-- Borrar una categoria de productos se lleva sus productos: los que no tienen historia se borran y
-- los que la tienen se archivan (RI-54) y se quedan SIN categoria (ID_Categoria NULL), para que la
-- categoria se pueda borrar. Un archivado sin categoria no sale en ninguna lista: las estadisticas
-- ya no lo cuentan dentro de ninguna categoria, y sus ventas siguen en los totales. Lo hace la
-- aplicacion con sentencias en orden, igual en las dos implementaciones (SQL_QUITAR_CATEGORIA).
--
-- SQLite no quita un NOT NULL con ALTER: se copian las filas aparte, se vuelve a crear la tabla y se
-- devuelven, con las FK apagadas (las pone el runner, esquema.md). Sin RENAME, para que la tabla se
-- siga llamando Productos tal cual en el esquema y la vista que la lee no haya que tocarla.
CREATE TABLE Productos_Copia AS SELECT * FROM Productos;

DROP TABLE Productos;

CREATE TABLE Productos (
  ID_Producto TEXT NOT NULL PRIMARY KEY,
  ID_Categoria TEXT,
  ID_Proveedor TEXT,
  Nombre TEXT NOT NULL,
  Precio_Venta INTEGER CHECK (typeof(Precio_Venta) IN ('integer','null')),
  Stock_Minimo REAL DEFAULT 0,
  Unidad_Medida TEXT,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Cantidad_Pedido_Esperada REAL,
  -- VR-04: stock "suelto" fuera de lotes. Contador simple por producto, OPCIONAL (NULL = el producto
  -- no usa stock suelto y se vende sin descontar de aqui). Un cobro nunca toma de un lote mas de lo
  -- que tiene y lo que los lotes no cubren se descuenta de aqui, asi que es este contador el que
  -- queda negativo: la senal honesta de sobreventa. Un lote solo baja de 0 si dos cobros a la vez lo
  -- consumen y se replican (VR-06). El stock total mostrado de un producto es
  -- SUM(lotes) + COALESCE(Stock_Suelto, 0).
  Stock_Suelto REAL,
  -- Tipo de IVA propio del producto. NULL = "hereda el del negocio"
  -- (Business_Settings.IVA_Percent), que es el caso de casi todo: en hosteleria el consumo en el
  -- establecimiento va al tipo reducido, bebida incluida. Deja de valer en cuanto se vende algo
  -- para llevar envasado, tabaco o merchandising, que tributan a otro tipo.
  -- Es nullable a proposito y no DEFAULT 10: "no decidido" y "decidido que sea 10" son cosas
  -- distintas. Un producto que nadie ha tocado tiene que SEGUIR al tipo general si este cambia;
  -- un 10 escrito en la fila se quedaria congelado sin que nadie lo pidiera.
  IVA_Percent REAL,
  Archivado_En DATETIME,
  FOREIGN KEY (ID_Categoria) REFERENCES Categorias_Producto(ID_Categoria),
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor)
);

INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo,
  Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent, Archivado_En)
SELECT ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo,
  Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent, Archivado_En
FROM Productos_Copia;

DROP TABLE Productos_Copia;

CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_nombre_activo
ON Productos(Nombre) WHERE Archivado_En IS NULL;

CREATE INDEX IF NOT EXISTS idx_productos_categoria
ON Productos(ID_Categoria);

CREATE INDEX IF NOT EXISTS idx_productos_proveedor
ON Productos(ID_Proveedor);
