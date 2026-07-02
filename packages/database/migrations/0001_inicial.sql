/* =========================================================
   TPV SCHEMA — MIGRACION INICIAL (0001) · UNICA Y COMPARTIDA (app local + nube Turso)
   - La FUENTE UNICA DE VERDAD del esquema son los ficheros .sql de
     packages/database/migrations/, aplicados EN ORDEN. Este es el primero.
     Los consumen los dos runners espejo:
       * App de escritorio (Rust): crates/tpv-infra-sqlite/src/migrations.rs los
         embebe con include_dir! y aplica lo pendiente en cada arranque.
       * Worker tpv-api: apps/cloud-worker-licensing/src/server/tenantMigrations.ts
         los registra y aplica igual sobre cada BD por-tenant (Turso).
     Cada BD lleva una tabla _migrations (name, hash, applied_at): una BD nueva se
     construye desde 0001 y una existente solo aplica lo que le falte.
   - REGLA DE ORO: nunca edites una migracion ya publicada (rompe el hash → error
     duro en ambos runners). Todo cambio va en una migracion NUEVA y aditiva.
   - Inventario con LOTES + FEFO.
   - Idempotencia/atomicidad: Applied_Operations (ver §10).
   - No pasa nada si alguna tabla queda vacia en un lado u otro: es un
     unico esquema para ambos.

   IDENTIFICADORES (UUIDv7):
   - Todas las claves primarias de negocio son TEXT (UUIDv7 generado por el
     cliente: Rust en la Main, repo HTTP del Handy). Las claves foraneas son
     TEXT a juego. Esto hace que una fila tenga el MISMO id en todos los
     dispositivos y en la nube → no hay divergencia de ids al sincronizar.
   - Los seeds (Roles, Turnos, Alergenos, Zonas, mesa BARRA) usan UUID FIJOS
     identicos en local y nube, para que sus ids coincidan siempre.
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
  Es_Sistema INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS Reservas (
  ID_Reserva TEXT PRIMARY KEY,
  ID_Cliente TEXT NOT NULL,
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
   6. Comandas / Detalles / Facturas / Cuentas
========================================================= */
CREATE TABLE IF NOT EXISTS Comandas (
  ID_Comanda TEXT PRIMARY KEY,
  ID_Mesa TEXT NOT NULL,
  ID_Reserva TEXT NULL,
  ID_Trabajador TEXT NULL,
  Fecha_Hora_Apertura TEXT NOT NULL,
  Fecha_Hora_Cierre TEXT NULL,
  Total_Comanda REAL NOT NULL DEFAULT 0,
  Estado TEXT NOT NULL DEFAULT 'Abierta',
  FOREIGN KEY (ID_Mesa) REFERENCES Mesas(ID_Mesa),
  FOREIGN KEY (ID_Reserva) REFERENCES Reservas(ID_Reserva),
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_comandas_mesa_estado
ON Comandas(ID_Mesa, Estado);

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

CREATE TABLE IF NOT EXISTS Facturas (
  ID_Factura TEXT PRIMARY KEY,
  ID_Comanda TEXT UNIQUE NOT NULL,
  ID_Cliente TEXT,
  Fecha_Emision DATETIME NOT NULL,
  Subtotal REAL NOT NULL,
  IVA REAL NOT NULL,
  Total_Pagado REAL NOT NULL,
  Metodo_Pago TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Cliente) REFERENCES Clientes(ID_Cliente)
);

CREATE INDEX IF NOT EXISTS idx_facturas_cliente
ON Facturas(ID_Cliente);

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

CREATE TABLE IF NOT EXISTS Email_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Modo TEXT NOT NULL DEFAULT 'managed' CHECK (Modo IN ('managed', 'smtp')),
  Smtp_Host TEXT NOT NULL DEFAULT '',
  Smtp_Port INTEGER NOT NULL DEFAULT 587,
  Smtp_User TEXT NOT NULL DEFAULT '',
  Smtp_Password TEXT NOT NULL DEFAULT '',
  Smtp_From_Email TEXT NOT NULL DEFAULT '',
  Smtp_From_Name TEXT NOT NULL DEFAULT '',
  Smtp_Use_Tls INTEGER NOT NULL DEFAULT 1,
  Updated_At TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO Email_Settings (ID) VALUES (1);

/* =========================================================
   13. Vistas
========================================================= */
CREATE VIEW IF NOT EXISTS v_inventario_producto_stock AS
SELECT
  p.ID_Producto,
  COALESCE(SUM(l.Stock_Disponible), 0) AS Stock_Actual,
  (
    SELECT l2.Caducidad
    FROM Lotes_Producto l2
    WHERE l2.ID_Producto = p.ID_Producto
      AND COALESCE(l2.Stock_Disponible, 0) > 0
      AND l2.Caducidad IS NOT NULL
    ORDER BY date(l2.Caducidad) ASC, datetime(l2.Fecha_Entrada) ASC, l2.ID_Lote ASC
    LIMIT 1
  ) AS Caducidad_Proxima,
  (
    SELECT l3.Codigo_Lote
    FROM Lotes_Producto l3
    WHERE l3.ID_Producto = p.ID_Producto
      AND COALESCE(l3.Stock_Disponible, 0) > 0
    ORDER BY
      CASE WHEN l3.Caducidad IS NULL THEN 1 ELSE 0 END,
      date(l3.Caducidad) ASC,
      datetime(l3.Fecha_Entrada) ASC,
      l3.ID_Lote ASC
    LIMIT 1
  ) AS Lote_Proximo
FROM Productos p
LEFT JOIN Lotes_Producto l ON l.ID_Producto = p.ID_Producto
GROUP BY p.ID_Producto;

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

-- Solo se siembra la zona BARRA: es el ancla de la venta rápida (id fijo, idéntico en local y
-- nube). Las zonas de ejemplo (Salon/Terraza) se eliminaron del seed; el usuario crea las suyas.
-- Updated_At: literal FIJO (no datetime('now')). Cada runner (Main y cada tenant) siembra por su
-- lado en instantes distintos y en otra zona horaria; un literal fijo hace que la fila sea
-- IDENTICA en todos los dispositivos y en la nube, y que cualquier edicion real (localtime, mas
-- reciente) gane siempre en la resolucion por Updated_At.
INSERT OR IGNORE INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At) VALUES
  ('00000000-0000-7000-8000-000000000303', 'BARRA', '[]', '2024-01-01 00:00:00');

INSERT OR IGNORE INTO Mesas (
  ID_Mesa,
  ID_Zona,
  Numero_Mesa,
  Capacidad,
  Ubicacion_X,
  Ubicacion_Y,
  Shape,
  Width,
  Height,
  Radius,
  Updated_At,
  Es_Sistema
) VALUES (
  '00000000-0000-7000-8000-000000000401',
  '00000000-0000-7000-8000-000000000303',
  'BARRA',
  0,
  0,
  0,
  'rect',
  1,
  1,
  NULL,
  '2024-01-01 00:00:00',  -- Updated_At: literal FIJO (ver nota en el seed de Zonas BARRA)
  1
);
