# Observabilidad

| Herramienta | Para qué |
|---|---|
| **Sentry** | Errores y crashes: panics de Rust, minidumps nativos, errores de la Webview y excepciones del worker y del Durable Object |
| **Axiom** | Telemetría estructurada: logs de los dispositivos reenviados por el worker y eventos de salud de la sincronización |
| **Better Stack** | Vigilancia desde fuera: la sonda de `/health` y los latidos del cron |
| Fichero local | `<AppData>/logs/tpv.log`, 7 días: la fuente de verdad para soporte |

La copia previa a migrar y las migraciones confirmadas se registran con `tracing` (target
`tpv::migrations`): éxitos a INFO y copia fallida a WARN. Incluyen nombre de fichero/migración,
bytes o error, sin la ruta absoluta de AppData.

En desarrollo la captura es **no-op** si faltan los secretos. Una publicación exige la configuración
de Sentry completa y sus mapas verificados; no se despliega sin esa comprobación.

El código propio, incluido licencias, emite con `tracing`. En Android, `JNI_OnLoad` inicializa
el logger de plataforma antes de usar JNI: conserva el diagnóstico temprano en Logcat
(`TPVRust`, INFO o superior). Cuando se instala el subscriber, el mismo logger pasa a conectar
las dependencias que usan `log` con `tracing`. El subscriber se registra por separado del logger:
un logger ya instalado no interrumpe la creación del guard, el estado y el worker. En escritorio
se instala `LogTracer` si la fachada `log` está libre.

**En la APK de release no hay capa de Logcat** (AUD-29, `tpv-telemetry::capa_de_logcat`): desde
`init`, lo de la app va a los destinos de siempre (el fichero local, Axiom y Sentry) y no a Logcat.
Logcat lo lee quien tenga ADB autorizado, un informe de errores del terminal o una app preinstalada
con `READ_LOGS`, el filtro de datos personales no llega ahí, y los fallos de comandos van con su
mensaje. **Tampoco cuando `init` falla**: si el fichero de logs no se puede crear (el almacenamiento
lleno), `init` sale sin subscriber ni puente, y con la feature `log` de `tracing` lo que se registra
saldría por el logger temprano. En release ese logger deja de escribir en Logcat en cuanto empieza
`init` (`tpv-telemetry::logger_temprano`), así que entonces lo de la app no va a ningún sitio; en
depuración sigue en Logcat hasta que lo sustituye el puente. En una compilación de depuración (la de
`pnpm tauri android dev` y la de E2E) una capa escribe además directamente a Logcat, sin bucles ni
duplicados. En release siguen llegando a Logcat
el arranque anterior a `init` (`[TPV] run() start`, la ruta de AppData), lo que Rust escriba por la
salida estándar o de error (tao la redirige con la etiqueta `RustStdoutStderr` en todo build: un
`panic`, el aviso de que `init` falló) y la excepción de Java que limpia el almacén de secretos
(`ExceptionDescribe`). La consola de la Webview sólo llega en depuración.

## El flujo

```
Escritorio (Rust + Webview)
  ├─ tauri-plugin-sentry ───────────────────────────────► Sentry   (DSN público embebido)
  ├─ invocar (fallo de un comando) ─► telemetria_fallo_de_comando ─► tracing (tpv::comandos)
  ├─ tracing ─► fichero local de 7 días                  [fuente de verdad]
  └─ tracing ─► cola durable <AppData>/telemetry-spool/
                  └─ hilo propio ─ POST /v1/telemetry (device-proof) ─► worker ─► Axiom

Worker (Hono)    ── @sentry/cloudflare ─────────────────► Sentry
TenantHub (DO)   ── emitSyncEvent() ────────────────────► Axiom (dataset de sync)
Better Stack     ── GET /health, latidos del cron
```

- **El token de Axiom no está en el dispositivo**: es un secreto del worker. Los equipos suben a
  `/v1/telemetry` autenticados y el worker retransmite. El endpoint fija `tenant_id` y `device_id` desde
  el token, no desde el cliente.
- **La cola a Axiom está en disco**: la antesala se persiste aproximadamente al segundo, en un
  segmento JSONL que se cierra a los 60 s, 500 eventos o 512 KiB. El envío agrupa también ficheros
  antiguos y respeta 500 eventos y 512 KiB de cuerpo JSON. Hay al menos 10 s entre peticiones
  cuando hay atraso, con backoff hasta 5 min y jitter ante fallos. Un POST lento no detiene el
  drenado; al quedar vacía, la cola espera una notificación sin sondear el disco.
- Un 2xx confirma los eventos enviados; un cursor en disco conserva el progreso parcial tras un
  reinicio. Los temporales se recuperan descartando únicamente la última línea incompleta. No hay
  fsync ni garantía frente a cortes de corriente. Puede haber duplicados si la entrega llega al
  servidor pero su confirmación no llega al dispositivo (entrega al menos una vez).
- **Retención acotada (RI-19)**: 256 MiB en Main y 64 MiB en Handy, podando los segmentos más
  antiguos. La antesala tiene un máximo de 20.000 eventos y un presupuesto conservador de memoria
  de 16 MiB en Main y 4 MiB en Handy (también en Android antes de conocer el modo). Se contabilizan
  las capacidades de las cadenas, los nodos de campos y el máximo de huecos del anillo. Un evento
  extraído sigue contando hasta terminar su escritura: no se vacía el anillo a una segunda cola.
  Se descarta lo más antiguo que no esté en escritura; si ese evento ocupa el presupuesto restante,
  se descarta la nueva entrada. Los descartes, errores de E/S y líneas
  corruptas quedan en el log local con target `tpv::telemetry`, excluido del reenvío para evitar
  realimentación. Los errores de escritura conservan los eventos no persistidos para reintentar.
