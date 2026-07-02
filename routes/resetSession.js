const express = require('express');
const router = express.Router();
const { clearSession } = require('../src/alexAgent');

// GET /api/leads/reset-session/:phone — utilidad de test, SIN auth.
// Bajo riesgo: solo limpia la sesión en memoria de un número específico.
router.get('/:phone', (req, res) => {
  clearSession(decodeURIComponent(req.params.phone));
  res.json({ ok: true });
});

module.exports = router;
