/* =========================================================
   TPV SCHEMA — MIGRACION INICIAL (0001) · UNICA Y COMPARTIDA (app local + nube Turso)
   - La FUENTE UNICA DE VERDAD del esquema son los ficheros .sql de
     packages/database/migrations/, aplicados EN ORDEN. Hoy este es el UNICO:
     antes del lanzamiento se CONSOLIDARON aqui las migraciones incrementales
     0002..0008 (contact settings, email unico de cliente, movimientos de stock,
     intentos de login, comanda unica por mesa, stock suelto y notificaciones).
     No habia instalaciones en produccion, asi que arrancar de un esquema plano
     es mas simple de leer y de mantener que una cadena de parches historicos.
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
   - No pasa nada si alguna tabla queda vacia en un lado u otro: es un
     unico esquema para ambos.

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
  ID_Rol TEXT PRIMARY KEY,
  Nombre_Rol TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO Roles (ID_Rol, Nombre_Rol) VALUES
  ('00000000-0000-7000-8000-000000000001', 'Administrador'),
  ('00000000-0000-7000-8000-000000000002', 'Camarero'),
  ('00000000-0000-7000-8000-000000000003', 'Cocinero'),
  ('00000000-0000-7000-8000-000000000004', 'Limpieza');

CREATE TABLE IF NOT EXISTS Usuarios (
  ID_Usuario TEXT PRIMARY KEY,
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
  ID_Usuario TEXT PRIMARY KEY,
  Intentos_Fallidos INTEGER NOT NULL DEFAULT 0,
  Bloqueado_Hasta_Ms INTEGER NOT NULL DEFAULT 0,
  Ultimo_Intento_Ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE CASCADE
);

/* =========================================================
   2. Personal y Horarios
========================================================= */
CREATE TABLE IF NOT EXISTS Trabajadores (
  ID_Trabajador TEXT PRIMARY KEY,
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
  ID_Turno TEXT PRIMARY KEY,
  Nombre_Turno TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS Asignacion_Turnos (
  ID_Asignacion TEXT PRIMARY KEY,
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
  ID_Default TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_hp_trab_weekday
ON Horario_Predeterminado(ID_Trabajador, Weekday);

/* =========================================================
   3. Inventario y Productos
========================================================= */
CREATE TABLE IF NOT EXISTS Categorias_Producto (
  ID_Categoria TEXT PRIMARY KEY,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Vendible INTEGER NOT NULL DEFAULT 1,
  Pasa_Cocina INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Proveedores (
  ID_Proveedor TEXT PRIMARY KEY,
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
  ID_Producto TEXT PRIMARY KEY,
  ID_Categoria TEXT NOT NULL,
  ID_Proveedor TEXT,
  Nombre TEXT NOT NULL UNIQUE,
  Precio_Venta REAL,
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
  FOREIGN KEY (ID_Categoria) REFERENCES Categorias_Producto(ID_Categoria),
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor)
);

-- La rejilla de productos filtra por categoria; ambos son FKs muy consultadas.
CREATE INDEX IF NOT EXISTS idx_productos_categoria
ON Productos(ID_Categoria);

CREATE INDEX IF NOT EXISTS idx_productos_proveedor
ON Productos(ID_Proveedor);

CREATE TABLE IF NOT EXISTS Lotes_Producto (
  ID_Lote TEXT PRIMARY KEY,
  ID_Producto TEXT NOT NULL,
  Codigo_Lote TEXT NOT NULL,
  Fecha_Entrada DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Caducidad DATE,
  Cantidad_Inicial REAL NOT NULL DEFAULT 0,
  Stock_Disponible REAL NOT NULL DEFAULT 0,
  Coste_Unitario REAL,
  ID_Proveedor TEXT,
  Notas TEXT,
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE CASCADE,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor),
  UNIQUE (ID_Producto, Codigo_Lote),
  CHECK (Cantidad_Inicial >= 0),
  CHECK (Stock_Disponible >= 0)
);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_cad
ON Lotes_Producto(ID_Producto, Caducidad);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_stock
ON Lotes_Producto(ID_Producto, Stock_Disponible);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_entrada
ON Lotes_Producto(ID_Producto, Fecha_Entrada);

-- Auditoria de movimientos de stock (INV-01b). Cada cambio manual de Stock_Disponible de un lote
-- (alta y ajuste) deja una fila trazable en vez de sobrescribir el valor a pelo sin rastro. Base
-- para la reconciliacion (INV-06): Stock_Disponible == Cantidad_Inicial - SUM(consumo) + SUM(ajustes).
--
-- Tipo: 'ALTA' (creacion del lote) | 'AJUSTE' (correccion manual del disponible).
-- Delta: variacion aplicada a Stock_Disponible (+entrada / -salida).
-- Stock_Resultante: disponible tras el movimiento (snapshot para reconciliar sin recomputar).
-- Motivo: texto libre (las Notas del alta/ajuste).
-- ID_Usuario: quien lo hizo (NULLABLE: no siempre disponible en la capa de comando todavia).
-- Fecha: instante local; el outbox/tenantHub lo congela a literal antes de replicar.
CREATE TABLE IF NOT EXISTS Movimientos_Stock (
  ID_Movimiento TEXT PRIMARY KEY,
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
  ID_Pedido TEXT PRIMARY KEY,
  ID_Proveedor TEXT,
  Email_Destino TEXT,
  Estado TEXT NOT NULL DEFAULT 'borrador',
  Fecha_Creacion TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  Fecha_Envio TEXT,
  Notas TEXT,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor) ON DELETE SET NULL,
  CHECK (Estado IN ('borrador', 'enviado', 'cancelado'))
);

