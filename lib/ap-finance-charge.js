// lib/ap-finance-charge.js
//
// Turns the finance charges on a supplier statement into one QBO Bill.
//
// The reconciliation already names them: "the difference is the $31.28 finance
// charge on this row. Enter it as its own bill; do not change the invoice."
// That instruction was right, and it was hand work — every statement, every
// month, once per charged row. This does it.
//
// WHY ITS OWN BILL AND NOT AN EDIT TO THE INVOICE. The invoice is what the
// supplier billed for goods, and it matches the PDF attached to it. Interest is
// a different expense against a different account, exempt where the goods are
// taxable, and folding it in would break the very match the reviewer just
// fixed. See mismatchNote in lib/ap-reconcile.js.
//
// TAX. Interest is an exempt financial service: no HST, no input tax credit, no
// tax code on the line. GlobalTaxCalculation says 'NotApplicable' outright
// rather than leaving it to a fallback — the lesson from ap-qbo-bills.js, where
// the fallback happened to be right and was still not worth relying on.

'use strict';

const { query, queryOne } = require('../db/connection');
const { qbPost } = require('./qbo-sync');
const { findAccountByName, findExistingBill } = require('./ap-qbo-bills');

// A supplier's interest figure and the gap it explains routinely differ by a
// cent or two of tax rounding — SanMar's 31.28 against a 31.25 gap. Same number
// lib/ap-reconcile.js uses to decide whether to blame the charge in its note:
// if the note says it, this posts it, and the reviewer never sees the two
// disagree with each other.
const ROUNDING_SLACK_CENTS = 25;

// Where the interest lands. A name rather than an id, so it survives a QBO
// restore into a new realm — same reasoning as QBO_AP_DEFAULT_ACCOUNT.
const ACCOUNT_NAME = () => process.env.QBO_AP_FINANCE_CHARGE_ACCOUNT || 'Interest Expense';

const centsToDollars = (c) => Math.round(c) / 100;
const fmt = (c) => '$' + (Math.abs(c) / 100).toFixed(2);
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Which statement rows carry a charge worth posting, and which do not.
 *
 * A charge is posted only where it accounts for the gap between the statement
 * and our books. A row where it does not is exactly the row the reconciliation
 * refuses to blame on interest — something else is wrong there, and posting the
 * charge would bury it under a second discrepancy.
 *
 * Pure. Exported for tests.
 */
function selectFinanceCharges(lines, slackCents = ROUNDING_SLACK_CENTS) {
  const charges = [];
  const skipped = [];

  for (const l of lines) {
    const charge = Math.abs(l.finance_charge_cents || 0);
    if (!charge) continue;

    if (l.our_amount_cents === null || l.our_amount_cents === undefined) {
      skipped.push({ line: l, reason: 'the invoice itself is not in our books yet' });
      continue;
    }

    const gap = Math.abs((l.amount_cents ?? 0) - l.our_amount_cents);
    const residual = Math.abs(gap - charge);
    if (residual > slackCents) {
      skipped.push({
        line: l,
        reason: 'the ' + fmt(charge) + ' charge does not account for the ' + fmt(gap) + ' difference',
      });
      continue;
    }
    charges.push({ line: l, cents: charge });
  }

  const totalCents = charges.reduce((sum, c) => sum + c.cents, 0);
  return { charges, skipped, totalCents };
}

/** Stable, readable, and unique per statement. */
function financeChargeDocNumber(statement) {
  const d = statement.statement_date
    ? isoDay(statement.statement_date).replace(/-/g, '')
    : 'S' + statement.id;
  return 'FC-' + d;
}

/**
 * The Bill payload. Pure, so the tax treatment can be asserted without a
 * network call — the part most likely to be wrong against a real company file.
 */
