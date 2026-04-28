const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

function genCode(seed) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  let code = '';
  for (let j = 0; j < 8; j++) {
    code += chars[Math.abs((h >> (j * 4)) & 0xf) % chars.length];
  }
  return code;
}

// ── Get or create affiliate code for current user ─────────────────────────────
router.post('/code', requireAuth, async (req, res) => {
  const userType = req.user.role; // 'customer' | 'provider'
  const userId = req.user.id;

  try {
    let { rows } = await db.query(
      `SELECT * FROM affiliate_codes WHERE user_type=$1 AND user_id=$2`,
      [userType, userId]
    );

    if (!rows[0]) {
      const seed = `${userType}-${userId}`;
      let code = genCode(seed);

      // Ensure uniqueness (collision fallback)
      let attempt = 0;
      while (true) {
        const existing = await db.query(`SELECT id FROM affiliate_codes WHERE code=$1`, [code]);
        if (!existing.rows[0]) break;
        code = genCode(seed + attempt++);
      }

      const insert = await db.query(
        `INSERT INTO affiliate_codes (user_type, user_id, code) VALUES ($1,$2,$3) RETURNING *`,
        [userType, userId, code]
      );
      rows = insert.rows;
    }

    res.json({ code: rows[0].code, clicks: rows[0].clicks });
  } catch (err) {
    console.error('Affiliate code error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Track click on referral link ──────────────────────────────────────────────
router.post('/click/:code', async (req, res) => {
  try {
    await db.query(`UPDATE affiliate_codes SET clicks=clicks+1 WHERE code=$1`, [req.params.code]);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // non-fatal
  }
});

// ── Get affiliate stats for current user ──────────────────────────────────────
router.get('/stats', requireAuth, async (req, res) => {
  const userType = req.user.role;
  const userId = req.user.id;

  try {
    const [codeRes, referralRes, payoutRes] = await Promise.all([
      db.query(
        `SELECT code, clicks FROM affiliate_codes WHERE user_type=$1 AND user_id=$2`,
        [userType, userId]
      ),
      db.query(
        `SELECT
           COUNT(*) AS total_referrals,
           COUNT(*) FILTER (WHERE status='active') AS active_referrals,
           COALESCE(SUM(flat_bonus) FILTER (WHERE flat_paid=true), 0) AS flat_earned,
           COALESCE(SUM(total_revenue_earned), 0) AS revenue_earned
         FROM affiliate_referrals
         WHERE referrer_type=$1 AND referrer_id=$2`,
        [userType, userId]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount),0) AS pending
         FROM payouts
         WHERE provider_id=$1 AND type='affiliate' AND status='pending'`,
        [userId]
      ),
    ]);

    const code = codeRes.rows[0];
    const stats = referralRes.rows[0];
    const pending = payoutRes.rows[0]?.pending || 0;

    res.json({
      code: code?.code,
      clicks: code?.clicks || 0,
      totalReferrals: Number(stats.total_referrals),
      activeReferrals: Number(stats.active_referrals),
      flatEarned: Number(stats.flat_earned),
      revenueEarned: Number(stats.revenue_earned),
      totalEarned: Number(stats.flat_earned) + Number(stats.revenue_earned),
      pending: Number(pending),
    });
  } catch (err) {
    console.error('Affiliate stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get referral history ──────────────────────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ar.id, ar.referred_type, ar.status, ar.flat_bonus, ar.flat_paid,
              ar.revenue_pct, ar.total_revenue_earned, ar.created_at, ar.revenue_window_end,
              CASE WHEN ar.referred_type='customer'
                   THEN (SELECT phone FROM customers WHERE id=ar.referred_id)
                   ELSE (SELECT company_name FROM providers WHERE id=ar.referred_id)
              END AS referred_name
       FROM affiliate_referrals ar
       WHERE ar.referrer_type=$1 AND ar.referrer_id=$2
       ORDER BY ar.created_at DESC LIMIT 50`,
      [req.user.role, req.user.id]
    );
    res.json({ referrals: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Request payout of affiliate earnings ──────────────────────────────────────
router.post('/payout', requireAuth, async (req, res) => {
  if (req.user.role !== 'provider') {
    return res.status(400).json({ error: 'Affiliate payouts only for providers (customers get credits)' });
  }
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM payouts WHERE provider_id=$1 AND type='affiliate' AND status='pending'`,
      [req.user.id]
    );
    const total = Number(rows[0].total);
    if (total < 50) return res.status(400).json({ error: `Minimum payout $50, current balance: $${total.toFixed(2)}` });

    await db.query(
      `UPDATE payouts SET status='processing'
       WHERE provider_id=$1 AND type='affiliate' AND status='pending'`,
      [req.user.id]
    );
    res.json({ ok: true, amount: total });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
