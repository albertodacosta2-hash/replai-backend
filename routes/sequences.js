const express = require('express');
const router  = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows: seqs } = await pool.query('SELECT * FROM email_sequences ORDER BY created_at DESC');
    const { rows: steps } = await pool.query(
      `SELECT s.*, t.name AS template_name, t.subject AS template_subject
       FROM email_sequence_steps s
       LEFT JOIN email_templates t ON s.template_id = t.id
       ORDER BY s.sequence_id, s.step_order`
    );
    res.json(seqs.map(seq => ({ ...seq, steps: steps.filter(s => s.sequence_id === seq.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  const { name, list_type, steps = [] } = req.body || {};
  if (!name || !list_type) return res.status(400).json({ error: 'name y list_type son requeridos' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [seq] } = await client.query(
      'INSERT INTO email_sequences (name, list_type) VALUES ($1,$2) RETURNING *',
      [name, list_type]
    );
    for (let i = 0; i < steps.length; i++) {
      await client.query(
        'INSERT INTO email_sequence_steps (sequence_id, template_id, delay_days, step_order) VALUES ($1,$2,$3,$4)',
        [seq.id, steps[i].template_id, steps[i].delay_days ?? 0, i]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(seq);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, active } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE email_sequences SET
         name   = COALESCE($1, name),
         active = COALESCE($2, active)
       WHERE id = $3 RETURNING *`,
      [name, active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Secuencia no encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM email_sequences WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
