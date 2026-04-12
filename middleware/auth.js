// middleware/auth.js
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function requireStaff(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'staff' || req.user.role === 'admin') return next();
    return res.status(403).json({ message: 'Staff access required' });
  });
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'admin') return next();
    return res.status(403).json({ message: 'Admin access required' });
  });
}

module.exports = { requireAuth, requireStaff, requireAdmin };
