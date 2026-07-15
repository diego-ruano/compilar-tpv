-- ============================================================================
--  Control-plane (Turso central: tpvcontrol-altarialights)
--  Sistema de licencias PROPIO (fuera Lemon Squeezy, dentro Stripe)
--  Fecha: 2026-07-14 · Plan: docs/PLAN_LICENCIAS_PROPIAS.md
-- ============================================================================
--
--  NO es una migración: el worker se auto-provisiona el esquema nuevo la primera
--  vez que se le llama (ver `ensureLicensingSchema` en src/server/licenseStore.ts).
--
--  Lo ÚNICO que el worker no puede hacer por sí mismo es reemplazar tablas que ya
--  existen con el esquema viejo de Lemon (`CREATE TABLE IF NOT EXISTS` no las
--  toca). Por eso este script solo BORRA esas tres tablas, una vez. Tras
--  ejecutarlo, la primera petición al worker recrea `licenses` con el esquema
--  nuevo y crea las tablas de OTP / swaps / auditoría.
--
--  Es DESTRUCTIVO, pero seguro: no hay ninguna licencia real en producción
--  (decisión §0 del plan). Ejecutar una sola vez:
--
--      turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-07-14_licencias_propias.sql
-- ============================================================================

DROP TABLE IF EXISTS license_instances;  -- contador de activaciones de Lemon (lo sustituye main_device_id)
DROP TABLE IF EXISTS license_meta;       -- payload crudo de los webhooks de Lemon
DROP TABLE IF EXISTS licenses;           -- esquema viejo con columnas lemon_*; el worker la recrea
