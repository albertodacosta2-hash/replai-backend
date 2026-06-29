require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const result = await pool.query("SELECT id FROM leads WHERE phone = '+584122100856'");
  const leadId = result.rows[0]?.id;
  if (leadId) {
    await pool.query("DELETE FROM messages WHERE lead_id = $1", [leadId]);
    console.log('Mensajes borrados');
  }
  await pool.query("UPDATE leads SET stage = 'new', status = 'New', lead_notified = false, name = null, last_lead_data = null WHERE phone = '+584122100856'");
  console.log('Reset OK');
  await pool.end();

  // Limpiar sesión en memoria de Railway
  https.get('https://replai-backend-production-fa37.up.railway.app/api/leads/reset-session/%2B584122100856', (res) => {
    console.log(`Sesión en memoria limpiada (${res.statusCode})`);
  }).on('error', (err) => {
    console.warn('No se pudo limpiar sesión en Railway:', err.message);
  });
})();
