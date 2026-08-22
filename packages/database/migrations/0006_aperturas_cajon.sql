/* =========================================================
   0006 — REGISTRO DE APERTURAS DEL CAJON

   Por que: el cajon portamonedas se abre solo al cobrar en efectivo, y eso
   ya queda trazado por el propio Pago. Lo que no deja rastro es abrirlo SIN
   una venta detras -para dar cambio, para cuadrar- y es justo por ahi por
   donde se va el dinero. En los TPV serios ese 'no sale' se registra: no
   para impedirlo (el camarero necesita abrirlo), sino para que exista la
   pregunta 'quien lo abrio a las 17:40'.

   Solo se anotan las aperturas MANUALES: las de un cobro se saben por su
   pago, y duplicarlas aqui seria ruido.

   Fecha la pone el dispositivo emisor; el outbox la congela a literal antes
   de replicar, igual que en Movimientos_Stock.
   ========================================================= */

CREATE TABLE IF NOT EXISTS Aperturas_Cajon (
  ID_Apertura TEXT PRIMARY KEY,
  ID_Usuario TEXT,
  Fecha DATETIME NOT NULL,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_aperturas_cajon_fecha
ON Aperturas_Cajon(Fecha);
