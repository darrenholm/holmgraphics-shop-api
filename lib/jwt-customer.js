// lib/jwt-customer.js
// JWT issuance + verification for online customers.
//
// Distinct from the staff JWTs handled in middleware/auth.js — same secret
// and library, but the payload carries `realm: 'customer'` so a customer
// JWT can never satisfy `requireStaff` or `requireAdmin` even if it gets
// pasted into the wrong header. Staff JWTs use the legacy payload shape
// (no `realm` field) so they're recognized as `realm: 'staff'` by default.

'use strict';

const jwt = require('jsonwebtoken');

const CUSTOMER_TOKEN_TTL = process.env.CUSTOMER_JWT_EXPIRES_IN || '14d';

function signCustomerToken(client) {
  return jwt.sign(
    {
      realm:    'customer',
      id:       client.id,
      email:    client.email,
      name:     [client.fname, client.lname].filter(Boolean).join(' ') ||
                client.company || client.email,
      company:  client.company || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: CUSTOMER_TOKEN_TTL }
  );
}

function verifyCustomerToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.realm !== 'customer') {
    throw new Error('Token is not a customer token');
  }
  return payload;
}

module.exports = { signCustomerToken, verifyCustomerToken, CUSTOMER_TOKEN_TTL };
