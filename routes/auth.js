const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sql, queryOne, query } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' });
  try {
    const user = await queryOne(
      `SELECT EmpNo AS id, First AS first_name, Last AS last_name,
              Email AS email, Role AS role, PasswordHash AS password_hash,
              Active AS active
       FROM Employee WHERE Email = @email`,
      { email: { type: sql.NVarChar(255), value: email } }
    );
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    if (user.active === false || user.active === 0) return res.status(403).json({ message: 'Account is inactive' });
    if (!user.password_hash) return res.status(401).json({ message: 'Account not set up for web login.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Invalid email or password' });
    const payload = { id: user.id, email: user.email, role: user.role || 'staff', name: `${user.first_name} ${user.last_name}`.trim() };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
    res.json({ token, user: payload });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: 'Login failed', detail: e.message });
  }
});

router.post('/set-password', async (req, res) => {
  const { empNo, password } = req.body;
  if (!empNo || !password || password.length < 6) return res.status(400).json({ message: 'empNo and password required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    await query(`UPDATE Employee SET PasswordHash = @hash WHERE EmpNo = @empNo`,
      { hash: { type: sql.NVarChar(255), value: hash }, empNo: { type: sql.Int, value: parseInt(empNo) } });
    res.json({ message: 'Password updated' });
  } catch (e) {
    res.status(500).json({ message: 'Failed', detail: e.message });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ message: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });
  try {
    const user = await queryOne(
      `SELECT PasswordHash AS password_hash FROM Employee WHERE EmpNo = @id`,
      { id: { type: sql.Int, value: req.user.id } }
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    await query(
      `UPDATE Employee SET PasswordHash = @hash WHERE EmpNo = @id`,
      { hash: { type: sql.NVarChar(255), value: hash }, id: { type: sql.Int, value: req.user.id } }
    );
    res.json({ message: 'Password changed successfully' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to change password', detail: e.message });
  }
});

module.exports = router;