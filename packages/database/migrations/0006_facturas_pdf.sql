-- El PDF de cada factura completa (un alta de Registros_Facturacion con destinatario: F1, F3 y las
-- rectificativas con cliente). La Main lo compone una vez, despues del cobro o de la emision, lo
-- guarda en AppData/facturas/{ID_Registro}.pdf y lo sube a la nube, que lo guarda sin
-- sobrescribirlo (docs/arquitectura/tickets.md).

-- Lo que lleva hecho este equipo con cada una. Es estado local del equipo: empieza por _, se escribe
-- siempre por raw(), no se replica ni sale en los volcados. En la nube existe vacia (el esquema es
-- uno). Sin DEFAULT de hora: la pone quien escribe.
CREATE TABLE _Facturas_Pdf (
  ID_Registro TEXT NOT NULL PRIMARY KEY,
  -- El PDF local, relativo a AppData (facturas/{ID_Registro}.pdf). NULL hasta que lo hay.
  Ruta TEXT,
  -- De donde salio el local: compuesto aqui o bajado de la nube (el que se emitio, en un equipo
  -- restaurado).
  Origen TEXT CHECK (Origen IS NULL OR Origen IN ('generado', 'bajado')),
  Generado_Ms INTEGER,
  -- Cuando lo confirmo la nube: subido, ya estaba o bajado de ella.
  Subido_Ms INTEGER,
  -- Los intentos fallidos de componerlo seguidos, el ultimo error y cuando toca el siguiente (la
  -- espera crece con cada fallo). Un fallo de la red no cuenta.
  Intentos INTEGER NOT NULL DEFAULT 0,
  Ultimo_Error TEXT,
  Proximo_Intento_Ms INTEGER,
  -- La nube lo rechazo por lo que es (no es un PDF, demasiado grande): no se vuelve a subir.
  Apartado INTEGER NOT NULL DEFAULT 0 CHECK (Apartado IN (0, 1))
);

-- Las facturas completas, que son pocas entre los registros: el job las busca cada minuto por este
-- indice sin recorrer los tickets.
CREATE INDEX IF NOT EXISTS idx_regfact_completas
ON Registros_Facturacion(Orden)
WHERE Tipo = 'ALTA' AND Destinatario_Json IS NOT NULL;
