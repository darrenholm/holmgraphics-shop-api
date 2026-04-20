// suppliers/promostandards/invoice.js
//
// PromoStandards Invoice 1.0.0 client.
// Spec: https://tools.promostandards.org/standards/services
//
// Operations:
//   - getInvoices            — pull unposted or posted invoices for
//                              reconciliation against our QuickBooks bills.
//
// This closes the loop: supplier ships goods → invoices us → we pull via
// this service → match to PO → push bill to QuickBooks (task #54).

const NAMESPACE = 'http://www.promostandards.org/WSDL/InvoiceService/1.0.0/';

// TODO(#45)
async function getInvoices(_client, _args) { throw new Error('Not implemented (task #45)'); }

module.exports = { NAMESPACE, getInvoices };