function buildFinanceChargeBill({ statement, charges, accountId, docNumber }) {
  if (!statement.vendor_qbo_id) throw new Error('statement has no vendor_qbo_id');
  if (!accountId) throw new Error('no expense account resolved');
  if (!charges.length) throw new Error('no charges to post');

  const dated = statement.statement_date ? ' dated ' + isoDay(statement.statement_date) : '';

  return {
    VendorRef: { value: String(statement.vendor_qbo_id) },
    DocNumber: docNumber,
    ...(statement.statement_date ? { TxnDate: isoDay(statement.statement_date) } : {}),
    PrivateNote:
      'Finance charges from the ' + (statement.vendor_name || 'supplier') + ' statement' +
      dated + '. Entered from the statement; there is no supplier invoice for these.',
    // No TaxCodeRef on any line: interest is an exempt financial service.
    GlobalTaxCalculation: 'NotApplicable',
    Line: charges.map(({ line, cents }) => ({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: centsToDollars(cents),
      Description:
        'Finance charge on invoice ' + (line.doc_number || '(no number)') +
        (line.txn_date ? ' dated ' + isoDay(line.txn_date) : ''),
      AccountBasedExpenseLineDetail: { AccountRef: { value: String(accountId) } },
    })),
  };
}

/**
 * Post one statement's finance charges as a single Bill.
 *
 * ONE BILL PER STATEMENT, not one per row: that is how the money arrives. The
 * supplier does not invoice interest, they add it to a statement, and a
 * bookkeeper doing this by hand would write one bill with a line per charged
 * invoice. It also keeps AP ageing honest — a dozen $2 bills is noise.
 *
 * Idempotent twice over: the stored bill id short-circuits it, and a bill
 * already in QBO under the same DocNumber is adopted rather than duplicated.
 * "Check again" is a button reviewers press repeatedly.
 */
async function postFinanceChargeBill(statementId) {
  const statement = await queryOne('SELECT * FROM ap_statements WHERE id = $1', [statementId]);
  if (!statement) throw new Error('ap_statements ' + statementId + ' not found');

  if (statement.finance_charge_bill_id) {
    return {
      billId: statement.finance_charge_bill_id,
      created: false,
      totalCents: statement.finance_charge_cents,
      reason: 'already posted',
    };
  }

  const lines = await query(
    'SELECT * FROM ap_statement_lines WHERE statement_id = $1 ORDER BY line_no', [statementId]);
  const { charges, skipped, totalCents } = selectFinanceCharges(lines);

  if (!charges.length) {
    return {
      billId: null, created: false, totalCents: 0, charges: [], skipped,
      reason: 'no finance charge on this statement accounts for its own row',
    };
  }

  const account = await findAccountByName(ACCOUNT_NAME());
  if (!account || !account.Id) {
    throw new Error(
      'No expense account named "' + ACCOUNT_NAME() + '" in the chart of accounts. ' +
      'Create it, or set QBO_AP_FINANCE_CHARGE_ACCOUNT to one that exists.'
    );
  }

  const docNumber = financeChargeDocNumber(statement);

  // Adopting is right rather than merely safe: a bill entered by hand under
  // this number is the same expense, and a second would double the payable.
  const existing = await findExistingBill({
    vendorQboId: statement.vendor_qbo_id,
    docNumber,
  });

  let billId;
  let created;
  if (existing) {
    billId = existing.Id;
    created = false;
  } else {
    const payload = buildFinanceChargeBill({
      statement, charges, accountId: account.Id, docNumber,
    });
    const res = await qbPost('/bill?minorversion=65', payload);
    billId = res && res.Bill && res.Bill.Id;
    if (!billId) throw new Error('QBO returned no Bill id');
    created = true;
  }

  await query(
    `UPDATE ap_statements
        SET finance_charge_bill_id = $1, finance_charge_cents = $2, finance_charge_at = NOW()
      WHERE id = $3`,
    [String(billId), totalCents, statementId]
  );

  return {
    billId: String(billId),
    created,
    totalCents,
    docNumber,
    accountName: account.Name || ACCOUNT_NAME(),
    charges: charges.map(({ line, cents }) => ({ doc_number: line.doc_number, cents })),
    skipped: skipped.map(({ line, reason }) => ({ doc_number: line.doc_number, reason })),
  };
}

module.exports = {
  postFinanceChargeBill,
  selectFinanceCharges,
  buildFinanceChargeBill,
  financeChargeDocNumber,
  ROUNDING_SLACK_CENTS,
};
