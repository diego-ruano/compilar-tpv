-- 0008_notificaciones.sql
--
-- Sistema de notificaciones in-app (NOTIF-01). Avisos persistentes que cualquier modulo puede
-- emitir (stock bajo, aprobar pedido, expedicion/expiracion de licencia, gracia offline, avisos
-- manuales) y que se pueden dirigir a un usuario concreto, a un rol o a todos.
--
-- Modelo "fan-out on read": UNA fila por mensaje (aunque vaya "a todos") en Notificaciones; el
-- estado "leido" es POR TRABAJADOR en Notificacion_Lecturas (un recibo por quien la lee). Asi una
-- notificacion "a todos"/"por rol" es una sola fila y cada usuario marca su propia lectura sin
-- duplicar el mensaje (escala sin explosion de filas por destinatario).
--
-- Sincronizacion (ver §9 CLAUDE.md): son tablas del ESQUEMA COMPARTIDO (se replican a la nube y a
-- las Handy por el outbox/WS). Por eso el ID lo genera el repositorio en Rust ANTES del INSERT
-- (TEXT PRIMARY KEY sin DEFAULT ni trigger) y las marcas de tiempo se escriben con
-- datetime('now','localtime'), que el outbox/tenantHub congela a literal antes de replicar.

-- El mensaje. Uno por notificacion, con independencia del numero de destinatarios.
--   Destino_Tipo / Destino_Valor: a quien apunta ('todos' -> Valor NULL; 'usuario' -> ID_Usuario;
--     'rol' -> ID_Rol, que es estable frente al renombrado del rol). El rol de un usuario vive en
--     Usuarios.ID_Rol, asi que la visibilidad "por rol" se resuelve contra esa tabla.
--   Accion / Payload: accion opcional que ofrece la notificacion y sus datos en JSON. El backend es
--     agnostico: el frontend decide como pintar cada Tipo y que hace cada Accion.
--   Clave_Dedupe: clave anti-duplicado mientras la notificacion esta 'activa' (p.ej.
--     'stock_bajo:<ID_Producto>') para no repetir el mismo aviso.
--   Estado: ciclo de vida. Al reponer stock / aprobar el pedido, el emisor marca 'resuelta' en vez
--     de acumular avisos.
CREATE TABLE IF NOT EXISTS Notificaciones (
  ID_Notificacion TEXT PRIMARY KEY,
  Tipo            TEXT NOT NULL,
  Severidad       TEXT NOT NULL DEFAULT 'info',
  Titulo          TEXT NOT NULL,
  Cuerpo          TEXT,
  Destino_Tipo    TEXT NOT NULL,
  Destino_Valor   TEXT,
  Accion          TEXT,
  Payload         TEXT,
  Clave_Dedupe    TEXT,
  Estado          TEXT NOT NULL DEFAULT 'activa',
  Creada_En       DATETIME NOT NULL,
  Expira_En       DATETIME,
  CHECK (Destino_Tipo IN ('todos', 'usuario', 'rol')),
  CHECK (Severidad IN ('info', 'exito', 'aviso', 'error')),
  CHECK (Estado IN ('activa', 'resuelta', 'descartada'))
);

-- Anti-duplicado: como mucho UNA notificacion 'activa' por Clave_Dedupe. Las resueltas/descartadas
-- no cuentan, asi que el aviso puede volver a emitirse si la condicion reaparece tras resolverse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe_activa
ON Notificaciones(Clave_Dedupe)
WHERE Clave_Dedupe IS NOT NULL AND Estado = 'activa';

-- Listado del centro de notificaciones: filtrar por estado y ordenar por fecha.
CREATE INDEX IF NOT EXISTS idx_notif_estado_fecha
ON Notificaciones(Estado, Creada_En);

-- Recibo de lectura por usuario. La AUSENCIA de fila = no leida para ese usuario. El estado "leido"
-- es por usuario (una notificacion "a todos" la leen distintos usuarios en distinto momento). Se
-- clava en ID_Usuario (el principal de la sesion, que siempre existe tras login) y no en
-- ID_Trabajador (que puede ser NULL, p.ej. el admin semilla sin ficha de trabajador).
-- ON DELETE CASCADE: al purgar/borrar una notificacion, sus recibos se van con ella. El DELETE del
-- padre se replica y cada motor re-deriva la cascada localmente (FK activadas en todas las conexiones).
CREATE TABLE IF NOT EXISTS Notificacion_Lecturas (
  ID_Notificacion TEXT NOT NULL,
  ID_Usuario      TEXT NOT NULL,
  Leida_En        DATETIME NOT NULL,
  PRIMARY KEY (ID_Notificacion, ID_Usuario),
  FOREIGN KEY (ID_Notificacion) REFERENCES Notificaciones(ID_Notificacion) ON DELETE CASCADE
);

-- Resolver "mis no leidas": buscar los recibos de un usuario.
CREATE INDEX IF NOT EXISTS idx_notif_lectura_usuario
ON Notificacion_Lecturas(ID_Usuario);
