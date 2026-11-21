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
  Vivos_Incompletos INTEGER NOT NULL DEFAULT 0,
  Empezada_Ms INTEGER NOT NULL,
  Nucleo_Hecho_Ms INTEGER,
  Fase1_Hecha_Ms INTEGER,
  Fin_Ms INTEGER,
  Terminada_Ms INTEGER,
  Pasadas_Contraste INTEGER NOT NULL DEFAULT 0,
  Ultimo_Error TEXT
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
  Politica TEXT NOT NULL CHECK (Politica IN ('upsert', 'solo_insertar')),
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
-- clave y sin datos: el repaso lo vuelve a intentar y lo que quede lo ve el contraste.
CREATE TABLE _Sync_Subida_Por_Revisar (
  Tabla TEXT NOT NULL,
  Clave_Json TEXT NOT NULL,
  Motivo TEXT NOT NULL,
  Intentos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (Tabla, Clave_Json)
);
