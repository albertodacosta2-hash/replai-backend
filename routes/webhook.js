const express = require('express');
const router = express.Router();
const { enqueue } = require('../src/alexAgent');
const { pool } = require('../db');

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

function extractMediaBody(msg) {
  switch (msg.type) {
    case 'image':    return `[imagen:${msg.image?.id}]`;
    case 'audio':    return `[audio:${msg.audio?.id}]`;
    case 'video':    return `[video:${msg.video?.id}]`;
    case 'sticker':  return `[imagen:${msg.sticker?.id}]`;
    case 'document': return `[documento:${msg.document?.id}:${msg.document?.filename || 'archivo'}]`;
    default:         return null;
  }
}

// POST /webhook — inbound messages from Meta
router.post('/', async (req, res) => {
  res.sendStatus(200); // ACK inmediato, Meta requiere < 5s

  try {
    // ── Instagram DM (object === 'instagram') ──
    // Mismo endpoint y verify token que WhatsApp; el payload llega como
    // entry[].messaging[] con sender.id (IGSID) + message.text.
    if (req.body?.object === 'instagram') {
      for (const entry of req.body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const text = event.message?.text;
          // Skip echoes (mensajes que envió la propia cuenta) — evita loop infinito
          if (!senderId || event.message?.is_echo) continue;
          if (senderId === process.env.INSTAGRAM_ACCOUNT_ID) continue;
          if (!text) continue; // attachments/reactions/postbacks: solo texto por ahora
          console.log(`[Instagram] ig:${senderId}: "${text.slice(0, 60)}"`);
          enqueue('ig:' + senderId, text);
        }
      }
      return;
    }

    // ── WhatsApp (flujo existente, sin cambios) ──
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return; // status updates, read receipts, etc.

    const msg  = messages[0];
    const from = '+' + msg.from;
    if (!from) return;

    if (msg.type === 'text') {
      const body = msg.text?.body;
      if (!body) return;
      console.log(`[Meta] ${from}: "${body.slice(0, 60)}"`);
      enqueue(from, body);
      return;
    }

    // Media message — save to DB directly, don't pass to AI
    const mediaBody = extractMediaBody(msg);
    if (!mediaBody) return;

    console.log(`[Meta] ${from}: ${mediaBody.slice(0, 60)}`);

    let { rows } = await pool.query('SELECT id FROM leads WHERE phone = $1', [from]);
    if (!rows.length) {
      const ins = await pool.query(
        `INSERT INTO leads (phone, channel, source, status) VALUES ($1, 'meta_whatsapp', 'WhatsApp Inbound', 'New') RETURNING id`,
        [from]
      );
      rows = ins.rows;
    }
    const leadId = rows[0].id;

    await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'inbound', 'lead', $2)`,
      [leadId, mediaBody]
    );
    await pool.query(
      `UPDATE leads SET last_activity_at = NOW(), stage = CASE WHEN stage = 'new' THEN 'replied' ELSE stage END, updated_at = NOW() WHERE id = $1`,
      [leadId]
    );
  } catch (err) {
    console.error('[Meta Webhook error]', err.message);
  }
});

module.exports = router;
