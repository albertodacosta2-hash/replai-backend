const { pool } = require('../db');

async function runNurturingCheck() {
  try {
    // Regla 1: Agent pipeline, sin actividad en 4 días desde new/replied
    await pool.query(`
      UPDATE leads SET nurturing = true, updated_at = NOW()
      WHERE nurturing = false
        AND pipeline = 'agent'
        AND stage IN ('new', 'replied')
        AND last_activity_at < NOW() - INTERVAL '4 days'
    `);

    // Regla 2: Appointment con no_show confirmado, sin actividad en 4 días
    await pool.query(`
      UPDATE leads SET nurturing = true, updated_at = NOW()
      WHERE nurturing = false
        AND stage = 'appointment'
        AND appointment_no_show = true
        AND last_activity_at < NOW() - INTERVAL '4 days'
    `);

    // Regla 3: Realtor post_visit, sin actividad en 4 días
    await pool.query(`
      UPDATE leads SET nurturing = true, updated_at = NOW()
      WHERE nurturing = false
        AND pipeline = 'realtor'
        AND stage = 'post_visit'
        AND last_activity_at < NOW() - INTERVAL '4 days'
    `);

    // Regla 4: Cita pasada y ghosteó — marcar no_show y mover a nurturing
    await pool.query(`
      UPDATE leads SET nurturing = true, appointment_no_show = true, updated_at = NOW()
      WHERE nurturing = false
        AND stage = 'appointment'
        AND appointment_no_show = false
        AND appointment_at IS NOT NULL
        AND appointment_at < NOW()
        AND last_activity_at < NOW() - INTERVAL '4 days'
    `);

    console.log('[nurturingJob] check completado');
  } catch (err) {
    console.error('[nurturingJob] error:', err.message);
  }
}

module.exports = { runNurturingCheck };
