-- Control-plane (Turso central) — registro de los correos que envía el worker (FABLE-C).
--
-- Qué es: una fila por intento de envío de `POST /v1/email/enviar-pedido`. NO impone ningún
-- límite (decisión del responsable, 2026-08-15: no se limita a nadie por ahora); es la traza que
-- permite ver a posteriori quién está enviando y cuánto, y hablar con ese cliente si hace falta.
--
-- Por qué en el control-plane y no en la BD del tenant: la BD del tenant se replica por el outbox
-- y la escribe el propio dispositivo. Un registro anti-abuso no puede vivir donde lo escribe el
-- que quieres vigilar, y además ensuciaría la replicación con filas que no son de negocio.
--
-- Ejecutar UNA vez contra la BD de control:
--   turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-08-15_email_sends.sql
--
-- El worker tolera que esta tabla NO exista: el registro es best-effort y su fallo nunca impide
-- que el correo salga (ver email.routes.ts). Así el despliegue no depende del orden.

CREATE TABLE IF NOT EXISTS email_sends (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  to_email   TEXT NOT NULL,
  proveedor  TEXT,
  ok         INTEGER NOT NULL,
  error_code TEXT,
  sent_at_ms INTEGER NOT NULL
);

-- Consulta natural: "qué ha enviado este tenant últimamente" (y el conteo por ventana, si algún
-- día se quiere poner un límite).
CREATE INDEX IF NOT EXISTS idx_email_sends_tenant_ts ON email_sends(tenant_id, sent_at_ms);

-- Vigilancia manual — los 20 tenants que más han enviado en los últimos 30 días:
--   SELECT tenant_id, COUNT(*) AS envios, COUNT(DISTINCT to_email) AS destinatarios
--   FROM email_sends
--   WHERE sent_at_ms > (unixepoch() - 30*24*3600) * 1000
--   GROUP BY tenant_id
--   ORDER BY envios DESC
--   LIMIT 20;
--
-- Purga (cuando la tabla crezca; no hay job automático a propósito):
--   DELETE FROM email_sends WHERE sent_at_ms < (unixepoch() - 365*24*3600) * 1000;
