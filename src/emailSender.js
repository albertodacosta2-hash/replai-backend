const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendCampaignEmail(to, subject, html) {
  const { data, error } = await resend.emails.send({
    from: 'Replai <onboarding@resend.dev>',
    to,
    subject,
    html,
  });
  if (error) {
    const detail = error.name ? `${error.name}: ${error.message}` : error.message;
    console.error('[emailSender] Error enviando a', to, ':', detail);
    return { ok: false, error: detail };
  }
  console.log('[emailSender] Enviado a', to, '| id:', data.id);
  return { ok: true, id: data.id };
}

module.exports = { sendCampaignEmail };
