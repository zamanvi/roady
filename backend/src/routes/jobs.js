const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireProvider } = require('../middleware/auth');
const { createEscrow } = require('../services/stripe');
const { createProxySession } = require('../services/twilio');
const { getIO } = require('../socket');

// ── Customer: create job request ──────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Customers only' });

  const { mode, serviceType, locationText, locationLat, locationLng, mediaUrl } = req.body;
  if (!mode || !locationText) return res.status(400).json({ error: 'mode and locationText required' });
  if (!['urgent', 'bargain'].includes(mode)) return res.status(400).json({ error: 'mode must be urgent or bargain' });

  try {
    const { rows } = await db.query(
      `INSERT INTO jobs
         (customer_id, mode, service_type, location_text, location_lat, location_lng, media_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7, $8)
       RETURNING *`,
      [req.user.id, mode, serviceType, locationText,
       locationLat || null, locationLng || null, mediaUrl || null,
       mode === 'urgent' ? 'pending' : 'bidding']
    );
    const job = rows[0];

    // Broadcast new job to all online providers in same state (real: geo filter)
    const io = getIO();
    io.to('providers').emit('new_job', {
      id: job.id,
      mode: job.mode,
      serviceType: job.service_type,
      locationText: job.location_text,
      createdAt: job.created_at,
    });

    res.status(201).json({ job });
  } catch (err) {
    console.error('Create job error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Customer: get my jobs ─────────────────────────────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT j.*, p.company_name, p.rating as provider_rating
       FROM jobs j
       LEFT JOIN providers p ON j.provider_id = p.id
       WHERE j.customer_id = $1
       ORDER BY j.created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get single job ────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT j.*, p.company_name, p.owner_name, p.rating as provider_rating,
              p.truck_type, p.truck_plate
       FROM jobs j
       LEFT JOIN providers p ON j.provider_id = p.id
       WHERE j.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Job not found' });

    const job = rows[0];
    // Customers can only see their own; providers can see assigned jobs
    if (req.user.role === 'customer' && job.customer_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Customer: confirm provider / initiate escrow ──────────────────────────────
router.post('/:id/confirm', requireAuth, async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Customers only' });

  const { providerId, agreedPrice } = req.body;
  if (!providerId || !agreedPrice) return res.status(400).json({ error: 'providerId and agreedPrice required' });

  try {
    const jobRes = await db.query(`SELECT * FROM jobs WHERE id = $1`, [req.params.id]);
    const job = jobRes.rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (job.status !== 'bidding' && job.status !== 'pending') {
      return res.status(409).json({ error: 'Job already assigned' });
    }

    const providerRes = await db.query(
      `SELECT stripe_account_id FROM providers WHERE id = $1`, [providerId]
    );
    const provider = providerRes.rows[0];

    const platformFee = Number((agreedPrice * 0.10).toFixed(2));
    const providerPayout = Number((agreedPrice - platformFee).toFixed(2));

    // Create Stripe escrow hold
    const customerRes = await db.query(
      `SELECT stripe_customer_id FROM customers WHERE id = $1`, [req.user.id]
    );
    const escrow = await createEscrow(
      agreedPrice,
      customerRes.rows[0]?.stripe_customer_id,
      job.id,
      provider?.stripe_account_id
    );

    // Mark job assigned
    await db.query(
      `UPDATE jobs SET
         provider_id = $1, agreed_price = $2, platform_fee = $3, provider_payout = $4,
         payment_intent_id = $5, status = 'assigned', dispatched_at = NOW()
       WHERE id = $6`,
      [providerId, agreedPrice, platformFee, providerPayout, escrow.paymentIntentId, job.id]
    );

    await db.query(
      `INSERT INTO payments
         (job_id, customer_id, provider_id, amount_total, platform_fee, provider_amount, stripe_payment_intent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [job.id, req.user.id, providerId, agreedPrice, platformFee, providerPayout, escrow.paymentIntentId]
    );

    // Set up Twilio proxy session for masked calling
    const custRes = await db.query(`SELECT phone FROM customers WHERE id=$1`, [req.user.id]);
    const provPhRes = await db.query(`SELECT phone FROM providers WHERE id=$1`, [providerId]);
    try {
      const proxy = await createProxySession(job.id, custRes.rows[0].phone, provPhRes.rows[0].phone);
      await db.query(
        `UPDATE jobs SET twilio_session_sid=$1, customer_proxy_number=$2, provider_proxy_number=$3 WHERE id=$4`,
        [proxy.sessionSid, proxy.customerProxyNumber, proxy.providerProxyNumber, job.id]
      );
    } catch (proxyErr) {
      console.warn('Proxy session creation failed (non-fatal):', proxyErr.message);
    }

    // Notify provider via Socket.io
    const io = getIO();
    io.to(`provider:${providerId}`).emit('job_assigned', {
      jobId: job.id,
      location: job.location_text,
      serviceType: job.service_type,
      price: agreedPrice,
      clientSecret: escrow.clientSecret,
    });

    res.json({
      clientSecret: escrow.clientSecret,
      paymentIntentId: escrow.paymentIntentId,
      platformFee,
      providerPayout,
    });
  } catch (err) {
    console.error('Confirm job error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Customer: confirm service complete → release escrow ───────────────────────
router.post('/:id/complete', requireAuth, async (req, res) => {
  const { rating, review } = req.body;
  try {
    const { rows } = await db.query(`SELECT * FROM jobs WHERE id = $1`, [req.params.id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (job.status !== 'in_progress' && job.status !== 'arrived') {
      return res.status(409).json({ error: 'Job not in completable state' });
    }

    const { capturePayment } = require('../services/stripe');
    await capturePayment(job.payment_intent_id);

    await db.query(
      `UPDATE jobs SET status='completed', completed_at=NOW(),
         customer_rating=$1, customer_review=$2 WHERE id=$3`,
      [rating || null, review || null, job.id]
    );
    await db.query(
      `UPDATE payments SET status='released', released_at=NOW() WHERE job_id=$1`,
      [job.id]
    );

    // Update provider stats
    await db.query(
      `UPDATE providers SET total_jobs = total_jobs + 1,
         rating = ((rating * total_jobs) + $1) / (total_jobs + 1)
       WHERE id = $2`,
      [rating || job.agreed_price > 0 ? 5 : 3, job.provider_id]
    );

    // Pay affiliate revenue share if provider was referred
    await creditAffiliateRevenue(job.provider_id, job.provider_payout);

    const io = getIO();
    io.to(`provider:${job.provider_id}`).emit('job_completed', { jobId: job.id, payout: job.provider_payout });

    res.json({ ok: true });
  } catch (err) {
    console.error('Complete job error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Provider: update job status ───────────────────────────────────────────────
router.patch('/:id/status', requireProvider, async (req, res) => {
  const { status } = req.body;
  const allowed = ['en_route', 'arrived', 'in_progress', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const { rows } = await db.query(`SELECT * FROM jobs WHERE id=$1`, [req.params.id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (job.provider_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const tsCol = { en_route: null, arrived: 'arrived_at', in_progress: null, cancelled: 'cancelled_at' }[status];
    const extra = tsCol ? `, ${tsCol} = NOW()` : '';

    await db.query(`UPDATE jobs SET status=$1${extra} WHERE id=$2`, [status, job.id]);

    const io = getIO();
    io.to(`customer:${job.customer_id}`).emit('job_status', { jobId: job.id, status });

    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Provider: get assigned/active jobs ────────────────────────────────────────
router.get('/provider/active', requireProvider, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT j.*, c.phone as customer_proxy_phone
       FROM jobs j
       LEFT JOIN customers c ON j.customer_id = c.id
       WHERE j.provider_id = $1 AND j.status NOT IN ('completed','cancelled')
       ORDER BY j.created_at DESC`,
      [req.user.id]
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function creditAffiliateRevenue(providerId, jobRevenue) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM affiliate_referrals
       WHERE referred_type='provider' AND referred_id=$1
         AND status='active' AND revenue_window_end > NOW()`,
      [providerId]
    );
    for (const ref of rows) {
      const credit = Number((jobRevenue * ref.revenue_pct).toFixed(2));
      if (credit > 0) {
        await db.query(
          `UPDATE affiliate_referrals
           SET total_revenue_earned = total_revenue_earned + $1 WHERE id=$2`,
          [credit, ref.id]
        );
        await db.query(
          `INSERT INTO payouts (provider_id, amount, type) VALUES ($1,$2,'affiliate')`,
          [ref.referrer_id, credit]
        );
      }
    }
  } catch (err) {
    console.error('Affiliate revenue credit error:', err.message);
  }
}

module.exports = router;
