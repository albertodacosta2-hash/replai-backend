const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { handleMessage } = require('../src/agent');
const { sendWhatsAppMeta } = require('../src/metaSender');

const pending = new Map(); // phone → timeout handle
const DEBOUNCE_MS = 3000;

// GET /webhook — Meta webhook verification
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[Meta] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /webhook — inbound messages from Meta
router.post('/', async (req, res) => {
  res.sendStatus(200); // ACK inmediato, Meta requiere < 5s

  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return; // status updates, read receipts, etc.

    const msg  = messages[0];
    const from = '+' + msg.from; // normalizar: Meta envía sin "+", e.g. "17867558495"
    const body = msg.text?.body;

    if (!from || !body) return;

    console.log(`[Meta] ${from}: "${body.slice(0, 60)}"`);

    // Upsert lead
    const existing = await pool.query('SELECT id FROM leads WHERE phone = $1', [from]);
    let leadId;

    if (existing.rows[0]) {
      leadId = existing.rows[0].id;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO leads (phone, channel, source, status)
         VALUES ($1, 'meta_whatsapp', 'Meta WhatsApp Inbound', 'New') RETURNING id`,
        [from]
      );
      leadId = rows[0].id;
    }

    // Guardar mensaje entrante en PostgreSQL
    await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'inbound', 'lead', $2)`,
      [leadId, body]
    );
    await pool.query('UPDATE leads SET updated_at = NOW() WHERE id = $1', [leadId]);

    // Si AI está pausada para este lead → no encolar
    const { rows: leadRows } = await pool.query('SELECT ai_active FROM leads WHERE id = $1', [leadId]);
    if (!leadRows[0]?.ai_active) return;

    // Debounce: cancelar timer previo si el cliente mandó otro mensaje
    if (pending.has(from)) clearTimeout(pending.get(from));

    const timer = setTimeout(() => {
      pending.delete(from);
      handleMessage(leadId, from, sendWhatsAppMeta).catch(err =>
        console.error('[Meta Agent error]', err.message)
      );
    }, DEBOUNCE_MS);

    pending.set(from, timer);
  } catch (err) {
    console.error('[Meta Webhook error]', err.message);
  }
});

module.exports = router;
