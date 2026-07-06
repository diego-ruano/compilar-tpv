# D11 — Login / autenticación / arranque

> **Ámbito.** Identificación del personal por **PIN**, hashing/verificación de credenciales, setup
> inicial (cambio de PIN/email obligatorio), y el fichaje asociado al login.
> **Capas:** `crates/tpv-domain/src/login.rs` (hash/verify PBKDF2), `crates/tpv-infra-sqlite/src/login.rs`
> (repo), `use_cases/login.rs`, `apps/cloud-worker-licensing/src/domains/login/*`,
> FE `apps/tpv-main/src/features/login/*`.

## Valoración de seguridad

**Aciertos:** verificación en **tiempo constante** (`verify_pin`, XOR-acumulado), PBKDF2-HMAC-SHA256
**con sal** (16 B) y 100 000 iteraciones, gate de setup inicial, y validaciones de entrada. **Riesgo
principal:** el **espacio de claves** (PIN de 4 dígitos) combinado con la ausencia de lockout y la
**replicación del hash a la nube**.

## Resumen de hallazgos

| ID | Sev | Estado | Título | Ubicación |
|----|-----|--------|--------|-----------|
| LOGIN-01 | 🟠 | ✅ | **Auth débil**: PIN de 4 dígitos (~10⁴) + sin lockout + `Password_Hash` replicado a la nube → brute-force trivial | `login.rs:534`, `domain/login.rs`, esquema |
| LOGIN-02 | 🟡 | ❌ | **Sin autorización server-side**: cualquier comando Tauri es invocable por cualquier rol (gating solo en FE) — **descartado por decisión** (ver nota) | `commands/*`, worker |
| LOGIN-03 | 🟡 | 🟡 | `list_login_users` **enumera usuarios** (reduce la seguridad efectiva con LOGIN-01) | `login.rs:481` |
| LOGIN-04 | 🟡 | ⏳ | PBKDF2 **100k iter** (bajo la guía OWASP ~600k); Argon2 explícitamente no soportado | `domain/login.rs:11,61` |
| LOGIN-05 | 🔵 | ⬜ | Doble implementación Rust/worker de login/verify (parity, crítico) | `login.rs` ↔ `login.commands.ts` |
| LOGIN-06 | 🔵 | ✅ | Fallbacks silenciosos (`email='admin@local'`, `rol='Sin rol'`) ocultan datos faltantes | `login.rs:180,199` |

> **Resolución (2026-07-05).**
> - **LOGIN-01 ✅ (lockout):** contador de intentos fallidos con bloqueo escalado (5 libres → 30 s /
>   1 min / 5 min / 15 min, reset al acertar), en Main y worker, sobre **login** y **fichaje**. Estado
>   en la tabla `Intentos_Login` (migración `0005`, esquema compartido pero device-local: la Main la
>   escribe con la conexión `raw`, sin replicar; el worker en su BD de tenant). Política pura en
>   `tpv-domain::login::login_bloqueo_ms`; verificador en `tpv-infra-sqlite::auth` y `lib/adminAuth.ts`.
>   *(No se aborda el keyspace del PIN ni la replicación del hash; ver LOGIN-04 y notas.)*
> - **LOGIN-06 ✅:** fallbacks explícitos (email ausente → `""`; rol ausente → error, por ser crítico
>   para la autorización), en Rust y worker.
> - **LOGIN-04 ⏳:** rehash-en-login **cableado** (latente); las iteraciones siguen en **100k** por el
>   tope de 10 ms de CPU del plan **Free** de Cloudflare (600k lo superaría y rompería el login de
>   Handy). Subir a 600k al activar el plan de pago — ver [BACKLOG](../BACKLOG.md).
> - **LOGIN-02 ❌ (descartado por decisión):** se llegó a implementar un re-PIN de administrador por
>   operación sensible (con enforcement en el ejecutor) para inventario/cobros/trabajadores, pero se
>   **retiró por completo** a petición del responsable: no aportaba frente a un PIN de admin ya
>   conocido y añadía fricción (un camarero no debería teclear el PIN de admin para cada acción; el
>   gating por rol del FE ya oculta lo que no le corresponde). Todo funciona como antes: **no se pide
>   el PIN de admin en ninguna operación**. La única defensa que queda contra el uso indebido de
>   credenciales es LOGIN-01 (lockout) + LOGIN-04 (hash fuerte al pasar a plan de pago).
> - **LOGIN-03 🟡:** su mitigación real (el lockout de LOGIN-01) está hecha; no se cambió la enumeración
>   en sí (aceptable en kiosco).
> - **LOGIN-05 ⬜:** tests de contrato Rust↔worker — infra de tests, ver [BACKLOG](../BACKLOG.md).
>
> **Extra (no era un hallazgo):** **auto-logout por inactividad** (10 min sin interacción → login),
> hook `shared/lib/useInactivityLogout.ts` montado en el root. Cualquier interacción reinicia el reloj.

