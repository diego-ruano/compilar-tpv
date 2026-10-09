-- RI-48: valores de dominio cerrados en todos los motores.
-- Los triggers imponen la misma regla que CHECK sin reconstruir tablas referenciadas.
-- Los runners de nube mantienen las FK activas dentro de su transaccion.
-- Validar primero los datos existentes; nunca convertir un metodo desconocido en efectivo.
CREATE TABLE _RI48_Validacion (Valido INTEGER NOT NULL CHECK (Valido = 1));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Pagos WHERE NOT (Metodo_Pago IN ('Efectivo','Tarjeta') OR (Metodo_Pago = 'Otro' AND Tipo = 'DEVOLUCION'));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Detalle_Comanda WHERE NOT (Estado_Cocina IS NULL OR Estado_Cocina IN ('PENDIENTE','PREPARADO'));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Reservas WHERE NOT (Estado IN ('PROXIMA','ACTIVA','FINALIZADA','CANCELADA','NO_SHOW'));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Tareas WHERE NOT (Estado IN ('ABIERTA','ELIMINADA'));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Tarea_Asignaciones WHERE NOT (Estado IN ('PENDIENTE','FINALIZADA'));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Fichajes WHERE NOT (Estado IS NULL OR Estado IN ('ABIERTO','CERRADO'));
INSERT INTO _RI48_Validacion SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM Movimientos_Caja WHERE NOT (Metodo_Pago IS NULL OR Metodo_Pago IN ('Efectivo','Tarjeta','Otro'));
DROP TABLE _RI48_Validacion;

CREATE TRIGGER ri48_pagos_metodo_pago_insert
BEFORE INSERT ON Pagos
WHEN NOT (NEW.Metodo_Pago IN ('Efectivo','Tarjeta') OR (NEW.Metodo_Pago = 'Otro' AND NEW.Tipo = 'DEVOLUCION'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Pagos.Metodo_Pago no admitido');
END;

CREATE TRIGGER ri48_pagos_metodo_pago_update
BEFORE UPDATE ON Pagos
WHEN NOT (NEW.Metodo_Pago IN ('Efectivo','Tarjeta') OR (NEW.Metodo_Pago = 'Otro' AND NEW.Tipo = 'DEVOLUCION'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Pagos.Metodo_Pago no admitido');
END;

CREATE TRIGGER ri48_detalle_comanda_estado_cocina_insert
BEFORE INSERT ON Detalle_Comanda
WHEN NOT (NEW.Estado_Cocina IS NULL OR NEW.Estado_Cocina IN ('PENDIENTE','PREPARADO'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Detalle_Comanda.Estado_Cocina no admitido');
END;

CREATE TRIGGER ri48_detalle_comanda_estado_cocina_update
BEFORE UPDATE ON Detalle_Comanda
WHEN NOT (NEW.Estado_Cocina IS NULL OR NEW.Estado_Cocina IN ('PENDIENTE','PREPARADO'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Detalle_Comanda.Estado_Cocina no admitido');
END;

CREATE TRIGGER ri48_reservas_estado_insert
BEFORE INSERT ON Reservas
WHEN NOT (NEW.Estado IN ('PROXIMA','ACTIVA','FINALIZADA','CANCELADA','NO_SHOW'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Reservas.Estado no admitido');
END;

CREATE TRIGGER ri48_reservas_estado_update
BEFORE UPDATE ON Reservas
WHEN NOT (NEW.Estado IN ('PROXIMA','ACTIVA','FINALIZADA','CANCELADA','NO_SHOW'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Reservas.Estado no admitido');
END;

CREATE TRIGGER ri48_tareas_estado_insert
BEFORE INSERT ON Tareas
WHEN NOT (NEW.Estado IN ('ABIERTA','ELIMINADA'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Tareas.Estado no admitido');
END;

CREATE TRIGGER ri48_tareas_estado_update
BEFORE UPDATE ON Tareas
WHEN NOT (NEW.Estado IN ('ABIERTA','ELIMINADA'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Tareas.Estado no admitido');
END;

CREATE TRIGGER ri48_tarea_asignaciones_estado_insert
BEFORE INSERT ON Tarea_Asignaciones
WHEN NOT (NEW.Estado IN ('PENDIENTE','FINALIZADA'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Tarea_Asignaciones.Estado no admitido');
END;

CREATE TRIGGER ri48_tarea_asignaciones_estado_update
BEFORE UPDATE ON Tarea_Asignaciones
WHEN NOT (NEW.Estado IN ('PENDIENTE','FINALIZADA'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Tarea_Asignaciones.Estado no admitido');
END;

CREATE TRIGGER ri48_fichajes_estado_insert
BEFORE INSERT ON Fichajes
WHEN NOT (NEW.Estado IS NULL OR NEW.Estado IN ('ABIERTO','CERRADO'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Fichajes.Estado no admitido');
END;

CREATE TRIGGER ri48_fichajes_estado_update
BEFORE UPDATE ON Fichajes
WHEN NOT (NEW.Estado IS NULL OR NEW.Estado IN ('ABIERTO','CERRADO'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Fichajes.Estado no admitido');
END;

CREATE TRIGGER ri48_movimientos_caja_metodo_pago_insert
BEFORE INSERT ON Movimientos_Caja
WHEN NOT (NEW.Metodo_Pago IS NULL OR NEW.Metodo_Pago IN ('Efectivo','Tarjeta','Otro'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Movimientos_Caja.Metodo_Pago no admitido');
END;

CREATE TRIGGER ri48_movimientos_caja_metodo_pago_update
BEFORE UPDATE ON Movimientos_Caja
WHEN NOT (NEW.Metodo_Pago IS NULL OR NEW.Metodo_Pago IN ('Efectivo','Tarjeta','Otro'))
BEGIN
  SELECT RAISE(ABORT, 'RI48: Movimientos_Caja.Metodo_Pago no admitido');
END;
