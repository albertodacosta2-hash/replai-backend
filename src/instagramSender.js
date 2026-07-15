// Envío de mensajes de texto por Instagram DM.
// El token (prefijo IGAA) es de "Instagram API with Instagram Login" — ese producto
// usa graph.instagram.com, no graph.facebook.com (que es solo para tokens EAA de
// Facebook Login for Business). Usar el host equivocado da "Cannot parse access token".
async function sendInstagramMessage(recipientId, body) {
  const url = `https://graph.instagram.com/v21.0/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`;
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
