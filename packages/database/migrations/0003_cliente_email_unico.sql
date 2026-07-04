-- CLI-04: unicidad de email de cliente.
-- Indice UNIQUE PARCIAL sobre lower(Email): dos clientes no pueden compartir email
-- (comparacion case-insensitive). Se excluyen los NULL/vacio del indice, asi que se
-- permiten multiples clientes sin email. La app normaliza el email a minusculas antes
-- de guardarlo; el indice sobre lower(Email) protege ademas frente a datos heredados
-- con mayusculas mezcladas.
--
-- NOTA: si una BD ya tuviera dos clientes con el mismo email, esta migracion fallara
-- (habria que deduplicar antes). En instalaciones limpias no aplica.
CREATE UNIQUE INDEX IF NOT EXISTS ux_clientes_email
ON Clientes(lower(Email))
WHERE Email IS NOT NULL AND Email <> '';
