/* =========================================================
   0003 — PERMITIR STOCK NEGATIVO EN LOS LOTES (VR-06)

   Por que: una venta de la Handy calcula su reparto FEFO contra el stock de la
   NUBE y se replica a la Main como deltas relativos (Stock_Disponible - N). Para
   que las dos copias converjan, ese delta tiene que aplicarse IGUAL en ambas; el
   clamp a cero (CASE WHEN ... < 0 THEN 0) que habia antes rompia esa igualdad:
   floreaba en una copia y no en la otra, inventando una divergencia silenciosa (o,
   sin clamp, chocaba con el CHECK y mandaba la op a cuarentena). Quitando el clamp
   Y el CHECK, el descuento es una operacion convergente y un lote puede quedar en
   negativo: es la senal de "sobreventa / recontad esto" que el bar corrige a mano
   (se avisa con una notificacion la primera vez por producto).

   SQLite no soporta ALTER TABLE ... DROP CONSTRAINT, asi que se reconstruye la
   tabla: crear la nueva sin el CHECK de Stock_Disponible, copiar, DROP la vieja y
   renombrar. El runner corre las migraciones con foreign_keys OFF (ver migrations.rs
   / tenantMigrations.ts), asi que el DROP NO cascadea a Movimientos_Stock ni viola
   la FK de Lote_Consumos; la integridad se verifica con foreign_key_check antes de
   confirmar.

   Se conserva el CHECK (Cantidad_Inicial >= 0): la cantidad con la que NACE un lote
   sigue sin poder ser negativa; lo que ahora puede bajar de cero es el disponible.

   Deterministica: solo DDL + copia de filas existentes (sin ids nuevos ni fechas),
   asi que Main y nube la aplican por separado y quedan identicas.
========================================================= */

-- La vista v_inventario_producto_stock depende de Lotes_Producto: SQLite no deja hacer DROP de una
-- tabla mientras una vista la referencia. Se suelta ahora y se recrea IDENTICA al final (quitar el
-- CHECK no cambia sus columnas). Es el paso 9 del procedimiento de rebuild de tabla de SQLite.
DROP VIEW IF EXISTS v_inventario_producto_stock;

CREATE TABLE Lotes_Producto_nuevo (
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
  CHECK (Cantidad_Inicial >= 0)
);

INSERT INTO Lotes_Producto_nuevo (
  ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad,
  Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas
)
SELECT
  ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad,
  Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas
FROM Lotes_Producto;

DROP TABLE Lotes_Producto;

ALTER TABLE Lotes_Producto_nuevo RENAME TO Lotes_Producto;

-- Los indices se van con la tabla vieja: se recrean identicos a 0001.
CREATE INDEX IF NOT EXISTS idx_lotes_producto_cad
ON Lotes_Producto(ID_Producto, Caducidad);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_stock
ON Lotes_Producto(ID_Producto, Stock_Disponible);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_entrada
ON Lotes_Producto(ID_Producto, Fecha_Entrada);

-- Recreacion IDENTICA de la vista (copiada verbatim de 0001, seccion 13). Ahora vuelve a apuntar a
-- la tabla reconstruida; su SUM(Stock_Disponible) suma tambien los negativos, que es lo deseado:
-- un lote sobrevendido resta del stock total del producto.
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
