-- RI-47: estado operativo local, escrito por raw(), sin réplica del destinatario.
CREATE TABLE _Cobros_Pendientes (
    ID_Pago TEXT PRIMARY KEY NOT NULL,
    Datos_Json TEXT NOT NULL CHECK (json_valid(Datos_Json))
);
