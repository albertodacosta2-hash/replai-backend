const { pool } = require('../db');
const { sendWhatsAppMeta } = require('../src/metaSender');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

// GET /api/leads
async function getLeads(req, res) {
  try {
    const { status, type, channel } = req.query;
    const conditions = [];
    const params = [];

    if (status)  { conditions.push(`status = $${params.push(status)}`); }
    if (type)    { conditions.push(`type = $${params.push(type)}`); }
    if (channel) { conditions.push(`channel = $${params.push(channel)}`); }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(`SELECT * FROM leads${where} ORDER BY created_at DESC`, params);
    res.json(rows.map(parseLead));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/leads/:id
async function getLeadById(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json(parseLead(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/leads
async function createLead(req, res) {
  try {
    const { name, phone, email, channel, type, source, owner } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const existing = await pool.query('SELECT id FROM leads WHERE phone = $1', [phone]);
    if (existing.rows[0]) return res.status(409).json({ error: 'Lead already exists', id: existing.rows[0].id });

    const { rows } = await pool.query(
      `INSERT INTO leads (name, phone, email, channel, type, source, owner)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name || null, phone, email || null, channel || 'whatsapp', type || 'Buyer', source || null, owner || null]
    );
    res.status(201).json(parseLead(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /api/leads/:id
async function updateLead(req, res) {
  try {
    const existing = await pool.query('SELECT id FROM leads WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lead not found' });

    const allowed = ['name', 'email', 'type', 'status', 'zone', 'budget', 'bedrooms',
      'timeline', 'financing', 'urgency', 'source', 'owner', 'tags', 'notes', 'ai_active',
      'pipeline', 'stage', 'last_activity_at', 'nurturing', 'appointment_at', 'appointment_no_show'];

    const setClauses = [];
    const params = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(key === 'tags' ? JSON.stringify(req.body[key]) : req.body[key]);
        setClauses.push(`${key} = $${params.length}`);
      }
    }

    if (!setClauses.length) return res.status(400).json({ error: 'No valid fields to update' });

    setClauses.push('updated_at = NOW()');
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE leads SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json(parseLead(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/leads/:id/messages
async function getMessages(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/leads/:id/messages
async function addMessage(req, res) {
  try {
    const { direction, sender, body } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });

    const { rows } = await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, direction || 'outbound', sender || 'human', body]
    );
    await pool.query('UPDATE leads SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/leads/:id/send-message
async function sendHumanMessage(req, res) {
  try {
    const { id } = req.params;
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });

    const { rows } = await pool.query('SELECT phone FROM leads WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'lead not found' });

    const { phone } = rows[0];
    await sendWhatsAppMeta(phone, body);
    await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'human', $2)`,
      [id, body]
    );
    await pool.query(
      `UPDATE leads SET ai_active = 0, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/leads/nurturing
async function getNurturing(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leads WHERE nurturing = true ORDER BY last_activity_at ASC`
    );
    res.json(rows.map(parseLead));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /api/leads/:id/stage
async function updateStage(req, res) {
  try {
    const { pipeline, stage } = req.body;
    if (!pipeline || !stage) return res.status(400).json({ error: 'pipeline and stage required' });

    const { rows } = await pool.query(
      `UPDATE leads SET pipeline = $1, stage = $2, last_activity_at = NOW(), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [pipeline, stage, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'lead not found' });
    res.json(parseLead(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/leads/:id/reactivate
async function reactivateLead(req, res) {
  try {
    const { id } = req.params;

    const { rows: leadRows } = await pool.query('SELECT phone FROM leads WHERE id = $1', [id]);
    if (!leadRows[0]) return res.status(404).json({ error: 'lead not found' });
    const { phone } = leadRows[0];

    const { rows: msgRows } = await pool.query(
      `SELECT direction, body FROM messages WHERE lead_id = $1 ORDER BY created_at ASC LIMIT 30`,
      [id]
    );

    const history = msgRows.map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }));

    const systemPrompt = `Eres Alex de Zona Cat. Este lead lleva varios días sin responder.
Genera UN solo mensaje corto (máximo 2 frases) y natural para retomar la conversación.
Sin markdown, sin listas, tono cálido. Termina con una pregunta breve.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: systemPrompt,
      messages: history.length > 0 ? history : [{ role: 'user', content: 'Hola' }],
    });

    const reply = response.content[0]?.text || 'Hola, ¿aún tienes interés en alquilar maquinaria? 😊';

    await sendWhatsAppMeta(phone, reply);
    await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'ai_agent', $2)`,
      [id, reply]
    );
    await pool.query(
      `UPDATE leads SET nurturing = false, ai_active = 1, last_activity_at = NOW(),
       stage = 'replied', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ ok: true, message: reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/leads/stats
async function getStats(req, res) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [newToday, qualified, active, appointments, followUp, closed] = await Promise.all([
      pool.query('SELECT COUNT(*) AS n FROM leads WHERE created_at::date = $1', [today]),
      pool.query("SELECT COUNT(*) AS n FROM leads WHERE status = 'Qualified'"),
      pool.query("SELECT COUNT(*) AS n FROM leads WHERE status NOT IN ('Closed','Lost')"),
      pool.query("SELECT COUNT(*) AS n FROM leads WHERE status = 'Appointment Scheduled'"),
      pool.query("SELECT COUNT(*) AS n FROM leads WHERE status = 'Follow-up Needed'"),
      pool.query("SELECT COUNT(*) AS n FROM leads WHERE status = 'Closed'"),
    ]);

    res.json({
      new_today:     parseInt(newToday.rows[0].n),
      qualified:     parseInt(qualified.rows[0].n),
      active_convos: parseInt(active.rows[0].n),
      appointments:  parseInt(appointments.rows[0].n),
      follow_up:     parseInt(followUp.rows[0].n),
      closed:        parseInt(closed.rows[0].n),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function parseLead(lead) {
  return {
    ...lead,
    tags: JSON.parse(lead.tags || '[]'),
    ai_active: Boolean(lead.ai_active),
    nurturing: Boolean(lead.nurturing),
    appointment_no_show: Boolean(lead.appointment_no_show),
    pipeline: lead.pipeline || 'agent',
    stage: lead.stage || 'new',
  };
}

module.exports = {
  getLeads, getLeadById, createLead, updateLead, getMessages, addMessage,
  getStats, sendHumanMessage, getNurturing, updateStage, reactivateLead,
};
