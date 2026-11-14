# El worker `tpv-api`

Un único Cloudflare Worker (`apps/cloud-worker-licensing/`, desplegado como `tpv-api`; la carpeta
conserva su nombre) sirve todo lo que es nube: la API de datos de la Handy, el Durable Object
`TenantHub`, el emparejamiento, las licencias, la compra por Stripe, la administración, las
actualizaciones, el correo, las imágenes y la telemetría. El cliente Rust apunta a él con
`CLOUD_API_BASE` (`crates/tpv-infra-licensing/src/lib.rs`), también para el WebSocket
(`crates/tpv-infra-http/src/websocket.rs`): `https://tpv-api.altarialights.workers.dev`. Desde ahí se
sirven también el widget de las reservas web y su API pública; la dirección que queda pegada en las
webs y en los correos es `RESERVAS_WEB_ORIGEN`, hoy la misma. No es un nombre propio de
`altarialights.com` a propósito: los de esa zona salen por IP que los operadores españoles bloquean
cuando hay fútbol (INFRA-04; el porqué, junto a `CLOUD_API_BASE`).

## Mapa

| Ruta | Dominio | Quién la usa |
|---|---|---|
| `GET /health` | `server/salud.ts` | La sonda externa |
| `GET /ws`, `/v1/ws` | `src/app.ts`, `domains/ws` | El WebSocket del `TenantHub` (con ticket de un solo uso, canjeado en `domains/ws/canje.ts`) |
| `/v1/clientes`, `/configuracion`, `/cuentas`, `/inventario`, `/login`, `/mesas`, `/notificaciones`, `/proveedores`, `/reservas`, `/stats`, `/tareas`, `/trabajadores`, `/venta-rapida` | `domains/<dominio>/` | La Handy (lecturas y escrituras de negocio) |
| `/v1/sync/*` | `domains/sync/` | La Main: catch-up, volcado, histórico, contraste ([sincronizacion.md](sincronizacion.md)) |
| `/v1/images/*` | `domains/images/` | Subir, servir y borrar imágenes en R2 |
| `/v1/email/*` | `domains/email/` | Pedidos a proveedores |
| `/v1/pair/*`, `/v1/device/*` | `domains/pairing/` | Emparejamiento ([emparejamiento.md](emparejamiento.md)) |
| `/v1/license/*`, `/v1/stripe/*`, `/v1/admin/*` | `domains/{licensing,stripe,admin}/` | Licencias ([licencias.md](licencias.md)) |
| `/v1/interruptores` | `domains/interruptores/` | La Main ([jobs-e-interruptores.md](jobs-e-interruptores.md)) |
| `/v1/update/*` | `domains/updates/` | El updater de escritorio y la publicación ([publicar-version.md](../guias/publicar-version.md)) |
| `/v1/telemetry/*` | `domains/telemetry/` | Reenvío de eventos ([observabilidad.md](observabilidad.md)) |

Cada dominio de negocio tiene `*.routes.ts` (rutas), `*.queries.ts` (lecturas), `*.commands.ts`
(escrituras, que se aplican por el `TenantHub`) y `*.schemas.ts` (zod). Bindings (`wrangler.json`): los
DO `TenantHub` y `AgendaWeb` (SQLite), R2 `tpv-images` (público por `r2.dev`) y `tpv-copias-control`
(privado), `send_email` (`EMAIL`), los limitadores por IP `LIMITADOR_CLAIM` y `LIMITADOR_LICENCIA`
(`lib/limitador.ts`) y el cron diario `0 7 * * *`.

