-- 003_add_category.sql
-- Supplier product categories.
--
-- Source: PromoStandards Product Data 2.0 (GetProduct) response has a
-- ProductCategoryArray with a `category` string (e.g. OUTERWEAR, T-SHIRTS,
-- SWEATSHIRTS/FLEECE). SanMar Canada's subCategory field is unsupported
-- per their docs — ignore.
--
-- We store the unmodified supplier string in `category_raw` and a
-- canonicalized bucket in `category` for filtering on the storefront.
-- Canonicalization lives in suppliers/sanmar/category-map.js so it can
-- be changed without a migration.
--
-- Safe to re-run.

ALTER TABLE supplier_product
  ADD COLUMN IF NOT EXISTS category     TEXT,
  ADD COLUMN IF NOT EXISTS category_raw TEXT;

-- Partial index matches the one already used by the sellable filter —
-- lets /catalog/search filter on (supplier, category) cheaply.
CREATE INDEX IF NOT EXISTS supplier_product_category_idx
  ON supplier_product (supplier_id, category)
  WHERE is_sellable = TRUE AND is_discontinued = FALSE;
