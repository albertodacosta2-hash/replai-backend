const express = require('express');
const router  = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM email_templates ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { name, subject, html, type = 'custom' } = req.body || {};
    if (!name || !subject || !html) return res.status(400).json({ error: 'name, subject y html son requeridos' });
    const { rows } = await pool.query(
      'INSERT INTO email_templates (name, subject, html, type) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, subject, html, type]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, subject, html, type } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE email_templates SET
         name    = COALESCE($1, name),
         subject = COALESCE($2, subject),
         html    = COALESCE($3, html),
         type    = COALESCE($4, type)
       WHERE id = $5 RETURNING *`,
      [name, subject, html, type, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Template no encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM email_templates WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
