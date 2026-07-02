const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username === process.env.DASHBOARD_USER && password === process.env.DASHBOARD_PASSWORD) {
    const token = jwt.sign({ user: username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }

  res.status(401).json({ error: 'Credenciales incorrectas' });
});

module.exports = router;
