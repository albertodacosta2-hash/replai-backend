require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/api/leads', require('./routes/leads'));
app.use('/webhook',   require('./routes/webhook'));

app.get('/health', (_req, res) => res.json({ ok: true, agent: process.env.AGENT_NAME }));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => app.listen(PORT, () => console.log(`Replai backend running on http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
