-- Control-plane (Turso central) — traza de entrega del correo con la clave de licencia.
--
-- `key_email_sent_at_ms IS NULL` significa que esa licencia se pagó/emitió pero el correo con la
-- clave NO llegó a enviarse (p. ej. Email Sending sin habilitar). Permite listarlas y reenviarlas
-- con `pnpm license:resend`.
--
-- Ejecutar UNA vez contra la BD de control:
--   turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-07-17_key_email_tracking.sql
--
-- Nota: el worker también la auto-añade en su arranque (ensureLicensingSchema). ALTER no admite
-- IF NOT EXISTS: si ya existe, falla con "duplicate column name" y no pasa nada.

ALTER TABLE licenses ADD COLUMN key_email_sent_at_ms INTEGER;

-- Licencias pagadas/emitidas cuya clave NUNCA se entregó por correo (para revisar):
--   SELECT license_id, customer_email, origin, key_short
--   FROM licenses
--   WHERE key_email_sent_at_ms IS NULL AND origin = 'stripe';
