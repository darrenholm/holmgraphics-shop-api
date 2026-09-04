// lib/ap-extract.js
// Turns a supplier PDF into structured invoice / statement data using the
// Claude API, plus the money and vendor-name normalizers the rest of the AP
// pipeline shares.
//
// Why a model instead of OCR: supplier invoices have no common layout, and
// the fields that matter for AP — invoice number, terms, the tax split, and
// the per-line amounts — sit in a different place on every one. Template-
// based OCR needs a template per vendor; this needs none.
//
// Public surface:
//   extractDocument({ buffer, filename })  — one API call, normalized result
//   parseMoneyToCents(str)                 — "$1,234.56" / "(12.00)" → cents
//   parseDate(str)                         — YYYY-MM-DD or null
//   normalizeVendor(name)                  — alias-table lookup key
//
// Money crosses the model boundary as STRINGS, exactly as printed on the
// document, and is converted to integer cents here. Asking for JSON numbers
// instead would put every amount through a float, and "1234.56" round-trips
// through IEEE-754 as 1234.5599999999999 often enough to matter on a table
// of amounts we later sum and compare against a statement balance.
//
// Requires ANTHROPIC_API_KEY. extractDocument() THROWS on API failure or
// refusal; callers record the message on ap_documents.extract_error and
// leave the row in the review queue rather than dropping the document.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = process.env.AP_EXTRACT_MODEL || 'claude-opus-5';

// Intuit caps attachments at 100MB but the Messages API caps a base64 PDF
// request at 32MB, so that is the binding limit for anything we can read.
const MAX_PDF_BYTES = 30 * 1024 * 1024;

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('AP extraction not configured: set ANTHROPIC_API_KEY');
    }
    _client = new Anthropic();
  }
  return _client;
}

// ─── Schema ──────────────────────────────────────────────────────────────
// Every field is required and every absent value is the empty string rather
// than null/optional. A strict schema with optionals gives the model a
// choice between omitting a key and emptying it, and the two are then
// indistinguishable downstream from "the model didn't look".

const LineSchema = z.object({
  description: z.string(),
  quantity:    z.string(),
  unit_price:  z.string(),
  amount:      z.string(),
});

const StatementLineSchema = z.object({
  doc_number: z.string(),
  date:       z.string(),
  amount:     z.string(),
  kind:       z.enum(['invoice', 'credit', 'payment', 'other']),
});

const DocumentSchema = z.object({
  doc_kind:   z.enum(['invoice', 'statement', 'credit_note', 'unknown']),
  confidence: z.enum(['low', 'medium', 'high']),

  vendor_name: z.string(),
  doc_number:  z.string(),
  txn_date:    z.string(),
  due_date:    z.string(),
  terms:       z.string(),
  currency:    z.string(),

  subtotal: z.string(),
  tax:      z.string(),
  total:    z.string(),
  memo:     z.string(),

  lines:           z.array(LineSchema),
  statement_lines: z.array(StatementLineSchema),

  notes: z.string(),
});

const SYSTEM = `You are an accounts-payable clerk for a Canadian sign and print shop reading a supplier document.

Return exactly what is printed. Never compute, infer, or correct a value that is not on the page — an amount you derived is worse than an empty string, because a human reviews empty strings and trusts filled ones.

Field rules:
- Money fields are STRINGS copied as printed, including the decimal point: "1,234.56", "(45.00)" for a credit, "0.00". Do not add currency symbols that are not there. Empty string if the document has no such amount.
- Dates are YYYY-MM-DD. Convert the printed format, but never guess a missing year — if you cannot tell, use an empty string.
- vendor_name is the SUPPLIER billing us, not our own company (Holm Graphics). If both appear, the vendor is the one whose remit-to or payment details are shown.
- doc_number is the supplier's invoice or statement number, not our PO or account number.
- terms is the printed payment terms, e.g. "Net 30", "2/10 Net 30", "Due on receipt". Empty string if not printed.
- currency is the ISO code, "CAD" or "USD". If nothing indicates otherwise on a Canadian supplier's document, use "CAD".

doc_kind:
- "invoice" — a single charge for goods or services.
- "credit_note" — a credit memo or return.
- "statement" — a month-end list of outstanding documents. Statements are the ones with several invoice numbers and a closing or aging balance.
- "unknown" — anything else, including packing slips and quotes.

lines: fill for invoices and credit notes, one entry per charge line. Skip subtotal, tax, freight-summary and total rows — those belong in the subtotal/tax/total fields. If a line has no explicit quantity or unit price, use empty strings and still record the amount. If the document has no itemization at all, return an empty array.

statement_lines: fill ONLY for statements, one entry per listed document. doc_number is the invoice number as printed. Classify each as invoice, credit, payment, or other. Include every row, including payments already applied. For non-statements return an empty array.

For a statement, put the closing balance in total and leave subtotal and tax empty.

confidence: "high" when the document is a clean digital PDF and every field you filled is unambiguous; "medium" when it is legible but something was ambiguous; "low" for a poor scan, a handwritten document, or anything you had to strain to read. Explain anything unusual in notes.`;

// ─── Parsers ─────────────────────────────────────────────────────────────

