# Auditoría end-to-end — Subsistema de Licencias

> **Alcance:** únicamente el flujo de **licencias** (activación, verificación/gate, estado local,
> anti-copia y enforcement). El emparejamiento (pairing) y la sincronización solo se mencionan donde
> tocan la licencia. **No se han modificado archivos**: este documento es solo de conclusiones.
>
> **Fecha:** 2026-06-19 · **Rama:** `main` · **Método:** lectura estática end-to-end (Rust ↔ worker ↔ frontend ↔ schema).

---

## 1. Veredicto general

El subsistema de licencias está **completo y operativo end-to-end**, y correctamente migrado a la
arquitectura hexagonal (comando fino → caso de uso → puerto → adaptador). El núcleo criptográfico
(anti-copia por clave de dispositivo, device-proof firmado, cifrado en reposo de la clave) es
**sólido**. No hay errores que rompan el camino feliz.

Dicho esto, la auditoría detecta **varios huecos de _enforcement_ y de fidelidad de datos** que
conviene decidir conscientemente (no son bugs de compilación; son decisiones de diseño que hoy dejan
la puerta más abierta de lo que aparenta), además de **código muerto y una pantalla que muestra datos
falsos al usuario**.

| # | Severidad | Hallazgo |
|---|-----------|----------|
| 1 | 🔴 Alta | El token JWT caduca a 30 días **sin refresco** → re-activación forzada periódica |
| 2 | 🟠 Media | La **expiración de la suscripción no se aplica** salvo que llegue el webhook de Lemon |
| 3 | 🟠 Media | El **límite de asientos/activaciones de Lemon se elude** tras la 1ª activación |
| 4 | 🟠 Media | Un **4xx transitorio** (p. ej. reloj desajustado) **borra la licencia local** |
| 5 | 🟡 Media-baja | Los **datos del formulario de activación se descartan** en el servidor |
| 6 | 🟡 Baja | `Activacion.tsx` es **código muerto y roto** (firma antigua de `invoke`) |
| 7 | 🟡 Baja | La sección "Licencia" de Configuración muestra **datos MOCK hardcodeados** |
| 8 | 🟡 Baja | `api_get_auth_headers` registrado **sin uso** en frontend |
| 9 | 🟡 Baja | `/v1/license/validate` implementado en el worker pero **nunca invocado** |
| 10 | ⚪ Nota | `LICENSE_JWT_SECRET` reutilizado para **tres** propósitos distintos |

---

## 2. Mapa de la superficie auditada

