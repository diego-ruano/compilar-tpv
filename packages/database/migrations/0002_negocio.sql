-- AUD-06: el sello de la base. Dice de que negocio es esta base, para que solo se use con la
-- licencia de ese negocio: se compara al abrirla, al activar una licencia y al restaurar o importar
-- una copia (que es la base entera, asi que lo lleva dentro).
--
-- Estado local, escrito por raw(): no se replica. Sin fila, la base no esta sellada: es una recien
-- creada, o una anterior a esta migracion. La fila la escribe la activacion de la licencia, o la
-- reconstruccion desde la nube dentro de su transaccion.
CREATE TABLE IF NOT EXISTS _Negocio (
    Id INTEGER PRIMARY KEY CHECK (Id = 1),
    ID_Negocio TEXT NOT NULL CHECK (length(ID_Negocio) > 0)
);
