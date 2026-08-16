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

> **Un hallazgo corregido se borra de este documento.** La traza del arreglo vive en el código y en
> el historial de git, no en una lista paralela que se queda vieja (misma convención que
> [docs/analisis](docs/analisis/00-indice.md)). Si buscas una letra que no aparece, está resuelta.

| # | Severidad | Título | OWASP |
|---|-----------|--------|-------|
| **B** | 🟠 Media | Fuga de stack traces / mensajes internos en respuestas de error | A05 / A09 |
| **D** | 🟡 Baja | Pairing "solo código" permite reclamar sin secreto (carrera de claim) | A07 Auth |
| **E** | 🟡 Baja | Sin anti-replay (nonce) en el device-proof (la firma del cuerpo ya está hecha) | A07 |

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

### 🟡 E — Sin anti-replay (nonce) en el device-proof

**OWASP:** A07.
**Ubicación:** [server/middleware/auth.ts](apps/cloud-worker-licensing/src/server/middleware/auth.ts) y [licensing.helpers.ts](apps/cloud-worker-licensing/src/domains/licensing/licensing.helpers.ts)

> **La mitad de este hallazgo está cerrada (2026-08-15):** la firma **ya cubre el cuerpo**
> (`…\nsha256(body)`), así que el contenido de una petición firmada no se puede alterar. Y la parte
> del internal-HMAC nunca fue cierta: `buildInternalPayload` siempre incluyó el `rawBody`.

**Lo que queda.** La firma no lleva **nonce de un solo uso**: dentro de la ventana de 2 minutos, una
petición firmada podría **reproducirse tal cual**.

**Por qué no corre prisa.** Para reproducirla hay que haberla capturado, y todo va por TLS. Además
las escrituras son idempotentes por `Op_Id`: repetir una no duplica nada. Queda como defensa en
profundidad para un atacante con posición de red.

**Solución (aplazada).** Guardar los nonces ya vistos durante la ventana. Necesita almacén
compartido —los isolates del worker no comparten memoria—: KV (barato pero eventualmente
consistente, justo lo que no conviene aquí), un Durable Object (consistente, pero un salto más por
petición) o una tabla en Turso. Ver el BACKLOG.

---

## 2. Dependencias — ahora lo vigila CI

La versión original de este apartado era un **inventario a mano** de las versiones instaladas y sus
CVEs, con fecha 2026-07-17. Se ha borrado: esa foto envejece sola y engaña. El 2026-08-15, con el
mismo árbol que la tabla daba por limpio, `pnpm audit --prod` sacaba **25 avisos**.

La verdad vive ahora en [.github/workflows/audit.yml](.github/workflows/audit.yml) (`cargo audit` +
`pnpm audit --prod`, en cada PR y los lunes) y en [.github/dependabot.yml](.github/dependabot.yml).
Para consultarlo en local:

```bash
pnpm audit --prod --audit-level moderate
cargo audit          # requiere: cargo install cargo-audit
```

⚠️ Un aviso **no** es un fallo explotable aquí: hay que mirar si el camino vulnerable se usa. En la
pasada del 2026-08-15, de los 9 avisos altos ninguno aplicaba (adaptadores de `hono` para AWS
Lambda, que en Workers no se usan; el de CORS de `hono` tampoco, porque el worker no usa
`hono/cors` sino su propia allowlist en `response.ts`; y el DoS de `react-router` necesita un
servidor, que en una app de escritorio no hay).

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
   **Aplazado con plan escrito** en [BACKLOG.md](docs/analisis/BACKLOG.md) (fila `FABLE-B`).
2. **G** — Endurecer la CSP de Tauri (`script-src 'self'`, `connect-src` a orígenes concretos).
   Con el método de sonda por CDP ya no hace falta ir a ciegas: ver el BACKLOG.
2. **D, E** — Endurecimientos de defensa en profundidad, según capacidad. **E no es un cambio
   suelto**: la firma la producen los clientes instalados y la verifica el worker, así que exige un
   despliegue en tres pasos (worker tolerante → clientes nuevos → worker estricto) y un almacén de
   nonces (hoy no hay binding de KV).

---

*Auditoría centrada exclusivamente en ciberseguridad/red, según lo solicitado. No cubre corrección de
lógica de negocio. Realizada por lectura estática del código; se recomienda complementar con un
`cargo audit`/`pnpm audit` automatizado y, si el presupuesto lo permite, un pentest dinámico del
worker en un entorno de staging.*
