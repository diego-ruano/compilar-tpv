# Plan — Sistema de licencias propio (retirada de Lemon Squeezy + Stripe)

> **Estado:** EN EJECUCIÓN.
> · **Fase 0 (preparación del cliente) — ✅ hecha** (`a610d9a`): la política del gate se sacó del
>   adaptador a `tpv-domain::licensing`, se unificó el host de la nube en una constante, se retiró el
>   comando duplicado `license_read_state_for_ui` y los alias muertos de `LicenseActivateInput`.
>   El cliente ya está listo para recibir la firma ed25519 y el enforcement de `expires_at` sin
>   tocar infraestructura.
> · **Worker (fases 1+2) — ✅ hecho**: modelo propio, emisión (Stripe + admin/CLI), activación con
>   `main_device_id` + OTP de cambio de dispositivo, `/status` firmado ed25519, `/refresh`, fuera
>   Lemon. El worker se auto-provisiona el esquema. `typecheck` verde. **Sin desplegar** (va junto a
>   la fase 3).
> · **Cliente Rust (fase 3) — ✅ hecho**: clave pública pineada + verificación de la firma en
>   `consultar_estado`, enforcement de `expires_at` vía estado firmado, clasificación de errores con
>   `/refresh` transparente, flujo de OTP de cambio de dispositivo end-to-end (comando + UI mínima en
>   AppBoot). `cargo build` + `cargo test` + `tsc` verdes.
> · **Pendiente de ti**: secretos, `DROP` de las 3 tablas viejas y config de Stripe (§16). Luego
>   desplegar worker **y** app juntos.
> **Fecha:** 2026-07-09 (actualizado 2026-07-14) · **Rama:** `main`
> **Ámbito:** subsistema de **licencias** (activación, gate, cobro, alta manual). El **pairing** de
> Handy y la **sincronización** (§9 de [CLAUDE.md](../CLAUDE.md)) se mantienen intactos y solo se
> mencionan donde comparten cripto/identidad de dispositivo.

---

## 0. Decisiones tomadas (con el responsable)

