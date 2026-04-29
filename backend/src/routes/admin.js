const router = require('express').Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ── Auto-create tables ────────────────────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS managers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    permissions JSONB DEFAULT '{"orders":false,"providers":false,"customers":false,"payments":false,"affiliates":false}',
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('Manager table init error:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS affiliate_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_type VARCHAR(10) NOT NULL CHECK (user_type IN ('customer','provider')),
    user_id UUID NOT NULL,
    code VARCHAR(20) UNIQUE NOT NULL,
    clicks INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('affiliate_codes init error:', err.message));

db.query(`
  CREATE TABLE IF NOT EXISTS affiliate_referrals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    referrer_type VARCHAR(10) NOT NULL,
    referrer_id UUID NOT NULL,
    referred_type VARCHAR(10) NOT NULL,
    referred_id UUID NOT NULL,
    code VARCHAR(20) NOT NULL,
    flat_bonus NUMERIC(8,2),
    flat_paid BOOLEAN DEFAULT FALSE,
    revenue_pct NUMERIC(5,4) DEFAULT 0,
    revenue_window_days SMALLINT DEFAULT 90,
    revenue_window_end TIMESTAMPTZ,
    total_revenue_earned NUMERIC(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','active','paid','expired')),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('affiliate_referrals init error:', err.message));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key && key === process.env.ADMIN_KEY) { req.role = 'admin'; return next(); }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireAdminOrManager(permission) {
  return async (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (key && key === process.env.ADMIN_KEY) { req.role = 'admin'; return next(); }
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.role !== 'manager') return res.status(401).json({ error: 'Unauthorized' });
      const { rows } = await db.query('SELECT * FROM managers WHERE id=$1 AND is_active=true', [payload.id]);
      if (!rows[0]) return res.status(401).json({ error: 'Manager inactive' });
      if (permission && !rows[0].permissions[permission]) return res.status(403).json({ error: 'No permission' });
      req.manager = rows[0];
      req.role = 'manager';
      next();
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
  };
}

// ── Manager login (public) ────────────────────────────────────────────────────
router.post('/manager-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
  try {
    const { rows } = await db.query('SELECT * FROM managers WHERE username=$1 AND is_active=true', [username]);
    if (!rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    await db.query('UPDATE managers SET last_login=NOW() WHERE id=$1', [rows[0].id]);
    const token = jwt.sign({ id: rows[0].id, role: 'manager', name: rows[0].name }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, manager: { id: rows[0].id, name: rows[0].name, username: rows[0].username, permissions: rows[0].permissions } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All routes below require admin key ────────────────────────────────────────
router.use('/managers', requireAdmin);

// ── Manager CRUD ──────────────────────────────────────────────────────────────
router.get('/managers', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id,name,username,permissions,is_active,last_login,created_at FROM managers ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/managers', async (req, res) => {
  const { name, username, password, permissions } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'name, username, password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO managers (name,username,password_hash,permissions) VALUES ($1,$2,$3,$4) RETURNING id,name,username,permissions,is_active,created_at`,
      [name, username, hash, JSON.stringify(permissions || {})]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username taken' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/managers/:id', async (req, res) => {
  const { permissions, is_active, name } = req.body;
  try {
    const updates = [], vals = [];
    let i = 1;
    if (permissions !== undefined) { updates.push(`permissions=$${i++}`); vals.push(JSON.stringify(permissions)); }
    if (is_active !== undefined) { updates.push(`is_active=$${i++}`); vals.push(is_active); }
    if (name !== undefined) { updates.push(`name=$${i++}`); vals.push(name); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE managers SET ${updates.join(',')} WHERE id=$${i}`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/managers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM managers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dashboard stats ───────────────────────────────────────────────────────────
router.get('/stats', requireAdminOrManager('orders'), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const weekAgo = new Date(Date.now() - 7*24*60*60*1000);
    const [customers, providers, jobs, revenue, todayJobs, weekJobs,
           todayCustomers, onlineProviders, revenueToday, disputes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM customers'),
      db.query('SELECT COUNT(*) FROM providers'),
      db.query('SELECT COUNT(*), status FROM jobs GROUP BY status'),
      db.query(`SELECT COALESCE(SUM(amount_total),0) as total FROM payments WHERE status='released'`),
      db.query(`SELECT COUNT(*) FROM jobs WHERE created_at >= $1`, [today]),
      db.query(`SELECT COUNT(*) FROM jobs WHERE created_at >= $1`, [weekAgo]),
      db.query(`SELECT COUNT(*) FROM customers WHERE created_at >= $1`, [today]),
      db.query(`SELECT COUNT(*) FROM providers WHERE is_online=true`),
      db.query(`SELECT COALESCE(SUM(amount_total),0) as total FROM payments WHERE status='released' AND released_at >= $1`, [today]),
      db.query(`SELECT COUNT(*) FROM jobs WHERE status='disputed'`),
    ]);
    const jobStats = {};
    jobs.rows.forEach(r => { jobStats[r.status] = parseInt(r.count); });
    res.json({
      customers: parseInt(customers.rows[0].count),
      providers: parseInt(providers.rows[0].count),
      onlineProviders: parseInt(onlineProviders.rows[0].count),
      jobs: jobStats,
      totalJobs: jobs.rows.reduce((a,r) => a+parseInt(r.count), 0),
      todayJobs: parseInt(todayJobs.rows[0].count),
      weekJobs: parseInt(weekJobs.rows[0].count),
      todayCustomers: parseInt(todayCustomers.rows[0].count),
      revenue: parseFloat(revenue.rows[0].total),
      revenueToday: parseFloat(revenueToday.rows[0].total),
      disputes: parseInt(disputes.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Revenue chart (7-day) ─────────────────────────────────────────────────────
router.get('/revenue/chart', requireAdminOrManager('payments'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT DATE(released_at) as day, COALESCE(SUM(amount_total),0) as revenue,
             COALESCE(SUM(platform_fee),0) as fees, COUNT(*) as jobs
      FROM payments WHERE status='released' AND released_at >= NOW()-INTERVAL '7 days'
      GROUP BY DATE(released_at) ORDER BY day ASC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Recent activity feed ──────────────────────────────────────────────────────
router.get('/activity', requireAdminOrManager('orders'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT j.id, j.status, j.created_at, j.accepted_at, j.completed_at,
             c.phone as customer_phone, p.company_name as provider_name,
             j.agreed_price
      FROM jobs j
      LEFT JOIN customers c ON c.id=j.customer_id
      LEFT JOIN providers p ON p.id=j.provider_id
      ORDER BY j.created_at DESC LIMIT 20
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Active job map pins ───────────────────────────────────────────────────────
router.get('/map', requireAdminOrManager('orders'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT j.id, j.status, j.location_lat, j.location_lng, j.location_text,
             c.phone as customer_phone, p.company_name as provider_name
      FROM jobs j
      LEFT JOIN customers c ON c.id=j.customer_id
      LEFT JOIN providers p ON p.id=j.provider_id
      WHERE j.location_lat IS NOT NULL AND j.status NOT IN ('completed','cancelled')
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customers ─────────────────────────────────────────────────────────────────
router.get('/customers', requireAdminOrManager('customers'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, phone, name, created_at,
        (SELECT COUNT(*) FROM jobs WHERE customer_id=customers.id) as job_count,
        (SELECT COUNT(*) FROM jobs WHERE customer_id=customers.id AND created_at>=NOW()-INTERVAL '7 days') as week_jobs
      FROM customers ORDER BY created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Providers ─────────────────────────────────────────────────────────────────
router.get('/providers', requireAdminOrManager('providers'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, company_name, owner_name, phone, email, city, state, dot_number,
             is_active, is_online, rating, total_jobs, created_at,
        (SELECT COUNT(*) FROM jobs WHERE provider_id=providers.id) as job_count
      FROM providers ORDER BY created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/providers/:id/activate', requireAdminOrManager('providers'), async (req, res) => {
  try { await db.query(`UPDATE providers SET is_active=true WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/providers/:id/deactivate', requireAdminOrManager('providers'), async (req, res) => {
  try { await db.query(`UPDATE providers SET is_active=false WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Jobs ──────────────────────────────────────────────────────────────────────
router.get('/jobs', requireAdminOrManager('orders'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT j.id, j.status, j.mode, j.location_text, j.created_at, j.agreed_price,
             j.completed_at, j.cancelled_at,
             c.phone as customer_phone, p.company_name as provider_name,
             pay.amount_total as amount
      FROM jobs j
      LEFT JOIN customers c ON c.id=j.customer_id
      LEFT JOIN providers p ON p.id=j.provider_id
      LEFT JOIN payments pay ON pay.job_id=j.id
      ORDER BY j.created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Payments ──────────────────────────────────────────────────────────────────
router.get('/payments', requireAdminOrManager('payments'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.amount_total, p.platform_fee, p.provider_amount,
             p.status, p.created_at, p.released_at,
             c.phone as customer_phone, pr.company_name as provider_name
      FROM payments p
      LEFT JOIN customers c ON c.id=p.customer_id
      LEFT JOIN providers pr ON pr.id=p.provider_id
      ORDER BY p.created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Affiliates ────────────────────────────────────────────────────────────────
router.get('/affiliates', requireAdminOrManager('affiliates'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT ar.id, ar.referrer_type, ar.referrer_id, ar.referred_type,
             ar.code, ar.flat_bonus, ar.revenue_pct, ar.flat_paid, ar.status, ar.created_at,
             CASE ar.referrer_type
               WHEN 'customer' THEN (SELECT phone FROM customers WHERE id=ar.referrer_id)
               WHEN 'provider' THEN (SELECT company_name FROM providers WHERE id=ar.referrer_id)
             END as referrer_name
      FROM affiliate_referrals ar ORDER BY ar.created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
