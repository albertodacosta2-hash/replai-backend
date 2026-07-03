require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const { runNurturingCheck }  = require('./src/nurturingJob');
const { runEmailSequences }  = require('./src/emailSequenceJob');
const { runFollowUpJob }     = require('./src/followUpJob');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const requireAuth = require('./middleware/requireAuth');

// Rutas públicas (sin auth)
app.use('/api/auth',                 require('./routes/auth'));
app.use('/api/leads/media',          require('./routes/media'));        // proxy media: lo consume el navegador
app.use('/api/leads/reset-session',  require('./routes/resetSession')); // utilidad de test
app.use('/webhook',                  require('./routes/webhook'));      // lo llama Meta

// Rutas protegidas (requieren JWT)
app.use('/api/leads',      requireAuth, require('./routes/leads'));
app.use('/api/templates',  requireAuth, require('./routes/templates'));
app.use('/api/sequences',  requireAuth, require('./routes/sequences'));

app.get('/health', (_req, res) => res.json({ ok: true, agent: process.env.AGENT_NAME }));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Replai backend running on http://localhost:${PORT}`));
    runNurturingCheck();
    setInterval(runNurturingCheck, 60 * 60 * 1000);
    runEmailSequences();
    setInterval(runEmailSequences, 60 * 60 * 1000);
    runFollowUpJob();
    setInterval(runFollowUpJob, 2 * 60 * 1000);
  })
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
