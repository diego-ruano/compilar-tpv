# D11 — Login / autenticación / arranque

> **Ámbito.** Identificación del personal por **PIN**, hashing/verificación de credenciales, setup
> inicial (cambio de PIN/email obligatorio), y el fichaje asociado al login.
> **Capas:** `crates/tpv-domain/src/login.rs` (hash/verify PBKDF2), `crates/tpv-infra-sqlite/src/login.rs`
> (repo), `use_cases/login.rs`, `apps/cloud-worker-licensing/src/domains/login/*`,
> FE `apps/tpv-main/src/features/login/*`.

## Valoración de seguridad

**Aciertos:** verificación en **tiempo constante** (`verify_pin`, XOR-acumulado), PBKDF2-HMAC-SHA256
con sal aleatoria de 16 B por usuario, **lockout escalado** tras 5 fallos, gate de setup inicial,
auto-logout por inactividad (10 min) y validaciones de entrada.

**Riesgo que queda:** el **espacio de claves**. Un PIN de 4 dígitos son 10⁴ combinaciones, y el
`Password_Hash` se replica a la BD del tenant en Turso. El coste de romper un hash offline es de
**décimas de segundo por usuario en una GPU de consumo**, y eso **no lo arregla subir iteraciones**
(ver LOGIN-04). El lockout protege el ataque *online*, que es el realista hoy; el *offline* exige
antes acceso de lectura a la BD de la nube.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| LOGIN-04 | 🔵 | El hash del PIN es **crackeable offline** si alguien lee la BD del tenant; subir iteraciones no lo arregla | `domain/login.rs:11-16`, `login.crypto.ts` |
| LOGIN-03 | 🔵 | `list_login_users` **enumera usuarios** | `login.rs` (`list_login_users`) |
| LOGIN-05 | 🔵 | Doble implementación Rust/worker de login/verify (parity, crítico) | `login.rs` ↔ `login.commands.ts` |

### LOGIN-04 🔵 El hash es crackeable offline (y las iteraciones no son la palanca)

- **Situación:** PBKDF2-HMAC-SHA256, 100.000 iteraciones, sal única por usuario. El
  `Usuarios.Password_Hash` viaja por el outbox a la BD del tenant (Turso), porque el **worker**
  verifica el PIN en el login de Handy (que no tiene BD local).
- **Por qué 100k y no 600k (OWASP):** el `crypto.subtle` de Cloudflare Workers **rechaza** PBKDF2
  con más de 100.000 iteraciones. Es un límite del **runtime**, no del plan de pago: tenerlo
  contratado no lo desbloquea. Está anotado en `crates/tpv-domain/src/login.rs:11-16`.
- **Por qué tampoco importaría:** con 10⁴ candidatos, probarlos todos contra un hash de 100k
  iteraciones cuesta ~10⁹ iteraciones PBKDF2, del orden de **décimas de segundo** en una GPU de
  consumo. A 600k serían ~0,5 s. Multiplicar por 6 el coste de algo que ya se hace en menos de un
  segundo no cambia nada: la variable que manda es el **tamaño del espacio de claves**, no el KDF.
- **Opciones reales**, por relación coste/beneficio:
  1. **PIN más largo para roles sensibles.** El dominio solo exige `len >= 4`. Permitir (o exigir)
     8 dígitos al admin multiplica por 10.000 el coste del ataque. Es el cambio más barato con
     diferencia.
  2. **Pepper**: un secreto que se mezcla con el PIN antes del PBKDF2 y que **no vive en la BD**
     (secreto del worker + keyring/SecretStore en la Main, entregado en la activación). Sin él, el
     hash replicado no se puede atacar por diccionario. Requiere tocar las dos implementaciones,
     distribuir y custodiar el secreto, y un rehash-en-login para migrar los hashes existentes.
     Ojo: perder el pepper = nadie puede entrar.
  3. **KDF más fuerte** (Argon2id/scrypt vía WASM en el Worker). El más caro y el que menos aporta
     frente a (1) y (2), por el mismo motivo del keyspace.
- **No aplica:** dejar de replicar `Password_Hash` a la nube — **descartado por decisión del
  responsable**: la Handy necesita que el worker verifique el PIN.
- **Decisión (2026-08-09): aplazado a cambios futuros.** El riesgo es bajo porque el ataque exige
  **primero** acceso de lectura a la BD del tenant en Turso (fuga de credenciales, incidente del
  proveedor o acceso administrativo), que es un escenario raro; y el ataque online, que es el
  realista, ya lo corta el lockout. Se retomará si el volumen de clientes lo justifica. De hacerse,
  el orden sería PIN largo para admin (barato) y luego el pepper. Ojo con el pepper: **si se pierde,
  nadie puede entrar en ningún sitio** y no se recupera de los datos, así que exige custodia y copia
  de seguridad reales.
- **Ya hecho y aprovechable:** el **rehash-en-login** está cableado (`crates/tpv-infra-sqlite/src/login.rs`),
  así que cualquier cambio de esquema de hash migra solo en el primer login de cada usuario.

### LOGIN-03 🔵 Enumeración de usuarios
`list_login_users` devuelve la lista de usuarios para que el operador elija su nombre: publica los
identificadores válidos, así que la seguridad efectiva queda solo en el PIN. Es el patrón normal de
un kiosco y su mitigación real (el lockout) ya está. Se deja como está.

### LOGIN-05 🔵 Doble implementación crítica
Login/verify existe en Rust y en el worker; una divergencia en la verificación sería grave.
**Arreglo:** tests de contrato de todos los caminos (setup, login, punch) → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

---

## Decisiones tomadas (no son pendientes)

- **LOGIN-02 — autorización server-side por rol: descartada.** Se llegó a implementar un re-PIN de
  administrador por operación sensible (con enforcement en el ejecutor) y se **retiró por completo**
  a petición del responsable: no aportaba frente a un PIN de admin ya conocido y añadía fricción. El
  gating por rol del FE oculta lo que no corresponde; **no se pide el PIN de admin en ninguna
  operación**.
