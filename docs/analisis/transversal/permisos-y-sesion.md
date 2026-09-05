# T7 — Permisos, sesión y modelo de amenaza de los gates que corren en cliente

> **Ámbito.** Quién puede hacer qué dentro de la app, y hasta dónde llega esa garantía.
> Cubre el gate por rol de los comandos Tauri (**SEC-01**) y el modelo de amenaza del gate de
> licencia (**LIC-04**), que son el mismo problema visto dos veces: una comprobación que se
> ejecuta en la máquina del usuario.
> **Capas:** `apps/tpv-main/src-tauri/src/lib.rs` (`AppState::sesion` y los helpers),
> `apps/tpv-main/src-tauri/src/commands/*`, `apps/tpv-main/src/shared/lib/permisos.ts`,
> `apps/tpv-main/src/app/App.tsx`.

---

## 1. Qué garantiza esto, y qué no

Conviene decirlo antes que nada, porque lo contrario —dejar que se suponga una garantía que no
existe— es peor que no tener el gate.

**En una app de escritorio, quien tiene la máquina puede saltarse cualquier comprobación que corra
en ella.** Abrir las DevTools e invocar comandos por el IPC, parchear el binario, editar la BD con
un cliente SQLite. Ni la sesión del backend ni el gate de licencia son fronteras criptográficas, y
no hay forma de que lo sean mientras el código se ejecute en el equipo del cliente.

Lo que sí consigue tener la sesión en el backend:

- Para pasar el gate hay que **iniciar sesión de verdad**, con el PIN de alguien autorizado.
- El usuario que queda registrado en una fila (quién cerró la caja, quién abrió el cajón) es un
  dato **que ha establecido el backend**, no uno que le han contado. Sin esto, cualquier auditoría
  registra el nombre que le pasen, y una auditoría que da confianza sin merecerla es peor que no
  tener ninguna.
- Cierra el hueco entre «la interfaz esconde el botón» y «el botón no hace nada».

**El riesgo real que cubre es un camarero con el TPV delante**, no un atacante con conocimientos.
Para ese riesgo, esto es suficiente; para el otro no hay nada que hacer del lado del cliente, y
por eso lo que de verdad importa —cobrar, replicar, revocar un dispositivo— lo valida además el
worker, que sí corre donde el usuario no manda.

### El mismo argumento vale para la licencia (LIC-04)

El gate de licencia (`license_gate`) decide si la app arranca, y decide **en el cliente**. Un
bypass local siempre es posible en última instancia. Lo que se ha hecho es reducir lo que hace
falta para llegar a él:

- El estado de licencia **lo firma el servidor** y se verifica contra una clave pública **pineada
  en el binario**, así que un proxy local con CA propia no puede falsificar `allowed = true`.
- Los secretos (device-id, clave ed25519, token del Handy) viven fuera de la BD, en el keyring del
  SO o en Android Keystore.
- La sincronización no se fía del gate local: `/v1/ws/ticket` vuelve a comprobar la licencia en el
  worker antes de dejar abrir el WebSocket.

Queda, y se asume: **quien parchee el binario usa la app sin licencia.** No es un descuido, es el
techo de un producto que se instala en casa del cliente. La barrera está puesta a la altura del
uso casual —copiar el `.exe` a otro equipo, cambiar la fecha del sistema—, que es de lo que se
trata.

---

## 2. Dónde vive la sesión

`AppState::sesion` — un `Option<Sesion>` en memoria, sin persistir.

| Momento | Qué pasa |
|---|---|
| Arranque | `None`. Al abrir la app siempre se pide PIN: no hay sesión persistente que restaurar |
| `login_user` OK | Se establece, con el `id_usuario`, `id_trabajador` y `rol` **que devuelve el repositorio** |
| Comando `logout` | Se limpia |
| Cierre por inactividad | El frontend llama a `logout` (pasa por `useAuth.logout()`) |
| Arranque del webview | `AppBoot` llama a `logout`, por si un F5 dejó una sesión colgada |

Ese último punto no es cosmético. Las dos sesiones —la del store de Zustand y la del backend— no
mueren juntas: al recargar el webview, el store se vacía solo y la UI vuelve al login, pero
`AppState::sesion` seguiría puesta. Quedaría **una sesión de administrador viva detrás de una
pantalla que pide PIN**.

