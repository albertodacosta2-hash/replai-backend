const express = require('express');
const router = express.Router();
const { enqueue } = require('../src/alexAgent');

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
    enqueue(from, body);
  } catch (err) {
    console.error('[Meta Webhook error]', err.message);
  }
});

module.exports = router;
