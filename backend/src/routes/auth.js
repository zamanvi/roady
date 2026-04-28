const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sendOTP, checkOTP } = require('../services/twilio');

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
}

// ── Customer: send OTP ────────────────────────────────────────────────────────
router.post('/customer/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  try {
    await sendOTP(phone);
    res.json({ ok: true });
  } catch (err) {
    console.error('OTP send error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// ── Customer: verify OTP + create/login account ───────────────────────────────
router.post('/customer/verify-otp', async (req, res) => {
  const { phone, code, refCode } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  try {
    const approved = await checkOTP(phone, code);
    if (!approved) return res.status(401).json({ error: 'Invalid or expired code' });

    // Upsert customer
    let { rows } = await db.query(
      `INSERT INTO customers (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING *`,
      [phone]
    );
    let customer = rows[0];

    // Track referral if first-time and ref code provided
    if (refCode && !customer.referred_by) {
      const refRow = await db.query(
        `SELECT user_id FROM affiliate_codes WHERE code = $1 AND user_type = 'customer'`,
        [refCode]
      );
      if (refRow.rows[0]) {
        const referrerId = refRow.rows[0].user_id;
        await db.query(
          `UPDATE customers SET referred_by = $1 WHERE id = $2`,
          [referrerId, customer.id]
        );
        await db.query(
          `INSERT INTO affiliate_referrals
             (referrer_type, referrer_id, referred_type, referred_id, code, flat_bonus)
           VALUES ('customer', $1, 'customer', $2, $3, 10)
           ON CONFLICT DO NOTHING`,
          [referrerId, customer.id, refCode]
        );
      }
    }

    const token = signToken({ id: customer.id, role: 'customer', phone });
    res.json({ token, customer: { id: customer.id, phone, name: customer.name } });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Provider: register ────────────────────────────────────────────────────────
router.post('/provider/register', async (req, res) => {
  const {
    companyName, ownerName, phone, email, password,
    city, state, zip, shopAddress, dotNumber, refCode,
    termsVersion,
  } = req.body;

  const missing = ['companyName','ownerName','phone','password','city','state','zip','shopAddress','dotNumber']
    .filter(k => !req.body[k]);
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'Invalid ZIP' });
  if (password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });

  try {
    const hash = await bcrypt.hash(password, 12);

    const { rows } = await db.query(
      `INSERT INTO providers
         (company_name, owner_name, phone, email, password_hash,
          city, state, zip, shop_address, dot_number,
          terms_agreed_at, terms_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(),$11)
       RETURNING id, company_name, owner_name, phone, email, state, city`,
      [companyName, ownerName, phone, email || null, hash,
       city, state.toUpperCase(), zip, shopAddress, dotNumber,
       termsVersion || '1.0']
    );
    const provider = rows[0];

    // Track provider referral
    if (refCode) {
      const refRow = await db.query(
        `SELECT user_id FROM affiliate_codes WHERE code = $1 AND user_type = 'provider'`,
        [refCode]
      );
      if (refRow.rows[0]) {
        const referrerId = refRow.rows[0].user_id;
        await db.query(
          `UPDATE providers SET referred_by = $1 WHERE id = $2`,
          [referrerId, provider.id]
        );
        await db.query(
          `INSERT INTO affiliate_referrals
             (referrer_type, referrer_id, referred_type, referred_id, code,
              flat_bonus, revenue_pct, revenue_window_days, revenue_window_end)
           VALUES ('provider', $1, 'provider', $2, $3, 50, 0.01, 90, NOW() + INTERVAL '90 days')`,
          [referrerId, provider.id, refCode]
        );
      }
    }

    const token = signToken({ id: provider.id, role: 'provider', company: companyName });
    res.status(201).json({ token, provider });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Phone or email already registered' });
    console.error('Provider register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Provider: login ───────────────────────────────────────────────────────────
router.post('/provider/login', async (req, res) => {
  const { identifier, password } = req.body; // phone or email
  if (!identifier || !password) return res.status(400).json({ error: 'Credentials required' });

  try {
    const { rows } = await db.query(
      `SELECT * FROM providers WHERE phone = $1 OR email = $1`,
      [identifier]
    );
    const provider = rows[0];
    if (!provider) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, provider.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ id: provider.id, role: 'provider', company: provider.company_name });
    res.json({
      token,
      provider: {
        id: provider.id,
        companyName: provider.company_name,
        ownerName: provider.owner_name,
        phone: provider.phone,
        email: provider.email,
        state: provider.state,
        city: provider.city,
        isOnline: provider.is_online,
      },
    });
  } catch (err) {
    console.error('Provider login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
