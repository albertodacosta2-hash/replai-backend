require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./db');
const { runNurturingCheck }  = require('./src/nurturingJob');
const { runEmailSequences }  = require('./src/emailSequenceJob');
const { runFollowUpJob }     = require('./src/followUpJob');

// ── Variables de entorno críticas: abortar si falta alguna ──
const required = ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'META_TOKEN', 'JWT_SECRET'];
required.forEach(v => {
  if (!process.env[v]) {
    console.error(`ERROR: Variable ${v} no definida`);
    process.exit(1);
  }
});

const app = express();

// Railway/Vercel corren detrás de un proxy — necesario para que el rate limit lea la IP real
app.set('trust proxy', 1);

// ── Security headers (Helmet) ──
app.use(helmet({
  contentSecurityPolicy: false,      // el frontend vive en Vercel; no servimos HTML aquí
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ──
// El webhook de Meta debe aceptar cualquier origen (se aplica antes del CORS general)
app.use('/webhook', cors({ origin: '*' }));

const allowedOrigins = [
  'https://replai-theta.vercel.app',
  'https://replai.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
}));

// ── Límite de tamaño de payload ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ──
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login' },
});
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

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
