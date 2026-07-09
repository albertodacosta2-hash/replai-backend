const { pool } = require('../db');
const { sendCampaignEmail } = require('./emailSender');

// El negocio opera en Miami — America/New_York ajusta automáticamente entre EST y EDT.
const SEND_TIMEZONE = 'America/New_York';

// Evita que dos corridas se solapen si una tarda más que el intervalo del setInterval.
let isRunning = false;

function currentMinutesInTZ(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return h * 60 + m;
}

function fmtMinutesOfDay(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

async function runEmailSequences() {
  if (isRunning) {
    console.log('[emailSequenceJob] corrida anterior aún en curso, se salta este tick');
    return;
  }
  isRunning = true;
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

    const nowMinutes = currentMinutesInTZ(SEND_TIMEZONE);
    let sent = 0, failed = 0, waitingDay = 0, waitingHour = 0, alreadyDone = 0;

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
          if (daysInactive < accumulated) { waitingDay++; break; }

          // Espera a que la hora de Miami (EST/EDT según la época del año) alcance
          // la hora y el minuto programados del paso — comparación de minutos-desde-
          // medianoche completa, no sólo la hora (antes ignoraba los minutos por completo).
          const [stepHour, stepMin] = (step.send_hour || '09:00').split(':').map(Number);
          const stepMinutes = stepHour * 60 + (stepMin || 0);
          if (nowMinutes < stepMinutes) { waitingHour++; continue; }

          try {
            const { rows: logs } = await pool.query(
              'SELECT id FROM email_sequence_log WHERE lead_id = $1 AND step_id = $2',
              [lead.id, step.id]
            );
            if (logs.length) { alreadyDone++; continue; }

            console.log(
              `[emailSequenceJob] procesando lead=${lead.id} (${lead.email}) seq=${seq.id} step=${step.id} ` +
              `programado=Día ${accumulated} · ${step.send_hour} Miami — hora actual Miami=${fmtMinutesOfDay(nowMinutes)}`
            );

            const result = await sendCampaignEmail(lead.email, step.subject, step.html);

            const { rows: inserted } = await pool.query(
              `INSERT INTO email_sequence_log (lead_id, sequence_id, step_id, status, error_message)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (lead_id, step_id) DO NOTHING
               RETURNING id`,
              [lead.id, seq.id, step.id, result.ok ? 'sent' : 'failed', result.ok ? null : result.error]
            );
            if (!inserted.length) {
              // Otra corrida ganó la carrera y ya insertó este mismo lead+paso — no hay nada más que hacer.
              console.log(`[emailSequenceJob] lead=${lead.id} step=${step.id} ya fue registrado por otra corrida, se omite`);
              continue;
            }

            if (result.ok) {
              sent++;
              console.log(`[emailSequenceJob] ✅ enviado lead=${lead.id} step=${step.id} resend_id=${result.id}`);
            } else {
              failed++;
              console.error(`[emailSequenceJob] ❌ falló lead=${lead.id} step=${step.id} error="${result.error}"`);
            }
          } catch (itemErr) {
            failed++;
            console.error(`[emailSequenceJob] error procesando lead=${lead.id} step=${step.id}:`, itemErr.message);
          }
        }
      }
    }

    console.log(
      `[emailSequenceJob] check completado — enviados=${sent} fallidos=${failed} ` +
      `ya_procesados=${alreadyDone} esperando_día=${waitingDay} esperando_hora=${waitingHour}`
    );
  } catch (err) {
    console.error('[emailSequenceJob] error:', err.message);
  } finally {
    isRunning = false;
  }
}

module.exports = { runEmailSequences };
