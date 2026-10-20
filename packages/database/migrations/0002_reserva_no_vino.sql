-- Reservas: a los cuantos minutos de su hora se marca "No vino" (NO_SHOW) una reserva a la que no
-- ha llegado nadie (sigue PROXIMA). 0 = nunca: se queda por llegar hasta que alguien la cierre o la
-- cancele. Lo aplica el job reservas_no_vino de la Main; se cambia en Configuracion -> Reservas.
ALTER TABLE Business_Settings ADD COLUMN Reserva_No_Vino_Min INTEGER NOT NULL DEFAULT 0
  CHECK (Reserva_No_Vino_Min >= 0 AND Reserva_No_Vino_Min <= 1440);
