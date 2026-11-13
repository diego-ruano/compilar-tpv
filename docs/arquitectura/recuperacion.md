# Recuperación: volver de perder la base local

El catch-up sirve para volver de un **corte**; no sirve para volver de perder la **base**. El estado de
una tabla es la suma de todos sus cambios, y `Sync_Changes` se purga a los 7 días: una Main que arranca
con `data.db` vacía y `Last_Seq = 0` no reconstruiría nada pidiendo cambios. Para eso está esta
pantalla, con tres salidas: la nube, una copia local o una copia traída de fuera.

**Sin internet, una Main que perdió su `data.db` no vuelve a vender**: puede reconstruir el fichero
desde una copia, pero el login no se abre hasta reconciliar con la nube. Trabajar sobre una copia
antigua crearía dos historiales que no hay forma de juntar.

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Guardia del seed | `crates/tpv-infra-sqlite/src/connection.rs::seed_admin_if_empty` | Con la licencia activada **no** siembra el administrador |
| Señal de equipo aprovisionado | `apps/tpv-main/src-tauri/src/lib.rs::dispositivo_aprovisionado` | `license_state.json` con `tenant_id`, fuera de `data.db` |
| Tercer estado del arranque | `crates/tpv-infra-sqlite/src/login.rs::setup_pendiente` | `requiere_recuperacion` = cero usuarios |
| Fase 1 | `domains/sync/sync.routes.ts` → `/v1/sync/bootstrap` | Estado acotado + `Seq` de la foto |
| Qué entra en la fase 1 | `domains/sync/bootstrap.ventana.ts` | Maestros enteros, transaccionales de 30 días, y el orden de relleno |
| Fase 2 | `/v1/sync/historico` + job `backfill_historico` + `use_cases/sync.rs::backfill_paso` | El resto del histórico, por páginas, con el bar ya vendiendo |
| Cola del backfill | `_Backfill_Historico` (`0001_inicial.sql`, §16) | Progreso reanudable, local |
| Restaurar desde la nube | `crates/tpv-infra-sqlite/src/sync.rs::bootstrap_restaurar` | Reemplaza en una transacción y siembra la cola de la fase 2 |
| Copias locales | `crates/tpv-infra-sqlite/src/recovery.rs` + job `backup_local` | `VACUUM INTO` diario, comprimido; se guardan las 7 últimas |
| Copia manual, exportar, importar | `commands/recovery.rs` (`recovery_create_backup`, `…_export_backup`, `…_import_backup`) | Sacar una copia del equipo y traerla de vuelta |
| Base que no abre | `lib.rs::run` (arranque sin `Db`) + `commands/recovery.rs::asegurar_base_para_recuperar` | Arrancar igual y apartar el fichero ilegible |
| Bloqueo del login | `_Recovery_State.Reconciliation_Pending` | Restaurado no es utilizable |
| Reconciliar | `tpv-application/src/use_cases/replicacion.rs` + transporte nativo | Catch-up → outbox → catch-up, hasta converger |
| Desbloquear | `commands/recovery.rs::completar` (interno) | Outbox a 0 y checkpoint ≥ el final del log de la nube |
| Copia anterior al log | `replicacion.rs::falta_un_tramo` + `purgadoHasta` de `/v1/sync/changes` | Le falta un tramo purgado: no se reconcilia (AUD-19) |
| Traslado de licencia | `use_cases/licensing.rs::activate` + `recovery.rs::BaseLocal` (la marca) | La base de antes del traslado no se usa |
| El sello de la base (AUD-06) | `_Negocio` (`0002_negocio.sql`) · `crates/tpv-infra-sqlite/src/sello.rs` · `tpv_domain::licensing::que_hacer_con_la_base` | De qué negocio es cada base y cada copia; una base sólo se usa con la licencia de su negocio |
| Cambio de negocio | `use_cases/licensing.rs::activate` (licencia pendiente + marca `AppData/cambio-de-negocio`) + reinicio (`commands/licensing.rs`) | La licencia es de otro negocio que la base: queda pendiente y el TPV se reinicia |
| Aplicarlo al arrancar | `lib.rs::run` → `use_cases/licensing.rs::aplicar_cambio_de_negocio_pendiente` | Apartar lo del anterior, la licencia pendiente a vigente, quitar la marca; antes de abrir nada |
| Apartar lo de otro negocio | `recovery::apartar_para_el_cambio_de_negocio` (arranque con cambio pendiente: todo) · `recovery::resolver_al_abrir` (`connection::init_main_db`: con la regla) | A `backups/negocio-anterior-<ms>/`; lo que quedó a medias, primero |
| Pantallas | `src/app/pages/RecuperarDatos.tsx` (restaurar) · `features/configuracion/sections/CopiasSeguridad.tsx` (ver y sacar copias, en Configuración → Licencia) | |

