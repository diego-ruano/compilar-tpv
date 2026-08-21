/* =========================================================
   0005 — NUMERO DE TICKET

   Por que: el ticket impreso solo llevaba la fecha y la palabra VENTA. No
   habia forma de atar un papel a su cobro: ni para una devolucion, ni para
   cuadrar un arqueo, ni para el cliente que vuelve a reclamar. Y una
   reimpresion tiene que salir con el MISMO numero que el original, asi que
   el numero no puede calcularse al imprimir: se guarda con el pago.

   Contador unico y no una serie por dispositivo porque solo cobra la Main
   (ver 'solo la Main cobra'): con un unico escritor no hay que repartir
   numeros ni coordinar equipos sin conexion. Si algun dia vuelve a cobrar
   otro dispositivo, esto se convierte en una serie por dispositivo — de ahi
   que el numero sea TEXT y no un entero, para que el formato pueda crecer
   sin migrar los ya emitidos.

   Numero_Ticket es NULLABLE: los cobros anteriores a esta migracion no lo
   tienen, y su ticket se reimprime sin numero en vez de inventarle uno.

   Deterministica: DDL + una fila constante (sin ids nuevos ni fechas), asi
   que Main y nube la aplican por separado y quedan identicas.
   ========================================================= */

ALTER TABLE Pagos ADD COLUMN Numero_Ticket TEXT;

CREATE TABLE IF NOT EXISTS Ticket_Contador (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Ultimo INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO Ticket_Contador (ID, Ultimo) VALUES (1, 0);
