const express = require('express');
const router = express.Router();
const multer = require('multer');
const twilio = require('twilio');
const { pool } = require('../db');
const ctrl = require('../controllers/leadsController');
const { handleMessage } = require('../src/agent');
const { clearSession } = require('../src/alexAgent');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// ── REST API ──
router.get('/stats',          ctrl.getStats);
router.get('/nurturing',      ctrl.getNurturing);
router.get('/media/:mediaId', async (req, res) => {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${req.params.mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.META_TOKEN}` },
    });
    if (!metaRes.ok) throw new Error(`Meta metadata error: ${await metaRes.text()}`);
    const { url } = await metaRes.json();

    const fileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.META_TOKEN}` },
    });
    if (!fileRes.ok) throw new Error('Meta media download error');

    res.setHeader('Content-Type', fileRes.headers.get('content-type') || 'application/octet-stream');
    const buf = await fileRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/',               ctrl.getLeads);
router.get('/:id',            ctrl.getLeadById);
router.post('/',              ctrl.createLead);
router.patch('/:id',          ctrl.updateLead);
router.delete('/:id',         ctrl.archiveLead);
router.get('/:id/messages',   ctrl.getMessages);
router.post('/:id/messages',  ctrl.addMessage);
router.post('/:id/send-message',  ctrl.sendHumanMessage);
router.post('/:id/send-media',    upload.single('file'), ctrl.sendMediaMessage);
router.patch('/:id/stage',        ctrl.updateStage);
router.post('/:id/reactivate',    ctrl.reactivateLead);

// ── Session reset (para tests) ──
router.get('/reset-session/:phone', (req, res) => {
  clearSession(decodeURIComponent(req.params.phone));
  res.json({ ok: true });
});

// ── Twilio WhatsApp Webhook ──
router.post('/webhook/twilio', async (req, res) => {
  try {
    const sig = req.headers['x-twilio-signature'];
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    if (process.env.NODE_ENV === 'production') {
      const valid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, req.body);
      if (!valid) return res.status(403).send('Forbidden');
    }

    const from = req.body.From?.replace('whatsapp:', '') || '';
    const body = req.body.Body || '';

    if (!from || !body) return res.type('text/xml').send('<Response/>');

    // Upsert lead
    const existing = await pool.query('SELECT id FROM leads WHERE phone = $1', [from]);
    let leadId;

    if (existing.rows[0]) {
      leadId = existing.rows[0].id;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO leads (phone, channel, source, status)
         VALUES ($1, 'whatsapp', 'WhatsApp Inbound', 'New') RETURNING id`,
        [from]
      );
      leadId = rows[0].id;
    }

    await pool.query(
      `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'inbound', 'lead', $2)`,
      [leadId, body]
    );
    await pool.query('UPDATE leads SET updated_at = NOW() WHERE id = $1', [leadId]);

    console.log(`[WhatsApp] ${from}: "${body.slice(0, 60)}"`);

    // Respond to Twilio immediately, then call AI async
    res.type('text/xml').send('<Response/>');

    // AI agent responds (fire-and-forget after Twilio ack)
    handleMessage(leadId, from).catch(err => console.error('[Agent error]', err.message));
  } catch (err) {
    console.error('[Webhook error]', err.message);
    res.type('text/xml').send('<Response/>');
  }
});

module.exports = router;
