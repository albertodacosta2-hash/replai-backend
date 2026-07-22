const { pool } = require('../db');
const { sendWhatsAppMeta } = require('./metaSender');
const { hasFollowUpTimer, sessions, computeFollowUpAt } = require('./alexAgent');

const FOLLOWUP_CON_EQUIPO = [
  (equipo) => `Hola, ¿alguna duda sobre ${equipo}? Estoy aquí para ayudarte 😊`,
  (equipo) => `¿Sigues interesado en la ${equipo}? Tenemos disponibilidad esta semana 🚜`,
  ()       => `Última consulta, ¿quieres que te aparte el equipo o prefieres que te contacte más adelante? 🙌`,
];

const FOLLOWUP_SIN_EQUIPO = [
  () => 'Hola, ¿sigues ahí? Cualquier máquina que necesites para tu obra, dime y te ayudo 💪',
  () => '¿Te puedo ayudar con algún equipo? Tenemos retroexcavadoras, excavadoras, bulldozers y más 🚜',
  () => 'No quiero ser pesado, si necesitas maquinaria en algún momento aquí estoy 🙌',
];

async function runFollowUpJob() {
  try {
    const { rows } = await pool.query(`
      SELECT id, phone, follow_up_count, last_lead_data
      FROM leads
      WHERE follow_up_at <= NOW()
        AND follow_up_at IS NOT NULL
        AND nurturing = false
        AND lead_notified = false
        AND follow_up_count < 3
        AND ai_active = 1
    `);

    if (rows.length > 0) {
      console.log(`[followUpJob] ${rows.length} lead(s) con follow-up pendiente`);
    }

    for (const lead of rows) {
      // Si el timer en memoria sigue activo, lo deja disparar (evita doble envío)
      if (hasFollowUpTimer(lead.phone)) {
        console.log(`[followUpJob] timer en memoria activo para ${lead.phone}, skip`);
        continue;
      }

      // Claim atómico — solo uno de los dos caminos (job vs timer) entra
      const { rowCount } = await pool.query(
        `UPDATE leads SET follow_up_at = NULL, updated_at = NOW()
         WHERE id = $1 AND follow_up_at IS NOT NULL AND follow_up_count < 3`,
        [lead.id]
      );
      if (rowCount === 0) continue; // timer lo reclamó justo antes

      const idx = lead.follow_up_count;
      const newCount = idx + 1;
      const equipo = lead.last_lead_data?.equipo;
      const msg = equipo ? FOLLOWUP_CON_EQUIPO[idx](equipo) : FOLLOWUP_SIN_EQUIPO[idx]();

      try {
        await sendWhatsAppMeta(lead.phone, msg);
        await pool.query(
          `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'ai_agent', $2)`,
          [lead.id, msg]
        );
        await pool.query(
          `UPDATE leads SET follow_up_count = $1, updated_at = NOW() WHERE id = $2`,
          [newCount, lead.id]
        );
        console.log(`[followUpJob] follow-up ${newCount}/3 enviado → ${lead.phone}`);

        if (newCount >= 3) {
          await pool.query(
            `UPDATE leads SET nurturing = true, updated_at = NOW() WHERE id = $1`,
            [lead.id]
          );
          console.log(`[followUpJob] lead → nurturing → ${lead.phone}`);
        } else {
          // Programa el próximo follow-up (FU2/FU3) para el día siguiente a las 10am Caracas
          await pool.query(
            `UPDATE leads SET follow_up_at = $1, updated_at = NOW() WHERE id = $2`,
            [computeFollowUpAt(newCount + 1), lead.id]
          );
        }

        // Sincronizar sesión en memoria si sigue viva (post-restart normalmente no existe)
        if (sessions.has(lead.phone)) {
          const session = sessions.get(lead.phone);
          session.followUpCount = newCount;
          session.messages.push({ role: 'assistant', content: msg });
        }
      } catch (err) {
        console.error(`[followUpJob] send error → ${lead.phone}:`, err.message);
        // Reintento en el próximo ciclo del job (2 min)
        pool.query(
          `UPDATE leads SET follow_up_at = NOW() + INTERVAL '2 minutes', updated_at = NOW() WHERE id = $1`,
          [lead.id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[followUpJob] query error:', err.message);
  }
}

module.exports = { runFollowUpJob };
