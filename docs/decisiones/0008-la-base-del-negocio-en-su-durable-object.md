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
crean en la jurisdicción `eu` ([worker.md](../arquitectura/worker.md)).

## Consecuencias

- Una escritura no sale del objeto: entra o no entra, y se sabe en el acto. Desaparecen el token por
  negocio, su rotación, el plazo de red y la resolución de confirmaciones inciertas. Queda el turno del
  log, que ordena la difusión ([sincronizacion.md](../arquitectura/sincronizacion.md)).
- Los tests corren sobre el mismo motor que producción.
- El coste de una petición lo marca el viaje entre el Worker que atiende y el DO, no el SQL. Con
  `eu`, el DO nace en un centro de la UE que no se elige (Frankfurt, Milán, Viena, Varsovia, Praga,
  Estocolmo, Bucarest…) y la pista de región no se respeta; sin jurisdicción, nace junto al primero
  que lo llama. Por eso la ruta va entera al DO: con un solo viaje, dónde caiga pesa poco.
- **Un negocio es un hilo**: toda lectura de la Handy pasa por su DO, y una consulta pesada retrasa al
  resto del negocio mientras dura. Medido en local con medio año de un restaurante con mucho
  movimiento (58 MB): las ventas por día de un mes, 159 ms; las de seis meses, 657 ms.
- El SQLite del DO tiene límites que el de la Main no tiene (100 parámetros por sentencia, 32 MiB por
  llamada…), y una clave foránea aplazada que llega rota al confirmar resetea el objeto. Lo que eso
  obliga a escribir de otra forma está en [worker.md](../arquitectura/worker.md) y en
  [sincronizacion.md](../arquitectura/sincronizacion.md).
- La jurisdicción no se puede cambiar sin empezar de cero: el mismo nombre da otro objeto.
- Una base se administra a través del worker, no con la CLI de Turso. Las copias propias de cada
  negocio están por hacer ([DO-03](../pendientes.md#do-03--copias-de-la-base-de-cada-negocio)).
