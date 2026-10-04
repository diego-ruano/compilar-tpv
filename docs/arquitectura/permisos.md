# Permisos, sesión y seguridad

Quién puede hacer qué dentro del TPV, cómo se protege lo que sale del equipo, y hasta dónde llega la
garantía.

## Qué garantiza esto, y qué no

**Quien tiene la máquina puede saltarse cualquier comprobación que corra en ella**: invocar comandos
por el IPC, parchear el binario, abrir `data.db` con un cliente SQLite. Ni la sesión del backend ni el
gate de licencia son fronteras criptográficas.

Lo que sí consiguen:

- Para pasar un gate hay que iniciar sesión con el PIN de alguien autorizado.
- El usuario que queda **firmado en una fila** (quién cobró, cerró la caja, anuló, abrió el cajón) lo
  pone el backend, no la pantalla.
- Entre «la interfaz esconde el botón» y «el botón no hace nada» no queda hueco.

El riesgo que cubre es **un camarero con el TPV delante**. Lo que de verdad importa —cobrar, la caja,
el registro fiscal, revocar un dispositivo, la licencia— lo valida además el worker, que corre donde
el usuario no manda. Y la licencia va firmada ([licencias.md](licencias.md)): un parche del binario la
salta, un ataque de red no.

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| La sesión | `apps/tpv-main/src-tauri/src/lib.rs` (`Sesion`, `AppState::sesion`) | `Option<Sesion>` en memoria: `id_usuario`, `id_trabajador`, `rol` |
| Los gates | `lib.rs` (`sesion`, `exigir_rol`, `exigir_rol_si_hay_sesion`) | Tres helpers |
| El rol | `lib.rs::ADMIN` · `src/shared/lib/permisos.ts::ROL_ADMIN` | Uno por lado |
| Código de error | `tpv-contracts::errors::ErrorCode::PermisoDenegado` (`permiso_denegado`) | La UI ramifica por él |
| Cierre de sesión | `src/shared/stores/useAuth.ts`, `src/app/AppBoot.tsx`, `src/shared/lib/useInactivityLogout.ts` | Las dos sesiones se cierran juntas |
| El guardián | `lib.rs::tests_exenciones_del_gate` | Lee el fuente y vigila las reglas de abajo |

## La sesión

| Momento | Qué pasa |
|---|---|
| Arranque | `None`: al abrir la app siempre se pide PIN |
| `login_user` correcto | Se pone, con el rol **que devuelve el repositorio** (SQLite en la Main, worker en la Handy) |
| `logout` | Se quita |
| 10 minutos sin tocar nada | El frontend cierra sesión (`useInactivityLogout`) |
| Recarga del webview | `AppBoot` llama a `logout`, para no dejar una sesión de administrador viva detrás de una pantalla de PIN |

El rol y el usuario salen del repositorio y **nunca de los argumentos** de un comando.

| Helper | Para qué |
|---|---|
| `sesion()` | Algo atribuible que hace cualquiera: exige estar identificado |
| `exigir_rol(&[ADMIN])` | Lo de administrador: sesión y rol |
| `exigir_rol_si_hay_sesion(&[ADMIN])` | Lo que se alcanza también **antes** del login: sin sesión pasa, con sesión exige el rol |

---

## Qué está gateado

**La lista es corta a propósito.** Antes de gatear algo la pregunta no es «¿es delicado?» sino «¿lo
hace alguien a mitad de servicio?». Un gate que estorba acaba en que todo el mundo conoce el PIN del
encargado.

### Administrador

| Área | Comandos |
|---|---|
| Cuentas, lecturas incluidas | `cuentas_get_entradas`, `cuentas_get_salidas`, `cuentas_get_resumen`, `cuentas_previsualizar_cambio`, `cuentas_create_gasto`, `cuentas_update_gasto`, `cuentas_delete_gasto`, `cuentas_update_pago`, `cuentas_anular_pago` |
| Cierre de caja | `cierre_preparar`, `cierre_confirmar`, `cierre_listar`, `cierre_detalle`, `cierre_reabrir` |
| Veri\*factu | `verifactu_listar`, `verifactu_certificados`, `verifactu_set_certificado`, `verifactu_probar_conexion`, `verifactu_emitir_factura_de_ticket`, `verifactu_subsanar_rechazados`, `verifactu_reconocer_anomalias`, `verifactu_exportar`, `verifactu_set_modo_prueba` |
| Personal | `trabajadores_create`, `trabajadores_update`, `trabajadores_get_detail` (la única lectura de personal gateada: devuelve la PII) |
| Configuración | `config_patch_business_settings`, `config_patch_ticket_settings`, `config_patch_contact_settings` |
| Correo de recuperación | `correo_recuperacion_estado`, `correo_recuperacion_usar_el_de_la_compra`; y `…_solicitar` / `…_confirmar`, que sin sesión sólo valen mientras el PIN inicial esté por elegir |
| Proveedores | `email_enviar_pedido` |
| Licencia | `license_sumar_clave` (gastar una clave pagada desde Configuración; el resto de `license_*` es del arranque y no pide sesión) |
| Dispositivos | `pair_create`, y `tpv_server_post_json` para `/v1/pair/…`, `/v1/device/…` y `/v1/login/correo-recuperacion/…` |
| Modo | `device_reset_mode` (gate blando) |

