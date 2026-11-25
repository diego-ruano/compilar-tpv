# 0009 · La base central en su Durable Object

**Estado:** vigente (2026-11-25).

## Contexto

- La base central del worker es una para todo el servicio: negocios, dispositivos, licencias, cobros
  de Stripe, emparejamientos, códigos por correo, claves y dominios de la reserva web, interruptores
  remotos, versiones de la app y la auditoría de la administración. Toda petición autenticada pasa
  por ella (`tenantAuth` lee el dispositivo y la licencia), y el `TenantHub` de cada negocio le
  pregunta quién es su Main.
- Estaba en Turso (la base `tpv-control`), y el Worker y cada `TenantHub` le hablaban por la red con
  `@libsql/client`. Desde [0008](0008-la-base-del-negocio-en-su-durable-object.md) era lo único que
  quedaba fuera de Cloudflare: un proveedor y un token más, un viaje de red por consulta y, en lo que
  lee, decide y escribe (canjear una clave, emitir o revertir un cobro, anular una licencia),
  transacciones interactivas que tenían la conexión abierta mientras el Worker decidía. Los tests de
  la central hablaban con un doble, no con el motor de producción.
- El responsable pidió sacarla con tres condiciones: el mismo comportamiento de negocio, la
  integridad garantizada y «que funcione el 99 %».
- Se estudiaron D1 y un Durable Object. D1 no tiene transacciones interactivas: cada operación que
  decide tendría que reescribirse como un lote con la decisión en SQL, una fila con un `CASE` que
  repite a mano el `WHERE` de cada escritura y las escrituras condicionadas por un marcador que el
  código sustituye. Si los dos predicados dejan de coincidir, o el marcador se queda sin sustituir
  (entonces es un comentario), la escritura entra sin condición y sin error. Y en D1 las claves
  foráneas no se pueden apagar: una migración que reconstruye una tabla padre borra en cascada sus
  hijas ([D1, foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)). En un
  Durable Object cada transacción se queda casi literal: el mismo SQL, en el mismo orden, dentro de
  `transactionSync`, sobre el mismo motor que la base de cada negocio.

## Decisión

- **La base central es el SQLite de un Durable Object, `BaseCentral`**, uno solo para todo el
  servicio y en el mismo Worker `tpv-api` ([0006](0006-un-solo-worker.md)): un Worker aparte no
  aporta nada. Se pide sólo con `centralDe` (`lib/objetosDelNegocio.ts`), con un nombre fijo,
  **sin jurisdicción**, que es lo que da menos latencia (como los objetos de los negocios), y con la
  pista de región de Europa occidental. Su nombre y su sitio son suyos y constantes: no salen de
  `JURISDICCION_DO` ni de `UBICACION_DO`.
- **Lo que lee, decide y escribe es una operación del objeto** (`server/central/operaciones/`):
  canjear una clave, emitir y revertir un cobro, anular y desanular una licencia, y sumarle y
  restarle meses. Corre entera en una transacción del objeto, con el mismo SQL y en el mismo orden
  que antes. Lo que tiene que esperar (cifrar una clave, Stripe, el correo, avisar a un `TenantHub`)
  lo hace el Worker antes o después.
- **Lo demás son sentencias sueltas y lotes todo o nada**, como antes, por un adaptador
  (`clienteCentral`, `server/central/cliente.ts`) con la misma forma que el cliente de la base del
  negocio (`lib/sql.ts`), y con un enlace de argumentos estricto, que guarda y rechaza lo mismo que
  la central siempre ha guardado (`server/central/enlace.ts`).
- **Su esquema son migraciones en código** (`server/central/migraciones/`), que aplica el propio
  objeto. El objeto no crea su esquema solo: lo aprovisiona la administración.
- **Se copia a sí mismo cada día a R2**, y la administración lo restaura desde una copia o lo
  devuelve a un instante de los últimos 30 días (`pnpm central:*`,
  [restaurar-la-central.md](../guias/restaurar-la-central.md)).
- Los tests hablan con un objeto `BaseCentral` de verdad. Un oráculo de equivalencia fijó, con el
  código de antes, lo que dejan hechas las operaciones en 40 escenarios conducidos por HTTP, y lo
  compara (`test/oraculoCentral.test.ts`).

