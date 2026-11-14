# 0008 · La base de cada negocio vive en su Durable Object

**Estado:** vigente.

## Contexto

Cada negocio tenía su base en Turso, y su `TenantHub` (el Durable Object que aplica y difunde las
escrituras) hablaba con ella por la red. Cada escritura pagaba ese viaje, a veces varias veces, y
traía consigo un token por negocio que había que rotar, un plazo por petición y toda la maquinaria de
AUD-18 para las confirmaciones inciertas: un lote que salió y del que no se sabe si entró. Los tests
del worker, en cambio, ya corrían sobre el SQLite del propio DO, no sobre Turso.

El DO tiene su propio SQLite, en la misma máquina que el código, con transacciones síncronas.

## Decisión

La base de cada negocio es el SQLite de su `TenantHub`, y **las rutas de negocio se ejecutan dentro de
ese DO**: el Worker autentica (token, firma y licencia, contra la base central) y le pasa la petición
entera (`lib/enElHub.ts`), así que cada petición cuesta un viaje al DO y no uno por consulta. Las
escrituras van por el motor del DO, como antes. La base central sigue en Turso. Los DO del negocio se
crean sin jurisdicción y con una pista de región de Europa occidental
([worker.md](../arquitectura/worker.md#la-base-del-negocio-dentro-de-su-tenanthub)).

## Consecuencias

- Una escritura no sale del objeto: entra o no entra, y se sabe en el acto. Desaparecen el token por
  negocio, su rotación, el plazo de red y la resolución de confirmaciones inciertas. Queda el turno del
  log, que ordena la difusión ([sincronizacion.md](../arquitectura/sincronizacion.md)).
- **Sobra la cola de entrada** (SYNC-18): existía porque cada operación costaba un viaje a Turso, y el
  DO guardaba el atraso de la Main para aplicarlo por su cuenta. Con la base dentro, la Main sube su
  outbox **por lotes síncronos** (`apply_lote`, hasta 200 operaciones por mensaje): el DO las aplica en
  un turno, cada una con su lote atómico, y el acuse lleva el veredicto de cada una. No hay estado
  intermedio («encolada, todavía no aplicada»), ni alarma, ni operaciones apartadas en la nube que la
  Main tenga que acusar.
- Los tests corren sobre el mismo motor que producción.
- El coste de una petición lo marca el viaje entre el Worker que atiende y el DO, no el SQL. Con la
  jurisdicción `eu`, el DO nace en un centro de la UE que no se elige (Frankfurt, Milán, Viena,
  Varsovia, Praga, Estocolmo, Bucarest…) y la pista de región no se respeta; sin jurisdicción, nace
  junto al primero que lo llama, o donde pida la pista. Por eso el responsable eligió no usar
  jurisdicción y poner la pista `weur`, que pide que el objeto nazca en Europa occidental aunque el
  primero que lo llame esté lejos; es una preferencia, no una garantía. Y por eso la ruta va entera
  al DO: con un solo viaje, dónde caiga pesa poco.
- **Un negocio es un hilo**: toda lectura de la Handy pasa por su DO, y una consulta pesada retrasa al
  resto del negocio mientras dura. Medido en local con medio año de un restaurante con mucho
  movimiento (58 MB): las ventas por día de un mes, 159 ms; las de seis meses, 657 ms.
- El SQLite del DO tiene límites que el de la Main no tiene (100 parámetros por sentencia, 32 MiB por
  llamada…), y una clave foránea aplazada que llega rota al confirmar resetea el objeto. Lo que eso
  obliga a escribir de otra forma está en [worker.md](../arquitectura/worker.md) y en
  [sincronizacion.md](../arquitectura/sincronizacion.md).
- La jurisdicción no se puede cambiar sin empezar de cero: el mismo nombre da otro objeto. Y la
  pista sólo cuenta al crear el objeto: uno que ya existe se queda donde nació.
- Una base se administra a través del worker, no con la CLI de Turso. Las copias propias de cada
  negocio están por hacer ([DO-03](../pendientes.md#do-03--copias-de-la-base-de-cada-negocio)).
- Lo que quedó en Turso de las bases de los negocios (su tabla en la base central, dos secretos y
  las propias bases) se retira a mano, tras desplegar
  ([DO-TURSO](../pendientes.md#do-turso--lo-que-queda-en-turso-de-las-bases-de-los-negocios)).
