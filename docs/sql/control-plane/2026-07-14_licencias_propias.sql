-- ============================================================================
--  Control-plane (Turso central: tpvcontrol-altarialights)
--  Migración: sistema de licencias PROPIO (fuera Lemon Squeezy, dentro Stripe)
--  Fecha: 2026-07-14 · Plan: docs/PLAN_LICENCIAS_PROPIAS.md
-- ============================================================================
--
--  ⚠️  DESTRUCTIVA. Recrea `licenses` desde cero y borra las tablas satélite de
--      Lemon. Es seguro porque NO hay ninguna licencia real en producción
--      (decisión §0 del plan: "campo libre"). Si eso deja de ser cierto, PARA:
--      haría falta una migración que preserve `license_key_hash` + `tenant_id`.
--
--  NO se toca: `tenants`, `devices`, `tenant_dbs`, `pair_requests`, `Ws_Tickets`,
--  `webhook_events` (esta última se REUTILIZA para los eventos de Stripe).
--
--  Cómo ejecutarla:
--      turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-07-14_licencias_propias.sql
--
--  Sobre los ALTER TABLE de `tenants` (al final): si alguna columna ya existiera,
--  Turso responde `duplicate column name: X`. Es inofensivo — salta esa línea y
--  sigue con la siguiente.
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ── 1. Fuera lo de Lemon ────────────────────────────────────────────────────
-- `license_instances` modelaba las "instancias" de Lemon (su contador de activaciones).
-- Lo sustituye `licenses.main_device_id`: 1 licencia = 1 Main.
DROP TABLE IF EXISTS license_instances;

-- `license_meta` guardaba el payload crudo de los webhooks de Lemon. Los de Stripe
-- ya quedan íntegros en `webhook_events.payload_json`.
DROP TABLE IF EXISTS license_meta;

DROP TABLE IF EXISTS licenses;

-- ── 2. Tabla `licenses` (modelo propio) ─────────────────────────────────────
CREATE TABLE licenses (
  license_id                 TEXT PRIMARY KEY,      -- uuid v4
  license_key_hash           TEXT NOT NULL UNIQUE,  -- sha256(clave canónica). La clave NUNCA en claro
  license_key_enc            TEXT,                  -- AES-GCM(clave) para soporte/reemisión
  key_short                  TEXT,                  -- "TPV-…-WX7Q" para la UI (no sensible)

  tenant_id                  TEXT,                  -- NULL hasta la 1ª activación
  main_device_id             TEXT,                  -- el ÚNICO Main autorizado (§6.4 del plan)

  status                     TEXT NOT NULL,         -- 'issued' | 'active' | 'expired' | 'revoked'
  disabled                   INTEGER NOT NULL DEFAULT 0,

  plan                       TEXT NOT NULL DEFAULT 'standard',
  term_months                INTEGER NOT NULL,      -- 1 | 3 | 12
  origin                     TEXT NOT NULL,         -- 'stripe' | 'manual'

  issued_at_ms               INTEGER NOT NULL,      -- emisión (compra o alta manual)
  activated_at_ms            INTEGER,               -- 1ª activación: aquí arranca el reloj
  expires_at_ms              INTEGER,               -- caducidad ABSOLUTA: fuente de verdad del gate

  -- Identidad del cliente. `customer_email` es la raíz de confianza del cambio de
  -- dispositivo (allí se manda el OTP), por eso es NOT NULL.
  customer_email             TEXT NOT NULL,
  customer_name              TEXT,

  -- Enlace con Stripe (sustituye a las columnas lemon_*)
  stripe_customer_id         TEXT,
  stripe_checkout_session_id TEXT,                  -- idempotencia del fulfillment
  stripe_payment_intent_id   TEXT,
  stripe_price_id            TEXT,

  created_at_ms              INTEGER NOT NULL,
  updated_at_ms              INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_licenses_key_hash ON licenses (license_key_hash);
-- Una sesión de checkout solo puede materializarse en UNA licencia: si Stripe
-- reintenta el webhook, el INSERT choca aquí y el fulfillment queda idempotente
-- incluso ante ejecuciones concurrentes.
CREATE UNIQUE INDEX ux_licenses_stripe_session
  ON licenses (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX ix_licenses_stripe_customer ON licenses (stripe_customer_id);
CREATE INDEX ix_licenses_tenant          ON licenses (tenant_id);
CREATE INDEX ix_licenses_email           ON licenses (customer_email);

-- ── 3. Cambio de dispositivo: OTP + traza ───────────────────────────────────
-- Código de un solo uso que autoriza mover la licencia a otro Main. Solo se guarda
-- el hash; el código en claro vive únicamente en el email del cliente.
CREATE TABLE license_device_otp (
  license_id     TEXT NOT NULL,
  new_device_id  TEXT NOT NULL,     -- el código SOLO vale para este dispositivo
  code_hash      TEXT NOT NULL,     -- sha256(código)
  attempts       INTEGER NOT NULL DEFAULT 0,
  expires_at_ms  INTEGER NOT NULL,  -- +10 min
  consumed_at_ms INTEGER,
  created_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (license_id, new_device_id)
);

-- Auditoría de cada reasignación de Main (detección de abuso / soporte).
CREATE TABLE license_device_swaps (
  swap_id        TEXT PRIMARY KEY,
  license_id     TEXT NOT NULL,
  from_device_id TEXT,
  to_device_id   TEXT NOT NULL,
  at_ms          INTEGER NOT NULL
);

CREATE INDEX ix_license_device_swaps_license ON license_device_swaps (license_id);

-- ── 4. Auditoría de las acciones de admin (CLI) ─────────────────────────────
CREATE TABLE admin_audit (
  audit_id   TEXT PRIMARY KEY,
  action     TEXT NOT NULL,   -- 'issue' | 'revoke' | 'extend'
  license_id TEXT,
  detail     TEXT,            -- JSON con lo relevante (nunca la clave en claro)
  at_ms      INTEGER NOT NULL
);

-- ── 5. Datos del negocio en `tenants` (corrige el bug #5: se descartaban) ────
-- Ejecuta línea a línea. Si alguna columna ya existe, Turso dirá
-- "duplicate column name" — ignora esa y continúa.
ALTER TABLE tenants ADD COLUMN display_name TEXT;
ALTER TABLE tenants ADD COLUMN legal_name   TEXT;
ALTER TABLE tenants ADD COLUMN email        TEXT;
ALTER TABLE tenants ADD COLUMN phone        TEXT;
ALTER TABLE tenants ADD COLUMN country      TEXT;

PRAGMA foreign_keys = ON;