`verifactu_estado` y `verifactu_declaracion_responsable` no piden rol: los leen la escalera de avisos
y cualquiera que quiera ver la declaración.

**Siempre queda un administrador activo.** Editar una ficha no puede quitarle el rol ni desactivar
al último (RI-62): sin ninguno, todo lo de esta tabla queda cerrado y no hay salida desde la
aplicación, porque la recuperación del PIN por correo es para un administrador. La Main lo comprueba
dentro de la transacción de `update_trabajador`. El worker lo comprueba antes de aplicar
(`ultimo_administrador`), con el mismo SQL.

### Basta con estar identificado

- **Cobrar**: `cobrar_detalles` (mesas) y `vr_cobrar_fraccionado` (venta rápida). El cobrador se
  guarda con el pago y es el rastro de un descuadre, así que sale de la sesión; un administrador que
  cobra queda registrado como él mismo. `VrCobrarFraccionadoInput` y
  `MesasCobrarDetallesInput` no llevan cobrador. Lo vigila
  `todo_comando_que_cobra_saca_el_cobrador_de_la_sesion`.
- **El ticket de un cobro**: `printer_ticket_de_pago` y `printer_imprimir_pago`. Lo imprime quien
  acaba de cobrar, a mitad de servicio; la reimpresión de un cobro antiguo está detrás del candado de
  Cuentas.
- **Abrir el cajón**: `printer_open_drawer`. Se anota en `Aperturas_Cajon` con quien tenga la sesión.
- **Estadísticas y clientes**: todos los `stats_*` y `clientes_*`. Las estadísticas dicen cuánto se
  factura y cuánto vende cada trabajador, y los clientes son datos personales. Toda pantalla de la app
  está detrás del login, así que no estorba a nadie: cierra la puerta a quien llegue sin PIN.

### Exentos, y por qué

| Comandos | Por qué |
|---|---|
| `login_user`, `list_login_users`, `setup_pendiente`, `logout` | Son el login |
| `complete_initial_setup` | Antes del primer login no hay con quién iniciar sesión (ver abajo) |
| `punch` y fichajes | Se ficha antes de tener sesión |
| `license_*` (salvo `license_sumar_clave`), `set_device_mode` | Las pantallas de arranque se pintan **en lugar** del router |
| Lecturas de arranque (modo, licencia, configuración, sincronización) | Las piden `AppBoot` y los stores antes del login |
| **Todo `commands/recovery.rs`** | ⚠️ La pantalla de recuperación existe para el caso de **cero usuarios**: un gate le cerraría la única salida, y en un equipo sano no se notaría. Tiene que tolerar `state.db == None` **y** `sesion == None` |
| `login_recuperar_pin_solicitar` / `…_confirmar` | Quien recupera el PIN es quien no puede iniciar sesión |

`los_comandos_de_recuperacion_no_pueden_exigir_sesion` y
`el_login_no_puede_exigir_lo_que_todavia_no_existe` leen el fuente y fallan si alguien añade un gate
ahí.

### El proxy firmado

`tpv_server_post_json` firma y manda lo que le den. Por él van el emparejamiento de una Handy (sin
sesión) y la administración de dispositivos. La regla va **por prefijo y fallando cerrado**
(`commands/pairing.rs::ruta_de_administracion`, normalizando la ruta antes): todo `/v1/pair/…`,
`/v1/device/…` y `/v1/login/correo-recuperacion/…` exige Administrador, salvo
`/v1/pair/claim`, `/v1/pair/fetch-token` y `/v1/pair/cancel` (`PAIRING_SIN_SESION`). Una ruta anónima
nueva del emparejamiento hay que añadirla también ahí.

### Lo que no está gateado

Comandas, inventario, reservas, tareas, proveedores, turnos y horarios: es el trabajo del turno. Tampoco hay tabla de permisos (`Roles` sólo tiene nombre e id), sesión persistente ni caducidad
de sesión en el backend.

### La interfaz

El gate del backend es la red, no el sustituto: la NavBar no enseña lo que no toca y las rutas de
administrador (`/cuentas`, `/configuracion`, las fichas de trabajador) rebotan a quien no lo es. Al
gatear un comando nuevo, su pantalla necesita también el candado de ruta. Ante un rechazo, el frontend
ramifica por `permiso_denegado` para decir «esto es de administrador».

### La Handy

El worker autentica por **dispositivo** (device-proof + JWT), no por persona: el filtro por rol
dentro de la Handy es de la aplicación. Lo que el worker sí sostiene es qué dispositivo puede escribir
qué: cobrar, la caja y el registro fiscal sólo la Main (`cobro_solo_en_main`,
`soloLaMainEscribeCaja`, `TABLAS_SOLO_MAIN`), con el veto como middleware delante de leer el cuerpo
([worker.md](worker.md)).

