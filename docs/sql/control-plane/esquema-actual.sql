-- ============================================================================================
-- Esquema de la base CENTRAL (control-plane) de `tpv-api`, tal como está en producción.
--
-- Foto tomada el 2026-09-16. Es la única referencia de esta base en el repo.
--
-- La estructura de esta base NO se toca desde el código: el worker no crea ni altera tablas. Se
-- gestiona a mano en Turso, y si cambia allí esta foto se queda vieja sin que nada avise, así que
-- hay que regenerarla a mano:
--
--   turso db shell tpvcontrol-altarialights "SELECT * FROM sqlite_master;"
--
-- De ese volcado se quitan las entradas `sqlite_autoindex_*` (sin SQL: son los índices que SQLite
-- crea solo para las claves primarias y los UNIQUE) y se agrupa cada tabla con sus índices.
-- No hay vistas ni triggers.
--
-- Lo que SÍ la ejecuta: los tests del worker (`test/helpers/planoDeControl.ts`), para crear estas
-- mismas tablas en su SQLite temporal. Por eso tiene que ser SQL válido de principio a fin.
-- ============================================================================================


-- ── Negocios ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  tenant_id        TEXT PRIMARY KEY,              -- UUID
  status           TEXT NOT NULL DEFAULT 'active'  CHECK (status IN ('active','suspended','deleted')),
  legal_name       TEXT,
  display_name     TEXT,
  email            TEXT,
  phone            TEXT,
  country          TEXT,
  timezone         TEXT,
  notes            TEXT,
  created_at_ms    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  updated_at_ms    INTEGER NOT NULL DEFAULT (unixepoch()*1000)
, field_dek TEXT);

CREATE INDEX idx_tenants_status ON tenants(status);

