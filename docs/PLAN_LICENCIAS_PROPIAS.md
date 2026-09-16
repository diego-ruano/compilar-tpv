# Sistema de licencias propio (Stripe) — diseño y operación

> **Estado: EN PRODUCCIÓN** (2026-08-15). Las licencias se emiten y validan de verdad: secretos
> puestos, esquema del control-plane aplicado y Stripe configurado y cobrando. Lo que sigue abajo es
> el **diseño** del sistema (modelo de datos, flujos, seguridad), no una lista de tareas.
> **Escrito:** 2026-07-09 · **En producción desde:** 2026-08
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

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
3. [Arquitectura destino](#3-arquitectura-destino)
4. [Modelo de datos (control-plane)](#4-modelo-de-datos)
5. [Seguridad — modelo de amenaza y controles](#5-seguridad)
6. [Flujos detallados](#6-flujos-detallados)
8. [Configuración de Stripe](#8-configuracion-de-stripe)
9. [Secretos y variables de entorno](#9-secretos)
11. [Testing y verificación](#11-testing)
13. [Riesgos y decisiones abiertas](#13-riesgos)
14. [Referencias](#14-referencias)
15. [Pendientes (futuro)](#15-pendientes-futuros)
16. [Operación: secretos, esquema y Stripe (referencia)](#16-checklist-de-operacion)

---

## 1. Resumen ejecutivo

**Nosotros somos la fuente de verdad** de las licencias: viven en nuestra base de datos de control
(Turso central), las genera **Stripe** (pago único, 3 duraciones) **o** el **admin a mano**, y el TPV
las valida contra nuestro worker. El gate está **cerrado criptográficamente** (LIC-01): **el servidor
firma el estado con ed25519 y el cliente lo verifica contra una clave pública pineada en el
binario**, así que un *proxy local + CA propia / DNS spoofing* no puede forjar una licencia.

Piezas:

- **Stripe** (pago único): `POST /v1/stripe/webhook` verifica la firma de Stripe (HMAC-SHA256 manual
  con SubtleCrypto, sin SDK) y, en `checkout.session.completed`, **minta o extiende** una licencia y
  **envía la clave por email** (Cloudflare Email Service).
- **Alta manual**: `POST /v1/admin/licenses` (token admin) minta una clave con la duración elegida.
- **Activación**: la clave la valida nuestro worker contra la BD; se aprovisiona la BD del tenant y
  se liga la pubkey del dispositivo (anti-copia). El token de sesión (JWT HS256) se **renueva** en `/status` (se elimina la re-activación
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

### 4.1 Tabla `licenses`

Qué significa cada columna. La definición exacta que hay en producción (índices incluidos) está en
[`docs/sql/control-plane/esquema-actual.sql`](sql/control-plane/esquema-actual.sql).

```sql
-- CONTROL-PLANE (Turso central).
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

  -- Enlace Stripe:
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

**Reembolso y chargeback (LIC-07):** un cobro puede deshacerse, así que el webhook también
escucha `charge.refunded`, `charge.dispute.created` y `charge.dispute.closed`. La regla depende de
**qué** se devolvió, y eso lo sabe `license_payments` (una fila por cobro cumplido; `licenses` solo
recuerda el último, porque `attachStripeSession` lo sobrescribe en cada renovación):

- **Alta devuelta** → licencia **revocada**.
- **Renovación devuelta** → se **restan** los meses que aportó; el periodo anterior no se toca.
- **Reembolso parcial** → no altera la licencia (es un ajuste): queda en `admin_audit`.
- **Disputa abierta** → se revierte ya, que el dinero ya no está. **Ganada** → se deshace la
  reversión. **Perdida** → se queda revertida.
- Si el cargo no se puede imputar a una licencia, **no se toca nada** y se audita: revocar a ojo la
  de otro cliente sería peor.

La auditoría anota `dias_activada`, que es lo que permite ver de un vistazo si un reembolso se
emitió fuera de la política comercial (devolver solo sin activar o dentro de la primera semana).

⚠️ **Los tres eventos hay que suscribirlos en el endpoint de webhook del Dashboard de Stripe.** El
worker solo recibe lo que esté marcado allí: sin eso, este código no llega a ejecutarse.

### 4.2 `webhook_events` (idempotencia)

Guarda `event_uid` (id del evento de Stripe, único), `event_name`, `payload_json` y `processed_ok`.
Es la barrera de idempotencia recomendada por Stripe (procesar cada `event.id` una sola vez).

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
- Verificación (con SubtleCrypto, **sin** SDK):
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
- **Device-proof** en cada llamada sensible: `sign(ts \n MÉTODO \n path \n sha256(token) \n sha256(cuerpo))`, ventana
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

> **Los datos vuelven por la recuperación, no por la licencia.** El cambio de dispositivo devuelve
> la **licencia y el tenant**; el contenido lo trae la pantalla de recuperación desde la BD del
> tenant en Turso (§9 de [CLAUDE.md](../CLAUDE.md), *Perder la BD local*). Como la Main sincroniza
> siempre que tiene conexión (SYNC-17), la nube tiene todo lo que llegó a subir. Lo único que no
> vuelve es lo que se quedó en el outbox del equipo perdido sin salir.

### 6.5 Gate (arranque + cada 6 h)

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

**Del sistema de licencias (worker, vía `wrangler secret put`):**

| Secreto | Qué es |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` / `sk_test_…` — llamar a la API de Stripe (retrieve session). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` — verificar la firma del webhook. |
| `LICENSE_SIGNING_PRIVATE_KEY` | seed ed25519 (32 bytes, base64) — firmar el estado de licencia. |
| `ADMIN_API_TOKEN` | ≥ 256 bits — auth del endpoint admin (comparación *timing-safe*). |

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

## 13. Riesgos y decisiones abiertas

| Tema | Riesgo / nota | Mitigación / recomendación |
|---|---|---|
| **Reloj del cliente** | El gate depende del reloj local para `expires_at`/gracia; un reloj adelantado “gana” días. | El servidor es autoritativo cuando hay red (firma `serverNow`); offline se tolera con la gracia acotada. Registrar desfases grandes. |
| **Extensión por email vs clave** | Casar renovaciones por `stripe_customer_id` requiere que el Payment Link cree/enlace el Customer. | Activar “crear cliente” en Stripe; *fallback* a clave nueva si no hay match. |
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

---

## 16. Operación: secretos, esquema y Stripe (referencia)

**Ya está todo aplicado en producción.** Se conserva como referencia para reponer un secreto, rotar
la clave de firma o montar un entorno nuevo (ver INFRA-01 en el BACKLOG).

> ⛔ **No despliegues el worker suelto.** `GET /v1/license/status` cambia de forma (ahora devuelve
> la aserción firmada) y el cliente Rust actual no sabe leerla: se quedaría sin poder validar. El
> worker y la **Fase 3** (cliente Rust) se despliegan **juntos**.

### 16.1 Secretos del worker

Desde `apps/cloud-worker-licensing/`:

```bash
# 1. Par de firma de licencia (genera el par primero: pnpm license:keypair)
pnpm exec wrangler secret put LICENSE_SIGNING_PRIVATE_KEY   # ← la PRIVADA que imprime el script

# 2. Token del CLI de administración (≥ 256 bits)
#    Generar: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
pnpm exec wrangler secret put ADMIN_API_TOKEN

# 3. Stripe (empieza en modo TEST)
pnpm exec wrangler secret put STRIPE_SECRET_KEY             # sk_test_… / sk_live_…
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET         # whsec_…
```

Ya existentes y que **siguen igual**: `LICENSE_JWT_SECRET`, `LICENSE_STORE_KEY`, `TURSO_*`,
`PAIR_PEPPER`, `EMAIL_FROM_ADDRESS`, `RELEASE_ADMIN_TOKEN`, `SENTRY_DSN`, `AXIOM_*`.

**La clave pública** que imprime `pnpm license:keypair` va **pineada en el binario Rust**
(`LICENSE_SIGNING_PUBLIC_KEY_B64` en `crates/tpv-infra-licensing/src/lib.rs`) — eso lo hago yo en la
Fase 3, pero necesito que me pases la pública (no la privada).

### 16.2 Esquema del control-plane (Turso)

> Superado. El worker ya **no** crea ni altera tablas de la base central (se quitó
> `ensureLicensingSchema`): su estructura se gestiona a mano en Turso y está fotografiada en
> [`docs/sql/control-plane/esquema-actual.sql`](sql/control-plane/esquema-actual.sql). Las
> migraciones sueltas que se ejecutaron entonces se borraron: la foto recoge su resultado.

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
