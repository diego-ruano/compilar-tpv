-- 0004_movimientos_stock.sql
--
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
