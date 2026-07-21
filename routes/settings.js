const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');

// Preferencias de UI del usuario del dashboard. El login es una credencial única
// compartida (no hay tabla de usuarios), así que se persiste por username del JWT.
// NOTA: esto es solo interfaz — no afecta los prompts de Alex/Sofía ni los webhooks.

// GET /api/settings — devuelve la preferencia de idioma del usuario autenticado
router.get('/', async (req, res) => {
  try {
    const username = req.user?.user;
    if (!username) return res.status(401).json({ error: 'No autenticado' });
    const { rows } = await pool.query(
      'SELECT language FROM user_prefs WHERE username = $1',
      [username]
    );
    res.json({ language: rows[0]?.language || 'es' });
  } catch (err) {
    console.error('[settings] GET error:', err.message);
    res.status(500).json({ error: 'Error al leer preferencias' });
  }
});

// PUT /api/settings — actualiza la preferencia de idioma (upsert por username)
router.put('/', [
  body('language').isIn(['es', 'en']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Idioma inválido' });
  try {
    const username = req.user?.user;
    if (!username) return res.status(401).json({ error: 'No autenticado' });
    const { language } = req.body;
    await pool.query(
      `INSERT INTO user_prefs (username, language, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (username) DO UPDATE
         SET language = EXCLUDED.language, updated_at = NOW()`,
      [username, language]
    );
    res.json({ language });
  } catch (err) {
    console.error('[settings] PUT error:', err.message);
    res.status(500).json({ error: 'Error al guardar preferencias' });
  }
});

module.exports = router;