---

## Cuándo se entra en recuperación

`recovery_status` da uno de estos estados, y `TransferPending` manda sobre los demás:

- **Traslado pendiente**: este equipo acaba de recibir la licencia de otro (abajo).
- **Faltan los datos**: la base tiene **cero usuarios**. En una instalación nueva eso no pasa, porque
  el seed crea el administrador; con la licencia activada el seed no lo crea, precisamente para que una
  base vacía no se confunda con una instalación nueva. Si se confundiera, el administrador del seed
  (PIN público `1234`, `Requiere_Setup = 1`) completaría su pantalla de inicio y ese `UPDATE Usuarios`
  pisaría en la nube la credencial del administrador de verdad.
- **Base ilegible**: si `init_main_db` falla, el `setup()` de Tauri no revienta: arranca **sin `Db`**,
  los comandos de arranque fallan y el frontend lo lee como datos perdidos. `recovery_status` desempata
  por modo (no tener base es normal en una Handy).
- **Reconciliación pendiente**: se restauró y todavía no se ha comprobado contra la nube.

Mientras dure:

- **El socket no se abre** (`pausada`): un catch-up desde cero aplicaría días de operaciones sobre
  tablas vacías y llenaría la cuarentena.
- **Ninguna escritura de negocio entra.** `connection::init_main_db` pone el cerrojo
  `Db::bloquear_escrituras_de_negocio` según el estado, y `WriteGuard::execute` lo consulta (`raw()`
  no). Si una escritura devuelve «este equipo está recuperando sus datos», el cerrojo está bien: lo que
  hay que revisar es por qué esa escritura corre durante una recuperación.
- **Todo `commands/recovery.rs` tolera `state.db == None` y `sesion == None`**
  ([permisos.md](permisos.md)).

## Desde la nube: dos fases (SYNC-19)

**Fase 1** (`/v1/sync/bootstrap`): lo imprescindible para volver a vender, en una petición y una
transacción de lectura, con el `Seq` leído **dentro** de esa transacción (leído aparte, una escritura
podría entrar en la foto y volver luego por el catch-up). No pagina: una foto a trozos no es una foto.

- **Maestros enteros; transaccionales, 30 días** (`VENTANA_DIAS`).
- La ventana **se estira hasta el último cierre de caja**: el arqueo suma desde ahí
  ([caja.md](caja.md)).
- **Lo que sigue vivo entra entero**, caiga donde caiga: comandas abiertas, notificaciones activas,
  pedidos en borrador, fichajes sin cerrar.
- **La unidad es la comanda**: entra con sus líneas, pagos, detalles de pago y consumos, o no entra
  (una FK colgante abortaría la restauración entera).
- `Registros_Facturacion` entra en la ventana **más su última fila por `Orden`**, que es el eslabón del
  que sigue la cadena.
- Una tabla de negocio sin clasificar viaja entera; un test compara la clasificación con el esquema.
- El worker dice qué tablas vienen recortadas (`parcial`) y en qué orden rellenarlas: la clasificación
  vive sólo en `bootstrap.ventana.ts`.
- **Un volcado se pide comprimido, con su propio plazo, y se lee de una pasada.** El cliente REST de
  la Main (`tpv-infra-licensing`) manda `Accept-Encoding: gzip` y descomprime al leer. Las rutas que
  bajan un volcado (`/bootstrap`, `/historico`, `/verificar` y `/verificar-claves`) tienen 150 s de
  plazo, de conectar a terminar el cuerpo, frente a los 20 s del resto; conectar tiene 10 s en
  todas. La respuesta va de los bytes a su tipo (`use_cases::sync::pedir`), sin un
  `serde_json::Value` intermedio que la tenga dos veces en memoria. Una respuesta que no llega
  entera es un fallo de conexión, no un volcado vacío.

