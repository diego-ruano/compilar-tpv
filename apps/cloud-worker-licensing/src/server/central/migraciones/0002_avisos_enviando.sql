-- AVISO-CADUCIDAD · La marca de un aviso de caducidad es «enviando» hasta que el correo sale.
--
-- `enviando_hasta_ms`: mientras no es NULL, el aviso se está mandando, y la marca es de quien la
-- puso hasta esa hora; pasada, otro ciclo la puede retomar, porque no consta que haya salido (la
-- central falló al soltarla, o la marca entró y su respuesta no volvió). NULL: el aviso ha salido.
-- Las marcas de antes de esta columna son de avisos que se dieron por enviados, y quedan así.
-- `sent_at_ms` es cuándo se puso la marca (domains/licensing/avisosDeCaducidad.ts).
ALTER TABLE license_notices ADD COLUMN enviando_hasta_ms INTEGER;
