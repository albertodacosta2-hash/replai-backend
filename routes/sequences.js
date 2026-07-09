const express = require('express');
const router  = express.Router();
const { pool } = require('../db');

const STEPS_SELECT = `
  SELECT s.*, t.name AS template_name, t.subject AS template_subject, t.html AS template_html
  FROM email_sequence_steps s
  LEFT JOIN email_templates t ON s.template_id = t.id
  WHERE s.sequence_id = ANY($1::int[])
  ORDER BY s.sequence_id, s.step_order
`;

router.get('/', async (req, res) => {
  try {
    const { rows: seqs } = await pool.query('SELECT * FROM email_sequences ORDER BY created_at DESC');
    const { rows: steps } = await pool.query(STEPS_SELECT, [seqs.map(s => s.id)]);
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
        'INSERT INTO email_sequence_steps (sequence_id, template_id, delay_days, send_hour, step_order) VALUES ($1,$2,$3,$4,$5)',
        [seq.id, steps[i].template_id, steps[i].delay_days ?? 0, steps[i].send_hour || '09:00', i]
      );
    }
    await client.query('COMMIT');
    const { rows: steps2 } = await pool.query(STEPS_SELECT, [[seq.id]]);
    res.status(201).json({ ...seq, steps: steps2 });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.patch('/:id', async (req, res) => {
  const { name, active, list_type, steps } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE email_sequences SET
         name      = COALESCE($1, name),
         active    = COALESCE($2, active),
         list_type = COALESCE($3, list_type)
       WHERE id = $4 RETURNING *`,
      [name, active, list_type, req.params.id]
    );
    const seq = rows[0];
    if (!seq) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Secuencia no encontrada' }); }

    if (Array.isArray(steps)) {
      const { rows: existing } = await client.query(
        'SELECT id FROM email_sequence_steps WHERE sequence_id = $1', [seq.id]
      );
      const existingIds = existing.map(r => r.id);
      const incomingIds  = steps.filter(s => s.id).map(s => s.id);
      const toDelete = existingIds.filter(id => !incomingIds.includes(id));
      if (toDelete.length) {
        await client.query('DELETE FROM email_sequence_steps WHERE id = ANY($1::int[])', [toDelete]);
      }
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.id) {
          await client.query(
            `UPDATE email_sequence_steps SET
               template_id = $1, delay_days = $2, send_hour = $3, step_order = $4
             WHERE id = $5 AND sequence_id = $6`,
            [s.template_id, s.delay_days ?? 0, s.send_hour || '09:00', i, s.id, seq.id]
          );
        } else {
          await client.query(
            'INSERT INTO email_sequence_steps (sequence_id, template_id, delay_days, send_hour, step_order) VALUES ($1,$2,$3,$4,$5)',
            [seq.id, s.template_id, s.delay_days ?? 0, s.send_hour || '09:00', i]
          );
        }
      }
    }

    await client.query('COMMIT');
    const { rows: freshSteps } = await pool.query(STEPS_SELECT, [[seq.id]]);
    res.json({ ...seq, steps: freshSteps });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM email_sequences WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sequences/:id/tracking — estado de envío por contacto x paso
router.get('/:id/tracking', async (req, res) => {
  try {
    const { rows: [seq] } = await pool.query('SELECT * FROM email_sequences WHERE id = $1', [req.params.id]);
    if (!seq) return res.status(404).json({ error: 'Secuencia no encontrada' });

    const { rows: steps } = await pool.query(STEPS_SELECT, [[seq.id]]);

    const { rows: leads } = await pool.query(
      `SELECT id AS lead_id, name, phone, status FROM leads
       WHERE nurturing = true AND archived = false AND email IS NOT NULL AND email <> ''`
    );
    const contacts = leads.filter(l =>
      seq.list_type === 'qualified' ? l.status === 'Qualified' : l.status !== 'Qualified'
    );

    const { rows: logs } = await pool.query(
      'SELECT lead_id, step_id, status, error_message FROM email_sequence_log WHERE sequence_id = $1',
      [seq.id]
    );

    const result = contacts.map(c => {
      const statuses = {};
      const errors = {};
      for (const step of steps) {
        const log = logs.find(l => l.lead_id === c.lead_id && l.step_id === step.id);
        statuses[step.id] = log ? log.status : 'pending';
        if (log && log.error_message) errors[step.id] = log.error_message;
      }
      return { lead_id: c.lead_id, name: c.name, phone: c.phone, statuses, errors };
    });

    res.json({ steps, contacts: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
