/* =========================================================
   TPV SCHEMA — MIGRACION INICIAL (0001) · UNICA Y COMPARTIDA (app local + nube Turso)
   - La FUENTE UNICA DE VERDAD del esquema son los ficheros .sql de
     packages/database/migrations/, aplicados EN ORDEN. Hoy este es el UNICO:
     antes del lanzamiento se CONSOLIDARON aqui todas las incrementales
     (contact settings, email unico de cliente, movimientos de stock, intentos
     de login, comanda unica por mesa, stock suelto, notificaciones, traza del
     consumo suelto, stock negativo en lotes, IVA por producto, numero de ticket
     y registro de aperturas del cajon).
     No hay instalaciones en produccion, asi que arrancar de un esquema plano es
     mas simple de leer y de mantener que una cadena de parches historicos: un
     esquema se lee de arriba abajo, una cadena de ALTERs hay que ejecutarla
     mentalmente para saber como acaba una tabla.
     Los consumen los dos runners espejo:
       * App de escritorio (Rust): crates/tpv-infra-sqlite/src/migrations.rs los
         embebe con include_dir! y aplica lo pendiente en cada arranque.
       * Worker tpv-api: apps/cloud-worker-licensing/src/server/tenantMigrations.ts
         los registra y aplica igual sobre cada BD por-tenant (Turso).
     Cada BD lleva una tabla _migrations (name, hash, applied_at): una BD nueva se
     construye desde 0001 y una existente solo aplica lo que le falte.
   - REGLA DE ORO (vigente desde el lanzamiento): nunca edites una migracion ya
     publicada (rompe el hash → error duro `migration_altered` en ambos runners).
     Todo cambio va en una migracion NUEVA y aditiva: 0002, 0003, ...
   - Inventario con LOTES + FEFO.
   - Idempotencia/atomicidad: Applied_Operations (ver §10).
   - Toda `TEXT PRIMARY KEY` lleva NOT NULL (RI-65). En SQLite solo INTEGER PRIMARY KEY lo impide
     por si misma; una de texto admite NULL -y varios, porque en un indice unico los NULL son
     distintos-. Ya paso: un lote creado desde Proveedores nacia con ID_Lote NULL, invisible para
     el FEFO. Con NOT NULL ese INSERT falla en el acto en vez de dejar una fila sin clave.
   - No pasa nada si alguna tabla queda vacia en un lado u otro: es un
     unico esquema para ambos.

   EL DINERO ES UN ENTERO DE CENTIMOS (ARQ-01):
   - Toda columna de dinero es INTEGER y guarda CENTIMOS. Nunca REAL, nunca euros.
     Un f64 no representa 0,10 EUR, asi que cada suma arrastraba un error que el
     codigo tapaba con (x*100).round()/100 repetido en 35 sitios y tres lenguajes
     -con tres modos de redondeo distintos: Rust aleja del cero, JavaScript lleva
     la mitad hacia +infinito y ROUND() de SQLite hace lo suyo-. Con enteros, SUM
     es exacto y ASOCIATIVO: la Main y Turso obtienen el mismo numero sin importar
     el orden de las filas ni el motor, que es lo que permite dejar los agregados
     derivados dentro del SQL (Total_Comanda tiene dos escritores, la Main por el
     outbox y la Handy por el Durable Object, y solo converge si se re-deriva).
   - Las CANTIDADES siguen siendo REAL a proposito: 0,5 kg es fraccionario de
     verdad, y fijarle la precision seria una decision de producto que nadie pidio.
     Lo mismo los tipos de IVA (existe el 7,5 %) y los milimetros del ticket.
   - CONSECUENCIA AL ESCRIBIR SQL: Cantidad (REAL) * Precio_Unitario (centimos)
     vuelve a ser un FLOTANTE. Hay que devolverlo a entero antes de sumar:
       SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER))
     Sin el CAST(ROUND(...)) se suma en coma flotante otra vez, con el agravante de
     que parece entero. El ROUND de SQLite y el .round() de Rust rompen el empate
     igual (alejandose del cero); Math.round de JavaScript NO, y por eso esa cuenta
     no se hace nunca en TypeScript.
   - Una columna de dinero nueva: INTEGER, y su DEFAULT en centimos (5 EUR -> 500).

   IDENTIFICADORES (UUIDv7):
   - Todas las claves primarias de negocio son TEXT (UUIDv7 generado por el
     cliente: Rust en la Main, repo HTTP del Handy). Las claves foraneas son
     TEXT a juego. Esto hace que una fila tenga el MISMO id en todos los
     dispositivos y en la nube → no hay divergencia de ids al sincronizar.
   - Los seeds (Roles, Turnos, Alergenos) usan UUID FIJOS identicos en local y
     nube, para que sus ids coincidan siempre.
   - Excepciones que NO son ids de negocio y siguen siendo INTEGER:
     singletons de configuracion (Business_Settings / Ticket_Settings, ID=1)
     y la tabla interna Applied_Operations.

   HORAS (CFG-04):
   - Ninguna columna lleva DEFAULT de hora: la pone siempre quien inserta.
     Un DEFAULT con la hora actual lo evaluaria cada base por su cuenta, y
     en la nube eso es otro instante y en UTC. La fila de la Main y su copia
     en Turso tienen que decir la misma hora. Lo vigila un test de db.rs.
========================================================= */

-- NOTA: aqui NO va `PRAGMA foreign_keys = ON`. Seria un no-op: (1) es un ajuste
-- POR CONEXION que no persiste en el fichero, y (2) el runner aplica cada migracion
-- dentro de una transaccion, donde el PRAGMA se ignora. La aplicacion real de las FK
-- es responsabilidad de CADA runner de conexion, que lo fija al abrir la conexion:
--   * App local (Rust): `tune()` en crates/tpv-infra-sqlite/src/db.rs.
--   * Nube (worker):    `probeTenantDb()` en src/durableObjects/tenantHub.ts.

/* =========================================================
   1. Seguridad y Usuarios
========================================================= */
CREATE TABLE IF NOT EXISTS Roles (
  ID_Rol TEXT NOT NULL PRIMARY KEY,
  Nombre_Rol TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO Roles (ID_Rol, Nombre_Rol) VALUES
  ('00000000-0000-7000-8000-000000000001', 'Administrador'),
  ('00000000-0000-7000-8000-000000000002', 'Camarero'),
  ('00000000-0000-7000-8000-000000000003', 'Cocinero'),
  ('00000000-0000-7000-8000-000000000004', 'Limpieza');

CREATE TABLE IF NOT EXISTS Usuarios (
  ID_Usuario TEXT NOT NULL PRIMARY KEY,
  ID_Rol TEXT NOT NULL,
  Email TEXT NOT NULL UNIQUE,
  Password_Hash TEXT NOT NULL,
  Nombre TEXT NOT NULL,
  Apellido TEXT,
  Estado TEXT DEFAULT 'Activo',
  Requiere_Setup INTEGER DEFAULT 0,
  FOREIGN KEY (ID_Rol) REFERENCES Roles(ID_Rol)
);

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
  ID_Usuario TEXT NOT NULL PRIMARY KEY,
  Intentos_Fallidos INTEGER NOT NULL DEFAULT 0,
  Bloqueado_Hasta_Ms INTEGER NOT NULL DEFAULT 0,
  Ultimo_Intento_Ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE CASCADE
);

/* =========================================================
   2. Personal y Horarios
========================================================= */
CREATE TABLE IF NOT EXISTS Trabajadores (
  ID_Trabajador TEXT NOT NULL PRIMARY KEY,
  ID_Usuario TEXT UNIQUE NOT NULL,
  DNI TEXT UNIQUE,
  Telefono TEXT,
  Puesto TEXT,
  IBAN TEXT,
  Numero_Seguridad_Social TEXT UNIQUE,
  Fecha_Inicio_Contrato DATE,
  Fecha_Fin_Contrato DATE,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

CREATE TABLE IF NOT EXISTS Turnos (
  ID_Turno TEXT NOT NULL PRIMARY KEY,
  Nombre_Turno TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS Asignacion_Turnos (
  ID_Asignacion TEXT NOT NULL PRIMARY KEY,
  ID_Trabajador TEXT NOT NULL,
  Fecha DATE NOT NULL,
  ID_Turno TEXT NOT NULL,
  Area TEXT NOT NULL,
  Hora_Inicio TIME,
  Hora_Fin TIME,
  Notas TEXT,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador),
  FOREIGN KEY (ID_Turno) REFERENCES Turnos(ID_Turno)
);

CREATE INDEX IF NOT EXISTS idx_asig_fecha ON Asignacion_Turnos(Fecha);
CREATE INDEX IF NOT EXISTS idx_asig_trab_fecha ON Asignacion_Turnos(ID_Trabajador, Fecha);

INSERT OR IGNORE INTO Turnos (ID_Turno, Nombre_Turno) VALUES
  ('00000000-0000-7000-8000-000000000101', 'LIBRE'),
  ('00000000-0000-7000-8000-000000000102', 'PARTIDO'),
  ('00000000-0000-7000-8000-000000000103', 'MAÑANA'),
  ('00000000-0000-7000-8000-000000000104', 'TARDE'),
  ('00000000-0000-7000-8000-000000000105', 'NOCHE');

CREATE TABLE IF NOT EXISTS Horario_Predeterminado (
  ID_Default TEXT NOT NULL PRIMARY KEY,
  ID_Trabajador TEXT NOT NULL,
  Weekday INTEGER NOT NULL,
  Orden INTEGER NOT NULL DEFAULT 1,
  ID_Turno TEXT NOT NULL,
  Area TEXT NOT NULL,
  Hora_Inicio TIME,
  Hora_Fin TIME,
  Notas TEXT,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE CASCADE,
  FOREIGN KEY (ID_Turno) REFERENCES Turnos(ID_Turno),
  UNIQUE (ID_Trabajador, Weekday, Orden)
);

/* =========================================================
   3. Inventario y Productos
========================================================= */
CREATE TABLE IF NOT EXISTS Categorias_Producto (
  ID_Categoria TEXT NOT NULL PRIMARY KEY,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Vendible INTEGER NOT NULL DEFAULT 1,
  Pasa_Cocina INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Proveedores (
  ID_Proveedor TEXT NOT NULL PRIMARY KEY,
  Nombre_Empresa TEXT NOT NULL,
  Contacto TEXT,
  Telefono TEXT,
  Email TEXT UNIQUE,
  CIF TEXT UNIQUE,
  Informacion_adicional TEXT,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT
);

CREATE TABLE IF NOT EXISTS Productos (
  ID_Producto TEXT NOT NULL PRIMARY KEY,
  ID_Categoria TEXT NOT NULL,
  ID_Proveedor TEXT,
  Nombre TEXT NOT NULL UNIQUE,
  Precio_Venta INTEGER,
  Stock_Minimo REAL DEFAULT 0,
  Unidad_Medida TEXT,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Cantidad_Pedido_Esperada REAL,
  -- VR-04: stock "suelto" fuera de lotes. Contador simple por producto, OPCIONAL (NULL = el producto
  -- no usa stock suelto y se vende sin descontar de aqui). A diferencia de los lotes (que nunca bajan
  -- de 0), este contador SI puede quedar negativo: es la senal honesta de sobreventa. El stock total
  -- mostrado de un producto es SUM(lotes) + COALESCE(Stock_Suelto, 0).
  Stock_Suelto REAL,
  -- Tipo de IVA propio del producto. NULL = "hereda el del negocio"
  -- (Business_Settings.IVA_Percent), que es el caso de casi todo: en hosteleria el consumo en el
  -- establecimiento va al tipo reducido, bebida incluida. Deja de valer en cuanto se vende algo
  -- para llevar envasado, tabaco o merchandising, que tributan a otro tipo.
  -- Es nullable a proposito y no DEFAULT 10: "no decidido" y "decidido que sea 10" son cosas
  -- distintas. Un producto que nadie ha tocado tiene que SEGUIR al tipo general si este cambia;
  -- un 10 escrito en la fila se quedaria congelado sin que nadie lo pidiera.
  IVA_Percent REAL,
  -- FISCAL-01 (Veri*factu). "Exento" NO es "IVA al 0 %": son dos afirmaciones legales distintas y
  -- el registro de facturacion las expresa en un <choice> del XSD (CalificacionOperacion vs
  -- OperacionExenta), asi que no hay forma de representar una con la otra.
  --   Exento = 0 -> operacion sujeta y no exenta: va con CalificacionOperacion 'S1' + TipoImpositivo
  --                 + CuotaRepercutida (un producto al 0 % es ESTO, con tipo y cuota a cero).
  --   Exento = 1 -> va con OperacionExenta = Causa_Exencion, y esta PROHIBIDO informar
  --                 TipoImpositivo, CuotaRepercutida, TipoRecargoEquivalencia ni
  --                 CuotaRecargoEquivalencia (error 1238 de la AEAT).
  -- Un booleano solo no basta: OperacionExenta exige CUAL exencion, no un "si". De ahi las dos
  -- columnas. 'E1' (art. 20 LIVA, operaciones interiores) es la unica realista en hosteleria.
  Exento INTEGER NOT NULL DEFAULT 0,
  Causa_Exencion TEXT,
  FOREIGN KEY (ID_Categoria) REFERENCES Categorias_Producto(ID_Categoria),
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor),
  CHECK (Exento IN (0,1)),
  CHECK (Causa_Exencion IS NULL OR Causa_Exencion IN ('E1','E2','E3','E4','E5','E6')),
  CHECK ((Exento = 1) = (Causa_Exencion IS NOT NULL))
);

-- La rejilla de productos filtra por categoria; ambos son FKs muy consultadas.
CREATE INDEX IF NOT EXISTS idx_productos_categoria
ON Productos(ID_Categoria);

CREATE INDEX IF NOT EXISTS idx_productos_proveedor
ON Productos(ID_Proveedor);

-- Un lote tiene UNA cantidad: Stock_Disponible, la que queda. No hay 'inicial' aparte porque
-- nadie la usaba para nada salvo para prohibir subir el disponible por encima de ella, o sea
-- para convertir en un error corregir al alza justo lo que se acababa de contar.
CREATE TABLE IF NOT EXISTS Lotes_Producto (
  ID_Lote TEXT NOT NULL PRIMARY KEY,
  ID_Producto TEXT NOT NULL,
  Codigo_Lote TEXT NOT NULL,
  Fecha_Entrada DATETIME NOT NULL,
  Caducidad DATE,
  Stock_Disponible REAL NOT NULL DEFAULT 0,
  Coste_Unitario INTEGER,
  ID_Proveedor TEXT,
  Notas TEXT,
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE CASCADE,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor),
  UNIQUE (ID_Producto, Codigo_Lote)
);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_cad
ON Lotes_Producto(ID_Producto, Caducidad);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_entrada
ON Lotes_Producto(ID_Producto, Fecha_Entrada);