| Capa | Archivo | Rol |
|---|---|---|
| Contratos (DTOs ts-rs) | [crates/tpv-contracts/src/licensing.rs](crates/tpv-contracts/src/licensing.rs) | `LicenseLocalState`, `LicenseGateResult`, `LicenseActivateInput`, cabeceras firmadas |
| Puerto | [crates/tpv-application/src/ports/licensing.rs](crates/tpv-application/src/ports/licensing.rs) | `trait LicensingService` / `PairingService` |
| Caso de uso | [crates/tpv-application/src/use_cases/licensing.rs](crates/tpv-application/src/use_cases/licensing.rs) | Valida entrada e invoca el servicio |
| Adaptador | [crates/tpv-infra-licensing/src/lib.rs](crates/tpv-infra-licensing/src/lib.rs) | HTTP al worker, `license_state.json`, gate + gracia offline |
| Cripto/identidad | [crates/tpv-infra-licensing/src/device.rs](crates/tpv-infra-licensing/src/device.rs) | device-id + clave ed25519 (keyring), firma de proof |
| Comandos Tauri | [apps/tpv-main/src-tauri/src/commands/licensing.rs](apps/tpv-main/src-tauri/src/commands/licensing.rs) | Capa fina (5 comandos) |
| Registro | [apps/tpv-main/src-tauri/src/main.rs](apps/tpv-main/src-tauri/src/main.rs#L783-L789) | `invoke_handler` |
| Worker (legacy) | [apps/cloud-worker-licensing/src/server/index.ts](apps/cloud-worker-licensing/src/server/index.ts) | `/v1/license/activate`, `/status`, `/validate`, webhook Lemon |
| Worker (router) | [apps/cloud-worker-licensing/src/index.ts](apps/cloud-worker-licensing/src/index.ts#L161-L164) | Hono + fallthrough `app.all("*")` → licensing legacy |
| Persistencia worker | [apps/cloud-worker-licensing/src/server/licenseStore.ts](apps/cloud-worker-licensing/src/server/licenseStore.ts) | `licenses`, `devices`, pubkey anti-copia, instancias |
| Frontend (gate + activación) | [apps/tpv-main/src/app/AppBoot.tsx](apps/tpv-main/src/app/AppBoot.tsx) | Orquesta gate, formulario de activación inline, pantalla bloqueo |

---

## 3. Flujo end-to-end (tal como está hoy)

### 3.1 Activación
1. El usuario rellena el formulario inline en [AppBoot.tsx:668-697](apps/tpv-main/src/app/AppBoot.tsx#L668-L697) e invoca `license_activate` con `{ args: { activation_key, … } }`.
2. El adaptador genera/lee `device_id` + clave ed25519 del keyring y hace `POST /v1/license/activate` enviando `activationKey`, `deviceId`, `devicePubKey` y `tenantInfo` ([lib.rs:354-447](crates/tpv-infra-licensing/src/lib.rs#L354-L447)).
3. El worker: idempotencia por hash de la clave → si no existe tenant, llama a **Lemon `/activate`**; provisiona la **DB Turso del tenant** + siembra admin; liga la **pubkey** al dispositivo (anti-copia); firma un **JWT HS256 de 30 días** y lo devuelve ([index.ts:991-1147](apps/cloud-worker-licensing/src/server/index.ts#L991-L1147)).
4. El adaptador persiste `license_state.json` (tenant_id, device_id, token, status, expires_at, timestamps).

### 3.2 Gate (verificación)
- Se ejecuta al arrancar en modo TPV y **cada 6 h** ([AppBoot.tsx:623-641](apps/tpv-main/src/app/AppBoot.tsx#L623-L641)), y al activar el modo "online" ([main.rs:330-336](apps/tpv-main/src-tauri/src/main.rs#L330-L336)).
- `GET /v1/license/status` firmado con device-proof. Se permite el uso si `status == "active" && !disabled` ([lib.rs:102-107](crates/tpv-infra-licensing/src/lib.rs#L102-L107)).
- **Gracia offline 48 h** con **detección de rollback de reloj** ([lib.rs:109-116](crates/tpv-infra-licensing/src/lib.rs#L109-L116)).

### 3.3 Anti-copia
- Clave privada ed25519 en keyring del SO; la pública se liga al `device_id` en la 1ª activación y **un mismatch lanza error** (`device_key_mismatch`, [licenseStore.ts:103-118](apps/cloud-worker-licensing/src/server/licenseStore.ts#L103-L118)).
- Cada llamada sensible va firmada: `sign(ts \n METHOD \n PATH \n sha256(token))`, con ventana anti-replay de 2 min ([device.rs:76-87](crates/tpv-infra-licensing/src/device.rs#L76-L87), [index.ts:192-241](apps/cloud-worker-licensing/src/server/index.ts#L192-L241)).

---

## 4. Hallazgos detallados

### 🔴 #1 — El token caduca a 30 días sin refresco → re-activación forzada periódica
`signToken` fija `setExpirationTime("30d")` ([index.ts:80-86](apps/cloud-worker-licensing/src/server/index.ts#L80-L86)) y **ningún endpoint reemite el token** (`/status` solo devuelve estado, no un token nuevo). Cuando caduca, `jwtVerify` falla y `/status` responde **401 invalid_token**. El adaptador trata **todo 4xx** como licencia inválida y ejecuta `delete_state()` ([lib.rs:296-302](crates/tpv-infra-licensing/src/lib.rs#L296-L302)), de modo que la app cae a `needs_activation` y exige **re-introducir la clave + todos los datos del negocio**.

- **Impacto:** un TPV que esté online a diario quedará bloqueado exactamente a los ~30 días, pidiendo re-activación. (La BD local NO se borra, así que no hay pérdida de datos, pero sí una interrupción operativa recurrente.)
- **Recomendación:** una de estas tres: (a) reemitir el JWT en `/status`; (b) tratar `token_expired` como recuperable y re-activar en silencio con la clave guardada; o (c) ampliar el TTL y/o renovar antes de caducar.

### 🟠 #2 — La expiración real de la suscripción no se aplica (salvo webhook)
El gate **nunca compara `expires_at`**: solo mira `status == active && !disabled`. Y `/v1/license/status` **no re-valida contra Lemon** (solo lee la fila local). La única re-validación con Lemon vive en `/v1/license/validate`, que **el cliente nunca llama** (ver #9). Por tanto, si una suscripción caduca/cancela y el webhook de Lemon **no llega o falla**, el TPV seguirá `active` indefinidamente.

- **Recomendación:** comprobar `expires_at` en el gate y/o re-validar contra Lemon periódicamente (reutilizando `/validate`).

### 🟠 #3 — El límite de asientos/activaciones de Lemon se elude tras la 1ª activación
En `/v1/license/activate`, solo se llama a Lemon **si no hay tenant** para esa clave; si ya existe, se **reutiliza el tenant y se omite Lemon** ([index.ts:1044-1061](apps/cloud-worker-licensing/src/server/index.ts#L1044-L1061)). Como `ensureDevice` acepta cualquier `deviceId` nuevo y le liga su pubkey, **cualquiera con la clave puede registrar TPVs ilimitados** en el mismo tenant sin tocar el `activation_limit` de Lemon.

- **Recomendación:** si el multi-terminal por licencia es intencional, documentarlo; si no, contar/limitar instancias activas (`license_instances`) en el servidor.

### 🟠 #4 — Un 4xx transitorio borra la licencia local
La rama `(400..=499) => delete_state()` ([lib.rs:296-302](crates/tpv-infra-licensing/src/lib.rs#L296-L302)) no distingue entre "licencia realmente inválida/revocada" y errores de **auth recuperables**. El worker devuelve **401** ante `device_ts_out_of_range` cuando el reloj del equipo se desvía **> 2 min** ([index.ts:209-211](apps/cloud-worker-licensing/src/server/index.ts#L209-L211)). Es decir, **un reloj mal ajustado basta para perder la licencia** y forzar re-activación.

- **Recomendación:** no borrar el estado ante 401 por desfase de reloj / firma; reservar `delete_state` para `not_found`/`revoked`/estado `disabled`.

### 🟡 #5 — Los datos del formulario de activación se descartan en el servidor
El formulario exige `legal_name`, `display_name`, `email`, `phone`, `country` (validación cliente en [AppBoot.tsx:336-345](apps/tpv-main/src/app/AppBoot.tsx#L336-L345)) y el adaptador los envía en `tenant_info` ([lib.rs:372-384](crates/tpv-infra-licensing/src/lib.rs#L372-L384)). Pero el worker de activación **ignora `tenant_info` por completo** (solo usa `activationKey/deviceId/devicePubKey/instanceName`) y `ensureTenantExistsMinimal` solo escribe `status` ([index.ts:150-162](apps/cloud-worker-licensing/src/server/licenseStore.ts#L150-L162)). El `user_name`/`user_email` que sí se guardan vienen de **Lemon**, no del formulario.

- **Impacto:** el negocio rellena datos obligatorios que no se persisten en ningún sitio del control plane.
- **Recomendación:** o persistir `tenant_info` (p. ej. en `license_meta`/`tenants`), o dejar de exigirlos en el formulario.

### 🟡 #6 — `Activacion.tsx` es código muerto y además roto
[apps/tpv-main/src/app/pages/Activacion.tsx](apps/tpv-main/src/app/pages/Activacion.tsx) **no lo importa nadie** (el flujo real está inline en `AppBoot.tsx`). Además llama `invoke("license_activate", { activationKey: k, restaurantName })` con la **firma antigua** (sin envoltura `args`, camelCase) que ya no corresponde al comando actual → **fallaría si se usara**.

- **Recomendación:** eliminar el archivo.

### 🟡 #7 — La sección "Licencia" de Configuración muestra datos MOCK
[Configuracion.tsx:69-75](apps/tpv-main/src/app/pages/Configuracion.tsx#L69-L75) define un `license` **hardcodeado** (`plan:"PRO"`, `status:"ACTIVA"`, `nextPaymentDate:"2026-02-15"`, `devices:5`) que se pinta en [Licencia.tsx](apps/tpv-main/src/features/configuracion/sections/Licencia.tsx). **No refleja el estado real** (`license_get_state`).

- **Impacto:** el usuario ve siempre "ACTIVA / PRO / 5 dispositivos" aunque su licencia esté caducada o bloqueada. Engañoso.
- **Recomendación:** cablear a `license_get_state` (estado real) o retirar la sección hasta tenerla.

### 🟡 #8 — `api_get_auth_headers` registrado pero sin consumidores
El comando existe ([commands/licensing.rs:26-32](apps/tpv-main/src-tauri/src/commands/licensing.rs#L26-L32)) y está registrado, pero **no se invoca desde el frontend** (sin coincidencias JS). Es un resto de la era "REST desde el TPV"; hoy el TPV lee local y las cabeceras firmadas para REST salen de `tpv_server_signed_headers`/`tpv_server_post_json`.

- **Recomendación:** eliminar si se confirma sin uso.

### 🟡 #9 — `/v1/license/validate` implementado pero nunca llamado
El endpoint de re-validación con Lemon existe en el worker ([index.ts:1192-1252](apps/cloud-worker-licensing/src/server/index.ts#L1192-L1252)), pero el cliente Rust solo usa `/activate` y `/status`. Es **código muerto** que, además, es justo la pieza que resolvería el #2.

- **Recomendación:** conectarlo (re-validación periódica) o eliminarlo.

### ⚪ #10 — `LICENSE_JWT_SECRET` con triple propósito
El mismo secreto firma los **tokens de licencia** (HS256), sirve de clave **HMAC de requests internas** worker-a-worker ([index.ts:615-623](apps/cloud-worker-licensing/src/server/index.ts#L615-L623)) y verifica el **JWT del WebSocket** ([index.ts:84](apps/cloud-worker-licensing/src/index.ts#L84)). Aceptable, pero rotarlo invalida **todo** a la vez y acopla dominios distintos.

---

## 5. Lo que está bien (no tocar)

- ✅ **Anti-copia robusta:** clave privada ed25519 en keyring; pubkey ligada al dispositivo en la 1ª activación con rechazo de mismatch.
- ✅ **Device-proof firmado** en cada llamada sensible (`ts·método·path·sha256(token)`), con ventana anti-replay de 2 min en cliente y servidor.
- ✅ **Gracia offline de 48 h con detección de rollback de reloj** (`CLOCK_ROLLBACK_TOLERANCE_MS`).
- ✅ **Clave de licencia cifrada AES-GCM en reposo**; solo se indexa el `sha256` (no se guarda en claro).
- ✅ **Webhook de Lemon** con verificación HMAC **timing-safe** + **idempotencia** (`webhook_events`).
- ✅ **Activación idempotente:** reutiliza tenant y no recrea la DB.
- ✅ **Hexagonal limpia:** comando fino → caso de uso (valida) → puerto → adaptador; sin SQL ni HTTP en la capa de comandos.
- ✅ **Propagación verbatim** de códigos de negocio (`AppError::raw`) para que el frontend los compare por igualdad.
- ✅ **`assertEnv`** valida los secretos requeridos antes de operar (falla con `missing_env_*` claro).

---

## 6. Recomendaciones priorizadas

1. **Resolver la caducidad del token a 30 días (#1)** — es lo único con impacto operativo seguro y recurrente. Reemitir token en `/status` o re-activación silenciosa.
2. **Decidir el enforcement de expiración/asientos (#2, #3)** — hoy el producto es más permisivo de lo que parece: una suscripción caducada sigue funcionando y los asientos no se limitan tras la 1ª activación.
3. **No borrar la licencia ante 401 recuperables (#4)** — endurecer la clasificación de errores del gate.
4. **Limpieza/honestidad de UI (#5, #6, #7)** — quitar el `Activacion.tsx` muerto, dejar de pedir datos que se tiran, y cablear (o retirar) la sección de Licencia con datos reales.
5. **Limpieza de código muerto (#8, #9)** — `api_get_auth_headers` y `/v1/license/validate`.

---

*Auditoría estática; no se ejecutó la app ni se llamó al worker. Las severidades reflejan riesgo
funcional/seguridad, no esfuerzo de corrección.*