CREATE TABLE IF NOT EXISTS Lineas_Pedido_Proveedor (
  ID_Linea TEXT PRIMARY KEY,
  ID_Pedido TEXT NOT NULL,
  Nombre_Producto TEXT NOT NULL,
  Cantidad REAL NOT NULL DEFAULT 1,
  Precio_Unitario REAL,
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
  ID_Alergeno TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_prod_alerg_prod
ON Producto_Alergenos(ID_Producto);

CREATE INDEX IF NOT EXISTS idx_prod_alerg_alerg
ON Producto_Alergenos(ID_Alergeno);

/* =========================================================
   5. Zonas / Mesas / Clientes / Reservas
========================================================= */
CREATE TABLE IF NOT EXISTS Zonas (
  ID_Zona TEXT PRIMARY KEY,
  Nombre_Zona TEXT NOT NULL UNIQUE,
  Room_Points TEXT NOT NULL DEFAULT '[]',
  Updated_At DATETIME
);

CREATE TABLE IF NOT EXISTS Mesas (
  ID_Mesa TEXT PRIMARY KEY,
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
  ID_Cliente TEXT PRIMARY KEY,
  Nombre TEXT NOT NULL,
  Telefono TEXT,
  Email TEXT,
  Notas TEXT,
  Total_Gastado REAL NOT NULL DEFAULT 0,
  Created_At TEXT DEFAULT (datetime('now','localtime'))
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
CREATE TABLE IF NOT EXISTS Reservas (
  ID_Reserva TEXT PRIMARY KEY,
  ID_Cliente TEXT,
  ID_Mesa TEXT NOT NULL,
  Dia_YMD TEXT NOT NULL,
  Hora TEXT NOT NULL,
  Turno TEXT NOT NULL,
  Comensales INTEGER NOT NULL DEFAULT 1,
  Nota TEXT,
  Estado TEXT NOT NULL DEFAULT 'ACTIVA',
  Created_At TEXT DEFAULT (datetime('now','localtime')),
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
  ID_Comanda TEXT PRIMARY KEY,
  ID_Mesa TEXT NULL,
  ID_Reserva TEXT NULL,
  ID_Trabajador TEXT NULL,
  Canal TEXT NOT NULL DEFAULT 'MESA',
  Fecha_Hora_Apertura TEXT NOT NULL,
  Fecha_Hora_Cierre TEXT NULL,
  Total_Comanda REAL NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS Detalle_Comanda (
  ID_Detalle TEXT PRIMARY KEY,
  ID_Comanda TEXT NOT NULL,
  ID_Producto TEXT NOT NULL,
  Cantidad REAL NOT NULL,
  Precio_Unitario REAL NOT NULL,
  Notas TEXT,
  Estado_Cocina TEXT DEFAULT 'PENDIENTE',
  Fecha_Hora_Cocina DATETIME,
  ID_Usuario_Cocinero TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto)
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
  Cantidad REAL NOT NULL,
  PRIMARY KEY (ID_Detalle, ID_Lote),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE,
  FOREIGN KEY (ID_Lote) REFERENCES Lotes_Producto(ID_Lote),
  CHECK (Cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_lote_consumos_lote
ON Lote_Consumos(ID_Lote);

-- (La tabla Facturas se retiro: nunca se escribia; el cobro vive integramente en Pagos +
--  Pago_Detalles, que es la fuente de verdad. Ver DB-13. Si algun dia hace falta facturacion
--  fiscal, se re-anade en una migracion nueva.)

-- Importe >= 0: validado en la capa de aplicacion (ver nota en Detalle_Comanda, DB-06).
CREATE TABLE IF NOT EXISTS Cuentas_Gastos (
  ID_Gasto TEXT PRIMARY KEY,
  Fecha DATE NOT NULL,
  Concepto TEXT NOT NULL,
  Importe REAL NOT NULL,
  Tipo_Gasto TEXT NOT NULL,
  ID_Proveedor TEXT NULL,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cuentas_gastos_fecha
ON Cuentas_Gastos(Fecha);

CREATE INDEX IF NOT EXISTS idx_cuentas_gastos_proveedor
ON Cuentas_Gastos(ID_Proveedor);

/* =========================================================
   7. Tareas
========================================================= */
CREATE TABLE IF NOT EXISTS Tareas (
  ID_Tarea TEXT PRIMARY KEY,
  Titulo TEXT NOT NULL,
  Descripcion TEXT,
  Fecha_Creacion DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Fecha_Limite DATE,
  Estado TEXT NOT NULL DEFAULT 'ABIERTA'
);

CREATE TABLE IF NOT EXISTS Tarea_Asignaciones (
  ID_Tarea TEXT NOT NULL,
  ID_Trabajador TEXT NOT NULL,
  Asignada_At DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  Finalizada_At DATETIME,
  PRIMARY KEY (ID_Tarea, ID_Trabajador),
  FOREIGN KEY (ID_Tarea) REFERENCES Tareas(ID_Tarea) ON DELETE CASCADE,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tarea_asig_trab
ON Tarea_Asignaciones(ID_Trabajador, Estado);

CREATE INDEX IF NOT EXISTS idx_tarea_asig_tarea
ON Tarea_Asignaciones(ID_Tarea);

/* =========================================================
   8. Fichajes
========================================================= */
CREATE TABLE IF NOT EXISTS Fichajes (
  ID_Fichaje TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_fichajes_user_fecha
ON Fichajes(ID_Usuario, Fecha);

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
CREATE TABLE IF NOT EXISTS Pagos (
  ID_Pago TEXT PRIMARY KEY,
  ID_Comanda TEXT NOT NULL,
  Fecha_Hora DATETIME NOT NULL,
  Metodo_Pago TEXT NOT NULL,
  Importe_Total REAL NOT NULL,
  Tipo TEXT NOT NULL,
  ID_Usuario_Cobrador TEXT,
  ID_Trabajador_Cobrador TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda) ON DELETE CASCADE,
  FOREIGN KEY (ID_Usuario_Cobrador) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  FOREIGN KEY (ID_Trabajador_Cobrador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pagos_fecha
ON Pagos(Fecha_Hora);

CREATE INDEX IF NOT EXISTS idx_pagos_comanda_fecha
ON Pagos(ID_Comanda, Fecha_Hora);

CREATE INDEX IF NOT EXISTS idx_pagos_trab_cobrador_fecha
ON Pagos(ID_Trabajador_Cobrador, Fecha_Hora);

CREATE TABLE IF NOT EXISTS Pago_Detalles (
  ID_Pago TEXT NOT NULL,
  ID_Detalle TEXT NOT NULL,
  PRIMARY KEY (ID_Pago, ID_Detalle),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle)
);

-- La PK (ID_Pago, ID_Detalle) no cubre las busquedas por ID_Detalle (que pago
-- cobro esta linea), necesarias al anular/revertir un pago.
CREATE INDEX IF NOT EXISTS idx_pago_detalles_detalle
ON Pago_Detalles(ID_Detalle);

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

CREATE INDEX IF NOT EXISTS idx_applied_ops_status
ON Applied_Operations(Status);

CREATE INDEX IF NOT EXISTS idx_applied_ops_created_at
ON Applied_Operations(Created_At_Ms);

CREATE INDEX IF NOT EXISTS idx_applied_ops_command
ON Applied_Operations(Command_Name);

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
  Updated_At TEXT DEFAULT (datetime('now','localtime'))
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
  Updated_At TEXT DEFAULT (datetime('now','localtime')),
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
  Updated_At TEXT DEFAULT (datetime('now','localtime'))
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

/* =========================================================
   13. Vistas
========================================================= */
-- Stock por producto + caducidad proxima + lote FEFO siguiente. Reescrita (DB-12) para NO usar
-- subconsultas correlacionadas por producto (que re-escaneaban Lotes_Producto una vez por producto
-- y disparaban lecturas -> coste de Turso). Ahora son 2 pasadas unicas sobre Lotes_Producto:
--   * agg:      SUM(stock) por producto + MIN(caducidad) de los lotes con stock (= caducidad proxima).
--   * lote_fefo: ROW_NUMBER() en UNA pasada para elegir el lote FEFO siguiente (rn = 1).
-- Columnas de salida IDENTICAS a la version anterior (Stock_Actual, Caducidad_Proxima, Lote_Proximo).
CREATE VIEW IF NOT EXISTS v_inventario_producto_stock AS
WITH agg AS (
  SELECT
    ID_Producto,
    COALESCE(SUM(Stock_Disponible), 0) AS Stock_Actual,
    -- Caducidad mas proxima = MIN de las caducidades de lotes con stock (MIN ignora NULLs).
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
   14. Seeds (UUID fijos: identicos en local y nube)
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