-- Auditoria de movimientos de stock (INV-01b). Cada cambio manual de Stock_Disponible de un lote
-- (alta y ajuste) deja una fila trazable en vez de sobrescribir el valor a pelo sin rastro. Base
-- para la reconciliacion (INV-06): Stock_Disponible == SUM(movimientos) - SUM(consumo).
--
-- Tipo: 'ALTA' (creacion del lote) | 'AJUSTE' (correccion manual del disponible).
-- Delta: variacion aplicada a Stock_Disponible (+entrada / -salida).
-- Stock_Resultante: disponible tras el movimiento (snapshot para reconciliar sin recomputar).
-- Motivo: texto libre (las Notas del alta/ajuste).
-- ID_Usuario: quien lo hizo (NULLABLE: no siempre disponible en la capa de comando todavia).
-- Fecha: instante local; el outbox/tenantHub lo congela a literal antes de replicar.
CREATE TABLE IF NOT EXISTS Movimientos_Stock (
  ID_Movimiento TEXT NOT NULL PRIMARY KEY,
  ID_Lote TEXT NOT NULL,
  Tipo TEXT NOT NULL,
  Delta REAL NOT NULL,
  Stock_Resultante REAL NOT NULL,
  Motivo TEXT,
  ID_Usuario TEXT,
  Fecha DATETIME NOT NULL,
  FOREIGN KEY (ID_Lote) REFERENCES Lotes_Producto(ID_Lote) ON DELETE CASCADE,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  CHECK (Tipo IN ('ALTA', 'AJUSTE'))
);

CREATE INDEX IF NOT EXISTS idx_mov_stock_lote
ON Movimientos_Stock(ID_Lote);

CREATE INDEX IF NOT EXISTS idx_mov_stock_fecha
ON Movimientos_Stock(Fecha);

CREATE TABLE IF NOT EXISTS Pedidos_Proveedor (
  ID_Pedido TEXT NOT NULL PRIMARY KEY,
  ID_Proveedor TEXT,
  Email_Destino TEXT,
  Estado TEXT NOT NULL DEFAULT 'borrador',
  Fecha_Creacion TEXT NOT NULL,
  Fecha_Envio TEXT,
  Notas TEXT,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor) ON DELETE SET NULL,
  CHECK (Estado IN ('borrador', 'enviado', 'cancelado'))
);

