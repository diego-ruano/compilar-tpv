# Licencias

Las licencias son nuestras: viven en la base central (control-plane), que es el SQLite de su objeto
`BaseCentral` ([worker.md](worker.md#la-base-central)), con su copia diaria y su vuelta a un
instante ([restaurar-la-central.md](../guias/restaurar-la-central.md)). Las emiten **Stripe** (pago
único) o el **administrador** a mano, y el TPV las valida contra el worker
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
| Almacén | `…/src/server/licenseStore.ts` | Las lecturas y las escrituras de una sentencia en la base central |
| Operaciones | `…/src/server/central/operaciones/` | Lo que escribe en más de una sentencia, entero o nada, dentro del objeto `BaseCentral`: el canje (`canjearClave`), el cobro y su reversión (`emitirCobro`, `revertirCobro`) y lo que la administración hace con una licencia ([worker.md](worker.md#las-operaciones)) |
| Cliente | `crates/tpv-infra-licensing/src/{lib,device,reloj,secret_store,field_crypto}.rs` | Llamadas al worker, verificación de la firma, identidad del dispositivo, hora de la nube, secretos, cifrado de PII |
| Política del gate | `crates/tpv-domain/src/licensing.rs` | Veredicto, gracia sin conexión, mensaje canónico. Puro |
| Casos de uso | `tpv-application/src/use_cases/licensing.rs` | `gate` (con avisos) y la comprobación manual |
| Comandos | `apps/tpv-main/src-tauri/src/commands/licensing.rs` | `license_activate`, `license_sumar_clave`, `license_check_now`, `license_clear_state`… |
| Pulso | `jobs/registro.rs::licencia` | Cada 6 h (`MainOperativa`), emite `license:changed` |
| Estructura de la base central | `…/src/server/central/migraciones/` | Sus migraciones, que aplica el objeto `BaseCentral`; el esquema que dan, en `…/central/esquema.snapshot.sql` |
| La base central en sí | `…/src/domains/admin/central.ts` + `pnpm central:*` | Cómo está, sus copias, restaurarla y volver a un instante ([restaurar-la-central.md](../guias/restaurar-la-central.md)) |

---

## La clave y la licencia

- **Formato**: `TPV-XXXXX-XXXXX-XXXXX-XXXXX` en base32 Crockford, con `crypto.getRandomValues`. En la
  base se guarda `sha256(clave)` (único, por donde se busca) y la clave cifrada con
  `LICENSE_STORE_KEY` (para reenviarla). Nunca en claro ni en logs.
- **Lo que se teclea se pasa a la forma canónica** antes de nada: minúsculas, espacios, guiones de
  más o de menos, el prefijo ausente y las confusiones de Crockford (O → 0, I y L → 1). La misma regla
  en la Main (`clave_canonica`, `tpv-domain/src/licensing.rs`), que rechaza una clave mal escrita sin
  ir a la red, en el worker (`normalizeLicenseKey`) y en la pantalla (`claveCanonica`), que avisa al
  escribirla; las tres recorren `crates/tpv-domain/src/clave_licencia_casos.json`, que lleva también
  el texto que se enseña (LIC-INC-01).
- **Tabla `licenses`**: `status` (`issued`, `active`, `revoked`, `redeemed`), `disabled`, `plan`
  (`standard`), `term_months`, `origin` (`stripe` | `manual`), `issued_at_ms`, `activated_at_ms`,
  `expires_at_ms`, `main_device_id`, `tenant_id`, `customer_email` (obligatorio: es a donde va el
  código de cambio de equipo), datos del cliente de Stripe, `redeemed_into_license_id` y
  `key_email_sent_at_ms`.
- **`redeemed` es una clave canjeada**: su tiempo se sumó a otra licencia
  (`redeemed_into_license_id`) y ella se queda sin Main, sin negocio y sin caducidad. No se activa
  ni se canjea otra vez, y no vuelve a `issued` (AUD-07).
- **El reloj arranca en la primera activación**, no en la compra: al emitir, `expires_at_ms` es
  `NULL`.

## Comprar

`POST /v1/stripe/webhook`. Barreras, en orden:

1. Firma HMAC-SHA256 de Stripe sobre el cuerpo **crudo**, comparación de tiempo constante.
2. El timestamp de la firma no se desvía más de 5 minutos.
3. Idempotencia por `event.id` (`webhook_events`): un evento procesado bien no se repite; uno que
   falló sí, y por eso se contestó con un error. Apuntar el fallo es otra escritura en la central
   (`markWebhookProcessed`), y lo que queda depende de que conteste:
   - Si contesta (la operación falló por otra cosa, o la central no la atendió y a esto sí, un fallo
     pasajero), el motivo queda en `webhook_events.error_text`: el mensaje del error, que, si es la
     central la que no ha atendido, es su identificador (`hub_unavailable` o `hub_overloaded`), no
     el texto de la plataforma; ése va como causa del error (`e.cause`) a Sentry. Stripe recibe un
     500 (`fulfillment_failed` o `reversal_failed`).
   - Si tampoco contesta (la central caída del todo), no queda nada en `error_text` y el error sube
     al `onError`, que contesta 503
     ([worker.md](worker.md#cuando-no-puede-atender)). Lo mismo si no contesta ya al apuntar el
     evento, antes de procesarlo.

   Con los dos, Stripe reintenta.
4. Idempotencia por sesión de checkout (índice único en `license_payments` por sesión y unidad),
   comprobada dentro de la operación de la central que emite el cobro (`emitirCobro`). Antes de
   preparar las claves se mira con la misma consulta: una sesión ya cumplida sale sin cifrar nada,
   también con `LICENSE_STORE_KEY` inservible.
5. Fail-closed: si una línea no trae `metadata.term_months` en su Price, la cantidad no es un entero
   positivo, la lista de líneas viene paginada o la compra pasa de `MAX_LICENCIAS_POR_COMPRA` (100),
   no se emite nada.

Eventos de pago: `checkout.session.completed` y `checkout.session.async_payment_succeeded` (un
checkout `unpaid` espera al segundo). **Toda compra emite claves nuevas, una por unidad**: comprar 4
del plan anual son 4 licencias de un año, no una de cuatro, porque quien compra varias puede querer
varios locales; quien quiera todo el tiempo en un equipo canjea las claves una tras otra y se suman
(ver [Activar](#activar)). Cada una se registra como cobro `kind='issue'` en `license_payments` con
su `unidad` (1…N), todas en una sola operación de la central (`emitirCobro`,
[worker.md](worker.md#las-operaciones)), y cuando ha entrado van **juntas en un correo**. La clave en
claro no llega a la central: el Worker la prepara antes, y a la operación le pasa su huella y su
cifrado. Si el correo falla la venta sigue: `key_email_sent_at_ms` queda a `NULL` y
`pnpm license:list` las enseña pendientes de `pnpm license:resend`; lo mismo si una entrega de Stripe
encuentra la sesión ya cumplida por otra que no llegó a mandar el correo, y entonces lo avisa en
Sentry (`stripe.correo_de_claves`), con las licencias
([CLAVES-SIN-CORREO](../pendientes.md#claves-sin-correo--las-claves-de-un-cobro-que-no-llegaron-a-salir)). La API de Stripe se llama con la versión fija `2025-09-30.clover` (hace falta
para `customer_details.business_name`).

Hay un único enlace de compra (`CHECKOUT_URL`) para estrenar y para renovar.

### Deshacer un cobro

Eventos `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn` y
`charge.dispute.closed` (hay que suscribirlos en el endpoint del Dashboard de Stripe). Todo en una
operación de la central (`revertirCobro`):

Un cargo puede tener varios cobros, uno por licencia de la compra, y cada uno se trata por su
cuenta:

| Caso | Efecto |
|---|---|
| Reembolso total o disputa **formal** de un **alta** | Licencia revocada, y se avisa al `TenantHub` como al [anular desde la administración](#anular-desde-la-administración). Si ya lo estaba, no se toca ni se avisa; en una disputa, su cobro queda `dispute_ya_revocada` en vez de `dispute` |
| … de una **renovación** (`kind='renewal'`, incluida una clave canjeada) | Se restan sus meses |
| **Consulta del banco** (disputa `warning_*`) o disputa `prevented` | Nada; queda en `admin_audit` como `consulta_sin_efecto` con las licencias de la compra (AUD-45). Si escala, se trata como una disputa formal |
| Reembolso parcial | Nada; queda en `admin_audit` con la licencia de cada cobro de la compra. Stripe no dice cuál se devuelve: se corrige a mano ([abajo](#reembolso-parcial-lo-que-se-hace-a-mano)) |
| Disputa **ganada** | Se deshace lo que revirtió esa disputa, y sólo eso (AUD-08): vuelve el alta cuyo cobro es `dispute` y los meses de la renovación. A un cobro `dispute_ya_revocada` sólo se le quita la marca, y una licencia sin cobro registrado (anterior a LIC-07) no se toca: si la revocó la disputa, se desrevoca a mano |
| Disputa **perdida** | Se queda lo revertido, y se revierte lo que siga sin revertir: una consulta que escaló sin que llegara `funds_withdrawn` |
| Consulta cerrada sin escalar (`warning_closed`) | Nada |
| Cargo sin licencia atribuible | Nada; se audita |

**Disputa formal o consulta.** Una disputa es formal si su `status` es `needs_response`,
`under_review`, `lost`, `appeal_needs_response` o `appeal_under_review` (lista blanca,
`ESTADOS_DE_DISPUTA_FORMAL`): en ellas el dinero ya ha salido. Cualquier otro estado no corta el
servicio. La consulta del banco (*inquiry*, sobre todo de American Express, Discover y Klarna) es
la fase previa a un contracargo: el banco pide información, el dinero no se mueve y, si no escala
en 120 días, Stripe la cierra `warning_closed`, sin «ganada» que deshaga nada
([docs.stripe.com/disputes/how-disputes-work#inquiries](https://docs.stripe.com/disputes/how-disputes-work#inquiries)).
Si escala, la consulta «se convierte en una disputa completa»
([docs.stripe.com/testing](https://docs.stripe.com/testing), `escalate_inquiry_evidence`): el
mismo objeto Dispute pasa a un estado formal, y Stripe lo avisa con `charge.dispute.funds_withdrawn`
([docs.stripe.com/payments/klarna/disputes](https://docs.stripe.com/payments/klarna/disputes)). El
código no depende de que sea el mismo `du_…`: atribuye por el PaymentIntent. Una
disputa formal trae `created` y `funds_withdrawn`, en cualquier orden: revierte el primero que
llegue, y el segundo encuentra el cobro ya marcado (`already_reversed`) y no resta dos veces los
meses de una renovación. Si `funds_withdrawn` no llega, la consulta escalada se revierte al
cerrarse `lost`. `charge.dispute.updated` no se usa: salta con cada prueba que se envía, y Stripe
no lo da como señal de escalado.

Una revocación a mano no la deshace ninguna disputa: ni la que se abre después ni la que ya estaba
abierta, porque revocar pasa sus cobros `dispute` a `dispute_ya_revocada`
([abajo](#anular-desde-la-administración)). Así, tras el reembolso parcial de una compra de varias,
la clave devuelta y revocada a mano no vuelve a `issued` aunque después se gane una disputa del
cargo.

#### Reembolso parcial: lo que se hace a mano

Lo decide el cobro de la unidad devuelta, en `license_payments` (`unidad`, `kind`, `term_months` y
`license_id`, que es la licencia que tiene ahora su tiempo):

- **Un alta que es el único cobro sin devolver de su licencia** (nadie ha canjeado otra clave sobre
  ella): se revoca esa licencia, `pnpm license:revoke -- --id …`.
- **Cualquier otro caso** —una renovación, una clave canjeada (su cobro se movió como `renewal` a la
  licencia que recibió el tiempo) o un alta sobre la que ya se han canjeado otras claves—: se restan
  a esa licencia los meses de la unidad, `pnpm license:shorten -- --id … --months N`. Revocarla
  anularía el negocio entero, con el tiempo que sigue pagado.

Si se compran dos claves y una se canjea sobre la otra, los dos cobros apuntan a la receptora, y la
auditoría del reembolso la lista dos veces: se acorta, no se revoca.

El cargo se atribuye por el historial de cobros, luego por el último cobro de la licencia y, como
último recurso, por el cliente de Stripe **sólo si tiene una única licencia**. La auditoría anota los
días que llevaba activada.

#### Reparar lo que revocó una consulta del banco

Hasta AUD-45 el webhook trataba una consulta como una disputa formal: revocaba el alta (o restaba los
meses de la renovación), marcaba el cobro `dispute` y, al cerrarse `warning_closed`, no deshacía
nada. Lo que quedó así se encuentra en la base central con la auditoría de la reversión y el evento
que la hizo, que guarda el estado con el que llegó la disputa. Se mira en una copia abierta en local
(`pnpm central:copiar`, [restaurar-la-central.md](../guias/restaurar-la-central.md#abrir-una-copia-en-local)),
que sólo lee:

```sql
SELECT a.license_id,
       json_extract(a.detail, '$.accion')                AS accion,       -- revocada | meses_restados
       json_extract(a.detail, '$.term_months')           AS term_months,
       json_extract(w.payload_json, '$.data.object.id')  AS dispute_id,
       json_extract(w.payload_json, '$.data.object.status') AS estado,
       l.status, a.at_ms
FROM admin_audit a
JOIN webhook_events w ON w.event_uid = json_extract(a.detail, '$.event_uid')
JOIN licenses l       ON l.license_id = a.license_id
WHERE a.action = 'dispute'
  AND json_extract(a.detail, '$.accion') IN ('revocada', 'meses_restados')
  AND substr(json_extract(w.payload_json, '$.data.object.status'), 1, 8) = 'warning_'
ORDER BY a.at_ms;
```

Sale de la auditoría y no de `license_payments` para que aparezcan también las licencias sin cobro
registrado (anteriores a LIC-07). Lo prueba `test/consultaDelBanco.test.ts`.

Por cada fila, antes de tocar nada, se mira la disputa (`dispute_id`) en el Dashboard de Stripe: si
ahora es formal (`needs_response`, `under_review`, `lost`…), escaló y la reversión vale; no se
repara. Si sigue siendo consulta o está `warning_closed`:

- **`revocada`** (un alta), si la licencia sigue `revoked` y nadie la ha revocado a mano después
  (en `admin_audit`, ninguna fila `revoke` de esa licencia posterior a `at_ms`):
  `pnpm license:unrevoke -- --id …`. Desrevocar le quita al alta la marca `dispute`, así que un
  reembolso total posterior del cargo vuelve a revocarla, y si la consulta escala después,
  `funds_withdrawn` la revierte como a cualquier disputa formal.
- **`meses_restados`** (una renovación): desrevocar no la toca. Primero se le quita la marca al
  cobro en la base central, desde Data Studio y con una copia hecha antes
  ([worker.md](worker.md#sql-a-mano))
  (`UPDATE license_payments SET reversed_at_ms = NULL, reversed_reason = NULL, reversed_event_uid = NULL
  WHERE license_id = ? AND kind = 'renewal' AND reversed_reason = 'dispute' AND reversed_event_uid = ?`,
  con el `event_uid` de la fila), y después se le devuelven los meses,
  `pnpm license:extend -- --id … --months <term_months>`. En ese orden: con la marca puesta, si la
  consulta escalara, `funds_withdrawn` no restaría los meses devueltos, y ganarla los sumaría otra
  vez.

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

Mal escrita → `invalid_license_key_format` (400), con el mismo texto que da la Main; bien escrita
pero de ninguna licencia → `license_not_found` (404) con su propia frase («No hay ninguna licencia
con esa clave. Revísala.»), no el genérico del código, que es el de un equipo que se ha quedado sin
ella. Revocada → `license_revoked`; caducada **y pasada la
gracia** → `license_expired`. **Una clave sin Main que no esté `issued` → `license_already_used`**
(409, AUD-07): es la que un canje dejó `redeemed`, que tampoco tiene `main_device_id`. Se rechaza
antes de elegir camino, sin negocio, base, fila de equipo, token ni DEK; al equipo que la canjeó se
le dice que su tiempo ya está sumado, y a cualquier otro, que se sumó a otra licencia. Después, uno
de tres caminos según `main_device_id`:

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
- En una operación de la central (`canjearClave`, `server/central/operaciones/canje.ts`), entera o
  nada: comprueba que la licencia elegida sigue siendo la viva de ese equipo
  (`sigueSiendoLaLicenciaDelEquipo`; si se ha anulado o trasladado entretanto, `clave_no_canjeable`
  sin gastar la clave), `canjearLicencia` (`WHERE status='issued'`, y si no gana la carrera contesta
  `license_already_used`), `extendLicense` (suma sobre lo que quedaba, o sobre hoy si ya venció) y
  `reasignarCobrosDeLaClave` (el cobro pasa a la licencia viva como `renewal`, para que un reembolso
  tenga de dónde restar).
- Ni tenant, ni base, ni DEK nuevos. Manda un recibo por correo y responde
  `tiempoSumado: true`; la pantalla enseña «tiempo añadido, vence el X» y espera a que se pulse.

Teclear en el bar 1 la clave que era para el bar 2 le suma el tiempo al bar 1: se ve en el acto. Y
esa clave ya no estrena el bar 2: allí contesta `license_already_used` («Esa clave ya se ha sumado a
otra licencia. Si era para otro local, contacta con soporte.»).

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

Primero **reserva el negocio en la licencia** (`reservarNegocioDeLaClave`, AUD-09): una sola
sentencia que, si la clave sigue sin estrenar (`issued`, sin Main y sin anular), le pone un
`tenant_id` nuevo si no tenía ninguno y devuelve el que tenga. Así todas las peticiones de la misma
clave —una ráfaga, un doble envío, los reintentos tras un fallo— caen en el mismo negocio y en el
mismo `TenantHub`, y ninguna estrena uno propio que la licencia no apunte. Si la clave ya no está sin
estrenar, contesta como quien pierde la carrera (abajo). Reservar no es nacer: el negocio nace cuando
la licencia se activa (`activated_at_ms`).

Después crea el tenant (`ensureTenantExistsMinimal`) y aprovisiona su base en el `TenantHub` del
negocio (`provisionTenantDatabase` → `aprovisionar`: el DO crea el esquema y el administrador
inicial; es idempotente, y con la base ya creada sólo dice que estaba). Entonces
`activateLicenseFirstTime` pone `active`, `activated_at_ms`, `expires_at_ms = ahora + meses` y
`main_device_id`, condicionado a que siga sin activar **y sin estrenar** (`main_device_id IS NULL
AND status = 'issued'`) y a que el negocio sea el reservado: si otro equipo ganó la carrera,
contesta `device_replaced`; si lo que pasó es que otro la canjeó mientras éste aprovisionaba su
base, `license_already_used` (AUD-07). Sólo quien gana da de alta el dispositivo con su clave
pública (`ensureDevice`) y guarda los datos del negocio: el negocio es el mismo para todas, y la
perdedora no deja ni su fila de equipo ni sus datos en el de la ganadora. Un fallo a medias deja la
clave sin estrenar con su negocio reservado (y quizá su base ya creada), y el reintento, de ese
equipo o de otro, vuelve a ese negocio. Si el fallo llega después de apuntar la licencia, el
reintento del mismo equipo entra como el de un equipo que vuelve a su licencia y da de alta su fila.

Un canje suelta el negocio que la clave tuviera reservado (`tenant_id = NULL`): ya no va a nacer. Si
una activación cortada lo llegó a crear, se queda sin licencia que lo apunte; esos negocios, y los
que dejaban las carreras antes de la reserva, se buscan y se retiran desde la administración
([abajo](#anular-desde-la-administración)).

**La base va antes que la licencia, y sólo para un negocio que no ha nacido** (DO-PERDIDA). Una
licencia con `activated_at_ms` es la prueba de que la base de su negocio existió, y con eso se
distingue un objeto vacío porque el negocio no ha nacido de uno que ha perdido su base
([worker.md](worker.md#la-base-del-negocio-dentro-de-su-tenanthub)). Por eso
`activateLicenseFirstTime` va después de aprovisionar, y otro camino que activara una licencia
tendría que hacer lo mismo. Al volver el mismo equipo a su licencia, o en un traslado con su código,
la base se mira antes de gastar el código y de tocar la fila del equipo: si falta, `tenant_db_perdida`
(503) sin hacer nada, y no se crea una vacía en su lugar.

**En un equipo que era de otro negocio** (AUD-06). Con la licencia anulada o trasladada, el equipo ya
no tiene una licencia viva a la que sumar tiempo, así que una clave sin estrenar abre un negocio
nuevo; pero su base local es la del anterior. Si el equipo era la Main (`role = 'tpv'`) de otro
negocio con alguna licencia (esté como esté) y sin retirar, la respuesta lleva `cambioDeEquipo: true`,
igual que un traslado; una Handy no guarda base, y no cuenta. Es un aviso: lo que protege a la Main es el sello de su base (abajo), que no depende de
que esta respuesta llegue.
No cuentan como negocio anterior el que deja a medias una primera activación fallida (no llegó a
tener una licencia activada: sólo cuenta una con `activated_at_ms`, porque una clave sin estrenar
puede tenerlo reservado) ni el retirado (`status = 'deleted'`, lo que deja cada tanda del
E2E, cuyo equipo estrena la siguiente con la carpeta de datos borrada). Sólo se mira en la primera
activación: el equipo que vuelve a la licencia de su negocio conserva su base aunque su fila haya
pasado por otro.

### 3. Cambio de equipo (la licencia ya está en otro)

Exige un código de 6 cifras enviado al **correo de la compra** (`customer_email`):

1. Sin código → `device_change_required` con una pista del correo.
2. `POST /v1/license/device-change/request` manda el código: hash guardado en `license_device_otp`,
   ligado a ese `deviceId`, 10 minutos y 5 intentos, como mucho uno por minuto. Responde siempre lo
   mismo, exista o no la clave.
3. Activar con el código: se verifica (tiempo constante), se consume de forma atómica,
   `reassignMainDevice` cambia la Main y deja su traza en `license_device_swaps` **en un solo lote**
   (entran las dos o ninguna, E7a-1), **conservando el tenant**, y se avisa al `TenantHub` y por correo
   al titular. Si el lote no vuelve con su respuesta, se mira su traza (su `swap_id` es sólo suyo): si
   está, ha entrado, y la ruta sigue con los avisos y `cambioDeEquipo: true`; si no está, o la central
   tampoco contesta a esa lectura, el 503 de siempre y ningún aviso. El código ya está gastado: lo
   que queda está en [TRASLADO-REINTENTO](../pendientes.md#traslado-reintento--un-traslado-de-licencia-que-falla-a-medias).

**Qué pasa con el equipo anterior** (AUD-02). Su fila de `devices` no se toca (sigue con rol `tpv`
y sin revocar): lo que lo deja fuera es la licencia, y no en todas partes a la vez.

- **REST**: `tenantAuth` lo rechaza con `device_replaced`, pero guarda la respuesta 60 s por isolate.
  Una petición suya que caiga en un isolate que lo dio por bueno llega hasta el `TenantHub`, y ahí se
  para: el hub sabe quién es la Main (su tabla, que el aviso del traslado pone al día en el acto) y
  contesta lo mismo, `device_replaced` (`vetoDeMain`, en todas las rutas de un `tpv`). Si la tabla
  todavía no lo sabe porque el aviso no llegó, pasa, como antes: como mucho el minuto que el Worker
  guarda su respuesta, o hasta que algo hace que el hub vuelva a leer quién es la Main; si la
  tabla dice otra Main, el hub pregunta a la base central antes de rechazar, para no dejar fuera a la
  nueva por un aviso perdido. Las pocas rutas de la Main que se ejecutan en el Worker (emparejar,
  dispositivos, reservas de la web) miran la licencia sin caché (`soloLaMainVigente`). El ticket del
  socket también: desde el traslado no recibe ninguno.
- **El socket que tenía abierto**: con la licencia ya cambiada, la ruta avisa al `TenantHub` del
  negocio (`lib/hub.ts::avisarCambioDeLicencia`), que vuelve a leer quién es la Main y le cierra el
  socket. El aviso no nombra a quién echar: si llega tarde, cuando la licencia ya ha vuelto a ese
  equipo, la lectura lo dice y no se le echa. Entre cambiar `main_device_id` y que el hub lea hay
  una llamada: en ese instante sigue dentro. Cerrado, deja de recibir lo del negocio, de poder
  mandar SQL y de contar como Main, y lo que tuviera esperando no entra. Al reconectar se le niega el ticket, lo traduce en un
  `license_check_now` y se bloquea con `device_replaced`, conservando su licencia local.
- **Si ese aviso no llega** (es best-effort) o su lectura no contesta, sigue dentro hasta que pase
  una de dos cosas: que
  salude el equipo nuevo, que lo echa, o la siguiente comprobación del `TenantHub`, que vuelve a
  leer de la base central quién es la Main en cuanto hay actividad en el negocio (una escritura
  suya o de una Handy, un volcado, un evento, el saludo de una Handy, un aviso) y ha pasado un
  minuto desde la última vez. Hasta que vuelve esa lectura puede escribir, recibir y contar como
  Main; entonces se le echa antes de hacer nada más. Sin actividad se queda conectado, y no le llega
  nada del negocio porque no hay nada que entregar. Detalle en
  [sincronizacion.md](sincronizacion.md#quién-es-la-main-dentro-del-tenanthub-aud-02).
- **Si la base central no contesta** o rechaza la consulta cuando el `TenantHub` pregunta, lo que
  sabía se queda como estaba y no se rechaza nada: se vuelve a preguntar al minuto. Es lo que evita
  cortar a la Main en una avería, y deja dentro a un equipo desplazado cuyo cierre no llegó
  mientras dure. Al saludar no: un `tpv` no entra sin que la base central conteste.
- **Las Handy** se quedan sin Main (`main_offline`) cuando se cierra el socket del equipo anterior y
  hasta que el nuevo se conecta y se pone al día. Mientras el anterior siga dentro, no.
- **Lo que tenía sin subir**: lo que no haya mandado cuando se le cierra se queda en su outbox. Lo
  que mandó y la nube le aplicó está en la nube; un lote que todavía esperaba su turno no entra (la
  sesión se vuelve a mirar en el turno del log) y se queda también en el outbox.

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
  de recuperación de una Handy revocada. Activar, no. El guardián devuelve el negocio en el que
  estaba la fila, que deja de saberse en cuanto el alta la muda (AUD-06).
- Entregan la **DEK** del tenant (`getOrCreateTenantFieldDek`, la existente si ya la hay), para que
  un equipo nuevo pueda descifrar la PII del personal.
- Devuelven el token de sesión (JWT HS256 de 30 días) y `cambioDeEquipo`. **Que la licencia viene de
  otro equipo sólo lo sabe el servidor**, y no depende de que se haya escrito un código: con
  `cambioDeEquipo`, la base del mismo negocio es de antes del traslado y se reconstruye desde la nube
  ([recuperacion.md](recuperacion.md)).

### Una base sólo se usa con la licencia de su negocio

De qué negocio es una base lo dice ella misma: su **sello**, la tabla local `_Negocio` (migración
`0002`), que viaja en cada copia. `tpv_domain::licensing::que_hacer_con_la_base` compara el sello con
el negocio de la licencia y es la misma regla en los tres sitios donde se mira: al activar, al abrir
la base (`connection::init_main_db`) y al restaurar o importar una copia
([recuperacion.md](recuperacion.md#una-base-sólo-se-usa-con-la-licencia-de-su-negocio)).

| La base | La licencia viene de otro equipo | Qué se hace |
|---|---|---|
| Lleva el sello del negocio de la licencia | No | Se usa |
| No lleva sello (recién creada, o anterior a los sellos) | No | Se sella con ese negocio y se usa |
| Lleva su sello, o ninguno | Sí | Se marca el traslado y se reconstruye desde la nube |
| Lleva el sello de otro negocio, o no se deja leer | Da igual | La licencia queda pendiente, el TPV se reinicia y el arranque aparta la base entera antes de aplicarla |

`activate` (el caso de uso), con la respuesta de la nube en la mano: primero contrasta lo concedido
con lo pedido (AUD-01, `comprobar_concesion`: quien pidió sólo sumar espera una suma, y una suma no
cambia de negocio; si no, no toca nada). Después decide con el sello:

- **otro negocio**: guarda lo concedido **como pendiente** (`guardar_pendiente`: el token y la DEK en
  entradas aparte del almacén de secretos, el estado en `license_state.pending.json`, el último), sin
  tocar la licencia vigente, anota el cambio (`AppData/cambio-de-negocio`) y contesta `reinicia`. El
  comando pide a Tauri que reinicie el TPV a los cuatro segundos, y hasta entonces todo sigue siendo
  del negocio anterior: la licencia, el token y la DEK vigentes son los suyos. Lo aplica el arranque,
  ése o cualquiera posterior si el reinicio no llega (`aplicar_cambio_de_negocio_pendiente`):
  aparta lo del equipo, pasa lo pendiente a vigente (`aplicar_pendiente`) y quita la anotación, en
  ese orden y antes de abrir nada
  ([recuperacion.md](recuperacion.md#una-base-sólo-se-usa-con-la-licencia-de-su-negocio));
- **el mismo negocio, o una base sin sello**: descarta lo que hubiera pendiente sin anotar, sella la
  base (nunca encima de un sello distinto: eso es un error) o marca el traslado, y guarda las
  credenciales (`guardar_credenciales`: el token y la DEK) y, lo último, `license_state.json`.

Las activaciones y los canjes (`sumar_clave`) van de uno en uno en todo el proceso: un cerrojo del
caso de uso cubre la petición a la nube (lo concedido espera en el adaptador, en un solo sitio), la
decisión, el sello y lo que se guarda. Y con un cambio de negocio anotado no se activa ni se canjea
nada: se rechaza antes de pedir nada a la nube, y lo que hay que hacer es reiniciar.

`activar_remoto` no guarda nada: lo concedido espera en el adaptador a que el caso de uso decida
dónde va. No necesita saber qué licencia se borró ni que el servidor avise: lo que decide está en la
base. Un corte en cualquier punto deja o la licencia de antes o el cambio entero pendiente; repetir
una activación cortada antes de anotar el cambio llega al mismo sitio. `sumar_clave` hace la misma comprobación de AUD-01 antes de
guardar nada.

Las credenciales guardadas también dicen de qué negocio son, y no se usan con otro:

- en modo `tpv`, la Main sólo firma con un token cuyo `tenantId` sea el de su licencia
  (`comprobar_negocio_del_token`), y `/status` no se consulta con uno ajeno; entre guardar el token
  de una licencia y guardar la licencia (una activación o un arranque cortados) no sale nada firmado;
- una subida de imagen lleva el negocio con el que empezó y cada intento comprueba que el token con
  el que firma es de ese negocio;
- la DEK se guarda ligada a su negocio (`set_field_dek_de`) y sólo se entrega para el sello de la
  base que se cifra. Si no se puede guardar, la que hubiera no se usa: se trabaja sin cifrar antes que
  con la clave de otro negocio. Una DEK guardada antes de ligarlas no dice de quién es y no se usa
  hasta la siguiente activación.

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
a activar» (`clear_state`), que anota el motivo para que la pantalla de activación lo explique. La
pantalla de bloqueo y la de activación avisan antes de que activar otra licencia aparta los datos
del equipo; no lo impiden.
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
La **hora del negocio** —ventas, fichajes, caja, registros de facturación, `x-client-now`— sigue
siendo la del equipo, a propósito: corregirla de golpe podría fechar una factura antes que la anterior
([0004](../decisiones/0004-la-hora-la-pone-quien-escribe.md)).

#### El aviso del reloj desfasado (RELOJ-01)

Lo que se hace con ella es avisar. `reloj::desfase_medido_ms()` da el último desfase medido, o nada
si este proceso todavía no ha tenido una respuesta del worker con la que medirlo (el 0 de arranque no
es una medida). Lo expone el comando `reloj_desfase` (`commands/reloj.rs`, DTO `DesfaseReloj`), sin
sesión y de sólo lectura: no firma, no sale a la red, no escribe. La franja `AvisoReloj`
(`app/arranque/`, hermana de `AvisoCaducidad` en `AppBoot`) lo lee al montar y cada minuto, en la Main
y en la Handy y también antes del login, y aparece cuando la hora del equipo se aparta **5 minutos o
más**: dice cuánto va adelantada o atrasada, que los tickets y la caja salen con esa hora y cómo
ajustarla (sincronizándola con la hora de Internet: en Windows 10 y 11, Configuración → Hora e idioma
→ Fecha y hora → «Sincronizar ahora»; en Windows 7, Panel de control → Fecha y hora → Hora de
Internet; en el teléfono, la fecha y la hora automáticas). No corrige nada ni toca el cobro. La medida
se renueva sola con el tráfico que ya hay: en la Main, al menos la consulta de interruptores (job
`interruptores`, cada 5 minutos); en la Handy, cada lectura o escritura. Con la medida se guardan la
hora del sistema y el reloj monótono de ese momento: si después la hora del sistema avanza más de un
minuto más o menos que el monótono, alguien la ha cambiado (o el equipo ha estado suspendido) y la
medida deja de valer hasta la siguiente. Así, quien pone el equipo en hora ve irse la franja en la
lectura siguiente, sin esperar a otra respuesta de la nube. Qué dice y a partir de cuánto, en
`relojDesfasado.ts` y `test/relojDesfasado.test.ts`.

## Anular desde la administración

`POST /v1/admin/licenses/:id/revoke` revoca y, en la misma operación de la central (`revocarAMano`),
hace suya la revocación (`atribuirRevocacionAMano`): si una disputa abierta ya había revocado el alta, su cobro pasa de
`dispute` a `dispute_ya_revocada`, y ganarla ya no la reactiva (AUD-08). Después, como best-effort y
si no estaba ya revocada, avisa por RPC al `TenantHub` del tenant (`lib/hub.ts::avisarCambioDeLicencia`
→ `releerMain`), que vuelve a leer quién es la Main (con la licencia anulada, nadie) y le cierra el
socket a la que había; si el DO no contesta, la revocación sigue hecha. El cliente reconecta, recibe
un 403, lo traduce en un `license_check_now` y se bloquea en el acto, sin esperar al job. Las Handy
no se cierran a mano: el DO
las congela al irse la Main. **Caducar no empuja**: se nota en la siguiente comprobación.

Hacen lo mismo las otras dos puertas que le quitan la licencia a una Main (AUD-02): el
[traslado a otro equipo](#3-cambio-de-equipo-la-licencia-ya-está-en-otro), con el equipo anterior, y
el webhook de Stripe cuando un reembolso o una disputa anulan un alta (una renovación devuelta sólo
resta meses, y eso es caducar; una que ya estaba revocada no avisa). Ninguna nombra a quién echar: el aviso hace que el hub relea en el
acto, y echa a la sesión `tpv` que no sea la Main que resulte. Así un aviso que llega tarde —el de un
traslado B→A después de que la licencia haya vuelto a B, o el de una anulación después de
deshacerla— no echa a la Main que ha vuelto a serlo. Si el aviso no llega, o su lectura no contesta,
el hub lo corrige por su cuenta en cuanto hay actividad: como mucho un minuto después de la última
vez vuelve a leer quién es la Main de la licencia sin anular, y echa a la sesión `tpv` que ya no lo
sea ([sincronizacion.md](sincronizacion.md#quién-es-la-main-dentro-del-tenanthub-aud-02)). La baja
de un dispositivo, en cambio, le cierra sus sockets sin condición (`cerrarSocketsDelDispositivo`).
Retirar los negocios del E2E no pasa por ese aviso: al borrar su `TenantHub` se cierran las sesiones
que siguieran vivas.

| Operación | Ruta | CLI |
|---|---|---|
| Emitir | `POST /v1/admin/licenses` | `pnpm license:issue -- --term 12 --email … --name … [--send-key]` |
| Listar | `GET /v1/admin/licenses` | `pnpm license:list` |
| Reenviar la clave | `POST …/:id/resend-key` | `pnpm license:resend` |
| Revocar | `POST …/:id/revoke` | `pnpm license:revoke -- --id …` |
| Desrevocar | `POST …/:id/unrevoke` (vuelve a `issued` o `active`; una clave canjeada, a `redeemed`). Le quita al alta la marca de una disputa, `dispute` o `dispute_ya_revocada`, para que un reembolso total posterior la vuelva a revocar (AUD-45); la de una renovación se queda, porque desrevocar no devuelve sus meses | `pnpm license:unrevoke -- --id …` |
| Extender | `POST …/:id/extend` | `pnpm license:extend -- --id … --months 12` |
| Acortar | `POST …/:id/shorten` (puede dejarla caducada) | `pnpm license:shorten` |
| Retirar los negocios del E2E | `POST /v1/admin/pruebas/retirar` | — (lo llama el E2E al terminar) |
| Negocios sin licencia (AUD-09) | `POST /v1/admin/negocios-huerfanos` (`{ "borrar": true }` para retirarlos) | `pnpm license:huerfanos [-- --borrar]` |

Una licencia emitida con `pruebas: true` (`origin = 'pruebas'`) es del E2E. Retirar anula las
licencias de pruebas, borra lo que guarda en la nube cada negocio de pruebas (su `TenantHub`, su
agenda de reservas web y sus imágenes:
[worker.md](worker.md#la-base-del-negocio-dentro-de-su-tenanthub)) y lo da por borrado
(`status = 'deleted'`).

Un negocio es de pruebas si todas sus licencias lo son **y** ninguna clave que no lo sea se ha
canjeado sobre una de ellas: una clave canjeada no lleva negocio (suma su tiempo a la licencia que
apunta), así que se sigue hasta el negocio de ésa. Un negocio con cualquier otra licencia, o con
tiempo de una clave de verdad, no se toca. Se vuelve a mirar negocio a negocio, justo antes de
borrar: lo que se borra no se deshace. **Las licencias se anulan antes de borrar nada**, en una
sentencia que sólo toca las de los negocios que en ese instante son de pruebas: el canje comprueba
dentro de su transacción que la licencia sigue viva, así que una clave de verdad que llegue mientras
se retira o entró antes (y el negocio ya no es de pruebas: ni se anula ni se borra) o ya no encuentra
licencia y no se gasta. Y un negocio sólo se borra si todas sus licencias siguen anuladas cuando le
llega el turno: si alguien desanula una mientras tanto, se deja como está. Cada llamada retira siete como mucho (son varias peticiones salientes por
negocio) y dice si quedan más. Un negocio que una licencia de pruebas sólo tenía reservado y que no
llegó a tener fila en `tenants` se da por borrado con una fila nueva, para que no vuelva a salir.

**Negocios huérfanos** (AUD-09, `domains/admin/huerfanos.ts`): los que ninguna licencia apunta,
esté como esté, sin retirar y creados hace más de un día. Los dejaban las activaciones que perdían
la carrera por una clave, o que se reintentaban, cuando cada petición estrenaba su negocio; hoy sólo
sale uno si una clave reservada se canjea después de que una activación cortada creara su negocio.
**Sin `borrar: true` sólo los lista**, con cuántas filas de `devices` apuntan a cada uno; con él,
vacía su `TenantHub` (`borrarTodo`) y lo da por borrado, volviendo a mirar cada negocio justo antes.
No toca el de una licencia viva, caducada, anulada o trasladada, ni el que una clave sin estrenar
tiene reservado, ni los del E2E (llevan su licencia), ni uno recién creado (puede ser una activación
en curso). Ningún otro camino crea negocios, así que uno sin licencia sólo sale de ahí o de que se
haya borrado a mano en la base central la licencia de uno de verdad: por eso se mira la lista antes
de borrar. Cada llamada retira doce como mucho y dice si quedan más.

Todas exigen `ADMIN_API_TOKEN` (comparación de tiempo constante; sin el secreto la ruta responde 503)
y quedan en `admin_audit`. El CLI lee el token de la variable de entorno `ADMIN_API_TOKEN`. Si la
nube no puede atender (un 503 `external`), el CLI no repite nada: dice que no se sabe si el cambio ha
entrado y que se compruebe antes de repetirlo, porque un `extend` o un `shorten` repetido se aplicaría
dos veces.

La base central en sí se administra con el mismo token y el mismo CLI (`pnpm central:*`): cómo está,
sus copias, restaurarla y volver a un instante. Lo que la cambia pide `--si`, y queda en Axiom
(`central_administrada`), no en `admin_audit`, que es una tabla de la propia central: el
procedimiento, en [restaurar-la-central.md](../guias/restaurar-la-central.md).

| Operación | Ruta | CLI |
|---|---|---|
| Cómo está | `GET /v1/admin/central/estado` | `pnpm central:estado` |
| Sus copias | `GET /v1/admin/central/copias` | `pnpm central:copias` |
| Una copia ahora | `POST /v1/admin/central/copiar-ahora` | `pnpm central:copiar` |
| Darle esquema, o restaurarla desde una copia (sólo sin aprovisionar) | `POST /v1/admin/central/aprovisionar` | `pnpm central:aprovisionar -- [--copia <clave>] --si` |
| Volver a un instante o a un marcador, o aplicar una vuelta preparada | `POST /v1/admin/central/volver` | `pnpm central:volver -- (--instante <fecha ISO> \| --marcador <m> \| --reiniciar <deshacer>) --si` |

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

Cada licencia va por su cuenta (E7a-7): si la central falla con una, al poner o al soltar su marca,
cuenta entre los `fallidos` del resumen del cron y el ciclo sigue con las demás. Si es que la central
no ha podido atender, queda como en el resto del Worker (`registrarSinLaCentral`): su
`central_no_disponible` en Axiom, con `metodo` `cron`, y Sentry (`cron.license_expiry`) sólo si no es
carga ni un fallo pasajero; cualquier otro fallo va a Sentry. **Con la central saturada, el ciclo se
corta**: las que faltan cuentan como fallidas, sin más viajes a una central que no atiende, y se
avisan al día siguiente. Si la marca no llegó a ponerse, su aviso sale al día siguiente; si se quedó
puesta, ese peldaño no sale ([AVISO-CADUCIDAD](../pendientes.md#aviso-caducidad--un-aviso-de-caducidad-que-no-sale-nunca)).

## Lo que guarda el equipo

| Qué | Dónde |
|---|---|
| `device_id` y clave privada ed25519 del dispositivo | Almacén de secretos: keyring del sistema en escritorio, Android Keystore (AES-GCM) en la Handy |
| Estado de la licencia (`tenant_id`, `device_id`, token, estado, caducidad, última comprobación) | `AppData/license_state.json` |
| DEK de la PII del personal, con el negocio al que pertenece | Almacén de secretos (y en la base central, cifrada con `LICENSE_STORE_KEY`) |
| De qué negocio es la base local | Su sello, `_Negocio`, dentro de `data.db` y de cada copia |
| La licencia de otro negocio que espera al reinicio | Su token y su DEK en entradas aparte del almacén de secretos; su estado en `AppData/license_state.pending.json`. La aplica el arranque |

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
| `LICENSE_JWT_SECRET` | Tokens de sesión. También la clave de los HMAC de los códigos por correo y de la huella de la conexión de un alta web (RW-ALTAS): rotarlo invalida los códigos en vuelo y pone a cero el tope de altas por conexión del día |
| `LICENSE_STORE_KEY` (+ `LICENSE_STORE_KEY_ID`) | Cifrar en reposo claves y DEK (`server/crypto.ts`). Global: perderla deja la PII de todos irrecuperable. **No se regenera nunca**: se guarda en el gestor de contraseñas el día que se crea, porque Cloudflare no deja volver a leerla |
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
descifra un canario y contesta 503 (ver [worker.md](worker.md#salud-y-vigilancia-externa)). Las DEK y las
claves de licencia no tienen arreglo sin la clave buena.

Stripe: un producto con un Price *one-time* por duración, cada uno con `metadata.term_months`, el
enlace de compra con «recopilar email», y el webhook en
`https://tpv-api.altarialights.workers.dev/v1/stripe/webhook` con los seis eventos de arriba (los dos de
[Comprar](#comprar) y los cuatro de [Deshacer un cobro](#deshacer-un-cobro)). Pagar
con Checkout alojado deja los datos de tarjeta fuera de nuestros servidores.

## Al tocar esto

- **La estructura de la base central se cambia con una migración nueva** en
  `src/server/central/migraciones/` (registrada en `migraciones.ts`), aditiva y en un despliegue
  **anterior** al del código que la usa: durante un despliegue conviven el código de antes y el de
  ahora a los dos lados del RPC ([worker.md](worker.md#su-esquema-migraciones-en-código)).
- **Lo que escribe licencias o cobros en más de una sentencia es una operación de la central**
  (`server/central/operaciones/`), síncrona y entera o nada; el correo, Stripe y el aviso al
  `TenantHub` van antes o después, en la ruta ([worker.md](worker.md#las-operaciones)).
- El correo de recuperación del PIN (LOGIN-07/08) vive en la misma base pero es otra cosa: ver
  [permisos.md](permisos.md#recuperar-el-pin).