- El cliente recorta el texto conforme al schema del servidor y omite campos estructurados
  excesivos con un marcador. Un 400/413/422 divide el lote hasta aislar el evento rechazado;
  autenticación, rate limit, red y 5xx conservan el lote. El servidor limita el cuerpo a 1 MiB
  antes de autenticar y espera Axiom: si falla, responde 502. Sin token de Axiom, sigue siendo un
  no-op.
- La captura a la antesala limita el mensaje a 4.000 bytes y cada campo de texto a 4 KiB, sin
  construir antes su representación completa. Los campos se limitan conjuntamente a 32 KiB de
  memoria estimada y 64 entradas, más el marcador `telemetry_captura_recortada` cuando se recortan
  u omiten datos. Un evento de más de 64 KiB de memoria estimada no entra en la antesala. Estos
  límites se aplican sólo al reenvío; el fichero local conserva el diagnóstico completo.
- **Escritorio**: el DSN entra al compilar con `TPV_SENTRY_DSN` (`option_env!`, con
  `rerun-if-env-changed` en `build.rs`). Sólo lo pone el workflow de release: en `pnpm tauri dev` no hay
  Sentry, y como la Webview manda sus eventos por el cliente de Rust, tampoco del frontend. El entorno lo
  decide el identificador de la app (`lib.rs::entorno_de_sentry`: `e2e`, `dev` o `prod`), así que la
  tanda E2E no se mezcla con los clientes. Los minidumps se inicializan sólo con DSN y sólo en
  escritorio.
- **Worker**: `SENTRY_DSN` es un secreto de Cloudflare. El artefacto de release fija `ENVIRONMENT=prod`,
  `SENTRY_RELEASE=tpv-api@<versión>` y `BUILD_COMMIT`. `nodejs_compat` está activado (lo exige `@sentry/cloudflare`).
  `instrumentDurableObjectWithSentry` cubre los handlers del WebSocket del DO.
- **Una ruta que se ejecuta dentro del `TenantHub` es para Sentry una petición**
  (`comoPeticionDeSentry`, `observability/sentry.ts`): `ejecutarRuta` corre con su propio ámbito de
  aislamiento y su propio cliente (`Sentry.wrapRequestHandler`, lo mismo que el SDK pone delante del
  `fetch` del Worker), que se envía y se suelta al terminar. Un fallo dentro de la ruta sale con su
  `operation`, llegue o no la llamada con los datos de traza del Worker, y lo que una petición
  apunta en su ámbito (`registrarPeticion`, `registrarCuerpoValidado`) acaba con ella. A los
  métodos RPC el SDK no les da ese ámbito: si en el isolate ya hay un cliente sólo bifurca el
  corriente, y el de aislamiento es el global, que comparten los DO de todos los negocios del
  isolate. Esas dos funciones son lo único que escribe en `Sentry.getIsolationScope()`, y sólo
  corren dentro de la `app`: en el `fetch` del Worker o en `ejecutarRuta`. Lo cubre
  `test/sentryEnElHub.test.ts`.