El rol sale del repositorio (SQLite en la Main, worker en la Handy) y **nunca de los argumentos**
del comando: quien puede invocar un comando puede escribir lo que quiera en sus args, así que un
rol que llega por ahí no es una comprobación, es una sugerencia.

### Los tres helpers

| Helper | Cuándo | Qué hace |
|---|---|---|
| `sesion()` | Escribe algo **atribuible** que hace cualquiera | Exige estar identificado, da igual el rol |
| `exigir_rol(&[...])` | Lo que es de administrador | Exige sesión **y** rol |
| `exigir_rol_si_hay_sesion(&[...])` | Comandos que se alcanzan **antes** del login | Sin sesión deja pasar; con sesión exige el rol |

El tercero merece explicación, porque parece un agujero y no lo es. `device_reset_mode` se alcanza
desde dos sitios: Configuración → Dispositivo (con la app abierta) y el botón «volver al selector
de modo» de las pantallas de arranque, que se pintan **en lugar** del router. En el segundo no hay
con quién iniciar sesión — es un equipo que aún no tiene licencia o aún no ha elegido modo—, así
que un gate duro dejaría una instalación nueva sin poder arrancar jamás. El gate blando cierra el
primer camino sin tocar el segundo.

---

## 3. Qué está gateado

**La lista es corta a propósito.** Gatear «añadir una línea a la comanda» convierte el TPV en
inservible en hora punta, y un gate que estorba se acaba resolviendo con que todo el mundo conozca
el PIN del encargado — que es exactamente el permiso que se quería quitar.

### Exigen Administrador

| Área | Comandos |
|---|---|
| Cuentas (sección entera, lecturas incluidas) | `cuentas_get_entradas` · `cuentas_get_salidas` · `cuentas_get_resumen` · `cuentas_create_gasto` · `cuentas_update_gasto` · `cuentas_delete_gasto` · `cuentas_update_pago` · `cuentas_delete_pago` · `cuentas_ticket_para_reimprimir` |
| Cierre de caja | `cierre_preparar` · `cierre_confirmar` · `cierre_listar` · `cierre_detalle` · `cierre_reabrir` |
| Personal | `trabajadores_create` · `trabajadores_update` · `trabajadores_get_detail` |
| Configuración | `config_patch_business_settings` · `config_patch_ticket_settings` · `config_patch_contact_settings` |
| Proveedores | `email_enviar_pedido` |
| Dispositivos | `pair_create` · `tpv_server_post_json` para `/v1/pair/…` y `/v1/device/…` |
| Modo | `device_reset_mode` (blando: sólo si hay sesión) |

Dos entradas piden justificación:

- **Las lecturas de Cuentas.** No es ampliar el gate por gusto: [PLAN_CIERRE_CAJA.md](../../PLAN_CIERRE_CAJA.md)
  §8 ya decidió que el candado fuera «en la ruta del frontend y, sobre todo, en los comandos
  Tauri», y hasta SEC-01 existía sólo la mitad de UI. El libro de caja dice cuánto se factura y
  cuánto se gasta; esconderlo del menú no es esconderlo.
- **`trabajadores_get_detail`.** Es la única lectura gateada fuera de Cuentas, y entra porque es la
  única que devuelve la PII cifrada del personal (DNI, IBAN, nº de Seguridad Social — ver TRAB-03).
  El listado, los turnos y los horarios **no** se gatean: todos los roles tienen Trabajadores en su
  menú para consultar su cuadrante.

### Basta con estar identificado

`printer_open_drawer`. Abrir el cajón para dar cambio es algo que el camarero necesita hacer, así
que no se pide rol; lo que sí se hace es dejarlo anotado en `Aperturas_Cajon` con **quien haya
iniciado sesión**, porque una apertura sin venta detrás es la única por la que alguien pregunta
cuando falta dinero.

### Exentos, y por qué

| Grupo | Por qué |
|---|---|
| `login_user`, `list_login_users`, `setup_pendiente`, `hash_password`, `logout` | Son el propio login: exigir sesión sería circular |
| `complete_initial_setup` | Corre en el primer arranque, cuando no hay con qué iniciar sesión |
| `punch` y fichajes | Se fichan **antes** de tener sesión de aplicación |
| `license_activate`, `license_clear_state`, `set_device_mode` | Sólo se alcanzan desde pantallas que se pintan en lugar del router: no hay login que superar |
| Lecturas de arranque (modo, licencia, config, estado de sync) | Las llaman `AppBoot` y los stores antes del login |
| **Todo `commands/recovery.rs`** | ⚠️ Ver abajo |

