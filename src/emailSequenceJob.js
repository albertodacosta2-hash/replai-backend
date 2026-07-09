const { pool } = require('../db');
const { sendCampaignEmail } = require('./emailSender');

async function runEmailSequences() {
  try {
    const { rows: sequences } = await pool.query(
      'SELECT * FROM email_sequences WHERE active = true'
    );
    if (!sequences.length) return;

    const seqIds = sequences.map(s => s.id);
    const { rows: steps } = await pool.query(
      `SELECT s.*, t.subject, t.html
       FROM email_sequence_steps s
       JOIN email_templates t ON s.template_id = t.id
       WHERE s.sequence_id = ANY($1::int[])
       ORDER BY s.sequence_id, s.step_order`,
      [seqIds]
    );

    const { rows: leads } = await pool.query(
      `SELECT id, email, name, last_activity_at, status
       FROM leads
       WHERE nurturing = true
         AND email IS NOT NULL AND email <> ''
         AND archived = false`
    );
    if (!leads.length) return;

    let sent = 0;
    for (const seq of sequences) {
      const seqSteps = steps.filter(s => s.sequence_id === seq.id);
      if (!seqSteps.length) continue;

      for (const lead of leads) {
        const isQualified = lead.status === 'Qualified';
        if (seq.list_type === 'qualified' && !isQualified) continue;
        if (seq.list_type === 'cold'      &&  isQualified) continue;

        const daysInactive = Math.floor(
          (Date.now() - new Date(lead.last_activity_at).getTime()) / 86400000
        );

        let accumulated = 0;
        for (const step of seqSteps) {
          accumulated += step.delay_days;
          if (daysInactive < accumulated) break;

          // Espera a que la hora del servidor alcance la hora programada del paso
          // (no hay timezone por lead — se usa la hora local del servidor).
          const [stepHour] = (step.send_hour || '09:00').split(':').map(Number);
          if (new Date().getHours() < stepHour) continue;

          const { rows: logs } = await pool.query(
            'SELECT id FROM email_sequence_log WHERE lead_id = $1 AND step_id = $2',
            [lead.id, step.id]
          );
          if (logs.length) continue;

          const result = await sendCampaignEmail(lead.email, step.subject, step.html);
          await pool.query(
            `INSERT INTO email_sequence_log (lead_id, sequence_id, step_id, status)
             VALUES ($1,$2,$3,$4)`,
            [lead.id, seq.id, step.id, result.ok ? 'sent' : 'error']
          );
          if (result.ok) sent++;
        }
      }
    }

    console.log(`[emailSequenceJob] check completado — ${sent} emails enviados`);
  } catch (err) {
    console.error('[emailSequenceJob] error:', err.message);
  }
}

module.exports = { runEmailSequences };
