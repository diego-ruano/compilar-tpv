# BUG — Un TPV sin datos puede quedarse sin ninguna salida

**Estado:** abierto · **Detectado:** 2026-08-26 · **Gravedad:** alta (deja el equipo inutilizable)
**Introducido en:** `db4b5d8` (recuperación de la BD local desde la nube)

---

## 1. El síntoma

1. Se borra `data.db` de un equipo con licencia activa.
2. La app arranca y dice **"Faltan los datos de este TPV"** (pantalla de recuperación).
3. Se pulsa **"Recuperar mis datos"** → error.
4. **No hay ninguna otra pantalla.** No se puede iniciar sesión (no hay usuarios), no se puede
   elegir PIN (la guardia impide sembrar el admin) y no se puede recuperar. El TPV es un ladrillo.

En el caso que lo destapó, el error del worker era:

```
[onError] POST /v1/sync/bootstrap → Error: migration_altered:
'0001_inicial.sql' fue modificada tras aplicarse (hash distinto).
Nunca edites una migración ya publicada: crea una nueva.
    at runTenantMigrations → getTenantClient → tenantQuery
```

---

## 2. Son DOS bugs, y conviene no mezclarlos

### BUG-A · La recuperación no tiene plan B (nuevo, lo introduce `db4b5d8`)

El fallo de diseño **no es el `migration_altered`**: es que el bootstrap sea la **única** salida.

`seed_admin_if_empty` deja de sembrar cuando el dispositivo está aprovisionado (correcto: sembrar
replicaba un PIN falso a la nube). Pero al quitar esa vía se quitó **la única forma de que el equipo
arrancase sin la nube**, y no se puso nada en su lugar para cuando la nube no responde.

El `migration_altered` es solo el disparador que tocó. Cualquiera de estos deja el mismo callejón:

- No hay internet en ese momento.
- El worker está caído o devuelve 5xx.
- La licencia está caducada o revocada (`/v1/sync/bootstrap` exige `tenantAuth` + rol `tpv`).
- El volcado supera `BOOTSTRAP_MAX_FILAS` (413 `bootstrap_demasiado_grande`).
- Cualquier error de SQL en el tenant.

**Lo que falta:** una salida que no dependa de la nube. Un TPV tiene que poder abrir el bar.

### BUG-B · Editar `0001_inicial.sql` inutiliza el REST de un tenant ya aprovisionado (preexistente)

`CLAUDE.md` §3 autoriza editar `0001_inicial.sql` mientras no haya clientes en producción, y dice
que la reparación es **"se borra la BD de desarrollo"**. Eso arregla el lado **local** y nada más.

La BD del **tenant en Turso** conserva en `_migrations` el hash de la versión antigua. Al cambiar el
fichero, `runTenantMigrations` compara y lanza `migration_altered` **para siempre**. Borrar
`data.db` no lo toca: son bases de datos distintas.

**Alcance real: el tenant entero, no solo el REST.** El guard corre en los **dos** caminos:

- `ensureTenantMigrated` ← `getTenantClient` ← **`tenantQuery`** → todas las rutas REST del worker,
  o sea todo lo que hace la **Handy** (que no tiene BD local: sin REST no opera).
- `ensureTenantMigrated` en **`tenantHub.ts:275`**, una vez por vida del DO, justo antes de aplicar
  escrituras. Así que la **replicación también se cae** en cuanto el DO re-resuelva la conexión —
  al despertar de la hibernación o al vencer el TTL de 6 h de las credenciales.

No hay asimetría entre REST y sync: con el hash desalineado, ese tenant deja de aceptar tanto
lecturas como escrituras. Por eso realinear `_migrations` en Turso lo desbloquea todo a la vez.

> Corregido el 2026-08-26: una versión anterior de este documento decía que el DO se saltaba el
> guard y que por eso el sync seguía vivo. **Es falso.** Venía de extrapolar el comentario de
> `tenantClient.ts`, que describe esa asimetría para el caso del **401** (rotación de token), no
> para el de migraciones.

**Un detalle que sí está bien resuelto:** `ensureTenantMigrated` no cachea el fallo
(`migrationGuard.delete(tenantId)` en el `catch`), así que reintenta en la siguiente petición en vez
de envenenar el isolate hasta que se recicle.

---

## 3. Por qué los tests no lo cogieron

- `test/helpers/clienteSql.ts` es un **doble** sobre el SQLite del Durable Object. No ejecuta
  `runTenantMigrations`, así que ningún test del worker puede ver un desajuste de hash.
- Los 7 tests de `bootstrap_restaurar` (`crates/tpv-infra-sqlite/src/sync.rs`) prueban la
  restauración **local**, con el volcado ya en la mano. Nada cubre el camino Main → worker → Turso.
- No hay ningún test de que la pantalla de recuperación tenga salida cuando el bootstrap falla.

---

## 4. Direcciones de arreglo (sin decidir)

**Para BUG-A** — hace falta una salida local. Opciones, de menos a más invasiva:

1. **Recuperar desde el `.bak`.** Ya se hacen copias antes de migrar
   (`connection.rs::backup_if_migration_pending`). Ofrecerlas en la pantalla de recuperación es la
   única vía que funciona **sin red**, que es justo lo que falta.
2. **Modo degradado explícito**: dejar sembrar el admin, pero marcando la BD como "no
   autoritativa" para que sus escrituras **no** salgan por el outbox hasta reconciliar. Resuelve el
   arranque sin reintroducir la corrupción de la nube, a cambio de un estado nuevo que mantener.
3. **Mínimo imprescindible**: que la pantalla explique el error real y ofrezca reintentar, en vez de
   un cartel muerto. No desbloquea, pero deja de mentir.

**Para BUG-B** — dos frentes:

1. **Reparar el tenant afectado**: realinear el hash de `_migrations` en Turso, o recrear el tenant.
2. **Corregir la regla de `CLAUDE.md`**: hoy dice "borra la BD de desarrollo", que es incompleto.
   Editar `0001` obliga a resetear **también el tenant en la nube**. O directamente prohibirlo en
   cuanto exista un tenant aprovisionado, aunque no sea "producción".

---

## 5. Deuda de diagnóstico que salió por el camino

`AppError::from_api_body` (`crates/tpv-application/src/error.rs`) solo lee `error` y `code` del
cuerpo, y **descarta `details.message`** — que es donde el worker pone la causa. Por eso este fallo
llega al TPV como un `internal_error` pelado y hubo que ir a `wrangler tail` para leer una línea que
ya venía en la respuesta. Afecta a **cualquier** 500 del worker, no solo a este.