// Accepts what suppliers actually print: "$1,234.56", "1 234.56", "(45.00)"
// and "45.00 CR" for credits, a bare "-12.5", and "1.234,56" in the European
// style some European-owned suppliers still emit. Returns integer cents, or
// null when the string holds no number at all — null and 0 mean different
// things on an invoice and must not collapse.
function parseMoneyToCents(raw) {
  if (raw === 0) return 0;
  if (!raw && raw !== '0') return null;

  let s = String(raw).trim();
  if (!s) return null;

  // Parenthesized and CR-suffixed amounts are both accounting negatives.
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\bCR$/i.test(s))   { negative = true; s = s.replace(/\bCR$/i, ''); }
  if (/^-/.test(s))       { negative = true; s = s.slice(1); }

  // Drop currency symbols, ISO codes and spaces used as thousands separators.
  s = s.replace(/[$£€]/g, '').replace(/\b(?:CAD|USD|EUR|GBP)\b/gi, '').replace(/\s/g, '').trim();
  if (!s) return null;

  // Decide which separator is the decimal point: whichever appears last.
  // "1.234,56" → comma decimal; "1,234.56" → period decimal.
  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }

  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;

  // Split on the decimal point and scale the fraction by hand rather than
  // multiplying a parsed float by 100, which is exactly where the cent-level
  // drift this module exists to avoid would creep back in.
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isFinite(cents)) return null;

  return negative ? -cents : cents;
}

// The model is asked for YYYY-MM-DD, so this is a validator rather than a
// parser. Anything else is rejected instead of being coerced — a wrong date
// on a bill silently books it to the wrong period.
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible days (Feb 30) by round-tripping through UTC.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return s;
}

// Lookup key for ap_vendor_aliases. Case, punctuation and legal-entity
// suffixes vary between the invoice and the QBO vendor list, so all three
// are stripped: "SANMAR CANADA ULC." and "SanMar Canada" both become
// "sanmar canada".
function normalizeVendor(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:inc|incorporated|ltd|limited|llc|ulc|lp|llp|co|corp|corporation|company)$/g, '')
    .trim();
}

// ─── Normalization ───────────────────────────────────────────────────────
// Maps the model's string-typed answer onto the column types in
// db/migrations/064_ap_bills.sql. Split out from extractDocument so the
// mapping can be tested without an API call.
function normalizeExtraction(parsed) {
  const lines = (parsed.lines || []).map((l, i) => ({
    line_no:      i + 1,
    description:  l.description || null,
    quantity:     l.quantity ? Number(String(l.quantity).replace(/,/g, '')) : null,
    unit_cents:   parseMoneyToCents(l.unit_price),
    amount_cents: parseMoneyToCents(l.amount),
  })).filter((l) => l.amount_cents !== null);

  const statementLines = (parsed.statement_lines || []).map((l, i) => ({
    line_no:      i + 1,
    doc_number:   l.doc_number || null,
    txn_date:     parseDate(l.date),
    amount_cents: parseMoneyToCents(l.amount),
    kind:         l.kind || 'other',
  }));

  return {
    doc_kind:   parsed.doc_kind   || 'unknown',
    confidence: parsed.confidence || 'low',

    vendor_name:    parsed.vendor_name || null,
    vendor_norm:    normalizeVendor(parsed.vendor_name),
    doc_number:     parsed.doc_number || null,
    txn_date:       parseDate(parsed.txn_date),
    due_date:       parseDate(parsed.due_date),
    terms:          parsed.terms || null,
    currency:       (parsed.currency || 'CAD').toUpperCase().slice(0, 3),

    subtotal_cents: parseMoneyToCents(parsed.subtotal),
    tax_cents:      parseMoneyToCents(parsed.tax),
    total_cents:    parseMoneyToCents(parsed.total),
    memo:           parsed.memo || null,

    lines,
    statement_lines: statementLines,
    notes: parsed.notes || null,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────
async function extractDocument({ buffer, filename = 'document.pdf' }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('extractDocument: buffer required');
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF too large for extraction (${buffer.length} bytes, limit ${MAX_PDF_BYTES})`);
  }

  const response = await client().messages.parse({
    model:      MODEL,
    max_tokens: 16000,
    system:     SYSTEM,
    messages: [{
      role: 'user',
      content: [
        {
          // The document block must precede the text block: Claude reads
          // content in order, and the instruction lands better once the
          // document it refers to is already in context.
          type: 'document',
          source: {
            type:       'base64',
            media_type: 'application/pdf',
            data:       buffer.toString('base64'),
          },
        },
        {
          type: 'text',
          text: `Extract this supplier document. The file is named "${filename}", which may or may not be meaningful — trust the page, not the filename.`,
        },
      ],
    }],
    output_config: { format: zodOutputFormat(DocumentSchema) },
  });

  // A refusal returns HTTP 200 with no usable content, so it has to be
  // checked before reading the parse result. Extremely unlikely on a
  // supplier invoice, but it fails as a normal extraction error rather than
  // as a confusing null dereference two lines down.
  if (response.stop_reason === 'refusal') {
    const detail = response.stop_details?.explanation || 'no explanation given';
    throw new Error(`Extraction refused by the model: ${detail}`);
  }
  if (!response.parsed_output) {
    throw new Error('Extraction returned no parsable output');
  }

  return {
    ...normalizeExtraction(response.parsed_output),
    model: response.model || MODEL,
    raw:   response.parsed_output,
    usage: response.usage || null,
  };
}

module.exports = {
  extractDocument,
  parseMoneyToCents,
  parseDate,
  normalizeVendor,
  normalizeExtraction,
  MODEL,
  MAX_PDF_BYTES,
  // Exported for unit tests.
  _internals: { DocumentSchema, SYSTEM },
};
