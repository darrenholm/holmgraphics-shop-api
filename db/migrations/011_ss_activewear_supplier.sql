-- 011_ss_activewear_supplier.sql
-- Seed S&S Activewear Canada as a second supplier alongside SanMar Canada.
-- Schema is already multi-supplier (see 002_supplier_catalog.sql) — this is
-- just the row + an api_kind tag so the adapter loader knows which client
-- to instantiate.
--
-- S&S exposes a REST API at https://api-ca.ssactivewear.com/V2/, HTTP Basic
-- auth (account_number:api_key). 60 req/min rate limit. Three endpoints
-- cover the catalog: /styles (parents), /products (variants with prices +
-- images + native colorHex), /inventory (per-warehouse qty). Whole catalog
-- = 3 unfiltered calls; per-style = 3 filtered calls (?styleID=N).
--
-- Distinct from the PromoStandards SOAP integration we'd discussed earlier
-- (different URL, different auth, different env vars). REST is what S&S
-- actually offers in Canada today; the SOAP path stays untaken.
--
-- Safe to re-run.

INSERT INTO supplier (code, name, api_kind, notes)
VALUES (
  'ss_activewear_ca',
  'S&S Activewear Canada',
  'custom',
  'REST API at api-ca.ssactivewear.com/V2/. HTTP Basic auth via SSACTIVEWEAR_ACCOUNT_NUMBER + SSACTIVEWEAR_API_KEY env vars. 60 req/min. Native colorHex on /products (color1, color2) — no curated map needed. Inventory in a separate /V2/inventory call.'
)
ON CONFLICT (code) DO NOTHING;
