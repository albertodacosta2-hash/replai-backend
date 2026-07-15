// Envío de mensajes de texto por Instagram DM (Meta Graph API).
// INSTAGRAM_ACCOUNT_ID e INSTAGRAM_ACCESS_TOKEN ya están configurados en Railway.
async function sendInstagramMessage(recipientId, body) {
  const url = `https://graph.facebook.com/v19.0/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: body },
    }),
  });
  if (!resp.ok) throw new Error(`Instagram API error: ${await resp.text()}`);
}

module.exports = { sendInstagramMessage };
