const router = require('express').Router();
const db = require('../db');
const { requireProvider } = require('../middleware/auth');
const { connectOnboardingLink, createConnectAccount } = require('../services/stripe');

// ── Get own profile ───────────────────────────────────────────────────────────
router.get('/me', requireProvider, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, company_name, owner_name, phone, email, city, state, zip,
              shop_address, dot_number, usdot_verified, insurance_carrier,
              insurance_policy, insurance_expiry, truck_year, truck_make,
              truck_model, truck_type, truck_capacity, truck_plate,
              hook_rate, per_mile_rate, after_hours_surcharge,
              coverage_radius_mi, coverage_zips, availability,
              is_online, rating, total_jobs, stripe_account_id
       FROM providers WHERE id=$1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Provider not found' });
    res.json({ provider: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Update profile ────────────────────────────────────────────────────────────
router.patch('/me', requireProvider, async (req, res) => {
  const allowed = [
    'company_name','owner_name','email','city','state','zip','shop_address',
    'dot_number','insurance_carrier','insurance_policy','insurance_expiry',
    'truck_year','truck_make','truck_model','truck_type','truck_capacity','truck_plate',
    'hook_rate','per_mile_rate','after_hours_surcharge',
    'coverage_radius_mi','coverage_zips','availability',
  ];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  const setClauses = updates.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const values = updates.map(([, v]) => v);
  values.push(req.user.id);

  try {
    const { rows } = await db.query(
      `UPDATE providers SET ${setClauses} WHERE id=$${values.length} RETURNING id`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Provider not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Toggle online/offline ─────────────────────────────────────────────────────
router.post('/me/availability', requireProvider, async (req, res) => {
  const { isOnline } = req.body;
  if (typeof isOnline !== 'boolean') return res.status(400).json({ error: 'isOnline boolean required' });
  try {
    await db.query(`UPDATE providers SET is_online=$1 WHERE id=$2`, [isOnline, req.user.id]);
    res.json({ ok: true, isOnline });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Earnings summary ──────────────────────────────────────────────────────────
router.get('/me/earnings', requireProvider, async (req, res) => {
  const { period = 'week' } = req.query;
  const intervalDays = { today: 1, week: 7, month: 30, all: 36500 };
  const days = intervalDays[period] ?? 7;

  try {
    const [summary, history] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='completed') AS jobs_done,
           COALESCE(SUM(provider_payout) FILTER (WHERE status='completed'), 0) AS net_earned,
           COALESCE(SUM(agreed_price) FILTER (WHERE status='completed'), 0) AS gross,
           COALESCE(SUM(platform_fee) FILTER (WHERE status='completed'), 0) AS platform_fees
         FROM jobs
         WHERE provider_id=$1 AND created_at > NOW() - ($2 * INTERVAL '1 day')`,
        [req.user.id, days]
      ),
      db.query(
        `SELECT id, service_type, location_text, agreed_price, provider_payout,
                platform_fee, mode, status, completed_at, customer_rating
         FROM jobs
         WHERE provider_id=$1 AND status='completed'
         ORDER BY completed_at DESC LIMIT 20`,
        [req.user.id]
      ),
    ]);

    const payoutsRes = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS pending_payouts
       FROM payouts WHERE provider_id=$1 AND status='pending'`,
      [req.user.id]
    );

    res.json({
      summary: { ...summary.rows[0], pending_payouts: payoutsRes.rows[0].pending_payouts },
      history: history.rows,
    });
  } catch (err) {
    console.error('Earnings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Stripe Connect onboarding ─────────────────────────────────────────────────
router.post('/me/stripe-connect', requireProvider, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT email, company_name, stripe_account_id FROM providers WHERE id=$1`, [req.user.id]
    );
    const provider = rows[0];
    let accountId = provider.stripe_account_id;

    if (!accountId) {
      const account = await createConnectAccount(provider.email, provider.company_name);
      accountId = account.id;
      await db.query(`UPDATE providers SET stripe_account_id=$1 WHERE id=$2`, [accountId, req.user.id]);
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5500';
    const link = await connectOnboardingLink(
      accountId,
      `${baseUrl}/provider.html?stripe=success`,
      `${baseUrl}/provider.html?stripe=refresh`
    );

    res.json({ url: link.url });
  } catch (err) {
    console.error('Stripe connect error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
