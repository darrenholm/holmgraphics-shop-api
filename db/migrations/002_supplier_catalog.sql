-- 002_supplier_catalog.sql
-- Multi-supplier apparel catalog schema.
--
-- Parent-SKU model: one `supplier_product` row per style (e.g. ATC1000),
-- and one `supplier_variant` row per size/colour combo (the `productId`
-- PromoStandards returns, e.g. 36016-2). Bulk Data 1.0 is the v1 source;
-- it returns flat quantity + price, so those live as columns on the
-- variant. When Inventory 2.0 and Pricing 1.0 come online in v2 we'll
-- promote per-warehouse stock and tiered pricing into their own tables.
--
-- Multi-supplier from day one: SanMar Canada is first, but S&S, AlphaBroder,
-- and others (awaiting credentials) plug in by inserting a new `supplier`
-- row and wiring a new adapter module. No schema changes needed.
--
-- brand_restriction enforces rules like "Nike / Eddie Bauer / TNF etc.
-- cannot be sold blank — embellishment required."
--
-- sync_run is the audit log: every ingest (nightly Bulk Data, or v2
-- realtime Inventory/Pricing pulls) writes a row so we can diagnose
-- stale data and replay failures.
--
-- Safe to re-run: all statements are IF NOT EXISTS / ON CONFLICT DO NOTHING.

