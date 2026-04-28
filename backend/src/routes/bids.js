const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireProvider } = require('../middleware/auth');
const { getIO } = require('../socket');

// ── Provider: submit bid on bargain job ───────────────────────────────────────
router.post('/:jobId', requireProvider, async (req, res) => {
  const { price, etaMinutes, strategy } = req.body;
  if (!price || !etaMinutes) return res.status(400).json({ error: 'price and etaMinutes required' });
  if (price < 1 || price > 9999) return res.status(400).json({ error: 'Invalid price' });
  if (etaMinutes < 1 || etaMinutes > 180) return res.status(400).json({ error: 'Invalid ETA' });

  try {
    const jobRes = await db.query(`SELECT * FROM jobs WHERE id=$1`, [req.params.jobId]);
    const job = jobRes.rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.mode !== 'bargain') return res.status(400).json({ error: 'Job is not in bargain mode' });
    if (job.status !== 'bidding') return res.status(409).json({ error: 'Bidding window closed' });

    const { rows } = await db.query(
      `INSERT INTO bids (job_id, provider_id, price, eta_minutes, strategy)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (job_id, provider_id)
       DO UPDATE SET price=$3, eta_minutes=$4, strategy=$5, submitted_at=NOW()
       RETURNING *`,
      [req.params.jobId, req.user.id, price, etaMinutes, strategy || 'price']
    );
    const bid = rows[0];

    // Notify customer of new bid
    const io = getIO();
    io.to(`customer:${job.customer_id}`).emit('new_bid', {
      jobId: job.id,
      bidId: bid.id,
      price,
      etaMinutes,
      strategy: bid.strategy,
      // Provider name revealed only after bid is accepted
      providerRating: await getProviderRating(req.user.id),
    });

    res.status(201).json({ bid });
  } catch (err) {
    console.error('Submit bid error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Provider: cancel own bid ──────────────────────────────────────────────────
router.delete('/:jobId', requireProvider, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE bids SET status='cancelled'
       WHERE job_id=$1 AND provider_id=$2 AND status='pending'`,
      [req.params.jobId, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Bid not found or already resolved' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Customer: get bids for a job ──────────────────────────────────────────────
router.get('/:jobId', requireAuth, async (req, res) => {
  try {
    const jobRes = await db.query(`SELECT customer_id FROM jobs WHERE id=$1`, [req.params.jobId]);
    if (!jobRes.rows[0]) return res.status(404).json({ error: 'Job not found' });
    if (req.user.role === 'customer' && jobRes.rows[0].customer_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { rows } = await db.query(
      `SELECT b.id, b.price, b.eta_minutes, b.strategy, b.status, b.submitted_at,
              p.rating, p.total_jobs, p.truck_type, p.city
       FROM bids b
       JOIN providers p ON b.provider_id = p.id
       WHERE b.job_id = $1 AND b.status = 'pending'
       ORDER BY b.submitted_at ASC`,
      [req.params.jobId]
    );
    res.json({ bids: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function getProviderRating(providerId) {
  const { rows } = await db.query(`SELECT rating, total_jobs FROM providers WHERE id=$1`, [providerId]);
  return rows[0] ? { rating: rows[0].rating, jobs: rows[0].total_jobs } : null;
}

module.exports = router;
