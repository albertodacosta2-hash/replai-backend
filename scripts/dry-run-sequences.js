// Dry run del emailSequenceJob: muestra qué dispararía AHORA con la lógica corregida
// (día calendario en America/New_York + hora >= send_hour), sin enviar ni escribir nada.
// Uso: node scripts/dry-run-sequences.js
require('dotenv').config();
const { DateTime } = require('luxon');
const { pool } = require('../db');

const SEND_TIMEZONE = 'America/New_York';

function calendarDaysBetween(fromDate, tz) {
  const start = DateTime.fromJSDate(fromDate, { zone: tz }).startOf('day');
  const today = DateTime.now().setZone(tz).startOf('day');
  return Math.floor(today.diff(start, 'days').days);
}

async function main() {
  const now = DateTime.now().setZone(SEND_TIMEZONE);
  const nowMinutes = now.hour * 60 + now.minute;
  console.log(`Hora actual en Miami: ${now.toFormat('cccc dd LLL yyyy · HH:mm')} (${SEND_TIMEZONE})\n`);

  // Punto 4 del pedido: verificar que la columna send_hour exista
  const { rows: col } = await pool.query(
    `SELECT column_name, data_type, column_default
     FROM information_schema.columns
     WHERE table_name = 'email_sequence_steps' AND column_name = 'send_hour'`
  );
  if (col.length) {
    console.log(`✓ Columna send_hour existe: ${col[0].data_type}, default ${col[0].column_default}\n`);
  } else {
    console.log('✗ Columna send_hour NO existe — habría que agregarla\n');
  }

  const { rows: sequences } = await pool.query('SELECT * FROM email_sequences WHERE active = true');
  if (!sequences.length) { console.log('No hay secuencias activas.'); return; }

  const seqIds = sequences.map(s => s.id);
  const { rows: steps } = await pool.query(
    `SELECT s.*, t.subject FROM email_sequence_steps s
     JOIN email_templates t ON s.template_id = t.id
     WHERE s.sequence_id = ANY($1::int[]) ORDER BY s.sequence_id, s.step_order`,
    [seqIds]
  );
  const { rows: leads } = await pool.query(
    `SELECT id, email, name, status FROM leads
     WHERE nurturing = true AND email IS NOT NULL AND email <> '' AND archived = false`
  );
  if (!leads.length) { console.log('No hay leads en nurturing.'); return; }

  const { rows: enrollments } = await pool.query('SELECT * FROM email_sequence_enrollments');
  const { rows: logs } = await pool.query("SELECT lead_id, step_id, status, sent_at FROM email_sequence_log");

  let wouldSend = 0;
  for (const seq of sequences) {
    const seqSteps = steps.filter(s => s.sequence_id === seq.id);
    if (!seqSteps.length) continue;
    console.log(`━━ Secuencia #${seq.id} "${seq.name}" (${seq.list_type}) ━━`);

    for (const lead of leads) {
      const isQualified = lead.status === 'Qualified';
      if (seq.list_type === 'qualified' && !isQualified) continue;
      if (seq.list_type === 'cold' && isQualified) continue;

      const enroll = enrollments.find(e => e.lead_id === lead.id && e.sequence_id === seq.id);
      const days = enroll
        ? calendarDaysBetween(new Date(enroll.enrolled_at), SEND_TIMEZONE)
        : 0; // el job lo inscribiría en esta corrida → día 0
      const enrollNote = enroll
        ? `inscrito ${DateTime.fromJSDate(new Date(enroll.enrolled_at), { zone: SEND_TIMEZONE }).toFormat('dd LLL HH:mm')} → día ${days}`
        : 'se inscribiría ahora → día 0';
      console.log(`  Lead #${lead.id} ${lead.name} <${lead.email}> [${lead.status}] — ${enrollNote}`);

      let accumulated = 0;
      for (const step of seqSteps) {
        accumulated += step.delay_days;
        const [h, m] = (step.send_hour || '09:00').split(':').map(Number);
        const stepMinutes = h * 60 + (m || 0);
        const label = `Día ${accumulated} · ${step.send_hour} "${step.subject}"`;
        const log = logs.find(l => l.lead_id === lead.id && l.step_id === step.id && l.status === 'sent');

        if (log) {
          const sentAt = DateTime.fromJSDate(new Date(log.sent_at), { zone: SEND_TIMEZONE }).toFormat('dd LLL HH:mm');
          console.log(`    ✓ ya enviado    — ${label} (salió ${sentAt})`);
        } else if (days < accumulated) {
          console.log(`    ⏳ espera día    — ${label} (faltan ${accumulated - days} día(s))`);
          break; // igual que el job: no mira pasos posteriores
        } else if (nowMinutes < stepMinutes) {
          console.log(`    ⏰ espera hora   — ${label} (dispara a las ${step.send_hour})`);
        } else {
          console.log(`    🚀 ENVIARÍA AHORA — ${label}`);
          wouldSend++;
        }
      }
    }
  }
  console.log(`\nTotal que dispararía en este tick: ${wouldSend}`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); }).finally(() => pool.end());