RI-46: los bindings de R2 son exclusivamente `IMAGES` y `COPIAS`. En desarrollo local, R2 y
`EMAIL` se simulan; no llevan `remote: true`. La base central sigue siendo la Turso de siempre.
La fecha de compatibilidad (`2026-05-29`) coincide con el runtime instalado; los tests reutilizan
el mismo `wrangler.json` con el entorno pisado ([los tests no salen a la red](#los-tests-no-salen-a-la-red))
y los tipos se regeneran con `pnpm cf-typegen`.

## Dos bases, y sólo una se migra desde el código

- **La base de cada negocio** vive en el SQLite de su `TenantHub` y se construye con las migraciones
  de `packages/database/migrations/`, registradas a mano en `src/server/tenantMigrations.ts`
  ([esquema.md](esquema.md)). La crea el alta (`aprovisionar`) y el DO la pone al día la primera vez
  que la toca tras un despliegue (`migrarBaseLocal`), sin atender nada más mientras tanto. Si no
  puede, el negocio contesta 503 `tenant_db_migration_failed` y el DO avisa
  ([esquema.md](esquema.md#si-la-migración-falla-en-la-nube)).
- **La base central** (control-plane: licencias, tenants, dispositivos, emparejamientos, interruptores,
  correo, releases…) está en Turso y **no cambia de estructura desde el código**: el worker lee y
  escribe filas, nunca hace `CREATE`, `ALTER` ni `DROP`. Su estructura se cambia **a mano en Turso,
  antes de desplegar** el worker que la use, y se refleja en `docs/sql/control-plane/esquema-actual.sql`,
  que es lo único que la documenta y lo que cargan los tests (`test/helpers/planoDeControl.ts`).

### La base del negocio, dentro de su `TenantHub`

- **Las rutas de negocio se ejecutan dentro del DO** (`lib/enElHub.ts`): un viaje por petición, no
  uno por consulta. El Worker resuelve lo que depende de la base central (`tenantAuth`: token, firma
  del dispositivo y licencia) y, si el router lleva `alHub` detrás de `tenantAuth`, le pasa la petición
  entera al `TenantHub` del negocio por RPC (`ejecutarRuta`), con la identidad como argumento y nunca
  en una cabecera. El DO ejecuta la misma `app` (`app.ts`); dentro, `tenantAuth` se fía de esa
  identidad, y los demás middlewares del router (vetos de rol, validación) corren allí una vez. Un
  router nuevo que lea o escriba la base del negocio lleva `alHub`; uno que sólo toque la central, R2
  o el correo, no. No hay otra forma de ejecutar una ruta de negocio: un test que monta un router
  suelto declara el doble de `alHub` (`test/helpers/rutaSuelta.ts`) y la ruta corre allí mismo.
- **Una ruta que lee la base del negocio va dentro aunque el resto de lo que hace sea de fuera.** El
  pedido a un proveedor (`/v1/email/enviar-pedido`) y el aviso de una reserva web
  (`/v1/reservas-web/avisos`) leen la base del negocio y además reservan cupo en la base central,
  piden un enlace a la `AgendaWeb` y mandan el correo: todo eso se hace desde el `TenantHub`, con su
  mismo entorno (`test/correoEnElHub.test.ts`). Mientras espera a la red, el DO atiende lo demás. En
  un router donde sólo una ruta lee la base del negocio, `alHub` va sólo en ella:
  `xRoutes.use("/ruta", alHub)` detrás del `use("*", tenantAuth)` (`reservas_web/main.routes.ts`).
- **La identidad lleva el rol del dispositivo** (`IdentidadDelWorker.rol`, `tpv` o `handy`). El
  Worker lo lee de la fila de `devices` al autenticar, en la misma consulta que la clave pública
  (`server/middleware/auth.ts`), y lo guarda con ella: 60 s por isolate, y sólo de un dispositivo
  vivo con su clave. Dentro del DO los vetos de rol (`soloLaMain…`) deciden con ese rol y no vuelven
  a la base central; así, con el dispositivo y la licencia en caché, una petición no la toca. Una
  baja se nota al caducar esa entrada, lo mismo que tarda `tenantAuth` en rechazar al dispositivo en
  cualquier otra ruta. En un router sin `alHub` (el emparejamiento, los dispositivos, las reservas
  web de la Main) el veto corre en el Worker (`soloLaMainVigente`) y lee la fila viva y la licencia,
  sin caché (`rolDelDispositivo`, `vetoDeLicencia`). Lo cubren `test/rolEnLaIdentidad.test.ts` y
  `test/mainDesplazadaRest.test.ts`.
- **Una petición de un `tpv` que el hub no tiene por la Main no se ejecuta** (AUD-02,
  `MotorTenantHub.vetoDeMain`), en ninguna ruta: es lo que rechaza el veto de licencia del Worker,
  que guarda su respuesta un minuto por isolate. El hub lo sabe al momento por su tabla
  ([sincronizacion.md](sincronizacion.md#quién-es-la-main-dentro-del-tenanthub-aud-02)); la Main de
  verdad no paga nada, y la que no cuadra pregunta a la base central antes de que se la rechace.
- **Las escrituras** van por el motor del DO (`aplicar`, o el WebSocket de la Main). **Las lecturas**,
  por `tenantQuery` (`lib/tenantClient.ts`): un `Client` con la forma del de libsql sobre el SQLite
  del DO (`tenantHub.sqlite.ts`). Sólo dentro del DO: toda ruta que lo usa lleva `alHub`, y fuera
  lanza (un router sin `alHub` que lee la base del negocio es un fallo). Un lote de lectura da una
  foto coherente: el SQL del DO es síncrono y nada se intercala.
- **Desde fuera del DO no se lee consulta a consulta, ni hay una puerta que acepte SQL.** La agenda
  de reservas web (otro DO) y las rutas públicas de la reserva (sin dispositivo, no van por `alHub`)
  piden **una lectura entera, por su nombre** (`leerParaLaWeb`, RPC `TenantHub.leerParaLaWeb`,
  `domains/reservas_web/lecturasDeLaWeb.ts`): el TenantHub la ejecuta con su base al lado, con «ahora»
  fijado a la hora del negocio, y devuelve lo que la agenda o la ruta necesitan. Un viaje por lectura:
  el día de la agenda eran cinco consultas y tres viajes seguidos. Lo que la lectura necesita del
  estado de la agenda se le pasa en sus datos, y lo que devuelve cruza el RPC por copia estructurada
  (`Map` y `Set` incluidos, `test/baseEnElDo.test.ts`). Sólo leen: la reserva web no escribe en la base
  del negocio (ADR 0007).
- **Lo único que una ruta escribe sin pasar por el motor es el estado propio de la nube**, que no
  se replica: el freno del PIN (`Intentos_Login`), el checkpoint de cada Main, que es el suelo de la
  purga (`Sync_Main_Checkpoints`), y el resumen diario de las estadísticas (`_Estad_*`, una caché que
  se rehace desde los cobros: [esquema.md](esquema.md#el-resumen-diario-de-las-estadísticas-17-de-0001)).
  Lo escribe dentro del DO, con el cliente de al lado: las rutas que lo tocan (el PIN,
  `/v1/sync/changes`, las estadísticas de productos y de mesas) llevan `alHub`, y desde fuera no hay
  puerta que escriba. El resumen de un día entra en un lote todo o nada, y sólo si todas sus
  sentencias escriben en sus tablas (`resumenDiario.ts::anotarResumen`).
- **El alta siembra el administrador inicial dentro del DO** (`aprovisionar`,
  `tenantHub.alta.ts`): el esquema y, si la base nace sin usuarios, su administrador, sin SQL que
  viaje desde el Worker. Contesta si la base ya estaba (`reused`). No va por el motor porque la Main
  siembra el mismo administrador, con el mismo id, en la suya.
- **El objeto sabe de qué negocio es, y sólo atiende al suyo** (DO-NEGOCIO,
  `tenantHub.negocio.ts`). El alta lo apunta en el sello de su base (`_Negocio`, el mismo de la base
  local de la Main), y toda llamada que trae un negocio se contrasta con él antes de hacer nada:
  `ejecutarRuta`, `aplicar`, `leerParaLaWeb`, `aprovisionar`, `releerMain` y la apertura
  del WebSocket (después, el negocio de una sesión es el de su attachment). El Worker ya llega al
  objeto por el nombre del negocio, así que es la segunda comprobación: si salta es un fallo del
  programa, `negocio_ajeno` (500), a Sentry una vez por instancia y a Axiom cada vez. Un objeto con
  base de antes de que se apuntara se queda con el negocio de la primera llamada que le llega, que
  viene del Worker por ese mismo nombre; uno sin base no apunta nada. Con el negocio apuntado, los
  eventos de salud lo llevan aunque la instancia la haya despertado un socket, sin ninguna llamada
  que se lo diga. Lo cubre `test/negocioDelHub.test.ts`.
- **Si el viaje al DO falla, no es un fallo del programa** (`alHub`, `lib/enElHub.ts`). Lo que una
  ruta lanza dentro del DO lo recoge allí su `onError`; una excepción de `ejecutarRuta` es que el
  objeto no ha podido atender, y Cloudflare dice por qué en el propio error:
  - `overloaded`: 503 `hub_overloaded` con `Retry-After`. No se repite: sería más carga.
  - `retryable` (el objeto se reinicia tras un despliegue, su almacenamiento no contestó): si es una
    lectura (un GET, o un POST declarado con `lecturaPorPost()`), se repite una vez con una petición
    y un stub nuevos. Una escritura no: la repite el cliente con su misma `X-Idempotency-Key`.
  - lo demás, o la repetición que también falla: 503 `hub_unavailable`.

  Los dos salen como `external` (lo que la Main y la Handy tratan como la nube sin disponibilidad),
  quedan en Axiom (`hub_no_disponible`) y, si la plataforma no lo da por pasajero, van también a
  Sentry (`hub.ejecutar_ruta`). Lo cubre `test/alHubSinElObjeto.test.ts`.
- Dentro del DO **un negocio es un hilo**: una ruta lenta (un PIN, que cuesta un PBKDF2 de 100.000
  vueltas, o unas estadísticas de meses) retrasa al resto del negocio mientras dura, la Main incluida.
  Por eso una estadística que crece con el rango pedido lo recorre **una vez por petición**: la de
  productos es una sola sentencia (`sqlProductos`, en `domains/stats/stats.queries.ts`) que devuelve
  las unidades por producto y el catálogo, y el mejor, el peor y los dos top 10 se sacan de ahí en
  código. Y las de productos y de mesas no recorren los cobros de los días ya cerrados: los leen del
  resumen diario ([esquema.md](esquema.md#el-resumen-diario-de-las-estadísticas-17-de-0001)), y
  antes rehacen los días sucios del rango de uno en uno, cediendo el paso entre uno y otro
  (`resumenAlDia`, en `domains/stats/resumenDiario.ts`). Un CTE repetido en varias sentencias se
  vuelve a calcular en cada una. Dentro de una misma
  sentencia lo decide el planificador: el de los clientes recurrentes, que tiene que mirar los
  cobros de toda la historia y lo leen tres partes de la sentencia, va `AS MATERIALIZED` porque sin
  esa marca SQLite lo deshace dentro de cada una. La Main hace lo mismo (`sql_productos` y `sql_clientes_recurrentes`,
  en `tpv-infra-sqlite/src/stats.rs`), el arnés de lectura fija que las dos dan el mismo resultado y
  el plan de las dos sentencias tiene su test en cada lado.
- **Un objeto sin base no dice por qué lo está** (DO-PERDIDA, `lib/basePerdida.ts`): el negocio no
  ha nacido todavía, o su base está en otro objeto (el despliegue apunta a otro espacio de nombres o
  a otra jurisdicción) o se ha perdido. Lo distingue la base central, sin cambiar su esquema: un
  negocio nace al activarse su primera licencia, y la activación crea la base **antes** de apuntar la
  licencia (`activateLicenseFirstTime` es lo único que escribe `activated_at_ms`). Así que una
  licencia suya con `activated_at_ms` prueba que su base existió. Lo que sale de ahí:
  - una ruta autenticada que se encuentra sin base contesta `tenant_db_not_provisioned` (404) si el
    negocio no ha nacido y `tenant_db_perdida` (503, `external`) si ya nació (`app.onError`), con un
    aviso a Sentry y a Axiom, uno cada diez minutos por negocio e isolate. Sólo con lo primero ofrece
    la Main crear una base vacía, y un equipo con licencia ya no se lo encuentra: su activación creó
    la base;
  - una base sólo se crea para un negocio que no ha nacido (`provisionTenantDatabase`, por donde
    pasan la activación y `/v1/sync/initialize-empty`). La activación de uno que ya nació (el mismo
    equipo que vuelve o el nuevo de un traslado) mira que su base esté antes de gastar el código y de
    tocar la fila del equipo, y no crea una vacía en su lugar;
  - si la base central no contesta, no se sabe: 500, y no se crea ni se ofrece nada;
  - el socket de la Main no pasa por aquí: su `apply_lote` sigue recibiendo `tenant_db_not_provisioned`,
    que para su outbox es pasajero.

  Otro camino que activara una licencia tendría que crear antes la base. Lo cubre
  `test/basePerdida.test.ts`; lo que queda sin salida, en
  [DO-PERDIDA](../pendientes.md#do-perdida--un-negocio-que-se-queda-sin-su-base-en-la-nube-no-tiene-salida-sin-soporte).
- **Sin jurisdicción, con pista de Europa occidental** (`JURISDICCION_DO` vacía y
  `UBICACION_DO = "weur"` en `wrangler.json`): los DO del negocio (`TenantHub` y `AgendaWeb`) se
  piden en Europa occidental, para que nazcan ahí aunque quien los llame primero esté en otro sitio,
  como el visitante de una web que reserva desde otro continente. Lo decidió el responsable, por
  latencia: dentro de la jurisdicción `eu` el objeto nace en un centro de la UE que no se elige y la
  pista de región no se respeta (medido el 2026-11-12 con objetos de usar y tirar en cada
  colocación). La pista sólo cuenta en la llamada que crea el objeto, y es una preferencia, no una
  garantía: Cloudflare la sigue cuando puede, y hoy un objeto no se muda después de creado.
- **Todo el que pide el objeto de un negocio pasa por `lib/objetosDelNegocio.ts`** (`hubDe`, en
  `lib/hub.ts`, y `agendaDe`, en `durableObjects/agendaWeb.ts`), que aplica la jurisdicción y la
  pista del despliegue. Nadie le pide un objeto a `env.TenantHub` o a `env.AgendaWeb` por su cuenta:
  el mismo nombre da otro objeto en otra jurisdicción, y una llamada sin la pista podría crearlo
  lejos. Por lo mismo, cambiar `JURISDICCION_DO` con negocios dados de alta es empezar de cero. En
  local y en los tests las dos van vacías: workerd no implementa jurisdicciones.
- **Límites del SQLite del DO** que no tiene el de la Main: 100 parámetros por sentencia, patrones de
  `LIKE` de 50 bytes, 5 `SELECT` por compuesto, 100 KB por sentencia, unos 2 MB por valor (uno de
  3 MB se rechaza) y 10 GB por objeto. Una lista de IDs de tamaño variable va como un único parámetro JSON:
  `IN (SELECT value FROM json_each(?))`, nunca un `?` por elemento: así entran en la nube «Ver tickets»
  de un día con cientos de tickets, el cobro de un ticket de barra de más de 99 líneas, un plano con
  más de 100 zonas o de 98 mesas en una zona y una tarea con más de 99 asignados (DO-01). Lo
  comprueban `test/sondaSqliteDo.test.ts` (el límite), los casos de contrato de 120 elementos
  (`*_120_*`) y `test/listasEnUnParametro.test.ts`, que lee el fuente y falla si una sentencia
  vuelve a componer un `?` por elemento.
- **Lo que teclea el usuario se busca con `instr(${normalizada(col)}, ?) > 0`, nunca con `LIKE`**: un
  patrón de `LIKE` con un texto de más de 50 bytes (49 letras, o 25 con acento) no pasa del DO, y en un
  patrón el `%` y el `_` tecleados son comodines. Así buscan los productos de las mesas y de la barra
  y los listados de caja, y la Main busca igual para devolver las mismas filas. Un `LIKE` con un
  patrón fijo y corto (`LIKE '%:%'`) no tiene ese problema. Lo vigila `test/busquedaDeTexto.test.ts`,
  que lee el fuente de los dominios.
- **Y sin acentos ni mayúsculas**: «café» encuentra «CAFÉ Solo» y «CAÑA», «Caña». El `lower()` de
  SQLite sólo baja las letras ASCII y el DO no admite funciones propias, así que `normalizada(col)`
  (`lib/busqueda.ts`) es SQL corriente: `lower()` y un `replace()` anidado por cada letra acentuada
  y cada acento suelto (un texto escrito descompuesto). El parámetro pasa por `textoABuscar`, que
  hace en código exactamente lo mismo y nada más: un `toLowerCase()` bajaría letras que la columna
  deja como están. La Main fabrica la misma expresión (`tpv-infra-sqlite/src/busqueda.rs`), y las dos
  salen de las tablas de `crates/tpv-domain/src/busqueda_casos.json`, que leen los dos lados
  (`test/busquedaSinAcentos.test.ts`). Una columna ya normalizada al escribir no sirve aquí: los
  listados de caja buscan en un texto que se compone al leer (mesa, cliente, método e importe).
- **Una llamada entre el worker y el DO tiene un tope de 32 MiB**, en los dos sentidos: lo que se le
  pasa y lo que devuelve como valor. El cuerpo de la respuesta de una ruta que se ejecuta dentro del
  DO no lo tiene: viaja como flujo (comprobado en local con 40 MiB).
- **Los volcados de sync** (`/v1/sync/bootstrap` e `/historico`, y las páginas del contraste) no leen por
  `tenantQuery`: dentro del DO recorren el cursor de su SQLite una vez y escriben cada fila una vez,
  ya como bytes de la respuesta (`domains/sync/volcado.ts`), sin un objeto por fila ni el texto del
  JSON entero. Lo escrito tiene un techo, `VOLCADO_MAX_BYTES` (24 MiB de JSON sin comprimir), además
  del tope de filas: cabe en la memoria del objeto y es lo que la Main descarga dentro del plazo de un
  volcado (150 s, y lo pide en gzip: [recuperacion.md](recuperacion.md#desde-la-nube-dos-fases-sync-19)).
  Como el cursor se lee según se escribe, la ventana más estrecha se intenta siempre aunque su
  estimación no quepa, y decide lo escrito. Los bytes se cuentan al escribir, exactos (UTF-8), y las
  filas también. El lector sólo lee dentro del TenantHub (fuera lanza, como `tenantQuery`): un test
  que monta el router de sync suelto ejecuta la ruta dentro, con `dentroDelHub` y el SQLite de un DO
  de verdad (`test/helpers/volcadoEnElHub.ts`).
- **Un cursor del SQLite del DO se recorre hasta el final.** Uno que se deja a medias mantiene su
  sentencia abierta, con su lectura, hasta que el recolector de memoria lo retira (mientras tanto,
  un `DROP` de esa tabla falla con `database table is locked`). `cursor.toArray()` y
  `Array.from(cursor.raw())` lo agotan; quien lo recorra a mano y pueda parar antes tiene que
  terminarlo, como hace el lector de los volcados.
- **Las respuestas de sync que crecen con el negocio salen en gzip si quien pregunta lo acepta**
  (`gzipSiSeAcepta`, `lib/gzip.ts`): `/v1/sync/changes`, `/bootstrap`, `/historico` y las del
  contraste (`/verificar/*`). Sin `Accept-Encoding: gzip` salen como siempre. El middleware va delante de
  `tenantAuth` y `alHub`: el `TenantHub` contesta sin comprimir y comprime el Worker lo que vuelve,
  para no gastar el hilo del negocio. La respuesta comprimida lleva `encodeBody: "manual"`; sin
  eso, el runtime comprime al transmitir lo que lleva `Content-Encoding` y saldría comprimida dos
  veces (`test/syncGzipTransmision.test.ts`). Se mira lo que pidió el cliente
  (`cf.clientAcceptEncoding`, si Cloudflare cambió la cabecera) y sólo se comprime un 200.
- **Retirar un negocio** (`/v1/admin/pruebas/retirar`, sólo los de pruebas:
  [licencias.md](licencias.md#anular-desde-la-administración)) es borrar todo lo que guarda en la nube:
  - su `TenantHub` (`borrarTodo`): cierra las sesiones que sigan vivas y borra todo lo guardado. El
    cierre de esos sockets llega después y no vuelve a crear nada: una sesión que cerró el DO ya está
    fuera y su salida ya se contabilizó;
  - su `AgendaWeb` (`borrarTodo`): lo que esperaba a la Main, con los datos de quien reservó, y su
    alarma. Espera a que acabe lo que la agenda tenga a medias (un alta lee la base y apunta
    después: si el borrado se colara en esa espera, el alta volvería a guardar los datos de quien
    reservó en una agenda ya retirada), y lo que llega mientras se borra espera a que termine. Si lo
    que está a medias no acaba en diez segundos, falla con `agenda_ocupada` y el negocio se queda
    para el siguiente intento;
  - sus imágenes: la carpeta del negocio en el bucket (`prefijoDelNegocio`), que acaba en `/` y por
    eso no es el principio de la de otro. La copia que el edge tenga en caché caduca sola.

  Lo cubre `test/retirarUnNegocio.test.ts`.

## Cómo se escribe una ruta

- **Una ruta no lee su propio cuerpo.** Lo valida `lib/validacion.ts` —`cuerpo(schema)`,
  `consulta(schema)`— y el handler lo recoge con `c.req.valid("json")`.
- **Todo lo que decide antes de leer el cuerpo es middleware y va delante**: el veto de rol
  (`soloLaMain…`), un tope de tamaño, un token de administración, el filtro por IP del emparejamiento. Un
  `*.routes.ts` no resuelve roles. Lo vigilan `test/anularSoloMain.test.ts` y
  `test/vetoAntesDelCuerpo.test.ts`.
- **Una ruta anónima lleva el tope de su cuerpo delante** (AUD-34): lo que no pasa por `tenantAuth`
  ni por un token de administración no lee un cuerpo entero antes de saber quién llama. Se declara
  antes que la ruta, `xRoutes.use("/ruta", topeAnonimo())` (`lib/validacion.ts`, 413
  `payload_too_large`): 8 KiB el emparejamiento (`claim`, `fetch-token`, `cancel`) y las licencias
  (`activate`, `device-change/request`, `refresh`), y 4 MiB el webhook de Stripe. Su evento más
  grande es una disputa cerrada con las pruebas y los metadatos al máximo (150 000 caracteres y 50
  pares de 40 + 500): con todo escapado en `\uXXXX`, unos 2,1 MB. Las públicas de la reserva web
  llevan el suyo, `topeDelCuerpo`. `test/vetoAntesDelCuerpo.test.ts` barre los routers y falla con una
  ruta anónima con cuerpo sin tope.
- **Toda ruta autenticada pasa por `tenantAuth`** (`middleware/tenant.ts`): token, device-proof, rol de
  la fila, licencia en uso. Tenant y dispositivo salen del token, nunca del cuerpo.
- **Ningún dato personal ni texto libre en la query ni en el camino: va en el cuerpo** (AUD-27).
  Cloudflare guarda el método y la URL de cada petición, y Logpush puede exportarlos a Axiom, sin
  pasar por el filtro de datos personales; el cuerpo no se registra
  ([observabilidad.md](observabilidad.md#lo-que-registra-cloudflare-de-cada-petición)). En la URL
  sólo van identificadores, fechas, filtros cerrados y paginación. Lo que es de una persona (nombre,
  teléfono, correo, documento), una nota o lo que se escribe en un buscador hace que la lectura pase
  a `post` con `cuerpo(schema)`.
- **Una lectura que va por POST se declara** con `xRoutes.use("/ruta", lecturaPorPost())`
  (`lib/rutas.ts`) **delante de `tenantAuth`**, que lee el cuerpo entero para comprobar la firma. La
  declaración le pone el tope a su cuerpo (8 KB, o el que se le diga) y es lo que la distingue de
  una escritura. El tope se comprueba en el Worker, antes de autenticar: un cuerpo que pasa de él no
  llega al `TenantHub`. Sigue siendo una lectura: sólo `tenantQuery`, que le fija la hora con
  `X-Client-Now`; ni `apply` ni `X-Idempotency-Key` ni los vetos que son para lo que escribe
  (`soloLaMain…`), y la Handy la pide con `CloudClient::post_lectura`. Sus consultas cuentan como
  lecturas en la cobertura de contrato. Van así el cliente de una reserva
  (`/v1/reservas/buscar-cliente`), los listados y el resumen de Cuentas (`/v1/cuentas/entradas`,
  `/salidas`, `/resumen`), los buscadores de productos (`/v1/mesas/productos/search`,
  `/v1/venta-rapida/productos/search`) y el resumen de tickets (`/v1/venta-rapida/index-rows`, cuya
  lista de ids no cabe en una query).
- Las dos reglas las vigila `test/sinDatosPersonalesEnLaQuery.node.test.ts`, que lee todo `src/`
  con el analizador de TypeScript (en Node: workerd no puede cargarlo, y `vitest.config.ts` tiene
  un proyecto para los `*.node.test.ts`) y con listas cerradas: lo que se lee de la query (por su
  nombre o con un schema con nombre de un `*.schemas.ts`, siguiendo los alias de importación), lo
  que lleva el camino, y que todo lo que no es un GET y sólo consulta esté declarado. Lo que no sabe
  leer lo da por malo. En la Handy, `tests_sin_datos_en_la_url` (`tpv-infra-http`) hace lo mismo
  con lo que pone en la URL, función a función.
- **Lo que la Handy no puede hacer** lo vetan middlewares: `soloLaMainCobra` (`cobro_solo_en_main`),
  `soloLaMainEscribeCaja` (`caja_solo_en_main`), y `lib/hub.ts::TABLAS_SOLO_MAIN` para las tablas
  fiscales.
- `cuerpoConIdentificador` es sólo para el emparejamiento. Los cuerpos permisivos de `sync`
  (`/changes`, `/historico`, `/salud` y las del contraste, `/verificar/resumen`, `/filas`,
  `/por-clave` y `/claves`) usan `cuerpoTolerante` con schemas que coercen y ponen valores por defecto: están en el
  camino de la recuperación y de la comprobación, donde se falla hacia «sigue trabajando».
- **Un schema con contrapartida en Rust lleva drift-guard**:
  `Assert<SameKeys<z.infer<typeof xSchema>, XInput>>` (`lib/typeGuards.ts`) compara las claves en las
  dos direcciones; los tipos de los valores los cubre el paso a los command builders.
- **Lo que ese schema acepta o rechaza es lo mismo que acepta o rechaza la Main**, y lo fija la tabla
  [`validacion_casos.json`](../../crates/tpv-domain/src/validacion_casos.json): una entrada base válida
  por dominio y casos que la cambian, con `acepta`, si hace falta el valor normalizado que `queda` y,
  en los que se rechazan, el `mensaje` que se enseña (VALID-03).
  La leen `tpv-domain/src/validacion_casos.rs` contra los `validar` del dominio y
  `test/validacionCasos.test.ts` contra los schemas. El arnés de contrato no lo ve: entra por debajo de
  la validación.
- **Un texto que llega se recorta con `recortar`** (`lib/texto.ts`; en un schema,
  `.overwrite(recortar)`), que quita lo mismo que `str::trim` en la Main: lo que Unicode marca como
  espacio. El `.trim()` de JavaScript quita además U+FEFF y deja U+0085, y un texto valía en un lado y
  no en el otro (VALID-01). `test/recortarComoLaMain.test.ts` lo vigila en todos los ficheros de los
  dominios del negocio.
- **Lo que llega antes de saber quién llama no pasa por nada que cueste más que recorrerlo**
  (AUD-33). Este motor de expresiones regulares retrocede: una repetición anclada al final que puede
  empezar en cada posición de un tramo (`"+$`, `\s+$`) lo recorre entero desde cada una, y tarda el
  cuadrado de su longitud. Las comillas de los extremos de una firma o una clave se quitan con
  `quitarComillas` (`lib/texto.ts`), que recorre los extremos como `recortar`. Y la firma y la clave
  pública llevan su tope antes de procesarlas, sobre la cadena tal como llega, antes de recortarla
  (`TOPE_FIRMA_B64`, 128, y `TOPE_CLAVE_B64`, 64, en `server/utils/ed25519.ts`; una firma son 88
  caracteres y una clave, 44): una `X-Device-Sig` más larga sale como `bad_device_signature` sin leer
  la base, en `tenantAuth` y en las rutas de licencias; en el emparejamiento, el `devicePubKey` de
  `claim` como `invalid_devicePubKey` y el `sigB64` de `fetch-token` y `cancel` como `missing_proof`,
  con el `.max()` del schema delante del recorte y del `transform`. Lo vigilan
  `test/quitarComillas.test.ts` y `test/topeDeLaFirma.test.ts`.
- **Una fecha que llega como texto se valida con `lib/fechas.ts`** (`zDia`, `normalizarDia`,
  `esFechaYmd`; espejo de `tpv_domain::fechas`): forma `YYYY-MM-DD` y día real de calendario. Una
  expresión regular deja pasar un 31 de febrero, y un `throw` dentro de un `transform` de zod no sale
  como fallo de validación sino como un 500.
- **El techo va en la respuesta, no en cada pieza**: una ruta que devuelve listas reparte un presupuesto
  común, o va por páginas con un cursor (como las claves del contraste, `/v1/sync/verificar/claves`).
  Un isolate tiene 128 MB. Lo que crece con el negocio se acota además en bytes, mientras se escribe
  (`VOLCADO_MAX_BYTES`, las páginas del contraste): un tope de filas no dice lo que ocupan.
- **Un importe que llega por la API viene en céntimos enteros** (`zDinero`); un `12.5` se rechaza.
  Uno que no puede ser negativo (un precio de venta, el coste de un lote) va con
  `zDineroNoNegativoCon(mensaje)` y el texto de la Main.

## Errores

- Toda respuesta de error lleva `code` del catálogo cerrado `ErrorCode`
  (`crates/tpv-contracts/src/errors.rs`, exportado a TS) además del identificador `error`. Se ramifica
  por `code`; el resto es diagnóstico.
- **Lo que ve la persona es `message`, nunca un identificador.** La frase vive en `lib/errorCodes.ts`:
  `MENSAJES` para lo que alguien puede provocar usando el programa, `SIN_MENSAJE_PROPIO` para lo que ya
  tiene código de negocio o sólo sale con un bug. Un identificador nuevo va a una de las dos o
  `test/mensajesDeError.test.ts` falla. No se añade al enum `ErrorCode` lo que sólo se enseña.
- La aplica un middleware a todas las respuestas (`middleware/completarErrores.ts`); un `message`
  escrito en la llamada gana a la tabla.
- **Un dato que no vale sale con el texto de su regla** (VALID-02): `cuerpo`, `consulta` y
  `cuerpoTolerante` ponen como `message` el del primer fallo cuando está escrito en el schema (un
  `MSG_*`, un `refine`, un `.min(1, "…")`), que es el mismo que da la Main. Los de zod por defecto
  salen en inglés y se quedan en los `issues`: la respuesta va sin `message` y se enseña el genérico.
- **Ese texto es una frase en español que dice qué hacer** (VALID-03): «Escribe el nombre del
  producto.», «Falta la mesa.», nunca «nombre required» ni «id_mesa invalido». Un id que llega en
  blanco en un parámetro de ruta (`parseId`) es un bug, no algo que corrija la persona: sale con un
  identificador de máquina (`id_mesa_invalido`) en `SIN_MENSAJE_PROPIO`. Lo vigila
  `test/mensajesEnEspanol.test.ts`.
- **Un error no cuenta su detalle interno** (FABLE-B): `serverError`, `unauthorized` y `forbidden`
  no aceptan detalles, y un 500 inesperado sale como `internal_error` sin más. La traza y el texto
  de Turso quedan en el log (`wrangler tail`) y en Sentry, donde se captura el error. Los `details`
  de un `HubError` sí viajan: los escribe quien lo lanza y son parte del contrato
  (`test/sinDetalleInterno.test.ts`).

## Correo

`/v1/email` manda pedidos a proveedores con el binding `EMAIL` (Cloudflare Email Service) desde
`EMAIL_FROM_ADDRESS`. Se acota **por destinatario** (sólo al `Email` de un proveedor dado de alta) **y
por volumen**: `TOPE_DIARIO` (100) envíos por negocio en una ventana de 24 h, contados en `email_sends`.
Cuentan los pedidos entregados y los que están saliendo (`tipo = 'pedido'`, `ok = 1` o
`error_code = 'enviando'`); lo que falló no. El sitio se reserva con la fila del envío en una sola
sentencia (`reservarCupo`), justo antes de enviar y después de comprobar el destinatario, y luego se
apunta cómo acabó y a qué hora: muchos pedidos a la vez no pasan del tope (AUD-41). Un pedido cuenta
desde que salió; una reserva que se quedó en `enviando` (el worker murió a medias), como enviada desde
que se reservó. Las dos dejan de contar al salir de la ventana. Si la base central no contesta, el
pedido sale igual y se apunta después si se puede. Las trazas se purgan a los 90 días
(`RETENCION_ENVIOS_MS`).

**Un pedido no sale dos veces.** La Main manda con cada pedido su clave de envío (`id_envio`, la
misma mientras se reintenta el mismo pedido sin cambiarlo, guardada en el almacenamiento de la
aplicación hasta que el envío termina bien: `claveDeEnvio.ts`), y es el id de su
fila (`pedido:<negocio>:<id_envio>`). La reserva del cupo es también la del id, en la misma
sentencia: un reintento de uno que ya salió (la respuesta se perdió por el camino) contesta `ok`
sin mandar otro; uno que está saliendo ahora por otra petición, 409 `email_en_curso`; uno que
falló, o que se quedó a medias más de cinco minutos, se vuelve a reservar y sale. Lo que ya salió no
se pisa nunca (`ok = 1`), y apuntar que salió se intenta tres veces antes de rendirse: uno que salió y
se queda en `enviando` es lo único que un reintento podría repetir. Sin clave (una Main anterior), cada
petición es un envío. Con la base central caída el pedido sale igual, también con clave: no se sabe
si ya salió, y entre no mandar un pedido y mandarlo dos veces en una caída se queda lo segundo.

Los correos al cliente de una reserva web salen de `domains/reservas_web/correos.ts`, desde
`EMAIL_RESERVAS_FROM_ADDRESS` con el nombre del negocio y su correo de contacto como `Reply-To`. Sólo
llevan datos estructurados (nada que haya escrito el visitante), van a la dirección del alta o al
cliente de la reserva web en la nube, y tienen sus topes: 600 al día por negocio y 10 por
destinatario, sobre lo entregado y lo que está saliendo (`tipo = 'reserva_web'`). Cada uno lleva su
id en `email_sends`, y el id y el cupo se reservan en una sola sentencia antes de enviar: el mismo
no sale dos veces, muchos a la vez no pasan de los topes y uno que falló se puede repetir. Sin la
base central no se envía (no se sabría si ya salió). Qué correo y cuándo:
[reservas-web.md](../estudios/reservas-web.md#48-correos).

Lo que va a una cabecera de esos correos sale en una línea (AUD-40). El nombre del negocio llega al
asunto y al remitente tal como está en la base, y ahí lo deja una Handy o la Main, que sube su
propio SQL: por eso no se valida al guardar sino donde se compone el correo. `enUnaLinea` pasa a
un espacio los caracteres de control y los separadores de línea, y el nombre entra con un tope de
100 caracteres (el asunto no puede pasar de 998). Una dirección de destino con un carácter de
control no es una dirección: no se envía ni gasta cupo, y sale como `fallido`.

RI-60: el envío exige nombre y correo comercial, leídos de la base del negocio junto con el
proveedor. Sale desde nuestro dominio verificado, con el nombre del negocio y su correo en
`Reply-To`. Dirección y teléfono son opcionales. Compra y recuperación del PIN conservan sus
correos independientes; el esquema del negocio sólo guarda el contacto comercial.

## Sincronización y firmas

El binding `TenantHub` está tipado y llama por RPC a `ejecutarRuta`, `aplicar`, `leerParaLaWeb`,
`aprovisionar`, `revocarDispositivo`, `releerMain` (AUD-02: la licencia del negocio ha cambiado) y
`avisarEmparejamiento`. El adaptador moderno extiende `DurableObject`; los
helpers y credenciales permanecen en un motor interno que no pertenece al prototipo RPC. No se
publican rutas `/internal/*`. Obtener el binding es la capacidad de acceso: no debe compartirse con
otro Worker ni convertirse en un proxy público. La autenticación del cliente (token, firma y
licencia) se ejecuta en el Worker antes de llamar al DO; los gates de cada ruta, dentro, antes de leer
el cuerpo, como siempre. Sentry instrumenta también las llamadas RPC, con tracing de
rendimiento desactivado, y `ejecutarRuta` corre además como una petición, con su ámbito y su cliente
([observabilidad.md](observabilidad.md#el-flujo)). Los errores de negocio cruzan como un resultado tipado y los inesperados
como excepciones. WebSockets, attachments, alarmas y almacenamiento conservan su funcionamiento.

RI-44: `/v1/sync/changes` valida en SQLite que las sentencias guardadas sean un array JSON y
conserva ese fragmento en la respuesta. Un registro inválido falla explícitamente; no se sustituye
por una operación vacía. Ed25519 firma y verifica exclusivamente con WebCrypto en producción;
Noble sólo sirve de referencia independiente en tests. Placement sigue desactivado; véase
[cómo medir antes de decidir](../guias/medir-worker.md).

## Imágenes

Se guardan en R2 con prefijo por tenant y una expresión contra rutas con `..` (`REL_PATH_RE`). El GET
público las sirve con `max-age=31536000, immutable`; borrar una la quita también del caché del edge,
pero **sólo del centro de datos que atiende la petición** (barrer los demás pediría el API de purga). La
Handy no lee por esa ruta: lee del `r2.dev` del bucket (`src/shared/lib/imageUrl.ts`,
[INFRA-03](../pendientes.md#infra-03--imágenes-por-r2dev)).

La clave de la Cache API omite la query: no hay transformaciones por parámetros, así que distintas
queries reutilizan la misma imagen y el borrado usa esa misma URL. No requiere opciones del plan
de Cloudflare; `ignoreSearch` no está soportado por esta API. Esto no modifica las cachés TanStack
del cliente ni la lectura directa de la Handy desde `r2.dev`.

Main y Handy guardan su cola local en `image_uploads.json`, con escritura temporal y sustitución
atómica. Solo hay un drenaje activo; cada confirmación modifica su propia revisión, conservando
las entradas añadidas durante una subida. Los rechazos de contenido (400/413/415/422) y archivos
locales ausentes o inválidos se apartan, sin detener las siguientes imágenes. Los errores de red,
credenciales y servidor conservan la entrada para reintentar. Una cola ilegible devuelve un error:
no se trata como vacía ni se sobrescribe. Configuración → Conectividad muestra el estado y permite
reintentar; sustituir una imagen desde su ficha elimina su entrada anterior. Cada rechazo nuevo
se registra a nivel ERROR, que la integración existente con Sentry captura una sola vez.

## Salud y vigilancia externa

- **`/health` toca la base central** (`server/salud.ts`) y contesta 200 o 503. El cuerpo no cuenta por
  qué falla (el error de libsql lleva la URL de la base). Caché de 30 s por isolate: la ruta es pública.
  No toca ninguna base de tenant. Lo vigila `test/salud.test.ts`.
- **También descifra el canario de `LICENSE_STORE_KEY`** (`canario_cifrado`, RI-73): con una clave
  equivocada contesta 503 (`cifrado: "falla"`). La fila la crea el propio `/health` la primera vez. Sin la
  tabla, `cifrado: "sin_comprobar"` y la sonda sigue en verde.
- Una sonda externa (Better Stack) la consulta en `tpv-api.altarialights.workers.dev/health`, el mismo
  hostname que usan los clientes.

## El cron diario

`scheduled` en `src/index.ts`. Cada tarea va en su `try` y ninguna propaga:

1. **Avisos de caducidad** de licencias ([licencias.md](licencias.md#avisos-de-caducidad)).
2. **Purga de la base central** (`server/purga.ts`): fallos de emparejamiento, trazas de correo y
   eventos del código de cambio de equipo.
3. **Copia de la base central a R2** (`server/copiaBaseCentral.ts`) y, sólo si se subió, su latido
   (`BETTERSTACK_HEARTBEAT_COPIAS_URL`).
4. Al final y fuera de los `try`, el latido del cron (`BETTERSTACK_HEARTBEAT_URL`), aunque una tarea
   haya fallado: responde a «¿se ejecuta el cron?». Un latido nunca propaga (`observability/latido.ts`).

### La copia de la base central

Es la base que no se puede perder: si el worker contesta `license_not_found`, el TPV borra su licencia
local, así que perder `licenses` o `devices` desactivaría a todos. La copia cubre lo que el PITR de
Turso no (más de 24 h en el plan Free, una base borrada, el propio proveedor):

- **Sólo lee**, en una transacción de lectura, y sale en formato `sqlite3 .dump` comprimido.
- Va al bucket **privado** `tpv-copias-control`, nunca a `tpv-images`: lleva correos de clientes y DEK
  cifradas.
- La retención la pone el ciclo de vida del bucket (35 días), por debajo de los 90 de
  `RETENCION_ENVIOS_MS`.
- Sin `LICENSE_STORE_KEY` las DEK de la copia no se pueden descifrar: ese secreto
  tiene que estar guardado fuera de Cloudflare.
- ⚠️ **Restaurar cambia de base**: `turso db create <nueva> --from-db tpv-control --timestamp <RFC3339>`
  (PITR) o `--from-dump copia.sql`, un token nuevo (`TURSO_AUTH_TOKEN`), su URL en `TURSO_DATABASE_URL`
  de `wrangler.json` y desplegar, **deprisa**: mientras el worker apunte a una base sin esas filas, cada
  TPV que compruebe su licencia la borra. Las licencias activadas después del punto restaurado hay que
  rehacerlas a mano.

## Los tests no salen a la red

Los tests corren dentro de workerd (`@cloudflare/vitest-pool-workers`) y toman de `wrangler.json` los
bindings, pero no pueden hablar con ningún servicio de verdad (`vitest.config.ts`):

- **El entorno es de pruebas** (`test/helpers/entornoDePruebas.ts`). Las `vars` que nombran un
  servicio o una cuenta —la base central, los remitentes, Turnstile, el origen de las reservas web,
  Axiom— valen direcciones `.invalid` y nombres ficticios. Los secretos que la suite necesita
  (`LICENSE_JWT_SECRET`, `TURSO_AUTH_TOKEN`) son deterministas; la pista de región de los DO, vacía;
  los demás van vacíos, que el worker trata como sin configurar, y el test que
  necesita uno lo pasa en su propio entorno. Wrangler mete además en los tests el `.dev.vars` de la
  carpeta del worker o, si no lo hay, su `.env` y su `.env.local`, y el pool no deja desactivarlo:
  la configuración le pregunta qué nombres va a cargar y los pone todos vacíos antes de aplicar la
  tabla. Así nada de ese fichero llega a un test, esté o no en `Env`. Vite, por su lado, cargaría
  el `.env` y pasaría sus `VITE_*` por `import.meta.env` y `process.env`: `envDir: false` se lo
  impide.
- **Una salida sin doble se rechaza y hace fallar al test** (`test/helpers/sinRed.ts`, que
  `setupFiles` pone antes de cada fichero). El `fetch` y el `WebSocket` globales —los comparten los
  tests, el worker y sus Durable Objects— lanzan `Salida a la red bloqueada en los tests: POST
  https://host`: el método y el origen, nunca la ruta ni la consulta, que es donde viajan los
  secretos (la URL de un latido lo es entera). Al terminar, el test falla con la lista de lo que
  intentó, aunque el código se haya tragado el error (un envío a Axiom o un latido no propagan su
  fallo). La guarda se pone antes de cargar el worker: el cliente de libsql se guarda el
  `WebSocket` al cargarse.
- **Detrás, el worker de pruebas no tiene por dónde salir**: `outboundService` manda todo lo que
  sale de él, también lo que no pase por el `fetch` global, a un worker auxiliar que lo corta, lo
  apunta y contesta 599 con el mismo texto; la guarda recoge lo apuntado al terminar cada test, así
  que también hace fallar al test.
- **Un socket TCP**: el worker auxiliar también lo corta, pero workerd no se lo pasa y no lo puede
  apuntar. Por eso `sinRed.setup.ts` sustituye con `vi.mock` el `connect` de `cloudflare:sockets`
  para todo lo que lo importe por el cargador de Vitest (los tests y el worker): lo rechaza, dice el
  host y el puerto, y lo apunta como el `fetch`. Lo que abre un socket por dentro del runtime
  (`node:net`, `node:tls`) no pasa por ahí: se vigila que ni el worker ni los tests los importen, y
  lo que haga así una dependencia se corta pero no hace fallar al test.

Lo vigila `test/sinRed.test.ts`, también con el propio Vitest: tres tests marcados `it.fails` se
tragan una salida (una de la guarda, una del worker auxiliar y un socket) y sólo los hace fallar el
gancho; sin él, salen en rojo.

Todo eso es del proyecto `workerd`. Los `*.node.test.ts` corren en el proyecto `node` (leen el
fuente con el analizador de TypeScript, que workerd no carga) y no tienen worker auxiliar: su guarda
es `test/helpers/sinRed.node.ts`. `fetch`, `WebSocket`, `node:net`, `node:tls` y los agentes de
`node:http` y `node:https` lanzan con el mismo texto (método y origen, o host y puerto), y el
gancho hace fallar al test aunque se trague el error. No cubre `node:dns` ni un proceso hijo: hoy
esos tests sólo leen ficheros. `envDir: false` va arriba y en cada proyecto: con uno solo de los
dos sitios, el `.env` sigue llegando. Lo vigila `test/sinRed.node.test.ts`.

Queda fuera el proceso de Node del propio Vitest (`vitest.config.ts`, sus plugins y un
`globalSetup`): hoy no hay `globalSetup` ni nada que pida red ahí, y lo que se añada en ese lado
no lo vigila nada.

**Un test declara el doble de lo que su código llama fuera**, antes de llamarlo:

| Lo que se llama | Doble |
|---|---|
| La base central desde una ruta o un helper (`getDb`) | `vi.mock("../src/server/db", …)` con `getDb` devolviendo `clienteSobre(sql, storage)` (`helpers/clienteSql.ts`) sobre el SQLite de un Durable Object, con `prepararPlanoDeControl(sql)` |
| El viaje al `TenantHub` de una ruta de negocio, en un router montado suelto | `vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"))`: la ruta corre allí mismo, contra los demás dobles. Con la `app` entera y el TenantHub de verdad no hace falta (`unViajePorPeticion.test.ts`) |
| La base del negocio desde una ruta | `vi.mock("../src/lib/tenantClient", …)` con `tenantQuery` llamando a su función con un `clienteSobre`, sobre `crearEsquemaTenant(sql)`. Desde la agenda o una ruta pública: `motor.leer = lectorSobre(state, ahora)` (`helpers/agenda.ts`) o el doble de `leerParaLaWeb` |
| La base del negocio en el `TenantHub` | No necesita doble: es el SQLite del propio DO. Con el esquema de verdad, `aprovisionar(tenantId)` (por RPC o dentro de `enElHub`); para ponerle delante otra base o hacerla fallar, dentro de `enElHub`: `hub.withTenantDbRetry` o `hub.getTenantDb` con un `clienteSobre` |
| La base central en el `TenantHub` | Dentro de `enElHub`: `hub.getCentralDb = () => cliente`, `hub.touchLastSeen = async () => {}` |
| Un `fetch`: Stripe, Axiom, Turnstile, un latido | `vi.stubGlobal("fetch", doble)` y `vi.unstubAllGlobals()` en `afterEach`; o `vi.mock` del módulo que lo hace |

## Secretos

Van con `pnpm exec wrangler secret put <NOMBRE>` desde `apps/cloud-worker-licensing/`, nunca en
`wrangler.json`. Los de licencias están en [licencias.md](licencias.md#secretos-del-worker); además:
`TURSO_AUTH_TOKEN` (base central), `PAIR_PEPPER`,
`RELEASE_ADMIN_TOKEN` (publicar releases), `SENTRY_DSN`, `AXIOM_TOKEN`,
`BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_HEARTBEAT_COPIAS_URL` y, opcional, `HANDY_TOKEN_TTL_SECONDS`.
Una ruta que depende de un secreto ausente responde 503 o 500 (fail-closed).

## Desplegar

Producción se despliega desde GitHub con un tag `v<versión>`. El workflow comprueba la misma versión
en worker y escritorio, sube los mapas a Sentry y verifica un error real antes de desplegar los mismos
bytes. Los tags `win7-v<versión>` publican únicamente el escritorio de Windows 7.

El worker lleva el esquema del negocio compilado dentro: **con un cambio de esquema, se despliega antes
de que los TPV escriban la columna nueva**, o la primera escritura se rechaza. Desplegar reinicia los DO,
y cada uno migra su base la primera vez que la toca. Y cualquier tabla o
columna nueva de la base central se crea a mano en Turso antes. Más en
[publicar-version.md](../guias/publicar-version.md).
