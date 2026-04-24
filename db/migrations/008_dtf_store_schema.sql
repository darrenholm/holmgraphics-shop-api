-- 008_dtf_store_schema.sql
-- DTF online store: extend `clients` for online buyers + add order/cart/proof
-- tables and DTF pricing config tables.
--
-- Per docs/dtf-online-store-plan.md (revision 2): online customers are NOT
-- a separate table. The existing `clients` table is the unified record for
-- both staff-created customers (in-shop, phone-in) and self-service online
-- buyers. New columns add the auth + activation surface; existing client
-- rows just have NULL password_hash and account_status='unactivated' until
-- they claim their account via an emailed activation link.
--
-- Online orders link to `projects(id)` via orders.job_id — they appear in
-- the existing job board with no special handling. Source = 'online' just
-- displays an "Online order" badge on the job page.
--
-- Safe to re-run.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. EXTEND clients
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS phone                  TEXT,
  ADD COLUMN IF NOT EXISTS password_hash          TEXT,
  ADD COLUMN IF NOT EXISTS account_status         TEXT NOT NULL DEFAULT 'unactivated'
                          CHECK (account_status IN ('unactivated', 'active', 'suspended')),
  ADD COLUMN IF NOT EXISTS activation_token       TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS activation_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_reset_token   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pricing_tier_id        INT,         -- NULL = standard pricing
  ADD COLUMN IF NOT EXISTS email_verified_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Case-insensitive unique index on email — required for registration
-- "already exists" lookups and for QBO existing-customer matching.
-- Existing rows with NULL or duplicate emails are tolerated; the partial
-- predicate skips NULLs entirely.
CREATE UNIQUE INDEX IF NOT EXISTS clients_email_lower_unique
  ON clients (LOWER(email))
  WHERE email IS NOT NULL AND email <> '';

