/* =========================================================
   TPV SCHEMA (Inventario con LOTES + FEFO)
   - Sin migraciones: pensado para borrar DB y recrear
   - Cambios clave:
     ✅ Productos = ficha (catálogo)
     ✅ Lotes_Producto = existencias por lote (caducidad/cantidad)
     ✅ Lote_Consumos = trazabilidad (qué lote se consumió en cada línea)
     ✅ Cuentas_Gastos.ID_Proveedor para gastos tipo "Proveedor"
     ✅ Applied_Operations para replay seguro por Op_Id
     ✅ Cloud_Changes + Sync_State para sync nube/local
========================================================= */

PRAGMA foreign_keys = ON;

/* =========================================================
   1. Seguridad y Usuarios
========================================================= */
CREATE TABLE IF NOT EXISTS Roles (
  ID_Rol INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Rol TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO Roles (Nombre_Rol) VALUES
  ('Camarero'),
  ('Cocinero'),
  ('Limpieza');

CREATE TABLE IF NOT EXISTS Usuarios (
  ID_Usuario INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Rol INTEGER NOT NULL,
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
  ID_Trabajador INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Usuario INTEGER UNIQUE NOT NULL,
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
  ID_Turno INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Turno TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS Asignacion_Turnos (
  ID_Asignacion INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Trabajador INTEGER NOT NULL,
  Fecha DATE NOT NULL,
  ID_Turno INTEGER NOT NULL,
  Area TEXT NOT NULL,
  Hora_Inicio TIME,
  Hora_Fin TIME,
  Notas TEXT,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador),
  FOREIGN KEY (ID_Turno) REFERENCES Turnos(ID_Turno)
);

CREATE INDEX IF NOT EXISTS idx_asig_fecha ON Asignacion_Turnos(Fecha);
CREATE INDEX IF NOT EXISTS idx_asig_trab_fecha ON Asignacion_Turnos(ID_Trabajador, Fecha);

INSERT OR IGNORE INTO Turnos (Nombre_Turno) VALUES
  ('LIBRE'),
  ('PARTIDO'),
  ('MAÑANA'),
  ('TARDE'),
  ('NOCHE');

CREATE TABLE IF NOT EXISTS Horario_Predeterminado (
  ID_Default INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Trabajador INTEGER NOT NULL,
  Weekday INTEGER NOT NULL,
  Orden INTEGER NOT NULL DEFAULT 1,
  ID_Turno INTEGER NOT NULL,
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
  ID_Categoria INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Vendible INTEGER NOT NULL DEFAULT 1,
  Pasa_Cocina INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Proveedores (
  ID_Proveedor INTEGER PRIMARY KEY AUTOINCREMENT,
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
  ID_Producto INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Categoria INTEGER NOT NULL,
  ID_Proveedor INTEGER,
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

CREATE TABLE IF NOT EXISTS Lotes_Producto (
  ID_Lote INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Producto INTEGER NOT NULL,
  Codigo_Lote TEXT NOT NULL,
  Fecha_Entrada DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Caducidad DATE,
  Cantidad_Inicial REAL NOT NULL DEFAULT 0,
  Stock_Disponible REAL NOT NULL DEFAULT 0,
  Coste_Unitario REAL,
  ID_Proveedor INTEGER,
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

/* =========================================================
   4. Alérgenos
========================================================= */
CREATE TABLE IF NOT EXISTS Alergenos (
  ID_Alergeno INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT
);

CREATE TABLE IF NOT EXISTS Producto_Alergenos (
  ID_Producto INTEGER NOT NULL,
  ID_Alergeno INTEGER NOT NULL,
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
  ID_Zona INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Zona TEXT NOT NULL UNIQUE,
  Room_Points TEXT NOT NULL DEFAULT '[]',
  Updated_At DATETIME
);

CREATE TABLE IF NOT EXISTS Mesas (
  ID_Mesa INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Zona INTEGER NOT NULL,
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
  ID_Cliente INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre TEXT NOT NULL,
  Telefono TEXT,
  Email TEXT,
  Notas TEXT,
  Total_Gastado REAL NOT NULL DEFAULT 0,
  Created_At TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS Reservas (
  ID_Reserva INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Cliente INTEGER NOT NULL,
  ID_Mesa INTEGER NOT NULL,
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

/* =========================================================
   6. Comandas / Detalles / Facturas / Cuentas
========================================================= */
CREATE TABLE IF NOT EXISTS Comandas (
  ID_Comanda INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Mesa INTEGER NOT NULL,
  ID_Reserva INTEGER NULL,
  ID_Trabajador INTEGER NULL,
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

CREATE TABLE IF NOT EXISTS Detalle_Comanda (
  ID_Detalle INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Comanda INTEGER NOT NULL,
  ID_Producto INTEGER NOT NULL,
  Cantidad REAL NOT NULL,
  Precio_Unitario REAL NOT NULL,
  Notas TEXT,
  Estado_Cocina TEXT DEFAULT 'PENDIENTE',
  Fecha_Hora_Cocina DATETIME,
  ID_Usuario_Cocinero INTEGER,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto)
);

CREATE INDEX IF NOT EXISTS idx_dc_cocinero_fecha
ON Detalle_Comanda(ID_Usuario_Cocinero, Fecha_Hora_Cocina);

CREATE INDEX IF NOT EXISTS idx_dc_estado_fecha
ON Detalle_Comanda(Estado_Cocina, Fecha_Hora_Cocina);

CREATE TABLE IF NOT EXISTS Lote_Consumos (
  ID_Detalle INTEGER NOT NULL,
  ID_Lote INTEGER NOT NULL,
  Cantidad REAL NOT NULL,
  PRIMARY KEY (ID_Detalle, ID_Lote),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE,
  FOREIGN KEY (ID_Lote) REFERENCES Lotes_Producto(ID_Lote),
  CHECK (Cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_lote_consumos_lote
ON Lote_Consumos(ID_Lote);

CREATE TABLE IF NOT EXISTS Facturas (
  ID_Factura INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Comanda INTEGER UNIQUE NOT NULL,
  ID_Cliente INTEGER,
  Fecha_Emision DATETIME NOT NULL,
  Subtotal REAL NOT NULL,
  IVA REAL NOT NULL,
  Total_Pagado REAL NOT NULL,
  Metodo_Pago TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Cliente) REFERENCES Clientes(ID_Cliente)
);

CREATE TABLE IF NOT EXISTS Cuentas_Gastos (
  ID_Gasto INTEGER PRIMARY KEY AUTOINCREMENT,
  Fecha DATE NOT NULL,
  Concepto TEXT NOT NULL,
  Importe REAL NOT NULL,
  Tipo_Gasto TEXT NOT NULL,
  ID_Proveedor INTEGER NULL,
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
  ID_Tarea INTEGER PRIMARY KEY AUTOINCREMENT,
  Titulo TEXT NOT NULL,
  Descripcion TEXT,
  Fecha_Creacion DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Fecha_Limite DATE,
  Estado TEXT NOT NULL DEFAULT 'ABIERTA'
);

CREATE TABLE IF NOT EXISTS Tarea_Asignaciones (
  ID_Tarea INTEGER NOT NULL,
  ID_Trabajador INTEGER NOT NULL,
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
  ID_Fichaje INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Usuario INTEGER NOT NULL,
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
  ID_Usuario INTEGER NOT NULL,
  Fecha DATE NOT NULL,
  Turno_Partido INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ID_Usuario, Fecha),
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

/* =========================================================
   9. Pagos
========================================================= */
CREATE TABLE IF NOT EXISTS Pagos (
  ID_Pago INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Comanda INTEGER NOT NULL,
  Fecha_Hora DATETIME NOT NULL,
  Metodo_Pago TEXT NOT NULL,
  Importe_Total REAL NOT NULL,
  Tipo TEXT NOT NULL,
  ID_Usuario_Cobrador INTEGER,
  ID_Trabajador_Cobrador INTEGER,
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
  ID_Pago INTEGER NOT NULL,
  ID_Detalle INTEGER NOT NULL,
  PRIMARY KEY (ID_Pago, ID_Detalle),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle)
);

/* =========================================================
   10. Idempotencia / Replay seguro
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

CREATE TABLE IF NOT EXISTS Outbox_Operations (
  ID_Outbox INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL UNIQUE,
  Command_Name TEXT NOT NULL,
  Payload_Json TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'PENDING',
  Attempt_Count INTEGER NOT NULL DEFAULT 0,
  Last_Error TEXT,
  Created_At_Ms INTEGER NOT NULL,
  Updated_At_Ms INTEGER NOT NULL,
  Last_Attempt_At_Ms INTEGER,
  Next_Retry_At_Ms INTEGER,
  CHECK (Status IN ('PENDING', 'SYNCING', 'APPLIED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_retry
ON Outbox_Operations(Status, Next_Retry_At_Ms, Created_At_Ms);

CREATE INDEX IF NOT EXISTS idx_outbox_status
ON Outbox_Operations(Status);

CREATE INDEX IF NOT EXISTS idx_outbox_created
ON Outbox_Operations(Created_At_Ms);

/* =========================================================
   11. Sync cloud/local
========================================================= */
CREATE TABLE IF NOT EXISTS Pending_Local_Applies (
  ID_Pending INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL UNIQUE,
  Command_Name TEXT NOT NULL,
  Payload_Json TEXT NOT NULL,
  Result_Json TEXT,
  Status TEXT NOT NULL DEFAULT 'PENDING',
  Attempt_Count INTEGER NOT NULL DEFAULT 0,
  Last_Error TEXT,
  Created_At_Ms INTEGER NOT NULL,
  Updated_At_Ms INTEGER NOT NULL,
  Last_Attempt_At_Ms INTEGER,
  Next_Retry_At_Ms INTEGER,
  CHECK (Status IN ('PENDING', 'PROCESSING', 'APPLIED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_pending_local_applies_status
ON Pending_Local_Applies(Status, Next_Retry_At_Ms, Created_At_Ms);

CREATE INDEX IF NOT EXISTS idx_pending_local_applies_command
ON Pending_Local_Applies(Command_Name);

CREATE TABLE IF NOT EXISTS Schema_Meta (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL,
  Updated_At_Ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO Schema_Meta (Key, Value, Updated_At_Ms)
VALUES ('schema_version', '1', 0);

CREATE TABLE IF NOT EXISTS Cloud_Changes (
  ID_Change INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Command_Version INTEGER NOT NULL DEFAULT 1,
  Device_Id TEXT,
  Payload_Json TEXT NOT NULL,
  Result_Json TEXT,
  Created_At_Ms INTEGER NOT NULL,
  UNIQUE (Op_Id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_changes_id
ON Cloud_Changes(ID_Change);

CREATE INDEX IF NOT EXISTS idx_cloud_changes_created
ON Cloud_Changes(Created_At_Ms);

CREATE INDEX IF NOT EXISTS idx_cloud_changes_command
ON Cloud_Changes(Command_Name);

CREATE TABLE IF NOT EXISTS Sync_State (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL,
  Updated_At_Ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO Sync_State (Key, Value, Updated_At_Ms)
VALUES ('last_cloud_change_id', '0', 0);

CREATE TABLE IF NOT EXISTS Cloud_Applied_Changes (
  ID_Change INTEGER PRIMARY KEY,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Device_Id TEXT,
  Applied_At_Ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_applied_ops
ON Cloud_Applied_Changes(Op_Id, Command_Name);

CREATE TABLE IF NOT EXISTS Local_Applied_Operations (
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Source TEXT NOT NULL,
  Applied_At_Ms INTEGER NOT NULL,
  PRIMARY KEY (Op_Id, Command_Name),
  CHECK (Source IN ('afterRemoteOk', 'cloudSync', 'outbox'))
);

CREATE INDEX IF NOT EXISTS idx_local_applied_source
ON Local_Applied_Operations(Source, Applied_At_Ms);

/* ---------------------------------------------------------
   Cloud_Apply_Failures
   Registro local de cambios remotos que NO se pudieron
   aplicar (BUG-009 / RM-P0-02). Permite avanzar el cursor
   sin perder la trazabilidad del fallo.
--------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS Cloud_Apply_Failures (
  ID_Change INTEGER PRIMARY KEY,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Device_Id TEXT,
  Error TEXT NOT NULL,
  Attempts INTEGER NOT NULL DEFAULT 1,
  Created_At_Ms INTEGER NOT NULL,
  Updated_At_Ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_apply_failures_op
ON Cloud_Apply_Failures(Op_Id, Command_Name);

CREATE INDEX IF NOT EXISTS idx_cloud_apply_failures_command
ON Cloud_Apply_Failures(Command_Name);

CREATE INDEX IF NOT EXISTS idx_cloud_apply_failures_created
ON Cloud_Apply_Failures(Created_At_Ms);

/* =========================================================
   12. Configuración
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
   14. Seeds
========================================================= */
INSERT OR IGNORE INTO Alergenos (Nombre, Nombre_Imagen, Ruta_Imagen) VALUES
  ('Gluten', 'gluten.png', '/alergenos/gluten.png'),
  ('Crustáceos', 'crustaceos.png', '/alergenos/crustaceos.png'),
  ('Huevos', 'huevos.png', '/alergenos/huevos.png'),
  ('Pescado', 'pescado.png', '/alergenos/pescado.png'),
  ('Cacahuetes', 'cacahuetes.png', '/alergenos/cacahuetes.png'),
  ('Soja', 'soja.png', '/alergenos/soja.png'),
  ('Lácteos', 'lacteos.png', '/alergenos/lacteos.png'),
  ('Frutos de cáscara', 'frutos_cascara.png', '/alergenos/frutos_cascara.png'),
  ('Apio', 'apio.png', '/alergenos/apio.png'),
  ('Mostaza', 'mostaza.png', '/alergenos/mostaza.png'),
  ('Sésamo', 'sesamo.png', '/alergenos/sesamo.png'),
  ('Sulfitos', 'sulfitos.png', '/alergenos/sulfitos.png'),
  ('Altramuces', 'altramuces.png', '/alergenos/altramuces.png'),
  ('Moluscos', 'moluscos.png', '/alergenos/moluscos.png');

INSERT OR IGNORE INTO Zonas (Nombre_Zona, Room_Points, Updated_At) VALUES
  ('Salon', '[]', datetime('now')),
  ('Terraza', '[]', datetime('now'));

INSERT OR IGNORE INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
VALUES ('BARRA', '[]', datetime('now'));

INSERT OR IGNORE INTO Mesas (
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
  (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = 'BARRA' LIMIT 1),
  'BARRA',
  0,
  0,
  0,
  'rect',
  1,
  1,
  NULL,
  datetime('now'),
  1
);

