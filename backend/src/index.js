require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { init: initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);

// Init Socket.io before routes
initSocket(server);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = [
  'https://roady-bj1u.vercel.app',
  process.env.CORS_ORIGIN,
].filter(Boolean);
app.use(cors({
  origin: function(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, true); // allow all during testing
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { error: 'Too many requests, slow down' },
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/jobs',      require('./routes/jobs'));
app.use('/api/bids',      require('./routes/bids'));
app.use('/api/providers', require('./routes/providers'));
app.use('/api/affiliate', require('./routes/affiliate'));
app.use('/api/payments',  require('./routes/payments'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Roady API running on port ${PORT} [${process.env.NODE_ENV}]`);
});