CREATE TABLE tenant_databases (
  tenant_id             TEXT PRIMARY KEY,
  turso_db_name         TEXT,
  turso_url             TEXT,
  turso_auth_token_enc  TEXT,  -- token cifrado (AES-GCM base64)
  created_at_ms         INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  rotated_at_ms         INTEGER, token_expires_at_ms INTEGER, provisioning_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (provisioning_status IN ('creating','ready','error')), last_error TEXT,

  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_tenantdb_status ON tenant_databases(provisioning_status);
CREATE INDEX idx_tenantdb_tokenexp ON tenant_databases(token_expires_at_ms);

CREATE TABLE tenant_recovery_emails (
  tenant_id      TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL
);


-- ── Dispositivos y emparejamiento ────────────────────────────────────────────────────────────

CREATE TABLE devices (
  device_id        TEXT PRIMARY KEY,  -- UUID o HWID
  tenant_id        TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('tpv','handy')),
  first_seen_at_ms INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  last_seen_at_ms  INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  revoked_at_ms    INTEGER, device_pubkey_b64 TEXT, pubkey_alg TEXT,

  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

CREATE TABLE pair_requests (
  pair_code                TEXT PRIMARY KEY,         -- "123456"
  secret_hash              TEXT NOT NULL,            -- SHA-256/Argon2 del secret del QR (no guardes el secret en claro)
  tenant_id                TEXT NOT NULL,
  created_by_device_id     TEXT NOT NULL,            -- device_id de la MAIN que lo creó

  status                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','used','expired')),

  created_at_ms            INTEGER NOT NULL,
  expires_at_ms            INTEGER NOT NULL,

  claimed_at_ms            INTEGER,                  -- cuando la handy hace claim
  approved_at_ms           INTEGER,                  -- cuando la main acepta
  used_at_ms               INTEGER,                  -- cuando se emite token definitivo (o se consume)

  claimed_by_device_id     TEXT,                     -- device_id de la handy
  claimed_device_pubkey_b64 TEXT,                    -- pubkey ed25519 b64
  claimed_device_name      TEXT,

  attempts                 INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_ms       INTEGER
);

CREATE INDEX idx_pair_requests_tenant   ON pair_requests (tenant_id);
CREATE INDEX idx_pair_requests_expires  ON pair_requests (expires_at_ms);
CREATE INDEX idx_pair_requests_status   ON pair_requests (status);

CREATE TABLE device_challenges (
  device_id       TEXT NOT NULL,
  nonce_b64        TEXT NOT NULL,
  expires_at_ms    INTEGER NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  used_at_ms       INTEGER,

  PRIMARY KEY (device_id, nonce_b64)
);

CREATE INDEX idx_device_challenges_exp  ON device_challenges (expires_at_ms);
CREATE INDEX idx_device_challenges_dev  ON device_challenges (device_id);

-- Los fallos al reclamar un código, por IP: la espera por tramos (`pairing.intentos.ts`).
CREATE TABLE pair_claim_fallos (
  ip                 TEXT PRIMARY KEY,
  fallos             INTEGER NOT NULL,
  ultimo_fallo_ms    INTEGER NOT NULL,
  bloqueado_hasta_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE Ws_Tickets (
  ticket TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

-- Cada petición de ticket borra los caducados: sin esto recorría la tabla entera.
CREATE INDEX idx_ws_tickets_expires ON Ws_Tickets (expires_at_ms);


-- ── Licencias ────────────────────────────────────────────────────────────────────────────────

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
, customer_business_name TEXT, customer_phone TEXT, customer_address_json TEXT, key_email_sent_at_ms INTEGER);

CREATE UNIQUE INDEX ux_licenses_stripe_session
  ON licenses (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX ix_licenses_stripe_customer ON licenses (stripe_customer_id);
CREATE INDEX ix_licenses_tenant          ON licenses (tenant_id);
CREATE INDEX ix_licenses_email           ON licenses (customer_email);

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

-- REV-13 · Qué avisos de caducidad se han mandado ya, para no repetirlos.
--
-- La clave incluye `expires_at_ms` a propósito: sin él, una licencia renovada no volvería a avisar
-- nunca (la fila del año pasado seguiría ahí). Con él, mover la caducidad abre un aviso nuevo y
-- deja el anterior como rastro de lo que se envió.
--
-- `kind`: 'expira_30' | 'expira_7' (ver PELDANOS en domains/licensing/avisosDeCaducidad.ts).
CREATE TABLE license_notices (
  license_id                 TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  expires_at_ms              INTEGER NOT NULL,
  sent_at_ms                 INTEGER NOT NULL,
  PRIMARY KEY (license_id, kind, expires_at_ms)
);

CREATE TABLE license_payments (
  payment_id                 TEXT PRIMARY KEY,
  license_id                 TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  term_months                INTEGER NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  reversed_at_ms             INTEGER,
  reversed_reason            TEXT,
  reversed_event_uid         TEXT,
  at_ms                      INTEGER NOT NULL
);

CREATE INDEX ix_license_payments_intent
  ON license_payments (stripe_payment_intent_id);
-- REV-01: una sesión de checkout se cumple una sola vez. Es la barrera del webhook de pago
-- (`licenses.stripe_checkout_session_id` no sirve: cada renovación la sobrescribe).
CREATE UNIQUE INDEX ux_license_payments_session
  ON license_payments (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX ix_license_payments_license ON license_payments (license_id);

CREATE TABLE admin_audit (
  audit_id   TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  license_id TEXT,
  detail     TEXT,
  at_ms      INTEGER NOT NULL
);

-- Idempotencia de los webhooks de Stripe: cada `event.id` se procesa una sola vez.
-- (Los comentarios de columna son de esta foto; los de la tabla en Turso son antiguos y no se
-- pueden cambiar sin recrearla.)
CREATE TABLE webhook_events (
  event_uid        TEXT PRIMARY KEY,  -- id del evento de Stripe (event.id)
  event_name       TEXT NOT NULL,      -- tipo del evento: checkout.session.completed, charge.refunded…
  resource_type    TEXT,              -- el objeto del evento: "checkout.session", "charge", "dispute"
  resource_id      TEXT,              -- id de ese objeto
  sig_hex          TEXT,              -- SIN USO: la firma de Stripe se verifica y no se guarda (NULL)
  body_sha256      TEXT,              -- sha256 del cuerpo crudo
  payload_json     TEXT NOT NULL,      -- el cuerpo completo
  received_at_ms   INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  processed_at_ms  INTEGER,
  processed_ok     INTEGER NOT NULL DEFAULT 0 CHECK (processed_ok IN (0,1)),
  error_text       TEXT
);

CREATE INDEX idx_webhooks_event_name ON webhook_events(event_name);
CREATE INDEX idx_webhooks_resource ON webhook_events(resource_type, resource_id);
CREATE INDEX idx_webhooks_processed ON webhook_events(processed_ok, received_at_ms);


-- ── Correo ───────────────────────────────────────────────────────────────────────────────────

CREATE TABLE email_codes (
  tenant_id         TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  purpose           TEXT NOT NULL,
  subject           TEXT NOT NULL,
  code_hash         TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  expires_at_ms     INTEGER NOT NULL,
  consumed_at_ms    INTEGER,
  created_at_ms     INTEGER NOT NULL,
  sends_in_window   INTEGER NOT NULL DEFAULT 1,
  window_started_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, device_id, purpose)
);

CREATE TABLE email_sends (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  to_email   TEXT NOT NULL,
  proveedor  TEXT,
  ok         INTEGER NOT NULL,
  error_code TEXT,
  sent_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_email_sends_tenant_ts ON email_sends(tenant_id, sent_at_ms);


-- ── Actualizaciones de la app ────────────────────────────────────────────────────────────────

CREATE TABLE app_releases (
  version       TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT 'windows',
  channel       TEXT NOT NULL DEFAULT 'stable',
  notes         TEXT,
  pub_date      TEXT NOT NULL,
  signature     TEXT NOT NULL,
  url           TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  PRIMARY KEY (version, target, channel)
);