`bootstrap_restaurar` reemplaza las tablas en una transacción, filtra nombres de tabla y columna
contra `sqlite_master` y contra `[A-Za-z0-9_]` (se interpolan en el SQL), informa de las tablas que
esta versión no conoce (`tablas_desconocidas`) en vez de fallar, vacía `_Sync_Failed` y siembra
`_Backfill_Historico`.

Si lo que se reemplaza es una copia restaurada que no llegó a reconciliarse (AUD-19), su outbox no
pasa a la base nueva, como en el traslado: es de antes, y lo que el equipo de entonces ya subió se
aplicaría otra vez en cuanto caducara su `Applied_Operations` (un `UPDATE` viejo devolvería un PIN o un
rol ya cambiados). Antes de tomar el escritor se guarda la base entera, outbox incluido, en
`backups/antes-de-la-nube-*`, y dentro de la transacción se vacía el outbox.

**Fase 2** (`/v1/sync/historico` + job `backfill_historico`, cada 5 minutos): el resto, por páginas de
`rowid`, sin transacción ni `Seq` (son datos que ya no cambian).

- **`INSERT OR IGNORE` siempre**: lo que ya está en local llegó por el catch-up y es más nuevo; la
  fase 2 vuelve a bajar a propósito la ventana de la fase 1.
- ⚠️ **Por `WriteGuard::raw()`**: por `execute()` devolvería a la nube, fila a fila, el histórico que
  acaba de bajar.
- El cursor avanza en la misma transacción que inserta: apagar a mitad no pierde nada.
- Es `Requiere::MainOperativa`, así que no compite con el desbloqueo del login. Se pausa con el
  interruptor `backfill_historico`.
- **La reconciliación de valores derivados se calla mientras falte histórico** (compararía maestros
  completos con transaccionales a medias), y Conectividad y Estadísticas dicen que el histórico se está
  descargando.
