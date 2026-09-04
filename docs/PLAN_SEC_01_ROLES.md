# PLAN — SEC-01 · Que el backend sepa quién ha iniciado sesión

**Estado:** plan, sin ejecutar · **Escrito:** 2026-09-03 · **Ficha:** [BACKLOG.md](analisis/BACKLOG.md#sec-01--los-permisos-son-sólo-de-ui)

> **Este documento se borra cuando el plan esté cumplido.**

---

## 1. El problema

`AppState` ([lib.rs:403](../apps/tpv-main/src-tauri/src/lib.rs#L403)) tiene exactamente cuatro
campos: `db`, `cloud`, `mode` y `mode_sync`. **No hay sesión.** `login_user`
([commands/login.rs:36](../apps/tpv-main/src-tauri/src/commands/login.rs#L36)) valida el PIN,
devuelve un `LoginOk` con el rol… y no guarda nada.

La sesión vive entera en el frontend, en el store Zustand `useAuth`, en memoria del webview. Lo único
que hay hoy es cosmético:

- [App.tsx:107](../apps/tpv-main/src/app/App.tsx#L107) impide **navegar** a `/cuentas` sin ser Administrador.
- `NavBar.tsx` esconde entradas del menú.

De los **183 comandos registrados**, ninguno comprueba nada. La regla vive donde está sentado el
usuario.

### Por qué el atajo obvio no vale

Pasar el rol como argumento del comando desde el frontend **no es un control de seguridad**: quien
puede invocar el comando puede escribir lo que quiera en el argumento. Protege del despiste, no de la
intención. Y para la auditoría de CUENTA-07 es peor que nada, porque firmaría cada anulación con el
nombre que le pasen — dando apariencia de rastro fiable a un dato que no lo es.

---

## 2. Hasta dónde llega esto (y hasta dónde no)

Conviene decirlo antes de empezar, para no vender lo que no es. En una app de escritorio, quien tenga
la máquina y sepa abrir las DevTools puede invocar comandos por el IPC. Una sesión en el backend
**no** es una frontera criptográfica.

Lo que sí consigue:

- Para pasar el gate hay que **iniciar sesión de verdad** con el PIN de alguien autorizado.
- El `Anulado_Por` de una anulación pasa a ser un dato **que el backend ha establecido**, no uno que
  le han contado. Sin esto, CUENTA-07 es un teatro.
- Cierra el hueco entre "la UI esconde el botón" y "el botón no hace nada".

El riesgo real aquí es un camarero con el TPV delante, no un atacante con conocimientos. Para ese
riesgo, esto es suficiente. **Documentarlo es parte del plan** (enlaza con LIC-04, que también es
documentar un modelo de amenaza de un gate que corre en cliente).

---

## 3. Diseño

### 3.1 La sesión en `AppState`

```rust
#[derive(Clone, Debug)]
pub(crate) struct Sesion {
    pub id_usuario: String,
    pub id_trabajador: Option<String>,
    pub rol: String,
    pub iniciada_en: i64,   // epoch ms
}

pub(crate) struct AppState {
    // …lo que ya hay…
    sesion: Arc<Mutex<Option<Sesion>>>,
}
```

Ciclo de vida:

| Momento | Qué pasa |
|---|---|
| Arranque | `None` |
| `login_user` OK | se establece, con los datos que ya devuelve `LoginOk` |
| Comando `logout` (nuevo) | se limpia |
| Cierre por inactividad | el frontend llama a `logout` (ver §3.4) |
| Arranque del frontend | `AppBoot` llama a `logout` por si quedó una sesión colgada |

### 3.2 El gate

Dos helpers en `AppState`, no una comprobación copiada 183 veces:

```rust
impl AppState {
    /// La sesión actual, o error si no hay ninguna.
    pub(crate) async fn sesion(&self) -> Result<Sesion, AppErrorDto>;

    /// La sesión actual si su rol está entre los permitidos; si no, error.
    pub(crate) async fn exigir_rol(&self, permitidos: &[&str]) -> Result<Sesion, AppErrorDto>;
}
```

Uso en un comando:

```rust
#[tauri::command]
pub async fn cuentas_anular_pago(
    state: State<'_, AppState>,
    args: AnularPagoArgs,
) -> Result<bool, AppErrorDto> {
    let sesion = state.exigir_rol(&["Administrador"]).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::anular_pago(repo.as_ref(), args.con_usuario(sesion.id_usuario)).await?)
}
```

Fíjate en la última línea: el `id_usuario` que llega al caso de uso **sale de la sesión**, no de
`args`. Ese es el punto del plan entero.

> Esto sigue siendo un comando fino: no mete SQL ni reglas de negocio, sólo adapta e inyecta. No
> rompe la regla de CLAUDE.md §4.2.

### 3.3 Qué se gatea (y qué NO)

**No hay que tocar 183 comandos.** La lista es corta y hay que resistir la tentación de ampliarla:
gatear "añadir línea a una comanda" convierte el TPV en inservible en hora punta.

**Con `exigir_rol(["Administrador"])`:**

| Área | Comandos |
|---|---|
| Dinero | `cuentas_anular_pago`, `cuentas_create_gasto`, `cuentas_update_gasto`, `cuentas_delete_gasto` |
| Caja | `cierre_confirmar`, `cierre_reabrir` |
| Personal | `trabajadores_create`, `trabajadores_update`, y la lectura de la ficha con PII |
| Configuración | escrituras de `configuracion_*` y `email_config` |
| Licencia y dispositivo | `license_activate`, cambio de modo, desemparejar Handy |

**Con `sesion()` a secas** (basta con estar identificado, sin importar el rol): comandos que escriben
algo atribuible pero que hace cualquiera — por ejemplo la apertura manual del cajón, que ya se anota
en `Aperturas_Cajon` y hoy se atribuye con lo que diga el frontend.

**Exentos a propósito — y esto es importante:**

| Grupo | Por qué |
|---|---|
| `login_user`, `list_login_users`, `setup_pendiente`, `hash_password` | Son el propio login: exigir sesión sería circular |
| `complete_initial_setup` | Corre en el primer arranque, cuando no hay con qué iniciar sesión |
| `punch` y fichajes | Se fichan antes de tener sesión de aplicación |
| **Todo `commands/recovery.rs`** | ⚠️ Ver abajo |
| Lecturas de arranque (modo, licencia, estado de sync) | Las llama `AppBoot` antes del login |

> ⚠️ **Los comandos de recuperación NO pueden exigir sesión, nunca.** La pantalla de recuperación
> existe precisamente para el caso de **cero usuarios**: no hay con quién iniciar sesión. Si se les
> pone el gate, se cierra la única salida de un equipo que ha perdido su `data.db` — el mismo
> callejón sin salida que documenta [BUG_RECUPERACION_BLOQUEADA.md](BUG_RECUPERACION_BLOQUEADA.md).
> Es la hermana exacta de la regla que ya existe: *"todo lo que hay en ese camino tiene que tolerar
> `state.db == None`"*. Añadir: **y tiene que tolerar `sesion == None`**.

### 3.4 Frontend

- `useAuth.logout()` llama al comando `logout` además de limpiar el store. Como `useInactivityLogout`
  ([useInactivityLogout.ts:38](../apps/tpv-main/src/shared/lib/useInactivityLogout.ts#L38)) ya pasa
  por ahí, el cierre por inactividad queda cubierto sin tocarlo.
- `AppBoot` llama a `logout` al arrancar: si el webview se recarga (F5), el store se vacía y la UI
  vuelve al login, pero la sesión del backend seguiría puesta. Sin esto quedaría una sesión de
  administrador viva detrás de una pantalla de login.
- Cuando un comando devuelva permiso denegado, mensaje claro. **Se sigue escondiendo el botón en la
  UI**: el gate del backend es la red, no el sustituto de una interfaz que no ofrece lo que no toca.

### 3.5 Código de error

Añadir `PermisoDenegado` → `"permiso_denegado"` al catálogo cerrado de
[errors.rs](../crates/tpv-contracts/src/errors.rs).

CLAUDE.md §8 dice que sólo se añade un código si alguien **hace algo distinto** con él, y aquí sí: el
frontend querrá distinguir "no puedes" de "ha fallado" — y probablemente forzar el login. Se exporta
solo a TS por ts-rs.

### 3.6 Modo Handy

En Handy los repositorios van por HTTP y la autoridad es el worker, que ya valida JWT + device-proof
+ rol. El gate local es una segunda capa, no la principal.

**A verificar durante la implementación:** que `login_user` en modo Handy pasa por el mismo camino y
deja la sesión puesta. Si no, los comandos gateados dejarían de funcionar en la Handy — que sería un
fallo introducido por este plan, no una protección.

---

## 4. Implementación, por pasos

1. `Sesion` + campo en `AppState` + los dos helpers (`lib.rs`).
2. Comando `logout`, registrado en la lista de `invoke_handler`.
3. `login_user` establece la sesión.
4. `PermisoDenegado` en el catálogo de errores + `cargo test -p tpv-contracts` para regenerar
   `bindings.ts`.
5. Frontend: `useAuth.logout()` y `AppBoot` llaman a `logout`.
6. Aplicar `exigir_rol` a la lista de §3.3, **empezando por los de dinero**.
7. Manejo del error nuevo en el frontend.
8. Documentar el modelo de amenaza de §2 en `docs/analisis/transversal/` y cerrar de paso LIC-04.

---

## 5. Tests

**Rust:**
- sin sesión, un comando gateado devuelve `permiso_denegado`
- con rol no autorizado, lo mismo
- con Administrador, pasa
- `logout` deja la sesión en `None`
- **los comandos de recuperación siguen funcionando sin sesión** ← el test que impide el callejón sin salida
- `login_user` deja la sesión con el rol correcto

**Frontend (vitest, store sin React):**
- `useAuth.logout()` invoca el comando `logout`

---

## 6. Verificación

```bash
cargo nextest run
cargo test -p tpv-contracts
pnpm --filter @tpv/main typecheck && pnpm --filter @tpv/main test
```

A mano: iniciar sesión como camarero e intentar llegar a un comando de dinero (por la URL directa, o
por la consola del webview) — debe rechazarlo. Y borrar `data.db` para comprobar que la pantalla de
recuperación **sigue funcionando entera sin sesión**.

---

## 7. Por qué esto va antes que CUENTA-07

[PLAN_CUENTA_07_ANULACIONES.md](PLAN_CUENTA_07_ANULACIONES.md) guarda `Anulado_Por` en cada
anulación. Si ese dato lo pone el frontend, la tabla de auditoría registra el nombre que le hayan
dicho, y cualquiera puede anular firmando con el de otro. Sería una auditoría que da confianza sin
merecerla, que es peor que no tener ninguna.

Este plan es pequeño (un campo, dos helpers, una docena de comandos) y es el que hace que el otro
valga para algo.

---

## 8. Fuera de alcance

- **Tabla de permisos.** `Roles` sólo tiene `ID_Rol` y `Nombre_Rol`, y con cuatro roles comprobar por
  nombre es suficiente. Un sistema de permisos granular ahora es sobreingeniería.
- **Sesión persistente entre reinicios.** Al arrancar se pide PIN, y está bien así.
- **Caducidad de sesión en el backend.** El cierre por inactividad del frontend ya la limpia. Un
  segundo temporizador en Rust sería otra política que mantener sincronizada.
