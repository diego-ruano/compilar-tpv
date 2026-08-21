/* =========================================================
   0004 — TIPO DE IVA POR PRODUCTO

   Por que: hasta ahora habia UN solo tipo de IVA para todo el negocio
   (Business_Settings.IVA_Percent) y el ticket calculaba base e IVA con el.
   Para un bar que solo sirve en local eso es correcto -en hosteleria el
   consumo en el establecimiento va al tipo reducido, bebida incluida-, pero
   deja de serlo en cuanto se vende algo para llevar envasado, tabaco o
   merchandising, que tributan a otro tipo. Y los tipos se han movido varias
   veces en los ultimos anos.

   NULL = "hereda el del negocio". Es deliberado que sea nullable y no un
   DEFAULT 10: un producto que nadie ha tocado tiene que SEGUIR al tipo general
   si este cambia, mientras que un 10 escrito en la fila se quedaria congelado
   sin que nadie lo pidiera. "No decidido" y "decidido que sea 10" son cosas
   distintas y la columna las distingue.

   Detalle_Comanda.IVA_Percent es un SNAPSHOT, igual que ya lo es
   Precio_Unitario: al vender una linea se copia el tipo vigente del producto.
   Sin eso, reimprimir un ticket del ano pasado lo sacaria con el tipo de hoy,
   que es justo lo que una reimpresion no puede hacer. Tambien nullable: una
   linea vendida antes de esta migracion no tiene tipo propio y cae al del
   negocio, como hasta ahora.

   Deterministica: solo ALTER TABLE ... ADD COLUMN (sin ids nuevos ni fechas),
   asi que Main y nube la aplican por separado y quedan identicas.
   ========================================================= */

ALTER TABLE Productos ADD COLUMN IVA_Percent REAL;

ALTER TABLE Detalle_Comanda ADD COLUMN IVA_Percent REAL;
