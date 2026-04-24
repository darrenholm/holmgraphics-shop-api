// middleware/customer-auth.js
// Auth middleware for online customers (separate realm from staff).
//
// Customer JWTs are issued by /api/customer/login and friends. The token
// carries `realm: 'customer'` to distinguish it from staff tokens. Used to
// gate /api/customer/* routes and any order action that requires a logged-
// in buyer.

'use strict';

const { verifyCustomerToken } = require('../lib/jwt-customer');

function requireCustomer(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    req.customer = verifyCustomerToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Invalid or expired customer token' });
  }
}

module.exports = { requireCustomer };
