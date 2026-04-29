const router = require('express').Router();
const db = require('../db');

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// ── Stats overview ────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [customers, providers, jobs, revenue, pendingProviders] = await Promise.all([
      db.query('SELECT COUNT(*) FROM customers'),
      db.query('SELECT COUNT(*) FROM providers'),
      db.query('SELECT COUNT(*), status FROM jobs GROUP BY status'),
      db.query(`SELECT COALESCE(SUM(amount_total),0) as total FROM payments WHERE status='released'`),
      db.query(`SELECT COUNT(*) FROM providers WHERE is_active = false OR is_active IS NULL`),
    ]);

    const jobStats = {};
    jobs.rows.forEach(r => { jobStats[r.status] = parseInt(r.count); });

    res.json({
      customers: parseInt(customers.rows[0].count),
      providers: parseInt(providers.rows[0].count),
      jobs: jobStats,
      revenue: parseFloat(revenue.rows[0].total),
      pendingProviders: parseInt(pendingProviders.rows[0].count),
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Customers ─────────────────────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, phone, name, created_at,
        (SELECT COUNT(*) FROM jobs WHERE customer_id = customers.id) as job_count
       FROM customers ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Providers ─────────────────────────────────────────────────────────────────
router.get('/providers', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, company_name, owner_name, phone, email, city, state,
              is_active, is_online, created_at,
        (SELECT COUNT(*) FROM jobs WHERE provider_id = providers.id) as job_count
       FROM providers ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/providers/:id/activate', async (req, res) => {
  try {
    await db.query(`UPDATE providers SET is_active = true WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/providers/:id/deactivate', async (req, res) => {
  try {
    await db.query(`UPDATE providers SET is_active = false WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Jobs / Orders ─────────────────────────────────────────────────────────────
router.get('/jobs', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT j.id, j.status, j.mode, j.location_text, j.created_at,
              c.phone as customer_phone,
              p.company_name as provider_name,
              pay.amount_total as amount
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN providers p ON p.id = j.provider_id
       LEFT JOIN payments pay ON pay.job_id = j.id
       ORDER BY j.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Affiliates ────────────────────────────────────────────────────────────────
router.get('/affiliates', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ar.id, ar.referrer_type, ar.referrer_id, ar.referred_type,
              ar.code, ar.flat_bonus, ar.revenue_pct, ar.paid_at, ar.created_at,
              CASE ar.referrer_type
                WHEN 'customer' THEN (SELECT phone FROM customers WHERE id = ar.referrer_id)
                WHEN 'provider' THEN (SELECT company_name FROM providers WHERE id = ar.referrer_id)
              END as referrer_name
       FROM affiliate_referrals ar
       ORDER BY ar.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
