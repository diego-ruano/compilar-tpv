-- 0006_comanda_unica_abierta.sql
--
-- MESA-03: como mucho UNA comanda 'Abierta' por mesa a la vez. Hasta ahora abrir_comanda
-- hacia siempre un INSERT sin comprobar, de modo que dos aperturas concurrentes de la misma
-- mesa (doble toque, o Main + Handy a la vez) podian dejar dos comandas abiertas y repartir
-- las lineas/totales entre ambas.
--
-- La capa de aplicacion ya hace la apertura idempotente (comprueba la comanda abierta antes
-- de insertar + INSERT ... WHERE NOT EXISTS). Este indice unico parcial es la RED DE SEGURIDAD
-- a nivel de esquema: garantiza el invariante aunque una ruta futura inserte sin el guard.
-- Solo aplica a filas con Estado='Abierta' (las 'Pagada'/cerradas no cuentan), asi que una
-- mesa puede acumular muchas comandas historicas cerradas y una unica abierta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comandas_una_abierta_por_mesa
ON Comandas(ID_Mesa) WHERE Estado = 'Abierta';
