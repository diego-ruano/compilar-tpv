# Permisos, sesión y seguridad

Quién puede hacer qué dentro del TPV, cómo se protege lo que sale del equipo, y hasta dónde llega la
garantía.

## Qué garantiza esto, y qué no

**Quien tiene la máquina puede saltarse cualquier comprobación que corra en ella**: invocar comandos
por el IPC, parchear el binario, abrir `data.db` con un cliente SQLite. Ni la sesión del backend ni el
gate de licencia son fronteras criptográficas.

Lo que sí consiguen:

- Para pasar un gate hay que iniciar sesión con el PIN de alguien autorizado, o como alguien autorizado
  que entra sin PIN ([abajo](#entrar-sin-pin)).
- El usuario que queda **firmado en una fila** (quién cobró, cerró la caja, anuló, abrió el cajón) lo
  pone el backend, no la pantalla.
- Entre «la interfaz esconde el botón» y «el botón no hace nada» no queda hueco.

El riesgo que cubre es **un camarero con el TPV delante**. El Worker valida la licencia, el dispositivo y las reglas de negocio; la autorización personal de
la Handy permanece en Rust hasta SEC-SESION. Y la licencia va firmada ([licencias.md](licencias.md)): un parche del binario la
salta, un ataque de red no.

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| La sesión | `apps/tpv-main/src-tauri/src/lib.rs` (`Sesion`, `AppState::sesion`) | `Option<Sesion>` en memoria: `id_usuario`, `id_trabajador`, `rol` |
| Los gates | `lib.rs` (`sesion`, `exigir_permiso`, `exigir_rol`, `exigir_rol_si_hay_sesion`) | Identidad vigente y gates por capacidad |
| El rol | `lib.rs::ADMIN` · `src/shared/lib/permisos.ts::ROL_ADMIN` | Uno por lado |
| Código de error | `tpv-contracts::errors::ErrorCode::PermisoDenegado` (`permiso_denegado`) | La UI ramifica por él |
| Cierre de sesión | `src/shared/stores/useAuth.ts`, `src/app/AppBoot.tsx`, `src/shared/lib/useInactivityLogout.ts` | Las dos sesiones se cierran juntas |
| El guardián | `lib.rs::tests_exenciones_del_gate` | Lee el fuente y vigila las reglas de abajo |

## La sesión

| Momento | Qué pasa |
|---|---|
| Arranque | `None`: al abrir la app siempre se vuelve al login |
| `login_user` correcto | Se pone, con el rol **que devuelve el repositorio** (SQLite en la Main, worker en la Handy) |
| `logout` | Se quita |
| Cambio de modo o sustitución del token Handy | Se quita antes de cambiar el backend/tenant |
| 10 minutos sin tocar nada | El frontend cierra sesión (`useInactivityLogout`) |
| Recarga del webview | `AppBoot` llama a `logout`, para no dejar una sesión de administrador viva detrás de una pantalla de PIN |

El rol y el usuario salen del repositorio y **nunca de los argumentos** de un comando.

RI-83: el caso de uso verifica el fichaje **antes** de devolver el acceso y establecer la sesión.
Hace falta la primera entrada de la jornada. Si se ha marcado jornada partida y cerrado la primera
parte, hace falta la segunda entrada. Después de la salida final se puede acceder: el login no
registra horas ni crea un tramo nuevo. Ningún rol está exento. La casilla de jornada partida es
manual; una segunda parte registrada impide desmarcarla, tanto en la Main como en la Handy.

| Helper | Para qué |
|---|---|
| `sesion()` | Algo atribuible que hace cualquiera: exige estar identificado |
| `exigir_permiso(codigo)` | Acción configurable: usuario activo y concesiones actuales |
| `exigir_rol(&[ADMIN])` | Administración estructural: sesión y rol vigente |
| `exigir_rol_si_hay_sesion(&[ADMIN])` | Lo que se alcanza también **antes** del login: sin sesión pasa, con sesión exige el rol |

Lo lleva `device_reset_mode` (volver al selector de modo, que en la Handy borra el vínculo). Sin
sesión lo alcanza el «← Volver» de la activación de licencia; con ella, Configuración → Dispositivo,
que tiene además candado de ruta. El «← Volver» de la vinculación de la Handy no lo llama: enseña el
selector sin tocar nada guardado, y desvincular queda para el administrador
([emparejamiento.md](emparejamiento.md#salir-del-vínculo)). El comando no se endurece para la Handy:
`handy_set_token`, que va sin sesión porque emparejar es anterior al login, sustituye el vínculo
igual, y por el IPC no hay frontera ([arriba](#qué-garantiza-esto-y-qué-no)).

Lo lleva también `sync_bootstrap_desde_nube` (traer el estado actual de la nube): sin sesión lo
alcanza la pantalla de recuperación; con ella, Configuración → Conectividad cuando un cambio de la
nube se ha atascado en su cuarentena (SYNC-36,
[sincronizacion.md](sincronizacion.md#la-salida-de-una-cuarentena-de-bajada-sync-36)).

---

## Capacidades por rol (RI-70)

El catálogo estable vive en `tpv-domain::permisos::CATALOGO`. `Roles_Permisos` guarda una concesión
por rol y acción; no hay permisos individuales, SQL configurable ni fallback cuando un rol está
vacío. Una capacidad desconocida se deniega incluso al administrador. Los comandos solicitan
`exigir_permiso`; el puerto se implementa en SQLite para Main y en HTTP para Handy.

`sesion()` relee el usuario activo y su rol vigente; `exigir_permiso` obtiene además las concesiones
en la misma consulta. Desactivar una persona, cambiarle el rol o editar sus permisos afecta a las
siguientes operaciones de su sesión abierta: en la Main, en la siguiente; en la Handy, en cuanto le
llega el aviso del cambio ([abajo](#la-autorización-guardada-en-la-handy-perm-cache)). Si se cierra o
cambia la sesión mientras llega una consulta HTTP, su respuesta no autoriza al nuevo usuario. El
proceso de réplica y los jobs no necesitan una sesión personal.

| Grupo | Capacidades configurables |
|---|---|
| Servicio | Comandas/venta/cobro, cocina, reservas, tareas propias |
| Inventario | Editar catálogo, precios e IVA, borrar/archivar productos, recibir mercancía, editar lotes, ajustar existencias |
| Gestión | Proveedores, pedidos y su correo, administrar tareas, horarios, plano, estadísticas, clientes, recalcular gasto |
| Caja | Cobros y devoluciones, gastos/totales/edición de pagos, cierre/reapertura de caja |

Editar una ficha requiere catálogo; cambiar su precio o IVA exige también precios. Crear un
producto exige ambos, y dar de alta existencias requiere recibir mercancía. SQLite revalida el
precio bajo el cerrojo de escritura; una edición Handy sin permiso de precios conserva precio e IVA
en el SQL aplicado por el Worker, sin recrear el producto si se borró durante la edición. Ajustar existencias va por sus comandos con atribución, nunca
por la ficha. Las tareas propias se consultan y finalizan con el trabajador de la sesión.

Las notificaciones las puede ver cualquiera con sesión, pero cada uno las suyas: los ocho comandos
`notificaciones_*` sacan el usuario de la sesión, y la pantalla no lo manda. Lo que ve (las dirigidas
a todos, a él o a su rol), en nombre de quién marca leído y sobre qué actúa la papelera depende de
ese usuario (AUD-26). Marcar leída exige que vaya dirigida a él; descartar, además, que esté en el
centro, y restaurar o eliminar, que esté en la papelera. Esa condición va **dentro de la propia
sentencia que escribe** (`DIRIGIDA_AL_USUARIO`, igual en `tpv-infra-sqlite/src/notificaciones.rs` y en
`notificaciones.commands.ts`): no hay hueco entre comprobar y escribir (si otro restaura lo que uno
iba a borrar para siempre, no se borra), y se cumple también donde se aplique después. Si no se cumple,
`not_found` («Esa notificación no está en tu lista.») y nada en el outbox. En la Handy el usuario lo
pone Rust desde la sesión y viaja en el cuerpo; el Worker aplica la misma condición, pero no puede
saber que ese usuario es el de la sesión
([SEC-SESION](../pendientes.md#sec-sesion--sesión-personal-verificable-en-el-worker)).

Valores iniciales:

- **Administrador:** acceso completo. No se puede retirar su acceso ni modificarlo con el gestor.
- **Encargado:** servicio y gestión operativa, estadísticas y cobros; gastos y cierre de caja quedan
  desactivados inicialmente y se pueden conceder.
- **Camarero:** venta, cocina, reservas, tareas propias, clientes y cobros/devoluciones.
- **Cocinero:** cocina y tareas propias. **Limpieza:** tareas propias.

El catálogo sigue disponible para el servicio y el horario del equipo requiere sesión. Administrar
permisos, personal y PIN, configuración del negocio, fiscalidad, licencia y dispositivos exige
siempre el administrador vigente. La última cuenta administradora activa no se puede desactivar ni
despojar de su rol (RI-62); el chequeo vive dentro de la transacción local y también en el Worker.

El gestor está en **Configuración → Permisos**, sólo en Main. Guarda una edición por rol en una
transacción replicable y rechaza una lista desconocida o duplicada. Compara las concesiones que se
vieron al empezar a editar con las actuales: una pantalla antigua no pisa cambios recientes.
No existe una ruta REST para editar permisos y `applyViaHub` veta `Roles_Permisos` desde Handy.

La interfaz consulta `permisos_sesion` (`usePermisos`); rutas, menú, botones de inventario y gestión
usan esas capacidades. No se releen por reloj: se releen cuando pueden haber cambiado, que es al
llegar un cambio replicado de `usuarios`, `roles` o `roles_permisos` (`syncStatements.ts` invalida
`["permisos"]`), al guardar la pantalla de permisos, en una conexión nueva del socket de la Handy (que
lo invalida todo), al montar una pantalla que los usa y al volver a la aplicación. Quien decide es el
backend, en cada comando. Al cerrar sesión se limpia la caché de consultas para no mostrar a la
siguiente persona información de la sesión anterior.

Si una relectura falla (sin red, la Handy al recuperarla), la aplicación no se desmonta: sigue
pintando con los últimos permisos leídos, avisa una vez y la relectura se reintenta sola cada 15 s
hasta que contesta. La pantalla de error, con «Reintentar» y «Cerrar sesión», sólo sale si no se han
leído nunca (`shared/lib/permisos.ts::estadoPermisos`). **Un usuario desactivado con la sesión
abierta** no recibe «no tienes permiso», que lo dejaba sin salida: `usuario_inactivo` («Tu usuario ya
no está activo. Habla con un administrador.»), con el mismo texto en la Main (el repositorio SQLite) y
en el worker (`GET /v1/trabajadores/permisos/:id`), y la pantalla cierra la sesión y el login lo dice.

### Arranque y recuperación

No piden sesión los comandos de login, setup inicial, fichaje, recuperación del PIN y recuperación
de datos, ni las lecturas de arranque. La recuperación debe funcionar con `db == None` y cero
usuarios. Los guardianes del fuente vigilan estas exenciones. `complete_initial_setup` sólo puede
cambiar el PIN público mientras `Requiere_Setup = 1`, y sólo se ejecuta en Main.

### Proxy e identidad

El proxy firmado del IPC sólo admite las rutas exactas de emparejamiento y administración de
dispositivos. Claim/fetch/cancel admiten el modo anónimo; los tickets y los saludos WebSocket de
Main y Handy son internos de Rust. Las rutas de réplica Main no pasan por IPC. El saludo Handy usa `WS_HANDY_HELLO`, y el Worker
lo contrasta con el rol central del dispositivo: cambiar el modo local no concede una firma Main.
El JWT y la firma de mensajes arbitrarios no se exponen a JavaScript (RI-20/RI-57).

### Alcance de la autorización en Handy

El Worker autentica **al dispositivo**, con JWT y device-proof. Rust valida la sesión personal y
sus capacidades antes de llamar a los puertos HTTP. La consulta de concesiones del Worker devuelve
configuración; no demuestra una sesión personal. Esa ampliación está aplazada en
[SEC-SESION](../pendientes.md#sec-sesion--sesión-personal-verificable-en-el-worker).
Las restricciones centrales de dispositivo (cobrar/caja/fiscal sólo Main) siguen aplicándose.

### La autorización guardada en la Handy (PERM-CACHE)

Los permisos de una persona sólo se hacen cumplir en Rust (lo de arriba). En la Main cada gate lee su
SQLite. En la Handy cada gate era un viaje a la nube (`GET /v1/trabajadores/permisos/{id}`) delante
de cada acción, así que el `AppState` guarda la autorización de la sesión y los gates la usan
mientras vale (`tpv-application::use_cases::autorizacion_guardada`, `AppState::autorizacion`). Lo que
hace cumplir el Worker (licencia, dispositivo, lo que sólo hace la Main) no pasa por ahí ni cambia.

Lo guardado vale, y sólo entonces:

- **con el socket de avisos de la Handy conectado, y de esa conexión** (`socket_handy.rs` le dice al
  `AppState` cuál es en cada cambio de su estado). Conectando, reintentando o rechazado no se guarda
  nada y cada gate pregunta, como antes; al abrirse otra conexión, lo de la anterior no vale (mientras
  el socket estuvo caído pudo perderse un aviso). En la Main no hay socket de avisos: no guarda nunca;
- **de esta sesión**: entrar y salir lo tiran, y otra sesión de la misma persona no hereda nada;
- **hasta que llega un cambio de `usuarios`, `roles` o `roles_permisos`**, o uno sin clasificar. El
  aviso lo tira **antes** de que la pantalla se entere (`handy:cambio`), así que la relectura de
  `usePermisos` ya va a la nube. Lo que escribe la propia Handy no le vuelve como aviso: editar un
  trabajador (`trabajadores_update`) lo tira también;
- **como mucho `EDAD_MAXIMA_MS` (5 minutos)**, contados con el mayor de los dos relojes del equipo:
  ni suspenderlo ni atrasar la hora alargan lo guardado.

Sólo se guardan respuestas buenas (a un usuario desactivado se le pregunta cada vez). Una respuesta
que venía de camino cuando se tiró lo guardado ni se guarda ni se usa: el gate que la esperaba vuelve
a preguntar, y como la nube avisa después de aplicar el cambio, la pregunta siguiente ya lo ve (como
mucho tres preguntas por gate, si los avisos no paran).

**La ventana**: un permiso retirado en la Main deja de valer en la Handy cuando el cambio llega a la
nube y la nube se lo avisa por el socket, que va casi a la vez (con la Main sin conexión, la nube
tampoco lo sabe, como antes). Si el aviso no llega con el socket aparentemente abierto (un
socket muerto que el latido todavía no ha detectado, o un objeto que se reinicia entre aplicar y
difundir), lo guardado caduca a los 5 minutos. Ese plazo es más largo que lo que tarda el latido en
notar un socket muerto y reconectar (ping cada 30 s, cierre a los 65 s sin respuesta), para no
adelantarse a la reconexión, que ya lo tira; y más corto que el cierre de sesión por inactividad
(10 minutos). Sin cambios ni cortes, una Handy en uso pregunta doce veces por hora, en vez de una
por acción.

---

## El PIN

- **PBKDF2-HMAC-SHA256**, 100.000 iteraciones (el techo de `crypto.subtle` en Workers, y el worker
  también verifica), sal de 16 bytes, formato `$pbkdf2-sha256$i=…$<sal>$<derivada>` idéntico en Rust y
  en el worker. Verificación en tiempo constante con `subtle`, parámetros acotados (1–100.000 iteraciones, sal de 16 bytes y derivada de 32), cálculo fuera del ejecutor async y rehash al iniciar sesión.
- **Freno a la fuerza bruta (LOGIN-01)**: cinco intentos libres y, desde el sexto fallo, un bloqueo
  de 30 s, 1 min, 5 min y 15 min. Toda ruta del worker que verifique un PIN **reserva el intento
  antes de verificarlo** (`reservarIntento`, AUD-05): una sola sentencia que lo cuenta y, si toca,
  fija el bloqueo, y que no concede nada mientras haya uno en vigor. Sin reserva contesta 429 sin
  verificar: con un bloqueo en vigor no se verifica ningún PIN, y los fallos que llegan a la vez se
  cuentan uno a uno (de veinte PIN malos a la vez se verifican seis, como en serie). Acertar borra
  el recuento (`throttleReset`), salvo que haya en vigor un bloqueo que fijó otro intento: ése sólo
  lo quita el acierto del intento que lo puso y, si no, dura hasta que vence, así que un acierto
  cuyo borrado llega tarde no se lleva un bloqueo posterior. Todo con el reloj del worker, no con
  `X-Client-Now`. Lo vigilan `test/pinSiempreConFreno.test.ts`, leyendo el fuente, y
  `test/loginFrenoConcurrente.test.ts`. El recuento vive en `Intentos_Login`, que no se replica: el
  worker lleva el de las Handy en la base del negocio y la Main el suyo en la local
  (`tpv-infra-sqlite/src/auth.rs`). El hash se replica a la nube; el riesgo de romperlo offline está en
  [LOGIN-04](../pendientes.md#login-04--el-hash-del-pin-se-puede-romper-offline).
- **El PIN inicial se elige en la Main y sólo ahí.** `complete_initial_setup` cambia el PIN del
  administrador sin pedir el actual (es el del seed, público) y su único cerrojo es
  `Requiere_Setup = 1`, que se apaga al usarlo. La Main lo aplica en su SQLite y el `UPDATE`, con el
  hash y no el PIN, sube por el outbox como cualquier escritura. No hay otro camino hacia esa fila:
  ni un comando que lo suba aparte ni una ruta del worker que lo escriba directo en la base del
  negocio (AUD-24; lo vigilan `pinSiempreConFreno.test.ts` y `setupInicialPendiente.test.ts`). En Rust
  el puerto falla por defecto en la Handy. Ese `UPDATE` puede tardar en llegar (la Main sin red, o con
  la réplica apagada, con una Handy ya vinculada), y mientras tanto la nube conserva el PIN público de
  la siembra con `Requiere_Setup = 1`: el worker no deja entrar ni fichar en la Handy a un usuario así
  («Termina la configuración inicial en el TPV y vuelve a intentarlo.», `setup_inicial_pendiente`),
  antes de mirar el PIN y sin gastar intentos. La Main sigue sin bloquearse: sin red, su setup y su
  login son locales.

### Entrar sin PIN

`Usuarios.Sin_PIN = 1`: el login y el fichaje de ese usuario no comprueban el PIN,
y basta con tocar su nombre. Lo marca un administrador con «Entra sin PIN» en la ficha del trabajador.

- **Lo decide el backend**, no la pantalla: `comprobar_pin` en `tpv-infra-sqlite/src/login.rs` y
  `entraSinPin` en `login.routes.ts`. A ese usuario tampoco se le mira el freno de LOGIN-01, que
  sigue intacto para los demás: no hay secreto que adivinar, y un bloqueo anterior le dejaría fuera.
  `list_login_users` devuelve `sin_pin` para que la pantalla no le pida nada.
- **La cuenta conserva su PIN.** El alta pone uno al azar si no se escribe ninguno, y quitar la
  casilla en la edición exige escribir uno nuevo.
- **No se le niega a ningún rol.** Marcarlo en un administrador avisa en la ficha: cualquiera que toque
  su nombre pasa sus gates, y lo que se firma en una fila queda a su nombre.
- La edición sólo cambia `Sin_PIN` si llega (`COALESCE(?, Sin_PIN)`, igual en la Main y en el worker).

### Eliminar a un trabajador

«Eliminar» en Trabajadores (administrador, `trabajadores_eliminar`, `DELETE /v1/trabajadores/:id`)
pide confirmación diciendo qué pasa. **Lo que tiene historia no se borra**: su registro de jornada
(fichajes), cobros, anulaciones, comandas, movimientos de caja y de stock, cierres, aperturas del
cajón, lo que preparó en cocina, las tareas hechas y los turnos ya pasados. Con algo de eso se
**retira**: `Usuarios.Estado = 'Inactivo'` y `Archivado_En`, así que no entra ni ficha, sale de la
plantilla, del selector de entrada, de las tareas, de los horarios y de las estadísticas de la
plantilla, y lo firmado sigue a su nombre. Sin nada, se borra. En los dos casos se quitan sus turnos
de hoy en adelante, su horario predeterminado y sus tareas pendientes.

- Una tanda de sentencias que deciden cada una por su cuenta, igual en la Main
  (`sql_quitar_trabajador`, dentro del `WriteGuard`) y en el worker (`SQL_QUITAR_TRABAJADOR`), como
  la de un producto: quien las aplica después vuelve a decidir con sus datos. Lo contrastan
  `tests/contract/casos/trabajadores/`.
- No deja el negocio sin administrador activo (RI-62, `ultimo_administrador`) y nadie se elimina a sí
  mismo («No puedes eliminar tu propia ficha. Pídeselo a otro administrador.», en el caso de uso, con
  el usuario de la sesión). En el worker, que la ficha siga en la plantilla y lo del administrador
  son guardas del lote (SYNC-30).
- Uno retirado no se edita (volver a ponerlo «Activo» lo devolvería al login) ni se recupera desde
  la aplicación. Conserva su correo y su DNI, que son únicos: a quien puede volver se le desactiva
  desde «Editar» en vez de eliminarlo, y el modal lo dice.

### Recuperar el PIN

| Pieza | Archivo |
|---|---|
| Reglas del código por correo | `apps/cloud-worker-licensing/src/domains/login/codigosPorCorreo.ts` |
| Recuperar el PIN | `…/login/recuperarPin.ts` · `tpv-application/src/use_cases/recuperacion_pin.rs` · `commands/recuperacion_pin.rs` |
| El correo de recuperación | `…/login/correoRecuperacion.ts` · `use_cases/correo_recuperacion.rs` · `commands/correo_recuperacion.rs` |
| En la base central | `email_codes`, `tenant_recovery_emails` (sin fila = el de la compra) |
| Pantallas | `features/login/RecuperarPinModal.tsx`, `features/configuracion/sections/CorreoRecuperacion.tsx`, `features/login/ConfirmarCorreoRecuperacion.tsx` |

- Un **código** que llega al correo y se escribe en el TPV, nunca un enlace (los filtros de correo
  abren los enlaces y gastarían uno de un solo uso). Hacen falta el buzón y la Main a la vez, porque la
  petición va firmada con la clave del equipo.
- **Sólo administradores**, y el `UPDATE` filtra por rol. A los demás se lo cambia un administrador
  desde Trabajadores.
- Verificar el código y guardar el PIN son **un** comando; el PIN no sale del equipo (sube por el
  outbox).
- Va al **correo de recuperación**, que es el de la compra (`licenses.customer_email`) hasta que se
  cambie. En la pantalla del PIN inicial se puede elegir otro; se confirma con un código antes de
  guardar el PIN o se salta, y mientras no se confirme manda el de la compra. Cambiarlo después exige un código enviado al
  correo **nuevo** y avisa al anterior y al de la compra; volver al de la compra no pide código.
- **Cinco minutos entre códigos** (`REENVIO_MIN_MS`), con la cuenta atrás en pantalla.
- El **traslado de la licencia** va siempre al correo de la compra ([licencias.md](licencias.md)).
- RI-60: el correo comercial vive en `Contact_Settings.Contact_Email`; la recuperación usa la base
  central. No hay un segundo campo de recuperación en el esquema del negocio.
- Sin internet no hay recuperación por correo: la salida es otro administrador.

---

## La superficie de la aplicación de escritorio

- **CSP cerrada** (`tauri.conf.json`, `app.security`): `script-src 'self'`; `connect-src` sólo el IPC
  en producción; `img-src` lo local y el bucket de imágenes de la Handy; `style-src
  'self'`; `object-src` y `frame-src` `'none'`. Un origen nuevo va en `csp` **y** en `devCsp`. Nada de
  `<style>` inyectado en tiempo de ejecución ni librerías que se autoinyecten CSS; la CSP sólo se aplica
  al build empaquetado y en Android, no en `pnpm tauri dev` de escritorio. Detalle y cómo comprobarlo
  en [frontend.md](frontend.md#csp).
- **La ventana no navega fuera de la aplicación** (AUD-25, `src-tauri/src/navegacion.rs`). No tiene
  marco ni barra de direcciones: otra web cargada en ella ocuparía el TPV entero, y la CSP no regula
  la navegación de nivel superior (un `<meta http-equiv=refresh>`, un enlace). Un plugin con
  `on_navigation` sólo admite los orígenes desde los que Tauri sirve la app: `http://tauri.localhost`
  y `https://tauri.localhost` (Windows y Android) y, sólo en un build de desarrollo, el servidor de
  Vite (`build.devUrl`). Cualquier otro destino (otra web, otro puerto del equipo, `data:`,
  `about:blank`) se cancela y deja un aviso en el registro con su origen. Lo decide `es_de_la_app`,
  con sus tests. Es una segunda capa, no la garantía de interceptar cualquier navegación:
  - cubre el marco principal: en Windows, lo que WebView2 anuncia con `NavigationStarting`; en
    Android, lo que la WebView pasa por `shouldOverrideUrlLoading`;
  - los iframes no pasan por ella: los para la CSP (`frame-src 'none'`);
  - la carga inicial no depende de ella: la hace Tauri con la dirección de la app, que sólo
    consulta a los plugins cuando la webview ya está registrada, y Android no la pasa por
    `shouldOverrideUrlLoading`;
  - una dirección que Tauri no sepa interpretar no llega al plugin: Tauri la deja pasar.

  La app no tiene enlaces externos ni ventanas secundarias; un enlace que haya que abrir va al
  navegador del sistema, nunca a la webview. Lo que impide que llegue marcado a la página es la
  primera capa: [frontend.md](frontend.md#gráficas).
- **La webview no lee AppData mediante el plugin `fs` ni escribe sobre los ficheros del equipo.** `fs:allow-write-file` existe para guardar
  donde la persona elija (el diálogo autoriza la ruta), con un `deny` para `data.db`, el estado de
  licencia, las copias y el resto de ficheros propios de AppData. Un fichero propio nuevo va a ese
  `deny`; lo vigila `la_webview_no_puede_escribir_sobre_los_ficheros_del_equipo`, que además rechaza
  cualquier `fs:allow-write*` sin ámbito.
- **Lo registrado es lo invocable.** Un comando que nadie llama no se registra en el
  `generate_handler!`. `scripts/check-comandos-tauri.mjs` comprueba en CI que todo lo que el frontend y
  el E2E invocan por nombre existe; `los_comandos_retirados_no_vuelven_por_la_puerta_de_atras` vigila
  que no vuelvan `tpv_server_signed_headers` (firmaba cualquier petición sin gate) ni
  `cobrar_venta_rapida` (un segundo camino de cobro no idempotente).
- **Secretos fuera de la base**: `device_id`, clave ed25519, token de la Handy y DEK en el keyring o en
  Android Keystore. El build de E2E (identificador `….e2e`) los guarda con otro nombre
  (`lib.rs::espacio_de_secretos`, `secret_store::apartar_secretos`), para no compartir identidad con la
  app de trabajo del mismo equipo. Los de producción no cambian de nombre nunca.
- **PII del personal cifrada** (`DNI`, `IBAN`, `Numero_Seguridad_Social`): AES-256-GCM determinista
  (para que el `UNIQUE` siga funcionando) en `tpv-infra-sqlite::trabajadores`, antes de construir la
  sentencia, así que el outbox replica el texto cifrado (`tpv-infra-licensing/src/field_crypto.rs`).
  La Handy no tiene la clave: el worker ni escribe ni devuelve esas columnas. La DEK la genera el
  worker y vive también en la base central cifrada con `LICENSE_STORE_KEY`: el proveedor tiene el texto
  cifrado y la clave, y eso cuenta para el RGPD ([LEGAL-01](../pendientes.md#legal-01--rgpd)). Volver
  de una avería devuelve la PII cifrada y la DEK.
- **Los errores salen sin datos personales** ([observabilidad.md](observabilidad.md)).

## La superficie del worker

- **SQL siempre parametrizado.** Lo único interpolado son nombres de tabla o columna de listas
  cerradas o placeholders `?N` generados.
- **Tenant y dispositivo salen del token**, nunca del cuerpo: imágenes (prefijo por tenant y
  `RUTA_DE_IMAGEN`, que sólo admite una carpeta de la lista y un UUID con su extensión), telemetría,
  sincronización y negocio.
- **JWT** verificado con `jose` y `algorithms: ["HS256"]` (`lib/sesion.ts`).
- **WebSocket** abierto con un ticket de un solo uso, consumido con `DELETE … RETURNING`: el token no
  viaja en la URL.
- **CORS** con lista fija de orígenes (`http://localhost:1420`, `tauri://localhost`,
  `http://tauri.localhost`), en `server/utils/response.ts`; no se usa `hono/cors`.
- **Rutas de administración fail-closed**: sin `ADMIN_API_TOKEN` o `RELEASE_ADMIN_TOKEN`, 503.
  Comparación de tiempo constante en tokens, códigos y firmas.
- **Webhook de Stripe**: firma sobre el cuerpo crudo, ventana de 5 min e idempotencia
  ([licencias.md](licencias.md#comprar)).
- **Device-proof**: firma con dominio `DEVICE_PROOF` de `ts`, método, ruta **y query**, hash del token y hash del cuerpo, con ±2 minutos.
  Sin nonce ([FABLE-E](../pendientes.md#fable-e--sin-nonce-en-el-device-proof)). Activar una licencia,
  que es anónima, lleva esa misma firma con el tramo del token vacío, comprobada con la clave pública
  que presenta la petición ([licencias.md](licencias.md#activar)). Una `X-Device-Sig` de más de 128
  caracteres (una firma son 88) se rechaza con `bad_device_signature` antes de mirarla y de leer la
  base (AUD-33, [worker.md](worker.md#cómo-se-escribe-una-ruta)).
- **El correo se acota por destinatario y por volumen**: sólo al email de un proveedor dado de alta y
  con un tope diario por negocio ([worker.md](worker.md#correo)).
- **Los errores no cuentan cómo está hecho el worker**: un 500 no lleva traza ni texto de la base
  ([worker.md](worker.md#errores)).
- Dependencias: `.github/workflows/audit.yml` (`cargo audit` y `pnpm audit --prod`, en cada PR y los
  lunes) y Dependabot. Un aviso no es un fallo explotable: hay que mirar si el camino vulnerable se usa.
