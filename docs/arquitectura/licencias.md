# Licencias

Las licencias son nuestras: viven en la base central (control-plane, una Turso que no se recrea), las
emiten **Stripe** (pago único) o el **administrador** a mano, y el TPV las valida contra el worker
`tpv-api`. El estado que decide si el TPV puede trabajar viaja **firmado con ed25519** y el cliente
lo verifica contra una clave pública fijada en el binario: un servidor falso, un MITM con CA propia o
un DNS envenenado no pueden fabricar una licencia válida.

**1 licencia = 1 negocio (tenant) = 1 Main**, más todas las Handy que se emparejen, que no consumen
licencia. Es además un invariante de la replicación: el `TenantHub` asume un único escritor por
tenant ([sincronizacion.md](sincronizacion.md)).

> Límite honesto: el gate decide en el cliente. Quien controle la máquina y parchee el binario puede
> saltárselo. Lo que la firma cierra es cualquier ataque de red o de servidor.

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Rutas del TPV | `apps/cloud-worker-licensing/src/domains/licensing/licensing.routes.ts` | `activate`, `device-change/request`, `status`, `refresh` |
| Estado y firma | `…/licensing/licensing.helpers.ts` | `computeLicenseState`, `stateAllowsUse`, mensaje canónico y firma, OTP, device-proof, la firma de la activación, aprovisionar el tenant |
| La clave | `…/licensing/licenseKey.ts` | Formato, generación y normalización |
| Correos | `…/licensing/licenseEmails.ts` | Clave, código de cambio de equipo, aviso de cambio, recibo de canje, aviso de caducidad |
| Avisos de caducidad | `…/licensing/avisosDeCaducidad.ts` | Del cron diario (`scheduled` en `src/index.ts`) |
| Compra | `…/domains/stripe/{stripe.routes,stripe.helpers}.ts` | Webhook: emitir, revertir, restaurar |
| Administración | `…/domains/admin/admin.routes.ts` + `scripts/tpv-license.mjs` | Emitir, listar, reenviar, revocar, desrevocar, extender, acortar |
| Almacén | `…/src/server/licenseStore.ts` | Todas las lecturas y escrituras de la base central |
| Cliente | `crates/tpv-infra-licensing/src/{lib,device,reloj,secret_store,field_crypto}.rs` | Llamadas al worker, verificación de la firma, identidad del dispositivo, hora de la nube, secretos, cifrado de PII |
| Política del gate | `crates/tpv-domain/src/licensing.rs` | Veredicto, gracia sin conexión, mensaje canónico. Puro |
| Casos de uso | `tpv-application/src/use_cases/licensing.rs` | `gate` (con avisos) y la comprobación manual |
| Comandos | `apps/tpv-main/src-tauri/src/commands/licensing.rs` | `license_activate`, `license_sumar_clave`, `license_check_now`, `license_clear_state`… |
| Pulso | `jobs/registro.rs::licencia` | Cada 6 h (`MainOperativa`), emite `license:changed` |
| Estructura de la base central | `docs/sql/control-plane/esquema-actual.sql` | La foto de producción; la usan los tests |

---

## La clave y la licencia

- **Formato**: `TPV-XXXXX-XXXXX-XXXXX-XXXXX` en base32 Crockford, con `crypto.getRandomValues`. En la
  base se guarda `sha256(clave)` (único, por donde se busca) y la clave cifrada con
  `LICENSE_STORE_KEY` (para reenviarla). Nunca en claro ni en logs.
- **Tabla `licenses`**: `status` (`issued`, `active`, `revoked`, `redeemed`), `disabled`, `plan`
  (`standard`), `term_months`, `origin` (`stripe` | `manual`), `issued_at_ms`, `activated_at_ms`,
  `expires_at_ms`, `main_device_id`, `tenant_id`, `customer_email` (obligatorio: es a donde va el
  código de cambio de equipo), datos del cliente de Stripe, `redeemed_into_license_id` y
  `key_email_sent_at_ms`.
- **El reloj arranca en la primera activación**, no en la compra: al emitir, `expires_at_ms` es
  `NULL`.

## Comprar

`POST /v1/stripe/webhook`. Barreras, en orden:

1. Firma HMAC-SHA256 de Stripe sobre el cuerpo **crudo**, comparación de tiempo constante.
2. El timestamp de la firma no se desvía más de 5 minutos.
3. Idempotencia por `event.id` (`webhook_events`): un evento procesado bien no se repite; uno que
   falló sí, y por eso se contestó 500.
