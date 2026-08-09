# Auditoría Fable — Ciberseguridad del monorepo TPV

> **Alcance:** seguridad de red / superficie de ataque de **todo** el proyecto (worker `tpv-api` +
> Durable Object TenantHub, backend Rust/Tauri, frontend Main y Handy) y **CVEs conocidos y
> documentados** de las dependencias en uso. **Fuera de alcance** (a petición del responsable): la
> lógica de negocio (cobros, descuentos, cuadres de caja, etc.).
>
> **Enfoque:** OWASP Top 10 (2021) — inyección, control de acceso roto, fallos criptográficos, mala
> configuración de seguridad, autenticación, SSRF, componentes vulnerables, etc.
>
> **Metodología:** lectura módulo a módulo del código fuente (no ejecución dinámica). Cada hallazgo
> lleva ubicación `archivo:línea`, impacto, precondiciones y solución concreta.
>
> **Fecha:** 2026-07-17 · **Rama:** `main`

---

## 0. Resumen ejecutivo

El proyecto tiene una **postura de seguridad sólida**: SQL 100 % parametrizado, criptografía bien
usada (ed25519 con clave pública pineada, HMAC timing-safe, PBKDF2), aislamiento multi-tenant
correcto (tenant/device SIEMPRE derivados del token, nunca del cliente), tokens en keyring (no en
`localStorage`), WebSocket con ticket efímero de un solo uso, y verificación robusta del webhook de
Stripe. **No se han encontrado inyecciones SQL, XSS, ni secretos commiteados, ni dependencias con
CVEs abiertos conocidos.**

Los hallazgos son, en su mayoría, de **endurecimiento** (hardening) y **defensa en profundidad**.