------------------------------------------------------------------------
-- Suppliers (SanMar CA, S&S, AlphaBroder, ...)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier (
  id          SERIAL       PRIMARY KEY,
  code        TEXT         NOT NULL UNIQUE,
  name        TEXT         NOT NULL,
  api_kind    TEXT         NOT NULL DEFAULT 'promostandards'
                           CHECK (api_kind IN ('promostandards','bulk','custom')),
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

------------------------------------------------------------------------
-- Brand restrictions (blank-sale blocks, embellishment requirements)
-- Brand match is case-insensitive — store canonical casing, query via LOWER().
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_restriction (
  id                        SERIAL       PRIMARY KEY,
  brand                     TEXT         NOT NULL UNIQUE,
  requires_embellishment    BOOLEAN      NOT NULL DEFAULT TRUE,
  blocked_from_blank_sale   BOOLEAN      NOT NULL DEFAULT TRUE,
  notes                     TEXT,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brand_restriction_brand_lower_idx
  ON brand_restriction (LOWER(brand));

------------------------------------------------------------------------
-- Style-level product (one per SKU family, e.g. ATC1000)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_product (
  id                SERIAL       PRIMARY KEY,
  supplier_id       INTEGER      NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  style             TEXT         NOT NULL,           -- SanMar "style" (ATC1000)

  product_name      TEXT,
  fr_product_name   TEXT,
  description       TEXT,
  fr_description    TEXT,

  brand             TEXT,                            -- joined against brand_restriction
  discount_code     TEXT,                            -- SanMar discount flag
  price_group       TEXT,                            -- NR, DR, etc.
  youth             BOOLEAN      NOT NULL DEFAULT FALSE,
  case_size         INTEGER,

  is_sellable       BOOLEAN      NOT NULL DEFAULT TRUE,   -- master on/off
  is_discontinued   BOOLEAN      NOT NULL DEFAULT FALSE,  -- priceGroup=DR or name contains DISCONTINUED

  raw_json          JSONB,                           -- anything not normalised above

  first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_synced_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (supplier_id, style)
);

CREATE INDEX IF NOT EXISTS supplier_product_supplier_id_idx
  ON supplier_product (supplier_id);

CREATE INDEX IF NOT EXISTS supplier_product_brand_lower_idx
  ON supplier_product (LOWER(brand));

-- Simple case-insensitive name search for the catalog search endpoint.
-- (pg_trgm would be nicer for fuzzy; add later if needed.)
CREATE INDEX IF NOT EXISTS supplier_product_name_lower_idx
  ON supplier_product (LOWER(product_name));

-- Filter "only sellable" lists fast.
CREATE INDEX IF NOT EXISTS supplier_product_sellable_idx
  ON supplier_product (supplier_id, is_sellable)
  WHERE is_sellable = TRUE AND is_discontinued = FALSE;

------------------------------------------------------------------------
-- Variant-level SKU (one per size/colour combo, e.g. productId=36016-2)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_variant (
  id                    SERIAL       PRIMARY KEY,
  product_id            INTEGER      NOT NULL REFERENCES supplier_product(id) ON DELETE CASCADE,

  supplier_variant_id   TEXT         NOT NULL,       -- the `productId` from PromoStandards (36016-2)

  size                  TEXT,
  size_order            INTEGER,                     -- derived on ingest: XS=10, S=20, M=30, ...
  color_name            TEXT,
  fr_color_name         TEXT,
  color_hex             TEXT,                        -- optional, we may enrich from media service

  weight_lb             NUMERIC(10,4),
  image_url             TEXT,                        -- hotlinked to SanMar for v1
  gtin                  TEXT,                        -- UPC/EAN if ever provided

  -- Flat v1 values from Bulk Data. v2 replaces with warehouse_stock + price_tier tables.
  quantity              INTEGER,
  price                 NUMERIC(10,2),
  sale_price            NUMERIC(10,2),
  sale_end_date         DATE,
  currency              TEXT         NOT NULL DEFAULT 'CAD',

  raw_json              JSONB,

  first_seen_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_synced_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (product_id, supplier_variant_id)
);

CREATE INDEX IF NOT EXISTS supplier_variant_product_id_idx
  ON supplier_variant (product_id);

-- Look up a specific size+colour under a product (variant picker on PDP).
CREATE INDEX IF NOT EXISTS supplier_variant_size_color_idx
  ON supplier_variant (product_id, color_name, size);

-- "Is this variant orderable?" — quantity > 0 and price is set.
CREATE INDEX IF NOT EXISTS supplier_variant_stocked_idx
  ON supplier_variant (product_id)
  WHERE quantity > 0 AND price IS NOT NULL;

------------------------------------------------------------------------
-- Sync audit log
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_run (
  id                 SERIAL       PRIMARY KEY,
  supplier_id        INTEGER      NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  kind               TEXT         NOT NULL
                                  CHECK (kind IN ('bulk_data','product_data','media_content','inventory','pricing')),
  status             TEXT         NOT NULL DEFAULT 'running'
                                  CHECK (status IN ('running','success','failed')),
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ended_at           TIMESTAMPTZ,
  products_upserted  INTEGER      NOT NULL DEFAULT 0,
  variants_upserted  INTEGER      NOT NULL DEFAULT 0,
  error_message      TEXT,
  error_detail       JSONB
);

CREATE INDEX IF NOT EXISTS sync_run_supplier_kind_started_idx
  ON sync_run (supplier_id, kind, started_at DESC);

-- Find the last successful run of a given kind per supplier quickly.
CREATE INDEX IF NOT EXISTS sync_run_last_success_idx
  ON sync_run (supplier_id, kind, ended_at DESC)
  WHERE status = 'success';

------------------------------------------------------------------------
-- Seed: SanMar Canada as the first supplier
------------------------------------------------------------------------
INSERT INTO supplier (code, name, api_kind, notes)
VALUES (
  'sanmar_ca',
  'SanMar Canada',
  'promostandards',
  'Account #26562. Bulk Data 1.0 is v1 primary source (1 call/day). Product Data / Media / Inventory / Pricing layered in for v2.'
)
ON CONFLICT (code) DO NOTHING;

------------------------------------------------------------------------
-- Seed: brand restrictions (cannot be sold as blanks — embellishment req'd)
------------------------------------------------------------------------
INSERT INTO brand_restriction (brand, notes) VALUES
  ('Eddie Bauer',      'Blanks blocked — embellishment required.'),
  ('OGIO',             'Blanks blocked — embellishment required.'),
  ('New Era',          'Blanks blocked — embellishment required.'),
  ('The North Face',   'Blanks blocked — embellishment required.'),
  ('Callaway',         'Blanks blocked — embellishment required.'),
  ('Original Penguin', 'Blanks blocked — embellishment required.'),
  ('Nike',             'Blanks blocked — embellishment required.')
ON CONFLICT (brand) DO NOTHING;