Cómo funciona por dentro: [worker.md](../arquitectura/worker.md#la-base-central).

## Consecuencias

- **Una operación entra entera o no entra, y se sabe en el acto**: no hay conexión abierta mientras
  el Worker decide, ni una confirmación que se pierde por la red. Lo vigilan
  `test/centralCarreras.test.ts` (la misma operación pedida varias veces a la vez),
  `test/centralFalloInyectado.test.ts` (un fallo tras cada sentencia de cada operación, sin que
  quede nada escrito) y el oráculo.
- Desaparecen el token de la base, su secreto y su rotación, el plazo de red de cada consulta del
  Worker, el doble de los tests y la librería. La base de antes se traspasa al objeto por el mismo
  camino que una copia y se borra.
- **El viaje que se paga es el RPC** entre el Worker que atiende (o el `TenantHub`) y el objeto. Su
  latencia aún no se ha medido en producción.
- **La central es un hilo para todo el servicio**: atiende de una en una lo de todos los negocios, y
  mientras se copia no atiende a nadie. Hoy no aprieta; lo que habría que hacer al crecer está en
  [pendientes.md](../pendientes.md) (CENTRAL-AUTH, SOCKET-DISPERSION).
- **Otro nombre o una jurisdicción dan otro objeto, vacío y sin error**, y la pista sólo cuenta en la
  primera llamada. Por eso el objeto no atiende sin aprovisionar (`central_sin_aprovisionar`) en vez
  de crear un esquema vacío y contestar que no existe ninguna licencia.
- **Desde el despliegue que crea la clase (`v3` en `wrangler.json`), `wrangler rollback` no puede
  volver a una versión anterior a él**: un cambio en el ciclo de vida de una clase de Durable Object
  bloquea el rollback a través de él
  ([rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)).
  Lo que falle se arregla hacia delante.
- **El plazo con el que el `TenantHub` le pregunta suelta a quien espera, pero no cancela la
  llamada**, y mientras tanto el `TenantHub` no hiberna. Se acepta: sólo pasa si la central tarda
  más que el plazo ([worker.md](../arquitectura/worker.md#el-plazo-del-tenanthub-central-plazo)).
- Restaurar desde una copia va en una sola llamada, que no puede pasar de 30 s: el cron avisa antes
  de llegar (CENTRAL-RESTAURAR, en [pendientes.md](../pendientes.md)).

### Reglas que impone

- **Una operación es síncrona de principio a fin**: ni `async`, ni `await`, ni promesas, ni nada de lo
  que importa. Una espera dentro abriría el objeto a otras llamadas a mitad de la transacción, y lo
  escrito después quedaría fuera de ella sin avisar. Lo que devuelve es un dato (lo que pasa por el
  RPC), y un resultado de negocio es un valor, no una excepción. Un nombre de operación no cambia
  nunca de significado: una que cambia lleva un nombre nuevo. Lo vigila
  `test/centralOperaciones.node.test.ts`, que lee el fuente.
- **El objeto se pide sólo por `lib/objetosDelNegocio.ts`** (`centralDe`), con un stub nuevo en cada
  viaje (`test/objetosDelNegocio.node.test.ts`). La central nunca llama a otro objeto: lo que hay
  que avisar después de escribir lo avisa quien llama.
- **Lo que la central no ha hecho viaja como valor, con su código** (`central_*`), nunca como una
  excepción que haya que clasificar por su texto, y nunca como filas vacías: «la central no
  contesta» no puede leerse como «esa licencia no existe».
- **Cuando no puede atender** (saturada, un fallo pasajero, un plazo vencido, cualquier otro rechazo
  del viaje, sin aprovisionar, averiada o a medias), **contesta 503 `external`**: `hub_overloaded` (con `Retry-After`) o
  `hub_unavailable`, lo mismo que el objeto de un negocio. Los clientes lo tratan como la nube sin
  contestar y repiten. **Nunca una respuesta que diga algo de la licencia o del equipo**, como
  `license_not_found`: la Main la toma por un rechazo (deja de replicar y sigue con la gracia sin
  conexión, [licencias.md](../arquitectura/licencias.md#el-gate)) y la Handy se queda fuera.
- **Un solo hilo**: toda ruta anónima que lee la central lleva delante un filtro por IP o una caché
  (`test/centralAnonimas.test.ts`), y lo que cada petición autenticada lee de ella va en cachés de un
  minuto por isolate.
- **Su esquema se cambia con una migración nueva, aditiva, en un despliegue anterior al del código
  que la usa**: durante un despliegue conviven el código de antes y el de ahora, a los dos lados
  del RPC ([worker.md](../arquitectura/worker.md#su-esquema-migraciones-en-código)).
- **La central nunca atiende a medias**: ni con una restauración sin terminar ni con una vuelta a
  un instante en curso, se esté preparando o esté preparada y sin aplicar. Contestaría como
  definitivo lo que no lo es: que una licencia no existe (el TPV no la borra, pero se bloquea al
  agotar la gracia sin conexión), que un código o una clave no valen.
