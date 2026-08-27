// lib/qbo-terminal-writeback.js
//
// Writes counter-POS (Stripe Terminal) payments into QuickBooks Online.
//
// Called from the Stripe webhook, never from the tablet. If QBO is down or
// throttled the payment is still recorded in terminal_payments and can be
// retried; a tablet-driven write would silently lose it the moment the
// counter WiFi blinked.
//
// ─── Where the money lands ───────────────────────────────────────────────────
// Stripe pays out NET of fees, in batches. A single counter sale therefore
// never matches a single bank deposit, so nothing here posts to the bank
// account. Instead:
//
//   1. The sale posts to a dedicated clearing account (default name
//      "Stripe Clearing"), either as a Payment applied to the job's existing
//      Invoice, or as a SalesReceipt when the job was never invoiced.
//   2. The Stripe fee posts as an expense PAID FROM that same clearing
//      account. Without step 2 the clearing account never zeroes out.
//   3. When the Stripe payout hits the bank, the bookkeeper matches it in
//      the bank feed as a transfer from the clearing account. That last step
//      is manual and deliberate — see TERMINAL_POS.md.
//
// QBO_STRIPE_CLEARING_ACCOUNT may instead be pointed at **Undeposited
// Funds**, which is a supported choice and needs no new account. The
// trade-off is step 2: QBO won't let an expense be drawn on Undeposited
// Funds, so the fee moves to a negative line the bookkeeper adds on each
// Bank Deposit. The code detects this and says so rather than failing after
// a customer has already been charged.
//
// ─── Idempotency ─────────────────────────────────────────────────────────────
// Three layers, because Stripe retries webhooks and QBO has no natural key:
//   • stripe_webhook_events de-dupes the delivery (routes/stripe-webhook.js)
//   • terminal_payments.qbo_synced_at short-circuits a second write
//   • every QBO create carries a deterministic ?requestid= derived from the
//     PaymentIntent, so even a genuine race gets collapsed by Intuit
//
// ─── Throttling ──────────────────────────────────────────────────────────────
// QBO's 429 has bitten this integration before (see the payroll sync). Every
// call goes through qbCall() which backs off exponentially and honours
// Retry-After.

'use strict';

const crypto = require('crypto');
const { query, queryOne } = require('../db/connection');
const {
  qbGet,
  qbPost,
  ensureQboCustomer,
  findMiscItemId,
} = require('./qbo-sync');

// ─── Configuration ───────────────────────────────────────────────────────────
// Names, not ids: ids differ between the sandbox and the live company, and a
// bookkeeper renaming an account is a support call rather than a redeploy.
const CLEARING_ACCOUNT_NAME = () =>
  process.env.QBO_STRIPE_CLEARING_ACCOUNT || 'Stripe Clearing';
const FEE_ACCOUNT_NAME = () =>
  process.env.QBO_STRIPE_FEE_ACCOUNT || 'Merchant Account Fees';
const STRIPE_VENDOR_NAME = () =>
  process.env.QBO_STRIPE_VENDOR || 'Stripe';
// QBO TaxCode id to claim the HST on Stripe's own fees as an input tax
// credit. Unset (the default) posts the fee gross with no tax.
//
// This is deliberately NOT inherited from the fee account's default tax code.
// `balance_transaction.fee` is the total Stripe actually deducted, tax
// included. If QBO were left to apply an account default under its usual
// tax-EXCLUSIVE rule it would add 13% ON TOP, and the Purchase would take
// more out of the clearing account than Stripe took out of the payout — so
// the account would drift by the tax on every single sale and never zero.
// Setting the treatment explicitly on every payload is what makes a dropdown
// in the QBO UI unable to break the reconciliation.
const FEE_TAX_CODE = () => process.env.QBO_STRIPE_FEE_TAX_CODE || null;

// Ontario HST. Same code the existing invoice/salesreceipt paths use.
const HST_TAX_CODE = '7';

