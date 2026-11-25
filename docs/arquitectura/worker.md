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
| `/v1/clientes`, `/configuracion`, `/cuentas`, `/inventario`, `/login`, `/mesas`, `/notificaciones`, `/pedidos-proveedor`, `/proveedores`, `/reservas`, `/stats`, `/tareas`, `/trabajadores`, `/venta-rapida` | `domains/<dominio>/` | La Handy (lecturas y escrituras de negocio) |
| `/v1/sync/*` | `domains/sync/` | La Main: catch-up, volcado, histórico, contraste ([sincronizacion.md](sincronizacion.md)) |
| `/v1/images/*` | `domains/images/` | Subir, servir y borrar imágenes en R2 |
| `/v1/facturas/*` | `domains/facturas/` | La Main: subir y bajar el PDF de cada factura completa ([Facturas en PDF](#facturas-en-pdf)) |
| `/v1/email/*` | `domains/email/` | El correo de un pedido a un proveedor (la Main y la Handy) |
| `/v1/pair/*`, `/v1/device/*` | `domains/pairing/` | Emparejamiento ([emparejamiento.md](emparejamiento.md)) |
| `/v1/license/*`, `/v1/stripe/*`, `/v1/admin/*` | `domains/{licensing,stripe,admin}/` | Licencias ([licencias.md](licencias.md)) |
| `/v1/admin/central/*` | `domains/admin/central.ts` | La administración de la base central ([abajo](#las-rutas-de-administración-de-la-central)) |
| `/v1/interruptores` | `domains/interruptores/` | La Main ([jobs-e-interruptores.md](jobs-e-interruptores.md)) |
| `/v1/update/*` | `domains/updates/` | El updater de escritorio y la publicación ([publicar-version.md](../guias/publicar-version.md)) |
| `/v1/telemetry/*` | `domains/telemetry/` | Reenvío de eventos ([observabilidad.md](observabilidad.md)) |

Cada dominio de negocio tiene `*.routes.ts` (rutas), `*.queries.ts` (lecturas), `*.commands.ts`
(escrituras, que se aplican por el `TenantHub`) y `*.schemas.ts` (zod). Bindings (`wrangler.json`): los
DO `TenantHub`, `AgendaWeb` y `BaseCentral` (SQLite), R2 `tpv-images` (las imágenes y el PDF de las
facturas; se lee por el worker, [Imágenes](#imágenes) y [Facturas en PDF](#facturas-en-pdf)),
`tpv-copias-control` (privado, las copias de la base central) y `tpv-copias-negocios` (privado, las de
cada negocio), `send_email` (`EMAIL`), los
limitadores por IP `LIMITADOR_CLAIM`, `LIMITADOR_LICENCIA`, `LIMITADOR_RESERVA_WEB`,
`LIMITADOR_RESERVA_WEB_ALTA`, `LIMITADOR_IMAGENES`, `LIMITADOR_ACTUALIZACIONES` (el feed) y
`LIMITADOR_SESION` (`/ws`, `/v1/license/refresh` y la espera de la Handy al emparejarse)
(`lib/limitador.ts`) y el cron diario `0 7 * * *`. Todos cuentan por red: la IPv4 tal cual y la IPv6
por su /64 (AUD-11). Toda ruta anónima que lee la base central lleva delante uno de esos filtros o una
caché; lo vigila `test/centralAnonimas.test.ts`.

RI-46: los bindings de R2 son exclusivamente `IMAGES`, `COPIAS` y `COPIAS_NEGOCIOS`; lo de los TPV
(imágenes y facturas) va en `IMAGES`, separado por carpetas. En desarrollo local, R2 y
`EMAIL` se simulan; no llevan `remote: true`. La base central es un objeto más: en `wrangler dev`
nace sin aprovisionar, y lo que la toca contesta 503 hasta que se le da esquema
(`pnpm central:aprovisionar -- --si`, con `TPV_API_BASE` apuntando a `wrangler dev`).
La fecha de compatibilidad (`2026-05-29`) coincide con el runtime instalado; los tests reutilizan
el mismo `wrangler.json` con el entorno pisado ([los tests no salen a la red](#los-tests-no-salen-a-la-red))
y los tipos se regeneran con `pnpm cf-typegen`.

## Dos bases, cada una en su objeto

- **La base de cada negocio** vive en el SQLite de su `TenantHub` y se construye con las migraciones
  de `packages/database/migrations/`, registradas a mano en `src/server/tenantMigrations.ts`
  ([esquema.md](esquema.md)). La crea el alta (`aprovisionar`) y el DO la pone al día la primera vez
  que la toca tras un despliegue (`migrarBaseLocal`), sin atender nada más mientras tanto. Si no
  puede, el negocio contesta 503 `tenant_db_migration_failed` y el DO avisa
  ([esquema.md](esquema.md#si-la-migración-falla-en-la-nube)).
- **La base central** (control-plane: licencias, tenants, dispositivos, emparejamientos, interruptores,
  correo, releases…) vive en el SQLite de su Durable Object, `BaseCentral`, y su estructura son sus
  migraciones (`src/server/central/migraciones/`, registradas en `migraciones.ts`), que aplica el
  propio objeto: el worker lee y escribe filas, nunca hace `CREATE`, `ALTER` ni `DROP`, y el objeto
  sólo le ejecuta sentencias de filas (`baseCentral.guardas.ts`). Una migración de la central es
  aditiva y va en un despliegue **anterior** al del código que la usa. Los tests hablan con un objeto
  de verdad, aprovisionado con esas migraciones (`test/helpers/central.ts`). Cómo funciona:
  [La base central](#la-base-central).

Las dos comparten el motor del SQLite de un objeto (`durableObjects/sqliteDelObjeto.ts`: ejecutar una
sentencia, las claves foráneas y el runner de migraciones), el formato y el cargador de sus copias
(`volcadoSql.ts`, `cargaDeCopias.ts`) y la vuelta a un instante (`instantes.ts`).

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
  por `tenantQuery` (`lib/tenantClient.ts`): una `Base` (`lib/sql.ts`) sobre el SQLite del DO
  (`tenantHub.sqlite.ts`). Sólo dentro del DO: toda ruta que lo usa lleva `alHub`, y fuera
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

  Cuando la que no puede atender es la base central, la respuesta es la misma
  ([abajo](#cuando-no-puede-atender)).
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
  `test/basePerdida.test.ts`. La salida de una base perdida de verdad es de soporte, a sabiendas:
  devolverle su copia diaria o crearle una vacía
  ([las copias de cada negocio](#las-copias-de-la-base-de-cada-negocio-do-03)).
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
  patrón el `%` y el `_` tecleados son comodines. Así buscan los productos de las mesas y de la barra,
  los listados de caja y los pedidos a proveedores, y la Main busca igual para devolver las mismas
  filas. Las listas que filtra la propia pantalla usan la misma regla
  ([frontend.md](frontend.md#los-buscadores)). Un `LIKE` con un patrón fijo y corto (`LIKE '%:%'`) no tiene ese problema. Lo vigila `test/busquedaDeTexto.test.ts`,
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
  - sus imágenes y el PDF de sus facturas: la carpeta del negocio en el bucket (`prefijoDelNegocio`),
    que acaba en `/` y por eso no es el principio de la de otro. Es lo único que borra una factura
    del bucket, y sólo de un negocio de pruebas. La copia que el edge tenga en caché caduca sola.

  Lo cubre `test/retirarUnNegocio.test.ts`.

  Un negocio que ninguna licencia apunta (`/v1/admin/negocios-huerfanos`, AUD-09:
  [licencias.md](licencias.md#anular-desde-la-administración)) sólo se vacía su `TenantHub`: no ha
  tenido nunca una Main con token, así que no tiene agenda ni imágenes.

## La base central

Una para todo el servicio: los negocios (`tenants`), los dispositivos, las licencias y sus cobros, la
auditoría de la administración, los eventos de Stripe, los emparejamientos y sus retos, los códigos y
las trazas de correo, los tickets del socket, las claves y los dominios de la reserva web, los
interruptores, las versiones de la app y el canario de `LICENSE_STORE_KEY`. Es el SQLite de un Durable
Object, `BaseCentral` (`durableObjects/baseCentral.ts`), en este mismo worker
([0009](../decisiones/0009-la-base-central-en-su-durable-object.md)).

### El objeto y cómo se le habla

- **Uno solo, pedido siempre igual**: `centralDe(env)` (`lib/objetosDelNegocio.ts`), con el nombre
  `central`, sin jurisdicción y con la pista `weur`. Son constantes y suyos, no salen de
  `JURISDICCION_DO` ni de `UBICACION_DO`: cambiar cómo nacen los objetos de los negocios no puede
  dejar a la central hablando con otro objeto, vacío. Nadie más nombra `env.BaseCentral`
  (`test/objetosDelNegocio.node.test.ts`). Cada viaje pide su stub, porque uno que ha lanzado puede
  haberse quedado roto, y pedirlo no sale del isolate. Sentry lo instrumenta como a los otros dos
  (`index.ts`).
- **Se le habla con `getDb(env)`** (`server/db.ts`), que da `clienteCentral`
  (`server/central/cliente.ts`): una `Base` de `lib/sql.ts` (`execute`, y `batch`, todo o nada) sobre
  el RPC del objeto (`ejecutar` y `lote`), más `operar(nombre, datos)` para
  [sus operaciones](#las-operaciones), tipado por operación. El `TenantHub` usa el mismo cliente, con
  plazo ([abajo](#el-plazo-del-tenanthub-central-plazo)). Cada viaje suma al tramo `central` del
  `Server-Timing` (`observability/tiempos.ts`). El resto de su RPC es de la administración y del cron
  (`estado`, `copiar`, `aprovisionar`, `prepararVuelta` y `reiniciar`), que lo piden a `centralDe`
  directamente ([abajo](#las-copias-de-la-base-central-restaurarla-y-volver-a-un-instante)).
- **`rowsAffected` son las filas que cambia la sentencia** (`changes()`), no las que escribe con sus
  índices: es lo que decide una carrera (un `UPDATE` condicionado, un `INSERT OR IGNORE`). Las filas
  se leen por nombre y por posición, y un entero de más de 2^53 vuelve redondeado, sin aviso
  (`test/centralCliente.test.ts`).
- **Los argumentos se convierten antes de salir y otra vez al entrar en el objeto**
  (`server/central/enlace.ts`), con lo que la central siempre ha guardado: un booleano como 1 o 0, una
  fecha como sus milisegundos, un `bigint` como número si cabe sin perder precisión, un `Uint8Array`
  como sus bytes. Un `undefined`, un `NaN` o un infinito lanzan sin llegar a viajar. Por su cuenta, el
  SQLite de un objeto guardaría un booleano como el texto `'true'` y una fecha como su texto en
  inglés, sin avisar (`test/centralEnlace.test.ts`). Sólo admite argumentos posicionales. Un número
  viaja siempre como REAL: en un texto (una columna `TEXT`, `CAST(? AS TEXT)`, `json_object`) un
  booleano sale «1.0».
- **Lo que el objeto no ha hecho viaja como resultado**, `{ ok: false, error: "central_…", detalle }`
  (`baseCentral.rpc.ts`), también un error de SQL. El cliente lo lanza en el Worker como
  `ErrorDeLaCentral`, con el estado HTTP de su código ([los códigos](#los-códigos-de-la-central)):
  quien lo recibe decide por el código, y el objeto no cuenta como un fallo suyo una restricción que
  quien escribe espera. Un viaje que no vuelve con su respuesta sale como `CentralNoDisponible`, con
  el error del viaje como causa: lo que la plataforma marca como saturado o pasajero, un plazo vencido
  y cualquier otro rechazo (la plataforma no dice por qué, o el objeto ha lanzado). **Un error nunca
  se convierte en filas vacías**: «la central no contesta» no puede leerse como «esa licencia no
  existe».

### Lo que cuida el objeto

Un objeto mal pedido o tocado a mano no falla en voz alta. Por eso (`baseCentral.ts`,
`baseCentral.guardas.ts`):

- **Sin aprovisionar no atiende, y no crea nada.** Sin `_migrations`, todo lo que no es de
  administración contesta `central_sin_aprovisionar`. El esquema sólo lo pone `aprovisionar`: vacío,
  o desde una copia ([abajo](#restaurar-desde-una-copia)). Si lo creara solo, un nombre equivocado
  daría una central vacía que contestaría que no existe ninguna licencia.
- **Con algo a medias no atiende**: una restauración que no terminó (`central_restauracion_a_medias`)
  o una vuelta a un instante preparada y sin aplicar (`central_vuelta_en_curso`). Lo dicen sus marcas
  en el almacenamiento del objeto, y es lo primero que mira.
- **Al arrancar se pone al día** con sus migraciones, dentro de `blockConcurrencyWhile` y sin atender
  nada mientras tanto. Si una aplicada ha cambiado (`central_migracion_alterada`) o una nueva no entra
  (`central_migracion_fallida`), no atiende, lo dice en cada llamada y avisa a Sentry
  (`central.migracion`).
- **Al empezar cada llamada mira las claves foráneas y los CHECK**: un `PRAGMA` lanzado a mano se
  quedaría puesto para todo lo que venga detrás en el objeto. Si los encuentra cambiados, los vuelve a
  poner y avisa a Sentry (`central.pragmas`). Encenderlas puede tener que esperar a que lo escrito se
  confirme, y nada de lo que decide la llamada se lee antes de esa espera.
- **Sólo ejecuta sentencias de filas, una por llamada**: `SELECT`, `INSERT`, `UPDATE`, `DELETE` y
  `WITH`. Ni varias en un texto, ni `PRAGMA`, ni de esquema, ni de transacción, ni `ATTACH`, ni
  `REPLACE`, `OR REPLACE` u `OR ROLLBACK`, ni nada sobre `_migrations`: `central_sentencia_prohibida`,
  que es un fallo del programa.
- **Nunca llama a otro objeto** (un `TenantHub`, una `AgendaWeb`): lo que hay que avisar después de
  escribir lo avisa quien llama, que puede esperar (`test/centralOperaciones.node.test.ts`).

Lo cubre `test/centralGuardas.test.ts`.

### Las operaciones

Lo que lee, decide y escribe en más de una sentencia, y tiene que entrar entero o no entrar, es una
operación (`server/central/operaciones/`, registradas en `registro.ts`). Corre entera dentro del
objeto, en un `transactionSync` (`baseCentral.operar.ts`), con el mismo SQL y en el mismo orden que
cuando el Worker la hacía con una transacción abierta por la red:

| Operación | La pide | Lo que hace el Worker antes y después |
|---|---|---|
| `canjearClave` | `/v1/license/activate`, al sumar una clave (`licensing.routes.ts`) | Antes, la DEK y el token; después, la frase de una clave ya usada y el recibo por correo |
| `emitirCobro` | El webhook de Stripe (`stripe.routes.ts`) | Antes, si la sesión ya se cumplió, con la consulta de la operación (`COBROS_DE_LA_SESION`: si lo está, sale sin preparar nada), y las claves (su huella, su forma corta y cifradas: la clave en claro no viaja), los ids y la hora; después, el correo con las claves y su marca |
| `revertirCobro` | El webhook: reembolsos y disputas | Después, marcar el evento y avisar al `TenantHub` de las altas anuladas |
| `revocarAMano`, `desrevocar` | `/v1/admin/licenses/:id/revoke` y `/unrevoke` | Antes, que la licencia exista; después, la auditoría y el aviso al `TenantHub` |
| `extenderAMano`, `acortarAMano` | `/v1/admin/licenses/:id/extend` y `/shorten` | Después, la auditoría. Leer la caducidad y escribir la nueva van juntos: dos a la vez no pierden ninguno de los dos cambios |

- **Es síncrona de principio a fin**: ni `async`, ni `await`, ni promesas, ni temporizadores, ni
  `fetch` o `crypto.subtle`, tampoco en lo que importa. Una espera dentro abriría el objeto a otras
  llamadas a mitad de la transacción, y lo escrito después quedaría fuera de ella. Si devuelve algo
  con `then`, se rechaza y se deshace. Lo vigila `test/centralOperaciones.node.test.ts`, que lee el
  fuente.
- **Devuelve un dato**: `null`, booleanos, números, textos, `ArrayBuffer`, y arrays y objetos
  literales de datos. Otra cosa (una instancia, una función, una fecha) se rechaza antes de confirmar
  y no queda nada escrito: el RPC la serializaría con la transacción ya confirmada, y quien la pidió
  recibiría un error de algo que sí entró. Un resultado de negocio (la clave ya usada, la sesión ya
  cumplida) es un valor; lanzar es fallar, y lo deshace todo (`central_operacion_fallida`, 500).
- **Un nombre no cambia nunca de significado**: una operación que cambia lleva un nombre nuevo.
  Durante un despliegue, un Worker nuevo puede hablar con el objeto de antes, que contesta
  `central_operacion_desconocida` a lo que no conoce (503: el cliente o Stripe repiten).
- **Una sola implementación**: lo que escribe licencias y cobros en más de una sentencia vive sólo
  aquí. En el Worker quedan las lecturas y las escrituras de una sentencia (`server/licenseStore.ts`:
  la auditoría, la marca del correo…). Las que corren también dentro de una operación (leer una
  licencia, darla de alta, apuntar en la auditoría) salen de constantes de `operaciones/licencias.ts`,
  que `licenseStore.ts` importa, para que no puedan divergir.
- **`emitirCobro` se repite una vez** si la plataforma corta la llamada por un fallo pasajero, porque
  no se sabe si entró. Si entró, contesta `ya_cumplida` con las licencias que preparó este Worker, y
  la emisión es ésta: se manda el correo. Con otras licencias es otra entrega de Stripe, y no se manda
  nada ([CLAVES-SIN-CORREO](../pendientes.md#claves-sin-correo--las-claves-de-un-cobro-que-no-llegaron-a-salir)).
  Una central saturada no se repite: Stripe reintenta más tarde.
- Lo demás son sentencias sueltas condicionadas y lotes todo o nada, con sus ventanas de siempre: la
  primera activación, los códigos por correo, el emparejamiento, los cupos de correo, el ticket del
  socket.

Lo cubren `test/centralOperar.test.ts`, `test/centralCarreras.test.ts` (la misma operación pedida a la
vez: un canje, una sesión de Stripe, un cargo revertido muchas veces), `test/centralFalloInyectado.test.ts`
(un fallo tras cada sentencia de cada operación, y la central entera tiene que quedar como estaba) y el
oráculo de equivalencia, `test/oraculoCentral.test.ts`: escenarios de las siete operaciones conducidos
sólo por HTTP, con Stripe, el correo y los `TenantHub` sustituidos, cuya foto de cada respuesta, cada
efecto y cada cambio en la central (`test/oraculo/central/`) se tomó con la central de antes de estar
en su objeto, y se compara entera. Se regeneran, a sabiendas de que lo que hace la central cambia, con
`pnpm --filter tpv-api exec vitest run test/oraculoCentral.test.ts -u`.

### Cuando no puede atender

La respuesta es la del objeto de un negocio que no puede atender (`lib/noDisponible.ts`): un 503
`external`, que la Main y la Handy tratan como la nube sin contestar y repiten
(`server/central/sinLaCentral.ts`):

- saturada (`overloaded`): `hub_overloaded`, con `Retry-After`;
- un fallo pasajero de la plataforma (`retryable`), un plazo vencido o cualquier otro rechazo del
  viaje (la plataforma no dice por qué, o el objeto ha lanzado): `hub_unavailable`;
- sin aprovisionar, una operación que no conoce, una migración alterada o fallida, o algo a medias
  (`ErrorDeLaCentral` con 503): `hub_unavailable`, sin `Retry-After`.

La traducen el `onError` de la `app`, el `/ws` y la activación cuando crea la base del negocio. Un
`catch` que seguiría sin la central la deja subir (`laCentralNoAtiende`): el feed de actualizaciones no
la lee como «no es piloto», que con sólo una beta publicada sería el 204 de «estás al día». **En
`tenantAuth` sólo un token o una firma que no valen son un 401** (`RechazoDeAutenticacion`): cualquier
fallo de la central sube al `onError`, porque un 401 le haría creer al equipo que su token no vale. El
motivo exacto no viaja: queda en Axiom (`central_no_disponible`, con el `motivo`: `saturada`,
`pasajera`, `plazo`, `rechazo` o el código del objeto) y, si no es carga ni un fallo pasajero, en
Sentry, con el error del viaje como causa, y en el log, que ahí hay algo que mirar
([observabilidad.md](observabilidad.md#eventos-de-tpv-sync)). Lo mismo queda cuando la central no le
atiende al `TenantHub`, que le habla por su cuenta (quién es la Main, el `last_seen`): el mismo evento,
con `metodo` `hub`, y Sentry con la misma regla (`registrarSinLaCentral`). Lo demás que le falle al
hub con la central (un error de SQL) va a Sentry, como siempre.

- **Nunca una respuesta que diga algo de la licencia o del equipo.** Una central vacía o a medias
  contestaría `license_not_found` a todos, y los clientes lo toman por un rechazo: la Main deja de
  replicar y sigue con la gracia sin conexión con `rejection_unverified`
  ([licencias.md](licencias.md#el-gate)), y la Handy se queda fuera en cada petición. Por eso la
  central no atiende sin aprovisionar ni a medias.
- Lo que la central lanza por otra cosa (un error de SQL, una sentencia prohibida, una operación que
  falla) sigue el camino de cualquier error: un 500 con su identificador (`central_error_sql`,
  `central_operacion_fallida`) y `code: internal`, y el texto de SQLite sólo en el log y en Sentry.
- Unas pocas cosas siguen sin la central, a propósito: el correo de un pedido sale aunque no se pueda
  apuntar ([Correo](#correo)) y los interruptores se dan por encendidos
  ([jobs-e-interruptores.md](jobs-e-interruptores.md#interruptores-remotos-de-emergencia-prod-06)).
  El feed de actualizaciones no: sólo le da el canal normal al equipo cuyo piloto no ha podido mirar
  por otro fallo de la lectura (un error de SQL), que va a Sentry. El webhook de Stripe contesta su
  503 y Stripe lo reintenta.

Lo cubre `test/centralNoDisponible.test.ts`.

### Un solo hilo

La central atiende de una en una lo de todos los negocios, y mientras se copia no atiende a nadie
([la copia](#la-copia-diaria)). Lo que se le lee en cada petición va en cachés de un minuto por
isolate: el dispositivo con su clave pública y el veto de la licencia (`tenantAuth`), los
interruptores, y las claves de la reserva web, con las que no valen en una caché aparte y acotada
(llenarla de claves inventadas no vacía la buena). `/health` recuerda su veredicto 30 s. El `TenantHub` le pregunta quién
es la Main como mucho una vez por minuto y negocio, y apunta el `last_seen` de un equipo como mucho
cada 5 minutos.

**Toda ruta anónima que lee la central lleva delante un filtro por IP o una caché.** El filtro es
`filtroPorIp` (`lib/limitador.ts`): contesta 429 `too_many_attempts`, con `Retry-After: 60`, antes de
leer el cuerpo y de tocar la central, y cuenta por red (AUD-11).

| Ruta | Lo que la protege |
|---|---|
| `GET /ws`, `POST /v1/license/refresh`, `POST /v1/pair/fetch-token` y `/cancel` | `LIMITADOR_SESION`, holgado: los equipos de un bar salen por la misma IP, y una Handy que espera la aprobación pregunta cada segundo y medio |
| `POST /v1/pair/claim` | `LIMITADOR_CLAIM`, y detrás el freno por IP de la base ([emparejamiento.md](emparejamiento.md)) |
| `POST /v1/license/activate` y `/device-change/request` | `LIMITADOR_LICENCIA` |
| `GET /v1/update/:target/:arch/:current` | `LIMITADOR_ACTUALIZACIONES` y la caché del feed: las versiones activas y los equipos piloto, leídos de una vez y guardados un minuto, que el isolate que publica, retira, promociona o marca un piloto vacía |
| Las públicas de la reserva web | `LIMITADOR_RESERVA_WEB` y la caché de las claves |
| `GET /health` | La caché de su veredicto |
| `GET /v1/license/status`, el webhook de Stripe, publicar y retirar versiones | Su secreto (el token, la firma de Stripe, el token de publicación), comprobado antes de leer nada |

Lo vigila `test/centralAnonimas.test.ts`, que recorre todas las rutas de la `app`: una anónima nueva
lo hace fallar hasta que alguien decide qué la protege y lo apunta, y lo apuntado se comprueba (con el
limitador cerrado no llega a la central; con caché, la segunda petición tampoco). Lo que haría falta
al crecer, sin decidir, está en [pendientes.md](../pendientes.md): `tenantAuth` en un solo viaje
(CENTRAL-AUTH) y más dispersión en el reintento del socket (SOCKET-DISPERSION).

### El plazo del `TenantHub` (CENTRAL-PLAZO)

- El `TenantHub` le habla a la central con plazo (`getCentralDb`): 5 s para leer quién es la Main
  (`mainEnCentral`, AUD-02) y 10 s para apuntar el `last_seen` de un equipo (`touchLastSeen`). Vencido,
  sale como `CentralNoDisponible` (`plazo`) y el hub sigue: el turno del log y la espera de la Main no
  se quedan colgados, y la tabla de la Main se queda como estaba. El `last_seen` que no se apunta se
  recoge en el hub, deja su `central_no_disponible` y, con el plazo vencido, va a Sentry
  (`sync.last_seen`); lo pone la siguiente actividad pasada la ventana.
- **La llamada vencida no se cancela.** Es un RPC, y Cloudflare no da forma de cortarlo: sigue viva
  sin nadie que la espere, y si escribía (el `last_seen`), escribe cuando la central la atiende.
  Mientras no termina es E/S pendiente, y el `TenantHub` no hiberna
  ([ciclo de vida](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
  El temporizador del plazo sí se quita al terminar (`conPlazo`), y el fallo de la llamada que ya
  nadie espera se recoge: no queda ningún rechazo sin recoger.
- **Se acepta así.** Sólo pasa si la central tarda más que el plazo, y la central no espera a nada de
  fuera mientras atiende: su SQL es síncrono. La otra forma, hablarle por `fetch` con
  `AbortSignal.timeout`, sería una segunda puerta a la central además del RPC, y antes habría que
  comprobar que cortar así libera de verdad al `TenantHub`.

Lo cubren `test/centralCliente.test.ts` (con la central ocupada, el plazo suelta a quien espera y la
llamada escribe después) y `test/elHubPuedeHibernar.test.ts`.

### Su esquema: migraciones en código

- Las migraciones de la central están en `src/server/central/migraciones/` y se registran, en orden,
  en `server/central/migraciones.ts` (`MIGRACIONES_DE_LA_CENTRAL`): el bundler no recoge una carpeta
  entera. `scripts/check-migration-registry.mjs` comprueba en CI que la carpeta y el registro
  coinciden y que ninguna abre o cierra transacciones. La primera, `0001_inicial.sql`, es el esquema
  entero.
- Las aplica el objeto con el mismo runner que la base de cada negocio
  (`sqliteDelObjeto.ts::migrarBase`, [esquema.md](esquema.md#cómo-se-aplica)): cada una en su
  transacción, con las claves foráneas apagadas alrededor de la tanda y `foreign_key_check` antes de
  confirmar, y en `_migrations` su nombre y el hash de su texto entero, comentarios incluidos. Una
  aplicada que cambia deja el objeto sin atender (`central_migracion_alterada`).
- **Un cambio es una migración nueva, aditiva, en un despliegue anterior al del código que la usa.**
  Durante un despliegue conviven el código de antes y el de ahora, a los dos lados del RPC: Cloudflare
  reparte el código nuevo poco a poco, y pide que lo que se dicen el Worker y sus objetos sea
  compatible en los dos sentidos
  ([known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)). Un
  Worker nuevo puede hablar un rato con el objeto de antes, que todavía no tiene la migración: por eso
  va en un despliegue anterior. Y un isolate con el código de antes puede hablar con el objeto ya
  migrado: por eso es aditiva, y nada de lo que el código de antes lee o escribe desaparece ni cambia
  de sentido.
- **La foto del esquema** es `src/server/central/esquema.snapshot.sql`, lo que dan las migraciones,
  comparada por `test/centralEsquema.test.ts`, que además fija a mano lo que no puede cambiar sin
  querer (las tablas, las columnas de `tenants`, el índice único de `license_payments` por sesión y
  unidad, las claves foráneas en cascada). Un cambio a propósito la regenera con
  `pnpm --filter tpv-api exec vitest run test/centralEsquema.test.ts -u`, y se revisa junto al de la
  migración.
- No es el esquema del negocio y no sigue sus reglas: no se replica, sus nombres van en inglés y
  algunas columnas toman su hora de un `DEFAULT`.

### SQL a mano

No hay ninguna ruta que acepte SQL. Para mirar, lo seguro es una copia abierta en local
([restaurar-la-central.md](../guias/restaurar-la-central.md#abrir-una-copia-en-local)). Para cambiar
una fila a mano está Data Studio, en el panel de Cloudflare (Durable Objects, el espacio de
`BaseCentral` de `tpv-api`, con el nombre `central`): ejecuta en el objeto de verdad, se factura como
cualquier petición y deja rastro en los registros de auditoría de la cuenta
([Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/)). **Ahí
no pasan las guardas del objeto: sólo sentencias de filas, nunca un `PRAGMA` ni una de esquema**
(`CREATE`, `ALTER`, `DROP`), que son de las migraciones. Un `PRAGMA` de las claves foráneas o de los
CHECK lo corrige la siguiente llamada, que avisa a Sentry (`central.pragmas`), pero lo escrito
entretanto ya habrá entrado. Antes de tocar nada, una copia (`pnpm central:copiar`).

## Cómo se escribe una ruta

- **Una ruta no lee su propio cuerpo.** Lo valida `lib/validacion.ts` —`cuerpo(schema)`,
  `consulta(schema)`— y el handler lo recoge con `c.req.valid("json")`.
- **Todo lo que decide antes de leer el cuerpo es middleware y va delante**: el veto de rol
  (`soloLaMain…`), un tope de tamaño, un token de administración, el filtro por IP del emparejamiento. Un
  `*.routes.ts` no resuelve roles. Lo vigilan `test/anularSoloMain.test.ts` y
  `test/vetoAntesDelCuerpo.test.ts`, que además pide cada ruta con un veto de rol como una Handy, con un
  cuerpo que no vale, por la `app` entera: tiene que quedarse en el veto, dentro del TenantHub.
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
- **Lo que decide si una escritura entra va en una guarda de su comando, no en una lectura de la
  ruta** (SYNC-30): un paso `{ kind: "guard", sql, args, error, status }` delante de lo que escribe,
  que el `TenantHub` evalúa dentro del lote atómico y no replica. Si su consulta no da un número
  distinto de 0, no queda nada (ni el gate de idempotencia) y la ruta contesta `error` con `status`,
  un 4xx con su frase en `MENSAJES`. Leído antes de `apply`, otra escritura podía entrar mientras
  el DO atendía a los demás. La ruta lee antes lo que necesita para construir el comando o para
  contestar sin escribir; lo que decide la guarda sólo lo mira también si tiene algo más que decir
  (con qué choca un solape), y entonces tiene que contestar lo mismo al reintento de una escritura
  que ya entró, que el gate contesta sin mirar la guarda. El porqué y la lista, en
  [sincronizacion.md](sincronizacion.md#lo-que-decide-una-escritura-se-mira-dentro-de-su-lote-sync-30).
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
  `/por-clave` y `/claves`) usan `cuerpoTolerante` con schemas que coercen y ponen valores por
  defecto: están en el camino de la recuperación y de la comprobación, donde se falla hacia «sigue
  trabajando». También el de `/v1/interruptores`, que la Main pregunta con su versión
  ([jobs-e-interruptores.md](jobs-e-interruptores.md)).
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
- **Un texto libre tiene un máximo** (AUD-36): las notas de un cliente, de un lote y de un pedido, la
  nota de una reserva y la información de un proveedor, como mucho 4.000 caracteres ya recortados
  (`cabeEnTextoLibre`, `lib/texto.ts`; en la Main, `tpv_domain::texto::texto_libre`), con sus casos en
  `validacion_casos.json`. Lo que escribe el negocio entero en una hora tiene además su presupuesto
  en el TenantHub ([sincronizacion.md](sincronizacion.md#el-lote-en-el-tenanthub-aplicarlote)): agotado,
  una escritura de la Handy contesta `presupuesto_agotado` (429).
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
  `test/quitarComillas.test.ts` y `test/topeDeLaFirma.test.ts`. Lo mismo con el SQL que sube la
  Main, que el `TenantHub` mira en cada operación (SYNC-34): el `;` final de un paso `value`
  (`evalValueStep`) se quita recorriendo desde el final, y los `'now'` que son argumento de una
  función de fecha (`tenantHub.tiempo.ts`) se buscan en una sola pasada, con una pila de los
  paréntesis abiertos. `test/tenantHubTiempo.test.ts` contrasta lo que se reconoce con el recorrido
  de antes y pasa textos enormes.
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
  de SQLite quedan en el log (`wrangler tail`) y en Sentry, donde se captura el error. Los `details`
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

**Un pedido no sale dos veces.** La Main o la Handy manda con cada pedido su clave de envío (`id_envio`, la
misma mientras se reintenta el mismo pedido sin cambiarlo, guardada en el almacenamiento de la
aplicación hasta que el envío termina bien: `claveDeEnvio.ts`), y es el id de su
fila (`pedido:<negocio>:<id_envio>`). La reserva del cupo es también la del id, en la misma
sentencia: un reintento de uno que ya salió (la respuesta se perdió por el camino) contesta `ok`
sin mandar otro; uno que está saliendo ahora por otra petición, 409 `email_en_curso`; uno que
falló, o que se quedó a medias más de cinco minutos, se vuelve a reservar y sale. Lo que ya salió no
se pisa nunca (`ok = 1`), y apuntar que salió se intenta tres veces antes de rendirse: uno que salió y
se queda en `enviando` es lo único que un reintento podría repetir. Un pedido sin clave, o con una
que no tiene su forma, se rechaza (`validation_error`) sin gastar cupo. Con la base central caída el
pedido sale igual: no se sabe si ya salió, y entre no mandar un pedido y mandarlo dos veces en una
caída se queda lo segundo.

Los correos al cliente de una reserva web salen de `domains/reservas_web/correos.ts`, desde
`EMAIL_RESERVAS_FROM_ADDRESS` con el nombre del negocio y su correo de contacto como `Reply-To`. Sólo
llevan datos estructurados (nada que haya escrito el visitante), van a la dirección del alta o al
cliente de la reserva web en la nube, y tienen sus topes: 600 al día por negocio y 10 por
destinatario, sobre lo entregado y lo que está saliendo (`tipo = 'reserva_web'`). Cada uno lleva su
id en `email_sends`, y el id y el cupo se reservan en una sola sentencia antes de enviar: el mismo
no sale dos veces, muchos a la vez no pasan de los topes y uno que falló se puede repetir. Un correo
puede exigir que otro haya salido (o esté saliendo) antes (`trasElCorreo`, en la misma sentencia):
el «has cancelado» sólo sale tras la confirmación de esa reserva (o si se cancela con el enlace
del correo de un cambio del restaurante), y si no, no gasta cupo (RW-ALTAS). Sin la base central no se envía (no se sabría si ya salió). Qué correo y cuándo:
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
`aprovisionar`, `revocarDispositivo`, `releerMain` (AUD-02: la licencia del negocio ha cambiado),
`avisarEmparejamiento` y los de administración de su base (DO-03: `estadoDeLaBase`, `copiarAhora`,
`prepararVuelta`, `reiniciar` y `trasVolver`; DO-PERDIDA: `crearBaseVacia` y `restaurarDesdeCopia`). Su única alarma es la de la copia diaria. El adaptador moderno extiende `DurableObject`; los
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

Se guardan en R2 con prefijo por tenant, y su ruta es siempre `images/{carpeta}/{uuid}.{ext}`: una
carpeta de la lista, en minúsculas, y por nombre el UUID que le pone la app al guardarla
(`RUTA_DE_IMAGEN`, `domains/images/rutaDeImagen.ts`; en la Main, `imagenes::ruta_segura`, y en la
Handy, `imageUrl.ts`, que admiten lo mismo). Esa ruta va en el camino de
`/v1/images/…`, y Cloudflare guarda la URL de cada petición: un
nombre que alguien le diera al fichero puede ser el de una persona (OBS-06). Las imágenes heredadas,
guardadas antes con su nombre, las renombra la Main en cada arranque antes de subir nada
(`images_backfill`, `renombrar_imagenes_heredadas`): copia el fichero con un UUID, encola la copia,
cambia las filas que la usan (productos, categorías, proveedores y alérgenos) en una transacción por
`WriteGuard`, que sube a la nube, y borra el fichero de antes. Encolada antes de cambiar las filas,
un corte a medias no deja ninguna fila apuntando a una imagen que no va a subir. Una que no usa
ninguna fila se queda como está, sin subir. Lo que no tiene esa forma no se sube, se baja ni se borra, y la Handy no lo
pide (`imageUrl.ts`). El que la ruta de una imagen sólo admita eso lo comprueba
`test/sinDatosPersonalesEnLaQuery.node.test.ts`.

**Quién lee el bucket.** La app lo lee por el worker:

| Quién | Cómo | Ruta |
|---|---|---|
| La Handy | `<img>` a `GET /v1/images/{tenant}/{ruta}`, público | La base `{CLOUD_API_BASE}/v1/images/{tenant}` la da Rust (`handy_url_imagenes`, `tpv_infra_licensing::url_imagenes_del_negocio`) y `imageUrl.ts` le pega la `Ruta_Imagen` |
| La Main | `POST /v1/images/download`, firmado, el negocio sale del token | `images_ensure_local`, que la deja en disco ([tickets.md](tickets.md) para el logo) |

El bucket no tiene acceso público: su dirección `r2.dev` está cerrada, y sólo se lee por el worker.
La CSP de la webview admite en `img-src` el origen del worker y no `r2.dev` (lo vigila
`lib.rs::las_imagenes_de_la_handy_salen_del_worker_y_no_de_r2_dev`).

**El GET público** contesta:

- **200** con los bytes, `Content-Type` según la extensión (el PUT ya exige que los bytes casen con
  ella), `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` y el
  `ETag` de R2.
- **400** `bad_image_path` si la ruta no es de la app o el negocio del camino no tiene forma de id
  (letras, cifras, `-` y `_`: ni una barra, que Hono descodificaría de un `%2F`, ni un punto),
  **404** `not_found` si aún no está en el bucket
  (la subida va por otro canal: el mismo URL la da en cuanto llegue) y **429** `too_many_attempts` si
  la red de quien pide pasa del filtro. Los tres con `Cache-Control: no-store`: no se guardan en la
  webview ni en una caché intermedia. El 400 y el 429 no llegan a R2; el 404 es una lectura que no
  encuentra nada.
- El negocio del camino es la carpeta del bucket (`prefijoDelNegocio`, que acaba en `/`): con otro
  negocio en el camino no se llega a lo que no es suyo. Lo público es la imagen de quien sepa su negocio
  y su UUID, que no se enumeran.

⚠️ **Cada imagen que llega al worker puede ser una lectura de R2.** El worker se sirve por
`workers.dev` (INFRA-04), y la documentación de Cloudflare sólo promete la Cache API en un dominio
propio («Workers deployed to custom domains have access to functional `cache` operations»,
[Cache](https://developers.cloudflare.com/workers/runtime-apis/cache/)); de `workers.dev` sólo dice
cómo forma la clave. El `caches.default` del GET se queda por si funciona, pero no se cuenta con él.
**La caché que cuenta es la de la webview**: el 200 es `immutable` por un año y cada imagen da siempre
el mismo URL (`imageUrl.ts` lo memoriza), así que una Handy pide cada imagen una vez y no la vuelve a
pedir mientras tenga su caché. Lo que cuesta cada fallo de esa caché: una petición del worker (con su
línea en los logs del worker, `observability` y `logpush`) y una operación de clase B de R2. Delante de R2 hay un filtro por IP holgado, `LIMITADOR_IMAGENES` (3000 por
minuto y red, `/64` en IPv6, AUD-11), para que nadie haga gastar sin techo; una Handy que estrena la
carta pide cientos de golpe, y las de un bar salen por la misma IP. Sólo cuenta lo que llega a R2.
Como los demás limitadores, si falta o falla deja pasar. El `<img>` no ve el 429: `ImageWithFallback`
lo trata como cualquier fallo, con sus reintentos rápidos (unos 12 s, dentro de la ventana) y, agotados,
el marcador y un último intento pasado el minuto (`ULTIMO_REINTENTO_MS`, más que el `Retry-After: 60`);
si ése también falla, la imagen se queda en el marcador hasta que se vuelva a pintar la pantalla.

Borrar una imagen la quita también del caché del edge (si lo hay), pero **sólo del centro de datos que
atiende la petición** (barrer los demás pediría el API de purga).

**Lo que se guarda, lo que se sube y lo que se pinta (AUD-31).** El valor de una imagen se replica y lo
pinta cada equipo, también en la pantalla de entrada, así que:

- Una columna de imagen (`Ruta_Imagen` de productos, categorías y proveedores, y `Logo_DataUrl`) sólo
  guarda esa forma, o nada. Lo comprueban los schemas del worker (`esImagenGuardable`) y los `validar`
  de la Main (`tpv_domain::imagenes::validar_ruta_imagen`), con los mismos casos y el mismo mensaje en
  `validacion_casos.json`. Ni un `data:`, ni una URL, ni la ruta de otro fichero.
- La pantalla (`imageUrl.ts`) pinta sólo eso o un icono de alérgeno de la app (`/alergenos/…`); lo
  demás, o una imagen que la Main no tiene en disco, da `""` y el `<img>` pinta su marcador. La CSP de
  la webview no admite `data:` en `img-src`.
- El PUT exige JPEG o PNG (no WebP, que la Main no decodifica, AUD-30) cuya cabecera declare como
  mucho 8192 px de lado y 24 Mpx, las cotas de RI-07 (`imagenes::decodificar`); lo demás es
  `image_too_large` (413) o `bad_image_path` (400). La app sube siempre lo que ya ha reconstruido
  `imagenes::procesar` (1024 px de lado como mucho).
- Lo que la Main baja de R2 (`images_ensure_local`) pasa por `imagenes::procesar` antes de escribirse
  en disco; si no pasa, no se escribe y contesta `false`.

La clave de la Cache API omite la query: no hay transformaciones por parámetros, así que distintas
queries reutilizan la misma imagen y el borrado usa esa misma URL. No requiere opciones del plan
de Cloudflare; `ignoreSearch` no está soportado por esta API. Esto no modifica las cachés TanStack
del cliente ni la de la webview.

Main y Handy guardan su cola local en `image_uploads.json`, con escritura temporal y sustitución
atómica. Solo hay un drenaje activo; cada confirmación modifica su propia revisión, conservando
las entradas añadidas durante una subida. Los rechazos de contenido (400/413/415/422) y archivos
locales ausentes o inválidos se apartan, sin detener las siguientes imágenes. Los errores de red,
credenciales y servidor conservan la entrada para reintentar. Una cola ilegible devuelve un error:
no se trata como vacía ni se sobrescribe. La pantalla de Conectividad (fuera del menú) muestra el
estado y permite reintentar; sustituir una imagen desde su ficha elimina su entrada anterior. Cada rechazo nuevo
se registra a nivel ERROR, que la integración existente con Sentry captura una sola vez.

## Facturas en PDF

El PDF de cada factura completa (un registro `ALTA` de `Registros_Facturacion` con destinatario) se
guarda en el mismo bucket que las imágenes, `IMAGES` (`tpv-images`), en
`{tenant}/facturas/{ID_Registro}.pdf`: un solo bucket para lo de los TPV, y lo que separa una cosa de
otra es la carpeta. Lo compone la Main una vez, después del cobro o de la emisión, y lo sube; es la
copia «congelada» que vuelve a bajar un equipo restaurado. Sólo la ve la Main, nunca la Handy. En la
Main lo mueve el job `facturas_pdf` (`tpv-infra-licensing/src/facturas.rs` es el cliente de estas
rutas; [tickets.md](tickets.md#el-pdf-de-una-factura-completa)).

Las rutas están en `domains/facturas/facturas.routes.ts` (la clave, en `claveDeFactura.ts`). No tocan la
base del negocio, así que se ejecutan en el Worker (sin `alHub`) y el veto es `soloLaMainVigente`, que
además mira la licencia sin caché. **Ninguna ruta borra una factura**: se conservan por ley. Lo único
que vacía esa carpeta es retirar un negocio de pruebas, que se lleva todo lo suyo.

**El contrato.** Las dos rutas van firmadas como las demás (`Authorization: Bearer`, `X-Device-Ts`,
`X-Device-Sig`; la firma cubre los bytes del cuerpo). El negocio sale del token; en el camino o en el
cuerpo sólo viaja el `ID_Registro`, un UUID (en cualquier caja; la clave lo escribe en minúsculas),
nunca el número de la factura ni el NIF (AUD-27).

`PUT /v1/facturas/{ID_Registro}`: sube el PDF. Cuerpo: los bytes del PDF tal cual
(`Content-Type: application/pdf`).

| Estado | Cuerpo | Cuándo |
|---|---|---|
| 200 | `{ "ok": true, "ya_estaba": false }` | Guardado |
| 200 | `{ "ok": true, "ya_estaba": true }` | Ya había un PDF de ese registro: no se toca (una factura subida no cambia). Para la Main es «subido» |
| 400 | `factura_id_no_valido` | El id del camino no es un UUID |
| 400 | `factura_no_es_pdf` | El cuerpo no empieza por `%PDF-` (o va vacío) |
| 403 | `forbidden_not_tpv` | Lo pide una Handy |
| 403 | `device_replaced` / `license_revoked` (y los demás rechazos de `tenantAuth`, 401 o 403) | La licencia ya no es de este equipo, o la firma o el token no valen |
| 413 | `factura_demasiado_grande` | Más de 5 MB (`MAX_BYTES_FACTURA`). Se decide antes de leer el cuerpo y de autenticar |

`POST /v1/facturas/descargar`: baja el PDF. Cuerpo JSON `{ "id_registro": "<UUID>" }` (1 KB como
mucho; si pasa, 413 `payload_too_large`).

| Estado | Cuerpo | Cuándo |
|---|---|---|
| 200 | Los bytes, `Content-Type: application/pdf`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` y el `ETag` de R2 | Está en la nube |
| 404 | `not_found` (`no-store`) | No está: aún no se ha subido. La Main la compone ella |
| 400 | `factura_id_no_valido` | Falta `id_registro` o no es un UUID (sin espacios alrededor) |
| 403 | `forbidden_not_tpv`, `device_replaced`… | Como en la subida |

Los errores salen como todos los del worker, `{ ok: false, code, error }` (`completarErrores`), con
`code` del catálogo: `validation` para los 400, `external` para el 413 y el 403 de la Handy, y
`device_revoked` o `license_expired` para la licencia. Los identificadores `factura_*` están en
`SIN_MENSAJE_PROPIO`: los lee el job de la Main, que reintenta o aparta, y no llegan a nadie.

**No se sobrescribe.** La subida pregunta antes si ya está (`head`) y, si no, escribe con
`If-None-Match: *`: si otra subida del mismo registro se cuela entre medias, R2 no escribe y la ruta
contesta `ya_estaba: true`.

**Las rutas de imágenes no llegan a las facturas.** Todas exigen una ruta con la forma de
`RUTA_DE_IMAGEN` (que empieza por `images/` y acaba en una extensión de imagen), y el GET público
además un negocio con forma de id. Ni el GET público, ni la subida, el borrado o la descarga firmados
de imágenes entregan, aceptan o borran nada de `facturas/`, se les pida como se les pida (mayúsculas,
`..`, `%2e%2e`, `\`, `%2F` en la ruta o en el negocio): lo vigila `test/facturasEnElBucket.test.ts`, que
cubre también la inmutabilidad, el tope, el veto y que sólo borren del bucket las rutas de imágenes y
la retirada de un negocio de pruebas. Que las rutas de facturas sean de la Main vigente lo vigila
además `test/mainDesplazadaRest.test.ts`.

## Salud y vigilancia externa

- **`/health` toca la base central** (`server/salud.ts`) y contesta 200 o 503. Una central sin
  aprovisionar, averiada o que no contesta es una base que no responde (`db: "inalcanzable"`). El
  cuerpo no cuenta por qué: el motivo se queda en el log y en Sentry (`health.database`). Caché de
  30 s por isolate: la ruta es pública. No toca ninguna base de tenant. Lo vigila `test/salud.test.ts`.
- **También descifra el canario de `LICENSE_STORE_KEY`** (`canario_cifrado`, RI-73): con una clave
  equivocada contesta 503 (`cifrado: "falla"`). La fila la crea el propio `/health` la primera vez. Sin la
  tabla, `cifrado: "sin_comprobar"` y la sonda sigue en verde.
- Una sonda externa (Better Stack) la consulta en `tpv-api.altarialights.workers.dev/health`, el mismo
  hostname que usan los clientes.

## El cron diario

`scheduled` en `src/index.ts`. Cada tarea va en su `try` y ninguna propaga:

1. **Avisos de caducidad** de licencias ([licencias.md](licencias.md#avisos-de-caducidad)).
2. **Purga de la base central** (`server/purga.ts`): fallos de emparejamiento, trazas de correo,
   eventos del código de cambio de equipo, códigos de emparejamiento caducados hace más de un día,
   que liberan su número (AUD-12), y retos de emparejamiento caducados (AUD-13). Va antes de la
   copia, para no guardar lo que se tira.
3. **Copia de la base central a R2**: se la pide a su objeto (`centralDe(env).copiar(<día>)`,
   [abajo](#la-copia-diaria)) y, sólo si se subió, late `BETTERSTACK_HEARTBEAT_COPIAS_URL`. Si no, a
   Sentry (`cron.backup`). Si la copia pasa de 150.000 filas (`FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ`),
   avisa también a Sentry: la copia vale, pero ya no se restauraría de una vez
   ([CENTRAL-RESTAURAR](../pendientes.md#central-restaurar--la-central-se-restaura-en-una-sola-llamada)).
4. Al final y fuera de los `try`, el latido del cron (`BETTERSTACK_HEARTBEAT_URL`), aunque una tarea
   haya fallado: responde a «¿se ejecuta el cron?». Un latido nunca propaga (`observability/latido.ts`).

## Las copias de la base central, restaurarla y volver a un instante

Es la base que no se puede perder: por ella pasan todos los negocios, y una central vacía o a medias
contestaría `license_not_found` a todos ([arriba](#cuando-no-puede-atender)). Cloudflare puede devolver
su objeto a cualquier instante de los últimos 30 días; eso no cubre que el objeto se pierda (un
borrado, otro nombre, el propio proveedor) ni lo que se descubre pasado ese plazo, y para eso está la
copia en R2, fuera del objeto. Las dos vueltas atrás son de administración (`domains/admin/central.ts`,
`pnpm central:*`; el procedimiento, en [restaurar-la-central.md](../guias/restaurar-la-central.md)).

### La copia diaria

La hace el propio objeto (`BaseCentral.copiar`, `durableObjects/baseCentral.copia.ts`, PROD-02):

- **Tres clases, en `base-central/`**: la del día, que pide el cron (`base-central/<AAAA-MM-DD>.sql.gz`,
  con el día en UTC; repetirla el mismo día la reescribe); una a mano, que pide la administración
  (`base-central/a-mano-<hora>.sql.gz`, que no pisa la del día); y la de cómo estaba antes de volver a
  un instante (`base-central/antes-de-volver-<hora>.sql.gz`). La hora va en ISO, con guiones en vez de
  dos puntos, para que la clave sirva de nombre de fichero también en Windows.
- **Es una foto**: lee `sqlite_master` y todas las tablas y comprime de una pasada, sin esperas
  (`GzipPorTrozos`, `volcadoSql.ts`, con `node:zlib`), así que ninguna escritura se intercala: la
  copia no puede tener una licencia sin su negocio ni un dispositivo sin el suyo. Sólo la subida, que
  ya es de lo leído, espera a R2. Lo que se paga es que, mientras lee y comprime, la central no atiende
  a nadie.
- **El formato es el de la copia de cada negocio** (`volcadoSql.ts`): un volcado SQL comprimido con
  gzip que abre `gunzip -c <copia>.sql.gz | sqlite3 central.db` sin nada nuestro
  (`test/copiaCentralSinNuestroCodigo.node.test.ts` la abre con `node:sqlite`). En la cabecera, con qué
  migraciones se hizo (`-- Migraciones: …`), cómo abrirla y cómo devolverla; después, cada tabla con
  su `CREATE` y sus filas, una sentencia `INSERT INTO "<tabla>" (<columnas>) VALUES (…);` por línea y
  en el orden en que entraron; los índices al final, y la línea del fin con las filas y las tablas
  (`-- Fin de la copia: …`). Un salto de línea dentro de un texto va como `char(10)`, y un texto con
  más de 40, o con un NUL, en hexadecimal.
- **Va todo lo que es de la base**, también una tabla que se cree mañana, sin tocar la copia. Fuera
  quedan las tablas de SQLite, las del propio objeto (`_cf_*`) y `_migrations`, cuyo papel lo hace la
  línea de las migraciones.
- **En R2 lleva** sus metadatos (cuándo se leyó, filas, tablas y la última migración) y su SHA-256,
  que R2 comprueba al recibirla.
- **Bucket privado y propio**: `tpv-copias-control` (`COPIAS`), nunca `tpv-images`, que se sirve sin
  firma: lleva los correos de los clientes y las DEK de los negocios, cifradas con
  `LICENSE_STORE_KEY`. Sin esa clave la copia no las devuelve: se guarda fuera de Cloudflare.
- **Cuánto se guardan lo decide la regla de ciclo de vida del bucket**, en Cloudflare, no el código, y
  vale también para las de a mano y las de antes de volver. Tiene que quedar por debajo de los 90 días
  de `RETENCION_ENVIOS_MS`, o los correos que la purga olvida seguirían vivos en las copias.
- **Un techo**: 32 MiB comprimida (`TOPE_COMPRIMIDO`). Se monta en memoria y al cerrarla ocupa el
  doble, dentro de los 128 MB del objeto. Pasado, falla en voz alta (`central_copia_fallida`) en vez
  de reventar el objeto, y el latido de la copia deja de sonar.

Lo cubre `test/copiaBaseCentral.test.ts`, que siembra una central con las operaciones de verdad, la
copia, la devuelve a otro objeto y las compara tabla a tabla, con el tipo de cada valor.

### Restaurar desde una copia

`aprovisionar({ claveDeCopia })` (`durableObjects/baseCentral.restaurar.ts`), con el cargador que
comparte con la base de cada negocio (`cargaDeCopias.ts`). **Sólo en un objeto sin aprovisionar**, o
con una restauración a medias; en uno aprovisionado no toca nada (`central_ya_aprovisionada`). Una
central con datos malos no se restaura: [vuelve a un instante](#volver-a-un-instante).

- **Nada se intercala**: corre dentro de `blockConcurrencyWhile`, así que ninguna otra llamada entra
  hasta que acaba, tampoco las guardas que reafirman las claves foráneas, que aquí van apagadas
  mientras entran las filas.
- **En este orden**: vacía el objeto (`deleteAll`) y pone la marca de restauración; mira que la copia
  sea de un esquema que este worker sabe poner (sus migraciones, un principio de las de aquí); pone
  ese esquema con las migraciones de la copia; carga sus filas, en tablas de la base y en lotes de
  unos 4 millones de caracteres por transacción, sin ejecutar ningún texto de la copia: cada línea de
  datos se lee entera con la gramática cerrada del cargador (`INSERT INTO "<tabla>" ("<columna>", …)
  VALUES (<literal>, …);` y nada más, como la de [un negocio](#las-copias-de-la-base-de-cada-negocio-do-03)),
  y se ejecuta la sentencia que escribe él con lo leído (una línea que no se lee así, o de otra
  tabla, la hace inservible); mira que esté entera (su línea del fin, con las mismas filas) y que no
  deje ninguna clave foránea rota; aplica sobre sus datos las migraciones que le falten, y quita la
  marca en la misma transacción que da la central por buena.
- **Si falla, como estaba**: vacía el objeto entero, marca incluida, y contesta
  `central_copia_inservible` con el motivo (`copia_no_encontrada`, `copia_no_valida`, `copia_cortada`,
  `copia_de_otra_version`, o que no se ha podido cargar, que va además a Sentry: `central.restaurar`).
  El motivo no lleva nada de la copia: de una línea que no se lee, su número, el carácter y un código
  (`tabla_ajena`, `columna_desconocida`, `valor_no_literal`…); de unas filas que SQLite no acepta, sus
  líneas, sus tablas y el código de SQLite, cuyo texto va sólo a Sentry, como causa.
- **Si el objeto se reinicia a mitad**, al arrancar la marca sigue ahí: no atiende
  (`central_restauracion_a_medias`) ni se pone al día con sus migraciones, y la siguiente restauración
  empieza vaciándolo.
- **El límite son los 30 s de `blockConcurrencyWhile`**: pasados, el objeto se reinicia y la marca lo
  deja sin atender. Medido en local con filas como las de la central, 150.000 tardan entre 11 y 16 s;
  lo que manda son las filas, no los bytes, así que la copia admite más de lo que se restaura de una
  vez. Por eso avisa el cron
  ([CENTRAL-RESTAURAR](../pendientes.md#central-restaurar--la-central-se-restaura-en-una-sola-llamada)).
- **El mismo camino carga una base que no sale de una copia**: convertida a este formato, subida a
  `base-central/` y aprovisionada desde ahí
  ([la guía](../guias/restaurar-la-central.md#una-base-que-no-sale-de-una-copia)).

Lo cubren `test/centralRestaurar.test.ts` y `test/cargaDeCopias.test.ts`.

### Volver a un instante

Con la API de Cloudflare (`getBookmarkForTime`, `onNextSessionRestoreBookmark` y `ctx.abort()`), detrás
de `Instantes` (`durableObjects/instantes.ts`), lo que comparte con la vuelta de cada negocio. Vuelve
el objeto entero y en el sitio. Lo pide `/v1/admin/central/volver`, en dos llamadas al objeto, cada
una con su stub:

1. **`prepararVuelta`** (`baseCentral.instante.ts`), sólo con la central aprovisionada, sin avería y
   sin una restauración a medias. Pone la marca de vuelta en curso, y desde ahí la central no atiende
   (`central_vuelta_en_curso`): lo que se escribiera no estaría en la copia de antes y se perdería al
   volver. Saca el marcador del instante antes de copiar nada (si la plataforma no vuelve o el instante
   no vale, no hay copia inútil), deja en R2 la copia de cómo está (`antes-de-volver-<hora>`) y la
   vuelta preparada para el siguiente arranque, y devuelve el marcador con el que se deshace. Si algo
   falla antes de dejarla preparada, quita su marca, o vuelve a poner la de una vuelta anterior que
   siguiera preparada, y la central vuelve a atender.
2. **`reiniciar`**: `ctx.abort()`. La llamada falla siempre, y es lo esperado: al arrancar, el objeto
   vuelve.

- **Al arrancar, la marca de una vuelta se quita**: la vuelta se aplica en el arranque, sea cual sea
  su causa, y lo que queda de la marca es de antes. Así, deshacer una vuelta (volver a su marcador,
  que es el estado de justo antes de reiniciar, con la marca puesta) no deja la central cerrada.
- **La ruta espera a que conteste** (diez veces, cada medio segundo) y, si sigue con la vuelta sin
  aplicar, la reinicia otra vez. Una central que ha vuelto pero no atiende (una migración que no
  entra) no se da por buena.
- Sólo a un instante pasado de los últimos 30 días (`central_instante_fuera_de_plazo`). No existe en
  local ni en los tests (`central_vuelta_no_disponible`): se prueba con un doble de `Instantes`
  (`test/centralVolver.test.ts`, `test/centralAdmin.test.ts`).

### Las rutas de administración de la central

Van detrás de `requireAdmin` (`ADMIN_API_TOKEN`), que no lee la central: todas contestan también con
ella sin aprovisionar.

| Ruta | Qué hace | CLI |
|---|---|---|
| `GET /v1/admin/central/estado` | Si está aprovisionada, sus migraciones, su avería, lo que tiene a medias (`enCurso`), las filas de cada tabla y lo que ocupa. Sólo lee | `pnpm central:estado` |
| `GET /v1/admin/central/copias` | Sus copias en R2, de la más reciente a la más vieja, con sus metadatos (100 como mucho, y `hayMas`) | `pnpm central:copias` |
| `POST /v1/admin/central/copiar-ahora` | Una copia ahora, con la hora en la clave | `pnpm central:copiar` |
| `POST /v1/admin/central/aprovisionar`, `{ claveDeCopia? }` | A un objeto sin aprovisionar: el esquema vacío o, con la clave, esa copia. La clave se valida antes de llegar al objeto: dentro de `base-central/`, un `.sql.gz` y sin `..` | `pnpm central:aprovisionar -- [--copia <clave>] --si` |
| `POST /v1/admin/central/volver`, `{ instanteMs }` o `{ marcador }` | A un instante o a un marcador | `pnpm central:volver -- (--instante <fecha ISO> \| --marcador <m>) --si` |

- **Lo que no se hace contesta `{ ok: false, error, message, detalle? }`** con el estado HTTP de su
  código ([abajo](#los-códigos-de-la-central)): `error` es el código; `message`, qué pasa y qué hacer
  (`QUE_PASA`, en `central.ts`); y `detalle`, si el objeto lo da, el motivo técnico, que el CLI enseña
  aparte («Motivo: …»). Al volver lleva además `deshacer` y `copiaDeAntes` aunque no haya salido
  entera, y el CLI escribe la orden que la deshace.
- **El rastro**: lo que cambia algo (copiar, aprovisionar o restaurar, volver) deja una línea en el
  log (`[central] {…}`) y el evento `central_administrada` en Axiom, con la acción, el resultado y,
  según el caso, la clave de la copia, sus filas y tablas, el destino, el marcador para deshacer y la
  copia de antes: nunca datos personales. No va a `admin_audit`, que es una tabla de la propia
  central: restaurarla o devolverla a un instante la reescriben. Al volver se deja dos veces: con
  `resultado: "preparada"` en cuanto la vuelta está preparada, antes de reiniciar (si la llamada no
  termina, es lo que queda de con qué se deshace), y con el resultado al final.

### Los códigos de la central

Los contesta el objeto (`CodigoDeLaCentral`, `baseCentral.rpc.ts`), salvo los dos últimos, que son de
la ruta que vuelve a un instante. Su estado HTTP lo fija `server/central/cliente.ts`.

| Código | HTTP | Cuándo |
|---|---|---|
| `central_sin_aprovisionar` | 503 | El objeto no tiene esquema: nadie lo ha aprovisionado, o se le ha pedido con otro nombre |
| `central_operacion_desconocida` | 503 | Una operación que este objeto no conoce: un despliegue a medias |
| `central_migracion_alterada` | 503 | Una migración ya aplicada ha cambiado |
| `central_migracion_fallida` | 503 | Una migración no ha podido aplicarse |
| `central_restauracion_a_medias` | 503 | Una restauración que no terminó: hasta que otra la vacíe y termine |
| `central_vuelta_en_curso` | 503 | Una vuelta a un instante preparada y sin aplicar: hasta que el objeto se reinicie |
| `central_error_sql` | 500 | Una sentencia ha fallado (una restricción, una columna que no existe): no ha escrito nada |
| `central_operacion_fallida` | 500 | Una operación ha lanzado: no ha escrito nada |
| `central_sentencia_prohibida` | 500 | Una sentencia que la central no ejecuta: un fallo del programa |
| `central_copia_fallida` | 500 | La copia no ha llegado a R2 (R2, el techo, un día mal escrito): no ha subido nada |
| `central_ya_aprovisionada` | 409 | `aprovisionar` en un objeto con esquema: no ha tocado nada |
| `central_copia_inservible` | 422 | La copia no se puede restaurar: el objeto se queda sin aprovisionar, como estaba |
| `central_instante_fuera_de_plazo` | 400 | Un instante del futuro o de hace más de 30 días |
| `central_vuelta_no_disponible` | 501 | La plataforma no devuelve objetos a un instante (en local) |
| `central_vuelta_sin_aplicar` | 503 | La vuelta está preparada pero la central no se ha reiniciado, y sigue cerrada: se repite la orden |
| `central_vuelta_sin_comprobar` | 503 | La central se ha reiniciado pero todavía no contesta: se mira cómo está |

- **Los seis primeros son «no puede atender»**: a una ruta que no es de administración le llegan como
  el 503 `hub_unavailable` ([arriba](#cuando-no-puede-atender)), y su código queda como el `motivo` de
  `central_no_disponible` en Axiom. Una ruta de administración los contesta con su código y su frase.
- **Los de 500** siguen el camino de cualquier error: la respuesta lleva el código y `code: internal`,
  y el detalle (el texto de SQLite, el motivo) sólo va al log y a Sentry.
- Todos están en `SIN_MENSAJE_PROPIO` (`lib/errorCodes.ts`): nadie se los enseña a quien usa el TPV.

## Las copias de la base de cada negocio (DO-03)

La base de un negocio tiene dos vueltas atrás, y las dos se piden desde la administración
(`domains/admin/basesDeNegocios.ts`, `pnpm negocio:*`; el procedimiento, en
[restaurar-un-negocio.md](../guias/restaurar-un-negocio.md)). Lo que cambia algo queda en
`admin_audit` con su motivo, y en Axiom sin él.

**La copia diaria** (`durableObjects/tenantHub.copia.ts`):

- **Cada TenantHub se copia a sí mismo, con su alarma**, entre las 3:00 y las 5:00 UTC (cada negocio
  a su minuto, sacado de su nombre). No hay un bucle en el cron: con miles de negocios no cabría en su
  plazo, y cada objeto tiene su base al lado. El alta arma la alarma, y un objeto con base que no la
  tenga (uno de antes, o uno vuelto a un instante) la arma en su primer acceso a la base. Sin base o
  sin negocio apuntado no copia ni se vuelve a armar, y `borrarTodo` la quita.
- **Es una foto**: lee y comprime sin esperas (gzip a trozos con `node:zlib`, en un solo miembro, que
  es lo que abre el `DecompressionStream` del runtime), así que ninguna escritura se intercala. Sólo
  la subida espera a la red. Mientras lee ocupa el hilo del negocio: por eso va de madrugada.
- **Sólo las tablas del negocio** (`esTablaDeNegocio`): ni las que empiezan por `_`, ni el log de la
  réplica, ni los intentos de PIN, ni vistas ni disparadores.
- **Un volcado SQL comprimido**, legible sin nuestro código (`gunzip -c | sqlite3`), con una
  sentencia de datos por línea (un salto de línea dentro de un texto va como `char(10)`, y un texto
  con más de 40, en hexadecimal: el SQLite de un objeto no admite una expresión de más de 100
  niveles, y cada salto son dos), las migraciones de la base en la cabecera y una línea de fin con
  las filas. Es el formato de la copia de la base central (`volcadoSql.ts`).
- **Bucket propio y privado**: `tpv-copias-negocios` (`COPIAS_NEGOCIOS`),
  `negocios/<negocio>/<AAAA-MM-DD>.sql.gz`. No es el de la base central: lleva los datos personales
  de los clientes de cada bar, un token de R2 que lea uno no lee el otro, y la retención es otra.
- **Se guardan 30 por negocio y lo decide el código** (`COPIAS_QUE_SE_GUARDAN`, al subir cada una),
  no una regla por antigüedad: ésa borraría también las últimas de un objeto perdido, que ya no hace
  copias nuevas, y es justo cuando hacen falta. La regla de ciclo de vida del bucket (90 días) es la
  red de lo que nadie poda: las copias de un negocio retirado.
- **Un techo**: 32 MiB comprimida (`TOPE_COMPRIMIDO`), que se monta en memoria y al cerrarla ocupa
  el doble. Pasado, falla en voz alta; lo que toca entonces es archivar lo antiguo (DB-14).
- **No propaga**: si falla, Sentry (`hub.copia_diaria`) y Axiom (`copia_diaria_fallida`), y se repite
  en una hora. Lo que sale bien deja `copia_diaria` en Axiom con la clave, las filas y los bytes, y
  nada de los datos. Es la falta de ese evento lo que hay que vigilar.
- **No deja al objeto despierto** (AUD-46): la alarma espera todo lo suyo, y lo único que deja en
  `waitUntil` es la traza de Axiom, que tiene plazo (`test/elHubPuedeHibernar.test.ts`).

**La vuelta a un instante** (`durableObjects/tenantHub.instante.ts`), con la API de Cloudflare
(`getBookmarkForTime`, `onNextSessionRestoreBookmark` y `ctx.abort()`,
[sqlite-storage-api](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)),
detrás de `Instantes` (`durableObjects/instantes.ts`), que comparte con la base central:

- **Tres llamadas desde la ruta**, cada una con un stub nuevo: `prepararVuelta` (lee lo que la nube
  había numerado, deja la vuelta para el siguiente arranque, cierra la base con una marca en el
  almacenamiento, echa a las sesiones y devuelve el marcador con el que se deshace), `reiniciar`
  (`ctx.abort()`: la llamada falla siempre, y es lo esperado) y `trasVolver`.
- **Mientras tanto la base no atiende** (`tenant_db_restaurando`, 503 `external`, pasajero para el
  outbox de la Main): lo que entrara se perdería al volver. Volver se lleva la marca, que es de
  después; si sigue ahí, el objeto no ha vuelto (`vuelta_sin_aplicar`) y la ruta lo reinicia otra vez.
- **El log se abre por encima de todo lo numerado** (`abrirLogTrasVolver`). La nube vuelta numeraría
  otra vez desde el `Seq` del instante, y la Main, que pide desde su checkpoint, se saltaría para
  siempre lo nuevo con un número que ya ha visto. Se escribe un cambio vacío (`nube_devuelta`, sin
  sentencias) con el `Seq` más alto que se sabía más `SALTO_DE_SEQ` (diez millones). Lo que se sabía
  es lo que la nube había numerado (`seqAntes`, que `prepararVuelta` lee antes de volver) y lo que la
  ruta saca de fuera del objeto (`seqConocido`, abajo). Con `modo: "nube"`, además, lo
  purgado se pone justo debajo, por encima de cualquier checkpoint, y cada Main aparta su base y se
  trae la nube (SYNC-32); con `main`, la Main sigue y sube su base entera (DO-SUBIDA, abajo)
  ([recuperacion.md](recuperacion.md#cuando-la-nube-vuelve-atrás-do-03)). Después de abrir el log se
  echa a todas las sesiones, también a las que entraron entre el reinicio y `trasVolver`: vuelven a
  saludar, y la Main recibe en su `hello_ok` la petición de subida.
- **Vuelve todo lo guardado**, también la tabla de quién es la Main (se vuelve a leer en el saludo),
  las bajas apuntadas para el canje del socket (la base central sigue rechazando el ticket de un
  dispositivo dado de baja) y quizá la alarma, que se vuelve a armar en el primer acceso.
- No existe en local ni en los tests (workerd: «does not implement point-in-time recovery»), y la
  ruta contesta 501 `vuelta_no_disponible`. Lo demás se prueba con un doble de la plataforma
  (`test/copiasDeNegocios.test.ts`).

**Darle base a un objeto vacío** (DO-PERDIDA, `/v1/admin/negocios/restaurar-copia` y `base-vacia`):
lo que la activación y `/v1/sync/initialize-empty` no hacen con un negocio que ya nació, hecho a
sabiendas por soporte. Las dos rutas miran en la base central que el negocio nació
(`negocio_sin_nacer`, 409), y el objeto, que está vacío (`tenant_db_already_provisioned`, 409).

- **`restaurarDesdeCopia`** (`durableObjects/tenantHub.restaurar.ts`, con el cargador que comparte con
  la base central, `cargaDeCopias.ts`) lee la copia de R2 según llega,
  descomprimida y por líneas, sin tenerla entera en memoria. Antes de tocar nada mira que la copia
  sea de un esquema que este worker sabe poner (sus migraciones, un principio de las de aquí; si no,
  `copia_de_otra_version`); pone el esquema con las migraciones de aquí, vacía lo que siembran y
  carga las filas de la copia en tablas del negocio. De la copia no se ejecuta ningún texto: cada
  línea de datos se lee entera con una gramática cerrada (`INSERT INTO "<tabla>" ("<columna>", …)
  VALUES (<literal>, …);` y nada más, con columnas de esa tabla y los literales que escribe la copia;
  si no, `copia_no_valida` con la línea, el carácter y un código), y se ejecuta la sentencia que
  escribe el cargador con lo leído. Va en lotes de unos 4 millones de caracteres por transacción
  (varias filas por llamada; una de más de 100 KB, sola y con sus textos como argumentos) y con las
  claves foráneas apagadas (la copia va tabla a tabla, no padres primero). Al acabar mira que esté
  entera (su línea de fin, con las mismas filas; si no, `copia_cortada`) y `foreign_key_check`
  (`copia_no_valida`). Con una copia que no vale, el objeto se queda vacío y la ruta contesta 422 con
  el código y lo que dice el cargador (`detalle`, sin nada de la copia), y lo deja en Axiom
  (`copia_no_restaurada`, el evento de toda restauración que el objeto no hace). Los disparadores
  saltan al cargar: los de validación aceptan lo que ya aceptaron, y los del resumen diario sólo
  apuntan días.
- **`crearBaseVacia`** es el alta (`aprovisionar`: esquema, sello y administrador inicial).
- **Las dos cierran la base mientras tanto** con la misma marca que la vuelta a un instante
  (`tenant_db_restaurando`), porque esperan a la red con la base a medias y las claves foráneas
  apagadas, y echan a las sesiones. **Todo o nada**: si algo falla, el objeto se vacía otra vez
  (también la alarma); si el objeto se reinicia a mitad, la marca se queda y la base cerrada, y la
  siguiente llamada a cualquiera de las dos vacía lo que quedó antes de empezar.
- **El log se abre por encima** (`abrirLogTrasVolver`), con el mismo `modo` que la vuelta a un
  instante. El objeto vacío no recuerda hasta dónde numeró, y `SALTO_DE_SEQ` solo no basta: tras otra
  pérdida o una vuelta, el log perdido ya numeraba por encima del salto, y la Main, con el checkpoint
  por encima del log nuevo, no bajaría lo que éste numerase por debajo (con `nube`, lo purgado tampoco
  le quedaría encima y no se traería la nube). Así que la ruta le pasa `seqConocido`, de lo que
  sobrevive a perder el objeto: el `inicio` más alto de los logs que se le han abierto (cada vuelta y
  cada base devuelta lo dejan en `admin_audit`) y el `seq` de sus copias de R2 (`seqMasAlto` al
  copiar, en los metadatos del objeto). El salto va encima y cubre lo que el log perdido numeró
  después. Sin la base central o R2 no se abre nada. La vuelta a un instante lo suma también a su
  `seqAntes`. Ese `inicio` se apunta **antes** de llamar al objeto (`negocio_log_reservado`,
  `reservarLog`): el rastro de la orden va cuando el objeto contesta, y si la base central falla
  entonces, o se pierde la respuesta con el log ya abierto, repetir la orden no lo arregla (el objeto
  ya tiene base) y la siguiente pérdida antes de la copia de la noche abriría otra vez en el mismo
  número. Una reserva cuya orden no llegó a abrir nada sólo sube un salto más la siguiente. Después se echa otra vez a todas las sesiones, como en `trasVolver`: el saludo no mira
  la marca, y una que entró mientras se llenaba la base saludó sin la petición de subida. Luego, la
  copia diaria armada.

Lo cubre `test/basePerdidaSalidas.test.ts`.

**La subida completa de la Main** (DO-SUBIDA, `durableObjects/tenantHub.subida.ts`; el lado de la
Main, en [sincronizacion.md](sincronizacion.md#la-subida-completa-tras-una-nube-devuelta-do-subida)):

- **La petición vive en el SQL del objeto** (`_Subida_Completa`, una fila). La apunta
  `abrirLogTrasVolver` con `modo: "main"`, en la misma transacción que abre el log, con su origen
  (`instante`, `copia` o `base_vacia`) y sin dueño: se la queda la primera Main vigente que salude, que
  el saludo comprueba contra la base central. No se ata a `_Main_Vigente`: tras volver a un instante,
  esa tabla también ha vuelto y nombraría a la Main de entonces. Con `modo: "nube"` se borra. La copia de R2 no
  la trae (empieza por `_`) y `vaciarObjeto` se la lleva. Estados: `esperando`, `terminada`,
  `caducada` (14 días sin ningún paso de su Main desde que se pidió o se reabrió, `Empezada_Ms`; una
  empezada no caduca, aunque la Main pase semanas apagada o la subida pausada, y reabrirla vuelve a
  dejarla sin empezar aunque conserve lo planeado para su techo), `agotada` (su techo total) y `huerfana`
  (saludó como Main otro dispositivo: un traslado a mitad).
- **El saludo de esa Main la lleva** (`hello_ok.subida: {id, estado, origen}`), sin esperas; a una
  Handy no se le dice nunca. Una Main anterior no mira el campo y sigue como antes.
- **Los pasos llegan por el socket** (`{type: "subida", pasoId, accion, …}`, acuse `subida_ack` con el
  mismo `pasoId`), como un `apply_lote`: sólo de un `tpv`, la forma antes que nada, en fila con lo
  demás que manda la Main, y después de la comprobación por actividad, en el turno del log. Llevan
  datos, no SQL. El objeto casa la tabla con su esquema (una tabla del negocio que existe como tabla:
  ni vistas, ni `_*`, ni el andamiaje de la réplica, ni los intentos de PIN) y las columnas con
  `pragma_table_info` (sin repetir y con la clave entera), y construye él la sentencia: `INSERT …
  SELECT json_extract(value, '$[i]') … FROM json_each(?1) WHERE 1 ON CONFLICT(clave) DO UPDATE SET …
  WHERE NOT (todo igual)`, con la lista en un parámetro (DO-01). Nunca `REPLACE` y nunca borra: un
  borrado lo pide la Main por su outbox, y pasa por AUD-36 como cualquier otro. Un registro de
  facturación sólo se inserta (`DO NOTHING`), y lo que ya está y es distinto vuelve como `fiscal` sin
  tocarse; el contador de una serie sólo sube (`Ultimo = MAX(Ultimo, excluded.Ultimo)`, política
  `monotono`). El `plan` dice la política de cada tabla, cómo nombra el log a esa Main
  (`dispositivo`), para que lo suyo no frene sus borrados, y dónde empieza el log nuevo
  (`inicioSeq`, el cambio vacío de `abrirLogTrasVolver`), para que la Main sepa si el cambio de una
  cuarentena suya se perdió con una base vacía o se escribió en la nube devuelta.
- **Una página con algo que no entra** (un único, una foránea, un `CHECK`, un trigger que rechaza) se
  parte por la mitad, cada mitad con su propia lista, hasta aislar las filas, que vuelven en
  `noEntraron` con su clase; lo pasajero (la base ocupada o llena) sale tal cual. 5.000 filas y
  1,5 MiB por página; más, `subida_pagina_demasiado_grande`, y la Main la parte.
- **Lo ajeno manda**: una página no entra si en el log hay algo de otro dispositivo por encima del
  checkpoint con el que la Main la leyó (`aplazada`, con `hastaSeq`). El `plan` y los `sobrantes`
  miran lo mismo.
- **No toca el log**: ni `Sync_Changes`, ni `Applied_Operations`, ni difusión de filas. Al acabar una
  tabla manda a las Handy `datos_subidos {tablas}`, que relee esas pantallas.
- **Su propio presupuesto (AUD-36)**: las páginas no gastan `_Presupuesto_Escritura`, así que el
  outbox de la Main y las Handy siguen como siempre. Gastan el de la petición (`LIMITES_DE_SUBIDA`):
  por hora, 10 millones de filas escritas (`rowsWritten`, con índices y triggers) o 2 GiB
  (`presupuesto_de_subida_agotado`, pasajero); en total, el menor entre 60 millones y diez veces lo
  que la Main declaró en su plan (con un suelo de un millón), y 6 GiB de crecimiento
  (`subida_presupuesto_superado`, permanente: la petición queda `agotada`, a Sentry, y sólo la reabre
  la administración con `pnpm negocio:subida -- --reabrir`, que echa a las sesiones `tpv` para que la
  Main vuelva a saludar y se la quede; sigue entonces por donde iba). Un
  bar con mucho histórico y una base vacía puede llegar a ese techo de 60 millones (un bar de mil
  comandas diarias escribe unas 70-80 millones de filas en dos años, contando índices y triggers). La exención sólo existe para pasos de
  la Main de la petición, mientras está `esperando`, y acaba con `fin`.
- **La alarma diaria** avisa una vez (Sentry `hub.subida_sin_empezar`) si la petición lleva un día
  esperando sin ninguna página desde que se pidió o se reabrió, emite `subida_caducada` si caduca
  entonces, y mientras está `esperando`, `agotada` o `huerfana` **la poda no se
  lleva las copias de R2 anteriores a la petición**: son las buenas, y las de después son de una base
  a medias.
- `negocio:estado` la enseña (`subida`): estado, origen, Main, páginas, filas escritas y declaradas.

Lo cubre `test/subidaCompleta.test.ts`.

## Los tests no salen a la red

Los tests corren dentro de workerd (`@cloudflare/vitest-pool-workers`) y toman de `wrangler.json` los
bindings, pero no pueden hablar con ningún servicio de verdad (`vitest.config.ts`):

- **El entorno es de pruebas** (`test/helpers/entornoDePruebas.ts`). Las `vars` que nombran un
  servicio o una cuenta —los remitentes, Turnstile, el origen de las reservas web, Axiom— valen
  direcciones `.invalid` y nombres ficticios. El secreto que la suite necesita (`LICENSE_JWT_SECRET`)
  es determinista; la pista de región de los DO, vacía;
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
  fallo). La guarda se pone antes de cargar el worker, para que nada de lo que se cargue se quede
  con el `fetch` o el `WebSocket` de verdad.
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
| La base central, desde una ruta, un helper o el `TenantHub` | No lleva doble: cada caso pide su objeto `BaseCentral` de verdad, aprovisionado con sus migraciones, con `centralDePrueba()` (`helpers/central.ts`), que le da un nombre que no ha usado nadie: una base nueva y vacía, que no ve lo que siembra otro caso, corran en el orden que corran (`centralSinAprovisionar()`, la misma sin esquema). Una ruta llega a ella como en producción, por `getDb(env)`, con `{ ...env, ...central.entorno }`; una función que recibe la base, por `central.db`; el `TenantHub`, con `enElHub(…, { central })` o `ponerLaCentral` (`helpers/hub.ts`). Lo que el test siembra o comprueba va directo al SQLite del objeto, por debajo de sus guardas (`filasDe`, `fotoDeLaCentral`, `negocioEnLaCentral`). Un fallo o un cruce que haya que provocar va en su stub, nunca en un doble de la base (`centralInterceptada`, `centralQueApunta`, `desvio`, `conFalloEnLasOperaciones`, `operarConFallo`); un R2 que falla, dentro del objeto (`conCopiasDentro`, `conR2Caido`); la vuelta a un instante, que en local no existe, con `conDobleDeInstantes` |
| El viaje al `TenantHub` de una ruta de negocio, en un router montado suelto | `vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"))`: la ruta corre allí mismo, contra los demás dobles. Con la `app` entera y el TenantHub de verdad no hace falta (`unViajePorPeticion.test.ts`): `helpers/negocioFirmado.ts` monta el negocio y firma las peticiones de la Main y de la Handy (`pedirComo`) |
| La base del negocio desde una ruta | `vi.mock("../src/lib/tenantClient", …)` con `tenantQuery` llamando a su función con el cliente de producción, `clienteLocal(state.storage)` (`tenantHub.sqlite.ts`), sobre `crearEsquemaTenant(sql)`. Desde la agenda o una ruta pública: `motor.leer = lectorSobre(state, ahora)` (`helpers/agenda.ts`) o el doble de `leerParaLaWeb` |
| La base del negocio en el `TenantHub` | No necesita doble: es el SQLite del propio DO. Con el esquema de verdad, `aprovisionar(tenantId)` (por RPC o dentro de `enElHub`); para ponerle delante otra base o hacerla fallar, dentro de `enElHub`: `hub.withTenantDbRetry` o `hub.getTenantDb` con `clienteLocal` o un envoltorio suyo |
| Un `fetch`: Stripe, Axiom, Turnstile, un latido | `vi.stubGlobal("fetch", doble)` y `vi.unstubAllGlobals()` en `afterEach`; o `vi.mock` del módulo que lo hace |

Cada fichero de tests corre en su propio workerd, con sus objetos en memoria: dos ficheros no comparten
nada. Los casos de un mismo fichero sí comparten los objetos que pidan con el mismo nombre, también la
central de `centralDe(env)`; por eso cada caso pide la suya.

## Secretos

Van con `pnpm exec wrangler secret put <NOMBRE>` desde `apps/cloud-worker-licensing/`, nunca en
`wrangler.json`. Los de licencias están en [licencias.md](licencias.md#secretos-del-worker); además:
`PAIR_PEPPER`, `RELEASE_ADMIN_TOKEN` (publicar releases), `SENTRY_DSN`, `AXIOM_TOKEN`,
`BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_HEARTBEAT_COPIAS_URL` y, opcional, `HANDY_TOKEN_TTL_SECONDS`.
Una ruta que depende de un secreto ausente responde 503 o 500 (fail-closed).

## Desplegar

Producción se despliega desde GitHub con un tag `v<versión>`. El workflow comprueba la misma versión
en worker y escritorio, sube los mapas a Sentry y verifica un error real antes de desplegar los mismos
bytes. Los tags `win7-v<versión>` publican únicamente el escritorio de Windows 7.

El worker lleva el esquema del negocio compilado dentro: **con un cambio de esquema, se despliega antes
de que los TPV escriban la columna nueva**, o la primera escritura se rechaza. Desplegar reinicia los DO,
y cada uno migra su base la primera vez que la toca; la central, al arrancar. Una migración nueva de
la base central va en un despliegue **anterior** al del código que la usa
([su esquema](#su-esquema-migraciones-en-código)). Más en
[publicar-version.md](../guias/publicar-version.md).

Desde el despliegue que creó la clase `BaseCentral` (la migración `v3` de `wrangler.json`),
`wrangler rollback` no puede volver a una versión anterior a él: un cambio en el ciclo de vida de una
clase de Durable Object lo bloquea
([rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)).
Lo que falle se arregla hacia delante.
