-- 0005_intentos_login.sql
--
-- Anti brute-force del PIN (LOGIN-01): estado de intentos fallidos y bloqueo temporal por usuario.
-- Tabla del ESQUEMA COMPARTIDO (existe igual en la BD local de la Main y en la de tenant en Turso),
-- pero su contenido es DEVICE-LOCAL: no se sincroniza.
--   - MAIN:  escribe/lee su propio estado con la conexion `raw` (sin outbox), para throttlear los
--            logins locales. No se replica a la nube.
--   - WORKER: escribe/lee este estado en la BD de tenant (directo, sin hub), para throttlear los
--            logins de Handy.
-- Cada lado throttlea de forma independiente; las filas de uno no viajan al otro.
--
-- Bloqueado_Hasta_Ms / Ultimo_Intento_Ms: epoch en milisegundos (reloj del dispositivo/worker). Se
-- comparan contra "ahora" en la capa de aplicacion; no se usan funciones de tiempo de SQL (no es
-- una escritura replicable, asi que no aplica el determinismo temporal del outbox).
CREATE TABLE IF NOT EXISTS Intentos_Login (
  ID_Usuario TEXT PRIMARY KEY,
  Intentos_Fallidos INTEGER NOT NULL DEFAULT 0,
  Bloqueado_Hasta_Ms INTEGER NOT NULL DEFAULT 0,
  Ultimo_Intento_Ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE CASCADE
);