| Decisión | Elección | Consecuencia de diseño |
|---|---|---|
| **Modelo de cobro** | **Duración fija (pago único)**: 1 / 3 / 12 meses | Webhook principal `checkout.session.completed`. Sin facturación recurrente que reconciliar. Renovar = nuevo pago (extiende la licencia). |
| **Al caducar** | **Aviso 7 días + gracia 3 días** | El servidor calcula `warn`/`grace`/`blocked` sobre `expires_at`. Banner de aviso los 7 días previos; 3 días de gracia tras caducar (el TPV sigue abierto, banner rojo); luego bloqueo. Independiente de la gracia **offline** (red) de 48 h ya existente. |
| **Alta manual** | **Endpoint admin protegido + CLI interno** | Sin panel web público. Un endpoint con `ADMIN_API_TOKEN` (comparación *timing-safe*) minta/lista/revoca/extiende licencias; lo invoca un script de Node (`pnpm license:*`) que ejecuta el admin. Mínima superficie de ataque. |
| **Identidad y cambio de dispositivo** | **Activación verificada por email (OTP)** | La licencia se liga a **un único Main** (`main_device_id`). Activar en un equipo distinto exige un **código de 6 dígitos enviado al `customer_email`** de la licencia: el cliente migra solo (sirve con el PC muerto o robado), pero traspasar la licencia exige entregar también el buzón. El Main anterior se bloquea en su siguiente `/status`. Cierra el bug de asientos ilimitados (#3) sin generar carga de soporte. Ver [§6.4](#64-cambio-de-dispositivo-otp). |
| **OTP: cuándo** | **Solo al cambiar de dispositivo** | La 1ª activación va directa (la clave acaba de llegar por email a esa misma persona). El código solo se exige si la licencia ya está ligada a otro `main_device_id`. |
| **Email de la licencia** | **Obligatorio al emitir** | `customer_email` es `NOT NULL`: sin él no habría recuperación autoservicio. Stripe siempre lo aporta; el CLI lo exige. El flag `--send-key` decide solo si **además** se le manda la clave por correo. |
| **Mapeo precio → duración** | **`metadata.term_months` en el Price de Stripe** | Se pueden crear o cambiar precios sin desplegar el worker. Si un Price llega sin `term_months`, el fulfillment **se rechaza** y queda registrado (fail-closed): nunca se emite una licencia de duración desconocida. |
| **Envío de correo** | **Cloudflare Email Service** (binding `EMAIL`) | ⚠️ Corrige este plan: **no es Resend** (se retiró). Se reutiliza el binding y el patrón de [email.routes.ts](../apps/cloud-worker-licensing/src/domains/email/email.routes.ts). Sin claves de API. |

**Producto único:** una sola “línea” de licencia (`plan = "standard"`) con tres precios (uno por
duración). Si en el futuro hay más planes, el modelo ya lleva la columna `plan`.

**Sin ventana rota:** la migración del esquema borra las columnas `lemon_*`, que el `activate`
actual todavía escribe. Por eso el worker se hace **de una sola tanda** (fases 1 y 2 juntas):
modelo + emisión + `activate` reescrito + `status` firmado + retirada de Lemon en un único
despliegue. Es viable porque **no hay ninguna licencia real en producción** (campo libre).

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Estado actual (inventario de lo que hay que tocar)](#2-estado-actual)
3. [Arquitectura destino](#3-arquitectura-destino)
4. [Modelo de datos (control-plane)](#4-modelo-de-datos)
5. [Seguridad — modelo de amenaza y controles](#5-seguridad)
6. [Flujos detallados](#6-flujos-detallados)
7. [Cambios por capa (borrar / modificar / añadir)](#7-cambios-por-capa)
8. [Configuración de Stripe](#8-configuracion-de-stripe)
9. [Secretos y variables de entorno](#9-secretos)
10. [Plan de implementación por fases](#10-plan-por-fases)
11. [Testing y verificación](#11-testing)
12. [Checklist de retirada de Lemon](#12-checklist-lemon)
13. [Riesgos y decisiones abiertas](#13-riesgos)
14. [Referencias](#14-referencias)
15. [Pendientes (futuro)](#15-pendientes-futuros)
16. [Checklist de operación — lo que tienes que hacer tú](#16-checklist-de-operacion)

---

## 1. Resumen ejecutivo

Hoy el licenciamiento delega la **verdad comercial** en Lemon Squeezy: la activación llama a
`https://api.lemonsqueezy.com/v1/licenses/activate`, y un webhook de Lemon actualiza el estado. La
clave de licencia es de Lemon; nuestra tabla `licenses` está sembrada de columnas `lemon_*`.

El objetivo es que **nosotros seamos la fuente de verdad**: la licencia vive en nuestra base de datos
de control (Turso central), la genera **Stripe** (pago único, 3 duraciones) **o** el **admin a mano**,
y el TPV la valida contra nuestro worker. Además aprovechamos la reescritura para **cerrar la
vulnerabilidad estructural del gate** (LIC-01): hoy la respuesta de licencia solo se confía a TLS; en
el diseño nuevo **el servidor firma el estado con ed25519 y el cliente lo verifica contra una clave
pública pineada en el binario**. Esto elimina el bypass por *proxy local + CA propia / DNS spoofing*.

Cambios de alto nivel:

- **Fuera Lemon**: se borra `lemonActivate`, `verifyLemonSignature`, el webhook `/v1/webhooks/lemon`,
  `LemonWebhookPayload`, el secreto `LEMON_WEBHOOK_SECRET` y **todas** las columnas `lemon_*`.
- **Dentro Stripe** (pago único): un endpoint `POST /v1/stripe/webhook` verifica la firma de Stripe
  (HMAC-SHA256 manual con SubtleCrypto, mismo patrón que ya se usa con Lemon) y, en
  `checkout.session.completed`, **minta o extiende** una licencia y **envía la clave por email**
  (Cloudflare Email Service, ya integrado).
- **Alta manual**: `POST /v1/admin/licenses` (token admin) minta una clave con la duración elegida.
- **Activación endurecida**: la clave la valida nuestro worker contra la BD (ya no Lemon); se
  aprovisiona la BD del tenant (igual que hoy) y se liga la pubkey del dispositivo (anti-copia, igual
  que hoy). El token de sesión (JWT HS256) se **renueva** en `/status` (se elimina la re-activación
  forzada a los 30 días).
- **Gate criptográficamente cerrado**: `/status` devuelve el estado **firmado (ed25519)**; el cliente
  Rust lo verifica contra la **clave pública pineada** antes de conceder acceso, y **comprueba
  `expires_at`** (hoy no se comprueba: bug de enforcement).
- **Caducidad con aviso + gracia**: el servidor marca `warn`/`grace`/`blocked`; el frontend muestra el
  banner y la pantalla de bloqueo con motivos claros. La sección *Configuración → Licencia* pasa a
  mostrar **datos reales**.

> **Nota de honestidad (modelo de amenaza).** Un gate que corre en el cliente es, en última instancia,
> evitable por quien controle por completo la máquina y **parchee el binario** (LIC-04). La firma
> pineada **no** cambia eso, pero **sí** cierra por completo el vector *remoto/red* (servidor falso,
> MITM con CA de confianza, redirección DNS), que es el realista y escalable. “100 % ciberseguro” se
> interpreta aquí como: **ninguna falla de red/servidor permite forjar una licencia válida**, los
> **secretos nunca salen del keyring/worker**, y cada control criptográfico (firma, anti-replay,
> idempotencia, comparación *timing-safe*) es correcto. El anti-tamper del binario es defensa en
> profundidad proporcional, no una garantía absoluta; se documenta como tal en [§5](#5-seguridad).

---

## 2. Estado actual

### 2.1 Mapa de la superficie (lo que existe hoy)

| Capa | Archivo | Rol respecto a licencias |
|---|---|---|
| Worker · rutas | [licensing.routes.ts](../apps/cloud-worker-licensing/src/domains/licensing/licensing.routes.ts) | `POST /v1/license/activate`, `GET /v1/license/status`, `POST /v1/webhooks/lemon` |
| Worker · helpers | [licensing.helpers.ts](../apps/cloud-worker-licensing/src/domains/licensing/licensing.helpers.ts) | `lemonActivate`, `verifyLemonSignature`, `signToken`(HS256 30d), `verifyToken`, `verifyDeviceProof`, `provisionTenantDatabase`, `ensureTenantInitialAdmin` |
| Worker · store | [licenseStore.ts](../apps/cloud-worker-licensing/src/server/licenseStore.ts) | tabla `licenses` con columnas `lemon_*`, `devices`, `tenants`, `license_instances`, `webhook_events`, `license_meta` |
| Worker · tipos | [shared.ts](../apps/cloud-worker-licensing/src/shared.ts) | `LicenseStatus`, `ActivateRequest/Response`, `LemonWebhookPayload` |
| Worker · env | [env.ts](../apps/cloud-worker-licensing/src/env.ts) | `LICENSE_JWT_SECRET`, `LICENSE_STORE_KEY`, `LEMON_WEBHOOK_SECRET`, Turso, email (binding `EMAIL`) |
| Worker · router | [index.ts](../apps/cloud-worker-licensing/src/index.ts) | monta `licenseRoutes` y `lemonWebhookRoutes` |
| Cripto reutilizable | [server/crypto.ts](../apps/cloud-worker-licensing/src/server/crypto.ts) · [utils/crypto.ts](../apps/cloud-worker-licensing/src/server/utils/crypto.ts) · [utils/nobleEd25519.ts](../apps/cloud-worker-licensing/src/server/utils/nobleEd25519.ts) | `aesGcmEncrypt/Decrypt`, `sha256Hex`, verificación/firma ed25519, HMAC *timing-safe* |
| Email | [email.routes.ts](../apps/cloud-worker-licensing/src/domains/email/email.routes.ts) | Cloudflare Email Service ya integrado (binding `EMAIL`, reutilizable para enviar la clave) |
| Cliente Rust · adaptador | [lib.rs](../crates/tpv-infra-licensing/src/lib.rs) | `LicensingAdapter` (activate/gate/`call_status`), `PairingAdapter` |
| Cliente Rust · identidad | [device.rs](../crates/tpv-infra-licensing/src/device.rs) | device-id + keypair ed25519 en keyring, `sign_device_proof` |
| Contratos | [tpv-contracts/src/licensing.rs](../crates/tpv-contracts/src/licensing.rs) | `LicenseLocalState`, `LicenseGateResult`, `LicenseActivateInput` |
| Puerto | [ports/licensing.rs](../crates/tpv-application/src/ports/licensing.rs) | `trait LicensingService` |
| Caso de uso | [use_cases/licensing.rs](../crates/tpv-application/src/use_cases/licensing.rs) | valida entrada, invoca el servicio |
| Comandos Tauri | [commands/licensing.rs](../apps/tpv-main/src-tauri/src/commands/licensing.rs) | `license_get_state/clear_state/gate/check_now/activate` |
| Frontend · gate/activación | [AppBoot.tsx](../apps/tpv-main/src/app/AppBoot.tsx) | formulario de activación inline + gate cada 6 h + `BlockedScreen` |
| Frontend · config | [Licencia.tsx](../apps/tpv-main/src/features/configuracion/sections/Licencia.tsx) | hoy solo un *placeholder* “pendiente de implementar” |

> **Control-plane sin migraciones.** El esquema de la BD central de Turso (`tpvcontrol-altarialights`)
> **se creó a mano** (ver comentario en `licenseStore.ts`: *“Tu schema principal ya lo has creado en
> Turso”*). No hay `migrations/*.sql` para él (las migraciones de `packages/database` son para la BD
> **del tenant**, no para el control-plane). Por eso los cambios de columnas de §4 se aplican con un
> **script SQL de migración versionado** (nuevo) que se ejecuta manualmente contra Turso y se guarda
> en el repo para trazabilidad.

### 2.2 Bugs/carencias que arrastramos y que este rediseño corrige

De las auditorías [AUDITORIA_LICENCIAS.md](AUDITORIA_LICENCIAS.md) y
[licensing-pairing.md](analisis/transversal/licensing-pairing.md):

1. 🔴 **Token 30d sin refresco** → re-activación forzada periódica. *(Se corrige: refresco en `/status`.)*
2. 🟠 **`expires_at` nunca se comprueba** en el gate. *(Se corrige: enforcement + firma.)*
3. 🟠 **Asientos ilimitados** tras la 1ª activación. *(Se corrige: `expires_at` + 1 Main por licencia, ver §5.6.)*
4. 🟠 **Un 4xx transitorio borra la licencia local** (p. ej. reloj desajustado → 401). *(Se corrige: clasificación de errores + `refresh` por device-proof.)*
5. 🟡 **Los datos del formulario de activación se descartan.** *(Se corrige: se persisten en `tenants`/`licenses` o se simplifica el formulario.)*
6. 🟡 **LIC-01: respuesta de licencia no verificada criptográficamente.** *(Se corrige: firma ed25519 pineada — el núcleo del rediseño.)*
7. ⚪ **`LICENSE_JWT_SECRET` con triple propósito.** *(Se recomienda separar; ver §9.)*

Ya **no** aplican (eliminados desde la auditoría de junio): `Activacion.tsx`, `api_get_auth_headers`,
`/v1/license/validate`. La sección `Licencia.tsx` ya no muestra el mock antiguo (es un *placeholder*).

---

## 3. Arquitectura destino

```
                              Pago único (1 / 3 / 12 meses)
   Cliente ──► Stripe Payment Link (hosted, PCI SAQ-A) ──► checkout.session.completed
                                                                    │  (firmado, HMAC-SHA256)
                                                                    ▼
                                            ┌──────────────────────────────────────┐
   Admin ──► CLI ──► POST /v1/admin/licenses│      WORKER  tpv-api (Cloudflare)     │
             (ADMIN_API_TOKEN, timing-safe) │  · verifica firma Stripe (SubtleCrypto)│
                                            │  · minta/extiende licencia (control-DB)│
                                            │  · email de la clave (Email Service)     │
                                            │  · /v1/license/activate  (valida clave)│
                                            │  · /v1/license/status    (FIRMA ed25519)│
                                            │  · /v1/license/refresh   (device-proof)│
                                            └───────────────┬────────────────────────┘
                                                            │
                              Turso central (control-plane):│ licenses · tenants · devices …
                                                            │
   ┌────────────────────────────────────────────────────────▼───────────────┐
   │ TPV MAIN (Tauri + Rust)                                                  │
   │  · activa con la clave  →  guarda license_state.json + token (keyring id)│
   │  · gate: pide /status firmado, VERIFICA con clave pública PINEADA,       │
   │          comprueba expires_at (+ gracia offline 48h / gracia caducidad)  │
   └──────────────────────────────────────────────────────────────────────────┘
```

Principios:

- **Fuente de verdad = control-plane DB.** La clave de licencia es un *ticket* de alta entropía cuyo
  `sha256` está indexado en `licenses`. Presentarla + ligar el dispositivo concede un token de sesión.
- **Dos vías de emisión, un solo almacén.** Stripe (webhook) y admin (endpoint) escriben en la **misma**
  tabla `licenses`; solo cambia `origin` (`'stripe'` | `'manual'`).
- **Reutilización máxima.** Se conservan y reaprovechan: identidad ed25519 en keyring
  ([device.rs](../crates/tpv-infra-licensing/src/device.rs)), device-proof + anti-replay, AES-GCM en
  reposo, `provisionTenantDatabase` + `ensureTenantInitialAdmin`, el JWT HS256 de sesión, el envío de correo, y el
  patrón hexagonal (comando fino → caso de uso → puerto → adaptador).
- **Novedad criptográfica.** Un **par ed25519 de *firma de licencia*** (distinto del de dispositivo):
  la privada vive **solo** en el worker (`LICENSE_SIGNING_PRIVATE_KEY`); la pública se **pinea como
  constante** en el binario Rust. El worker firma el estado; el cliente lo verifica.

---

## 4. Modelo de datos

### 4.1 Tabla `licenses` (destino)

Se **eliminan** las columnas `lemon_*` y se añaden las de Stripe/duración. Propuesta:

```sql
-- CONTROL-PLANE (Turso central). Migración manual versionada en el repo.
CREATE TABLE licenses (
  license_id                 TEXT PRIMARY KEY,      -- uuid v4
  license_key_hash           TEXT NOT NULL UNIQUE,  -- sha256(clave) — indexado
  license_key_enc            TEXT,                  -- AES-GCM(clave) en reposo (soporte/reemisión)
  key_short                  TEXT,                  -- "TPV-…-AB12" para UI (no sensible)

  tenant_id                  TEXT,                  -- NULL hasta la 1ª activación
  main_device_id             TEXT,                  -- el ÚNICO Main que puede usar la licencia
  status                     TEXT NOT NULL,         -- 'issued'|'active'|'expired'|'revoked'
  disabled                   INTEGER NOT NULL DEFAULT 0,

  plan                       TEXT NOT NULL DEFAULT 'standard',
  term_months                INTEGER NOT NULL,      -- 1 | 3 | 12 (duración comprada)
  origin                     TEXT NOT NULL,         -- 'stripe' | 'manual'

  issued_at_ms               INTEGER NOT NULL,      -- emisión (compra o alta manual)
  activated_at_ms            INTEGER,               -- 1ª activación (arranca el reloj)
  expires_at_ms              INTEGER,               -- caducidad ABSOLUTA (fuente de verdad del gate)

  -- Identidad del cliente (raíz de confianza del cambio de dispositivo, §6.4):
  customer_email             TEXT NOT NULL,         -- OBLIGATORIO: destino del OTP
  customer_name              TEXT,

  -- Enlace Stripe (reemplaza lemon_*):
  stripe_customer_id         TEXT,
  stripe_checkout_session_id TEXT,                  -- idempotencia de fulfillment
  stripe_payment_intent_id   TEXT,
  stripe_price_id            TEXT,

  created_at_ms              INTEGER NOT NULL,
  updated_at_ms              INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_licenses_key_hash ON licenses(license_key_hash);
CREATE INDEX ix_licenses_customer ON licenses(stripe_customer_id);
CREATE INDEX ix_licenses_tenant   ON licenses(tenant_id);
CREATE INDEX ix_licenses_email    ON licenses(customer_email);
```

### 4.1.b Códigos de cambio de dispositivo (OTP)

```sql
-- OTP de un solo uso para reactivar en un equipo distinto (§6.4). Solo se guarda el hash.
CREATE TABLE license_device_otp (
  license_id       TEXT NOT NULL,
  code_hash        TEXT NOT NULL,       -- sha256(código) — nunca en claro
  new_device_id    TEXT NOT NULL,       -- el código solo vale para ESTE dispositivo
  attempts         INTEGER NOT NULL DEFAULT 0,
  expires_at_ms    INTEGER NOT NULL,    -- +10 min
  consumed_at_ms   INTEGER,
  created_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (license_id, new_device_id)
);

-- Traza de cada cambio de Main (auditoría / detección de abuso).
CREATE TABLE license_device_swaps (
  swap_id        TEXT PRIMARY KEY,
  license_id     TEXT NOT NULL,
  from_device_id TEXT,
  to_device_id   TEXT NOT NULL,
  at_ms          INTEGER NOT NULL
);
```

**Anclaje del reloj (decisión de diseño):** la caducidad **arranca en la 1ª activación**, no en la
compra. Al emitir, `status='issued'`, `expires_at_ms=NULL`. En `activate`, si es la primera vez:
`status='active'`, `activated_at_ms=now`, `expires_at_ms = now + term_months`. Es lo justo para un
modelo “compra la clave y actívala cuando montes el TPV”.

**Renovación (pago único que extiende):** al comprar de nuevo, el webhook busca al cliente por
`stripe_customer_id`:
- Si tiene una licencia **activa** → **extiende**: `expires_at_ms += term_months` (email “renovada
  hasta …”, sin nueva clave). UX ideal: el cliente no reintroduce nada.
- Si no (primera compra o licencia caducada hace mucho) → **minta clave nueva** y la envía por email.
  Al activarla en un TPV que ya tiene licencia, `activate` **suma** el término al `expires_at_ms`
  vigente (o desde `now` si ya venció).

### 4.2 `webhook_events` (idempotencia) — se conserva y generaliza

La tabla `webhook_events` (hoy usada para Lemon) se **reutiliza** para Stripe: guarda `event_uid`
(id del evento de Stripe, único), `event_name`, `payload_json`, `processed_ok`. Es la barrera de
idempotencia recomendada por Stripe (procesar cada `event.id` una sola vez). Se renombra el campo
conceptual pero la estructura vale igual.

### 4.3 Retirada de columnas `lemon_*`

`lemon_license_key_id`, `lemon_order_id`, `lemon_order_item_id`, `lemon_customer_id`,
`lemon_store_id`, `lemon_product_id`, `lemon_created_at`, `lemon_updated_at`, `activation_limit`,
`instances_count` → **DROP**. Como SQLite/libsql soporta `ALTER TABLE … DROP COLUMN` moderno, el
script de migración las elimina; si se prefiere conservar histórico, se puede crear `licenses_v2` y
migrar filas. Recomendación: **DROP** limpio (no hay ventas Lemon reales que preservar).

---

## 5. Seguridad

> Requisito del responsable: *“100 % ciberseguro, sin margen a una sola falla”*. Abajo, el modelo de
> amenaza explícito y el control que cierra cada vector. Donde un vector es **inherentemente** no
> cerrable (gate en cliente), se dice con claridad y se acota su alcance.

### 5.1 Firma de licencia pineada (cierra LIC-01) — el control central

- **Par de claves de *firma de licencia*** (ed25519), **distinto** del par de dispositivo:
  - Privada → secreto de worker `LICENSE_SIGNING_PRIVATE_KEY` (seed de 32 bytes, base64). Nunca sale
    de Cloudflare.
  - Pública → **constante embebida** en el binario Rust
    (`LICENSE_SIGNING_PUBLIC_KEY_B64` en [lib.rs](../crates/tpv-infra-licensing/src/lib.rs)). **Pineada**:
    no se descarga de ningún sitio.
- **`GET /v1/license/status`** devuelve, además del estado, una **aserción firmada**. Se firma una
  cadena **canónica de orden fijo** (no JSON con orden variable), p. ej.:

  ```
  msg = "v1|" + tenant_id + "|" + device_id + "|" + license_id + "|" + status +
        "|" + plan + "|" + (expires_at_ms ?? "") + "|" + issued_at_ms +
        "|" + assertion_expires_at_ms + "|" + client_ts
  sig = ed25519_sign(LICENSE_SIGNING_PRIVATE_KEY, utf8(msg))
  ```

  - `client_ts` = el `X-Device-Ts` que envió el cliente en ESTA petición → **liga la aserción a la
    petición** (anti-replay: no se puede reproducir una aserción vieja de “active”).
  - `assertion_expires_at_ms` = `serverNow + 5 min` → la aserción firmada es efímera.
- **Verificación en el cliente** ([lib.rs](../crates/tpv-infra-licensing/src/lib.rs), `call_status`):
  reconstruye `msg` con los campos recibidos, verifica `sig` con la **pública pineada**
  (`ed25519_dalek::VerifyingKey::verify_strict`), y **solo entonces** confía en `status`/`expires_at`.
  Comprueba además que `client_ts` coincide con el que envió y que la aserción no está caducada.
- **Resultado:** un servidor falso / MITM con CA de confianza / DNS spoofing **no puede** forjar
  `active` (no tiene la privada). El TLS deja de ser la única barrera.

### 5.2 Verificación del webhook de Stripe (sin bajar la guardia)

- Stripe firma con cabecera `Stripe-Signature: t=<unix>,v1=<hmac_sha256_hex>[,v1=…]`.
- Verificación (mismo patrón que `verifyLemonSignature`, con SubtleCrypto, **sin** SDK):
  1. Parsear `t` y **todos** los `v1`.
  2. `signed_payload = t + "." + rawBody` (**cuerpo crudo**, sin reparsear — cuidado con leer el body
     dos veces en Workers; usar `await c.req.raw.text()` una sola vez).
  3. `expected = HMAC_SHA256(STRIPE_WEBHOOK_SECRET, signed_payload)` en hex.
  4. **Comparación *timing-safe*** de `expected` contra cada `v1` (reutilizar `timingSafeEqualHex`).
  5. **Anti-replay:** `abs(now - t) ≤ 300 s` (tolerancia de 5 min de Stripe; **nunca 0**).
- Alternativa válida: SDK oficial `stripe.webhooks.constructEventAsync(rawBody, sig, secret,
  undefined, Stripe.createSubtleCryptoProvider())` — **`Async`** obligatorio en Workers (el
  `SubtleCryptoProvider` no funciona en contexto síncrono). **Recomendación:** verificación manual
  (cero dependencias nuevas, idéntica al patrón que ya existe y auditado). El SDK queda como opción.
- **Idempotencia:** registrar `event.id` en `webhook_events`; si ya está, responder `200` sin
  reprocesar (Stripe reintenta y puede duplicar). Responder `2xx` **rápido**.
- **Fulfillment seguro:** en `checkout.session.completed`, comprobar `payment_status !== 'unpaid'`
  antes de emitir; y hacerlo **idempotente por `stripe_checkout_session_id`** (único en `licenses`),
  porque el handler puede ejecutarse varias veces/concurrentemente. Manejar también
  `checkout.session.async_payment_succeeded` (métodos diferidos).

### 5.3 La clave de licencia

- Formato: `TPV-XXXXX-XXXXX-XXXXX-XXXXX` en **base32 Crockford** (sin `I/O/1/0` ambiguos), ≥ 100 bits
  de entropía, generada con **CSPRNG** (`crypto.getRandomValues`).
- En reposo: `sha256(clave)` (indexado, único) + `AES-GCM(clave)` (reutiliza
  [server/crypto.ts](../apps/cloud-worker-licensing/src/server/crypto.ts)). **Nunca** texto plano.
- En tránsito: solo viaja en la activación (HTTPS). No se loguea (ni entera ni en errores).

### 5.4 Autenticación de dispositivo (se conserva, es sólida)

- Clave privada ed25519 del **dispositivo** en keyring del SO; pubkey ligada a `device_id` en la 1ª
  activación; *mismatch* → error (`device_key_mismatch`, anti-copia).
- **Device-proof** en cada llamada sensible: `sign(ts \n MÉTODO \n path \n sha256(token))`, ventana
  anti-replay 2 min en cliente y worker. Se mantiene igual.

### 5.5 Endpoint admin (alta manual)

- `Authorization: Bearer <ADMIN_API_TOKEN>` con **comparación *timing-safe***; token de ≥ 256 bits en
  secreto de worker; **solo HTTPS**.
- Rate-limit por IP y *audit log* (quién/cuándo/qué licencia) en `webhook_events` o tabla `admin_audit`.
- **Sin panel web** → sin superficie de sesión/CSRF. El CLI lee el token de una variable de entorno
  local del admin, nunca se hardcodea.
- Operaciones: `issue` (minta), `list`, `revoke` (→ `status='revoked'` + corta WS con
  `/v1/device/revoke`), `extend`.

### 5.6 Enforcement de caducidad y asientos

- El gate **comprueba `expires_at_ms`** (hoy no lo hace). El servidor es autoritativo y lo **firma**;
  el cliente lo re-comprueba localmente (funciona offline con el `expires_at` firmado).
- **1 licencia = 1 tenant = 1 TPV Main** (+ Handys ilimitados). Es además un **invariante de
  arquitectura**: el `TenantHub` (DO) asume un único Main por tenant (single-writer de la sync, §9 de
  [CLAUDE.md](../CLAUDE.md)); dos Mains romperían la replicación. Los Handy se emparejan al Main y **no**
  consumen licencia. Esto cierra el “asientos ilimitados” (bug #3) de forma natural.

### 5.7 Higiene de secretos

- Secretos en Cloudflare (`wrangler secret put`), nunca en `wrangler.json` (que es público en el repo).
- **Separar `LICENSE_JWT_SECRET`** (hoy triple propósito: tokens de licencia + HMAC interno + JWT del
  WS) en secretos distintos, para poder rotar sin acoplar dominios (recomendado, no bloqueante).
- **Rotación** de la clave de firma de licencia: el binario puede pinear **dos** claves públicas
  (actual + siguiente) para permitir rotar sin invalidar clientes viejos durante una ventana.
- PCI: con **Stripe Checkout/Payment Links (hosted)** los datos de tarjeta **nunca** tocan nuestros
  servidores → alcance **PCI SAQ-A** (el más simple).

### 5.8 Límite honesto (LIC-04)

El gate decide en el cliente. Quien controle la máquina y **parchee el binario** (saltándose la
verificación de firma) puede usar el TPV sin licencia válida. La firma pineada **no** lo evita; lo que
evita es cualquier ataque **de red/servidor** (el realista y escalable). Inversión anti-tamper
adicional (ofuscación, *integrity checks*) es opcional y proporcional al valor; se documenta el modelo
y no se promete lo imposible.

---

## 6. Flujos detallados

### 6.1 Compra (Stripe, pago único)

```
1. Cliente abre el Payment Link de su duración (1/3/12m).  [3 Prices en Stripe]
2. Paga en la página hosted de Stripe (SAQ-A).
3. Stripe → POST /v1/stripe/webhook  (checkout.session.completed, firmado)
4. Worker: verifica firma + t (≤5min) + idempotencia por event.id.
5. payment_status !== 'unpaid' →
     - retrieve session (expand line_items) para leer price → term_months.
     - ¿cliente ya tiene licencia activa? (stripe_customer_id)
         · sí → extiende expires_at += term  (email "renovada")
         · no → minta clave (CSPRNG) + fila licenses(origin='stripe', status='issued')
                 → email con la clave (Email Service)
6. Responde 200 (rápido).
```

### 6.2 Alta manual (admin)

```
admin$ tpv-license issue --term 12 --email cliente@bar.com --name "Bar La Plaza"
  → POST /v1/admin/licenses  (Bearer ADMIN_API_TOKEN)
  → worker minta clave (origin='manual', status='issued', term_months=12)
  → devuelve { key: "TPV-…", license_id }  (y opcional: email al cliente)
```

### 6.3 Activación (TPV Main)

```
1. Usuario introduce la clave + nombre del negocio en AppBoot.
2. license_activate → POST /v1/license/activate { activationKey, deviceId, devicePubKey, tenantInfo }
3. Worker:
   - sha256(clave) → busca licencia. No existe → error 'license_not_found'.
   - status ∈ {revoked,disabled} → error. status 'expired' → error 'license_expired'.
   - ¿main_device_id?
       · NULL (1ª activación) → sigue: status='active', activated_at=now,
         expires_at = now + term_months, main_device_id = deviceId.
       · == deviceId (re-activación en el MISMO equipo) → OK, idempotente.
       · != deviceId (otro equipo) → NO activa: exige OTP (§6.4).
   - liga pubkey del dispositivo (anti-copia) — igual que hoy.
   - provisiona la BD del tenant (Turso) + admin inicial — igual que hoy.
   - persiste tenantInfo (legal_name/email/phone/country) en tenants — corrige bug #5.
   - firma y devuelve token de sesión (HS256).
4. Cliente guarda license_state.json (tenant_id, device_id, token, status, expires_at).
```

### 6.4 Cambio de dispositivo (OTP)

El cliente cambia de ordenador (se rompió, se lo robaron, lo formateó). **No hace falta el equipo
viejo** y **no hace falta soporte**: basta con su clave y con el buzón al que se emitió la licencia.

```
1. Activa con su clave en el PC nuevo → el worker ve main_device_id != deviceId
   → responde 409 { error: 'device_change_required', emailHint: 'a***@bar.com' }.
2. El TPV pide el código. El cliente pulsa "Enviar código":
   POST /v1/license/device-change/request { activationKey, deviceId }
   → worker: genera 6 dígitos (CSPRNG), guarda sha256 en license_device_otp
     (ligado a ESE deviceId, 10 min, máx 5 intentos), y lo envía a customer_email.
     Responde SIEMPRE 200 con el mismo cuerpo (no filtra si la clave existe).
3. El cliente teclea el código:
   POST /v1/license/activate { activationKey, deviceId, devicePubKey, tenantInfo, deviceChangeCode }
   → worker verifica el OTP (hash, caducidad, intentos, mismo deviceId).
   → OK: main_device_id = deviceId (MISMO tenant_id: conserva su BD y sus datos),
     consume el OTP, registra el swap en license_device_swaps y **avisa por email al titular**
     ("tu TPV se ha activado en un equipo nuevo; si no has sido tú, contáctanos").
4. El Main anterior, en su siguiente /status, ve que ya no es el main_device_id
   → 'device_replaced' → borra su estado local y se bloquea. Un solo escritor, invariante intacto.
```

> **Ojo — los datos no viajan con la licencia.** El cambio de dispositivo recupera la **licencia y
> el tenant**, no necesariamente el contenido: la BD del tenant en Turso solo está poblada si ese
> cliente trabajaba en **modo online** (el outbox replica a la nube). Un cliente en modo offline
> que pierde el PC recupera su licencia, pero su TPV nuevo arranca **vacío**. Pendiente de
> resolver (ver [§15](#15-pendientes-futuros)).

### 6.5 Gate (arranque + cada 6 h + al activar modo online)

```
1. license_gate → GET /v1/license/status (device-proof firmado).
2. Worker devuelve estado + ASERCIÓN FIRMADA (ed25519) + token renovado si procede.
3. Cliente:
   - verifica la firma con la pública PINEADA. Falla → allowed=false (reason='bad_signature').
   - comprueba status=='active' && !disabled && now < expires_at (todo dentro de lo firmado).
   - guarda el token renovado (elimina el muro de los 30 días — bug #1).
4. Errores:
   - red caída / 5xx → gracia OFFLINE 48h (con detección de rollback de reloj) — igual que hoy.
   - 401 por reloj/desfase o token expirado → NO borrar; intentar /v1/license/refresh
     (auth por device-proof) — corrige bug #4.
   - 'license_not_found'/'revoked'/'expired' definitivo → borra estado y bloquea.
5. Caducidad (aviso 7 días + gracia 3 días):
   - now within [expires_at - 7d, expires_at) → allowed=true + warn=true (banner).
   - now within [expires_at, expires_at + 3d) → allowed=true + reason='expiry_grace' (banner rojo).
   - now ≥ expires_at + 3d → allowed=false + reason='expired'.
6. El dispositivo ya no es el Main de la licencia (hubo un cambio, §6.4)
   → allowed=false + reason='device_replaced' → borra el estado local.
```

### 6.6 Renovación / caducidad ya vencida

- Con extensión por `stripe_customer_id`: el cliente vuelve a comprar → el webhook extiende → en el
  siguiente `/status` el TPV ve el nuevo `expires_at` (firmado) y el banner desaparece. Sin re-teclear
  clave.
- Si se emitió clave nueva: el TPV ofrece “Renovar / introducir clave” → `activate` que **suma** el
  término.

### 6.7 Revocación (admin / fraude / reembolso)

```
tpv-license revoke --license-id …  → status='revoked', disabled=1
  + POST /v1/device/revoke (corta WS y marca el dispositivo)
  → próximo /status firmado = revoked → cliente borra estado y bloquea.
```

---

## 7. Cambios por capa

Leyenda: 🟥 **borrar** · 🟨 **modificar** · 🟩 **añadir**.

### 7.1 Worker `tpv-api`

**Licensing (rutas/helpers):**
- 🟥 `licensing.helpers.ts`: `lemonActivate`, `verifyLemonSignature`.
- 🟥 `licensing.routes.ts`: `lemonWebhookRoutes` (todo el bloque `POST /v1/webhooks/lemon`).
- 🟨 `licensing.routes.ts` · `POST /v1/license/activate`: dejar de llamar a Lemon; validar la clave
  contra `licenses` (existencia + `status` + no caducada); setear `activated_at`/`expires_at` en la 1ª
  activación; persistir `tenantInfo`. Mantener `provisionTenantDatabase` + `ensureDevice` +
  `setDevicePubKeyB64IfEmptyOrThrow`.
- 🟨 `licensing.routes.ts` · `GET /v1/license/status`: añadir **aserción firmada ed25519** + **refresco
  del token** + cálculo `warn`/`grace`/`expired` sobre `expires_at`.
- 🟩 `licensing.routes.ts` · `POST /v1/license/refresh`: nuevo; auth por **device-proof** (decodifica
  claims del token aunque esté caducado, verifica proof contra la pubkey guardada), reemite token.
- 🟩 `licensing.routes.ts` · `POST /v1/license/device-change/request`: nuevo (§6.4). Genera el OTP de
  6 dígitos, guarda su `sha256` en `license_device_otp` (ligado al `deviceId` que pide el cambio,
  10 min, máx 5 intentos) y lo envía a `customer_email`. Respuesta **constante** (mismo 200 exista o
  no la clave) para no filtrar qué claves son válidas. Rate-limit por clave/IP.
- 🟨 `licensing.routes.ts` · `POST /v1/license/activate`: acepta `deviceChangeCode` opcional; sin él,
  si `main_device_id` ya apunta a otro equipo → `409 device_change_required`. Con OTP válido:
  reasigna `main_device_id`, registra el swap y **avisa por email al titular**.
- 🟩 `licensing.helpers.ts`: `signLicenseAssertion(env, fields)` (ed25519 con
  `LICENSE_SIGNING_PRIVATE_KEY`, WebCrypto `crypto.subtle.sign({name:'Ed25519'})` o `@noble/ed25519`),
  `computeLicenseState(license, now)` (deriva `active/expired/warn/grace`) y los helpers del OTP
  (`issueDeviceOtp`, `verifyDeviceOtp` — hash + caducidad + intentos, comparación *timing-safe*).

**Stripe (nuevo dominio):**
- 🟩 `src/domains/stripe/stripe.routes.ts`: `POST /v1/stripe/webhook` (verificación manual de firma,
  idempotencia, fulfillment: mint/extend + email).
- 🟩 `src/domains/stripe/stripe.helpers.ts`: `verifyStripeSignature(rawBody, header, secret)`,
  `priceIdToTermMonths(priceId)` (mapa de los 3 Prices → 1/3/12), `retrieveSession(expand line_items)`
  (REST `GET https://api.stripe.com/v1/checkout/sessions/:id` con `Authorization: Bearer
  STRIPE_SECRET_KEY`; sin SDK, form-style como el `lemonActivate` actual).

**Admin (nuevo dominio):**
- 🟩 `src/domains/admin/admin.routes.ts`: `POST /v1/admin/licenses` (issue), `GET /v1/admin/licenses`
  (list), `POST /v1/admin/licenses/:id/revoke`, `POST /v1/admin/licenses/:id/extend`. `email` es
  **obligatorio** en el issue; `sendKey` decide si además se le manda la clave por correo.
- 🟩 `src/middleware/requireAdmin.ts`: Bearer con comparación **timing-safe** contra `ADMIN_API_TOKEN`;
  fail-closed si el secreto no está configurado. 🟨 De paso, `updates.routes.ts` (`checkAdmin`) pasa a
  usarlo: hoy compara el token con `!==` (no *timing-safe*) y mantiene su propio secreto.
- 🟩 `scripts/tpv-license.mjs` (raíz del repo, **fuera** del workspace/Turbo) + scripts de pnpm
  (`license:issue`, `license:list`, `license:revoke`, `license:extend`). Lee `ADMIN_API_TOKEN` del
  entorno del admin; nunca se hardcodea ni se versiona.

**Store / tipos / env / router:**
- 🟨 `licenseStore.ts`: quitar columnas `lemon_*` de `LicenseRow`, del `INSERT`/`ON CONFLICT` de
  `upsertLicenseFromEventOrActivation`; renombrar/reenfocar a `issueLicense`, `extendLicense`,
  `activateLicense`, `getLicenseByHash`, `getLicenseByStripeCustomer`. Mantener `ensureDevice`,
  `setDevicePubKeyB64IfEmptyOrThrow`, `ensureTenantExistsMinimal`, `upsertWebhookEvent`.
- 🟨 `shared.ts`: 🟥 `LemonWebhookPayload`; 🟨 `LicenseStatus` (alinear a
  `issued|active|expired|revoked`); 🟩 tipos de la aserción firmada y de admin.
- 🟨 `env.ts`: 🟥 `LEMON_WEBHOOK_SECRET`; 🟩 `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `LICENSE_SIGNING_PRIVATE_KEY`, `ADMIN_API_TOKEN`.
- 🟨 `index.ts`: 🟥 `lemonWebhookRoutes` (mount + import); 🟩 `app.route("/v1/stripe", stripeRoutes)` y
  `app.route("/v1/admin", adminRoutes)`.
- 🟨 `wrangler.json`: sin cambios de secretos (van por `wrangler secret put`); revisar `vars`.

**Migración de esquema (control-plane):**
- 🟩 `docs/sql/control-plane/2026-07-XX_licencias_propias.sql` (nuevo): `ALTER TABLE licenses DROP
  COLUMN lemon_*`; `ADD COLUMN term_months/origin/issued_at_ms/activated_at_ms/expires_at_ms/
  stripe_*`; índices. Ejecutar a mano contra Turso y versionar.

### 7.2 Cliente Rust (`crates/*`)

- 🟨 [tpv-contracts/src/licensing.rs](../crates/tpv-contracts/src/licensing.rs):
  - `LicenseLocalState`: 🟩 `expires_at_ms: Option<i64>`, `plan`, `warn`/`grace` derivados si se
    quieren cachear. `expires_at` sigue como string informativo.
  - 🟩 `LicenseGateResult`: enriquecer `reason` con `warn`/`expiry_grace`/`expired`/`bad_signature`
    (strings estables — el frontend los compara por igualdad).
  - 🟨 `LicenseActivateInput`: dejar obligatorio `display_name`; el resto (`legal_name/email/phone/
    country`) opcional (ahora **sí** se persisten). Regenerar bindings (`pnpm generate-types`).
- 🟨 [tpv-infra-licensing/src/lib.rs](../crates/tpv-infra-licensing/src/lib.rs):
  - 🟩 `const LICENSE_SIGNING_PUBLIC_KEY_B64` (pineada) + verificación ed25519 en `call_status`.
  - 🟨 `server_allows_use`: añadir chequeo de `expires_at` y de firma. 🟨 `gate_inner`: mapear
    `warn`/`grace`. 🟨 clasificación de errores (no borrar en 401 de reloj/token; llamar a `refresh`).
  - 🟨 unificar `LICENSE_API_BASE`/`TPV_SERVER_BASE` en una sola constante (LIC-06).
- ⬜ [device.rs](../crates/tpv-infra-licensing/src/device.rs): **sin cambios** (identidad y proof se
  reutilizan tal cual).
- 🟨 [ports/licensing.rs](../crates/tpv-application/src/ports/licensing.rs) +
  [use_cases/licensing.rs](../crates/tpv-application/src/use_cases/licensing.rs): 🟩 método `refresh`
  si se expone como comando; validaciones de entrada. Cambios mínimos (la lógica vive en el adaptador).

### 7.3 Comandos Tauri

- 🟨 [commands/licensing.rs](../apps/tpv-main/src-tauri/src/commands/licensing.rs): sin cambios de firma
  para `license_get_state/gate/check_now/activate/clear_state`. 🟩 opcional `license_refresh` (si no se
  hace transparente dentro del gate). Registrar en `main.rs` si se añade.

### 7.4 Frontend

- 🟨 [AppBoot.tsx](../apps/tpv-main/src/app/AppBoot.tsx):
  - Formulario de activación: mantener clave + nombre negocio; el resto de campos pasan a **opcionales**
    (o se recortan) — coherente con que ahora **sí** se guardan (bug #5). `activationValid` se ajusta.
  - `BlockedScreen`: textos por `reason` (`expired`, `revoked`, `bad_signature`, `offline_expired`).
  - 🟩 Banner de aviso de caducidad (`warn` / `expiry_grace`) con CTA “Renovar” (link a la web de
    compra). Reutiliza `UpdateBanner` como patrón visual.
- 🟨 [Licencia.tsx](../apps/tpv-main/src/features/configuracion/sections/Licencia.tsx): cablear a
  `license_get_state` real → mostrar plan, estado, **días restantes**, `expires_at`, `key_short`,
  dispositivo, y botón “Renovar/Introducir clave”. Fin del *placeholder*.

### 7.5 Documentación / config

- 🟨 [CLAUDE.md](../CLAUDE.md): §4.5 y §referencias a licensing → describir Stripe en vez de Lemon.
- 🟨 [BACKLOG.md](analisis/BACKLOG.md): cerrar LIC-01/02/06 al implementarse; enlazar este plan.
- 🟨 [AUDITORIA_LICENCIAS.md](AUDITORIA_LICENCIAS.md) / [licensing-pairing.md](analisis/transversal/licensing-pairing.md):
  nota de “superseded by este plan” (histórico).

---

## 8. Configuración de Stripe

1. **Producto y precios (test primero).** Un producto “TPV — Licencia” con **3 Prices** *one-time*:
   1 mes, 3 meses, 1 año. Guardar los `price_id` → mapear a `term_months` en el worker
   (`priceIdToTermMonths`). Añadir `metadata.term_months` en cada Price como respaldo del mapeo.
2. **Payment Links.** Un Payment Link por Price (o un Pricing Table). Activar **“recopilar email”** y
   **crear/enlazar Customer** (para poder extender por `stripe_customer_id` en renovaciones).
3. **Webhook.** Endpoint `https://tpv-api.altarialights.workers.dev/v1/stripe/webhook`, eventos
   **mínimos** (recomendación oficial de Stripe: solo los necesarios):
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed` (opcional, para marcar fallo)
   Guardar el **signing secret** (`whsec_…`) en `STRIPE_WEBHOOK_SECRET`.
4. **API version.** Fijar explícitamente la usada por el worker (actual: `2025-07-30.basil`) al hacer
   `retrieve` de la sesión, para estabilidad de tipos/campos.
5. **Modo test.** Probar con **Stripe CLI** (`stripe listen --forward-to …/v1/stripe/webhook` y
   `stripe trigger checkout.session.completed`) y tarjetas de prueba antes de `live`.

---

## 9. Secretos

**Añadir (worker, vía `wrangler secret put`):**

| Secreto | Qué es |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` / `sk_test_…` — llamar a la API de Stripe (retrieve session). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` — verificar la firma del webhook. |
| `LICENSE_SIGNING_PRIVATE_KEY` | seed ed25519 (32 bytes, base64) — firmar el estado de licencia. |
| `ADMIN_API_TOKEN` | ≥ 256 bits — auth del endpoint admin (comparación *timing-safe*). |

**Quitar:** `LEMON_WEBHOOK_SECRET`.

**Constante pineada en el binario Rust:** `LICENSE_SIGNING_PUBLIC_KEY_B64` (la pública del par de
firma; **no** es secreto, pero es **integridad crítica** — cambiarla invalida clientes).

**Generar el par de firma (offline, una vez).** Ejemplo con Node + `@noble/ed25519` (o WebCrypto):

```js
import * as ed from "@noble/ed25519";
const priv = ed.utils.randomPrivateKey();          // 32 bytes
const pub  = await ed.getPublicKeyAsync(priv);
const b64  = (u8) => Buffer.from(u8).toString("base64");
console.log("LICENSE_SIGNING_PRIVATE_KEY =", b64(priv)); // → wrangler secret put
console.log("LICENSE_SIGNING_PUBLIC_KEY_B64 =", b64(pub)); // → constante en lib.rs
```

> **Recomendación (LIC / #10):** separar `LICENSE_JWT_SECRET` (tokens de sesión) del HMAC interno y del
> secreto del WS, para rotaciones independientes. No bloqueante para el MVP.

---

## 10. Plan por fases

Orden respetando dependencias del Cargo workspace (contracts → application → infra → app) y
verificando en cada paso (`cargo build`, `cargo test -p tpv-contracts`, `tsc`, `pnpm generate-types`).

**Fase 0 — Preparación (sin tocar producto).**
- Generar el par de firma ed25519. Crear los 3 Prices + Payment Links + webhook en Stripe **test**.
- `wrangler secret put` de los 4 secretos nuevos. Escribir el script SQL de migración del control-plane.

**Fases 1 + 2 — Worker completo (una sola tanda, ver §0).**
Se fusionan porque la migración del esquema rompe el `activate` actual: dejarlas separadas
implicaría desplegar un worker roto entre medias. Orden interno:
1. Migración SQL del control-plane (drop `lemon_*`, nuevas columnas, `license_device_otp`,
   `license_device_swaps`).
2. `licenseStore.ts`: `issueLicense`/`extendLicense`/`activateLicense`/`getLicenseByHash`/
   `getLicenseByStripeCustomer` + helpers del OTP. Fuera todo lo `lemon_*`.
3. `shared.ts` / `env.ts` / `index.ts`: tipos, secretos nuevos, montaje de rutas.
4. Dominio `admin/` (issue/list/revoke/extend) + `requireAdmin` *timing-safe* + CLI. **Primero**,
   porque permite emitir claves y probar el resto end-to-end sin depender de Stripe.
5. `activate` reescrito (validación contra BD, `main_device_id`, OTP de cambio de dispositivo,
   provisión de tenant, persistir tenantInfo) + `device-change/request` + emails.
6. `status` firmado (ed25519) + `warn`/`grace` + refresco de token. Nuevo `refresh` por device-proof.
7. 🟥 Borrar Lemon (`lemonActivate`, `verifyLemonSignature`, `lemonWebhookRoutes`,
   `LemonWebhookPayload`, `LEMON_WEBHOOK_SECRET`).
8. Dominio `stripe/` (webhook + verificación + fulfillment + email). Probar con Stripe CLI.

**Fase 3 — Cliente Rust.**
- Contracts: nuevos campos + `reason`s. `pnpm generate-types`.
- `lib.rs`: pública pineada + verificación de firma + enforcement `expires_at` + clasificación de
  errores + `refresh` + unificar constantes de host. `cargo build` + `cargo test -p tpv-contracts`.

**Fase 4 — Frontend.**
- Ajustar formulario de activación, `BlockedScreen`, banner de caducidad. Cablear `Licencia.tsx` a
  datos reales. `tsc` verde.

**Fase 5 — Verificación end-to-end + go-live.**
- Pruebas de §11 en Stripe **test**. Revisión de seguridad (`/security-review`).
- Cambiar Stripe a **live**, `wrangler secret put` de las claves `live`, desplegar. Validar una compra
  real de bajo importe + activación + gate + renovación.

---

## 11. Testing

**Webhook / firma (Stripe):**
- Firma válida → 200 y licencia creada. Firma manipulada (byte cambiado) → 400, sin efectos.
- `t` fuera de ventana (> 5 min) → rechazo (anti-replay). Reenvío del mismo `event.id` → idempotente
  (una sola licencia). `payment_status: unpaid` → no emite.

**Firma de licencia (gate):**
- Aserción con firma válida → `allowed`. Firma inválida / clave pública equivocada → `bad_signature`,
  bloqueo. Reproducir una aserción vieja (otro `client_ts`) → rechazo por `client_ts`/expiry.
- **Prueba de MITM:** proxy local + CA propia devolviendo `active` **sin** firma válida → el cliente
  **bloquea** (demuestra que se cierra LIC-01).

**Enforcement de caducidad:**
- `now` en ventana de aviso → banner + `allowed`. En gracia → banner rojo + `allowed`. Pasada la
  gracia → bloqueo. Extensión por renovación → desaparece el aviso.

**Resiliencia (regresiones de los bugs):**
- Reloj adelantado/atrasado > 2 min → `refresh` recupera, **no** borra la licencia (bug #4).
- Token de sesión “caducado” → `refresh` reemite; sin muro de 30 días (bug #1).
- Sin red → gracia offline 48 h; rollback de reloj → `clock_rollback_detected`.

**Admin/CLI:**
- Token correcto → emite. Token incorrecto/ausente → 401 (timing-safe). Revoke → siguiente `/status`
  = revoked → cliente bloquea.

**Anti-copia (sin regresión):** activar en un 2º dispositivo con otra pubkey → `device_key_mismatch`.

---

## 12. Checklist de retirada de Lemon

- [ ] `licensing.helpers.ts`: borrar `lemonActivate`, `verifyLemonSignature`.
- [ ] `licensing.routes.ts`: borrar `lemonWebhookRoutes` (`POST /v1/webhooks/lemon`).
- [ ] `index.ts`: quitar import y `app.route("/v1/webhooks", lemonWebhookRoutes)`.
- [ ] `shared.ts`: borrar `LemonWebhookPayload`; alinear `LicenseStatus`.
- [ ] `env.ts`: borrar `LEMON_WEBHOOK_SECRET`. `wrangler secret delete LEMON_WEBHOOK_SECRET`.
- [ ] `licenseStore.ts`: quitar todas las columnas/props `lemon_*` (+ `activation_limit`,
      `instances_count` si no se reutilizan).
- [ ] Control-plane Turso: `ALTER TABLE licenses DROP COLUMN lemon_*` (script versionado).
- [ ] Stripe Dashboard: eliminar la app/webhook de Lemon; revocar la API key de Lemon.
- [ ] Docs: `CLAUDE.md` (§4.5), `BACKLOG.md`, marcar auditorías como *superseded*.
- [ ] `grep -ri "lemon" apps/ crates/ packages/` → **0 resultados** en código (solo histórico en docs).

---

## 13. Riesgos y decisiones abiertas

| Tema | Riesgo / nota | Mitigación / recomendación |
|---|---|---|
| **Reloj del cliente** | El gate depende del reloj local para `expires_at`/gracia; un reloj adelantado “gana” días. | El servidor es autoritativo cuando hay red (firma `serverNow`); offline se tolera con la gracia acotada. Registrar desfases grandes. |
| **Extensión por email vs clave** | Casar renovaciones por `stripe_customer_id` requiere que el Payment Link cree/enlace el Customer. | Activar “crear cliente” en Stripe; *fallback* a clave nueva si no hay match. |
| **Migración destructiva** | `DROP COLUMN lemon_*` es irreversible. | Backup de la tabla `licenses` antes; no hay ventas Lemon reales que preservar. |
| **Rotación de la clave de firma** | Cambiar la pública pineada invalida binarios viejos. | Pinear 2 claves (actual+siguiente) durante la ventana de rotación. |
| **Anti-tamper del binario (LIC-04)** | Inherente a un gate en cliente. | Documentado; invertir en ofuscación solo si el valor lo justifica. |
| **`LICENSE_JWT_SECRET` triple** | Acopla rotaciones (#10). | Separar en 3 secretos (mejora, no bloqueante). |
| **Trials / reembolsos** | No pedidos ahora. | El modelo (`origin`, `status`, `extend`, `revoke`) ya los soporta; añadir cuando se necesiten. |

---

## 14. Referencias

- Stripe — Fulfill orders (Checkout): https://docs.stripe.com/checkout/fulfillment
- Stripe — Receive events / webhooks (best practices, replay, idempotencia): https://docs.stripe.com/webhooks
- Stripe — Resolver errores de verificación de firma: https://docs.stripe.com/webhooks/signature
- Stripe — Checkout Sessions API (retrieve, expand `line_items`, `payment_status`): https://docs.stripe.com/api/checkout/sessions
- Stripe — Metadata en Checkout: https://docs.stripe.com/metadata/use-cases
- Stripe — Versionado de API (Basil, `2025-07-30.basil`): https://docs.stripe.com/api/versioning
- Stripe en edge/Workers — `constructEventAsync` + `SubtleCryptoProvider` (verificación asíncrona):
  https://github.com/stripe/stripe-node/issues/1942
- Cloudflare Workers — cuerpo de request de un solo uso (`tee()`): https://github.com/cloudflare/workers-sdk/issues/2816
- Cliente Rust — `ed25519-dalek` (`VerifyingKey::verify_strict`): https://docs.rs/ed25519-dalek
- Auditorías internas previas: [AUDITORIA_LICENCIAS.md](AUDITORIA_LICENCIAS.md) ·
  [licensing-pairing.md](analisis/transversal/licensing-pairing.md) · [BACKLOG.md](analisis/BACKLOG.md)

---

## 15. Pendientes (futuro)

Trabajo **conscientemente aplazado**. No bloquea el sistema de licencias propio, pero el modelo de
datos se diseña para que estas piezas sean una **ampliación y no una reescritura**.

### 15.1 Cuenta de cliente con contraseña (el modelo “SaaS completo”)

Hoy la raíz de confianza del cambio de dispositivo es **el buzón de correo** (OTP, §6.4). El paso
natural es que la licencia cuelgue de una **cuenta** (email + contraseña) y que activar el TPV sea
**iniciar sesión**. Qué añadiría:

- Recuperación autoservicio sin teclear la clave (solo login).
- Portal del cliente: ver facturas, **renovar**, listar/desvincular dispositivos.
- Casa de forma natural con el `stripe_customer_id` (misma identidad para cobro y acceso).

**Por qué se aplaza:** mete fricción en las pruebas de desarrollo (registro + login en cada
activación) y no aporta seguridad *adicional* frente al OTP por email —el buzón sigue siendo la
raíz de confianza en ambos casos—. Cuando se haga, el `customer_email` ya obligatorio de `licenses`
es la clave de unión: se añade una tabla `accounts` y la licencia pasa a referenciarla, sin tocar
la activación ni el gate.

### 15.2 Recuperación de datos al cambiar de dispositivo (offline → online)

El cambio de dispositivo (§6.4) devuelve **licencia y tenant**, pero los **datos** solo están en la
nube si el cliente trabajaba en **modo online**. Un cliente en offline que pierde el PC recupera la
licencia con la BD vacía.

La solución obvia —“que active el modo online y se suba todo”— **no es viable tal cual**: un negocio
con un año de operación acumula un `_Sync_Outbox` enorme y el primer drenado reventaría (miles de
sentencias por WebSocket, sin control de lotes ni de memoria en el DO). Hace falta diseñar un
**bootstrap masivo** distinto del sync incremental: snapshot comprimido de la BD local → subida en
partes → carga en Turso, con reanudación y sin pasar por el TenantHub.

Mientras tanto: la pantalla de cambio de dispositivo debe **decir la verdad** (“recuperarás tu
licencia; tus datos solo si tenías la sincronización activada”), y conviene empujar el modo online
como recomendado, no como opcional.

---

## 16. Checklist de operación

Lo que **no puede hacer el código por ti**: secretos, esquema de la BD central y configuración de
Stripe. Nada de esto bloquea escribir código, pero **todo** bloquea el despliegue.

> ⛔ **No despliegues el worker suelto.** `GET /v1/license/status` cambia de forma (ahora devuelve
> la aserción firmada) y el cliente Rust actual no sabe leerla: se quedaría sin poder validar. El
> worker y la **Fase 3** (cliente Rust) se despliegan **juntos**.

### 16.1 Secretos del worker

Desde `apps/cloud-worker-licensing/`:

```bash
# 1. Par de firma de licencia (genera el par primero: pnpm license:keypair)
npx wrangler secret put LICENSE_SIGNING_PRIVATE_KEY   # ← la PRIVADA que imprime el script

# 2. Token del CLI de administración (≥ 256 bits)
#    Generar: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put ADMIN_API_TOKEN

# 3. Stripe (empieza en modo TEST)
npx wrangler secret put STRIPE_SECRET_KEY             # sk_test_… / sk_live_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET         # whsec_…

# 4. Fuera el de Lemon
npx wrangler secret delete LEMON_WEBHOOK_SECRET
```

Ya existentes y que **siguen igual**: `LICENSE_JWT_SECRET`, `LICENSE_STORE_KEY`, `TURSO_*`,
`PAIR_PEPPER`, `EMAIL_FROM_ADDRESS`, `RELEASE_ADMIN_TOKEN`, `SENTRY_DSN`, `AXIOM_*`.

**La clave pública** que imprime `pnpm license:keypair` va **pineada en el binario Rust**
(`LICENSE_SIGNING_PUBLIC_KEY_B64` en `crates/tpv-infra-licensing/src/lib.rs`) — eso lo hago yo en la
Fase 3, pero necesito que me pases la pública (no la privada).

### 16.2 Esquema del control-plane (Turso) — **sin migración**

El worker se **auto-provisiona** el esquema nuevo (`ensureLicensingSchema` en `licenseStore.ts`): la
primera petición crea `licenses`, `license_device_otp`, `license_device_swaps`, `admin_audit` y las
columnas de `tenants`. No hay que ejecutar SQL para eso.

Lo único manual, **una vez**: borrar las tablas viejas de Lemon (el `CREATE TABLE IF NOT EXISTS` no
puede reemplazar una `licenses` que ya existe con las columnas `lemon_*`):

```bash
turso db shell tpvcontrol-altarialights < docs/sql/control-plane/2026-07-14_licencias_propias.sql
# (son 3 líneas: DROP de licenses, license_meta, license_instances)
```

Seguro porque no hay licencias reales. Tras esto, la primera llamada al worker reconstruye todo.

### 16.3 Stripe

1. Un producto **“TPV — Licencia”** con **3 Prices** *one-time* (1 mes, 3 meses, 12 meses).
2. En **cada Price**, añadir `metadata.term_months` = `1` / `3` / `12`. ⚠️ Sin esto el webhook
   **rechaza la compra** (fail-closed): es de donde sale la duración.
3. Un **Payment Link** por Price, con **“recopilar email”** y **crear/enlazar Customer** activados
   (sin `customer`, una renovación no puede casarse con la licencia existente y emitiría clave nueva).
4. **Webhook** → `https://tpv-api.altarialights.workers.dev/v1/stripe/webhook`, solo estos eventos:
   `checkout.session.completed` y `checkout.session.async_payment_succeeded`. Copiar el
   `whsec_…` a `STRIPE_WEBHOOK_SECRET`.
5. Probar en test: `stripe listen --forward-to …/v1/stripe/webhook` + `stripe trigger
   checkout.session.completed`.

### 16.4 Uso del CLI

```bash
$env:ADMIN_API_TOKEN = "…"                 # PowerShell (bash: export ADMIN_API_TOKEN="…")

pnpm license:issue  -- --term 12 --email cliente@bar.com --name "Bar La Plaza" --send-key
pnpm license:list
pnpm license:extend -- --id <licenseId> --months 12
pnpm license:revoke -- --id <licenseId>
```
```