- **Logpush** está activado en el worker (`"logpush": true`); el destino se configura en el panel de
  Cloudflare. Qué lleva: [Lo que registra Cloudflare de cada petición](#lo-que-registra-cloudflare-de-cada-petición).

## Los fallos de comandos

Todo comando pasa por `invocar` (`packages/client/src/transporte.ts`). Cuando uno falla, avisa a
`shared/observability/fallosDeComandos.ts`, que decide su gravedad por el código con una tabla
exhaustiva (`GRAVEDAD`: un código nuevo no compila hasta tener la suya) y lo cuenta:

| Gravedad | Códigos | `tracing` | Mensaje | Sentry |
|---|---|---|---|---|
| `programa` | `internal`, `repository`, `tenant_migration_altered`, `bootstrap_too_large` | `error!` | Sí | Sí, desde la Webview |
| `entorno` | `external`, `main_offline`, `backup_corrupt` | `warn!` | Sí | No |
| `normal` | los de respuesta esperada: validación, PIN, permisos, licencia… | `info!` | No | No |
| no se cuenta | `not_approved` (la respuesta del sondeo mientras se vincula una Handy) | — | — | — |

- **Va a Rust siempre**, con `telemetria_fallo_de_comando` (sin sesión: también cuenta lo de antes del
  login), que lo escribe con target `tpv::comandos`: llega al `tpv.log` y a Axiom
  (`tpv-device-logs`) por la cola en disco, así que lo que falla sin red llega al volver. Lleva el
  comando, el código, la gravedad, la pantalla (`pathname`), lo que tardó y las veces.
- **A Sentry sólo los fallos del programa**, y desde la Webview: el evento lleva el rastro de lo que
  se pulsó y por dónde se navegó antes. Se agrupa por comando y código (`fingerprint`). El
  `error!` de Rust no genera un segundo evento: `filtro_de_sentry` (`tpv-telemetry`) deja
  `tpv::comandos` como miga. Lo que falla sin red no llega a Sentry, pero sí a Axiom.
- **El mensaje de una respuesta esperada no viaja**: puede llevar lo que escribió alguien, y para
  saber que pasa basta el código.
- **Una racha no inunda**: el mismo comando con el mismo código sale una vez, y los que lleguen en el
  minuto siguiente salen juntos al cerrarse, con `veces`.
- **No se cuenta dos veces**: `invocar` marca el error (`yaRegistrado`) y `captureException` no lo
  reenvía, venga de `conAviso`, del listener global o del `catch` de una pantalla.
- **Lo que no es un fallo del programa va como `external`**: los errores de la impresora
  (`fallo_de_impresora` en `lib.rs`) lo son, o cada rollo que se acaba sería un issue.
- **Lo que una Handy no tiene porque es de la Main es `conflict`**, una respuesta esperada: los
  registros de facturación, el ticket de un cobro y los pedidos a proveedores
  (`AppState::base_de_la_main`), igual que la caja en sus repositorios HTTP. Una Main sin su base
  sí es `internal`.

Lo que falla en la propia pantalla, sin comando de por medio, va por `captureException`.

## Los errores salen sin datos personales (OBS-01)

Antes de mandar algo a Sentry o a Axiom, el mensaje y los campos pasan por un filtro que sustituye por un
marcador lo que tenga forma de dato personal o de secreto: DNI, NIE, IBAN, número de la Seguridad
Social, teléfono, tarjeta, correo, PIN y tokens. `sendDefaultPii = false` sólo cubre el contexto
automático de Sentry, no las cadenas que compone el código.

Hay **tres copias** porque no pueden compartir código: la Webview (`src/shared/observability/scrub.ts`),
el core de Rust (`crates/tpv-telemetry/src/scrub.rs`, que vuelve a filtrar todo lo que sale de la Main)
y el worker (`apps/cloud-worker-licensing/src/observability/scrub.ts`, en el `beforeSend` de Sentry).
Lo que sale a Axiom se filtra también en `ingestToAxiom`, sobre una copia del lote: cubre los eventos
generados por el worker/DO sin modificar el estado del llamante. Si copiar, filtrar o serializar falla,
no se envía el lote y la ingesta del dispositivo responde 502 para conservarlo.
Lo que las mantiene iguales es `crates/tpv-telemetry/src/scrub_casos.json`, la tabla que leen los tests de
las tres: **una regla nueva lleva su caso ahí**, o las otras copias no se enteran. Lo que
decide cada regla no depende del motor de cada copia: ver «Lo que tiene que decidir igual en las
tres copias», más abajo.

No reconoce nombres ni direcciones: un mensaje de error no se compone con ellos. No toca el fichero local.

**Lo que tiene que decidir igual en las tres copias.** Sin apoyarse en lo que cada motor entiende
por blanco o por mayúscula:

- **Blancos**, escritos uno a uno (`\s` no vale: en JavaScript incluye U+FEFF y no U+0085, y en
  Rust, al revés). Alrededor de un separador (`token = x`), los de los dos: lo que Unicode marca como
  espacio, más U+FEFF. Lo que termina un valor, y lo que separa una palabra de diagnóstico del
  valor que deja sin tapar (`hash: …`, `ts=…`), sólo los que valían ahí en las dos copias (sin
  U+0085 ni U+FEFF): ninguna copia tapa menos que antes.
- **Mayúsculas**: sólo se igualan las de ASCII. En JavaScript, la bandera `i` sin la `u`; en Rust,
  `(?i-u:…)`, porque `(?i)` a secas pliega Unicode (la K del kelvin, U+212A, contaría como `k`, y
  la ese larga, U+017F, como `s`). La eñe de «contraseña» va escrita en sus dos cajas.
- **Fronteras y dígitos**: ASCII, `(?-u:\b)` y `[0-9]`.

**El filtro cuesta un tiempo lineal (AUD-32).** En el worker y en el `TenantHub` corre síncrono,
antes de contestar, sobre texto que elige quien llama, y el motor de expresiones regulares de
JavaScript retrocede: una repetición sin tope que puede empezar en cada posición de un tramo (`x+@`)
lo recorre entero desde cada una. Las tres copias redactan lo mismo (la de Rust no retrocede):

- **Correo**: con las cotas de lo que reconoce, hasta 64 caracteres antes de la arroba, 253 de
  dominio y 63 de dominio final (los límites de RFC 5321 y 1035). De una parte local más larga se
  redactan sus últimos 64 caracteres; de un dominio final más largo, los primeros 63; y si el último
  punto del dominio queda a más de 253 caracteres de la arroba, se redacta hasta el último punto que
  sí cabe.
- **JWT**: sin cota en ningún tramo, recorrido a mano (`redactarJwt`, `redact_jwt`): cada tramo de
  base64url se mira una vez, y si tiene un `eyJ` al principio o detrás de un guion y le siguen un
  punto, otro tramo, otro punto y otro tramo, se redacta desde el primer `eyJ`. Redacta lo mismo que
  la expresión de siempre, con la cabecera tan larga como sea (un `kid` largo).
- **`hash`, `huella`, `event`**: entre la palabra y su valor van `:` o `=` entre blancos, o blancos
  con algún espacio, escrito de modo que sólo se pueda repartir de una manera.
- **Teléfonos y tarjetas**: los separadores pegados a un número se miran desde el número hacia
  fuera, no recorriendo el texto anterior.

Los bordes de cada cota, el JWT largo y sus fronteras, los blancos y las mayúsculas son casos de
`scrub_casos.json`. Lo vigila `test/scrubCoste.test.ts`, en el worker, sin depender de la máquina:

- lee las fuentes de todas las expresiones regulares del filtro, que están juntas en
  `EXPRESIONES`: una con alguna repetición sin tope (`*`, `+`, `{n,}`) tiene que estar en la lista de
  excepciones con su fuente entera, carácter a carácter, y el porqué escrito, así que cualquier
  cambio en ella obliga a revisarla (quitar el `^` de `/^ +$/` haría cuadrática la búsqueda de un
  teléfono detrás de un hueco largo); y comprueba que el filtro no ejecuta ninguna otra;
- cuenta los pasos de los dos recorridos escritos a mano (`scrubContando`) con textos escritos
  contra ellos, y exige que no pasen de ocho por carácter.

Lleva además un diagnóstico con reloj que no falla: compara lo que tarda un texto entero con lo que
tarda en dieciséis trozos y, si el entero tarda más de cuatro veces, lo avisa en la consola.

`apps/tpv-main/test/scrub.test.ts` comprueba que la copia de la Webview es, por debajo de su
cabecera, el mismo código que la del worker.

**Lo que entra al filtro del worker tiene techo** (`observability/tope.ts`). Todas sus salidas a
telemetría filtran cada cadena con dos topes: `ingestToAxiom` (todo evento a Axiom, del worker, del
`TenantHub` o de un dispositivo), el `beforeSend` de Sentry (mensaje, excepciones, migas, extra,
etiquetas y URL) y el aviso de la consola cuando Axiom rechaza un lote. Se acota la copia que sale,
nunca el dato con el que se trabaja.

- **Lo que sale**: 16 KiB (16.384 bytes) en UTF-8, con la marca `…[recortado]` dentro, cortado entre
  caracteres completos (un emoji no se parte). Se corta **después** de filtrar: cortar un texto ya
  filtrado no deja a la vista nada que el filtro haya tapado, y al revés un JWT o un correo partidos
  ya no se reconocerían.
- **Lo que se filtra**: hasta 64 Ki caracteres (de JavaScript), entero. Uno más largo se corta antes
  de filtrarlo, en el último blanco que no sea un espacio (un salto de línea, un tabulador…) antes
  de ese tope, y si no hay ninguno sale sólo la marca. Ningún dato que el filtro reconoce lleva uno
  de esos blancos dentro, así que cortar ahí no parte nada; un espacio no valdría, porque un
  teléfono, una tarjeta o un IBAN se escriben con espacios.

Nada legítimo llega a esos topes: el texto más largo de un dispositivo son 4 KiB por campo. Además,
cada entrada tiene el suyo:

| Entrada | Techo |
|---|---|
| `POST /v1/telemetry` | 1 MiB de cuerpo, antes de autenticar (el dispositivo manda como mucho 512 KiB); 500 eventos; 4.000 caracteres de mensaje; por evento, 128 KiB de `fields` serializados y 256 caracteres por nombre de campo |
| `device_auth_rechazado` | La ruta, filtrada y acotada después a 256 bytes con la marca (`tenantAuth`, con `acotar`): un JWT en la ruta sale `[jwt]` entero |
| Eventos del `TenantHub` (`apply_error`, `resultado_ilegible`…) | El tope común: la clave y el nombre de la operación llegan enteros a `ingestToAxiom`, que los filtra antes de acotarlos |
| `X-Idempotency-Key` | De 16 a 64 letras, cifras, guiones o guiones bajos (`^[A-Za-z0-9_-]{16,64}$`; la Handy manda un UUIDv7). Otra cosa se rechaza con `invalid_op_id` (400) sin llamar al `TenantHub` |

La Webview y el core de Rust no acotan: lo que filtran lo ha escrito la propia app, y el motor de
Rust no retrocede. Las dos copias de TypeScript son el mismo código: `scrubDeep` y `scrubEvent`
aceptan un filtro por cadena, y sólo el worker les pasa el suyo.

RI-42: conserva UUIDs completos, fechas ISO, timestamps identificados por claves temporales
(`*_ms`, `timestamp`, `epoch`, `ts`) y hashes identificados como tales. Las credenciales se
ocultan antes de proteger esos intervalos; las claves estructuradas de secretos también se
redactan. Detecta teléfonos españoles de nueve cifras con prefijo opcional `+34`, `0034`, `34`
o `(+34)`, incluidos varios teléfonos consecutivos separados por espacios, y candidatos a tarjeta
de 13–19 cifras que pasan Luhn. Reconoce claves de credenciales entre comillas en texto JSON y
variantes explícitas como `access_token`, `refreshToken`, `id-token` y `client_secret`, también
en objetos anidados. Son secretas también tres claves que no lo parecen por su nombre: la DEK de los
campos cifrados (`fieldDek`, `field_dek`), el hash de un PIN (`password_hash`, `passwordHash`) y el
ticket de un solo uso del WebSocket (`ticket`, como nombre de campo o con `:` o `=` detrás: «ticket
2027/000001» y `numero_ticket` se conservan). Los valores entre comillas se redactan completos,
incluidos espacios y escapes.
Si la captura termina dentro de un valor entre comillas, se redacta hasta el final del texto.
La autorización consume el esquema Bearer/Basic y su credencial, sin borrar el texto siguiente;
las pasadas posteriores conservan los marcadores y el diagnóstico.
No redacta cualquier número largo por su longitud. Rust preselecciona reglas con RegexSet y conserva cadenas prestadas sin
reemplazos. La tabla compartida cubre texto y objetos anidados, incluida su idempotencia.

### Qué lleva un mensaje de error (AUD-28)

El filtro es la segunda barrera. La primera es que el mensaje no se componga con datos: el de un
fallo de `entorno` o de `programa` viaja entero, y el filtro no reconoce un nombre, una nota, una
ruta de AppData ni un teléfono o un correo codificados en una URL (`telefono=%2B34+612+345+678`,
`email=ana%40…`). Así que **un mensaje de error no lleva el cuerpo de una respuesta, ni a trozos, ni
la URL de la petición, ni una ruta de AppData**. Lo que falla al hablar con el worker dice esto:

| Fallo | Lo que dice | Lo que no lleva |
|---|---|---|
| La petición no tiene respuesta (sin red, DNS, TLS, tiempo agotado) | En la Handy (`tpv-infra-http`), «No se ha podido conectar con el servidor. Comprueba la conexión a internet.» y, entre paréntesis, la clase del fallo: `tiempo de espera agotado`, `no se pudo abrir la conexión` o `la petición no llegó a completarse`. En licencias y emparejamiento, el texto de reqwest sin la URL | La URL (ni la query ni la ruta) |
| Un 2xx que no encaja en su DTO, entero o un trozo | `bad_json: la respuesta de la nube no encaja en <tipo> (<clase de serde>, línea …, columna …)`; en licencias, con su operación delante (`activate_bad_json`, `invalid_json` en `/status`, `bad_refresh_response`, `bad_pair_create_response`) | El cuerpo ni el texto de serde, que cita el valor que no encaja. El de la activación y el de `/status` llevan el token de sesión y la DEK de los datos del personal |
| Un 2xx de la activación sin la licencia | «La respuesta del servidor de licencias no trae la licencia concedida (ok=false | sin token | sin negocio).» | El cuerpo |
| Un rechazo (no 2xx) que el worker explica | Su `message` o su `error` (`AppError::from_api_body`) | — |
| Un rechazo sin el JSON de la API (la página de un intermediario) | `http_<status>`, con lo que falló delante cuando lo cuenta el adaptador (`activate_failed_http_502`, `image_download_http_404`: `AppError::rechazo`) y, sólo si el cuerpo entero es el `error code: NNNN` de Cloudflare, ese código (`http_530:cloudflare_1016`). Lo que el cuerpo diga del caso va al código del error, no al texto | El cuerpo: una página de error puede repetir la petición que se le hizo |

- La clase del fallo sale de `fallo_de_transporte`, y el tipo y la posición, de `no_encaja` /
  `leer_campo` (`client.rs`) y de `no_encaja` en `tpv-infra-licensing`: bastan para dar con el
  campo. La ruta no se conserva: el evento del fallo ya lleva el comando, la pantalla y lo que tardó,
  y nada impide que una ruta lleve un texto.
- **`reloj::enviar`** (`tpv-infra-licensing`), por donde salen las peticiones de la Handy y las de
  licencia, emparejamiento e imágenes, devuelve el error de reqwest sin su URL (`without_url`): quien
  ponga su texto en un mensaje pone `error sending request`, sin destino. La petición del código de
  traslado de licencia, que no pasa por ahí, le quita la URL ella misma; la subida de la telemetría no
  compone ningún mensaje con su error.
- **Un fichero de AppData se nombra por su nombre** (`license_state.json`, `device_config.json`,
  `interruptores.json`, `images/logo`), nunca por su ruta, que lleva el usuario de Windows; el
  `io::Error` no la cita. No hay un registro sólo local: todo lo que se escribe con `tracing` a
  partir de INFO sale a Axiom (`forward.rs`), así que la ruta no va ni a los avisos. **Una
  imagen** se nombra con `imagenes::para_registro`: la carpeta y su UUID, o, si es una heredada con
  el nombre que alguien le dio, sólo la carpeta y la extensión.
- Si la DEK de los datos del personal no se puede guardar, el aviso lo dice sin el error del almacén
  de secretos ni el nombre de su entrada.
- El aviso de un interruptor que se apaga desde la nube dice cuál y hasta cuándo, no el motivo: es
  texto libre de soporte, y se guarda y se enseña en pantalla sin salir del equipo.
- Lo comprueban los tests de comportamiento, que miran el mensaje que sale: `tests_mensaje_sin_datos`
  en `client.rs` (un puerto en el que no escucha nadie, el tiempo agotado y respuestas que no
  encajan), `tests_respuesta_api` en `tpv-application/src/error.rs` (rechazos cuyo cuerpo no es de
  la API) y `tests_mensajes_sin_datos` en `tpv-infra-licensing` (la activación y `/status` que no
  encajan, y los ficheros de la licencia que no se dejan escribir).
- Además, `tests_ningun_mensaje_lleva_el_error_ni_el_cuerpo` (`client.rs`) lee el fuente de
  `tpv-infra-http` y avisa de lo que se ve a simple vista: un hueco con el error o con el cuerpo
  (`{e}`, `{text}`), el error o el cuerpo entre los argumentos de `format!`, de un aviso de
  `tracing` o de un constructor de `AppError` (`"{}", e`, `e.to_string()`, `error = %e`), ese
  constructor entregado como función (`map_err(AppError::sin_conexion)`) y una petición que sale
  con `.send()` o `execute` en vez de con `reloj::enviar`. No sigue un valor de una variable a otra
  ni entra en una función aparte: no sustituye a los tests de comportamiento.

## Lo que registra Cloudflare de cada petición

La plataforma registra cada invocación del worker por su cuenta, sin que su código intervenga: **el
filtro de datos personales no llega ahí**.

- **Workers Logs** (`"observability": { "enabled": true }` en `wrangler.json`) guarda de cada petición
  el método y la URL, con su query, durante 7 días.
- **Logpush** (`"logpush": true`) deja que un job, que se configura en el panel de Cloudflare, exporte
  las trazas de cada invocación al dataset `cloudflare-logpush` de Axiom. Si ese job incluye el campo
  `Event`, la URL va dentro. Qué campos manda el nuestro no está en el repositorio.
- La redacción propia de la plataforma sólo tapa lo que parece un identificador largo (un hexadecimal
  de 32 cifras o más, un base64 de 21 o más): un teléfono, un correo o un nombre se quedan como están.
- El cuerpo de la petición no se registra.

Por eso **ningún dato personal ni texto libre viaja en la URL** (AUD-27): va en el cuerpo de un POST,
y en la query sólo quedan identificadores, fechas, filtros cerrados y paginación. La regla y los tests
que la vigilan, en [worker.md](worker.md#cómo-se-escribe-una-ruta). Lo que queda fuera de ella, el
nombre de una imagen heredada, es [OBS-06](../pendientes.md#obs-06--el-nombre-de-una-imagen-heredada-viaja-en-la-url).

Cloudflare puede además quitar la query de las URL que registra, con el ajuste
`observability.redact_query_string` del worker. **No sale de `wrangler.json`**: el Wrangler con el que
se despliega (4.96.0) no conoce ese campo, así que se pone por la API de Cloudflare, a mano, y el
repositorio no dice si está puesto. Cada despliegue envía el `observability` de `wrangler.json`
(`{ "enabled": true }`), sin él: si se pone, después de cada despliegue se comprueba que sigue
([pendiente](#pendiente)).

## Piezas

| Capa | Archivo |
|---|---|
| Crate de telemetría | `crates/tpv-telemetry/` (`config`, `context`, `event`, `forward`, `spool`, `worker`, `sentry`, `scrub`, `state`) |
| Cableado del escritorio | `apps/tpv-main/src-tauri/src/lib.rs` |
| Sentry de la Webview | `apps/tpv-main/src/shared/observability/sentry.ts` (más el error boundary y el listener global) |
| Fallos de comandos | `packages/client/src/transporte.ts`, `shared/observability/fallosDeComandos.ts`, `commands/telemetria.rs` |
| Mensajes de error (AUD-28) | `crates/tpv-infra-licensing/src/reloj.rs` (`enviar`), `crates/tpv-infra-http/src/client.rs` (`fallo_de_transporte`, `no_encaja`, `leer_campo`), `crates/tpv-infra-licensing/src/lib.rs` (`no_encaja`, `leer_activacion`, `leer_status`, `fallo_de_fichero`), `crates/tpv-application/src/error.rs` (`from_api_body`, `rechazo`), `apps/tpv-main/src-tauri/src/imagenes.rs` (`para_registro`) |
| Sentry del worker | `apps/cloud-worker-licensing/src/observability/sentry.ts` |
| Axiom | `apps/cloud-worker-licensing/src/observability/axiom.ts` |
| Ingesta | `apps/cloud-worker-licensing/src/domains/telemetry/telemetry.routes.ts` |
| Eventos de sync | `durableObjects/tenantHub.motor.ts` (`emitSyncEvent`), `tenantHub.mensajes.ts` |
| Latidos | `apps/cloud-worker-licensing/src/observability/latido.ts` |
| Salud | `apps/cloud-worker-licensing/src/server/salud.ts` |
| Desglose de tiempos (`Server-Timing`: base central y viajes al `TenantHub`; lo lee el generador de carga, y sólo lo recibe un dispositivo autenticado por `tenantAuth`, nunca una ruta pública o anónima) | `apps/cloud-worker-licensing/src/observability/tiempos.ts`, `src/app.ts` |
| Esquema de evento | `crates/tpv-telemetry/src/event.rs` → `packages/contracts/src/generated/telemetry.ts` (ts-rs) |

## Release de Sentry y source maps

El cliente usa la release que fija `build.rs` a partir de la versión de `tpv` y del target.
`sentry-config.mjs` comprueba Cargo, `tauri.conf.json`, `package.json`, el tag y la identidad de
Sentry. Vite y Rust usan `tpv-desktop@<versión>`; Windows 7 usa `tpv-desktop-win7@<versión>`.
Comparten proyecto, con releases distintas. Los eventos nativos llevan `build_variant` y, en CI,
`build_commit`.

RI-24: `release.yml` exige DSN y token, comprueba por API que el DSN es una Client Key activa de
`altaria-lights/tpv-desktop` y pasa la identidad derivada del tag al build. Si falla la configuración, la subida
o la comprobación de los artefactos remotos, no llega a los jobs de firma y publicación.

Los mapas se generan como `hidden`, se suben con el JavaScript a `~/assets/` y se borran del bundle.
Se usa `release.uploadLegacySourcemaps`, sin inyección de Debug IDs: `tauri-plugin-sentry 0.5` pasa
el sobre a `sentry-rust 0.42`, cuyo deserializador no acepta imágenes `sourcemap` en `debug_meta`.
Inyectarlas haría que el puente descartase el evento. Las rutas relativas permiten simbolizar
tanto `http://tauri.localhost/assets/…` como el protocolo de Tauri.

El plugin nativo usa `init_with_no_injection`: la Webview ya inicializa su SDK con el filtro de
datos personales. Así no hay un segundo SDK inyectado que capture eventos sin ese filtro.

El token interno de CI necesita **Release → Admin**, **Organization → Read** y **Project → Read**:
el último permite comprobar el DSN activo y leer un evento controlado para verificar su traza.

### Worker: mapas, captura y datos seleccionados

El tag moderno `v<versión>` publica escritorio y API con una misma versión. El worker lleva
`tpv-api@<versión>`, en su propio proyecto. `win7-v<versión>` sólo publica Windows 7: una rama
congelada nunca reemplaza el backend compartido con código antiguo.

`worker.mjs` compila con Wrangler, inyecta Debug IDs y sube los mapas con la CLI oficial. Un
manifiesto guarda hashes del JS, mapas, módulos SQL, widget y configuración. Su sha256 sale como
salida del job que compila, y el que despliega lo exige antes de leer el artefacto (AUD-43): los
hashes y el Debug ID remoto sólo prueban que el artefacto es coherente consigo mismo, y otro job de
la ejecución podría sustituirlo por uno con el Debug ID legítimo copiado. Después se comprueban los
hashes y el Debug ID remoto. Wrangler recibe `no_bundle`, y ningún `build`, para ejecutar los mismos
bytes que se subieron. `verify-worker-sentry.mjs` ejecuta ese artefacto en workerd local sin
credenciales de Turso y exige que Sentry reciba el fallo con archivo, línea y contexto TypeScript.
Las pruebas van a `sentry-verification` y fallan antes de abrir una conexión o escribir datos.

Los `catch` de correo, Stripe, aprovisionamiento, cron y sincronización notifican errores técnicos
y conservan su respuesta o reintento. Se filtran rechazos HTTP tipados de entrada/autorización y
rechazos de negocio de `HubError`, incluido `main_offline`. Los fallos desconocidos se notifican.
Una caída de red o una cuota agotada puede impedir recibir un evento; Better Stack conserva la
vigilancia externa.

La recogida automática de cuerpo, cabeceras, cookies, IP y query está desactivada. Después de
autenticar y validar, `requestContext.ts` selecciona campos por operación: importes en céntimos,
stock, IVA, booleanos y enums cerrados. En pedidos sólo guarda cantidad de líneas y longitud de
notas. Una ruta o campo nuevo no envía su cuerpo hasta incorporarlo expresamente a la lista.
No se envían nombres, notas, destinatarios, PIN, JWT ni identificadores de personas. El filtro
final elimina usuario, extras libres y consola; el filtro común redacta patrones reconocibles en
los mensajes de error. La revisión de proveedores y retención sigue en
[LEGAL-01](../pendientes.md#legal-01--rgpd).

Los transportes Rust añaden `X-TPV-Version` y `X-TPV-Variant`, obtenidas del shell. El worker
guarda valores con formato de versión y variantes conocidas como `client_version` y
`client_variant`. Son contexto diagnóstico, no autorización.
No se embebe el token en el frontend ni en Rust. En builds locales sin token Sentry sigue siendo
opcional; una release oficial se marca con `TPV_RELEASE_BUILD=1` y no permite omitirlo.

Para verificar una traza controlada, guardar un JSON con `eventId`, `source` (sufijo del archivo
original) y `line`, y ejecutar `node scripts/release/check-sentry-event.mjs <json>` con las variables
de build. El script espera la recepción y exige la versión, plataforma, archivo y línea correctos.

El worker tiene su propio proyecto y su propia versión (`SENTRY_RELEASE` del worker, no la versión
de escritorio). `upload_source_maps` de Wrangler sube mapas a Cloudflare; no los entrega al SDK
de Sentry. Para simbolizar sus eventos también hay que subir a su proyecto el bundle y sus mapas
exactos al desplegar, con una versión compartida por esa subida y el runtime. La comprobación real
del 10-10-2026 confirmó recepción en `node-cloudflare-workers`, entorno `prod`, pero sin release
ni simbolización TypeScript; esto requiere completar el despliegue del worker.

## Configuración

| Variable | Dónde | Qué |
|---|---|---|
| `TPV_SENTRY_DSN` | Entorno del build de escritorio (release) | DSN de `tpv-desktop` |
| `SENTRY_AUTH_TOKEN` | Secret de GitHub; validación, builds y comprobación de mapas, nunca el paso que ejecuta Wrangler con el token de Cloudflare | Token interno para subir mapas y comprobar la configuración |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Variables de GitHub | `altaria-lights`, `tpv-desktop` |
| `SENTRY_RELEASE` | Lo calcula el workflow desde el tag | Nombre del componente/variante y versión compartidos por eventos y mapas |
| `TPV_RELEASE_BUILD` | Lo fija el workflow a `1` | Bloquea la release si faltan los datos de Sentry |
| `SENTRY_DSN` | Secreto del worker | DSN de su proyecto (`node-cloudflare-workers` en la cuenta actual) |
| `SENTRY_WORKER_PROJECT` | Variable de GitHub | Slug del proyecto del worker (`node-cloudflare-workers`) |
| `ENVIRONMENT` | Lo fija el artefacto del worker | `prod`; la comprobación local usa `sentry-verification` |
| `AXIOM_TOKEN` | Secreto del worker | Ingesta |
| `AXIOM_DATASET` | `wrangler.json` (`tpv-device-logs`) | Logs de dispositivo |
| `AXIOM_DATASET_SYNC` | `wrangler.json` (`tpv-sync`) | Eventos del worker y del DO |
| `AXIOM_DOMAIN` | `wrangler.json` (`eu-central-1.aws.edge.axiom.co`) | Región de Axiom |
| `BETTERSTACK_HEARTBEAT_URL` | Secreto del worker | Latido del cron (suena siempre al acabar) |
| `BETTERSTACK_HEARTBEAT_COPIAS_URL` | Secreto del worker | Latido de la copia de la base central (sólo si se subió) |

Sentry: dos proyectos para este sistema (`tpv-desktop` y `node-cloudflare-workers`), región UE,
sin Session Replay. Axiom: tres datasets
(`cloudflare-logpush`, `tpv-sync`, `tpv-device-logs`), separados por la **retención**, que es propiedad
del dataset: acortarla borra lo que quede fuera del plazo nuevo, sin vuelta atrás. Cada evento lleva
`service` (`tpv-device`, `tpv-sync`, `tpv-api`). Retención sugerida: 30 días para `tpv-sync`, 30–90
para `tpv-device-logs`.

Para comprobar la ingesta sin esperar a que pase algo, una petición sin autenticar a una ruta de tenant
emite un `device_auth_rechazado`:

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/sync/verificar/resumen \
  -H "Authorization: Bearer sonda" -H "Content-Type: application/json" -d '{}'
```

Devuelve 401 y en `tpv-sync` debe aparecer el evento con `motivo: invalid_jwt`.

## Correlación

La telemetría de dispositivos y sync lleva `tenant_id`, `device_id`, `device_mode` (tpv/handy),
`app_version` y `environment`. En Sentry, la release identifica el componente y su versión;
`build_variant` y `build_commit` identifican el escritorio, y los errores HTTP del worker añaden
`client_version` y `client_variant` cuando el cliente los envía. Los eventos del DO en Axiom añaden `connected_devices` y
`main_connected`. `connected_devices` cuenta los sockets autenticados de `state.getWebSockets()`; el
`last_seen_at_ms` de un dispositivo se refresca al conectar (lo apunta el Worker al canjear el ticket) y con
su actividad, no con el latido (que no despierta al DO): la presencia real la dan `main_online` / `main_offline`.

## Eventos de `tpv-sync`

Sólo **fallos** y **ciclo de vida**: una escritura correcta no se emite.

| `event` | Cuándo |
|---|---|
| `apply_error` | Una escritura falla en el DO: una de la Handy o una operación de un lote de la Main. `command_name`, `op_id`, `device_id` y error recortado (en una de la Handy, también `latency_ms`), sin el comando ni sus args |
| `main_online` / `main_offline` | Una Main se autentica / se va la última (freeze de las Handy) |
| `device_auth_rechazado` | El worker rechaza a un dispositivo. `motivo`, `ruta` (filtrada y acotada a 256 bytes), `metodo` |
| `tenant_salud_sync` | El contraste diario de una Main con la nube (descuadres, reparadas) |
| `hub_no_disponible` | El objeto de un negocio no ha atendido una petición: `motivo` (`saturado`, `pasajero`, `otro`), si era una lectura ya repetida, el método y la ruta. Lo emite el Worker (`service: tpv-api`) |
| `base_llena` | La base de un negocio está llena o en sólo lectura. Una vez por instancia del DO; no se aparta nada mientras dure |
| `migracion_fallida` | La base de un negocio no ha podido ponerse al día tras un despliegue: contesta 503 hasta que se arregle. Una vez por instancia del DO |

## Alarmas recomendadas

- **Sentry**: issue nuevo o pico en cada proyecto, caída del *crash-free rate*, Spike Protection y
  filtros de entrada (un DSN público se puede sondear).
- ⚠️ **`outbox_op_apartada` en Sentry** (lo emite el TPV): un equipo tiene un dato que la nube no va a
  tener. Trae `op_id`, `command_name`, `intentos`, `permanente` y `error_nube`, sin sentencias ni args. Su
  pareja en el worker es el `apply_error` de esa misma `op_id`.
- **Main caída**: `main_offline` sin `main_online` posterior en N minutos por `tenant_id`.
- **Errores de apply**: volumen de `apply_error` por `tenant_id`.
- **Un negocio cuyo objeto no da abasto o no arranca**: una racha de `hub_no_disponible` del mismo
  `tenant_id`. Uno suelto con `pasajero` es normal: cada despliegue reinicia los objetos.
- **Una base que necesita a alguien**: cualquier `base_llena` o `migracion_fallida`. También llegan a
  Sentry (`tenant_db.full`, `tenant_db.migration`).
- **Dispositivo rechazado**: una racha de `device_auth_rechazado` del mismo `device_id`; agrupar por
  `motivo` (`device_revoked`, `bad_device_signature`, `device_ts_out_of_range`). No van a Sentry: un 401
  suelto es normal.
- **Descuadres**: `tenant_salud_sync` con descuadres.
- **Errores de dispositivo**: tasa de `level == "ERROR"` en `tpv-device-logs` por tenant. Los fallos
  de comandos (`target == "tpv::comandos"`) se agrupan por `comando` y `code`.
- **Better Stack**: `/health` en rojo, y cualquiera de los dos latidos que deje de sonar.

## Por qué `/health` y los latidos

Sentry y Axiom dependen de que el código se ejecute y consiga emitir: si el worker no despliega, la
cuenta se suspende o el DNS se rompe, un panel vacío se ve igual que «no pasa nada». Por eso hay una
sonda externa contra el **mismo hostname que usan los clientes**, y `/health` toca la base central
([worker.md](worker.md#salud-y-vigilancia-externa)): un `{ ok: true }` que no comprueba nada estaría verde
durante una avería de Turso. Ninguna petición HTTP ve que el cron lleve meses sin dispararse; eso lo dice
su latido.

## Pendiente

- **Lo que tiene que comprobar y hacer el responsable en Cloudflare y en Axiom** (AUD-27; nada de
  esto se ve desde el repositorio):
  - mirar si `observability.redact_query_string` está puesto en el worker `tpv-api`; si no, ponerlo
    por la API de Cloudflare y comprobar tras el siguiente despliegue que sigue;
  - mirar en el panel si el job de Logpush manda el campo `Event` (la URL va dentro), qué retención
    tiene `cloudflare-logpush` y quién puede leerlo;
  - si el job lo mandaba, lo que se copió con datos de clientes en la URL sale de Axiom acortando
    la retención de `cloudflare-logpush`; en Workers Logs caduca solo a los 7 días.
- Un límite por dispositivo en `/v1/telemetry` (hoy: topes de tamaño y autenticación).
- En Rust, `#[tracing::instrument(skip_all, fields(...))]` en los casos de uso para no volcar DTOs con
  datos de cliente en los spans.