-- Auto-bump updated_at on any UPDATE to clients.
CREATE OR REPLACE FUNCTION clients_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_updated_at_trigger ON clients;
CREATE TRIGGER clients_updated_at_trigger
  BEFORE UPDATE ON clients
  FOR EACH ROW
  EXECUTE FUNCTION clients_set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. SAVED ADDRESSES + PAYMENT METHODS
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS client_addresses (
  id            SERIAL PRIMARY KEY,
  client_id     INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label         TEXT,                          -- 'Home', 'Office', etc.
  name          TEXT NOT NULL,
  addr1         TEXT NOT NULL,
  addr2         TEXT,
  city          TEXT NOT NULL,
  province      CHAR(2) NOT NULL,
  postal_code   TEXT NOT NULL,
  country       CHAR(2) NOT NULL DEFAULT 'CA',
  phone         TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_addresses_client_idx
  ON client_addresses (client_id);

-- Saved QB Payments tokenized cards. Raw card numbers never touch our DB —
-- we only store the QB-issued token + display metadata.
CREATE TABLE IF NOT EXISTS client_payment_methods (
  id              SERIAL PRIMARY KEY,
  client_id       INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  qb_card_token   TEXT NOT NULL,
  card_brand      TEXT,                        -- Visa, Mastercard, etc.
  card_last4      CHAR(4),
  card_exp_month  INT CHECK (card_exp_month BETWEEN 1 AND 12),
  card_exp_year   INT CHECK (card_exp_year BETWEEN 2024 AND 2099),
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_payment_methods_client_idx
  ON client_payment_methods (client_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. DTF PRICING CONFIG (admin-editable)
-- ═════════════════════════════════════════════════════════════════════════════

-- Garment categorization on existing supplier products so we know which
-- print-location list to show. Default 'apparel' covers most SanMar items.
ALTER TABLE supplier_product
  ADD COLUMN IF NOT EXISTS garment_category TEXT NOT NULL DEFAULT 'apparel'
                          CHECK (garment_category IN ('apparel', 'headwear', 'aprons', 'bags'));

-- Per-product weight in grams, used to estimate shipping package weight.
-- Backfilled from SanMar PromoStandards data where available; defaults
-- applied by category in a follow-up data load script.
ALTER TABLE supplier_product
  ADD COLUMN IF NOT EXISTS weight_grams INT;

-- Print locations: Left chest, Full back, Hat front, etc. Filtered by
-- garment_category in the cart UI. NULL location_id on a decoration row
-- means "custom location".
CREATE TABLE IF NOT EXISTS print_locations (
  id                SERIAL PRIMARY KEY,
  garment_category  TEXT NOT NULL CHECK (garment_category IN ('apparel', 'headwear', 'aprons', 'bags')),
  name              TEXT NOT NULL,
  max_width_in      NUMERIC(5,2) NOT NULL,
  max_height_in     NUMERIC(5,2) NOT NULL,
  display_order     INT NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS print_locations_category_idx
  ON print_locations (garment_category, display_order)
  WHERE active = TRUE;

-- Quantity-tiered prices for each print location. Per-design quantity
-- (aggregated across all line items using the same design) drives the
-- tier selection. max_quantity NULL = unlimited (top tier).
CREATE TABLE IF NOT EXISTS print_location_prices (
  id                 SERIAL PRIMARY KEY,
  print_location_id  INT NOT NULL REFERENCES print_locations(id) ON DELETE CASCADE,
  min_quantity       INT NOT NULL CHECK (min_quantity >= 1),
  max_quantity       INT CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
  price_per_piece    NUMERIC(8,2) NOT NULL CHECK (price_per_piece >= 0)
);

CREATE INDEX IF NOT EXISTS print_location_prices_loc_idx
  ON print_location_prices (print_location_id, min_quantity);

-- Custom-order pricing: per-square-inch with quantity tiers and a per-
-- design setup fee. Applied when the customer picks "Other (custom)" and
-- enters width/height. min_per_piece is a floor so tiny designs don't
-- come out absurdly cheap.
CREATE TABLE IF NOT EXISTS dtf_custom_tiers (
  id                    SERIAL PRIMARY KEY,
  min_quantity          INT NOT NULL CHECK (min_quantity >= 1),
  max_quantity          INT CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
  price_per_sqin        NUMERIC(8,4) NOT NULL CHECK (price_per_sqin >= 0),
  min_per_piece         NUMERIC(8,2) NOT NULL DEFAULT 0,
  setup_fee_per_design  NUMERIC(8,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS dtf_custom_tiers_qty_idx
  ON dtf_custom_tiers (min_quantity);

-- HST/GST rates by Canadian province. Effective_from supports rate
-- changes over time without losing history.
CREATE TABLE IF NOT EXISTS tax_rates (
  province_code   CHAR(2) PRIMARY KEY,
  rate            NUMERIC(6,5) NOT NULL CHECK (rate >= 0 AND rate <= 1),
  rate_label      TEXT NOT NULL,                 -- 'HST', 'GST', 'GST+QST'
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. ORDERS
-- ═════════════════════════════════════════════════════════════════════════════

-- An order is the customer-facing record of an online purchase. It links to
-- a row in `projects` (job_id) so it appears in the existing staff job
-- board with no special handling. The `source` column lets the job page
-- show an "Online order" badge.
--
-- order_number mirrors the job number for human readability — both are
-- the same string. We keep both columns so future channel-specific
-- numbering (e.g. "ONL-2026-0001") is possible without renaming jobs.
CREATE TABLE IF NOT EXISTS orders (
  id                  SERIAL PRIMARY KEY,
  order_number        TEXT NOT NULL UNIQUE,
  job_id              INT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  client_id           INT NOT NULL REFERENCES clients(id),
  source              TEXT NOT NULL DEFAULT 'online'
                      CHECK (source IN ('online', 'quote_request')),
  status              TEXT NOT NULL DEFAULT 'awaiting_artwork'
                      CHECK (status IN (
                        'awaiting_artwork',  -- order created, customer still uploading designs
                        'awaiting_proof',    -- artwork in, staff to generate proof
                        'awaiting_approval', -- proof sent, customer to approve
                        'in_production',     -- approved, being printed
                        'ready_to_ship',     -- decorated, label not yet generated
                        'ready_for_pickup',  -- pickup orders only
                        'shipped',
                        'delivered',
                        'picked_up',
                        'complete',
                        'cancelled',
                        'refunded'
                      )),

  -- pricing snapshot (what the customer was charged)
  items_subtotal      NUMERIC(10,2) NOT NULL,
  shipping_total      NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_total           NUMERIC(10,2) NOT NULL,
  grand_total         NUMERIC(10,2) NOT NULL,

  -- shipping vs pickup
  fulfillment_method  TEXT NOT NULL DEFAULT 'ship'
                      CHECK (fulfillment_method IN ('ship', 'pickup')),

  ship_to_name        TEXT,                   -- NULL for pickup
  ship_to_addr1       TEXT,
  ship_to_addr2       TEXT,
  ship_to_city        TEXT,
  ship_to_province    CHAR(2),
  ship_to_postal      TEXT,
  ship_to_country     CHAR(2) DEFAULT 'CA',
  ship_to_phone       TEXT,

  shipping_carrier    TEXT,                   -- 'canadapost', 'purolator', etc. NULL for pickup
  shipping_service    TEXT,                   -- 'expedited', 'ground', etc.
  shipping_quote_id   TEXT,                   -- ShipTime QuoteId from /rates response
  shiptime_ship_id    INT,                    -- ShipTime shipId after /shipments call
  tracking_number     TEXT,
  label_url           TEXT,                   -- ShipTime label PDF URL

  -- QBO links
  qbo_invoice_id      TEXT,                   -- QBO Invoice/SalesReceipt id
  qb_payment_id       TEXT,                   -- QB Payments charge id
  qb_refund_id        TEXT,                   -- QB Payments refund id (if refunded)

  notes               TEXT,                   -- internal
  customer_notes      TEXT,                   -- entered by customer at checkout

  -- timestamps for state machine transitions (NULL until that state is reached)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at             TIMESTAMPTZ,
  proof_sent_at       TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  ready_at            TIMESTAMPTZ,            -- ready_to_ship OR ready_for_pickup
  shipped_at          TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  picked_up_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_status_idx       ON orders (status);
CREATE INDEX IF NOT EXISTS orders_client_idx       ON orders (client_id);
CREATE INDEX IF NOT EXISTS orders_job_idx          ON orders (job_id);
CREATE INDEX IF NOT EXISTS orders_created_idx      ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_source_idx       ON orders (source);
CREATE INDEX IF NOT EXISTS orders_fulfillment_idx  ON orders (fulfillment_method);

CREATE OR REPLACE FUNCTION orders_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at_trigger ON orders;
CREATE TRIGGER orders_updated_at_trigger
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION orders_set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. ORDER LINE ITEMS + DESIGNS + DECORATIONS
-- ═════════════════════════════════════════════════════════════════════════════

-- One row per (product variant, size) per order. Quantity is per-size.
-- Garment cost only — decoration cost lives on order_decorations.
CREATE TABLE IF NOT EXISTS order_items (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  supplier        TEXT NOT NULL,            -- e.g. 'sanmar_ca'
  style           TEXT NOT NULL,            -- e.g. 'PC54'
  variant_id      TEXT NOT NULL,            -- supplier variant id
  product_name    TEXT NOT NULL,            -- snapshot for invoice display
  color_name      TEXT NOT NULL,
  color_hex       TEXT,
  size            TEXT NOT NULL,
  quantity        INT NOT NULL CHECK (quantity > 0),
  unit_price      NUMERIC(8,2) NOT NULL,    -- garment retail per piece (after markup)
  line_subtotal   NUMERIC(10,2) NOT NULL    -- quantity × unit_price
);

CREATE INDEX IF NOT EXISTS order_items_order_idx
  ON order_items (order_id);

-- A "design" is a single uploaded artwork file. One design can be applied
-- to multiple line items (e.g. same logo on shirts AND hoodies in one
-- order). Quantity tiers aggregate across all decorations using the same
-- design.
CREATE TABLE IF NOT EXISTS designs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,        -- customer-supplied: "Logo A"
  artwork_path        TEXT NOT NULL,        -- e.g. L:\ClientFilesL-Z\HuronBayCoop\Job9551\designs\<uuid>.png
  artwork_filename    TEXT NOT NULL,
  artwork_mime        TEXT,
  artwork_size_bytes  BIGINT,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS designs_order_idx
  ON designs (order_id);

-- A decoration is "this design at this location on this line item." Multiple
-- decorations per line item allow a customer to put a logo on the chest AND
-- a name on the back of the same shirt.
CREATE TABLE IF NOT EXISTS order_decorations (
  id                 SERIAL PRIMARY KEY,
  order_id           INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id      INT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  design_id          UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  print_location_id  INT REFERENCES print_locations(id),  -- NULL for custom
  custom_location    TEXT,                                -- free text, custom only
  width_in           NUMERIC(5,2),                        -- custom only
  height_in          NUMERIC(5,2),
  decoration_cost    NUMERIC(10,2) NOT NULL DEFAULT 0,
  setup_fee          NUMERIC(10,2) NOT NULL DEFAULT 0,
  CONSTRAINT order_decoration_loc_or_custom CHECK (
    (print_location_id IS NOT NULL) OR
    (print_location_id IS NULL AND custom_location IS NOT NULL
     AND width_in IS NOT NULL AND height_in IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS order_decorations_order_idx
  ON order_decorations (order_id);
CREATE INDEX IF NOT EXISTS order_decorations_item_idx
  ON order_decorations (order_item_id);
CREATE INDEX IF NOT EXISTS order_decorations_design_idx
  ON order_decorations (design_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. PROOFS
-- ═════════════════════════════════════════════════════════════════════════════

-- One proof per "round" — first proof is proof_number=1, revisions get 2, 3, etc.
-- approval_token is used in the customer-facing approval link.
CREATE TABLE IF NOT EXISTS proofs (
  id                     SERIAL PRIMARY KEY,
  order_id               INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  proof_number           INT NOT NULL,
  proof_image_path       TEXT NOT NULL,         -- local path under L:\...\Job<num>\proofs\
  proof_image_url        TEXT,                  -- optional public URL via files-bridge
  approval_token         TEXT NOT NULL UNIQUE,  -- url-safe random; used in email link
  created_by             TEXT NOT NULL,         -- staff email
  sent_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at            TIMESTAMPTZ,
  changes_requested_at   TIMESTAMPTZ,
  changes_request_text   TEXT,
  cancelled_at           TIMESTAMPTZ,
  UNIQUE (order_id, proof_number)
);

CREATE INDEX IF NOT EXISTS proofs_order_idx        ON proofs (order_id);
CREATE INDEX IF NOT EXISTS proofs_approval_token   ON proofs (approval_token);

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. WEBHOOK EVENTS
-- ═════════════════════════════════════════════════════════════════════════════

-- Audit log of incoming webhook events from QB Payments, ShipTime, etc.
-- processed_at NULL means it hasn't been handled yet. error captures the
-- last failure if processing failed.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL,            -- 'qb_payments', 'shiptime', 'qbo'
  event_type    TEXT NOT NULL,
  external_id   TEXT,                     -- provider's event id, for dedup
  raw_payload   JSONB NOT NULL,
  processed_at  TIMESTAMPTZ,
  error         TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_events_source_idx
  ON webhook_events (source, event_type, received_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_external_unique
  ON webhook_events (source, external_id)
  WHERE external_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. SEED: HST RATES
-- ═════════════════════════════════════════════════════════════════════════════

-- Canadian provincial sales tax (current as of 2026-04). Update via the
-- admin UI as rates change.
INSERT INTO tax_rates (province_code, rate, rate_label) VALUES
  ('ON', 0.13000, 'HST'),
  ('NB', 0.15000, 'HST'),
  ('NS', 0.15000, 'HST'),
  ('PE', 0.15000, 'HST'),
  ('NL', 0.15000, 'HST'),
  ('AB', 0.05000, 'GST'),
  ('BC', 0.05000, 'GST'),  -- + 7% PST not collected here (B2C threshold complexity)
  ('MB', 0.05000, 'GST'),
  ('SK', 0.05000, 'GST'),
  ('NT', 0.05000, 'GST'),
  ('NU', 0.05000, 'GST'),
  ('YT', 0.05000, 'GST'),
  ('QC', 0.05000, 'GST')   -- + 9.975% QST handled separately if registered
ON CONFLICT (province_code) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. SEED: DEFAULT PRINT LOCATIONS + PRICING
-- ═════════════════════════════════════════════════════════════════════════════

-- Initial set per docs/dtf-online-store-plan.md. Edit in /admin/pricing
-- without touching SQL. ON CONFLICT not needed here because there's no
-- natural unique key — we check for existing rows before inserting so the
-- migration is idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM print_locations LIMIT 1) THEN
    -- APPAREL
    INSERT INTO print_locations (garment_category, name, max_width_in, max_height_in, display_order) VALUES
      ('apparel',  'Left chest',     4.00,  4.00, 10),
      ('apparel',  'Right chest',    4.00,  4.00, 11),
      ('apparel',  'Full chest',    11.00, 11.00, 20),
      ('apparel',  'Full back',     12.00, 14.00, 30),
      ('apparel',  'Yoke / Upper back', 12.00, 3.00, 40),
      ('apparel',  'Left sleeve',    3.00,  4.00, 50),
      ('apparel',  'Right sleeve',   3.00,  4.00, 51),
      -- HEADWEAR
      ('headwear', 'Front',          4.00,  2.00, 10),
      ('headwear', 'Left side',      2.50,  2.00, 20),
      ('headwear', 'Right side',     2.50,  2.00, 21),
      ('headwear', 'Back',           4.00,  1.00, 30),
      -- APRONS
      ('aprons',   'Center chest',   8.00,  8.00, 10),
      ('aprons',   'Lower / pocket', 8.00,  4.00, 20),
      -- BAGS
      ('bags',     'Front',         10.00, 10.00, 10),
      ('bags',     'Back',          10.00, 10.00, 20);
  END IF;
END $$;

-- Default per-location quantity-tier pricing.
-- Tiers: 1-11 / 12-23 / 24-47 / 48-95 / 96+
DO $$
DECLARE
  loc RECORD;
  base NUMERIC(8,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM print_location_prices LIMIT 1) THEN
    FOR loc IN SELECT id, name, garment_category FROM print_locations LOOP
      -- pick a base price per location pattern
      base := CASE
        WHEN loc.name IN ('Left chest', 'Right chest')                 THEN 6.00
        WHEN loc.name IN ('Full chest', 'Full back')                   THEN 14.00
        WHEN loc.name = 'Yoke / Upper back'                            THEN 8.00
        WHEN loc.name IN ('Left sleeve', 'Right sleeve')               THEN 5.00
        WHEN loc.garment_category = 'headwear' AND loc.name = 'Front'  THEN 7.00
        WHEN loc.garment_category = 'headwear'                         THEN 5.00
        WHEN loc.garment_category = 'aprons' AND loc.name LIKE 'Center%' THEN 10.00
        WHEN loc.garment_category = 'aprons'                           THEN 8.00
        WHEN loc.garment_category = 'bags'                             THEN 10.00
        ELSE 8.00
      END;
      INSERT INTO print_location_prices (print_location_id, min_quantity, max_quantity, price_per_piece) VALUES
        (loc.id,  1,  11, base),
        (loc.id, 12,  23, ROUND(base * 0.85, 2)),
        (loc.id, 24,  47, ROUND(base * 0.70, 2)),
        (loc.id, 48,  95, ROUND(base * 0.60, 2)),
        (loc.id, 96, NULL, ROUND(base * 0.55, 2));
    END LOOP;
  END IF;
END $$;

-- Default custom (per-sq-in) pricing tiers + setup fee.
INSERT INTO dtf_custom_tiers (min_quantity, max_quantity, price_per_sqin, min_per_piece, setup_fee_per_design)
SELECT * FROM (VALUES
  ( 1,  11, 0.3000, 8.00, 15.00),
  (12,  23, 0.2500, 6.00, 15.00),
  (24,  47, 0.2000, 5.00, 15.00),
  (48,  95, 0.1700, 4.00,  0.00),  -- setup waived at 48+
  (96, NULL, 0.1400, 3.50, 0.00)
) AS v(min_quantity, max_quantity, price_per_sqin, min_per_piece, setup_fee_per_design)
WHERE NOT EXISTS (SELECT 1 FROM dtf_custom_tiers LIMIT 1);
