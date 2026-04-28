const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireProvider } = require('../middleware/auth');
const { constructWebhookEvent, refundPayment, cancelPayment } = require('../services/stripe');

// ── Stripe webhook — handle payment events ────────────────────────────────────
// Must use express.raw() — registered in index.js before json middleware
router.post('/webhook', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': {
        // Customer authorized payment — ready to capture on job complete
        const pi = event.data.object;
        await db.query(
          `UPDATE payments SET status='held' WHERE stripe_payment_intent=$1`,
          [pi.id]
        );
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        await db.query(
          `UPDATE payments SET status='captured', captured_at=NOW() WHERE stripe_payment_intent=$1`,
          [pi.id]
        );
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await db.query(
          `UPDATE jobs SET status='cancelled', cancel_reason='payment_failed'
           WHERE payment_intent_id=$1`,
          [pi.id]
        );
        break;
      }
      case 'transfer.created': {
        const transfer = event.data.object;
        await db.query(
          `UPDATE payments SET stripe_transfer_id=$1, status='released' WHERE stripe_payment_intent=$2`,
          [transfer.id, transfer.source_transaction]
        );
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

// ── Provider: request payout of job earnings ──────────────────────────────────
router.post('/payout/request', requireProvider, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS pending
       FROM payouts WHERE provider_id=$1 AND type='earnings' AND status='pending'`,
      [req.user.id]
    );
    const amount = Number(rows[0].pending);
    if (amount < 20) {
      return res.status(400).json({ error: `Minimum payout $20, current: $${amount.toFixed(2)}` });
    }

    await db.query(
      `UPDATE payouts SET status='processing'
       WHERE provider_id=$1 AND type='earnings' AND status='pending'`,
      [req.user.id]
    );
    res.json({ ok: true, amount });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Customer: dispute a completed job ─────────────────────────────────────────
router.post('/dispute/:jobId', requireAuth, async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Customers only' });
  const { reason } = req.body;

  try {
    const { rows } = await db.query(`SELECT * FROM jobs WHERE id=$1`, [req.params.jobId]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const hoursElapsed = (Date.now() - new Date(job.completed_at).getTime()) / 3600000;
    if (hoursElapsed > 48) return res.status(409).json({ error: 'Dispute window expired (48h)' });

    await db.query(
      `UPDATE jobs SET status='disputed' WHERE id=$1`,
      [job.id]
    );
    await db.query(
      `UPDATE payments SET status='disputed' WHERE job_id=$1`,
      [job.id]
    );

    // In production: trigger admin review, hold provider payout, send notifications
    console.log(`Dispute filed for job ${job.id} by customer ${req.user.id}: ${reason}`);

    res.json({ ok: true, message: 'Dispute filed. Our team will review within 24 hours.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin: approve dispute refund ─────────────────────────────────────────────
router.post('/dispute/:jobId/refund', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });

  try {
    const { rows } = await db.query(`SELECT * FROM jobs WHERE id=$1`, [req.params.jobId]);
    const job = rows[0];
    if (!job || job.status !== 'disputed') return res.status(404).json({ error: 'Disputed job not found' });

    await refundPayment(job.payment_intent_id);
    await db.query(`UPDATE jobs SET status='cancelled' WHERE id=$1`, [job.id]);
    await db.query(`UPDATE payments SET status='refunded' WHERE job_id=$1`, [job.id]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