// ─── Money helpers ───────────────────────────────────────────────────────────
// Everything upstream is integer cents. QBO wants dollars as a JSON number.
// Round at the single boundary rather than accumulating float drift.
function centsToDollars(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function dollarsToCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

function todayInToronto() {
  // QBO dates are plain YYYY-MM-DD with no zone. A counter sale at 8pm
  // Eastern is still "today" to the shop; using the server's UTC date would
  // book it to tomorrow for five hours every evening.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Deterministic Intuit request id. Same logical write → same id → Intuit
// returns the original result instead of creating a duplicate. Max 50 chars,
// alphanumeric.
function requestId(purpose, key) {
  return crypto.createHash('sha1').update(`${purpose}:${key}`).digest('hex').slice(0, 32);
}

// ─── Throttle-aware call wrapper ─────────────────────────────────────────────
// Retries 429 and 5xx with exponential backoff. Does NOT retry 4xx other
// than 429 — those are payload problems that will fail identically forever,
// and burning three round-trips on them just delays the error surfacing.
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function qbCall(fn, { label = 'qbo', baseDelayMs = BASE_DELAY_MS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || 0;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      // Full jitter — a fixed backoff makes concurrent retries collide again
      // at exactly the same moment.
      const ceiling = baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.floor(Math.random() * ceiling) + baseDelayMs;
      console.warn(`[terminal-qbo] ${label} ${status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─── Reference lookups (cached per process) ──────────────────────────────────
// The chart of accounts changes about once a year. A process-lifetime cache
// saves two round-trips on every single counter sale.
const _refCache = new Map();

async function cachedLookup(key, fn) {
  if (_refCache.has(key)) return _refCache.get(key);
  const value = await fn();
  _refCache.set(key, value);
  return value;
}

function qbqlEscape(s) {
  return String(s ?? '').replace(/'/g, "\\'");
}

async function findAccountByName(name) {
  return cachedLookup(`account:${name}`, async () => {
    const data = await qbCall(
      () => qbGet(`/query?query=${encodeURIComponent(
        `SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Name = '${qbqlEscape(name)}' MAXRESULTS 1`
      )}`),
      { label: `findAccount(${name})` }
    );
    return data?.QueryResponse?.Account?.[0] || null;
  });
}

// Deliberately does NOT create the account when missing. Auto-creating a
// general-ledger account picks its type and its place in the chart of
// accounts on the bookkeeper's behalf, and a wrong guess is far more
// expensive to unwind than a failed sync. Fail loudly, name the fix.
async function requireAccount(name, purpose) {
  const acct = await findAccountByName(name);
  if (!acct) {
    const err = new Error(
      `QuickBooks has no account named "${name}" (needed for ${purpose}). ` +
      `Create it in QBO — Chart of Accounts → New — then re-run the sync. ` +
      `To point at a differently-named account instead, set the matching ` +
      `QBO_STRIPE_* variable in Railway.`
    );
    err.setupRequired = true;
    throw err;
  }
  return acct;
}

// Undeposited Funds is a QBO system account, not an ordinary asset account:
// it exists to hold received payments until a Bank Deposit sweeps them, and
// QBO will not let anything draw an expense on it. Depositing counter sales
// there is perfectly valid — it just means the Stripe fee cannot be posted
// automatically and has to go on the Bank Deposit as a negative line when the
// payout is matched.
//
// Detected by AccountSubType rather than by name, so a renamed or
// French-language company file still behaves correctly.
function isUndepositedFunds(account) {
  return account?.AccountSubType === 'UndepositedFunds';
}

async function findVendorByName(name) {
  return cachedLookup(`vendor:${name}`, async () => {
    const data = await qbCall(
      () => qbGet(`/query?query=${encodeURIComponent(
        `SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${qbqlEscape(name)}' MAXRESULTS 1`
      )}`),
      { label: `findVendor(${name})` }
    );
    return data?.QueryResponse?.Vendor?.[0] || null;
  });
}

// QBO PaymentMethod is cosmetic — it's what shows in the "Payment method"
// column. Omitted entirely when the company hasn't got a matching one, which
// is a lot cheaper than creating list entries nobody asked for.
async function findPaymentMethodByName(name) {
  if (!name) return null;
  return cachedLookup(`paymentmethod:${name}`, async () => {
    const data = await qbCall(
      () => qbGet(`/query?query=${encodeURIComponent(
        `SELECT Id, Name FROM PaymentMethod WHERE Name = '${qbqlEscape(name)}' MAXRESULTS 1`
      )}`),
      { label: `findPaymentMethod(${name})` }
    );
    return data?.QueryResponse?.PaymentMethod?.[0] || null;
  });
}

// Maps what the reader actually did to a QBO PaymentMethod name.
// 'interac_present' covers ALL debit including co-branded cards, so it must
// be checked before falling back to the card brand.
function paymentMethodNameFor(row) {
  if (row.payment_method_type === 'interac_present') return 'Interac';
  const brand = (row.card_brand || '').toLowerCase();
  if (brand === 'visa') return 'Visa';
  if (brand === 'mastercard') return 'MasterCard';
  if (brand === 'amex' || brand === 'american_express') return 'American Express';
  if (brand === 'discover') return 'Discover';
  return null;
}

// ─── Invoice lookup ──────────────────────────────────────────────────────────
// Project invoices are created by routes/quickbooks.js with
// DocNumber = String(project.id) — that route doesn't persist the returned
// QBO id anywhere, so DocNumber is the only link back. Balance matters: an
// already-settled invoice can't take another payment without turning into a
// customer credit, so a zero-balance hit is treated as "no invoice".
async function findOpenInvoiceForProject(projectId) {
  if (!projectId) return null;
  const data = await qbCall(
    () => qbGet(`/query?query=${encodeURIComponent(
      `SELECT Id, DocNumber, Balance, TotalAmt, CustomerRef FROM Invoice ` +
      `WHERE DocNumber = '${qbqlEscape(String(projectId))}' MAXRESULTS 5`
    )}`),
    { label: `findInvoice(${projectId})` }
  );
  const invoices = data?.QueryResponse?.Invoice || [];
  return invoices.find((inv) => Number(inv.Balance) > 0) || null;
}

// ─── Main entry point ────────────────────────────────────────────────────────
// Idempotent. Returns { skipped } when the row was already written back, so
// the webhook can 200 a duplicate delivery without pretending it did work.
async function writeBackPayment(terminalPaymentId) {
  const row = await queryOne(
    `SELECT * FROM terminal_payments WHERE id = $1`,
    [terminalPaymentId]
  );
  if (!row) throw new Error(`terminal_payments #${terminalPaymentId} not found`);
  if (row.qbo_synced_at) {
    // The sale is posted, but the fee is a separate transaction with its own
    // failure mode and it may have been the half that didn't land. Retry just
    // that — re-posting the sale here would duplicate it, and leaving the fee
    // unposted means the clearing account never zeroes.
    if (!row.qbo_fee_purchase_id && row.fee_cents > 0) {
      const clearing = await requireAccount(CLEARING_ACCOUNT_NAME(), 'the Stripe processing fee');
      if (isUndepositedFunds(clearing)) {
        // Retrying can never succeed here; the fee is a Bank Deposit line.
        // Leave the existing warning standing rather than churning the row.
        return { skipped: true, docType: row.qbo_doc_type, docId: row.qbo_doc_id,
                 reason: 'fee is posted by hand on the Bank Deposit (Undeposited Funds mode)' };
      }
      const feeId = await postStripeFee(row, { clearing });
      await query(
        `UPDATE terminal_payments
            SET qbo_fee_purchase_id = $1, qbo_warning = NULL, updated_at = NOW()
          WHERE id = $2`,
        [feeId, row.id]
      );
      return { docType: row.qbo_doc_type, docId: row.qbo_doc_id, feePurchaseId: feeId, feeRetried: true };
    }
    return { skipped: true, docType: row.qbo_doc_type, docId: row.qbo_doc_id };
  }
  if (row.status !== 'succeeded') {
    return { skipped: true, reason: `status is "${row.status}", not "succeeded"` };
  }

  await query(
    `UPDATE terminal_payments SET qbo_attempts = qbo_attempts + 1, updated_at = NOW() WHERE id = $1`,
    [row.id]
  );

  try {
    const result = await postSaleToQbo(row);
    await query(
      `UPDATE terminal_payments
          SET qbo_doc_type        = $1,
              qbo_doc_id          = $2,
              qbo_fee_purchase_id = $3,
              qbo_warning         = $4,
              qbo_error           = NULL,
              qbo_synced_at       = NOW(),
              updated_at          = NOW()
        WHERE id = $5`,
      [result.docType, result.docId, result.feePurchaseId, result.warning, row.id]
    );
    return result;
  } catch (err) {
    await query(
      `UPDATE terminal_payments SET qbo_error = $1, updated_at = NOW() WHERE id = $2`,
      [String(err.message).slice(0, 2000), row.id]
    );
    throw err;
  }
}

async function postSaleToQbo(row) {
  const clearing = await requireAccount(CLEARING_ACCOUNT_NAME(), 'the counter-sale deposit account');

  const client = row.client_id
    ? await queryOne(`SELECT * FROM clients WHERE id = $1`, [row.client_id])
    : null;
  if (!client) {
    throw new Error(
      `terminal_payments #${row.id} has no linked client — cannot resolve a QBO customer. ` +
      `Attach the job to a client in the shop app and re-sync.`
    );
  }
  const qbCustomerId = await qbCall(() => ensureQboCustomer(client), { label: 'ensureQboCustomer' });

  const pmName = paymentMethodNameFor(row);
  const paymentMethod = pmName ? await findPaymentMethodByName(pmName) : null;

  const invoice = await findOpenInvoiceForProject(row.project_id);

  const result = invoice
    ? await postPaymentAgainstInvoice(row, { invoice, qbCustomerId, clearing, paymentMethod })
    : await postSalesReceipt(row, { qbCustomerId, clearing, paymentMethod });

  // The fee is a separate transaction and a separate failure mode. If it
  // blows up we still want the sale itself recorded, so the caller learns
  // about it through qbo_warning rather than losing the sale to a rollback
  // QBO can't give us anyway.
  let feePurchaseId = null;
  let feeWarning = null;
  try {
    feePurchaseId = await postStripeFee(row, { clearing });
  } catch (err) {
    if (err.expectedForUndepositedFunds) {
      // Not a fault — it's the standing consequence of depositing to
      // Undeposited Funds, and it reads as a to-do on the POS screen.
      feeWarning = `Stripe ${err.message}`;
    } else {
      feeWarning = `Stripe fee not posted: ${err.message}`;
      console.error(`[terminal-qbo] fee post failed for ${row.payment_intent_id}:`, err.message);
    }
  }

  const warning = [result.warning, feeWarning].filter(Boolean).join(' | ') || null;
  return { ...result, feePurchaseId, warning };
}

// ─── Path A: Payment applied to an existing Invoice ──────────────────────────
async function postPaymentAgainstInvoice(row, { invoice, qbCustomerId, clearing, paymentMethod }) {
  const amount = centsToDollars(row.amount_cents);
  const balance = Number(invoice.Balance) || 0;

  // Applying more than the balance is a QBO validation error. Apply what
  // fits and let the remainder sit as an unapplied credit on the customer —
  // TotalAmt above the sum of the lines is exactly how QBO models that.
  const applied = Math.min(amount, balance);
  const overpayment = Math.round((amount - applied) * 100) / 100;

  const payload = {
    CustomerRef: { value: qbCustomerId },
    TxnDate:     todayInToronto(),
    TotalAmt:    amount,
    DepositToAccountRef: { value: clearing.Id },
    ...(paymentMethod ? { PaymentMethodRef: { value: paymentMethod.Id } } : {}),
    PaymentRefNum: String(row.payment_intent_id).slice(0, 21),
    PrivateNote: privateNoteFor(row, `applied to invoice #${invoice.DocNumber}`),
    Line: [{
      Amount: applied,
      LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
    }],
  };

  const res = await qbCall(
    () => qbPost(
      `/payment?minorversion=65&requestid=${requestId('payment', row.payment_intent_id)}`,
      payload
    ),
    { label: 'createPayment' }
  );
  const id = res?.Payment?.Id;
  if (!id) throw new Error('QBO did not return a Payment Id');

  return {
    docType: 'Payment',
    docId:   id,
    warning: overpayment > 0
      ? `Charged $${amount.toFixed(2)} against an invoice balance of $${balance.toFixed(2)} — ` +
        `$${overpayment.toFixed(2)} is sitting as an unapplied credit on this customer.`
      : null,
  };
}

// ─── Path B: SalesReceipt for a job with no invoice ──────────────────────────
async function postSalesReceipt(row, { qbCustomerId, clearing, paymentMethod }) {
  const miscItemId = await qbCall(() => findMiscItemId(), { label: 'findMiscItem' });

  // The counter charges a tax-INCLUSIVE total: that's the number on the
  // reader and on the customer's receipt. QBO builds its total up from
  // tax-exclusive lines, so the line goes in at subtotal and QBO recomputes
  // the HST from TaxCodeRef — the same convention createSalesReceiptFromOrder
  // uses. When the tablet sent an explicit split we trust it; otherwise back
  // the subtotal out at 13%.
  const totalCents    = row.amount_cents;
  const subtotalCents = row.subtotal_cents != null
    ? row.subtotal_cents
    : Math.round(totalCents / 1.13);

  const payload = {
    CustomerRef: { value: qbCustomerId },
    TxnDate:     todayInToronto(),
    DepositToAccountRef: { value: clearing.Id },
    ...(paymentMethod ? { PaymentMethodRef: { value: paymentMethod.Id } } : {}),
    PaymentRefNum: String(row.payment_intent_id).slice(0, 21),
    PrivateNote:   privateNoteFor(row, 'counter sale, no invoice on file'),
    ...(row.project_id ? { DocNumber: String(row.project_id) } : {}),
    Line: [{
      Amount:      centsToDollars(subtotalCents),
      DetailType:  'SalesItemLineDetail',
      Description: row.description || 'Counter sale',
      SalesItemLineDetail: {
        ItemRef:    { value: miscItemId },
        UnitPrice:  centsToDollars(subtotalCents),
        Qty:        1,
        TaxCodeRef: { value: HST_TAX_CODE },
      },
    }],
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: HST_TAX_CODE },
      TotalTax:      0,   // 0 tells QBO to recalculate from the line tax codes
    },
  };

  const res = await qbCall(
    () => qbPost(
      `/salesreceipt?minorversion=65&requestid=${requestId('salesreceipt', row.payment_intent_id)}`,
      payload
    ),
    { label: 'createSalesReceipt' }
  );
  const receipt = res?.SalesReceipt;
  if (!receipt?.Id) throw new Error('QBO did not return a SalesReceipt Id');

  // QBO recalculating tax from a backed-out subtotal can land a cent away
  // from what the customer was actually charged, which would leave the
  // clearing account permanently off by that cent. Surface it rather than
  // let it quietly accumulate.
  const qboTotalCents = dollarsToCents(receipt.TotalAmt);
  const drift = qboTotalCents - totalCents;
  const warning = drift !== 0
    ? `QBO recalculated this receipt to $${centsToDollars(qboTotalCents).toFixed(2)} but the ` +
      `customer was charged $${centsToDollars(totalCents).toFixed(2)} ` +
      `(${drift > 0 ? '+' : ''}${drift}¢). Adjust the receipt in QBO so the clearing account zeroes.`
    : null;

  return { docType: 'SalesReceipt', docId: receipt.Id, warning };
}

// ─── The Stripe fee ──────────────────────────────────────────────────────────
// Money leaves the clearing account and lands in a fee expense account. This
// is the half people forget, and without it the clearing account grows by the
// fee on every sale and never reconciles.
//
// The whole fee is posted gross to one expense line. If Stripe charges HST on
// its fees to this account, the ITC split is a bookkeeping decision — this
// does not guess at it.
// Shapes the fee Purchase. Pure, so the tax treatment — the part that decides
// whether the clearing account ever reaches zero — is unit-testable without a
// QuickBooks company file.
//
// The line Amount is ALWAYS the full amount Stripe deducted. What changes with
// `taxCode` is how QBO splits it:
//
//   taxCode unset → GlobalTaxCalculation 'NotApplicable'. The whole fee is
//                   expense, no input tax credit claimed.
//   taxCode set   → GlobalTaxCalculation 'TaxInclusive'. QBO backs the tax OUT
//                   of the amount, giving expense + ITC that still sum to what
//                   Stripe took. Never 'TaxExcluded' — that adds tax on top and
//                   silently overdraws the clearing account on every sale.
function buildFeePurchasePayload({ row, clearingId, feeAccountId, vendorId, taxCode, txnDate }) {
  return {
    PaymentType: 'Cash',
    AccountRef:  { value: clearingId },      // paid OUT of clearing
    TxnDate:     txnDate,
    GlobalTaxCalculation: taxCode ? 'TaxInclusive' : 'NotApplicable',
    ...(vendorId ? { EntityRef: { value: vendorId, type: 'Vendor' } } : {}),
    PrivateNote: `Stripe processing fee — ${row.payment_intent_id}`,
    Line: [{
      Amount:      centsToDollars(row.fee_cents),
      DetailType:  'AccountBasedExpenseLineDetail',
      Description: `Stripe fee on counter sale${row.project_id ? ` — job #${row.project_id}` : ''}`,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: feeAccountId },
        ...(taxCode ? { TaxCodeRef: { value: String(taxCode) } } : {}),
      },
    }],
  };
}

async function postStripeFee(row, { clearing }) {
  if (!row.fee_cents || row.fee_cents <= 0) return null;
  if (row.qbo_fee_purchase_id) return row.qbo_fee_purchase_id;

  // Depositing to Undeposited Funds is a supported choice, but QBO won't let
  // an expense be drawn on it. Say so once, plainly, as a warning on the row
  // rather than throwing — the sale is already posted and the customer has
  // already paid. The fee goes on the Bank Deposit by hand at payout time.
  if (isUndepositedFunds(clearing)) {
    const err = new Error(
      `fee of ${centsToDollars(row.fee_cents).toFixed(2)} not posted — sales deposit to ` +
      `Undeposited Funds, which QBO won't let an expense be drawn on. Add it as a ` +
      `negative "${FEE_ACCOUNT_NAME()}" line on the Bank Deposit when you match the Stripe payout.`
    );
    err.expectedForUndepositedFunds = true;
    throw err;
  }

  const feeAccount = await requireAccount(FEE_ACCOUNT_NAME(), 'the Stripe processing fee');
  const vendor = await findVendorByName(STRIPE_VENDOR_NAME());

  const payload = buildFeePurchasePayload({
    row,
    clearingId:   clearing.Id,
    feeAccountId: feeAccount.Id,
    vendorId:     vendor?.Id || null,
    taxCode:      FEE_TAX_CODE(),
    txnDate:      todayInToronto(),
  });

  const res = await qbCall(
    () => qbPost(
      `/purchase?minorversion=65&requestid=${requestId('fee', row.payment_intent_id)}`,
      payload
    ),
    { label: 'createFeePurchase' }
  );
  const id = res?.Purchase?.Id;
  if (!id) throw new Error('QBO did not return a Purchase Id for the Stripe fee');
  return id;
}

// ─── Refunds ─────────────────────────────────────────────────────────────────
// Reached from charge.refunded. Credit-card refunds issued from the Stripe
// Dashboard arrive here; Interac refunds cannot be issued through Stripe at
// all (they need the original card physically present at the reader), so in
// practice this handles credit and any out-of-band debit refund the shop
// records manually.
//
// Posts a RefundReceipt drawn on the clearing account, mirroring the deposit
// that went in. That keeps the clearing account symmetrical whether the sale
// was a Payment or a SalesReceipt.
//
// `refundedCents` is the DELTA for this refund, not the running total — two
// partial refunds on one sale are two genuine RefundReceipts. Replay of the
// same Stripe event is blocked upstream by stripe_webhook_events, and a
// same-minute retry is collapsed by the deterministic Intuit request id.
async function writeBackRefund(terminalPaymentId, { refundedCents }) {
  const row = await queryOne(`SELECT * FROM terminal_payments WHERE id = $1`, [terminalPaymentId]);
  if (!row) throw new Error(`terminal_payments #${terminalPaymentId} not found`);
  if (!refundedCents || refundedCents <= 0) return { skipped: true, reason: 'nothing refunded' };

  const clearing = await requireAccount(CLEARING_ACCOUNT_NAME(), 'the counter-sale refund account');
  const client = row.client_id
    ? await queryOne(`SELECT * FROM clients WHERE id = $1`, [row.client_id])
    : null;
  if (!client) throw new Error(`terminal_payments #${row.id} has no linked client for the refund`);

  const qbCustomerId = await qbCall(() => ensureQboCustomer(client), { label: 'ensureQboCustomer' });
  const miscItemId   = await qbCall(() => findMiscItemId(), { label: 'findMiscItem' });

  // Same tax-inclusive→exclusive treatment as the sale, so a full refund
  // reverses a full sale to the cent.
  const subtotalCents = Math.round(refundedCents / 1.13);

  const payload = {
    CustomerRef:         { value: qbCustomerId },
    TxnDate:             todayInToronto(),
    DepositToAccountRef: { value: clearing.Id },
    PaymentRefNum:       String(row.payment_intent_id).slice(0, 21),
    PrivateNote:         privateNoteFor(row, 'refund'),
    Line: [{
      Amount:      centsToDollars(subtotalCents),
      DetailType:  'SalesItemLineDetail',
      Description: `Refund — ${row.description || 'counter sale'}`,
      SalesItemLineDetail: {
        ItemRef:    { value: miscItemId },
        UnitPrice:  centsToDollars(subtotalCents),
        Qty:        1,
        TaxCodeRef: { value: HST_TAX_CODE },
      },
    }],
    TxnTaxDetail: { TxnTaxCodeRef: { value: HST_TAX_CODE }, TotalTax: 0 },
  };

  const res = await qbCall(
    () => qbPost(
      `/refundreceipt?minorversion=65&requestid=${requestId('refund', `${row.payment_intent_id}:${refundedCents}`)}`,
      payload
    ),
    { label: 'createRefundReceipt' }
  );
  const id = res?.RefundReceipt?.Id;
  if (!id) throw new Error('QBO did not return a RefundReceipt Id');

  // Append rather than overwrite: a second partial refund on the same sale
  // is a second document, and losing the first id would hide it.
  await query(
    `UPDATE terminal_payments
        SET qbo_refund_id = CONCAT_WS(',', NULLIF(qbo_refund_id, ''), $1::text),
            updated_at    = NOW()
      WHERE id = $2`,
    [id, row.id]
  );
  return { docId: id };
}

function privateNoteFor(row, suffix) {
  const bits = [
    'Holm Graphics counter sale',
    row.project_id ? `job #${row.project_id}` : null,
    row.payment_method_type === 'interac_present' ? 'Interac debit' : row.card_brand,
    row.card_last4 ? `••${row.card_last4}` : null,
    `Stripe ${row.payment_intent_id}`,
    suffix,
  ].filter(Boolean);
  return bits.join(' — ');
}

// ─── Preflight ───────────────────────────────────────────────────────────────
// Checks everything the write-back needs BEFORE the first live sale, so the
// answer to "will this reconcile?" doesn't arrive as a failed webhook with a
// customer already charged. Surfaced at GET /api/terminal/qbo-preflight.
async function qboPreflight() {
  const checks = [];
  async function check(name, fn) {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message });
    }
  }

  await check('QuickBooks connected', async () => {
    const info = await qbGet('/companyinfo/1?minorversion=65');
    return info?.CompanyInfo?.CompanyName || 'connected';
  });
  await check(`Deposit account "${CLEARING_ACCOUNT_NAME()}"`, async () => {
    const a = await requireAccount(CLEARING_ACCOUNT_NAME(), 'deposits');
    if (isUndepositedFunds(a)) {
      return `${a.Name} — Undeposited Funds mode: sales post automatically, but the Stripe ` +
             `fee must be added by hand as a negative line on each Bank Deposit. ` +
             `A dedicated clearing account would post it for you.`;
    }
    // Not fatal, but worth saying out loud: QBO's Transfer form only offers
    // Bank and Credit Card accounts, and matching the payout against the real
    // bank IS that form. On an Other Current Asset it degrades to a manual
    // journal entry every payout — and the account's type can't be changed
    // after the fact, so this is much cheaper to hear now than in a month.
    if (a.AccountType !== 'Bank') {
      return `${a.Name} (${a.AccountType}, id ${a.Id}) — sales and fees will post, but this ` +
             `is not a Bank account, so QBO's Transfer form won't offer it when you match ` +
             `the Stripe payout. Consider recreating it as a book-only Bank account.`;
    }
    return `${a.Name} (${a.AccountType}, id ${a.Id}) — fees post automatically`;
  });
  await check(`Fee account "${FEE_ACCOUNT_NAME()}"`, async () => {
    const a = await requireAccount(FEE_ACCOUNT_NAME(), 'fees');
    const deposit = await findAccountByName(CLEARING_ACCOUNT_NAME());
    return isUndepositedFunds(deposit)
      ? `${a.Name} (id ${a.Id}) — the category to pick for the negative fee line on the Bank Deposit`
      : `${a.Name} (${a.AccountType}, id ${a.Id})`;
  });
  await check('Fee tax treatment', async () => {
    const code = FEE_TAX_CODE();
    if (!code) {
      return 'no QBO_STRIPE_FEE_TAX_CODE — the whole Stripe fee posts as expense, ' +
             'no input tax credit claimed. Safe, and the clearing account still zeroes.';
    }
    const data = await qbCall(
      () => qbGet(`/query?query=${encodeURIComponent(
        `SELECT Id, Name FROM TaxCode WHERE Id = '${qbqlEscape(code)}' MAXRESULTS 1`
      )}`),
      { label: `findTaxCode(${code})` }
    );
    const tc = data?.QueryResponse?.TaxCode?.[0];
    if (!tc) throw new Error(`QBO has no TaxCode with id "${code}" (QBO_STRIPE_FEE_TAX_CODE)`);
    return `${tc.Name} (id ${tc.Id}), applied tax-INCLUSIVE so the fee still totals ` +
           `exactly what Stripe deducted`;
  });
  await check('"Misc" item', async () => `item id ${await findMiscItemId()}`);
  await check(`Vendor "${STRIPE_VENDOR_NAME()}" (optional)`, async () => {
    const v = await findVendorByName(STRIPE_VENDOR_NAME());
    return v ? `id ${v.Id}` : 'not found — fee expenses will post with no vendor';
  });

  return { ok: checks.every((c) => c.ok), checks };
}

// Clears the reference cache. Called after a QBO reconnect so a re-pointed
// company file doesn't keep writing to the old company's account ids.
function clearRefCache() {
  _refCache.clear();
}

module.exports = {
  writeBackPayment,
  isUndepositedFunds,
  writeBackRefund,
  qboPreflight,
  clearRefCache,
  findOpenInvoiceForProject,
  // Exported for unit tests.
  _internals: {
    centsToDollars,
    dollarsToCents,
    buildFeePurchasePayload,
    paymentMethodNameFor,
    requestId,
    todayInToronto,
    qbCall,
    privateNoteFor,
  },
};