> ⚠️ **Los comandos de recuperación NO pueden exigir sesión, nunca.** Esa pantalla existe
> precisamente para el caso de **cero usuarios**: un equipo que ha perdido su `data.db` no tiene
> con quién iniciar sesión. Ponerles el gate cierra la única salida que les queda — el callejón
> sin salida que documenta [BUG_RECUPERACION_BLOQUEADA.md](../../BUG_RECUPERACION_BLOQUEADA.md) —
> y lo hace **en silencio**, porque en un equipo sano no se nota.
>
> Es la hermana exacta de la regla que ya estaba escrita: *«todo lo que hay en ese camino tiene que
> tolerar `state.db == None`»*. Añádele: **y tiene que tolerar `sesion == None`**.
>
> Lo vigila un test (`tests_exenciones_del_gate`) que lee el propio fuente de `recovery.rs`. No se
> puede probar ejecutando los comandos —haría falta una app de Tauri entera— y, sobre todo, el
> fallo que hay que impedir no es que devuelvan mal: es que alguien les añada un gate el día que
> amplíe la lista mirando el fichero de al lado.

### El gate del proxy genérico

`tpv_server_post_json` es un transporte, no un comando de negocio: firma lo que le den y lo manda.
Por él viajan a la vez el emparejamiento de un Handy —que ocurre antes de que nadie inicie
sesión— y la administración de dispositivos de Configuración. Por eso la regla va **por ruta y
fallando cerrado**: todo `/v1/pair/…` y `/v1/device/…` exige Administrador, salvo los dos pasos
que da el Handy al emparejarse (`/v1/pair/claim`, `/v1/pair/fetch-token`).

Es un **prefijo y no una lista blanca** a propósito: una ruta de administración que se añada mañana
queda cubierta sola, que es justo lo contrario de lo que hace una lista de rutas exactas.

---

## 4. La UI sigue escondiendo lo que no toca

El gate del backend es **la red, no el sustituto** de una interfaz que no ofrece lo que no
corresponde. Las dos capas siguen:

- La NavBar no enseña al camarero lo que no es suyo.
- Las rutas de administrador (`/cuentas`, `/configuracion`, las fichas de trabajador) rebotan a
  quien no lo es. No es seguridad —se puede invocar el comando sin pasar por la pantalla— sino
  cortesía: sin ellas, quien escriba la URL ve una pantalla entera rota a base de «permiso
  denegado» en vez de un «esto no es tuyo».
- El nombre del rol vive en un sitio por lado: `ADMIN` en `lib.rs` y `ROL_ADMIN` en
  `shared/lib/permisos.ts`. Estaba escrito a mano en cinco pantallas, que es como la NavBar, la
  ruta y el backend podían discrepar sin que nadie se enterase.

Cuando un comando rechaza, el frontend ramifica por el código `permiso_denegado` (nunca por el
texto: ARCH-05) para poder decir «esto es de administrador» en vez de «no se pudieron cargar los
datos», que es el mensaje que hace que alguien reintente diez veces algo que nunca va a funcionar.

---

## 5. Lo que queda fuera, a sabiendas

- **Tabla de permisos.** `Roles` sólo tiene `ID_Rol` y `Nombre_Rol`, y con cuatro roles comparar
  por nombre basta. Un sistema granular ahora es sobreingeniería.
- **Sesión persistente entre reinicios.** Al arrancar se pide PIN, y está bien así.
- **Caducidad de sesión en el backend.** El cierre por inactividad del frontend ya la limpia. Un
  segundo temporizador en Rust sería otra política que mantener sincronizada con la primera.
- **El worker no sabe qué persona está usando una Handy.** Autentica por **dispositivo**
  (device-proof + JWT), no por usuario. El filtro por rol en modo Handy es del cliente, igual que
  antes; lo que el worker sí sostiene es qué **dispositivo** puede escribir qué (`cobro_solo_en_main`,
  `soloLaMainEscribeCaja`). Cerrarlo del todo pediría que el token llevara el usuario de la sesión,
  y eso es otro trabajo.
- **El resto de escrituras de negocio no está gateado** (comandas, inventario, reservas, clientes,
  tareas, proveedores). Es deliberado: son el trabajo del turno, y ponerles fricción es lo que
  acaba en un PIN compartido.
