// Construye un Error enriquecido con el código de Meta a partir del cuerpo de la respuesta.
// Meta devuelve { error: { code, message, error_data: { details } } }.
async function metaError(resp, prefix) {
  const raw = await resp.text();
  let metaCode = null, metaMessage = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error) {
      metaCode = parsed.error.code ?? null;
      metaMessage = parsed.error.error_data?.details || parsed.error.message || raw;
    }
  } catch (_) { /* respuesta no-JSON: se conserva el texto crudo */ }
  const err = new Error(`${prefix}: ${metaMessage}`);
  err.metaCode = metaCode;
  err.metaMessage = metaMessage;
  return err;
}

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
  if (!resp.ok) throw await metaError(resp, 'Meta API error');
}

// Envía una plantilla aprobada (único formato permitido fuera de la ventana de 24h).
// `params` son los valores para los placeholders {{1}}, {{2}}… del cuerpo (opcional).
async function sendWhatsAppTemplate(to, templateName, langCode = 'es', params = []) {
  const url = `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`;
  const template = { name: templateName, language: { code: langCode } };
  if (params.length) {
    template.components = [{
      type: 'body',
      parameters: params.map(text => ({ type: 'text', text: String(text) })),
    }];
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
  });
  if (!resp.ok) throw await metaError(resp, 'Meta template error');
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
  if (!resp.ok) throw await metaError(resp, 'Meta media upload error');
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
  if (!resp.ok) throw await metaError(resp, 'Meta API error');
}

module.exports = { sendWhatsAppMeta, sendWhatsAppTemplate, uploadMediaToMeta, sendWhatsAppMedia };