---

## Detalle de hallazgos

### LOGIN-01 🟠 Autenticación débil por combinación de factores — CONFIRMADO
- **Evidencia:**
  - El setup exige `pin_nuevo.len() >= 4` (`use_cases/login.rs:60`) → PINs de **4 dígitos**
    ⇒ ~10 000 combinaciones.
  - `login` (`login.rs:534-551`) hace `verify_pin` y devuelve; **no hay** contador de intentos,
    retardo ni bloqueo. Intentos ilimitados.
  - `Usuarios.Password_Hash` está en el esquema compartido → **se replica a Turso** (nube).
- **Fallo:** con 10⁴ posibilidades, un atacante con acceso a la BD de la nube puede **brute-forcear
  offline** todos los PINs (PBKDF2 100k × 10⁴ ≈ 10⁹ ops, factible); y en local/Handy puede probar
  online sin límite. PBKDF2 no compensa un keyspace tan pequeño.
- **Impacto:** suplantación de cualquier trabajador (incluido admin) → acceso a caja, control horario,
  datos.
- **Arreglo (defensa en profundidad):** (1) **lockout/rate-limiting** con backoff tras N fallos por
  usuario/dispositivo; (2) **no replicar** `Password_Hash` a la nube si no es imprescindible (o
  segregarlo); (3) permitir PINs más largos / segundo factor para roles sensibles (admin); (4)
  subir iteraciones (LOGIN-04). Priorizar (1) y (2).

### LOGIN-02 🟡 Sin autorización a nivel de comando
- **Ubicación:** los `#[tauri::command]` no comprueban rol; la restricción por rol vive en el FE. En
  la Handy, el worker autentica el **dispositivo** (tpv/handy) pero conviene revisar la autorización
  por **rol** dentro del tenant.
- **Fallo:** un FE comprometido/modificado puede invocar comandos administrativos con una sesión de
  camarero. Amenaza acotada en un kiosco local, mayor con Handy en red.
- **Arreglo:** enforcar el rol en la frontera (comando/worker) para las operaciones sensibles
  (gestión de personal, borrado de pagos, configuración).

### LOGIN-03 🟡 Enumeración de usuarios
- **Ubicación:** `list_login_users` (`login.rs:481`) devuelve la lista de usuarios para que el
  operador elija su nombre. Típico de kiosco, pero publica los identificadores válidos y, junto con
  LOGIN-01, deja la seguridad efectiva en solo el PIN.
- **Arreglo:** aceptable para kiosco físico; reforzar con lockout (LOGIN-01) si el acceso no es de
  confianza.

### LOGIN-04 🟡 Parámetros de hashing
- **Ubicación:** `PBKDF2_ITERS = 100_000` (`domain/login.rs:11`); `parse_pbkdf2_phc` **rechaza**
  argon2 (`:61`).
- **Fallo:** 100k está por debajo de la recomendación OWASP actual para PBKDF2-SHA256 (~600k), y se
  descarta un algoritmo más robusto (Argon2id) por diseño.
- **Arreglo:** subir iteraciones y/o migrar a Argon2id con rehash progresivo en el login.

### LOGIN-05 🔵 Doble implementación crítica
- Login/verify existe en Rust y worker. Una divergencia en la verificación sería grave. **Arreglo:**
  tests de contrato de todos los caminos (setup, login, punch).

### LOGIN-06 🔵 Fallbacks silenciosos
- `login.rs:180` (`email → "admin@local"`) y `:199`/`:207` (`rol → "Sin rol"`) enmascaran datos
  ausentes en vez de fallar o avisar. **Arreglo:** tratar la ausencia explícitamente.

---

## Workflow de corrección (D11)

1. **LOGIN-01 (prioridad).** Lockout/rate-limiting + segregar/no replicar el hash + PIN más largo o
   2FA para admin. Coordinar con [sync-tenanthub.md](../transversal/sync-tenanthub.md) (qué se
   replica) y [trabajadores.md](trabajadores.md) (PII).
2. **LOGIN-02 (authz).** Enforcar rol en la frontera para operaciones sensibles.
3. **LOGIN-04 (hashing).** Subir iteraciones / Argon2id con rehash.
4. **LOGIN-03/05/06 (endurecimiento y parity).** Tests de contrato; fallbacks explícitos.

**Invariante clave:** el acceso a operaciones sensibles debe requerir **credenciales robustas** y
autorización verificada en el backend, no solo en el FE; el material de credenciales no debe
exponerse más de lo imprescindible.