---

## El PIN

- **PBKDF2-HMAC-SHA256**, 100.000 iteraciones (el techo de `crypto.subtle` en Workers, y el worker
  también verifica), sal de 16 bytes, formato `$pbkdf2-sha256$i=…$<sal>$<derivada>` idéntico en Rust y
  en el worker. Verificación en tiempo constante y rehash al iniciar sesión.
- **Freno a la fuerza bruta (LOGIN-01)**: bloqueo escalado tras los fallos. Toda ruta del worker que
  verifique un PIN mira el freno antes y cuenta el fallo después; lo vigila
  `test/pinSiempreConFreno.test.ts`. El hash se replica a Turso; el riesgo de romperlo offline está en
  [LOGIN-04](../pendientes.md#login-04--el-hash-del-pin-se-puede-romper-offline).
- **El PIN inicial se elige en la Main y sólo ahí.** `complete_initial_setup` cambia PIN y correo del
  administrador sin pedir el actual (es el del seed, público) y su único cerrojo es
  `Requiere_Setup = 1`, que se apaga al usarlo. El worker no tiene un segundo camino hacia esa fila:
  la Main lo aplica en su SQLite y lo sube por `POST /v1/login/sync-initial-setup` (firmada, rol TPV),
  directa a Turso porque aún no hay WebSocket. En Rust el puerto falla por defecto en la Handy, y una
  Main con el setup pendiente no sale de `/setup`, así que no puede haber Handys vinculadas todavía.

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
  cambie. Al activar se puede elegir otro; se confirma con un código en la pantalla del PIN inicial o se
  salta, y mientras no se confirme manda el de la compra. Cambiarlo después exige un código enviado al
  correo **nuevo** y avisa al anterior y al de la compra; volver al de la compra no pide código.
- **Cinco minutos entre códigos** (`REENVIO_MIN_MS`), con la cuenta atrás en pantalla.
- El **traslado de la licencia** va siempre al correo de la compra ([licencias.md](licencias.md)).
- `Contact_Settings.Recovery_Email` sigue en el esquema y no lo usa nada.
- Sin internet no hay recuperación por correo: la salida es otro administrador.

---

## La superficie de la aplicación de escritorio

- **CSP cerrada** (`tauri.conf.json`, `app.security`): `script-src 'self'`; `connect-src` sólo el IPC
  y el WebSocket de `tpv-api`; `img-src` lo local y el bucket de imágenes de la Handy; `style-src
  'self'`; `object-src` y `frame-src` `'none'`. Un origen nuevo va en `csp` **y** en `devCsp`. Nada de
  `<style>` inyectado en tiempo de ejecución ni librerías que se autoinyecten CSS; la CSP sólo se aplica
  al build empaquetado y en Android, no en `pnpm tauri dev` de escritorio. Detalle y cómo comprobarlo
  en [frontend.md](frontend.md#csp).
- **La webview no escribe sobre los ficheros del equipo.** `fs:allow-write-file` existe para guardar
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
  Android Keystore. El certificado de la AEAT no se guarda: sólo su huella.
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
  `REL_PATH_RE` contra rutas con `..`), telemetría, sincronización y negocio.
- **JWT** verificado con `jose` y `algorithms: ["HS256"]` (`lib/sesion.ts`).
- **WebSocket** abierto con un ticket de un solo uso, consumido con `DELETE … RETURNING`: el token no
  viaja en la URL.
- **CORS** con lista fija de orígenes (`http://localhost:1420`, `tauri://localhost`,
  `http://tauri.localhost`), en `server/utils/response.ts`; no se usa `hono/cors`.
- **Rutas de administración fail-closed**: sin `ADMIN_API_TOKEN` o `RELEASE_ADMIN_TOKEN`, 503.
  Comparación de tiempo constante en tokens, códigos y firmas.
- **Webhook de Stripe**: firma sobre el cuerpo crudo, ventana de 5 min e idempotencia
  ([licencias.md](licencias.md#comprar)).
- **Device-proof**: firma de `ts`, método, ruta, hash del token y hash del cuerpo, con ±2 minutos.
  Sin nonce ([FABLE-E](../pendientes.md#fable-e--sin-nonce-en-el-device-proof)).
- **El correo se acota por destinatario y por volumen**: sólo al email de un proveedor dado de alta y
  con un tope diario por negocio ([worker.md](worker.md#correo)).
- Pendiente: los 500 todavía devuelven detalles internos
  ([FABLE-B](../pendientes.md#fable-b--detalles-internos-en-las-respuestas-de-error)).
- Dependencias: `.github/workflows/audit.yml` (`cargo audit` y `pnpm audit --prod`, en cada PR y los
  lunes) y Dependabot. Un aviso no es un fallo explotable: hay que mirar si el camino vulnerable se usa.