4. Idempotencia por sesión de checkout (índice único en `license_payments` por sesión y unidad),
   comprobada dentro de la transacción.
5. Fail-closed: si una línea no trae `metadata.term_months` en su Price, la cantidad no es un entero
   positivo, la lista de líneas viene paginada o la compra pasa de `MAX_LICENCIAS_POR_COMPRA` (100),
   no se emite nada.

Eventos de pago: `checkout.session.completed` y `checkout.session.async_payment_succeeded` (un
checkout `unpaid` espera al segundo). **Toda compra emite claves nuevas, una por unidad**: comprar 4
del plan anual son 4 licencias de un año, no una de cuatro, porque quien compra varias puede querer
varios locales; quien quiera todo el tiempo en un equipo canjea las claves una tras otra y se suman
(ver [Activar](#activar)). Cada una se registra como cobro `kind='issue'` en `license_payments` con
su `unidad` (1…N), todas en la misma transacción, y después del `COMMIT` van **juntas en un correo**.
Si el correo falla la venta sigue: `key_email_sent_at_ms` queda a `NULL` y `pnpm license:list` las
enseña pendientes de `pnpm license:resend`. La API de Stripe se llama con la versión fija `2025-09-30.clover` (hace falta
para `customer_details.business_name`).

Hay un único enlace de compra (`CHECKOUT_URL`) para estrenar y para renovar.

### Deshacer un cobro

Eventos `charge.refunded`, `charge.dispute.created` y `charge.dispute.closed` (hay que suscribirlos
en el endpoint del Dashboard de Stripe). Todo en una transacción:

Un cargo puede tener varios cobros, uno por licencia de la compra, y cada uno se trata por su
cuenta:

| Caso | Efecto |
|---|---|
| Reembolso total o disputa abierta de un **alta** | Licencia revocada |
| … de una **renovación** (`kind='renewal'`, incluida una clave canjeada) | Se restan sus meses |
| Reembolso parcial | Nada; queda en `admin_audit` con todas las licencias de la compra (Stripe no dice cuál se devuelve: se revoca a mano) |
| Disputa **ganada** | Se deshace lo que revirtió esa disputa (y sólo eso) |
| Cargo sin licencia atribuible | Nada; se audita |

El cargo se atribuye por el historial de cobros, luego por el último cobro de la licencia y, como
último recurso, por el cliente de Stripe **sólo si tiene una única licencia**. La auditoría anota los
días que llevaba activada.

## Activar

`POST /v1/license/activate { activationKey, deviceId, devicePubKey, tenantInfo, deviceChangeCode?,
soloSumar?, tenantActual? }`.

La activación y la solicitud de traslado validan el JSON con el middleware común antes de
consultar licencias. `deviceId` es obligatorio: el servidor no inventa otra identidad. La clave
pública debe contener exactamente 32 bytes Ed25519 en base64 estándar. Los cuerpos inválidos
devuelven `validation_error` (400); pedir un traslado con una clave bien formada pero desconocida
sigue devolviendo `{ ok: true }`, para no revelar qué licencias existen.
**La ruta es anónima, pero va firmada con la clave privada del equipo** (AUD-01). Ni el `device_id` ni
la clave pública son un secreto: la Main de un negocio ve los de cada equipo que pasó por él
(`/v1/device/list`, `/v1/pair/pending`), y no cambian al mudarse. Lo que prueba que quien activa es
ese equipo es la firma:

- El cliente (`activar_remoto`) serializa el cuerpo una vez, lo firma y manda la firma en
  `X-Device-Sig` y su hora en `X-Device-Ts`. Lo firmado es el device-proof de las rutas autenticadas
  sobre esta ruta y sin token (`device.rs::mensaje_de_activacion`):
  `DEVICE_PROOF \n ts \n POST \n /v1/license/activate \n sha256("") \n sha256(cuerpo)`. El cuerpo
  entra entero, así que quedan atados el `deviceId`, la clave pública, la clave de activación, el
  código de traslado, `soloSumar` y `tenantActual`; la ruta va dentro, así que la firma no vale para
  otra.
- El worker la comprueba **con la clave pública que presenta el cuerpo**
  (`verificarFirmaDeActivacion`), con ±2 minutos de margen, antes de leer una sola fila. Sin
  cabeceras o con la hora fuera de margen no llega a leerse el cuerpo (`exigirFirma`, delante del
  validador); la firma se comprueba detrás (`firmaDelEquipo`). Si no vale, 401
  (`missing_device_proof`, `device_ts_out_of_range`, `bad_device_signature`) sin mover la fila del
  equipo, gastar la clave, entregar la DEK ni contar un intento del código de traslado.
- **La firma sólo prueba la clave que se presenta**, así que lo siguiente es compararla con la
  registrada (`exigirLaClaveDeEsteEquipo`): si la nube ya conoce ese `device_id`, en el negocio que
  sea, la clave tiene que ser la suya (`device_key_mismatch`, 409). Una fila sin clave registrada no
  se da por buena con la que llegue (`device_key_missing`, 409): la arregla soporte, y a una Handy,
  volver a vincularla en su negocio. Va delante del canje y del código de traslado, así que el
  rechazo no deja nada hecho: ni código consumido, ni fila tocada.
- **El negocio de un equipo es el de su fila de `devices`**, no el que diga la petición. El TPV
  manda en `tenantActual` el de su licencia guardada, si tiene; si no es el registrado, 409
  `device_tenant_mismatch` y no se sigue. Abrir el TPV comprueba la licencia, y eso devuelve la fila
  a su negocio si el equipo sigue siendo su Main.
- Un equipo recién estrenado no ha visto todavía la hora de la nube: si su reloj va mal, el rechazo
  la trae y la activación se repite una vez firmada con ella
  ([abajo](#la-hora-con-la-que-se-firma)).

Rust y el worker comparten un vector con una clave fija
(`crates/tpv-infra-licensing/src/firma_activacion_casos.json`): el mismo cuerpo, el mismo mensaje y
la misma firma en los dos lados.

No existe o no se reconoce → `license_not_found`; revocada → `license_revoked`; caducada **y pasada la
gracia** → `license_expired`. Después, uno de tres caminos según `main_device_id`:

### 1. Clave sin estrenar en un equipo que ya tiene licencia: suma tiempo (canje)

Si este `deviceId` ya es la Main de una licencia viva **en el negocio en el que la nube lo tiene
registrado** (el `tenant_id` de su fila de `devices`), la clave nueva **no crea un negocio**:

- **Va atado al negocio en el que la nube tiene registrado al equipo.** El canje suma a la licencia
  viva de la que el equipo es la Main **en ese negocio** (`licenciaVivaDelDispositivo`), se diga o no
  `tenantActual`. Un equipo puede ser la Main de dos licencias vivas de negocios distintos; si en el
  suyo no tiene ninguna, no se suma a la de otro.
- **Si su fila está en otro negocio que su licencia, no hay canje.** Una Main de A cuya fila está en
  B (vinculada como Handy en B y aún sin readmitir, por ejemplo) no tiene licencia viva en B. Si
  activa sin licencia guardada y sin `soloSumar` (la pantalla de activación tras «Borrar y volver a
  activar»), la clave sigue a la primera activación: crea un negocio C, muda allí la fila y estrena
  en él la clave. La salida es devolver antes la fila a A. Si el TPV conserva su licencia, abrirlo
  pasa por `/status`, que readmite la Main en el negocio de su licencia (`readmitirMain`), y después
  la clave se suma a A; mientras la fila siga en B, la petición lleva `tenantActual` = A y contesta
  `device_tenant_mismatch` sin gastar la clave. Sin licencia guardada, se activa primero la clave de
  A en ese equipo (es su Main: lo readmite en A) y después la nueva.
- Esa licencia se lee **una vez**, y con ella deciden el veto de `soloSumar` y el canje.
- La clave presentada ya se ha comparado con la registrada, y aquí el equipo tiene que tener fila:
  sin ella no hay con qué comprobar que es él (`device_key_missing`).
- Calcula antes todo lo que puede fallar sin escribir (la DEK y el token).
- En una transacción: comprueba que la licencia elegida sigue siendo la viva de ese equipo
  (`sigueSiendoLaLicenciaDelEquipo`; si se ha anulado o trasladado entretanto, `clave_no_canjeable`
  sin gastar la clave), `canjearLicencia` (`WHERE status='issued'`, y si no gana la carrera contesta
  `license_already_used`), `extendLicense` (suma sobre lo que quedaba, o sobre hoy si ya venció) y
  `reasignarCobrosDeLaClave` (el cobro pasa a la licencia viva como `renewal`, para que un reembolso
  tenga de dónde restar).
- Ni tenant, ni base en Turso, ni DEK nuevos. Manda un recibo por correo y responde
  `tiempoSumado: true`; la pantalla enseña «tiempo añadido, vence el X» y espera a que se pulse.

Teclear en el bar 1 la clave que era para el bar 2 le suma el tiempo al bar 1: se ve en el acto.

Con el TPV ya en marcha, el sitio es **Configuración → Licencia → Añadir otra licencia**
(`license_sumar_clave`, de administrador). La petición lleva `soloSumar`, y con ella el worker
rechaza con `clave_no_canjeable` todo lo que no sea este canje, sin tocar nada: la clave que ya
tiene el equipo, una ya activada en otro (que por la pantalla de activación sería un cambio de
equipo) y una clave nueva en un equipo sin licencia viva en su negocio (que estrenaría otro). Con
`soloSumar` la ruta suma o rechaza: no llega nunca al alta de un negocio. Es como renueva quien compra
otra licencia, y como junta en un local el tiempo de varias.

El TPV tampoco guarda lo que la nube le concede sin mirar qué le pidió
(`tpv_domain::licensing::comprobar_solicitud` y `comprobar_concesion`): sin licencia guardada no
manda un `soloSumar`; un `soloSumar` que no vuelve como suma no se guarda; y una suma que vuelve con
otro negocio que el suyo, tampoco. En los tres casos se queda con su token y su DEK de antes.

### 2. Primera activación

Crea el tenant (`ensureTenantExistsMinimal`), da de alta el dispositivo con su clave pública,
aprovisiona su base en Turso (`provisionTenantDatabase`) y guarda los datos del negocio. Después
`activateLicenseFirstTime` pone `active`, `activated_at_ms`, `expires_at_ms = ahora + meses` y
`main_device_id`, condicionado a que siga sin activar: si otro equipo ganó la carrera, contesta
`device_replaced`. La base de Turso aprovisionada para el perdedor se queda vacía.

### 3. Cambio de equipo (la licencia ya está en otro)

Exige un código de 6 cifras enviado al **correo de la compra** (`customer_email`):

1. Sin código → `device_change_required` con una pista del correo.
2. `POST /v1/license/device-change/request` manda el código: hash guardado en `license_device_otp`,
   ligado a ese `deviceId`, 10 minutos y 5 intentos, como mucho uno por minuto. Responde siempre lo
   mismo, exista o no la clave.
3. Activar con el código: se verifica (tiempo constante), se consume de forma atómica,
   `reassignMainDevice` cambia la Main (registro en `license_device_swaps`) **conservando el
   tenant**, y se avisa por correo al titular.

**Los topes de verdad van por licencia** (RI-68, `license_otp_eventos`, ventana de 24 h):
- como mucho **5 códigos enviados**; pasado el tope se contesta igual, sin enviar;
- como mucho **10 códigos incorrectos**; después, ni el bueno entra hasta el día siguiente.

Los 5 intentos de cada código no bastan: un `deviceId` inventado abre otra pareja, y pedir otro código
los reinicia. Delante de las dos rutas hay además un filtro por IP (`LIMITADOR_LICENCIA`, 10 por
minuto), que deja pasar si el binding falta (`lib/limitador.ts`).

**Cada tope se reserva antes de actuar, en una sola sentencia que sólo concede si queda cupo**
(AUD-04; `reservarEnvioDeOtp`, `reservarIntentoDeOtp`, `reservarFalloDeOtp`): muchos intentos a la vez
no comparan más códigos que los del tope, y quien no reserva sale sin que se compare nada, con 429 si
es el tope lo que se lo impide. Primero el intento del código, que devuelve la huella con la que
comparar, y después el fallo del día. Si el día no concede el suyo, el intento del código se devuelve:
un rechazo sin comparación no gasta intentos, y el código sigue valiendo cuando el día se libera. Si
el código es el bueno, el fallo reservado se devuelve y se consume justo el código que se comparó,
siempre que no haya caducado. Un código caducado no gasta intento.

El traslado va siempre al correo de la compra, no al de recuperación: si siguiera a éste, quien sepa
el PIN de un administrador podría cambiarlo y llevarse la licencia.

### Lo que hacen los tres

- Antes de nada, la firma del equipo y la comparación de su clave con la registrada
  ([arriba](#activar)).
- Dan de alta el dispositivo, o mudan su fila, con `ensureDevice`: **una sola sentencia, que escribe
  la fila con su clave** y sólo toca una que ya existe si su clave registrada es la presentada. Un
  corte a mitad de la activación no deja una fila sin clave.
- **Límite conocido.** La comparación de la clave y el alta no son un lote. Si la clave registrada de
  ese mismo `device_id` cambia justo entre las dos —sólo puede hacerlo un emparejamiento suyo que
  recoja el token en ese instante, en el negocio donde está su fila—, se rechaza
  (`device_key_mismatch`) sin escribir la fila ni entregar credenciales, pero lo anterior ya está
  hecho: en un cambio de equipo el código queda consumido y hay que pedir otro, y si la fila era de
  ese mismo negocio, su `updated_at_ms` ya se ha movido. El negocio se crea o se toca después de
  `exigirClaveSiEsDeOtroNegocio`, así que un rechazo suyo no deja un negocio recién creado.
- Justo antes, `exigirClaveSiEsDeOtroNegocio`, la regla que comparten con el emparejamiento: una
  fila de **otro** negocio no se mueve con otra clave (`device_key_mismatch`) ni si no tiene clave
  registrada (`device_key_missing`). Toda puerta que dé de alta un dispositivo comprueba la firma de
  la clave que le presentan y llama a ese guardián (hoy: activar y recoger el token del
  emparejamiento). Dentro del mismo negocio, el emparejamiento sí deja que la clave cambie: es la vía
  de recuperación de una Handy revocada. Activar, no.
- Entregan la **DEK** del tenant (`getOrCreateTenantFieldDek`, la existente si ya la hay), para que
  un equipo nuevo pueda descifrar la PII del personal.
- Devuelven el token de sesión (JWT HS256 de 30 días) y `cambioDeEquipo`. **Quién decide que hubo
  traslado es el servidor**: con `cambioDeEquipo`, el TPV marca `traslado-pendiente` y reconstruye su
  base desde la nube ([recuperacion.md](recuperacion.md)).

## El gate

`GET /v1/license/status` con token y device-proof. El worker:

- Verifica el token (si no vale: `token_expired`, y el cliente va a `/refresh`) y el device-proof. Si
  la clave del dispositivo no está registrada en ese tenant —una Main que se usó como Handy de otro
  negocio—, `readmitirMain` la vuelve a dar de alta si firma con su clave registrada y sigue siendo
  la Main.
- La licencia del `licHash` tiene que ser la del tenant del token (AUD-03): si no, `license_not_found`
  sin aserción, que hablaría de una licencia ajena.
- Deriva el estado (`computeLicenseState`):

| Estado | Cuándo | ¿Trabaja? |
|---|---|---|
| `revoked` | Revocada o `disabled` | No, y el cliente borra su estado |
| `device_replaced` | La Main de la licencia es otro equipo | No, y borra |
| `active` | Faltan más de 7 días (o no ha arrancado el reloj) | Sí |
| `warn` | Últimos 7 días | Sí, con aviso |
| `expiry_grace` | Hasta 3 días después de caducar | Sí, con aviso en rojo |
| `expired` | Pasada la gracia | No, pero **conserva** el estado: al renovar basta con reintentar |

- Firma la **aserción**: `v|tenant|device|license|state|plan|expires_at|issued_at|assertion_expires_at|client_ts`
  con `LICENSE_SIGNING_PRIVATE_KEY`. Dura 5 minutos y lleva el `X-Device-Ts` de esta petición, así
  que una aserción vieja no se puede reproducir. Cambiar el formato obliga a cambiarlo igual en
  `tpv-domain::licensing::mensaje_canonico` y subir la versión `v`.
- **Renueva el token sólo si el estado deja trabajar.** La respuesta llega siempre (es por donde el
  cliente se entera), pero un equipo anulado no recibe credencial nueva.

El cliente verifica la firma con cualquiera de las claves de `LICENSE_SIGNING_PUBLIC_KEYS_B64` y la
frescura, y decide
(`evaluar_estado` / `evaluar_fallo`):

**El gate nunca borra la licencia local** (RI-09). Un `revoked` o `device_replaced` firmado bloquea con
su motivo y la conserva. Si el servidor se corrige (se deshace la anulación, o era un error nuestro:
una base equivocada, una copia restaurada), basta con reintentar. El único borrado es «Borrar y volver
a activar» (`clear_state`), que anota el motivo para que la pantalla de activación lo explique.
Una comprobación que estaba esperando a la nube mientras se borraba, se activaba o se sumaba una clave
no guarda lo que trae, ni el estado ni el token: vuelve a comprobar la licencia que haya entonces.
`/refresh` y la readmisión de una Main adjuntan a su rechazo la misma aserción firmada que daría
`/status` cuando la licencia existe.

| Fallo | Veredicto |
|---|---|
| `license_not_found`, `license_revoked`, `device_replaced` **sin aserción firmada** | No se puede comprobar: gracia sin conexión, con motivo `rejection_unverified` y un aviso a los administradores |
| Firma inválida | Bloquea y conserva (`bad_signature`) |
| Sin conexión, 5xx o token o proof rechazados | Gracia sin conexión |
| `device_ts_out_of_range` (reloj desfasado) | Igual que sin conexión, con motivo `clock_skew_detected` |

**Gracia sin conexión: 72 h** desde la última comprobación correcta (o desde la activación). Si el
reloj está más de 2 minutos por detrás de esa base, bloquea con `clock_rollback_detected`.

Lo gastado no sale sólo de restar fechas, que se puede trampear atrasando el reloj poco a poco (RI-36).
Además se **cuenta** (`offline_consumido_ms` en `license_state.json`, `sumar_tiempo_sin_conexion`):
- con la app abierta, con el reloj monótono del proceso, que no se puede atrasar;
- entre arranques, con el de pared, nunca hacia atrás.

Manda lo mayor de las dos cuentas. El job `licencia_reloj` cuenta cada 5 minutos, sin red, así que
cerrando la app y atrasando el reloj sólo se esconden minutos. Una comprobación buena pone la cuenta
a cero.

El pulso es el job `licencia`, cada 6 h; usa `gate` (que aplica la gracia y emite los avisos a los
administradores), no la comprobación manual del botón «Reintentar». Además de esto, el worker
**comprueba la licencia en todas las rutas autenticadas** (`tenantAuth` → `lib/licenciaEnUso.ts`, con
caché de 60 s), y que sea la de su negocio, así que una licencia anulada deja sin correo, R2, volcado
ni lecturas de la Handy aunque el equipo conserve un token. El ticket del WebSocket la comprueba
**sin** esa caché: es con lo que reconecta la Main a la que se acaba de anular la licencia. Detalle en
[permisos.md](permisos.md).

### Renovar el token

`POST /v1/license/refresh`: lee los claims del token **sin verificarlo** y exige el device-proof, que
sólo ata tenant y dispositivo; por eso la licencia del `licHash` tiene que ser la de ese tenant
(AUD-03), o sería quien llama el que la elige. Licencia de otro tenant o sin él → `license_not_found`;
licencia anulada → `license_revoked`; dispositivo revocado → `device_revoked`; una Main desplazada →
`device_replaced`. Una Handy recibe su token con su propia duración (`handyTokenTtlSeconds`) y sin la
comprobación de traslado, que la daría por desplazada siempre (ver [emparejamiento.md](emparejamiento.md)).

### La hora con la que se firma

Toda firma con hora sale de `reloj::ahora_ms()`: el reloj del equipo más el desfase medido con la
cabecera `Date` de cada respuesta del worker. Todo lo que habla con el worker se manda con
`reloj::enviar`, para anotar la medida. Un rechazo por la hora se repite **una vez** con la hora que
trajo ese rechazo; también la activación, que es la primera petición de un equipo recién estrenado. El desfase vive en memoria; se descarta una medida con una ida y vuelta de más de
10 s. Las caducidades que pone la nube (de la aserción, del token) también se comparan con su hora.
La **hora del negocio** —ventas, fichajes, caja, Veri\*factu, `x-client-now`— sigue siendo la del
equipo ([pendientes.md](../pendientes.md#reloj-01--la-hora-del-negocio-es-la-del-equipo)).

## Anular desde la administración

`POST /v1/admin/licenses/:id/revoke` revoca y, como best-effort, pide al `TenantHub` del tenant que
cierre el socket de la Main (`lib/hub.ts::cerrarSocketsDelDispositivo` → `/internal/revoke`, firmado
con HMAC sobre método, ruta y cuerpo). El cliente reconecta, recibe un 403, lo traduce en un
`license_check_now` y se bloquea en el acto, sin esperar al job. Las Handy no se cierran a mano: el DO
las congela al irse la Main. **Caducar no empuja**: se nota en la siguiente comprobación.

| Operación | Ruta | CLI |
|---|---|---|
| Emitir | `POST /v1/admin/licenses` | `pnpm license:issue -- --term 12 --email … --name … [--send-key]` |
| Listar | `GET /v1/admin/licenses` | `pnpm license:list` |
| Reenviar la clave | `POST …/:id/resend-key` | `pnpm license:resend` |
| Revocar | `POST …/:id/revoke` | `pnpm license:revoke -- --id …` |
| Desrevocar | `POST …/:id/unrevoke` (vuelve a `issued` o `active`) | `pnpm license:unrevoke` |
| Extender | `POST …/:id/extend` | `pnpm license:extend -- --id … --months 12` |
| Acortar | `POST …/:id/shorten` (puede dejarla caducada) | `pnpm license:shorten` |
| Retirar los negocios del E2E | `POST /v1/admin/pruebas/retirar` | — (lo llama el E2E al terminar) |

Una licencia emitida con `pruebas: true` (`origin = 'pruebas'`) es del E2E. Retirar borra la base en
Turso de cada negocio cuyas licencias sean todas de pruebas, lo da por borrado (`status = 'deleted'`)
y anula sus licencias. Un negocio con cualquier otra licencia no se toca. Las bases de los negocios
se crean en el grupo `tpv` de Turso (`GRUPO_TURSO`), que tiene que existir antes de desplegar.

Todas exigen `ADMIN_API_TOKEN` (comparación de tiempo constante; sin el secreto la ruta responde 503)
y quedan en `admin_audit`. El CLI lee el token de la variable de entorno `ADMIN_API_TOKEN`.

### Rotar el token de administración

`ADMIN_API_TOKEN` autoriza el plano de control: licencias, interruptores remotos, recifrado del
almacén, pilotos y promoción de releases. Es un secreto técnico de quien opera el CLI. La
publicación de binarios usa el secreto independiente `RELEASE_ADMIN_TOKEN`.

Se rota ante una filtración, al retirar un equipo o una persona autorizada y según la política
de mantenimiento. El procedimiento afecta a las herramientas de administración; los TPV siguen
usando sus tokens de dispositivo.

1. Generar un valor aleatorio de al menos 32 bytes en el gestor de secretos y guardarlo allí.
2. Desde `apps/cloud-worker-licensing/`, ejecutar `pnpm exec wrangler secret put ADMIN_API_TOKEN`
   e introducir el nuevo valor en la entrada interactiva. Esto publica una nueva versión del
   Worker con el secreto actualizado: coordinarlo con los operadores del CLI.
3. Actualizar el `.env` local ignorado por Git y las variables de los equipos o automatizaciones
   autorizados. La variable de entorno tiene prioridad sobre `.env`: sustituir también cualquier
   valor antiguo cargado en una terminal abierta.
4. Comprobar con `pnpm license:list` desde la raíz que el nuevo token funciona. Verificar que una
   petición de lectura con el token antiguo recibe 401 y retirar sus copias del gestor de secretos
   y de las máquinas autorizadas. Registrar fecha y responsable, sin guardar el valor en logs.

Solo se acepta el token vigente. Ante una filtración no se recupera el acceso restaurando el
secreto antiguo: se distribuye uno nuevo. Un rollback de código debe conservar el secreto vigente.

## Avisos de caducidad

El cron diario manda un correo a 30 y a 7 días de caducar, **el peldaño más urgente que toque** y uno
por licencia y ciclo, con el enlace de compra `CHECKOUT_URL`. Sin esa variable no se manda nada. Se
marca en `license_notices` antes de enviar y sólo envía quien gana la marca; si el correo falla, la
marca se suelta. La clave de `license_notices` incluye `expires_at_ms`, para que un aviso de un ciclo
no silencie el del siguiente.

## Lo que guarda el equipo

| Qué | Dónde |
|---|---|
| `device_id` y clave privada ed25519 del dispositivo | Almacén de secretos: keyring del sistema en escritorio, Android Keystore (AES-GCM) en la Handy |
| Estado de la licencia (`tenant_id`, `device_id`, token, estado, caducidad, última comprobación) | `AppData/license_state.json` |
| DEK de la PII del personal | Almacén de secretos (y en la base central, cifrada con `LICENSE_STORE_KEY`) |

El device-proof firma `ts \n MÉTODO \n ruta \n sha256(token) \n sha256(cuerpo)` (`device.rs`), con ±2
minutos de margen en el worker. La activación firma lo mismo con el token vacío
([Activar](#activar)).

**La identidad sólo se crea al activar y al emparejar** (`get_or_create_*` en `device.rs`). Firmar, el
gate y el updater la leen (`leer_*`) y nunca la crean. Al leer, el almacén distingue tres casos
(`ErrorSecreto`, RI-72):
- **No hay nada**: se crea, si quien pregunta puede crear.
- **No se ha podido preguntar** (`NoDisponible`): es un error y se reintenta en la siguiente llamada.
  Escribir otra identidad encima perdería para siempre la que la nube conoce.
- **Hay algo, pero no se puede descifrar** (`Ilegible`): sólo pasa en Android, con una copia restaurada en
  otro teléfono. Se regenera. La app lleva además `allowBackup="false"`.

## Secretos del worker

| Secreto | Para qué |
|---|---|
| `LICENSE_SIGNING_PRIVATE_KEY` | Firmar la aserción. Su pública va fija en `LICENSE_SIGNING_PUBLIC_KEYS_B64` (`tpv-infra-licensing/src/lib.rs`) junto a la de reserva (`pnpm license:keypair` genera cada par) |
| `LICENSE_JWT_SECRET` | Tokens de sesión |
| `LICENSE_STORE_KEY` (+ `LICENSE_STORE_KEY_ID`) | Cifrar en reposo claves, DEK y tokens de Turso (`server/crypto.ts`). Global: perderla deja la PII de todos irrecuperable. **No se regenera nunca**: se guarda en el gestor de contraseñas el día que se crea, porque Cloudflare no deja volver a leerla |
| `LICENSE_STORE_KEY_ANTERIOR` (+ `_ID`) | Sólo durante una rotación: la clave de antes, para leer |
| `ADMIN_API_TOKEN` | Las rutas de administración |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Leer la sesión de checkout y verificar el webhook |
| `CHECKOUT_URL` | El enlace de compra de los avisos de caducidad |

### Rotar la clave de firma

El cliente lleva pineadas **dos** claves públicas (RI-09): la **en uso**, cuya privada es
`LICENSE_SIGNING_PRIVATE_KEY`, y la **de reserva**, cuya privada no está en Cloudflare: se guarda fuera
de línea, en el gestor de contraseñas. Si la en uso se filtra:

1. `pnpm exec wrangler secret put LICENSE_SIGNING_PRIVATE_KEY` con la privada **de reserva**. Todos los
   equipos la aceptan desde la siguiente comprobación, sin actualizarse.
2. En la versión siguiente: se genera un par nuevo con `pnpm license:keypair`, la lista pasa a ser
   `[reserva actual, nueva reserva]` (se quita la filtrada) y la privada nueva va al gestor de
   contraseñas.

Subir al worker una privada cuya pública no esté en la lista deja a todos los equipos bloqueados con
`bad_signature` (bloquea pero conserva la licencia: se arregla volviendo a poner la buena).

### Rotar `LICENSE_STORE_KEY`

Lo cifrado lleva la versión de la clave (`k<id>:` + base64; sin prefijo es la versión `1`, lo de antes
de RI-73), así que cambiarla ya no deja ilegible lo anterior:

1. Clave nueva: `openssl rand -base64 32`, primero al gestor de contraseñas.
2. `wrangler secret put` de `LICENSE_STORE_KEY_ANTERIOR` (la de ahora) y `LICENSE_STORE_KEY_ANTERIOR_ID`
   (su versión, `1` si nunca se ha rotado). Después `LICENSE_STORE_KEY` (la nueva) y `LICENSE_STORE_KEY_ID`
   (una versión nueva: `2`, `3`…).
3. Desde ese momento se escribe con la nueva, y lo que se lee con la anterior se guarda ya con la nueva.
   `pnpm license:recifrar` pasa el resto de una vez y lista lo que no se deja descifrar con ninguna.
4. Cuando no quede nada: `wrangler secret delete LICENSE_STORE_KEY_ANTERIOR` (y su `_ID`).

Cambiar `LICENSE_STORE_KEY` **sin** pasar la anterior es lo que pasó el 27/09. Lo delata `/health`, que
descifra un canario y contesta 503 (ver [worker.md](worker.md#salud-y-vigilancia-externa)). Los tokens de
Turso se sustituyen solos en la siguiente lectura, pero las DEK y las claves de licencia no tienen
arreglo sin la clave buena.

Stripe: un producto con un Price *one-time* por duración, cada uno con `metadata.term_months`, el
enlace de compra con «recopilar email», y el webhook en
`https://tpv-api.altarialights.workers.dev/v1/stripe/webhook` con los cinco eventos de arriba. Pagar
con Checkout alojado deja los datos de tarjeta fuera de nuestros servidores.

## Al tocar esto

- **La estructura de la base central se cambia a mano en Turso, antes de desplegar** el worker que la
  use, y se refleja en `docs/sql/control-plane/esquema-actual.sql` ([worker.md](worker.md)).
- El correo de recuperación del PIN (LOGIN-07/08) vive en la misma base pero es otra cosa: ver
  [permisos.md](permisos.md#recuperar-el-pin).
