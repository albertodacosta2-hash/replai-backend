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

// Fallback: cuando el webhook llega como 'message_edit' (sin sender ni texto —
// comportamiento observado en cuentas con "Instagram API with Instagram Login"),
// se consulta directamente la conversación más reciente para obtener el mensaje real.
async function getLatestInstagramMessage() {
  const url = `https://graph.instagram.com/v21.0/${process.env.INSTAGRAM_ACCOUNT_ID}/conversations` +
    `?platform=instagram&fields=id,messages.limit(1){id,from,to,message,created_time}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`Instagram API error: ${await resp.text()}`);
  const data = await resp.json();
  const convo = data.data?.[0];
  const msg = convo?.messages?.data?.[0];
  if (!msg) return null;
  return {
    mid: msg.id,
    senderId: msg.from?.id,
    text: msg.message,
    createdTime: msg.created_time,
  };
}

module.exports = { sendInstagramMessage, getLatestInstagramMessage };