CREATE TABLE IF NOT EXISTS Lineas_Pedido_Proveedor (
  ID_Linea TEXT NOT NULL PRIMARY KEY,
  ID_Pedido TEXT NOT NULL,
  Nombre_Producto TEXT NOT NULL,
  Cantidad REAL NOT NULL DEFAULT 1,
  Precio_Unitario INTEGER,
  Unidad TEXT,
  FOREIGN KEY (ID_Pedido) REFERENCES Pedidos_Proveedor(ID_Pedido) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pedidos_prov_proveedor
ON Pedidos_Proveedor(ID_Proveedor);

CREATE INDEX IF NOT EXISTS idx_lineas_pedido_prov_pedido
ON Lineas_Pedido_Proveedor(ID_Pedido);

/* =========================================================
   4. Alérgenos
========================================================= */
CREATE TABLE IF NOT EXISTS Alergenos (
  ID_Alergeno TEXT NOT NULL PRIMARY KEY,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT
);

CREATE TABLE IF NOT EXISTS Producto_Alergenos (
  ID_Producto TEXT NOT NULL,
  ID_Alergeno TEXT NOT NULL,
  PRIMARY KEY (ID_Producto, ID_Alergeno),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE CASCADE,
  FOREIGN KEY (ID_Alergeno) REFERENCES Alergenos(ID_Alergeno) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prod_alerg_alerg
ON Producto_Alergenos(ID_Alergeno);

/* =========================================================
   5. Zonas / Mesas / Clientes / Reservas
========================================================= */
CREATE TABLE IF NOT EXISTS Zonas (
  ID_Zona TEXT NOT NULL PRIMARY KEY,
  Nombre_Zona TEXT NOT NULL UNIQUE,
  Room_Points TEXT NOT NULL DEFAULT '[]',
  Updated_At DATETIME
);

CREATE TABLE IF NOT EXISTS Mesas (
  ID_Mesa TEXT NOT NULL PRIMARY KEY,
  ID_Zona TEXT NOT NULL,
  Numero_Mesa TEXT NOT NULL,
  Capacidad INTEGER NOT NULL,
  Ubicacion_X INTEGER NOT NULL,
  Ubicacion_Y INTEGER NOT NULL,
  Shape TEXT NOT NULL,
  Width INTEGER NOT NULL,
  Height INTEGER NOT NULL,
  Radius INTEGER,
  Updated_At DATETIME,
  UNIQUE (ID_Zona, Numero_Mesa),
  FOREIGN KEY (ID_Zona) REFERENCES Zonas(ID_Zona) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Clientes (
  ID_Cliente TEXT NOT NULL PRIMARY KEY,
  Nombre TEXT NOT NULL,
  Telefono TEXT,
  Email TEXT,
  Notas TEXT,
  Total_Gastado INTEGER NOT NULL DEFAULT 0,
  Created_At TEXT,
  -- FISCAL-02: datos para emitir una factura COMPLETA (F1/F3) a este cliente. Son opcionales: la
  -- inmensa mayoria de los clientes de un bar no piden factura y nunca los tendran.
  --   NIF + Razon_Social -> van al REGISTRO de facturacion (bloque Destinatarios).
  --   Direccion_Fiscal   -> solo al PAPEL (art. 6 ROF exige el domicilio del destinatario en la
  --                         factura, pero el registro de la AEAT no lo lleva).
  -- Existen para que la comida de empresa que se repite cada mes no dicte el NIF doce veces.
  NIF TEXT,
  Razon_Social TEXT,
  Direccion_Fiscal TEXT
);

-- CLI-01: el email de cliente identifica de forma unica cuando existe. Indice UNICO PARCIAL sobre
-- lower(Email): case-insensitive, y solo aplica a los que tienen email (NULL/'' no colisionan, que
-- es el caso mayoritario: un cliente puede no tener email).
CREATE UNIQUE INDEX IF NOT EXISTS ux_clientes_email
ON Clientes(lower(Email))
WHERE Email IS NOT NULL AND Email <> '';

-- Reservas.ID_Cliente es NULLABLE a propósito: una reserva puede existir sin cliente
-- asignado. El gasto solo se atribuye/revierte cuando hay cliente real
-- (comanda -> reserva -> cliente); si es NULL, no se acredita a nadie. La FK sigue
-- vigente pero no enforce sobre NULL.
-- ID_Mesa es NULL-able a proposito: se puede apuntar una reserva sin decidir todavia en que
-- mesa se sienta. Una reserva sin mesa no sale en el plano (la meta filtra ID_Mesa IS NOT NULL)
-- ni puede chocar con otra por el hueco: no ocupa nada hasta que se le asigna una.
CREATE TABLE IF NOT EXISTS Reservas (
  ID_Reserva TEXT NOT NULL PRIMARY KEY,
  ID_Cliente TEXT,
  ID_Mesa TEXT,
  Dia_YMD TEXT NOT NULL,
  Hora TEXT NOT NULL,
  Turno TEXT NOT NULL,
  Comensales INTEGER NOT NULL DEFAULT 1,
  Nota TEXT,
  Estado TEXT NOT NULL DEFAULT 'ACTIVA',
  Created_At TEXT,
  FOREIGN KEY (ID_Cliente) REFERENCES Clientes(ID_Cliente),
  FOREIGN KEY (ID_Mesa) REFERENCES Mesas(ID_Mesa)
);

CREATE INDEX IF NOT EXISTS idx_reservas_mesa_dia_hora
ON Reservas(ID_Mesa, Dia_YMD, Hora);

CREATE INDEX IF NOT EXISTS idx_reservas_cliente
ON Reservas(ID_Cliente);

/* =========================================================
   6. Comandas / Detalles / Cuentas
========================================================= */
-- Una comanda es un TICKET. Su origen lo define `Canal`:
--   'MESA'  -> consumo en sala; SIEMPRE lleva ID_Mesa.
--   'BARRA' -> venta rapida; NUNCA lleva mesa (ID_Mesa IS NULL).
-- Antes la venta rapida se anclaba a una mesa "de sistema" (BARRA) sembrada en el seed, lo que
-- obligaba a inventarse una zona y una mesa fantasma que el usuario veia y no podia borrar, y ademas
-- chocaba con el invariante "una comanda abierta por mesa" (todos los tickets de barra compartian
-- mesa → el segundo ticket abierto violaba el indice unico). Modelando el canal explicitamente:
--   * desaparecen la mesa y la zona fantasma (ya no se siembran),
--   * los tickets sin mesa no compiten entre si (ver el indice unico de abajo),
--   * anadir canales futuros ('LLEVAR', 'DELIVERY'...) no obliga a tocar indices ni seeds.
--
-- El CHECK de coherencia hace el modelo autoconsistente: es imposible insertar una comanda de mesa
-- sin mesa, o una de barra con mesa, aunque una ruta futura se despiste.
--
-- CHECK de `Estado`: es la clave del indice unico de mas abajo. Si se colase un valor con otra
-- capitalizacion ('abierta'), el indice parcial dejaria de aplicar EN SILENCIO; el CHECK lo impide.
--
-- (Los comentarios van FUERA del CREATE TABLE a proposito: el snapshot anti-drift colapsa cada
--  sentencia a una linea, y un `--` dentro se comeria el resto de la linea.)
CREATE TABLE IF NOT EXISTS Comandas (
  ID_Comanda TEXT NOT NULL PRIMARY KEY,
  ID_Mesa TEXT NULL,
  ID_Reserva TEXT NULL,
  ID_Trabajador TEXT NULL,
  Canal TEXT NOT NULL DEFAULT 'MESA',
  Fecha_Hora_Apertura TEXT NOT NULL,
  Fecha_Hora_Cierre TEXT NULL,
  Total_Comanda INTEGER NOT NULL DEFAULT 0,
  Estado TEXT NOT NULL DEFAULT 'Abierta',
  FOREIGN KEY (ID_Mesa) REFERENCES Mesas(ID_Mesa),
  FOREIGN KEY (ID_Reserva) REFERENCES Reservas(ID_Reserva),
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL,
  CHECK (Canal IN ('MESA', 'BARRA')),
  CHECK (Estado IN ('Abierta', 'Pagada')),
  CHECK ((Canal = 'MESA') = (ID_Mesa IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_comandas_mesa_estado
ON Comandas(ID_Mesa, Estado);

-- MESA-03: como mucho UNA comanda 'Abierta' por mesa. Evita que dos aperturas concurrentes de la
-- misma mesa (doble toque, o Main + Handy a la vez) dejen dos comandas abiertas repartiendo lineas.
-- La capa de aplicacion ya hace la apertura idempotente; esto es la RED DE SEGURIDAD del esquema.
--
-- Los tickets de barra NO se ven afectados aunque no se excluyan explicitamente: en SQLite los NULL
-- se consideran DISTINTOS entre si en un indice UNIQUE, y las comandas de barra tienen ID_Mesa NULL.
-- Es decir, el invariante dice exactamente lo que debe decir: "una comanda abierta por mesa real;
-- tickets sin mesa, los que hagan falta".
CREATE UNIQUE INDEX IF NOT EXISTS idx_comandas_una_abierta_por_mesa
ON Comandas(ID_Mesa) WHERE Estado = 'Abierta';

-- Listado de tickets de venta rapida (y, en general, filtrar por canal en estadisticas).
CREATE INDEX IF NOT EXISTS idx_comandas_canal_estado
ON Comandas(Canal, Estado);

CREATE INDEX IF NOT EXISTS idx_comandas_reserva
ON Comandas(ID_Reserva);

CREATE INDEX IF NOT EXISTS idx_comandas_trab_apertura
ON Comandas(ID_Trabajador, Fecha_Hora_Apertura);

-- Cantidad y Precio_Unitario: la POSITIVIDAD (Cantidad > 0, Precio_Unitario >= 0) se valida en la
-- CAPA DE APLICACION (use_cases de Rust + esquemas zod del worker), NO con CHECK: SQLite no permite
-- anadir un CHECK a una tabla ya existente via ALTER, y el runner envuelve cada migracion en una
-- transaccion (recrear la tabla seria arriesgado en tablas tan referenciadas). Ver DB-06.
-- La linea de comanda es un SNAPSHOT de la venta, no un puntero al catalogo de hoy: Nombre_Producto,
-- Precio_Unitario e IVA_Percent se copian del producto al vender. Sin eso, reimprimir un ticket del
-- ano pasado lo sacaria con el nombre, el precio y el tipo de hoy, que es justo lo que una
-- reimpresion no puede hacer.
--
-- Y es lo que permite que el catalogo BORRE (INV-05): ID_Producto es nullable y su FK es ON DELETE
-- SET NULL, asi que quitar un producto que ya no se vende deja la venta intacta -con su nombre, su
-- precio y su tipo- y solo pierde el enlace a una ficha que ya no existe. Sin el snapshot, esa misma
-- FK dejaria las lineas historicas sin nombre.
CREATE TABLE IF NOT EXISTS Detalle_Comanda (
  ID_Detalle TEXT NOT NULL PRIMARY KEY,
  ID_Comanda TEXT NOT NULL,
  ID_Producto TEXT,
  Nombre_Producto TEXT,
  Cantidad REAL NOT NULL,
  Precio_Unitario INTEGER NOT NULL,
  IVA_Percent REAL,
  Notas TEXT,
  Estado_Cocina TEXT DEFAULT 'PENDIENTE',
  Fecha_Hora_Cocina DATETIME,
  ID_Usuario_Cocinero TEXT,
  -- FISCAL-01: la exencion se CONGELA en la linea igual que el nombre, el precio y el tipo, y por
  -- el mismo motivo: el registro de facturacion es el hecho fiscal del dia de la venta. Si manana
  -- alguien desmarca la casilla del producto, el registro ya emitido no puede cambiar de sentido.
  Exento INTEGER NOT NULL DEFAULT 0,
  Causa_Exencion TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE SET NULL,
  CHECK (Exento IN (0,1)),
  CHECK (Causa_Exencion IS NULL OR Causa_Exencion IN ('E1','E2','E3','E4','E5','E6')),
  CHECK ((Exento = 1) = (Causa_Exencion IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_dc_cocinero_fecha
ON Detalle_Comanda(ID_Usuario_Cocinero, Fecha_Hora_Cocina);

CREATE INDEX IF NOT EXISTS idx_dc_estado_fecha
ON Detalle_Comanda(Estado_Cocina, Fecha_Hora_Cocina);

-- Ruta mas caliente del POS: "dame las lineas de esta comanda"
-- (SELECT ... FROM Detalle_Comanda WHERE ID_Comanda = ?). Sin este indice era un
-- full scan de toda la tabla de lineas en cada apertura/refresco/cobro/ticket.
CREATE INDEX IF NOT EXISTS idx_dc_comanda
ON Detalle_Comanda(ID_Comanda);

-- FK a Productos: acelera joins/comprobaciones de integridad por producto.
CREATE INDEX IF NOT EXISTS idx_dc_producto
ON Detalle_Comanda(ID_Producto);

CREATE TABLE IF NOT EXISTS Lote_Consumos (
  ID_Detalle TEXT NOT NULL,
  ID_Lote TEXT NOT NULL,
  -- STOCK-01: el COBRO que hizo este consumo. Una linea cobrada, anulada y vuelta a cobrar deja un
  -- consumo por cobro, y de lotes distintos si el primero se agoto entre medias. Sin saber de que
  -- cobro es cada uno, anular el segundo devolvia tambien lo del primero, que ya habia vuelto a su
  -- lote: stock fantasma. Anular devuelve SOLO lo de su cobro. Se inserta DESPUES del pago: la FK
  -- se comprueba sentencia a sentencia, tambien al replicarla en la nube.
  ID_Pago TEXT NOT NULL,
  Cantidad REAL NOT NULL,
  PRIMARY KEY (ID_Detalle, ID_Lote, ID_Pago),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE,
  FOREIGN KEY (ID_Lote) REFERENCES Lotes_Producto(ID_Lote),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago) ON DELETE CASCADE,
  CHECK (Cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_lote_consumos_pago
ON Lote_Consumos(ID_Pago);

CREATE INDEX IF NOT EXISTS idx_lote_consumos_lote
ON Lote_Consumos(ID_Lote);

-- Espejo de Lote_Consumos para el stock que no esta en lotes (VR-04). Una venta consume primero de
-- los lotes (FEFO) y lo que estos no cubren se descuenta de Productos.Stock_Suelto; sin esta traza,
-- anular un pago devolvia lo de los lotes y perdia PARA SIEMPRE la parte suelta, porque no habia de
-- donde reconstruirla. Y como ese contador puede quedar negativo a proposito (senal de sobreventa),
-- la perdida ni siquiera se distinguia de una sobreventa legitima.
--
-- Es tambien la otra mitad del invariante de reconciliacion (INV-06): el stock de un producto es
-- SUM(lotes) + Stock_Suelto.
-- ID_Producto va SIN FK a proposito: forma parte de la clave primaria, asi que no puede quedarse a
-- NULL cuando se borra el producto (INV-05), y borrar la fila tampoco vale, porque es el rastro de
-- un consumo que ocurrio. Se queda como valor suelto, igual que Lineas_Pedido_Proveedor guarda el
-- nombre del producto y no su id.
CREATE TABLE IF NOT EXISTS Suelto_Consumos (
  ID_Detalle  TEXT NOT NULL,
  ID_Producto TEXT NOT NULL,
  -- STOCK-01: el cobro que hizo este consumo, por lo mismo que en Lote_Consumos.
  ID_Pago     TEXT NOT NULL,
  Cantidad    REAL NOT NULL,
  PRIMARY KEY (ID_Detalle, ID_Producto, ID_Pago),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE,
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago) ON DELETE CASCADE,
  CHECK (Cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_suelto_consumos_pago
ON Suelto_Consumos(ID_Pago);

CREATE INDEX IF NOT EXISTS idx_suelto_consumos_producto
ON Suelto_Consumos(ID_Producto);

-- (La tabla Facturas se retiro: nunca se escribia; el cobro vive integramente en Pagos +
--  Pago_Detalles, que es la fuente de verdad. Ver DB-13. Si algun dia hace falta facturacion
--  fiscal, se re-anade en una migracion nueva.)

-- Importe >= 0: validado en la capa de aplicacion (ver nota en Detalle_Comanda, DB-06).
--
-- Pagado_Con_Caja (CAJA-01): el dinero salio del cajon. Solo esos gastos restan del esperado del
-- arqueo; una factura pagada por banco no ha tocado el cajon, y restarla haria "sobrar" ese dinero.
CREATE TABLE IF NOT EXISTS Cuentas_Gastos (
  ID_Gasto TEXT NOT NULL PRIMARY KEY,
  Fecha DATE NOT NULL,
  Concepto TEXT NOT NULL,
  Importe INTEGER NOT NULL,
  Tipo_Gasto TEXT NOT NULL,
  ID_Proveedor TEXT NULL,
  Pagado_Con_Caja INTEGER NOT NULL DEFAULT 0,
  CHECK (Pagado_Con_Caja IN (0, 1)),
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cuentas_gastos_fecha
ON Cuentas_Gastos(Fecha);

CREATE INDEX IF NOT EXISTS idx_cuentas_gastos_proveedor
ON Cuentas_Gastos(ID_Proveedor);

-- Cierre de caja (arqueo). CUENTA-06.
--
-- Un cierre es el corte del periodo: va del cierre ANTERIOR a este, sin fechas de por medio. Lo
-- dispara un boton, no un reloj, porque el calendario no sabe partir la jornada de un bar -una cena
-- de 23:30 a 01:30 es un servicio, no dos dias- y porque un cierre automatico se inventaria el
-- recuento: tendria el esperado, pero nadie habria contado el cajon.
--
-- Los importes se GUARDAN, no se derivan al leer. Un arqueo es la foto de lo que se vio esa noche.
-- Si despues se corrige un apunte de su periodo (CAJA-01), la foto NO se toca: lo que el cierre
-- marca hoy va en las columnas Rect_*, y cada correccion deja su fila en Cierre_Rectificaciones.
-- Asi el cierre sigue explicando por que faltaban 20 euros esa noche, y ademas dice cuanto marca hoy.
--
-- Lo que se DEJA en el cajon es el Fondo_Inicial del cierre siguiente: asi se encadenan los
-- periodos sin que nadie tenga que declarar dos veces el mismo numero. Y como lo dejado es dinero
-- contado a mano, rectificar un cierre no mueve a los siguientes.
CREATE TABLE IF NOT EXISTS Cierres_Caja (
  ID_Cierre TEXT NOT NULL PRIMARY KEY,
  Fecha_Hora DATETIME NOT NULL,
  ID_Usuario TEXT,
  Fondo_Inicial INTEGER NOT NULL DEFAULT 0,
  Ventas_Efectivo INTEGER NOT NULL DEFAULT 0,
  Esperado INTEGER NOT NULL DEFAULT 0,
  Contado INTEGER NOT NULL DEFAULT 0,
  Descuadre INTEGER NOT NULL DEFAULT 0,
  Dejado INTEGER NOT NULL DEFAULT 0,
  Retirado INTEGER NOT NULL DEFAULT 0,
  Motivo TEXT,
  Reabierto_En DATETIME,
  Reabierto_Por TEXT,
  -- Desde cuando cuenta (exclusivo): la Fecha_Hora del cierre anterior; NULL en el primero. Es lo
  -- que dice a que cierre pertenece un apunte que se corrige despues.
  Periodo_Desde DATETIME,
  -- Gastos pagados con dinero del cajon durante el periodo. Restan del esperado.
  Gastos_Caja INTEGER NOT NULL DEFAULT 0,
  -- Lo que el cierre marca HOY tras corregir apuntes de su periodo. NULL = nunca se ha rectificado.
  Rect_Ventas_Efectivo INTEGER,
  Rect_Gastos_Caja INTEGER,
  Rect_Esperado INTEGER,
  Rect_Descuadre INTEGER,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  FOREIGN KEY (Reabierto_Por) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL
);

-- "Cual es el ultimo cierre" se pregunta al abrir la pantalla y al preparar cada cierre, asi que es
-- la consulta caliente de esta tabla.
CREATE INDEX IF NOT EXISTS idx_cierres_fecha
ON Cierres_Caja(Fecha_Hora DESC);

-- Cada correccion de un apunte que cambio los numeros de un cierre ya hecho (CAJA-01): que se toco,
-- quien, cuando y por que, con el esperado y el descuadre de antes y de despues. Es el rastro de las
-- columnas Rect_* de Cierres_Caja: sin el, un cierre rectificado diria cuanto marca pero no por que.
CREATE TABLE IF NOT EXISTS Cierre_Rectificaciones (
  ID_Rectificacion TEXT NOT NULL PRIMARY KEY,
  ID_Cierre TEXT NOT NULL,
  Fecha_Hora DATETIME NOT NULL,
  ID_Usuario TEXT,
  Descripcion TEXT NOT NULL,
  Motivo TEXT,
  Esperado_Antes INTEGER NOT NULL,
  Esperado_Despues INTEGER NOT NULL,
  Descuadre_Antes INTEGER NOT NULL,
  Descuadre_Despues INTEGER NOT NULL,
  FOREIGN KEY (ID_Cierre) REFERENCES Cierres_Caja(ID_Cierre) ON DELETE CASCADE,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cierre_rectificaciones_cierre
ON Cierre_Rectificaciones(ID_Cierre, Fecha_Hora);

-- El recuento por monedas y billetes, del dinero contado y del que se deja. Sin esto un descuadre
-- pasado solo dice cuanto falto: "faltan 50" y "falta un billete de 50" no se investigan igual.
CREATE TABLE IF NOT EXISTS Cierre_Denominaciones (
  ID_Cierre TEXT NOT NULL,
  Momento TEXT NOT NULL,
  Valor INTEGER NOT NULL,
  Unidades INTEGER NOT NULL,
  PRIMARY KEY (ID_Cierre, Momento, Valor),
  CHECK (Momento IN ('CONTADO','DEJADO')),
  FOREIGN KEY (ID_Cierre) REFERENCES Cierres_Caja(ID_Cierre) ON DELETE CASCADE
);

/* =========================================================
   7. Tareas
========================================================= */
CREATE TABLE IF NOT EXISTS Tareas (
  ID_Tarea TEXT NOT NULL PRIMARY KEY,
  Titulo TEXT NOT NULL,
  Descripcion TEXT,
  Fecha_Creacion DATETIME NOT NULL,
  Fecha_Limite DATE,
  Estado TEXT NOT NULL DEFAULT 'ABIERTA'
);

CREATE TABLE IF NOT EXISTS Tarea_Asignaciones (
  ID_Tarea TEXT NOT NULL,
  ID_Trabajador TEXT NOT NULL,
  Asignada_At DATETIME NOT NULL,
  Estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  Finalizada_At DATETIME,
  PRIMARY KEY (ID_Tarea, ID_Trabajador),
  FOREIGN KEY (ID_Tarea) REFERENCES Tareas(ID_Tarea) ON DELETE CASCADE,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tarea_asig_trab
ON Tarea_Asignaciones(ID_Trabajador, Estado);

/* =========================================================
   8. Fichajes
========================================================= */
CREATE TABLE IF NOT EXISTS Fichajes (
  ID_Fichaje TEXT NOT NULL PRIMARY KEY,
  ID_Usuario TEXT NOT NULL,
  Fecha DATE NOT NULL,
  Parte INTEGER NOT NULL DEFAULT 1,
  Hora_Entrada DATETIME,
  Hora_Salida DATETIME,
  Estado TEXT DEFAULT 'ABIERTO',
  Cerrado_Automatico INTEGER DEFAULT 0,
  Cierre_Motivo TEXT,
  Incidencia TEXT,
  UNIQUE(ID_Usuario, Fecha, Parte),
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

CREATE INDEX IF NOT EXISTS idx_fichajes_user_abierto
ON Fichajes(ID_Usuario, Estado);

CREATE TABLE IF NOT EXISTS Fichaje_Dia (
  ID_Usuario TEXT NOT NULL,
  Fecha DATE NOT NULL,
  Turno_Partido INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ID_Usuario, Fecha),
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

/* =========================================================
   9. Pagos
========================================================= */
-- Importe_Total >= 0: validado en la capa de aplicacion (ver nota en Detalle_Comanda, DB-06).
-- Estado: un cobro anulado NO se borra (CUENTA-07). Borrarlo bajaba el esperado del arqueo
-- exactamente lo mismo que faltaba en el cajon, asi que la sisa mas comun del sector salia con
-- descuadre cero: los numeros eran correctos y no habia nada contra lo que compararlos.
-- Anulado_En/Anulado_Por son obligatorios cuando el pago esta anulado, y prohibidos cuando no:
-- una anulacion sin firma no es una auditoria. Motivo_Anulacion NO entra en el CHECK a proposito
-- (obligarlo por esquema convertiria un olvido en un error de base de datos, que no se puede
-- explicar); lo exige el caso de uso, que si puede dar un mensaje decente.
CREATE TABLE IF NOT EXISTS Pagos (
  ID_Pago TEXT NOT NULL PRIMARY KEY,
  ID_Comanda TEXT NOT NULL,
  Fecha_Hora DATETIME NOT NULL,
  Metodo_Pago TEXT NOT NULL,
  Importe_Total INTEGER NOT NULL,
  Tipo TEXT NOT NULL,
  ID_Usuario_Cobrador TEXT,
  ID_Trabajador_Cobrador TEXT,
  Numero_Ticket TEXT,
  Estado TEXT NOT NULL DEFAULT 'ACTIVO',
  Anulado_En TEXT,
  Anulado_Por TEXT,
  Motivo_Anulacion TEXT,
  -- FISCAL-01: POR QUE este cobro dejo de contar. Son dos instrumentos legales distintos y el
  -- registro de facturacion que genera cada uno es distinto:
  --
  --   'ERROR'      -> la venta NO EXISTIO (ticket de prueba, mesa equivocada). Genera un
  --                   RF DE ANULACION (art. 11.1 RRSIF). La AEAT dice en su FAQ que estos casos
  --                   deben ser "MUY POCO FRECUENTES". Las lineas vuelven a la comanda.
  --   'DEVOLUCION' -> la venta SI EXISTIO y se devuelve el dinero. Genera una FACTURA
  --                   RECTIFICATIVA (RF de alta R5, TipoRectificativa=I, importe negativo). La
  --                   AEAT es explicita: "todas las facturas emitidas, en la medida en que
  --                   respondan a operaciones realmente efectuadas (como es el caso habitual) NO
  --                   PUEDEN ANULARSE". Las lineas NO vuelven: se vendieron.
  --
  -- Antes las dos cosas salian por el mismo boton, y la que mas se va a usar -la devolucion- es
  -- justo la que no era una anulacion.
  --
  -- NO se toca `Estado` para distinguirlas, y eso es la decision: en este esquema 'ANULADO' ya
  -- significa "no cuenta como venta", y las dos lo son. Mezclar el motivo en `Estado` obligaria a
  -- revisar las ~14 consultas que filtran por el -el arqueo, las estadisticas, el pendiente de una
  -- comanda, la reconciliacion y sus espejos del worker- para algo que al cajon le da igual: el
  -- dinero salio en los dos casos. Lo que cambia es el papel que hay que emitir.
  Motivo_Baja TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda) ON DELETE CASCADE,
  FOREIGN KEY (ID_Usuario_Cobrador) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  FOREIGN KEY (ID_Trabajador_Cobrador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL,
  FOREIGN KEY (Anulado_Por) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  CHECK (Estado IN ('ACTIVO','ANULADO')),
  CHECK ((Estado = 'ANULADO') = (Anulado_En IS NOT NULL AND Anulado_Por IS NOT NULL)),
  CHECK (Motivo_Baja IS NULL OR Motivo_Baja IN ('ERROR','DEVOLUCION')),
  CHECK ((Motivo_Baja IS NOT NULL) <= (Estado = 'ANULADO'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_fecha
ON Pagos(Fecha_Hora);

CREATE INDEX IF NOT EXISTS idx_pagos_comanda_fecha
ON Pagos(ID_Comanda, Fecha_Hora);

CREATE INDEX IF NOT EXISTS idx_pagos_trab_cobrador_fecha
ON Pagos(ID_Trabajador_Cobrador, Fecha_Hora);

-- Todas las lecturas de caja filtran por Estado desde CUENTA-07 (el arqueo, las estadisticas, el
-- pendiente de una comanda), y casi todas acotan ademas por fecha.
CREATE INDEX IF NOT EXISTS idx_pagos_estado_fecha
ON Pagos(Estado, Fecha_Hora);

-- ON DELETE CASCADE en ID_Detalle desde CUENTA-07. Antes no hacia falta: una linea cobrada no se
-- borraba nunca, y al anular se borraban las dos filas a la vez. Ahora anular devuelve la linea a
-- la comanda, asi que el camarero puede quitarla despues -y si la FK lo impidiera, la linea
-- quedaria congelada en la mesa, que es peor que el comportamiento que este cambio arregla.
--
-- No se pierde auditoria: lo que prueba la anulacion es la fila de Pagos (importe, quien, cuando y
-- por que), que sobrevive. Una fila de Pago_Detalles cuya linea ya no existe no seria una prueba
-- sino un puntero colgante: la reimpresion une con Detalle_Comanda, asi que esa linea desaparece
-- del papel igual, conservemos el enlace o no.
--
-- Y lo que protege a un cobro ACTIVO no es esta FK: son las guardias de las funciones que borran
-- lineas, que se niegan a tocar una linea cubierta por un pago activo (`v_lineas_cobradas`).
CREATE TABLE IF NOT EXISTS Pago_Detalles (
  ID_Pago TEXT NOT NULL,
  ID_Detalle TEXT NOT NULL,
  PRIMARY KEY (ID_Pago, ID_Detalle),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE
);

-- La PK (ID_Pago, ID_Detalle) no cubre las busquedas por ID_Detalle (que pago
-- cobro esta linea), necesarias al anular/revertir un pago.
CREATE INDEX IF NOT EXISTS idx_pago_detalles_detalle
ON Pago_Detalles(ID_Detalle);

-- Que una linea este COBRADA no es "tiene fila en Pago_Detalles": es "tiene fila en Pago_Detalles
-- ligada a un pago ACTIVO" (CUENTA-07). La diferencia aparece al anular: como el pago ya no se
-- borra, sus Pago_Detalles siguen ahi -y son justo lo que permite reimprimir el ticket tal como se
-- emitio-, pero las lineas vuelven a estar pendientes de cobro.
--
-- Va en una vista y no repetido en cada consulta porque el predicado esta en ~27 sitios entre Rust
-- y el worker: escrito 27 veces, la proxima consulta que alguien anada se olvidara del filtro y el
-- sintoma sera una mesa con lineas congeladas o un pendiente descuadrado, no un error. Las
-- ESCRITURAS siguen yendo contra Pago_Detalles; esta vista es solo para leer.
-- (Comentario fuera del CREATE VIEW: el snapshot anti-drift colapsa cada sentencia a una linea y
--  un `--` dentro se comeria el resto.)
CREATE VIEW IF NOT EXISTS v_lineas_cobradas AS
SELECT pd.ID_Pago AS ID_Pago, pd.ID_Detalle AS ID_Detalle
FROM Pago_Detalles pd
JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
WHERE p.Estado = 'ACTIVO';

-- Correlativo del ticket impreso (Pagos.Numero_Ticket). Sin el, un papel no se puede atar a su
-- cobro: ni para una devolucion, ni para cuadrar un arqueo, ni para el cliente que vuelve a
-- reclamar. Y una reimpresion tiene que salir con el MISMO numero que el original, asi que el
-- numero no se calcula al imprimir: se guarda con el pago.
--
-- FISCAL-01: el contador YA NO VIVE AQUI. La tabla `Ticket_Contador` (un `Ultimo` global sin serie,
-- formato `T-000123`) se retiro y su papel lo hace `Serie_Facturacion` (§14): desde Veri*factu el
-- numero del ticket ES el numero de la factura -`Pagos.Numero_Ticket` guarda el `Num_Serie_Factura`
-- del registro-, con serie por ejercicio y reinicio anual.
--
-- Dos numeraciones paralelas serian dos cosas que pueden divergir, y la que importa a efectos
-- legales es la fiscal: la que va en el QR del papel y en el `IDFactura` que la AEAT usa como clave
-- unica. La columna sigue siendo TEXT, que es justo lo que permitio este cambio sin migrar nada.

-- Aperturas MANUALES del cajon portamonedas. Las de un cobro se saben por su Pago y duplicarlas
-- aqui seria ruido; lo que no dejaba rastro es abrirlo SIN una venta detras (dar cambio, cuadrar),
-- que es justo por donde se va el dinero. No se registra para impedirlo -el camarero necesita
-- abrirlo- sino para que exista la pregunta "quien lo abrio a las 17:40".
CREATE TABLE IF NOT EXISTS Aperturas_Cajon (
  ID_Apertura TEXT NOT NULL PRIMARY KEY,
  ID_Usuario TEXT,
  Fecha DATETIME NOT NULL,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_aperturas_cajon_fecha
ON Aperturas_Cajon(Fecha);

-- Historial de caja (CUENTA-07). Calcado en forma a Movimientos_Stock, que ya hace esto mismo para
-- el inventario: una fila por hecho, sin borrar nunca.
--
-- Es para INVESTIGAR, no para calcular. Pagos sigue siendo la unica fuente de verdad del dinero y
-- el arqueo sigue derivando de ahi: en cuanto alguien sume el esperado desde esta tabla habra dos
-- fuentes para la misma cifra y divergiran.
--
-- ID_Movimiento es TEXT PRIMARY KEY, asi que el UUID se genera ANTES del INSERT (paso kind:"value"
-- en el worker, new_id() en Rust) y nunca por DEFAULT ni trigger: si no, nube y Main acaban con
-- filas distintas para el mismo hecho (CLAUDE.md 9, "IDs deterministas").
--
-- ON DELETE SET NULL en las referencias aunque ya no borremos pagos: un movimiento es un hecho
-- historico y no puede desaparecer porque desaparezca aquello a lo que apunta.
--
-- Importe SIEMPRE en positivo; el signo lo da el Tipo. Mezclar signos en una columna que alguien
-- va a sumar es pedir un error. Ampliar Tipo (devoluciones de VENTA-01, Veri*factu) es tocar solo
-- el CHECK.
CREATE TABLE IF NOT EXISTS Movimientos_Caja (
  ID_Movimiento TEXT NOT NULL PRIMARY KEY,
  Fecha_Hora TEXT NOT NULL,
  Tipo TEXT NOT NULL,
  ID_Pago TEXT,
  ID_Gasto TEXT,
  ID_Usuario TEXT,
  ID_Trabajador TEXT,
  Importe INTEGER NOT NULL DEFAULT 0,
  Metodo_Pago TEXT,
  Motivo TEXT,
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago) ON DELETE SET NULL,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL,
  CHECK (Tipo IN ('COBRO','ANULACION','DEVOLUCION','GASTO','GASTO_ANULADO'))
);

CREATE INDEX IF NOT EXISTS idx_movcaja_fecha
ON Movimientos_Caja(Fecha_Hora);

-- RI-04: un movimiento por (Tipo, apunte). Es la idempotencia que caja_movimientos::registrar ya
-- garantiza con su WHERE NOT EXISTS, y es tambien lo que hace barata esa comprobacion: sin estos
-- indices era un SCAN de la tabla en cada cobro, gasto y anulacion, y como la sentencia se replica
-- tal cual, en Turso cada cobro leia (y facturaba) el historial entero. Parciales porque cada fila
-- apunta a un pago O a un gasto. SQLite parte el OR de aquella sentencia y usa uno por rama.
CREATE UNIQUE INDEX IF NOT EXISTS ux_movcaja_pago
ON Movimientos_Caja(Tipo, ID_Pago) WHERE ID_Pago IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_movcaja_gasto
ON Movimientos_Caja(Tipo, ID_Gasto) WHERE ID_Gasto IS NOT NULL;

/* =========================================================
   10. Idempotencia / Atomicidad (tabla de la NUBE)
   Applied_Operations la usa el WORKER (nube) como gate idempotente por Op_Id al
   aplicar escrituras (ver TenantHub.applyInternalCommand): un Op_Id repetido viola
   UNIQUE(Op_Id) y hace rollback del batch, evitando duplicar el trabajo.

   Forma parte del esquema UNICO compartido, asi que TAMBIEN se crea en la BD local
   de la Main, pero AHI QUEDA VACIA a proposito: la Main lleva su propia idempotencia
   en la tabla de control _Sync_Applied_Ops (creada por init_sync_tables en
   crates/tpv-infra-sqlite/src/db.rs, fuera de las migraciones). Reparto:
     - NUBE  -> Applied_Operations (esta tabla).
     - MAIN  -> _Sync_Applied_Ops  (anti-eco de sus propias escrituras + catch-up).
   Se mantiene en ambos lados por la politica de esquema unico (no pasa nada si queda
   vacia en un lado). Tabla interna de control: su ID sigue siendo INTEGER local.
========================================================= */
CREATE TABLE IF NOT EXISTS Applied_Operations (
  ID_Applied_Operation INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Request_Hash TEXT NOT NULL,
  Device_Id TEXT,
  Status TEXT NOT NULL DEFAULT 'PROCESSING',
  Result_Json TEXT,
  Error_Text TEXT,
  Created_At_Ms INTEGER NOT NULL,
  Applied_At_Ms INTEGER,
  Updated_At_Ms INTEGER NOT NULL,
  UNIQUE (Op_Id),
  CHECK (Status IN ('PROCESSING', 'APPLIED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_applied_ops_created_at
ON Applied_Operations(Created_At_Ms);

/* Log de replicacion de la NUBE (tambien vacias en la Main, por la misma politica):
     - Sync_Changes: cada escritura aplicada por el TenantHub, con sus sentencias ya
       resueltas. Alimenta el catch-up (/v1/sync/changes) y el broadcast.
     - Sync_Main_Checkpoints: hasta donde ha confirmado cada Main; es el suelo de la
       purga de Sync_Changes.
   Antes las creaba el Durable Object al abrir su conexion, y un tenant recien
   aprovisionado no las tenia hasta la primera escritura por el DO: el catch-up por
   REST de una Main recien activada llegaba antes y fallaba con
   `no such table: Sync_Changes` (SYNC-28). Aqui nacen con el tenant. */
CREATE TABLE IF NOT EXISTS Sync_Changes (
  Seq INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT,
  Statements_Json TEXT NOT NULL,
  Device_Id TEXT,
  Created_At_Ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Sync_Main_Checkpoints (
  Device_Id TEXT NOT NULL PRIMARY KEY,
  Last_Seq INTEGER NOT NULL,
  Updated_At_Ms INTEGER NOT NULL
);

/* =========================================================
   11. Configuración (singletons: ID=1, no son ids de negocio)
   (La antigua tabla Schema_Meta/schema_version se retiro: el versionado real del
    esquema lo lleva la tabla de control _migrations de los runners; ver migrations.rs.)
========================================================= */
CREATE TABLE IF NOT EXISTS Business_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Business_Name TEXT NOT NULL DEFAULT 'TPV',
  Logo_DataUrl TEXT,
  Direccion TEXT DEFAULT '',
  Telefono TEXT DEFAULT '',
  CIF TEXT DEFAULT '',
  Mensaje_Footer TEXT DEFAULT '¡Gracias por su visita!',
  IVA_Percent REAL NOT NULL DEFAULT 10,
  -- A partir de cuanto descuadre el cierre de caja exige escribir un motivo (CUENTA-06). 5 euros
  -- deja pasar el centimo de redondeo y el error de vuelta sin dar la lata, y obliga a explicar lo
  -- que ya es dinero de verdad. Cada negocio lo ajusta.
  Umbral_Descuadre INTEGER NOT NULL DEFAULT 500,
  -- ── FISCAL-01 (Veri*factu) ──────────────────────────────────────────────────────────────────
  -- Razon_Social NO es Business_Name. "Bar La Plaza" es el rotulo; "Francisco Garcia SL" es quien
  -- factura. El ticket ensena los dos; el registro de facturacion (NombreRazonEmisor y el bloque
  -- ObligadoEmision de la cabecera) solo el segundo.
  Razon_Social TEXT NOT NULL DEFAULT '',
  -- DescripcionOperacion es un campo OBLIGATORIO del registro (hasta 500 caracteres). No se deriva
  -- de las lineas: los nombres de producto los escribe el usuario y un campo obligatorio que puede
  -- llegar vacio o con basura es un rechazo garantizado. Texto fijo, configurable.
  Descripcion_Op TEXT NOT NULL DEFAULT 'Servicios de hosteleria y restauracion',
  -- Limite (IVA incluido) por encima del cual una factura simplificada (F2) ya no vale y hay que
  -- emitir factura completa (F1). El general del art. 4.1 RD 1619/2012 son 400 EUR, pero la
  -- hosteleria esta en la lista del art. 4.2 y sube a 3.000. La AEAT lo valida en el servicio web
  -- (error 1150). Va aqui y no incrustado porque es un numero que la norma puede mover.
  Limite_Simplif INTEGER NOT NULL DEFAULT 300000,
  -- 'produccion' | 'pruebas'. Cambia A LA VEZ el endpoint del servicio web y la URL del QR que se
  -- imprime en el papel. Un ticket emitido en pruebas lleva un QR que apunta a prewww2.aeat.es: la
  -- pantalla tiene que gritarlo. Es una decision explicita y visible, y no una variable de entorno,
  -- porque produccion y pruebas se distinguen en tres caracteres (www1 / prewww1).
  Verifactu_Entorno TEXT NOT NULL DEFAULT 'produccion',
  -- MODO-PRUEBA (temporal): con 1, los cobros numeran en la serie PRUEBA y NO emiten registro de
  -- facturacion: sin QR, sin envio a la AEAT y sin necesitar NIF ni certificado. Sirve para probar
  -- el programa mientras Veri*factu no es obligatorio, y antes del 1-1-2027 se quita entero (ver
  -- docs/VERIFACTU_PENDIENTES.md): un interruptor que deja de declarar ventas no puede existir en un
  -- TPV que se venda.
  Modo_Prueba INTEGER NOT NULL DEFAULT 0,
  Updated_At TEXT,
  CHECK (Verifactu_Entorno IN ('produccion','pruebas'))
);

INSERT OR IGNORE INTO Business_Settings (ID) VALUES (1);

CREATE TABLE IF NOT EXISTS Ticket_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Show_Logo INTEGER NOT NULL DEFAULT 1,
  Show_BusinessName INTEGER NOT NULL DEFAULT 1,
  Show_Address INTEGER NOT NULL DEFAULT 1,
  Show_Phone INTEGER NOT NULL DEFAULT 1,
  Show_CIF INTEGER NOT NULL DEFAULT 1,
  Show_DateTime INTEGER NOT NULL DEFAULT 1,
  Show_LineItems INTEGER NOT NULL DEFAULT 1,
  Show_BaseAndIVA INTEGER NOT NULL DEFAULT 1,
  Show_Total INTEGER NOT NULL DEFAULT 1,
  Show_FooterMessage INTEGER NOT NULL DEFAULT 1,
  Paper_Width_Mm INTEGER NOT NULL DEFAULT 80,
  Paper_Dpi INTEGER NOT NULL DEFAULT 203,
  Chars_Per_Line INTEGER NOT NULL DEFAULT 42,
  Margin_Top_Mm REAL NOT NULL DEFAULT 0,
  Margin_Bottom_Mm REAL NOT NULL DEFAULT 0,
  Margin_Left_Mm REAL NOT NULL DEFAULT 0,
  Margin_Right_Mm REAL NOT NULL DEFAULT 0,
  Font_Scale REAL NOT NULL DEFAULT 1.0,
  Updated_At TEXT,
  CHECK (Paper_Width_Mm IN (58, 80, 112)),
  CHECK (Paper_Dpi IN (203, 300)),
  CHECK (Chars_Per_Line >= 20 AND Chars_Per_Line <= 80),
  CHECK (Font_Scale >= 0.5 AND Font_Scale <= 2.0)
);

INSERT OR IGNORE INTO Ticket_Settings (ID) VALUES (1);

-- Datos de contacto/recuperacion del negocio (singleton, ID=1).
CREATE TABLE IF NOT EXISTS Contact_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Recovery_Email TEXT NOT NULL DEFAULT '',
  Contact_Email TEXT NOT NULL DEFAULT '',
  Contact_Phone TEXT NOT NULL DEFAULT '',
  Updated_At TEXT
);

INSERT OR IGNORE INTO Contact_Settings (ID) VALUES (1);

-- (La tabla Email_Settings se retiro: todo el correo se envia por el worker
--  (Cloudflare Email Service / Resend), asi que ya no hay configuracion ni
--  credenciales SMTP locales ni replicadas a la nube. Ver DB-04.)

/* =========================================================
   12. Notificaciones (NOTIF-01)
   Avisos persistentes que cualquier modulo puede emitir (stock bajo, aprobar pedido,
   expiracion de licencia, gracia offline, avisos manuales) y que se pueden dirigir a un
   usuario concreto, a un rol o a todos.

   Modelo "fan-out on read": UNA fila por mensaje (aunque vaya "a todos") en Notificaciones;
   el estado "leido" es POR USUARIO en Notificacion_Lecturas (un recibo por quien la lee). Asi
   una notificacion "a todos"/"por rol" es una sola fila y cada usuario marca su propia lectura
   sin duplicar el mensaje (escala sin explosion de filas por destinatario).

   Sincronizacion (ver §9 CLAUDE.md): son tablas del ESQUEMA COMPARTIDO (se replican a la nube
   y a las Handy por el outbox/WS). Por eso el ID lo genera el repositorio en Rust ANTES del
   INSERT (TEXT PRIMARY KEY sin DEFAULT ni trigger) y las marcas de tiempo se escriben con
   datetime('now','localtime'), que el outbox/tenantHub congela a literal antes de replicar.
========================================================= */
-- Destino_Tipo / Destino_Valor: a quien apunta ('todos' -> Valor NULL; 'usuario' -> ID_Usuario;
--   'rol' -> ID_Rol, que es estable frente al renombrado del rol). El rol de un usuario vive en
--   Usuarios.ID_Rol, asi que la visibilidad "por rol" se resuelve contra esa tabla.
-- Accion / Payload: accion opcional que ofrece la notificacion y sus datos en JSON. El backend es
--   agnostico: el frontend decide como pintar cada Tipo y que hace cada Accion.
-- Clave_Dedupe: clave anti-duplicado mientras la notificacion esta 'activa' (p.ej.
--   'stock_bajo:<ID_Producto>') para no repetir el mismo aviso.
-- Estado: ciclo de vida. Al reponer stock / aprobar el pedido, el emisor marca 'resuelta' en vez
--   de acumular avisos.
CREATE TABLE IF NOT EXISTS Notificaciones (
  ID_Notificacion TEXT NOT NULL PRIMARY KEY,
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

/* =========================================================
   13. Vistas
========================================================= */
-- Stock por producto + caducidad proxima + lote FEFO siguiente. Reescrita (DB-12) para NO usar
-- subconsultas correlacionadas por producto (que re-escaneaban Lotes_Producto una vez por producto
-- y disparaban lecturas -> coste de Turso). Ahora son 2 pasadas unicas sobre Lotes_Producto:
--   * agg:      SUM(stock) por producto + MIN(caducidad) de los lotes con stock (= caducidad proxima).
--   * lote_fefo: ROW_NUMBER() en UNA pasada para elegir el lote FEFO siguiente (rn = 1).
-- Columnas de salida IDENTICAS a la version anterior (Stock_Actual, Caducidad_Proxima, Lote_Proximo).
-- Caducidad_Proxima = MIN de las caducidades de los lotes CON stock (MIN ignora los NULL).
--
-- (Este comentario va fuera del CREATE VIEW por la misma razon que en las tablas: el snapshot
--  anti-drift colapsa cada sentencia a una linea, y un `--` dentro se comeria el resto.)
CREATE VIEW IF NOT EXISTS v_inventario_producto_stock AS
WITH agg AS (
  SELECT
    ID_Producto,
    COALESCE(SUM(Stock_Disponible), 0) AS Stock_Actual,
    MIN(CASE WHEN COALESCE(Stock_Disponible, 0) > 0 THEN Caducidad END) AS Caducidad_Proxima
  FROM Lotes_Producto
  GROUP BY ID_Producto
),
lote_fefo AS (
  SELECT ID_Producto, Codigo_Lote
  FROM (
    SELECT
      ID_Producto,
      Codigo_Lote,
      ROW_NUMBER() OVER (
        PARTITION BY ID_Producto
        ORDER BY
          CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
          date(Caducidad) ASC,
          datetime(Fecha_Entrada) ASC,
          ID_Lote ASC
      ) AS rn
    FROM Lotes_Producto
    WHERE COALESCE(Stock_Disponible, 0) > 0
  )
  WHERE rn = 1
)
SELECT
  p.ID_Producto,
  COALESCE(a.Stock_Actual, 0) AS Stock_Actual,
  a.Caducidad_Proxima AS Caducidad_Proxima,
  f.Codigo_Lote AS Lote_Proximo
FROM Productos p
LEFT JOIN agg a ON a.ID_Producto = p.ID_Producto
LEFT JOIN lote_fefo f ON f.ID_Producto = p.ID_Producto;

/* =========================================================
   14. Veri*factu / registros de facturacion (FISCAL-01, FISCAL-02)
   RD 1007/2023 (RRSIF) + Orden HAC/1177/2024. Diseno y porques: docs/PLAN_VERIFACTU.md.

   El principio que ordena todo lo demas: el REGISTRO DE FACTURACION es el hecho fiscal. El papel
   es una copia suya y el envio a la AEAT es una consecuencia diferida. De ahi las tres reglas que
   no se negocian:
     1. El registro se crea EN LA MISMA TRANSACCION que el cobro (art. 9 RRSIF: "de forma
        simultanea o inmediatamente anterior a la expedicion").
     2. NO SE MODIFICA JAMAS. Una correccion es OTRA fila (subsanacion), nunca un UPDATE.
     3. Nada de lo que rodea al envio puede impedir cobrar.

   Se replica a la nube por el outbox como el resto del esquema: es lo que permite que una Main que
   perdio su data.db recupere su cadena. NINGUNA ruta del worker puede escribirla: la nube es copia,
   no fuente.
========================================================= */

-- Contador de la serie de facturacion. Serie = ejercicio ('2027'), formato '2027/000001'.
--
-- Se reserva como el antiguo Ticket_Contador: `UPDATE ... SET Ultimo = Ultimo + 1`, RELATIVO, para
-- que la sentencia que sale al outbox converja sola. Sigue siendo un contador propio y no un
-- SELECT MAX(...) de los registros.
--
-- Lo que si es nuevo: antes de usar el numero se comprueba contra MAX(Numero) de
-- Registros_Facturacion para esa serie y, si el contador va por detras, SALTA HACIA ADELANTE.
-- Existe por un caso concreto: restaurar una copia local de hace tres dias devolveria el contador a
-- un numero ya emitido, y la AEAT rechazaria el registro por duplicado (IDFactura = emisor + numero
-- + fecha, error 3000). Un hueco en la numeracion es explicable; un numero repetido es un registro
-- que no entra. SE FALLA HACIA EL HUECO.
CREATE TABLE IF NOT EXISTS Serie_Facturacion (
  Serie  TEXT NOT NULL PRIMARY KEY,
  Ultimo INTEGER NOT NULL DEFAULT 0
);

-- El corazon. Append-only: se inserta y nunca se toca (sin UPDATE, sin DELETE, sin excepciones).
--
-- Tres decisiones que parecen detalles y no lo son:
--
--   * `Orden` EXPLICITO, no rowid. El ultimo eslabon de la cadena es MAX(Orden). Con rowid la
--     cadena dependeria del orden en que una restauracion reinserta las filas, que no esta
--     garantizado.
--   * `Cadena_Huella` SE GUARDA. Es redundante -se puede recomputar- y precisamente por eso vale:
--     si algun dia el formateo cambia, el fichero ensena que se hasheo de verdad. Es ademas lo que
--     hace auditable la exportacion (art. 8 RRSIF) sin tener que confiar en el codigo que la lee.
--   * Los IMPORTES SON TEXTO. `ImporteTotal` y `CuotaTotal` entran en la cadena hasheada, y
--     REAL -> texto no es una operacion unica: 123.1, 123.10 y 123.100000000000001 son tres cadenas
--     distintas. Se formatean UNA vez y nadie recomputa nada al leer: el XML, el QR y la
--     exportacion se construyen desde el texto guardado.
--
-- `Fecha_Operacion` (DD-MM-AAAA) se informa SOLO cuando la operacion se efectuo en un dia distinto
-- al de expedicion de la factura. No es opcional a nuestro gusto: lo exigen el art. 6.1.i) para la
-- factura completa y el 7.1.c) para la simplificada, con la MISMA redaccion -"siempre que se trate
-- de una fecha distinta a la de expedicion de la factura"-, asi que tambien alcanza a los tickets.
--
-- NULL es el caso normal de un bar -se consume y se cobra en el mismo acto- y la AEAT interpreta la
-- ausencia como "igual a FechaExpedicionFactura"; lo dicen sus propios codigos de error, que
-- repiten "FechaExpedicionFactura si no se informa FechaOperacion". Los tres casos en que NO
-- coinciden: una comanda que cruza la medianoche, una rectificativa de una venta de otro dia y una
-- F3 que canjea un ticket anterior.
--
-- NO entra en la cadena de huella, asi que informarlo no cambia ninguna huella ya calculada.
--
-- ID_Registro es TEXT PRIMARY KEY, asi que el UUID se genera ANTES del INSERT (nunca por DEFAULT ni
-- trigger): CLAUDE.md 9, "IDs deterministas". ON DELETE SET NULL en ID_Pago porque un registro
-- fiscal no puede desaparecer porque desaparezca aquello a lo que apunta (misma regla que
-- Movimientos_Caja); ademas la fuente de verdad del dinero sigue siendo Pagos.
--
-- ESTA TABLA NO SE PURGA NUNCA (DB-14). El dia que se implemente el archivado de datos antiguos,
-- esta y `Serie_Facturacion` quedan fuera: el art. 7 RRSIF exige conservarlos "sin que puedan ser
-- modificados ni eliminados", y borrar una fila de `Serie_Facturacion` devolveria el contador a 1 y
-- reemitiria numeros ya usados. El detalle de BACKLOG.md DB-14 dice que SI se puede archivar y por
-- que: el importe, la base, la cuota y el desglose ya viven DENTRO del registro, no se derivan de
-- la comanda al leer.
CREATE TABLE IF NOT EXISTS Registros_Facturacion (
  ID_Registro           TEXT NOT NULL PRIMARY KEY,
  Orden                 INTEGER NOT NULL,
  Tipo                  TEXT NOT NULL,
  NIF_Emisor            TEXT NOT NULL,
  Num_Serie_Factura     TEXT NOT NULL,
  Fecha_Expedicion      TEXT NOT NULL,
  Fecha_Operacion       TEXT,
  Serie                 TEXT NOT NULL,
  Numero                INTEGER NOT NULL,
  Nombre_Razon_Emisor   TEXT NOT NULL,
  Tipo_Factura          TEXT,
  Tipo_Rectificativa    TEXT,
  Descripcion_Operacion TEXT,
  Importe_Total         TEXT,
  Cuota_Total           TEXT,
  Desglose_Json         TEXT,
  Destinatario_Json     TEXT,
  Referencias_Json      TEXT,
  Macrodato             TEXT,
  Primer_Registro       TEXT,
  Ant_NIF               TEXT,
  Ant_Num_Serie         TEXT,
  Ant_Fecha             TEXT,
  Ant_Huella            TEXT,
  Cadena_Huella         TEXT NOT NULL,
  Huella                TEXT NOT NULL,
  Tipo_Huella           TEXT NOT NULL DEFAULT '01',
  Fecha_Hora_Huso       TEXT NOT NULL,
  Subsanacion           TEXT,
  Rechazo_Previo        TEXT,
  Sin_Registro_Previo   TEXT,
  Subsana_ID_Registro   TEXT,
  Sistema_Json          TEXT NOT NULL,
  QR_Url                TEXT NOT NULL,
  Incidencia            TEXT NOT NULL DEFAULT 'N',
  ID_Pago               TEXT,
  UNIQUE (Orden),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago) ON DELETE SET NULL,
  CHECK (Tipo IN ('ALTA','ANULACION')),
  CHECK (Tipo_Factura IS NULL OR Tipo_Factura IN ('F1','F2','F3','R1','R2','R3','R4','R5')),
  CHECK (Tipo_Rectificativa IS NULL OR Tipo_Rectificativa IN ('S','I')),
  CHECK (Primer_Registro IS NULL OR Primer_Registro = 'S'),
  CHECK (Subsanacion IS NULL OR Subsanacion IN ('S','N')),
  CHECK (Rechazo_Previo IS NULL OR Rechazo_Previo IN ('N','S','X')),
  CHECK (Sin_Registro_Previo IS NULL OR Sin_Registro_Previo IN ('N','S')),
  CHECK (Macrodato IS NULL OR Macrodato IN ('N','S')),
  CHECK (Incidencia IN ('N','S')),
  CHECK (Tipo_Huella = '01')
);

-- La clave unica de una factura ante la AEAT es (emisor, numero de serie, fecha de expedicion). Un
-- duplicado es el error 3000 y un registro que no entra.
--
-- Es UNIQUE sobre esa terna PERO NO sobre la fila entera: una SUBSANACION conserva el mismo
-- IDFactura a proposito -no es una factura nueva, es el mismo hecho bien contado-, asi que el
-- indice tiene que dejar pasar la segunda. Se excluyen del indice las filas de subsanacion.
CREATE UNIQUE INDEX IF NOT EXISTS ux_regfact_idfactura
ON Registros_Facturacion(NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Tipo)
WHERE Subsanacion IS NULL OR Subsanacion <> 'S';

-- La ruta caliente del envio ("dame los pendientes por Orden ascendente") la sirve el UNIQUE (Orden)
-- de la tabla, que ya es un indice por Orden. Tenia ademas uno propio identico (RI-17): una escritura
-- mas en la transaccion de cada cobro para nada.

-- RI-03: reservar el numero de factura hace MAX(Numero) de la serie en CADA cobro, dentro de la
-- transaccion del escritor unico. Sin este indice recorria la tabla entera, que es la que por ley no
-- se purga nunca y cuyas filas son anchas: ~120 ms por cobro con un ano de registros, y subiendo.
CREATE INDEX IF NOT EXISTS idx_regfact_serie_numero
ON Registros_Facturacion(Serie, Numero);

-- RI-03: "el registro de este numero de ticket" (reimpresion, F3). ux_regfact_idfactura no sirve:
-- empieza por NIF_Emisor, y quien pregunta solo tiene el numero. Sin esto, reimprimir un ticket
-- antiguo recorria los registros hacia atras por Orden hasta dar con el.
CREATE INDEX IF NOT EXISTS idx_regfact_numserie
ON Registros_Facturacion(Num_Serie_Factura, Tipo, Orden);

-- El panel fiscal y la exportacion (art. 8 RRSIF) filtran por rango de fechas.
CREATE INDEX IF NOT EXISTS idx_regfact_fecha
ON Registros_Facturacion(Fecha_Expedicion);

-- "Que registro corresponde a este cobro" (reimpresion, anulacion, rectificativa).
CREATE INDEX IF NOT EXISTS idx_regfact_pago
ON Registros_Facturacion(ID_Pago);

/* =========================================================
   15. Seeds (UUID fijos: identicos en local y nube)
========================================================= */
INSERT OR IGNORE INTO Alergenos (ID_Alergeno, Nombre, Nombre_Imagen, Ruta_Imagen) VALUES
  ('00000000-0000-7000-8000-000000000201', 'Gluten', 'gluten.png', '/alergenos/gluten.png'),
  ('00000000-0000-7000-8000-000000000202', 'Crustáceos', 'crustaceos.png', '/alergenos/crustaceos.png'),
  ('00000000-0000-7000-8000-000000000203', 'Huevos', 'huevos.png', '/alergenos/huevos.png'),
  ('00000000-0000-7000-8000-000000000204', 'Pescado', 'pescado.png', '/alergenos/pescado.png'),
  ('00000000-0000-7000-8000-000000000205', 'Cacahuetes', 'cacahuetes.png', '/alergenos/cacahuetes.png'),
  ('00000000-0000-7000-8000-000000000206', 'Soja', 'soja.png', '/alergenos/soja.png'),
  ('00000000-0000-7000-8000-000000000207', 'Lácteos', 'lacteos.png', '/alergenos/lacteos.png'),
  ('00000000-0000-7000-8000-000000000208', 'Frutos de cáscara', 'frutos_cascara.png', '/alergenos/frutos_cascara.png'),
  ('00000000-0000-7000-8000-000000000209', 'Apio', 'apio.png', '/alergenos/apio.png'),
  ('00000000-0000-7000-8000-00000000020a', 'Mostaza', 'mostaza.png', '/alergenos/mostaza.png'),
  ('00000000-0000-7000-8000-00000000020b', 'Sésamo', 'sesamo.png', '/alergenos/sesamo.png'),
  ('00000000-0000-7000-8000-00000000020c', 'Sulfitos', 'sulfitos.png', '/alergenos/sulfitos.png'),
  ('00000000-0000-7000-8000-00000000020d', 'Altramuces', 'altramuces.png', '/alergenos/altramuces.png'),
  ('00000000-0000-7000-8000-00000000020e', 'Moluscos', 'moluscos.png', '/alergenos/moluscos.png');

-- NO se siembra ninguna zona ni mesa: el usuario crea las suyas desde el editor de salones.
-- (Antes se sembraban una zona y una mesa "BARRA" como ancla de la venta rapida. Ya no hacen falta:
--  los tickets de venta rapida son Comandas con Canal='BARRA' y sin mesa. Ver la nota de la tabla
--  Comandas en §6.)

/* =========================================================
   16. Andamiaje LOCAL del dispositivo (prefijo `_`)

   Estado que describe lo que le pasa a ESTE equipo: que le falta por subir, que se
   trajo, cuando corrio cada job, como va el envio a la AEAT. Nada de esto es un dato
   de negocio y nada de esto viaja: sus escrituras van por `WriteGuard::raw()`, que no
   captura en `_Sync_Outbox`.

   VIVE AQUI, EN EL ESQUEMA UNICO, Y NO EN CODIGO. Antes lo creaban a mano dos funciones
   de `crates/tpv-infra-sqlite/src/db.rs` (`init_sync_tables` / `init_jobs_table`), y eso
   era tener dos esquemas: uno declarado y versionado, y otro imperativo que no pasaba
   por `_migrations`, no entraba en el snapshot anti-drift y solo se podia leer
   ejecutandolo mentalmente. Un cambio en aquel no dejaba rastro en ningun sitio.

   Que estas tablas se creen tambien en el tenant de Turso es DELIBERADO y no molesta:
   se quedan vacias, como ya dice la cabecera de este fichero. El volcado de recuperacion
   no las mira (`esRestaurable` descarta todo lo que empieza por `_`, ver
   domains/sync/bootstrap.ventana.ts), asi que no viajan ni de vuelta.
========================================================= */

-- Lo que esta Main ha escrito y todavia no ha confirmado la nube. Es una COLA ORDENADA:
-- sus operaciones se apoyan unas en otras (una linea necesita su comanda), asi que se
-- sube por `Seq` y no en cualquier orden.
--
-- Intentos / Ultimo_Error / Ultimo_Intento_Ms / Cuarentena (SYNC-20): una operacion que
-- la nube RECHAZA no es lo mismo que una que no ha podido salir. Sin estas columnas el
-- drenado no sabia distinguirlas y hacia lo unico que podia: parar y reintentar, en
-- silencio y para siempre, con todas las ventas de detras detenidas tambien. Es la misma
-- politica que el DO ya aplicaba a su cola de entrada (`_Cola_Muerta` en tenantHub.ts),
-- traida al camino en vivo, que es por donde va un TPV al dia.
CREATE TABLE IF NOT EXISTS _Sync_Outbox (
    Seq INTEGER PRIMARY KEY AUTOINCREMENT,
    Op_Id TEXT NOT NULL UNIQUE,
    Command_Name TEXT NOT NULL,
    Statements_Json TEXT NOT NULL,
    Created_At_Ms INTEGER NOT NULL,
    Intentos INTEGER NOT NULL DEFAULT 0,
    Ultimo_Error TEXT,
    Ultimo_Intento_Ms INTEGER,
    Cuarentena INTEGER NOT NULL DEFAULT 0,
    -- SYNC-26: si esta fila es una REPARACION, el Op_Id de la operacion apartada que la motivo.
    --
    -- Existe para poder cerrar el aviso. Sin el enlace, una operacion apartada se quedaba en
    -- cuarentena para siempre aunque su reparacion hubiera subido: el panel seguiria diciendo
    -- "hay cambios que la nube ha rechazado" con el problema ya resuelto, y un aviso que no se
    -- apaga solo cuando el problema se arregla ensena a descartar avisos.
    Repara_Op_Id TEXT
);

-- El drenado pide siempre lo pendiente NO apartado, por orden. Sin este indice, una
-- cuarentena vieja obliga a recorrer la cola entera en cada pasada.
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pendientes
ON _Sync_Outbox(Cuarentena, Seq);

-- Anti-eco de las escrituras propias + gate de idempotencia del catch-up.
-- Reparto (ver §10): la NUBE usa `Applied_Operations`; la MAIN usa esta.
CREATE TABLE IF NOT EXISTS _Sync_Applied_Ops (
    Op_Id TEXT NOT NULL PRIMARY KEY,
    Seq INTEGER NOT NULL,
    Applied_At_Ms INTEGER NOT NULL
);

-- SYNC-18: operaciones que la nube ya ha ACEPTADO en su cola pero aun no ha confirmado
-- aplicadas. Su fila sigue en `_Sync_Outbox` a proposito: mientras no vuelva por el
-- catch-up (que es la prueba de que se aplico de verdad), esta Main conserva su copia y
-- puede reenviarla. Lo que hace esta tabla es que no se reenvie MIENTRAS TANTO.
CREATE TABLE IF NOT EXISTS _Sync_Encoladas (
    Op_Id TEXT NOT NULL PRIMARY KEY,
    Encolada_En_Ms INTEGER NOT NULL
);

-- Hasta donde ha leido esta Main el log de cambios de la nube.
CREATE TABLE IF NOT EXISTS _Sync_State (
    Id INTEGER PRIMARY KEY CHECK (Id = 1),
    Last_Seq INTEGER NOT NULL
);
INSERT OR IGNORE INTO _Sync_State (Id, Last_Seq) VALUES (1, 0);

-- Cuarentena de BAJADA: cambios remotos que esta Main no ha sabido aplicar. Tras 5
-- intentos se apartan y el checkpoint AVANZA, para que el resto siga convergiendo.
CREATE TABLE IF NOT EXISTS _Sync_Failed (
    Op_Id TEXT NOT NULL PRIMARY KEY,
    Seq INTEGER NOT NULL,
    Statements_Json TEXT NOT NULL,
    Attempts INTEGER NOT NULL,
    Quarantined INTEGER NOT NULL DEFAULT 0,
    Last_Error TEXT,
    First_Failed_At_Ms INTEGER NOT NULL,
    Last_Failed_At_Ms INTEGER NOT NULL
);

-- Estado local y persistente del protocolo de recuperacion. Vive dentro de la BD para que
-- restaurar el fichero y marcarlo como "todavia bloqueado" pueda hacerse antes de abrirlo
-- al resto de la aplicacion, sin una ventana de login accidental tras un reinicio.
CREATE TABLE IF NOT EXISTS _Recovery_State (
    Id INTEGER PRIMARY KEY CHECK (Id = 1),
    Reconciliation_Pending INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO _Recovery_State (Id, Reconciliation_Pending) VALUES (1, 0);

-- SYNC-19 - fase 2: el historico que la ventana del bootstrap dejo fuera. La siembra
-- `bootstrap_restaurar` (una fila por tabla que el worker marco `parcial`) y la va
-- avanzando el job `backfill_historico`. Con esto el backfill es reanudable por
-- construccion: apagar el TPV a media descarga no pierde nada, y volver a pedir una
-- pagina ya aplicada es inocuo (`INSERT OR IGNORE`).
--
-- `Orden` conserva el que dio el worker: padres primero. Cada pagina es su propia
-- transaccion, asi que `defer_foreign_keys` no cubre a una hija insertada antes que su
-- padre; sin ese orden la fase 2 fallaria fila a fila y no terminaria nunca.
CREATE TABLE IF NOT EXISTS _Backfill_Historico (
    Tabla TEXT NOT NULL PRIMARY KEY,
    Orden INTEGER NOT NULL DEFAULT 0,
    Cursor INTEGER NOT NULL DEFAULT 0,
    Filas_Traidas INTEGER NOT NULL DEFAULT 0,
    Completada INTEGER NOT NULL DEFAULT 0,
    Ultimo_Intento_Ms INTEGER,
    Ultimo_Error TEXT
);

-- FISCAL-01 (Veri*factu): estado del envio a la AEAT.
--
-- Es estado LOCAL del equipo y NO SE REPLICA A PROPOSITO. Tras una restauracion la verdad
-- no esta en nuestra nube sino en la AEAT, a la que se le puede preguntar
-- (ConsultaFactuSistemaFacturacion). Replicarlo daria una respuesta que parece buena y no
-- lo es.
--
-- Estado:
--   PENDIENTE              -> generado, aun no aceptado por la AEAT.
--   ACEPTADO               -> EstadoRegistro 'Correcto' (o duplicado: ya lo teniamos alli).
--   ACEPTADO_CON_ERRORES   -> esta en la AEAT pero hay que SUBSANARLO (errores 2000-2008).
--   RECHAZADO              -> NO esta en la AEAT. Se subsana (Subsanacion=S, RechazoPrevio=X).
CREATE TABLE IF NOT EXISTS _Verifactu_Envios (
    ID_Registro       TEXT NOT NULL PRIMARY KEY,
    Estado            TEXT NOT NULL,
    Intentos          INTEGER NOT NULL DEFAULT 0,
    Ultimo_Intento_Ms INTEGER,
    Codigo_Error      TEXT,
    Descripcion_Error TEXT,
    CSV               TEXT,
    Creado_En_Ms      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_verifactu_envios_estado
ON _Verifactu_Envios(Estado);

-- Anomalias de la cadena detectadas por la comprobacion previa del art. 7.i) de la Orden
-- HAC/1177/2024. Es estado LOCAL de diagnostico: describe lo que le ha pasado a ESTE
-- equipo.
--
-- No es el "registro de eventos" del RRSIF: ese solo es obligatorio para los SIF que pueden
-- actuar en modalidad NO VERI*FACTU, y este es SOLO VERI*FACTU (lo confirma la NOTA 1 del
-- apartado 15 del FAQ de desarrolladores de la AEAT). Esto es la parte util de aquello: que
-- una anomalia no se quede solo en un log que nadie abre.
CREATE TABLE IF NOT EXISTS _Verifactu_Anomalias (
    ID_Anomalia     TEXT NOT NULL PRIMARY KEY,
    Clase           TEXT NOT NULL,
    Mensaje         TEXT NOT NULL,
    ID_Registro     TEXT,
    Detectada_En_Ms INTEGER NOT NULL,
    Reconocida      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_verifactu_anomalias_pend
ON _Verifactu_Anomalias(Reconocida, Detectada_En_Ms);

-- Control de flujo obligatorio (art. 16.2 Orden HAC/1177/2024): el siguiente envio no puede
-- salir hasta que pasen `Espera_Segundos` desde el anterior O hasta acumular 1000 registros
-- (maximo por envio), lo que ocurra primero. El valor inicial es 60 y la AEAT lo actualiza
-- en cada respuesta (`TiempoEsperaEnvio`).
CREATE TABLE IF NOT EXISTS _Verifactu_Flujo (
    ID               INTEGER PRIMARY KEY CHECK (ID = 1),
    Espera_Segundos  INTEGER NOT NULL DEFAULT 60,
    Ultimo_Envio_Ms  INTEGER
);
INSERT OR IGNORE INTO _Verifactu_Flujo (ID, Espera_Segundos) VALUES (1, 60);

-- Estado de los jobs periodicos (jobs/mod.rs). `Last_Ok_Ms` es su razon de ser: permite
-- decidir el vencimiento en reloj de pared (si ha pasado el intervalo desde el ultimo
-- exito) en vez de por tiempo de proceso, de modo que un job de 6 h se ejecute igualmente
-- en un equipo que se apaga cada noche.
CREATE TABLE IF NOT EXISTS _Jobs_State (
    Nombre TEXT NOT NULL PRIMARY KEY,
    Last_Run_Ms INTEGER,
    Last_Ok_Ms INTEGER,
    Last_Error TEXT,
    Fallos INTEGER NOT NULL DEFAULT 0
);