- **El contraste con la nube tampoco corre mientras falte histórico** (VERIF-01): lo que queda por
  bajar le parecería sobrante de la nube y lo borraría arriba, con sus cascadas, antes de que la
  fase 2 lo trajera ([sincronizacion.md](sincronizacion.md#reparar-una-divergencia-sync-22-sync-24-sync-25)).
  Lo que recuerda de sus pasadas (`_Verificacion_Nube`) es estado local: reconstruir desde la nube
  no lo toca, y una copia local trae el de cuando se hizo. En los dos casos vuelve a contrastar,
  con el histórico ya completo, en el primer momento tranquilo que le toque
  ([jobs-e-interruptores.md](jobs-e-interruptores.md#cuándo-se-contrasta-con-la-nube-verif-02)).

## Desde una copia local

- **Copia diaria**: `VACUUM INTO` por el pool de **lectura** (en WAL la instantánea es coherente sin
  bloquear al escritor ni los cobros), se valida y se guarda **comprimida con gzip** en
  `AppData/backups/data-*.db.gz`, conservando las 7 últimas. Lo que se valida y se restaura es siempre
  la base descomprimida en un fichero aparte; un `.db.gz` también lo abre 7-Zip. Por el escritor
  fallaría: no admite `ATTACH` (AUD-02), que es como SQLite adjunta el destino de un `VACUUM INTO`
  ([sincronizacion.md](sincronizacion.md#escritor-único-y-captura)).
- **Fuera del runtime async**: SQLite trabaja sin ceder en el hilo que lo llama, así que el
  `VACUUM INTO`, el `quick_check`, comprimir y copiar la base entera van por `spawn_blocking`.
- **Copia ahora / guardar fuera / traer**: `recovery_create_backup`, `recovery_export_backup` (a donde
  elija el usuario: un USB; sale comprimida, tal como está guardada) y `recovery_import_backup`, que la
  guarda comprimida como `import-*` y **no caduca**. Se importa una copia comprimida o una base tal cual
  (una `.db` de antes, o la `data.db` rescatada de otro equipo): el formato se reconoce por el contenido.
- **Una copia lleva el sello de su base** (AUD-06): con el de otro negocio que el de la licencia, ni
  se importa, ni se restaura, ni se saca del equipo, y lo dice («Esa copia es de otro negocio…»); sin licencia activada, una
  sellada tampoco. Una copia **sin sello** (anterior a los sellos) no dice de quién es: se acepta como
  antes, la pantalla advierte de que no se comprueba, el daño se queda en local (restaurar no llena el
  outbox) y se deshace recuperando de la nube; al abrirla se sella con la licencia que haya
  ([SYNC-33](../pendientes.md#sync-33--una-copia-sin-sello-no-dice-de-qué-negocio-es)). Lo apartado
  (`backups/antes-de-traslado-*` y `backups/negocio-anterior-*/`) no se importa, lleve sello o no.
  Y no se restaura nada mientras la base que hay en el equipo sea de otro negocio: primero se aparta.
- Una copia inservible se rechaza diciendo por qué.
- Al restaurar, `_Sync_Failed` queda coherente con el checkpoint de la copia (AUD-18): lo que va por
  encima se borra, porque el catch-up de la reconciliación lo vuelve a traer y a intentar en orden. Su
  marcador de `_Sync_Applied_Ops`, si lo tiene, se va con él sólo si lo puso una cuarentena que no
  llegó a mover el checkpoint (una copia de cuando no era una sola transacción: intentos agotados y el
  marcador posterior al último fallo), porque con él el cambio se daría por aplicado sin haberse
  aplicado. Si es el anti-eco de una operación propia (cuyo eco no pudo mover el checkpoint), se
  queda: ya está aplicada en esa copia, y sin él el catch-up la aplicaría otra vez. La cuarentena que
  va por debajo se conserva, porque esa copia no tiene ese cambio y el catch-up no lo traerá (un fallo
  de debajo sin cuarentena, de una copia anterior a AUD-18, pasa a estarlo). Con una cuarentena,
  `completar` no desbloquea con esa copia: la salida es otra copia o la nube.
- **La guardia del outbox**: restaurar reemplaza, así que se niega si hay operaciones sin subir. La
  comprobación va **dentro** de la transacción (`bootstrap_restaurar` y
  `recovery::asegurar_reemplazo_seguro`), con dos excepciones: una base ya en reconciliación y una base
  sin usuarios, porque ninguna de las dos está vendiendo. Una operación apartada sigue contando.
- **Las copias viven en el mismo disco que protegen**: cubren un borrado o una corrupción, no una
  máquina muerta. Para eso, «Guardar fuera…» en Configuración → Licencia (ahí no se restaura).

## Base ilegible

`asegurar_base_para_recuperar` **sólo actúa si no hay `Db`**: mueve la `data.db` que no se pudo abrir a
`backups/ilegible-*` (no se borra: es lo único que queda de lo que no subió; tampoco se ofrece como
copia restaurable) y crea una vacía en su sitio para que la nube tenga dónde escribir.

## Restos

`pre-restore-*`, `failed-restore-*`, `ilegible-*`, `antes-de-traslado-*` y `antes-de-la-nube-*` no son
copias diarias: el job `backup_local` conserva las dos más recientes de cada familia y purga el resto,
junto con los temporales de más de una hora (`data.restore.*` y los `backups/.*.tmp` de una copia que
no terminó). De estas familias, `pre-restore-*`, `failed-restore-*` e `ilegible-*` no se comprimen: se
apartan con un `rename`, sin reescribirlas. `antes-de-traslado-*` y `antes-de-la-nube-*` sí van
comprimidas. Las copias previas a una migración
(`data.db.bak.*`, en la raíz de AppData) siguen la misma regla, y tampoco se comprimen: se hacen al
arrancar, antes de abrir la base, y comprimirlas retrasaría el arranque.

Con un cambio de negocio pendiente no se borra nada de esto, ni las copias diarias de más: la
retención se suspende hasta que el arranque lo aparte todo
([abajo](#una-base-sólo-se-usa-con-la-licencia-de-su-negocio)).

`backups/negocio-anterior-<ms>/` no es una familia de restos: es todo lo de otro negocio, apartado
([abajo](#una-base-sólo-se-usa-con-la-licencia-de-su-negocio)). La purga no entra y nada la vacía:
ocupa lo que ocupaban esos ficheros hasta que alguien la borre a mano.

## Reconciliar y desbloquear

Tras restaurar, `_Recovery_State.Reconciliation_Pending = 1` ([verifactu.md](verifactu.md#tras-restaurar)
dice qué pasa con los registros de facturación) y el socket hace, en orden: **catch-up** (lo ocurrido
después de la copia), **subir el outbox** (lo que la copia tenía) y **catch-up** otra vez hasta que el
outbox esté a 0 y el checkpoint alcance el final del log de la nube (hasta 180 vueltas).
`completar` vuelve a comprobarlo y desbloquea el login. Si `/v1/sync/changes` no informa del
final del log, **no se desbloquea**.

**Una copia anterior a lo que guarda la nube no se reconcilia** (AUD-19). `Sync_Changes` se purga
a los 7 días, así que a una copia con el cursor por debajo le faltaría un tramo que el catch-up ya
no puede traer: ventas, cobros y cierres de en medio, y las bajas, los roles y los PIN que
cambiaron. Si `/v1/sync/changes` dice que la nube ya ha purgado algo por encima de `Last_Seq`
(`purgadoHasta`), el catch-up para antes de aplicar ni subir nada con «Esta copia es anterior a lo que
guarda la nube: recupera el estado actual de la nube.». Es un ciclo fallido más, y a los cinco la
pantalla ofrece las alternativas, la nube entre ellas; elegirla no sube el outbox de la copia (ver
«Desde la nube»). Antes de elegir, la lista de copias enseña la antigüedad de cada una y avisa, sin
impedirla, de las que pasan de 7 días.

Si `/v1/sync/changes` no dice `purgadoHasta` (un worker anterior a AUD-19), **ninguna
reconciliación termina**, tampoco la que sigue a recuperar desde la nube: el modo recuperación
no puede comprobar lo que falta y para. Por eso el worker se despliega antes que la Main.

Tras **5 ciclos seguidos fallidos** (contador del motor nativo) la reconciliación queda `bloqueada`: deja
de reintentar sola y la pantalla vuelve a ofrecer las alternativas.

## Traslado de licencia

Un equipo que recibe la licencia de otro con el código del correo tiene en su base lo de antes del
traslado, y el otro equipo ha seguido trabajando:

- **Lo dice el servidor** (`cambioDeEquipo` en la respuesta de `/v1/license/activate`), no que se haya
  escrito un código.
- La señal es la marca `AppData/traslado-pendiente`, fuera de `data.db` (restaurar una copia no la
  borra). Con ella: estado `TransferPending`, escrituras cerradas, la pantalla sólo ofrece la nube y
  **el outbox no sube**.
- Reconstruir desde la nube **descarta ese outbox** (la excepción a la guardia) y guarda antes la base
  en `backups/antes-de-traslado-*`. La marca se quita **después** del `COMMIT`.
- Es del mismo negocio, así que sólo la base es de antes: sus copias, sus imágenes y lo que dejó a
  medias (`_Cobros_Pendientes`, `_Reservas_Web_Avisos`) se quedan.
- No cubre al equipo que vuelve a ser la Main de su licencia sin que se trasladara: ahí su base vale, y
  si su fila de `devices` se movió, `readmitirMain` lo arregla al comprobar la licencia.

## Una base sólo se usa con la licencia de su negocio

AUD-06. Cada base lleva dentro de qué negocio es: su **sello**, la fila de `_Negocio`. Lo escriben la
activación (en una base sin sello), la apertura de una base sin sello con una licencia guardada (en la
misma transacción que sus datos iniciales, si es nueva) y la reconstrucción desde la nube, en la suya;
las copias lo llevan porque son la base entera. Una base que no se deja leer no dice de quién es, y
nunca se da por «sin sello». La regla es una (`tpv_domain::licensing::que_hacer_con_la_base`,
[licencias.md](licencias.md#una-base-sólo-se-usa-con-la-licencia-de-su-negocio)) y se aplica en tres
sitios: al activar, al abrir la base y al restaurar, importar o exportar una copia (arriba).

**Cambiar de negocio reinicia el TPV, y hasta entonces el negocio nuevo no existe en el proceso.**
Cuando la licencia que se activa es de otro negocio que la base (o no se sabe de quién es la base):

1. Se guarda **como pendiente**, sin tocar la vigente: su token y su DEK en entradas aparte del
   almacén de secretos (`license-token-pendiente`, `field-dek-pendiente`) y su estado en
   `AppData/license_state.pending.json`, que se escribe el último (entero o nada) y es lo que dice
   que hay una pendiente. Después se anota el cambio en `AppData/cambio-de-negocio` (con el negocio;
   también entero o nada).
2. La pantalla avisa («Esta licencia es de otro negocio. Guardamos aparte los datos del anterior y el
   TPV se reinicia.») y a los cuatro segundos el comando pide a Tauri que reinicie el TPV
   (`app.restart()`, en escritorio). No es más que eso: si el TPV se cierra antes o el reinicio no
   llega, el cambio se queda anotado y lo aplica el siguiente arranque, sea cuando sea.
3. Hasta entonces todo sigue siendo del negocio anterior: la licencia vigente, sus credenciales, su
   base y lo que se hace con ella. Lo que estaba en marcha, o empieza en esos segundos (un login, la
   réplica, una subida o una descarga, la copia diaria, una restauración), termina como del anterior,
   con sus credenciales y en su base, y lo que deje se aparta con ella al arrancar. Con el cambio
   anotado:
   - **no se activa ni se canjea ninguna otra licencia**, tampoco la del negocio de la base: se
     rechaza antes de pedir nada a la nube («El TPV tiene un cambio de licencia pendiente: ciérralo y
     vuelve a abrirlo antes de activar otra.»). Todas las activaciones y canjes van además de una en
     una (un cerrojo del proceso en el caso de uso), y sellar nunca sustituye un sello distinto;
   - **la retención se suspende**: ni la copia diaria ni la purga de restos borran nada del equipo
     (mirar la marca y borrar van juntos, con el mismo turno que toma quien publica la marca: la
     publicación espera al borrado en curso y lo que viene detrás ya la ve), porque todo es del
     negocio que se va a apartar.
4. Al arrancar, en `setup()`, antes de leer la licencia para nada, de abrir la base y de que arranque
   ninguna tarea (`use_cases::licensing::aplicar_cambio_de_negocio_pendiente`), si hay un cambio
   anotado:
   1. se aparta **todo** lo que haya en el equipo de un negocio (abajo), haya o no `data.db` y diga lo
      que diga su sello: una restauración cortada entre sus dos `rename` deja el equipo sin
      `data.db` y con todo lo demás. Lo único que se queda es una base ya sellada con el negocio
      nuevo, que no puede darse antes de aplicarlo;
   2. la licencia pendiente pasa a vigente: token, DEK y estado; después se borra lo pendiente, el
      estado lo último;
   3. se quita la anotación del cambio.

   Y se abre la base con la licencia nueva: vacía, y el equipo sigue el camino de uno que ha perdido
   sus datos (trae los de su negocio de la nube).

Cada paso se puede repetir, y el orden aguanta un corte en cualquier punto: el siguiente arranque
sigue desde donde se quedó. Mientras el cambio no termina, la licencia vigente es la anterior (hasta
el paso 2) y **no se abre ninguna base**: el arranque sigue sin `Db`, como con una base ilegible, y en
caliente no se abre ni se instala ninguna (`sin_cambio_de_negocio_a_medias`: la pantalla de
recuperación dice que se cierre el TPV y se vuelva a abrir). Como el proceso de antes puede tardar un
instante en soltar la base al reiniciarse, un fallo al arrancar se reintenta unas cuantas veces antes
de rendirse.

Sólo el arranque quita la anotación: ni una restauración ni una apertura en caliente lo hacen. Y una
licencia pendiente sólo se aplica con su anotación: una pendiente sin anotación (el corte cayó entre
guardar la una y la otra) se descarta al arrancar, y una anotación sin pendiente (lo pendiente se ha
perdido o no se deja leer) cuyo negocio no es el de la licencia vigente sólo se quita, y el equipo
sigue con lo que tenía. Cambiar de idea antes del reinicio no se puede: hay que reiniciar y, después,
activar la otra licencia, que es otro cambio de negocio.

El cableado de `setup()` (llamar al caso de uso, el reintento, arrancar sin base si no termina) y las
negativas en caliente con la marca puesta no tienen test automático: lo que tiene es lo de debajo (el
caso de uso, lo pendiente en el almacén y el apartado, con SQLite de verdad). El reinicio en sí sólo
se prueba a mano.

**Lo que se aparta** (`recovery::apartar_para_el_cambio_de_negocio` en el paso 1;
`recovery::resolver_al_abrir`, con la regla de la licencia, desde cada `connection::init_main_db`):

- un apartado que se quedó a medias se termina primero, sea cual sea la licencia: lo que ya se movió
  no es del negocio de la base que quede, y lo que falta es suyo;
- con un cambio pendiente, todo lo del equipo (arriba); al abrir, si la base es de otro negocio que
  la licencia, o no se deja leer. En los dos casos **se aparta todo lo de ese negocio**, sin borrar ni
  pisar nada (un nombre ocupado lleva otro detrás), a
  `backups/negocio-anterior-<ms>/`, con la misma forma que tenía en AppData: la base (y con ella sus
  intentos de login, su registro de jobs, lo que tenía a medias y su outbox), **todas** sus copias y
  bases guardadas de `backups/`, las copias previas a una migración, los temporales de una
  restauración, la carpeta `images/` y su cola, sus marcas y el WAL de la base (aunque no esté la
  base: junto a la nueva sería su WAL). Al abrir una base ilegible se quedan sólo las copias selladas
  con la licencia, que dicen ser de ese negocio: son con las que se recupera una base dañada. Lo que
  es del equipo (la licencia, el modo, los interruptores, la telemetría) se queda.

La carpeta lleva una marca de apartado en curso desde que se crea hasta que termina, y la base es lo
último que se mueve. Si algo no se deja mover (un fichero abierto por otro programa), o una carpeta
no se deja abrir o recorrer (sólo una que no existe cuenta como vacía), se para ahí: la base sigue en
su sitio con su sello, las marcas siguen puestas, la licencia nueva sigue pendiente y el siguiente
arranque lo termina en la misma carpeta. Si ya no queda nada que apartar, no se crea ninguna.

Volver a la licencia del negocio anterior después de traer la nube del nuevo es lo mismo al revés: la
base del nuevo se aparta en otra carpeta y el anterior trae la suya de su nube.

Las imágenes y la clave de cifrado de campo siguen la misma regla
([licencias.md](licencias.md#una-base-sólo-se-usa-con-la-licencia-de-su-negocio)): la cola sólo se
sube, y lo que falta sólo se baja, si la base abierta es la del negocio de la licencia, y cada subida
lleva el negocio con el que empezó.

Lo que no hace:

- **No reconoce una copia sin sello** (anterior a los sellos): se acepta con un aviso
  ([SYNC-33](../pendientes.md#sync-33--una-copia-sin-sello-no-dice-de-qué-negocio-es)).
- Los cobros antiguos del navegador (`localStorage`, de antes de que los cobros a medias vivieran en
  la base) no dicen de qué negocio son: se importan sólo si su ticket está en la base, con todas sus
  líneas; los demás se apartan en el propio `localStorage` como desconocidos
  ([frontend.md](frontend.md)).
- `negocio-anterior-<ms>/` no se vacía nunca.
- En la Handy no hay base ni reinicio: no activa licencias de Main.
- No reinicia por la fuerza: si el TPV no llega a reiniciarse (se cierra antes, o el reinicio falla),
  el cambio lo aplica el siguiente arranque, y hasta entonces no se activa otra licencia ni se purga
  nada.

## Lo que vuelve y lo que no

- Vuelve todo lo que llegó a la nube, incluida la **PII del personal**: viaja cifrada por el outbox, el
  volcado la devuelve tal cual y la DEK se recupera al activar.
- No vuelve lo que se quedó en el outbox del equipo perdido.
