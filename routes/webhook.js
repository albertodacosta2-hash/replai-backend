const express = require('express');
const router = express.Router();
const { enqueue } = require('../src/alexAgent');
const { pool } = require('../db');
const { getLatestInstagramMessage } = require('../src/instagramSender');

// Dedupe en memoria de mids de Instagram ya procesados — evita reprocesar el mismo
// mensaje si Meta manda varios pings de 'message_edit' para el mismo envío.
const processedIgMids = new Set();

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

// GET /webhook/ig-subscribe?secret=<META_VERIFY_TOKEN> — diagnóstico/setup temporal.
// Verificar el webhook en Meta NO suscribe automáticamente la cuenta de Instagram a
// recibir eventos; hace falta este llamado explícito a subscribed_apps. Se elimina
// una vez confirmado que los DMs llegan. Protegido con el mismo secreto del verify token
// para que no sea un endpoint público abierto.
router.get('/ig-subscribe', async (req, res) => {
  if (req.query.secret !== process.env.META_VERIFY_TOKEN) return res.sendStatus(403);
  try {
    // graph.instagram.com — el token IGAA es de "Instagram API with Instagram Login".
    const url = `https://graph.instagram.com/v21.0/${process.env.INSTAGRAM_ACCOUNT_ID}/subscribed_apps?subscribed_fields=messages`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` },
    });
    const data = await resp.json();
    console.log('[ig-subscribe]', resp.status, JSON.stringify(data));
    res.status(resp.status).json(data);
  } catch (err) {
    console.error('[ig-subscribe] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /webhook/ig-status?secret=<META_VERIFY_TOKEN> — confirma si la cuenta quedó suscrita.
router.get('/ig-status', async (req, res) => {
  if (req.query.secret !== process.env.META_VERIFY_TOKEN) return res.sendStatus(403);
  try {
    const url = `https://graph.instagram.com/v21.0/${process.env.INSTAGRAM_ACCOUNT_ID}/subscribed_apps`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` },
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /webhook/ig-resolve-mid?mid=<mid>&secret=<META_VERIFY_TOKEN> — resuelve un
// message id contra la Graph API para ver su contenido real (sender, texto). Los
// eventos 'message_edit' que está mandando Meta no traen sender/texto, solo el mid.
router.get('/ig-resolve-mid', async (req, res) => {
  if (req.query.secret !== process.env.META_VERIFY_TOKEN) return res.sendStatus(403);
  try {
    const fields = req.query.fields || 'id,from,to,message,created_time';
    const url = `https://graph.instagram.com/v21.0/${encodeURIComponent(req.query.mid)}?fields=${encodeURIComponent(fields)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` },
    });
    const data = await resp.json();
    console.log('[ig-resolve-mid]', resp.status, JSON.stringify(data));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /webhook/ig-debug-token?secret=<META_VERIFY_TOKEN> — inspecciona la FORMA del
// token guardado en Railway sin exponerlo completo (solo longitud y bordes), para
// detectar comillas/espacios/valor vacío sin pegar el secreto en ningún lado. Temporal.
router.get('/ig-debug-token', (req, res) => {
  if (req.query.secret !== process.env.META_VERIFY_TOKEN) return res.sendStatus(403);
  const raw = process.env.INSTAGRAM_ACCESS_TOKEN;
  const acc = process.env.INSTAGRAM_ACCOUNT_ID;
  res.json({
    accessToken: raw ? {
      length: raw.length,
      startsWithEAA: raw.startsWith('EAA'),
      hasLeadingWhitespace: raw !== raw.trimStart(),
      hasTrailingWhitespace: raw !== raw.trimEnd(),
      hasQuotes: raw.includes('"') || raw.includes("'"),
      first6: raw.slice(0, 6),
      last6: raw.slice(-6),
    } : 'NO DEFINIDO (undefined)',
    accountId: acc ? { value: acc, length: acc.length } : 'NO DEFINIDO (undefined)',
  });
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

  // Diagnóstico temporal: registra cualquier POST que llegue, sin importar el shape.
  // Ver comentario en db/index.js (webhook_debug_log) — quitar una vez confirmado Instagram.
  pool.query(
    `INSERT INTO webhook_debug_log (object, body) VALUES ($1, $2)`,
    [req.body?.object || null, JSON.stringify(req.body || {})]
  ).catch(err => console.error('[webhook debug log] error:', err.message));

  try {
    // ── Instagram DM (object === 'instagram') ──
    // Mismo endpoint y verify token que WhatsApp; el payload llega como
    // entry[].messaging[] con sender.id (IGSID) + message.text.
    if (req.body?.object === 'instagram') {
      for (const entry of req.body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          const text = event.message?.text;

          if (senderId && text) {
            // Shape estándar (Messenger-style) — flujo directo.
            if (event.message?.is_echo || senderId === process.env.INSTAGRAM_ACCOUNT_ID) continue;
            console.log(`[Instagram] ig:${senderId}: "${text.slice(0, 60)}"`);
            enqueue('ig:' + senderId, text);
            continue;
          }

          // Fallback: la cuenta manda 'message_edit' sin sender/texto (observado con
          // "Instagram API with Instagram Login"). Se resuelve consultando la conversación.
          if (event.message_edit) {
            try {
              const latest = await getLatestInstagramMessage();
              // Log a DB del resultado crudo — no hay acceso a logs de consola de Railway.
              await pool.query(
                `INSERT INTO webhook_debug_log (object, body) VALUES ('ig-fallback-result', $1)`,
                [JSON.stringify({ latest })]
              ).catch(() => {});
              if (!latest || !latest.senderId || !latest.text) continue;
              if (latest.senderId === process.env.INSTAGRAM_ACCOUNT_ID) continue; // eco propio
              if (processedIgMids.has(latest.mid)) continue; // ya procesado
              processedIgMids.add(latest.mid);
              console.log(`[Instagram:fallback] ig:${latest.senderId}: "${latest.text.slice(0, 60)}"`);
              enqueue('ig:' + latest.senderId, latest.text);
            } catch (err) {
              await pool.query(
                `INSERT INTO webhook_debug_log (object, body) VALUES ('ig-fallback-error', $1)`,
                [JSON.stringify({ error: err.message })]
              ).catch(() => {});
              console.error('[Instagram:fallback] error resolviendo conversación:', err.message);
            }
          }
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
