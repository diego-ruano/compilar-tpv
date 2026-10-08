-- RI-85: migración aditiva para conservar las bases de trabajo existentes.
ALTER TABLE Asignacion_Turnos ADD COLUMN ID_Grupo TEXT;
CREATE INDEX idx_asig_grupo ON Asignacion_Turnos(ID_Grupo);

-- La regla se comprueba también en dominio. Esta guarda la aplica dentro de la
-- transacción, incluida la réplica, sin una lectura previa que pueda quedarse vieja.
CREATE TRIGGER asig_validar_insert BEFORE INSERT ON Asignacion_Turnos
BEGIN
  SELECT RAISE(ABORT, 'horario_invalido') WHERE
    date(NEW.Fecha) IS NULL OR date(NEW.Fecha) <> NEW.Fecha OR
    (NEW.Hora_Inicio IS NULL) <> (NEW.Hora_Fin IS NULL) OR
    (NEW.Hora_Inicio IS NOT NULL AND (time(NEW.Hora_Inicio) IS NULL OR
      time(NEW.Hora_Fin) IS NULL OR time(NEW.Hora_Inicio) = time(NEW.Hora_Fin)));
  SELECT RAISE(ABORT, 'horario_solapado') WHERE NEW.Hora_Inicio IS NOT NULL AND EXISTS (
    SELECT 1 FROM Asignacion_Turnos a WHERE a.ID_Trabajador = NEW.ID_Trabajador
      AND a.ID_Asignacion <> NEW.ID_Asignacion AND a.Hora_Inicio IS NOT NULL
      AND datetime(a.Fecha || ' ' || a.Hora_Inicio) < datetime(NEW.Fecha || ' ' || NEW.Hora_Fin,
        CASE WHEN time(NEW.Hora_Fin) < time(NEW.Hora_Inicio) THEN '+1 day' ELSE '+0 day' END)
      AND datetime(NEW.Fecha || ' ' || NEW.Hora_Inicio) < datetime(a.Fecha || ' ' || a.Hora_Fin,
        CASE WHEN time(a.Hora_Fin) < time(a.Hora_Inicio) THEN '+1 day' ELSE '+0 day' END)
  );
END;

CREATE TRIGGER asig_validar_update BEFORE UPDATE ON Asignacion_Turnos
BEGIN
  SELECT RAISE(ABORT, 'horario_invalido') WHERE
    date(NEW.Fecha) IS NULL OR date(NEW.Fecha) <> NEW.Fecha OR
    (NEW.Hora_Inicio IS NULL) <> (NEW.Hora_Fin IS NULL) OR
    (NEW.Hora_Inicio IS NOT NULL AND (time(NEW.Hora_Inicio) IS NULL OR
      time(NEW.Hora_Fin) IS NULL OR time(NEW.Hora_Inicio) = time(NEW.Hora_Fin)));
  SELECT RAISE(ABORT, 'horario_solapado') WHERE NEW.Hora_Inicio IS NOT NULL AND EXISTS (
    SELECT 1 FROM Asignacion_Turnos a WHERE a.ID_Trabajador = NEW.ID_Trabajador
      AND a.ID_Asignacion <> NEW.ID_Asignacion AND a.Hora_Inicio IS NOT NULL
      AND datetime(a.Fecha || ' ' || a.Hora_Inicio) < datetime(NEW.Fecha || ' ' || NEW.Hora_Fin,
        CASE WHEN time(NEW.Hora_Fin) < time(NEW.Hora_Inicio) THEN '+1 day' ELSE '+0 day' END)
      AND datetime(NEW.Fecha || ' ' || NEW.Hora_Inicio) < datetime(a.Fecha || ' ' || a.Hora_Fin,
        CASE WHEN time(a.Hora_Fin) < time(a.Hora_Inicio) THEN '+1 day' ELSE '+0 day' END)
  );
END;