> **Corregido y retirado de esta lista:** el hallazgo 🔴 **A** (el `apply` por WebSocket no
> comprobaba el rol, así que una Handy autenticada podía ejecutar SQL arbitrario en su tenant) está
> **arreglado**: el `apply` exige `role === "tpv"` y el rol lo dicta la BD central, no la cabecera
> del cliente ([tenantHub.ts:1686-1698](apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts#L1686-L1698)).

| # | Severidad | Título | OWASP |
|---|-----------|--------|-------|
| **B** | 🟠 Media | Fuga de stack traces / mensajes internos en respuestas de error | A05 / A09 |
| **G** | 🟠 Media | CSP del cliente Tauri demasiado permisiva (`https:` comodín) | A05 Security Misconfiguration |
| **C** | 🟡 Baja-Media | Envío de correo a destinatario arbitrario sin límite por tenant | A04 / abuso |
| **D** | 🟡 Baja | Pairing "solo código" permite reclamar sin secreto (carrera de claim) | A07 Auth |
| **E** | 🟡 Baja | Sin anti-replay (nonce) en device-proof e internal-HMAC (solo ventana temporal) | A07 |
| **F** | 🟡 Baja | `/internal/revoke` del DO sin verificación HMAC | A01 (defensa en profundidad) |
| **H** | 🟡 Baja | CI sin escaneo de dependencias (`cargo audit` / `pnpm audit` / Dependabot) | A06 |
| **I** | 🟡 Baja | Lockfiles obsoletos/duplicados commiteados (npm + pnpm por-app) | A08 / higiene |

---

## 1. Hallazgos detallados

### 🟠 B — Fuga de stack traces y mensajes internos en las respuestas de error

**OWASP:** A05 Security Misconfiguration / A09 Security Logging & Monitoring Failures (exposición de
información sensible).
**Ubicación:**
- [apps/cloud-worker-licensing/src/server/utils/response.ts:40-63](apps/cloud-worker-licensing/src/server/utils/response.ts#L40-L63) (`serverError`/`unauthorized` devuelven `details` al cliente)
- Llamantes que pasan `stack`/`name`/`cause`/`message`:
  [index.ts:146-152](apps/cloud-worker-licensing/src/index.ts#L146-L152),
  [pairCreate.ts:130-143](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/pairCreate.ts#L130-L143),
  [pairClaim.ts:287-291](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/pairClaim.ts#L287-L291),
  [pairApprove.ts:196-201](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/pairApprove.ts#L196-L201),
  [pairFetchToken.ts:385-389](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/pairFetchToken.ts#L385-L389),
  [revokeDevice.ts:154](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/revokeDevice.ts#L154),
  [listDevices.ts:100](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/listDevices.ts#L100)

**Descripción.** `serverError(req, code, details)` serializa `details` **en el cuerpo JSON que recibe
el cliente**. Varios handlers pasan `{ message, name, stack, cause }` del `Error` capturado. Ante un
500 (y algunos 401) el cliente recibe la **traza completa**, el nombre de la excepción y, en el caso
de errores de Turso, el texto crudo del motor (nombres de tabla/columna, SQL, rutas de fichero del
bundle). Es divulgación de información que facilita el reconocimiento del sistema a un atacante.

**Impacto.** Information disclosure. No es explotable por sí solo, pero acelera cualquier otro ataque
(mapea estructura de código, esquema, y mensajes internos).

**Solución.** No devolver nunca `stack`/`cause`/`message` crudos al cliente. Registrarlos en
Sentry/`console.error` (server-side) y responder solo con un **código estable**:

```ts
export function serverError(req: Request, error: string) {
    return json({ ok: false, error }, 500, req);   // sin `details`
}
```

Mantener el `console.error(e?.stack)` que ya existe en algunos handlers (visible en `wrangler tail`)
es correcto; lo que hay que quitar es el `details` en la respuesta HTTP.

---

### 🟠 G — CSP del cliente Tauri demasiado permisiva (`https:` comodín)

**OWASP:** A05 Security Misconfiguration.
**Ubicación:** [apps/tpv-main/src-tauri/tauri.conf.json:23](apps/tpv-main/src-tauri/tauri.conf.json#L23)
y capacidades en [apps/tpv-main/src-tauri/capabilities/default.json](apps/tpv-main/src-tauri/capabilities/default.json)

**Descripción.** La CSP es:

```
default-src 'self' ipc: https:; img-src 'self' asset: ... blob: data:;
```

Como no se declaran `script-src` ni `connect-src` explícitos, ambos **heredan** de `default-src`, que
incluye el comodín `https:`. Esto significa que la webview puede cargar **scripts** y abrir
**conexiones** hacia **cualquier** origen HTTPS. Combinado con las capacidades amplias del cliente
(`fs:allow-write-file`, `fs:scope-download/desktop/document`, `opener:default`), si en el futuro
apareciera un XSS (p. ej. por un dato no escapado inyectado en el DOM), el atacante podría cargar
código remoto arbitrario y usar las APIs de Tauri (escribir ficheros, abrir rutas/URLs).

**Impacto.** No hay XSS hoy (no se usa `dangerouslySetInnerHTML`/`eval`), así que es riesgo latente:
amplifica cualquier XSS futuro de "molesto" a "grave".

**Solución.** Endurecer la CSP a orígenes concretos:

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: https://tpv-api.altarialights.workers.dev wss://tpv-api.altarialights.workers.dev; img-src 'self' asset: http://asset.localhost https://asset.localhost blob: data:;"
```

(ajustar `style-src` a lo que exija Tailwind/Vite). Y revisar si las capacidades `fs:scope-*` y
`opener` son todas necesarias; reducir al mínimo el alcance.

---

### 🟡 C — Envío de correo a destinatario arbitrario sin límite por tenant

**OWASP:** A04 Insecure Design / abuso de recursos (reputación del dominio remitente).
**Ubicación:** [apps/cloud-worker-licensing/src/domains/email/email.routes.ts:37-69](apps/cloud-worker-licensing/src/domains/email/email.routes.ts#L37-L69)

**Descripción.** Cualquier dispositivo autenticado del tenant puede `POST /v1/email/enviar-pedido`
con un `email_destino` **arbitrario** (validado solo como email bien formado). El worker envía desde
tu dominio con SPF/DKIM. El contenido va **HTML-escapado** (`esc()`, líneas 136-142) y los campos van
estructurados al binding `EMAIL.send()` (no hay inyección de cabeceras ni de HTML). El único freno es
el rate limit **global** de Cloudflare Email Service (`E_RATE_LIMIT_EXCEEDED`), no uno por
tenant/dispositivo.

**Impacto.** Un token comprometido puede emitir correos "de pedido" a direcciones arbitrarias con la
firma de tu dominio → spam/uso indebido que daña la reputación de envío (deliverability) del dominio.

**Solución.** Añadir límite por tenant/dispositivo (p. ej. contador con ventana en la BD central) y,
si el caso de uso lo permite, restringir `email_destino` a correos de proveedores ya dados de alta en
el tenant en lugar de aceptar cualquiera.

---

### 🟡 D — Pairing "solo código" permite reclamar sin secreto (carrera de claim)

**OWASP:** A07 Identification & Authentication Failures.
**Ubicación:** [apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/pairClaim.ts:200-253](apps/cloud-worker-licensing/src/server/endpoints/rest/pairing/pairClaim.ts#L200-L253)

**Descripción.** Cuando el body **no** trae `pairSecret`, se omite la verificación criptográfica y el
claim se realiza igual (registra `claimed_by_device_id`/pubkey). El estado permanece `pending`, por lo
que un **segundo** reclamante puede sobrescribir el claim del primero. La protección es: throttle por
IP (30/60 s), TTL de 10 min del código, y **aprobación manual** en la Main. El espacio de códigos es
10⁶ (6 dígitos).

**Impacto.** Un atacante que adivine/observe un código pendiente puede reclamarlo (o pisar el claim
legítimo) y, si el operador de la Main aprueba sin fijarse, emparejar un dispositivo no deseado. El
throttle es por-IP (evadible con varias IPs), pero la aprobación manual y el TTL corto acotan mucho el
riesgo.

**Solución.**
- Preferir siempre la ruta con secreto (QR/URI); tratar la ruta "solo código" como excepción.
- En la UI de aprobación de la Main, mostrar nombre/fingerprint del dispositivo que reclamó para que
  el operador detecte suplantaciones.
- Considerar un cap **global** de intentos (además del por-IP) y/o un código más largo o TTL más corto.
- Fijar el claim al **primer** reclamante (no permitir sobrescritura mientras siga `pending`).

---

### 🟡 E — Sin anti-replay (nonce) en device-proof e internal-HMAC (solo ventana temporal)

**OWASP:** A07.
**Ubicación:**
- device-proof: [apps/cloud-worker-licensing/src/server/middleware/auth.ts:83-119](apps/cloud-worker-licensing/src/server/middleware/auth.ts#L83-L119) y [licensing.helpers.ts:247-295](apps/cloud-worker-licensing/src/domains/licensing/licensing.helpers.ts#L247-L295)
- internal-HMAC: [apps/cloud-worker-licensing/src/lib/internalAuth.ts:74-99](apps/cloud-worker-licensing/src/lib/internalAuth.ts#L74-L99)

**Descripción.** El "device proof" firma `ts\nMÉTODO\nPATH\nsha256(token)` con una ventana de deriva
de 2 min, **sin nonce de un solo uso** y **sin cubrir el cuerpo** de la petición. El HMAC interno
(worker→DO) tiene ventana de 60 s, también sin nonce. Sobre TLS no es explotable (no hay captura del
tráfico), y las escrituras están protegidas por idempotencia (`Op_Id`), pero es un hueco de defensa en
profundidad: dentro de la ventana, una misma petición firmada podría reproducirse, y como la firma no
cubre el body, no hay integridad sobre el payload en ese canal.

**Solución (opcional, defensa en profundidad).** Cachear nonces de un solo uso para el device-proof en
endpoints sensibles (Cloudflare KV/DO con TTL = ventana), e incluir un `sha256(body)` dentro del
mensaje firmado del device-proof y del internal-HMAC.

---

### 🟡 F — `/internal/revoke` del Durable Object sin verificación HMAC

**OWASP:** A01 (defensa en profundidad).
**Ubicación:** [apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts:1296-1312](apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts#L1296-L1312)

**Descripción.** `/internal/apply` verifica `verifyInternalWorkerRequest` (HMAC con
`LICENSE_JWT_SECRET`), pero `/internal/revoke` **no**: cierra el socket del `deviceId` que venga en el
body sin autenticar. El DO **no es direccionable desde Internet** (solo vía binding del worker), así
que el impacto real es bajo (a lo sumo, inconsistencia si algún día una ruta reenviara peticiones del
usuario al DO). Es una asimetría que conviene cerrar por coherencia.

**Solución.** Aplicar también `verifyInternalWorkerRequest` en la rama `/internal/revoke` (y firmar la
petición en `revokeDevice.ts`, igual que hace `hub.ts` para `/internal/apply`).

---

### 🟡 H — CI sin escaneo de vulnerabilidades de dependencias

**OWASP:** A06 Vulnerable and Outdated Components (proceso).
**Ubicación:** [.github/workflows/ci.yml](.github/workflows/ci.yml) · [.github/workflows/release.yml](.github/workflows/release.yml)

**Descripción.** No hay ningún job de auditoría de dependencias: ni `pnpm audit`, ni `cargo audit`
(RustSec `advisory-db`), ni Dependabot, ni CodeQL. Hoy el árbol está limpio (§2), pero sin escaneo
continuo una regresión futura pasaría desapercibida.

**Solución.**
- Rust: añadir `cargo audit` (o `cargo deny check advisories`) como job de CI.
- JS: `pnpm audit --prod` (o Socket/Snyk) en CI.
- Activar **Dependabot** (o Renovate) para PRs automáticos de actualización.

---

### 🟡 I — Lockfiles obsoletos y duplicados commiteados (viola CLAUDE.md: solo pnpm)

**OWASP:** A08 Software & Data Integrity Failures / higiene de cadena de suministro.
**Ubicación:** ficheros rastreados:
- `apps/cloud-worker-licensing/package-lock.json` (npm) + `apps/cloud-worker-licensing/pnpm-lock.yaml` (obsoleto)
- `apps/tpv-main/package-lock.json` (npm) + `apps/tpv-main/pnpm-lock.yaml`
- `pnpm-lock.yaml` (raíz — el **autoritativo** del workspace)

**Descripción.** El monorepo es un workspace pnpm: el **único** lock válido es el de la raíz, y CI usa
`pnpm install --frozen-lockfile` sobre él (por eso el árbol desplegado es correcto: `hono@4.12.23`,
`zod@3.25.76`, etc.). Pero se han commiteado además:
- `package-lock.json` de **npm** en dos apps → exactamente lo que CLAUDE.md **prohíbe** (mezclar npm
  rompe el aislamiento de pnpm).
- `pnpm-lock.yaml` **por-app** que están **desincronizados**: el del worker, por ejemplo, en su
  sección `importers` solo lista `@libsql/client`, `@noble/ed25519` y `jose` — **le faltan `hono`,
  `@sentry/cloudflare` y `zod`**, y fija `zod@3.22.3` (mientras el lock raíz instala `zod@3.25.76`).

Estos ficheros son "trampas": si alguien ejecuta `npm ci` o `pnpm install` **dentro** de una subcarpeta,
obtendrá un árbol de dependencias **distinto y más antiguo** que el desplegado — builds no
reproducibles y potencial de instalar versiones no auditadas.

**Solución.**
```bash
git rm apps/cloud-worker-licensing/package-lock.json apps/tpv-main/package-lock.json
git rm apps/cloud-worker-licensing/pnpm-lock.yaml apps/tpv-main/pnpm-lock.yaml
```
Mantener **solo** el `pnpm-lock.yaml` de la raíz y añadir a `.gitignore`:
```
**/package-lock.json
apps/*/pnpm-lock.yaml
packages/*/pnpm-lock.yaml
```

---

## 2. Dependencias — CVEs conocidos y documentados

Se revisaron las versiones **realmente instaladas** (lock raíz autoritativo, `--frozen-lockfile`).
**No se encontró ninguna dependencia con CVE/advisory abierto conocido.** Detalle:

### 2.1 JavaScript / worker + frontend

| Paquete | Versión instalada | Estado | Notas |
|---|---|---|---|
| hono | 4.12.23 | ✅ Al día | Los advisories antiguos (path traversal en `serveStatic` de 4.5.x, etc.) están muy por detrás. |
| @noble/ed25519 | 3.0.0 | ✅ Sin CVE | Librería auditada, criptografía constante. |
| jose | 6.1.3 | ✅ Sin CVE | v6 actual. |
| zod | 3.25.76 | ✅ Al día | (El `3.22.3` del lock por-app **obsoleto no se instala**; ver hallazgo I.) |
| @libsql/client | 0.17.0 | ✅ Sin CVE | |
| @sentry/cloudflare | 10.62.0 | ✅ Al día | |
| vite | 7.2.6 | ✅ Al día | Los CVEs de dev-server (`?raw`, `server.fs.deny`) son de las líneas 5/6; además es *devDependency* y producción es un bundle Tauri. |
| esbuild | 0.25.12 / 0.27.0 | ✅ Parcheado | ≥ 0.25.0 → **no** afectado por GHSA-67mh-4wv8-2f99 (dev-server). Solo *dev*. |
| nanoid | 3.3.11 | ✅ Parcheado | ≥ 3.3.8 → **no** afectado por CVE-2024-55565. |
| semver | 6.3.1 | ✅ Parcheado | **No** afectado por CVE-2022-25883 (ReDoS, corregido en 6.3.1). |
| postcss | 8.5.6 | ✅ Parcheado | ≥ 8.4.31 → **no** afectado por CVE-2023-44270. |
| react / react-dom | 19.2.1 | ✅ Al día | |
| react-router-dom | 7.10.1 | ✅ Al día | |
| pdf-lib | 1.17.1 | ✅ Sin CVE conocido | |
| apexcharts / konva | 5.3.6 / 10.0.12 | ✅ Sin CVE conocido | Renderizan datos propios; sin sinks HTML peligrosos en el uso actual. |

### 2.2 Rust (Cargo.lock)

| Crate | Versión | Estado | Notas |
|---|---|---|---|
| tauri | 2.11.2 | ✅ Al día | |
| tauri-plugin-updater | 2.10.1 | ✅ Al día | Updater con firma minisign (clave pública pineada en `tauri.conf.json`). |
| ed25519-dalek | 2.2.0 | ✅ Seguro | El oráculo de doble-pubkey (RUSTSEC-2022-0093) afectaba a < 2.0. |
| ring | 0.17.14 | ✅ Al día | Por delante de RUSTSEC-2025-0009 (overflow AES) corregido en 0.17.12. |
| rustls | 0.23.40 / 0.22.4 | ✅ Al día | 0.23.40 es muy reciente; 0.22.4 es el último de la línea 0.22. |
| openssl / openssl-sys | 0.10.81 / 0.9.117 | ✅ Al día | Por delante de RUSTSEC-2025-0022 (corregido en 0.10.70). |
| reqwest | 0.12.28 / 0.13.4 | ✅ Al día | |
| hyper | 1.10.1 / 0.14.32 | ✅ Al día | |
| tokio | 1.52.3 | ✅ Al día | |
| libsql | 0.3.5 | ✅ Sin CVE conocido | |
| keyring | 2.3.3 | ✅ Sin CVE conocido | Almacena el token de sesión (bien: no en disco plano). |

> **Recomendación:** las tablas anteriores son un snapshot manual a fecha de hoy. La forma correcta de
> mantenerlas verdes es el **hallazgo H** (`cargo audit` + `pnpm audit` + Dependabot en CI).

---

## 3. Verificado como CORRECTO (para tranquilidad)

Durante la auditoría se confirmó explícitamente que **no** existen estos problemas habituales:

- **Sin inyección SQL.** Todo el SQL (worker y Rust) usa parámetros `?N`. Las únicas interpolaciones
  con `format!`/template son **nombres de columna/tabla desde constantes allowlist** o **placeholders
  `?N` generados por índice** (p. ej. `configuracion.commands.ts`, `cuentas.queries.ts`,
  `crates/tpv-infra-sqlite/*`); los valores de usuario van siempre parametrizados.
- **Sin XSS.** El frontend no usa `dangerouslySetInnerHTML`, `innerHTML`, `eval` ni `new Function`. El
  HTML de los correos escapa el contenido (`esc()`).
- **JWT sin confusión de algoritmo.** `jose` verifica con `algorithms: ["HS256"]`; el verificador
  propio (`jwtHs256.ts`) usa HMAC siempre → no hay `alg:none` ni confusión HS/RS.
- **Criptografía correcta.** Firma ed25519 del estado de licencia con **clave pública pineada** en el
  binario (resistente a MITM/DNS/CA falsa). Comparaciones **timing-safe** en tokens admin, OTP y firmas.
  PBKDF2-SHA256 para PINs (tope 100k del runtime de CF). CSPRNG (`crypto.getRandomValues`) para códigos,
  nonces y claves.
- **Webhook de Stripe robusto.** Firma HMAC sobre el cuerpo **crudo**, comparación timing-safe,
  anti-replay de 5 min, idempotencia por `event.id` **y** por sesión de checkout, fail-closed sin
  `term_months`.
- **Aislamiento multi-tenant.** `tenantId`/`deviceId` se derivan **siempre del token** (nunca del
  cliente) en imágenes, telemetría, sync y negocio. Claves R2 prefijadas por tenant + regex
  anti-path-traversal (`REL_PATH_RE`). Resolución de credenciales por-tenant con rotación y locking
  optimista (CAS).
- **Gestión de sesiones/tokens.** El token de sesión vive en el **keyring** (no en `localStorage`). El
  WebSocket se abre con un **ticket efímero de un solo uso** canjeado por REST firmado, consumido
  atómicamente (`DELETE ... RETURNING`) → nunca viaja el token por el query string.
- **Anti fuerza bruta en login.** El login/fichaje por PIN tiene throttle por intentos fallidos
  (`throttleSecondsLeft`/`throttleFail`), y el OTP de cambio de dispositivo tiene TTL + máximo de
  intentos + consumo atómico.
- **Fail-closed en administración.** Los tokens admin (`ADMIN_API_TOKEN`, `RELEASE_ADMIN_TOKEN`)
  deshabilitan la ruta (503) si no están configurados; nunca "sin secreto → pasa todo".
- **Sin secretos commiteados.** `wrangler.json` solo contiene config no sensible (URL de Turso, slug,
  remitente de correo). `.dev.vars`/`.env` están en `.gitignore`. Los secretos van por
  `wrangler secret put`.
- **CORS restringido.** Allowlist fija de orígenes (`localhost:1420`, `tauri://localhost`,
  `http://tauri.localhost`); no hay `Access-Control-Allow-Origin: *` con credenciales.

---

## 4. Plan de acción sugerido (por prioridad)

1. **B** — Quitar `stack`/`message`/`cause` de las respuestas de error (dejar solo el código).
2. **G** — Endurecer la CSP de Tauri (`script-src 'self'`, `connect-src` a orígenes concretos).
3. **H / I** — Añadir `cargo audit` + `pnpm audit` + Dependabot en CI; borrar los lockfiles npm y los
   `pnpm-lock.yaml` por-app.
4. **C, D, E, F** — Endurecimientos de defensa en profundidad, según capacidad.

---

*Auditoría centrada exclusivamente en ciberseguridad/red, según lo solicitado. No cubre corrección de
lógica de negocio. Realizada por lectura estática del código; se recomienda complementar con un
`cargo audit`/`pnpm audit` automatizado y, si el presupuesto lo permite, un pentest dinámico del
worker en un entorno de staging.*
