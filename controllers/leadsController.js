const { Readable, PassThrough } = require('stream');
const { pool } = require('../db');
const { sendWhatsAppMeta, uploadMediaToMeta, sendWhatsAppMedia } = require('../src/metaSender');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function convertWebmToOgg(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const outStream = new PassThrough();
    outStream.on('data', c => chunks.push(c));
    outStream.on('end', () => resolve(Buffer.concat(chunks)));
    outStream.on('error', reject);
    ffmpeg()
      .input(Readable.from(buffer))
      .inputFormat('webm')
      .audioCodec('libopus')
      .format('ogg')
      .on('error', reject)
      .pipe(outStream, { end: true });
  });
}

// GET /api/leads
async function getLeads(req, res) {
  try {
    const { status, type, channel } = req.query;
    const conditions = ['(archived IS NOT TRUE)'];
    const params = [];

    if (status)  { conditions.push(`status = $${params.push(status)}`); }
    if (type)    { conditions.push(`type = $${params.push(type)}`); }
    if (channel) { conditions.push(`channel = $${params.push(channel)}`); }

    const where = ' WHERE ' + conditions.join(' AND ');
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
      'pipeline', 'stage', 'last_activity_at', 'nurturing', 'appointment_at', 'appointment_no_show',
      'property_interest', 'budget_estimate', 'next_action'];

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

// POST /api/leads/:id/send-media
async function sendMediaMessage(req, res) {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const { rows } = await pool.query('SELECT phone FROM leads WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'lead not found' });
    const { phone } = rows[0];

    let { buffer, mimetype, originalname: filename } = req.file;

    // Meta only accepts audio/ogg, audio/mp4, audio/mpeg, audio/amr, audio/aac
    // Chrome MediaRecorder produces audio/webm — convert to ogg/opus first
    if (mimetype.startsWith('audio/webm')) {
      console.log('[sendMedia] converting webm → ogg/opus');
      buffer = await convertWebmToOgg(buffer);
      mimetype = 'audio/ogg; codecs=opus';
      filename = filename.replace(/\.webm$/, '.ogg');
    }

    const mediaType = mimetype.startsWith('image/') ? 'image'
      : mimetype.startsWith('audio/') ? 'audio'
      : 'document';

    const mediaId = await uploadMediaToMeta(buffer, mimetype, filename);
    await sendWhatsAppMedia(phone, mediaId, mediaType, filename);

    const msgBody = mediaType === 'audio' ? `[audio:${mediaId}]` : `[archivo: ${filename}]`;
    await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'human', $2)`,
      [id, msgBody]
    );
    await pool.query(`UPDATE leads SET ai_active = 0, updated_at = NOW() WHERE id = $1`, [id]);

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

    // Única validación: que el stage sea uno válido. NO se valida dirección —
    // se permite mover el lead a cualquier stage, hacia adelante o hacia atrás.
    const validAgentStages = ['new', 'replied', 'profiled', 'appointment'];
    const validRealtorStages = ['call', 'visit', 'post_visit', 'offer', 'closed'];
    const allValidStages = [...validAgentStages, ...validRealtorStages];
    if (!allValidStages.includes(stage)) {
      return res.status(400).json({ error: 'Stage inválido' });
    }

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

// GET /api/leads/stats?period=today|week|month
// Boundaries SQL por periodo — 'period' se valida contra este whitelist antes de interpolar.
const PERIOD_BOUNDS = {
  today: {
    start:     "CURRENT_DATE",
    prevStart: "CURRENT_DATE - INTERVAL '1 day'",
    prevEnd:   "CURRENT_DATE",
  },
  week: {
    start:     "DATE_TRUNC('week', NOW())",
    prevStart: "DATE_TRUNC('week', NOW()) - INTERVAL '1 week'",
    prevEnd:   "DATE_TRUNC('week', NOW())",
  },
  month: {
    start:     "DATE_TRUNC('month', NOW())",
    prevStart: "DATE_TRUNC('month', NOW()) - INTERVAL '1 month'",
    prevEnd:   "DATE_TRUNC('month', NOW())",
  },
};

async function getStats(req, res) {
  try {
    const period = PERIOD_BOUNDS[req.query.period] ? req.query.period : 'month';
    const { start, prevStart, prevEnd } = PERIOD_BOUNDS[period];

    const num = r => parseInt(r.rows[0].n) || 0;
    const flt = r => parseFloat(r.rows[0].m) || 0;

    // Conteo de leads por status dentro de una ventana [desde, hasta)
    const leadCount = (statusClause, from, to) =>
      pool.query(
        `SELECT COUNT(*) AS n FROM leads
         WHERE archived = false ${statusClause}
           AND created_at >= ${from}${to ? ` AND created_at < ${to}` : ''}`
      );

    // Promedio en minutos entre un inbound y el outbound siguiente del mismo lead
    const avgResponse = (from, to) =>
      pool.query(
        `WITH o AS (
           SELECT lead_id, direction, created_at,
                  LAG(created_at) OVER (PARTITION BY lead_id ORDER BY created_at) AS prev_at,
                  LAG(direction)  OVER (PARTITION BY lead_id ORDER BY created_at) AS prev_dir
           FROM messages)
         SELECT AVG(EXTRACT(EPOCH FROM (created_at - prev_at)) / 60) AS m
         FROM o
         WHERE direction = 'outbound' AND prev_dir = 'inbound'
           AND created_at >= ${from}${to ? ` AND created_at < ${to}` : ''}`
      );

    const [
      leadsNew, leadsNewPrev,
      qualified, qualifiedPrev,
      appointments, appointmentsPrev,
      avgResp, avgRespPrev,
      aiResponses, activeLeads, nurturing, messagesSent,
    ] = await Promise.all([
      leadCount('', start),
      leadCount('', prevStart, prevEnd),
      leadCount("AND status = 'Qualified'", start),
      leadCount("AND status = 'Qualified'", prevStart, prevEnd),
      leadCount("AND status = 'Appointment Scheduled'", start),
      leadCount("AND status = 'Appointment Scheduled'", prevStart, prevEnd),
      avgResponse(start),
      avgResponse(prevStart, prevEnd),
      pool.query(
        `SELECT COUNT(DISTINCT lead_id) AS n FROM messages
         WHERE direction = 'outbound' AND sender = 'ai_agent' AND created_at >= ${start}`
      ),
      leadCount("AND status NOT IN ('Closed','Lost')", start),
      pool.query("SELECT COUNT(*) AS n FROM leads WHERE nurturing = true AND archived = false"),
      pool.query(
        `SELECT COUNT(*) AS n FROM messages
         WHERE direction = 'outbound' AND sender = 'ai_agent' AND created_at >= ${start}`
      ),
    ]);

    const leadsNewN   = num(leadsNew);
    const qualifiedN  = num(qualified);
    const avgRespN    = flt(avgResp);

    res.json({
      period,
      // Primarias + delta vs periodo anterior
      leads_new:           leadsNewN,
      leads_new_delta:     leadsNewN - num(leadsNewPrev),
      qualified:           qualifiedN,
      qualified_delta:     qualifiedN - num(qualifiedPrev),
      appointments:        num(appointments),
      appointments_delta:  num(appointments) - num(appointmentsPrev),
      avg_response_min:    Math.round(avgRespN * 10) / 10,
      avg_response_delta:  Math.round((avgRespN - flt(avgRespPrev)) * 10) / 10,
      // Banner estrella
      ai_responses:        num(aiResponses),
      // Secundarias
      active_leads:        num(activeLeads),
      nurturing_count:     num(nurturing),
      messages_sent:       num(messagesSent),
      qualification_rate:  leadsNewN ? Math.round((qualifiedN / leadsNewN) * 100) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/leads/:id — archiva (no borra físicamente)
async function archiveLead(req, res) {
  try {
    const { rows } = await pool.query(
      `UPDATE leads SET archived = true, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
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
    archived: Boolean(lead.archived),
    appointment_no_show: Boolean(lead.appointment_no_show),
    pipeline: lead.pipeline || 'agent',
    stage: lead.stage || 'new',
  };
}

module.exports = {
  getLeads, getLeadById, createLead, updateLead, getMessages, addMessage,
  getStats, sendHumanMessage, sendMediaMessage, getNurturing, updateStage, reactivateLead, archiveLead,
};
