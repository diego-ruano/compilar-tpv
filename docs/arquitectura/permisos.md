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
| Arranque | `None`: al abrir la app siempre se pide PIN |
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

---

## Capacidades por rol (RI-70)

El catálogo estable vive en `tpv-domain::permisos::CATALOGO`. `Roles_Permisos` guarda una concesión
por rol y acción; no hay permisos individuales, SQL configurable ni fallback cuando un rol está
vacío. Una capacidad desconocida se deniega incluso al administrador. Los comandos solicitan
`exigir_permiso`; el puerto se implementa en SQLite para Main y en HTTP para Handy.

`sesion()` relee el usuario activo y su rol vigente; `exigir_permiso` obtiene además las concesiones
en la misma consulta. Desactivar una persona, cambiarle el rol o editar sus permisos afecta a las
siguientes operaciones de su sesión abierta. Si se cierra o cambia la sesión mientras llega una
consulta HTTP, su respuesta no autoriza al nuevo usuario. El proceso de réplica y los jobs no
necesitan una sesión personal.

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

La interfaz consulta `permisos_sesion`; rutas, menú, botones de inventario y gestión usan esas
capacidades. Se refrescan ante cambios replicados y cada 30 segundos; el backend consulta siempre
el estado vigente. Al cerrar sesión se limpia la caché de consultas para no mostrar a la siguiente
persona información de la sesión anterior.

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

---

## El PIN

- **PBKDF2-HMAC-SHA256**, 100.000 iteraciones (el techo de `crypto.subtle` en Workers, y el worker
  también verifica), sal de 16 bytes, formato `$pbkdf2-sha256$i=…$<sal>$<derivada>` idéntico en Rust y
  en el worker. Verificación en tiempo constante con `subtle`, parámetros acotados (1–100.000 iteraciones, sal de 16 bytes y derivada de 32), cálculo fuera del ejecutor async y rehash al iniciar sesión.
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
- **Device-proof**: firma con dominio `DEVICE_PROOF` de `ts`, método, ruta **y query**, hash del token y hash del cuerpo, con ±2 minutos.
  Sin nonce ([FABLE-E](../pendientes.md#fable-e--sin-nonce-en-el-device-proof)).
- **El correo se acota por destinatario y por volumen**: sólo al email de un proveedor dado de alta y
  con un tope diario por negocio ([worker.md](worker.md#correo)).
- Pendiente: los 500 todavía devuelven detalles internos
  ([FABLE-B](../pendientes.md#fable-b--detalles-internos-en-las-respuestas-de-error)).
- Dependencias: `.github/workflows/audit.yml` (`cargo audit` y `pnpm audit --prod`, en cada PR y los
  lunes) y Dependabot. Un aviso no es un fallo explotable: hay que mirar si el camino vulnerable se usa.
