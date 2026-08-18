/* =========================================================
   0002 — TRAZA DEL CONSUMO DE STOCK SUELTO

   El problema que arregla: una venta consume primero de los LOTES (FEFO) y lo que
   estos no cubren se descuenta de Productos.Stock_Suelto (VR-04). El consumo de
   lotes queda anotado en Lote_Consumos, pero el del suelto no quedaba anotado en
   ninguna parte. Consecuencia: al anular un pago se devolvia a los lotes lo suyo y
   la parte suelta se perdia PARA SIEMPRE, porque no habia de donde reconstruirla.
   Y como ese contador puede quedar negativo a proposito (senal de sobreventa), la
   perdida no se distinguia de una sobreventa legitima.

   Esta tabla es el espejo de Lote_Consumos para el stock sin lote: misma forma,
   misma clave por linea de comanda y mismo ON DELETE CASCADE. Con ella la anulacion
   puede devolver lo suelto igual que devuelve los lotes.

   Tambien es la otra mitad del invariante de reconciliacion (INV-06): el stock de un
   producto es SUM(lotes) + Stock_Suelto, asi que sin traza del suelto solo se podia
   cuadrar la mitad.

   ADITIVA: crea una tabla y su indice. No toca nada existente.
========================================================= */

CREATE TABLE IF NOT EXISTS Suelto_Consumos (
  ID_Detalle  TEXT NOT NULL,
  ID_Producto TEXT NOT NULL,
  Cantidad    REAL NOT NULL,
  PRIMARY KEY (ID_Detalle, ID_Producto),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE,
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto),
  CHECK (Cantidad > 0)
);

-- Reconciliacion por producto (INV-06) y devolucion al anular un pago.
CREATE INDEX IF NOT EXISTS idx_suelto_consumos_producto
ON Suelto_Consumos(ID_Producto);

/* ---------------------------------------------------------
   REPARACION: lotes creados sin ID_Lote

   El alta de un producto con stock desde la pantalla de Proveedores omitia la
   columna ID_Lote en el INSERT, y SQLite admite NULL en una PRIMARY KEY de tipo
   TEXT. Esos lotes quedaban INVISIBLES para el consumo FEFO (que descarta los que
   no tienen id): su stock se veia en Inventario pero no se descontaba nunca, y la
   venta se iba entera al stock suelto. El worker si ponia un UUID, asi que ademas
   los dos motores hacian cosas distintas.

   El id se deriva de (ID_Producto, Codigo_Lote), que es UNIQUE: asi la Main y la
   nube reconstruyen EL MISMO id al aplicar cada una esta migracion por su cuenta.
--------------------------------------------------------- */

UPDATE Lotes_Producto
SET ID_Lote = 'lote-0002-' || ID_Producto || '-' || Codigo_Lote
WHERE ID_Lote IS NULL;

/* ---------------------------------------------------------
   RECONSTRUCCION DEL ALTA (INV-01b / INV-06)

   El invariante de reconciliacion es:
       Stock_Disponible == SUM(Movimientos_Stock.Delta) - SUM(Lote_Consumos.Cantidad)

   Para que se sostenga, todo lote necesita su movimiento de origen. Los creados
   desde Inventario ya lo tenian; los creados desde Proveedores no. Se reconstruye
   con la cantidad inicial y la fecha de entrada del propio lote.

   El id del movimiento tambien se deriva del lote (mismo motivo: los dos motores
   aplican esta migracion por separado y deben coincidir).
--------------------------------------------------------- */

INSERT INTO Movimientos_Stock
  (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
SELECT
  'alta-0002-' || l.ID_Lote,
  l.ID_Lote,
  'ALTA',
  COALESCE(l.Cantidad_Inicial, 0),
  COALESCE(l.Cantidad_Inicial, 0),
  'Alta reconstruida por la migracion 0002',
  NULL,
  l.Fecha_Entrada
FROM Lotes_Producto l
WHERE NOT EXISTS (
  SELECT 1 FROM Movimientos_Stock m
  WHERE m.ID_Lote = l.ID_Lote AND m.Tipo = 'ALTA'
);
