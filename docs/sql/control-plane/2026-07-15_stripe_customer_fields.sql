-- Control-plane (Turso central) — datos de compra de Stripe en `licenses`.
--
-- Añade el nombre empresarial, el teléfono y la dirección de facturación que se recopilan en el
-- Checkout de Stripe, para que el negocio pueda emitir la factura con los datos del comprador.
-- El nombre individual ya viaja en `customer_name` y el email en `customer_email`.
--
-- Ejecutar UNA vez contra la BD de control:
--   turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-07-15_stripe_customer_fields.sql
--
-- Nota: el worker también auto-añade estas columnas en su arranque (ensureLicensingSchema), así que
-- este script es solo para aplicarlas de inmediato / dejar traza. ALTER no admite IF NOT EXISTS:
-- si una columna ya existe, ese ALTER falla con "duplicate column name" y se continúa con el resto.

ALTER TABLE licenses ADD COLUMN customer_business_name TEXT;
ALTER TABLE licenses ADD COLUMN customer_phone TEXT;
ALTER TABLE licenses ADD COLUMN customer_address_json TEXT;
