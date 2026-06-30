async function sendWhatsAppMeta(to, body) {
  const url = `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!resp.ok) throw new Error(`Meta API error: ${await resp.text()}`);
}

async function uploadMediaToMeta(buffer, mimetype, filename) {
  const url = `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimetype }), filename);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.META_TOKEN}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`Meta media upload error: ${await resp.text()}`);
  const data = await resp.json();
  return data.id;
}

async function sendWhatsAppMedia(to, mediaId, mediaType, filename) {
  const url = `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const mediaObj = { id: mediaId };
  if (mediaType === 'document') mediaObj.filename = filename;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: mediaType,
      [mediaType]: mediaObj,
    }),
  });
  if (!resp.ok) throw new Error(`Meta API error: ${await resp.text()}`);
}

module.exports = { sendWhatsAppMeta, uploadMediaToMeta, sendWhatsAppMedia };
