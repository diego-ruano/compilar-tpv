-- ============================================================================
--  Control-plane (Turso central: tpvcontrol-altarialights)
--  Sistema de licencias PROPIO (fuera Lemon Squeezy, dentro Stripe)
--  Fecha: 2026-07-14 · Plan: docs/PLAN_LICENCIAS_PROPIAS.md
-- ============================================================================
--
--  NO es una migración con framework: se aplica una vez, a mano. El worker también
--  se auto-provisiona este mismo esquema (`ensureLicensingSchema` en
--  src/server/licenseStore.ts), así que ejecutar esto es opcional salvo por los DROP
--  del principio, que el worker NO puede hacer (un `CREATE TABLE IF NOT EXISTS` no
--  reemplaza una `licenses` que ya existe con las columnas lemon_*).
--
--  Es DESTRUCTIVO, pero seguro: no hay ninguna licencia real en producción (§0).
--  `tenants` ya trae legal_name/display_name/email/phone/country → no se toca.
--  `webhook_events` se reutiliza tal cual para los eventos de Stripe → no se toca.
--
--      turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-07-14_licencias_propias.sql
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ── Fuera lo de Lemon (primero las que referencian a licenses) ──────────────
DROP TABLE IF EXISTS license_instances;   -- contador de instancias de Lemon (lo sustituye main_device_id)
DROP TABLE IF EXISTS license_meta;        -- payload crudo de los webhooks de Lemon
DROP TABLE IF EXISTS licenses;            -- esquema viejo con columnas lemon_*

-- ── licenses (modelo propio) ────────────────────────────────────────────────
CREATE TABLE licenses (
  license_id                 TEXT PRIMARY KEY,
  license_key_hash           TEXT NOT NULL UNIQUE,
  license_key_enc            TEXT,
  key_short                  TEXT,
  tenant_id                  TEXT,
  main_device_id             TEXT,
  status                     TEXT NOT NULL,
  disabled                   INTEGER NOT NULL DEFAULT 0,
  plan                       TEXT NOT NULL DEFAULT 'standard',
  term_months                INTEGER NOT NULL,
  origin                     TEXT NOT NULL,
  issued_at_ms               INTEGER NOT NULL,
  activated_at_ms            INTEGER,
  expires_at_ms              INTEGER,
  customer_email             TEXT NOT NULL,
  customer_name              TEXT,
  stripe_customer_id         TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  stripe_price_id            TEXT,
  created_at_ms              INTEGER NOT NULL,
  updated_at_ms              INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_licenses_stripe_session
  ON licenses (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX ix_licenses_stripe_customer ON licenses (stripe_customer_id);
CREATE INDEX ix_licenses_tenant          ON licenses (tenant_id);
CREATE INDEX ix_licenses_email           ON licenses (customer_email);

-- ── Cambio de dispositivo (OTP + traza) ─────────────────────────────────────
CREATE TABLE license_device_otp (
  license_id     TEXT NOT NULL,
  new_device_id  TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  expires_at_ms  INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  created_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (license_id, new_device_id)
);

CREATE TABLE license_device_swaps (
  swap_id        TEXT PRIMARY KEY,
  license_id     TEXT NOT NULL,
  from_device_id TEXT,
  to_device_id   TEXT NOT NULL,
  at_ms          INTEGER NOT NULL
);

-- ── Auditoría del CLI de admin ──────────────────────────────────────────────
CREATE TABLE admin_audit (
  audit_id   TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  license_id TEXT,
  detail     TEXT,
  at_ms      INTEGER NOT NULL
);

PRAGMA foreign_keys = ON;
