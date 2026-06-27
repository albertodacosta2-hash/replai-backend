const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsApp(to, body) {
  const formatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: formatted,
    body,
  });
}

async function notifyRealtor(lead) {
  const realtorNumber = process.env.REALTOR_WHATSAPP;
  if (!realtorNumber) return;

  const msg =
    `🎯 Nuevo lead calificado!\n` +
    `Nombre: ${lead.name || 'Sin nombre'}\n` +
    `Teléfono: ${lead.phone}\n` +
    `Tipo: ${lead.type}\n` +
    `Zona: ${lead.zone || '—'}\n` +
    `Presupuesto: ${lead.budget || '—'}\n` +
    `Canal: ${lead.channel}\n` +
    `Ver en Replai: /inbox → lead #${lead.id}`;

  await sendWhatsApp(realtorNumber, msg);
}

module.exports = { sendWhatsApp, notifyRealtor };
