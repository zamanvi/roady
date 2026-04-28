-- Roady Platform — PostgreSQL Schema
-- Run: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Customers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         VARCHAR(20) UNIQUE NOT NULL,
  name          VARCHAR(120),
  email         VARCHAR(255),
  referred_by   UUID REFERENCES customers(id) ON DELETE SET NULL,
  stripe_customer_id  VARCHAR(60),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Providers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name      VARCHAR(200) NOT NULL,
  owner_name        VARCHAR(120) NOT NULL,
  phone             VARCHAR(20)  UNIQUE NOT NULL,
  email             VARCHAR(255) UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  city              VARCHAR(100) NOT NULL,
  state             CHAR(2)      NOT NULL,
  zip               CHAR(5)      NOT NULL,
  shop_address      TEXT         NOT NULL,
  dot_number        VARCHAR(60)  NOT NULL,
  usdot_verified    BOOLEAN DEFAULT FALSE,
  insurance_carrier VARCHAR(200),
  insurance_policy  VARCHAR(100),
  insurance_expiry  DATE,
  -- Truck info
  truck_year        SMALLINT,
  truck_make        VARCHAR(60),
  truck_model       VARCHAR(60),
  truck_type        VARCHAR(60),  -- flatbed, wheel-lift, etc.
  truck_capacity    VARCHAR(40),
  truck_plate       VARCHAR(20),
  -- Rates
  hook_rate         NUMERIC(8,2),
  per_mile_rate     NUMERIC(8,2),
  after_hours_surcharge NUMERIC(8,2),
  -- Coverage
  coverage_radius_mi SMALLINT DEFAULT 25,
  coverage_zips     TEXT[],       -- additional ZIP codes served
  -- Availability (bitmask per day: 0=off, 1=on)
  availability      JSONB DEFAULT '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":false,"sun":false}',
  -- Platform
  is_online         BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  rating            NUMERIC(3,2) DEFAULT 0,
  total_jobs        INT DEFAULT 0,
  stripe_account_id VARCHAR(60),   -- Stripe Connect for payouts
  referred_by       UUID REFERENCES providers(id) ON DELETE SET NULL,
  terms_agreed_at   TIMESTAMPTZ,   -- clickwrap timestamp
  terms_version     VARCHAR(10) DEFAULT '1.0',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Jobs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     UUID NOT NULL REFERENCES customers(id),
  provider_id     UUID REFERENCES providers(id),
  mode            VARCHAR(10) NOT NULL CHECK (mode IN ('urgent','bargain')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','bidding','assigned','en_route','arrived','in_progress','completed','cancelled','disputed')),
  service_type    VARCHAR(80),      -- flat_tire, tow, jump_start, lockout, etc.
  location_text   TEXT,
  location_lat    NUMERIC(10,7),
  location_lng    NUMERIC(10,7),
  destination_text TEXT,
  media_url       TEXT,
  agreed_price    NUMERIC(8,2),
  platform_fee    NUMERIC(8,2),
  provider_payout NUMERIC(8,2),
  eta_minutes     SMALLINT,
  -- Twilio proxy session for masked communication
  twilio_session_sid VARCHAR(60),
  customer_proxy_number VARCHAR(20),
  provider_proxy_number VARCHAR(20),
  -- Timing
  dispatched_at   TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  arrived_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  -- Stripe
  payment_intent_id    VARCHAR(60),
  payment_captured     BOOLEAN DEFAULT FALSE,
  -- Review
  customer_rating      SMALLINT CHECK (customer_rating BETWEEN 1 AND 5),
  customer_review      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Bids (Bargain mode) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bids (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES providers(id),
  price       NUMERIC(8,2) NOT NULL,
  eta_minutes SMALLINT NOT NULL,
  strategy    VARCHAR(20),   -- price | rating | speed
  status      VARCHAR(20) DEFAULT 'pending'
                CHECK (status IN ('pending','won','lost','cancelled')),
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (job_id, provider_id)
);

-- ── Payments / Escrow ledger ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id              UUID NOT NULL REFERENCES jobs(id),
  customer_id         UUID NOT NULL REFERENCES customers(id),
  provider_id         UUID NOT NULL REFERENCES providers(id),
  amount_total        NUMERIC(8,2) NOT NULL,
  platform_fee        NUMERIC(8,2) NOT NULL,
  provider_amount     NUMERIC(8,2) NOT NULL,
  stripe_payment_intent VARCHAR(60) UNIQUE NOT NULL,
  stripe_transfer_id  VARCHAR(60),
  status              VARCHAR(20) DEFAULT 'held'
                        CHECK (status IN ('held','captured','released','refunded','disputed')),
  captured_at         TIMESTAMPTZ,
  released_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Provider payouts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payouts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  amount          NUMERIC(8,2) NOT NULL,
  type            VARCHAR(20) DEFAULT 'earnings'
                    CHECK (type IN ('earnings','affiliate','bonus')),
  stripe_payout_id VARCHAR(60),
  status          VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','paid','failed')),
  requested_at    TIMESTAMPTZ DEFAULT NOW(),
  paid_at         TIMESTAMPTZ
);

-- ── Affiliates ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_type   VARCHAR(10) NOT NULL CHECK (user_type IN ('customer','provider')),
  user_id     UUID NOT NULL,
  code        VARCHAR(20) UNIQUE NOT NULL,
  clicks      INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_type   VARCHAR(10) NOT NULL,
  referrer_id     UUID NOT NULL,
  referred_type   VARCHAR(10) NOT NULL,
  referred_id     UUID NOT NULL,
  code            VARCHAR(20) NOT NULL,
  flat_bonus      NUMERIC(8,2),
  flat_paid       BOOLEAN DEFAULT FALSE,
  revenue_pct     NUMERIC(5,4) DEFAULT 0,   -- e.g. 0.01 = 1%
  revenue_window_days SMALLINT DEFAULT 90,
  revenue_window_end  TIMESTAMPTZ,
  total_revenue_earned NUMERIC(10,2) DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending','active','paid','expired')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── OTP / SMS Verification ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_verifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       VARCHAR(20) NOT NULL,
  twilio_sid  VARCHAR(60),
  verified    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '10 minutes'
);

-- ── Indices ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_customer    ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_provider    ON jobs(provider_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_bids_job         ON bids(job_id);
CREATE INDEX IF NOT EXISTS idx_bids_provider    ON bids(provider_id);
CREATE INDEX IF NOT EXISTS idx_payments_job     ON payments(job_id);
CREATE INDEX IF NOT EXISTS idx_payouts_provider ON payouts(provider_id);
CREATE INDEX IF NOT EXISTS idx_aff_code         ON affiliate_codes(code);
CREATE INDEX IF NOT EXISTS idx_providers_online ON providers(is_online) WHERE is_online = TRUE;
CREATE INDEX IF NOT EXISTS idx_providers_state  ON providers(state);

-- ── Updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['customers','providers','jobs'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %s', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
