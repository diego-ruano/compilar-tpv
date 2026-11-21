-- DO-SUBIDA: la subida completa de la Main a una nube que soporte le ha devuelto en modo main (una
-- base vacia, su copia de R2 o una vuelta a un instante). Es estado local del equipo: empieza por _,
-- se escribe siempre por raw(), no se replica ni sale en los volcados. En la nube existen vacias
-- (el esquema es uno); lo que la nube recuerda de la peticion va en su propia tabla
-- (_Subida_Completa, tenantHub.subida.ts). Sin DEFAULT de hora: la pone quien escribe.

-- La subida de esta Main: la peticion que atiende y por donde va.
CREATE TABLE _Sync_Subida (
  Id INTEGER PRIMARY KEY CHECK (Id = 1),
  Id_Subida TEXT NOT NULL,
  Origen TEXT NOT NULL,
  Estado TEXT NOT NULL CHECK (Estado IN ('subiendo', 'contrastando', 'terminada', 'abandonada')),
  -- El plan: NULL hasta que la nube lo contesta.
  Desde_Imprescindible TEXT,
  Desde_Reciente TEXT,
  Hasta_Seq_Plan INTEGER,
  -- El Seq del cambio vacio con que la nube abrio su log al volver (lo dice el plan; NULL si no lo
  -- dice, un worker anterior): lo numerado por debajo es de la base de antes.
  Inicio_Seq INTEGER,
  -- Este equipo, como lo nombra el log de la nube: lo suyo no frena sus borrados.
  Dispositivo TEXT,
  Vivos_Incompletos INTEGER NOT NULL DEFAULT 0,
  Empezada_Ms INTEGER NOT NULL,
  Nucleo_Hecho_Ms INTEGER,
  Fase1_Hecha_Ms INTEGER,
  Fin_Ms INTEGER,
  Terminada_Ms INTEGER,
  Pasadas_Contraste INTEGER NOT NULL DEFAULT 0,
  Ultimo_Error TEXT,
  -- Rechazos sin clasificar seguidos: la espera hasta el siguiente paso se dobla con cada uno, y
  -- vuelve a cero en cuanto un paso se confirma.
  Rechazos_Seguidos INTEGER NOT NULL DEFAULT 0
);

-- Lo que se sube, tabla a tabla y fase a fase, con su cursor. Turno ordena las etapas (lo vivo, el
-- nucleo, lo imprescindible, los sobrantes de los maestros, los ultimos dias y el historico); Orden,
-- las tablas dentro de una etapa (padres primero). Estado: 0 pendiente, 1 hecha, 2 fallida.
CREATE TABLE _Sync_Subida_Tablas (
  Tabla TEXT NOT NULL,
  Fase INTEGER NOT NULL CHECK (Fase IN (0, 1, 2, 3, 4)),
  Turno INTEGER NOT NULL,
  Orden INTEGER NOT NULL,
  Sql TEXT,
  Parametrizada INTEGER NOT NULL DEFAULT 0,
  Columnas_Json TEXT NOT NULL CHECK (json_valid(Columnas_Json)),
  Clave_Json TEXT NOT NULL CHECK (json_valid(Clave_Json)),
  Politica TEXT NOT NULL CHECK (Politica IN ('upsert', 'solo_insertar', 'monotono')),
  Por_Clave INTEGER NOT NULL DEFAULT 0,
  Claves_Fijadas INTEGER NOT NULL DEFAULT 0,
  Cursor_Json TEXT CHECK (Cursor_Json IS NULL OR json_valid(Cursor_Json)),
  Estado INTEGER NOT NULL DEFAULT 0 CHECK (Estado IN (0, 1, 2)),
  Filas_Leidas INTEGER NOT NULL DEFAULT 0,
  Filas_Escritas INTEGER NOT NULL DEFAULT 0,
  Total INTEGER NOT NULL DEFAULT 0,
  Intentos INTEGER NOT NULL DEFAULT 0,
  Ultimo_Error TEXT,
  PRIMARY KEY (Tabla, Fase)
);

-- Las claves fijadas al empezar una tabla en las fases que no recorren la tabla entera: las vivas
-- de la nube y las de la ventana de la recuperacion.
CREATE TABLE _Sync_Subida_Claves (
  Tabla TEXT NOT NULL,
  Fase INTEGER NOT NULL,
  Clave_Json TEXT NOT NULL,
  PRIMARY KEY (Tabla, Fase, Clave_Json)
) WITHOUT ROWID;

-- Lo que la nube no dejo entrar (un unico, una foranea, un CHECK, lo fiscal distinto), por su
-- clave y sin datos: el repaso lo vuelve a intentar y lo que quede lo ve el contraste. Turno: el
-- de la etapa tras la que toca volver a intentarlo (al cambiar de etapa).
CREATE TABLE _Sync_Subida_Por_Revisar (
  Tabla TEXT NOT NULL,
  Clave_Json TEXT NOT NULL,
  Motivo TEXT NOT NULL,
  Intentos INTEGER NOT NULL DEFAULT 0,
  Turno INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (Tabla, Clave_Json)
);

-- Lo que la nube tiene y este equipo no (lo vivo de la copia, los sobrantes de los maestros): se
-- junta aqui y se pide borrar por el outbox al acabar su etapa, hijas primero (Orden mas alto
-- antes), cada clave con el final del log que vio la nube al decirlo.
CREATE TABLE _Sync_Subida_Por_Borrar (
  Tabla TEXT NOT NULL,
  Clave_Json TEXT NOT NULL,
  Turno INTEGER NOT NULL,
  Orden INTEGER NOT NULL,
  Hasta_Seq INTEGER NOT NULL,
  PRIMARY KEY (Tabla, Clave_Json)
) WITHOUT ROWID;
