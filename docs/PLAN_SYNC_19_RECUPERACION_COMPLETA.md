# PLAN — SYNC-19 · Recuperación completa, sin techo de filas

**Estado:** plan, sin ejecutar · **Escrito:** 2026-09-04 · **Ficha:** [BACKLOG.md](analisis/BACKLOG.md)

> **Este documento se borra cuando el plan esté cumplido.**

---

## 1. El problema

[`sync.routes.ts:139`](../apps/cloud-worker-licensing/src/domains/sync/sync.routes.ts#L139) define
`BOOTSTRAP_MAX_FILAS = 300_000`. Pasado ese número, `/v1/sync/bootstrap` responde 413 y **el equipo
no puede recuperarse desde la nube** — que es, según CLAUDE.md, *"la única forma de volver a
operar"*.

Lo grave no es el tope, es **cuándo se descubre**: el día que un cliente ha perdido su `data.db`. Y
`BootstrapTooLarge` existe en [`errors.rs:125`](../crates/tpv-contracts/src/errors.rs#L125) pero **no
lo usa nadie en el frontend**, así que lo que se ve es un error genérico.

El tope existe por una razón real: el volcado se construye **entero en memoria** antes de responder,
y un isolate de Workers tiene 128 MB.

**Objetivo:** recuperarlo todo, sin importar el tamaño, y que el bar vuelva a vender en minutos.

---

## 2. Lo que se investigó (2026-09-04)

### 2.1 Cloudflare Workers — lo que permite

De la [documentación de límites](https://developers.cloudflare.com/workers/platform/limits/):

- **No hay límite de reloj de pared** para Workers disparados por HTTP: *"As long as the client
  remains connected, the Worker can continue processing, making subrequests, and streaming a response
  body"*. Una respuesta en streaming puede durar lo que haga falta.
- **CPU**: 30 s por defecto, **hasta 5 min** (`limits.cpu_ms`, máx. 300.000). `wrangler.json` **no
  tiene** hoy bloque `limits`, así que estamos en 30 s.
- **Memoria**: 128 MB por isolate. Es el techo que motiva el límite actual.
- **Subpeticiones**: 10.000 por invocación (plan de pago). 41 tablas son 41.

→ **Streaming es viable.** Deja de materializar el volcado y la memoria deja de ser el límite.

### 2.2 libsql / Hrana — transacciones interactivas

De la [spec de Hrana 3](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md): un
*stream* es una conexión SQLite identificada por un **baton** que funciona como cookie de sesión — el
servidor lo devuelve en cada respuesta y el cliente lo manda en la siguiente. El stream se mantiene
abierto mientras la conexión no esté en auto-commit, es decir, **mientras haya una transacción**.

El worker usa `@libsql/client/web` 0.17.3 sobre `@libsql/hrana-client` 0.10.0, así que lo tiene.

**Pero con una pega para Workers**, del propio mantenedor
([issue #723](https://github.com/tursodatabase/libsql/issues/723)): *"that's not the case for
Cloudflare workers: we need to figure out a way to utilise workers API to gracefully close
uncommitted transactions"*. Una transacción abandonada **no se cierra ordenadamente** y retiene la
conexión hasta que expire.

→ Sostener una transacción **entre peticiones** es frágil. Dentro de **una** petición, no.

### 2.3 Turso — branching

Turso permite [crear una base a partir de otra](https://docs.turso.tech/features/branching), incluso
desde un instante concreto. Es una foto congelada sin sostener nada.

→ Válido, pero mete Platform API, cuota y latencia. **Se descarta** porque el diseño de §3 no lo
necesita.

### 2.4 La conclusión que cambió el diseño

Al partir el problema en dos fases, **la parte difícil sólo afecta a la fase pequeña**:

- **Fase 1** necesita foto coherente y `Seq` exacto — pero es poca cosa y cabe de sobra.
- **Fase 2** es histórico: comandas cerradas, pagos viejos. **No necesita ser coherente con el
  `Seq`**, porque son datos que ya no cambian. Se puede paginar sin transacción, sin baton, sin
  branch y sin R2.

Y la reanudabilidad sale gratis: si una página falla, se reintenta esa página.

---

## 3. Diseño

```
  Pérdida de data.db
         │
         ├─ FASE 1 ── /v1/sync/bootstrap (acotado) ──► maestros + ventana reciente
         │              1 petición · 1 transacción · Seq exacto
         │              → reconciliación → LOGIN DESBLOQUEADO · el bar vende
         │
         └─ FASE 2 ── job de fondo, paginado ────────► histórico completo
                        sin transacción · INSERT OR IGNORE · reanudable
                        → el equipo ya está operativo mientras corre
```

### 3.1 Fase 1 — lo imprescindible

Mismo endpoint, mismo contrato de respuesta, mismo `Seq` en una transacción. Sólo cambia **qué
tablas y cuántas filas**.

> **Qué es «la ventana».** Es cuánto histórico baja **de golpe** para que el bar pueda volver a
> vender. Todo lo anterior llega después, en segundo plano, sin que nadie espere (fase 2). No es
> «lo que se puede recuperar»: se recupera todo igualmente, sólo que en dos tiempos.

**Decisión (2026-09-04): la ventana por defecto es de 7 días**, con la excepción de §3.1.1. El
razonamiento es que, como el resto llega solo, no hay motivo para hacer esperar al bar por datos que
no necesita para abrir la persiana. Cuando se midan filas/día en un restaurante real
([METRICAS_PRODUCCION.md](METRICAS_PRODUCCION.md)) se podrá subir — o, si el volumen resulta ser
pequeño, bajarlo todo de una vez y quedarse sin fase 2. **La ventana es un parámetro, no una
decisión de arquitectura**: cambiarla es cambiar un número.

**Maestros — completos, sin ventana.** Son los que dejan al bar operativo y crecen con el catálogo,
no con las ventas:

`Usuarios`, `Roles`, `Trabajadores`, `Mesas`, `Zonas`, `Productos`, `Categorias_Producto`,
`Alergenos`, `Producto_Alergenos`, `Proveedores`, `Clientes`, `Lotes_Producto`, `Business_Settings`,
`Contact_Settings`, `Ticket_Settings`, `Turnos`, `Horario_Predeterminado`, `Tareas`,
`Tarea_Asignaciones`, `Asignacion_Turnos`, `Reservas`.

⚠️ **`Ticket_Contador` es obligatorio en fase 1.** Sin él la numeración se reinicia y dos ventas
distintas comparten número — exactamente lo que el contador propio existe para evitar (CLAUDE.md §11).

⚠️ **`Reservas` va entera**, incluidas las futuras. Una reserva de la semana que viene importa más
que un ticket de hace un año.

**Transaccionales — sólo ventana reciente** (7 días por defecto):

`Comandas`, `Detalle_Comanda`, `Pagos`, `Pago_Detalles`, `Lote_Consumos`, `Suelto_Consumos`,
`Movimientos_Stock`, `Cuentas_Gastos`, `Cierres_Caja`, `Cierre_Denominaciones`, `Fichajes`,
`Fichaje_Dia`, `Aperturas_Cajon`, `Pedidos_Proveedor`, `Lineas_Pedido_Proveedor`, `Notificaciones`,
`Notificacion_Lecturas`.

#### 3.1.1 La ventana real es «7 días **o** el periodo de caja abierto, lo que sea más largo»

⚠️ Una ventana fija de 7 días tiene un agujero. El arqueo calcula
`esperado = fondo + cobros en efectivo desde el último cierre`
([`cierre_caja.rs:164`](../crates/tpv-infra-sqlite/src/cierre_caja.rs#L164)). Si el bar lleva **diez
días sin cerrar caja** —cosa que pasa: el aviso de «caja sin cerrar» es una notificación, no una
acción— la ventana de 7 días dejaría fuera tres días de cobros y **el primer arqueo tras recuperar
saldría descuadrado por un dinero que sí está en el cajón**.

Por eso la ventana efectiva es:

```
desde = MIN(hoy - 7 días, fecha del último cierre no reabierto)
```

Es la misma regla que ya aplica a `Cierres_Caja` abajo, generalizada: **el periodo de caja abierto
entra entero, siempre.** No hay que traer todo el histórico, sólo no partir el periodo en curso.

⚠️ **`Cierres_Caja` necesita al menos el último cierre no reabierto**, aunque caiga fuera de la
ventana: es lo que define el periodo de caja abierto y el gate de bloqueo (CLAUDE.md §12). Si la
ventana no lo alcanza, se incluye igualmente el más reciente.

**`Intentos_Login` no se restaura.** Es estado anti-fuerza-bruta, no dato de negocio: empezar con la
tabla vacía es correcto.

**Tablas hijas dentro de la ventana:** las que no tienen fecha propia (`Pago_Detalles`,
`Lote_Consumos`, `Suelto_Consumos`, `Cierre_Denominaciones`, `Lineas_Pedido_Proveedor`,
`Notificacion_Lecturas`) se filtran **por la fecha de su padre**, con un `JOIN`. Si se filtran por su
cuenta, entran huérfanas y revientan las FK.

**Streaming: todavía no.** Al recortar el alcance el volcado baja mucho, y el `db.batch` actual
probablemente sobra. Se mide primero (§8) y sólo se pasa a streaming si hace falta. El tope de
300.000 **se queda como guardia de la fase 1**, que es donde tiene sentido.

### 3.2 Fase 2 — el histórico, en segundo plano

Endpoint nuevo, paginado y sin transacción:

```
POST /v1/sync/historico
{ "tabla": "Pagos", "cursor": "<último ID de la página anterior>", "limite": 5000 }
→ { "columnas": [...], "filas": [[...]], "siguiente_cursor": "..." | null }
```

**Paginación por clave primaria ascendente**, no por fecha:

```sql
SELECT * FROM "Pagos" WHERE ID_Pago > ?1 ORDER BY ID_Pago LIMIT ?2;
```

Por qué por PK y no por fecha, que era lo intuitivo:

- Funciona **igual para todas las tablas**, incluidas las hijas que no tienen columna de fecha. Con
  fechas habría que mantener un mapa tabla→columna y casos especiales para las hijas.
- El cursor es **estable y total**: no hay empates ni filas saltadas.
- Se re-descarga la ventana de la fase 1 **una vez**. Es coste acotado y conocido, y a cambio
  desaparece toda una familia de casos especiales. Buen cambio.

**Orden de tablas: padres primero**, porque cada página es su propia transacción y `defer_foreign_keys`
sólo ayuda dentro de una:

```
Comandas → Detalle_Comanda → Pagos → Pago_Detalles → Lote_Consumos → Suelto_Consumos
Pedidos_Proveedor → Lineas_Pedido_Proveedor
Cierres_Caja → Cierre_Denominaciones
Notificaciones → Notificacion_Lecturas
Movimientos_Stock · Fichajes · Fichaje_Dia · Aperturas_Cajon · Cuentas_Gastos
```

---

## 4. Las tres trampas

### 4.1 La fase 2 no puede pisar lo que trajo el catch-up

El caso: la fase 1 deja `Last_Seq = S`. Después alguien **anula un pago antiguo** (que desde
CUENTA-07 es un `UPDATE` sobre la fila, no un borrado — CLAUDE.md §13). El catch-up trae ese
`UPDATE`, pero la fila aún no existe en local → falla → cuarentena. Y luego la fase 2 inserta la versión **vieja**, sin la
anulación. Resultado: un dato incorrecto que nadie ve.

**Solución: `INSERT OR IGNORE`.** La fase 2 nunca pisa una fila existente, porque lo que ya está es
más nuevo. Barato, pero hay que saberlo de antemano.

### 4.2 La fase 2 NO puede pasar por el outbox

Si los `INSERT` de la fase 2 van por `WriteGuard::execute`, se capturan en `_Sync_Outbox` y **el
equipo reenvía a la nube todo el histórico que acaba de bajarse de la nube**. Cientos de miles de
operaciones, facturadas como filas escritas en Turso, para no cambiar nada.

**Solución:** `WriteGuard::raw()`, igual que hacen `bootstrap_restaurar`
([`sync.rs:611`](../crates/tpv-infra-sqlite/src/sync.rs#L611)) y las escrituras de `_Jobs_State`.
Es el mismo aviso que ya está en CLAUDE.md §10, y aquí el coste de olvidarlo es mucho mayor.

### 4.3 La reconciliación va a gritar descuadres falsos durante el backfill

El job `reconciliacion` recalcula desde el origen lo que otras columnas guardan sumado
([`reconciliacion.rs`](../crates/tpv-infra-sqlite/src/reconciliacion.rs)):

- **Lotes:** `SUM(Movimientos_Stock.Delta) - SUM(Lote_Consumos.Cantidad)` contra
  `Lotes_Producto.Stock_Disponible`.
- **Clientes:** la suma de **todos** los pagos de sus reservas contra `Clientes.Total_Gastado`.

Los dos valores «guardados» (`Stock_Disponible`, `Total_Gastado`) son columnas de tablas **maestras**,
que la fase 1 restaura **completas y correctas**. Los dos valores «calculados» salen de tablas
**transaccionales**, que durante el backfill están **a medias**. Resultado: mientras la fase 2 corre,
prácticamente **todos** los lotes y **todos** los clientes con historial salen descuadrados.

**No corrompe nada** — el job sólo lee, y el propio comentario del fichero lo deja claro: *"la
decisión de qué hacer con un descuadre es de quien lleva el negocio, no del job"*. El daño es otro y
es peor de lo que parece: un aluvión de notificaciones falsas justo después de una recuperación
**enseña al usuario a ignorar precisamente la alarma que no debe ignorar**.

**Solución: el job `reconciliacion` no corre mientras el backfill esté incompleto.** Dos formas:

- comprobación al principio del cuerpo del job (¿queda alguna fila con `Completada = 0` en
  `_Backfill_Historico`? → salir con `Ok(())`), o
- una variante nueva de `Requiere` en el motor de jobs.

Lo primero es menos invasivo y se queda contenido en `jobs/registro.rs`. Al terminar el backfill, el
job vuelve solo en su siguiente vencimiento — y **esa** primera pasada sí es informativa, porque
compara sobre datos completos.

---

## 5. Esquema

Una tabla local de progreso. **No se replica** (prefijo `_`, como el resto del andamiaje):

```sql
CREATE TABLE IF NOT EXISTS _Backfill_Historico (
  Tabla TEXT PRIMARY KEY,
  Cursor TEXT NULL,
  Filas_Traidas INTEGER NOT NULL DEFAULT 0,
  Completada INTEGER NOT NULL DEFAULT 0,
  Ultimo_Intento_Ms INTEGER NULL,
  Ultimo_Error TEXT NULL
);
```

Se siembra al terminar la fase 1 (una fila por tabla transaccional, `Completada = 0`) y el job la va
avanzando. Con eso el backfill es reanudable por construcción: apagar el TPV por la noche no pierde
nada.

Cambio de esquema ⇒ los cinco sitios de CLAUDE.md §3 (0001, `tenantMigrations.ts`,
`esquemaTenant.ts`, `migrations.rs`, y rebendecir el snapshot). Aunque esta tabla sea local, el
snapshot anti-drift la ve.

---

## 6. Implementación

### 6.1 Worker

1. `sync.routes.ts`: `/v1/sync/bootstrap` pasa a aceptar `{ ventana_dias }` y construye el volcado
   según §3.1 — maestros completos, transaccionales filtrados, hijas por `JOIN` al padre.
2. `Cierres_Caja`: añadir el último cierre aunque quede fuera de la ventana.
3. `BOOTSTRAP_MAX_FILAS` se queda como guardia de fase 1 (y probablemente se puede bajar).
4. **Nuevo** `/v1/sync/historico` (§3.2): sin transacción, paginado por PK, `limite` acotado por
   servidor.
5. Ambos siguen exigiendo `isTpvDevice` — la Handy no se recupera, no tiene BD local.

### 6.2 Rust — contratos y persistencia

6. `tpv-contracts/src/sync.rs`: DTOs de la página del histórico y del progreso.
7. `tpv-infra-sqlite/src/sync.rs`:
   - `bootstrap_restaurar` siembra `_Backfill_Historico` al terminar.
   - Nuevo `historico_insertar_pagina(tabla, columnas, filas)`: `INSERT OR IGNORE` en lotes, por
     `raw()`, respetando `MAX_PARAMS_POR_SENTENCIA` (ya existe esa lógica de troceado).
   - Lectura/avance del cursor.
8. `tpv-infra-http`: el cliente del endpoint nuevo.

### 6.3 El job

9. `jobs/registro.rs`: job `backfill_historico`, `Requiere::MainOperativa`.
   - Que sea `MainOperativa` es justo lo que hace falta: **no corre mientras la reconciliación está
     pendiente**, así que no compite con la fase 1 ni retrasa el desbloqueo del login.
   - Cuerpo idempotente (lo exige el motor): mira `_Backfill_Historico`, coge la primera tabla no
     completada, pide una página, la inserta, avanza el cursor. **Unas pocas páginas por tick**, no
     el bucle entero — así el motor conserva el control y no se come el equipo en hora punta.
   - Cuando todas están completadas, no hace nada (no-op barato).
   - Devolver `Err` en caso de fallo, para que el backoff del motor actúe.
10. **Silenciar el job `reconciliacion` mientras el backfill esté incompleto** (§4.3): comprobación
    al principio de su cuerpo y salida con `Ok(())`. Sin esto, la recuperación termina con el panel
    de notificaciones lleno de descuadres inventados.

### 6.4 Frontend

11. **Manejar `BootstrapTooLarge`** — lo más barato y lo primero, independientemente del resto: hoy
    el usuario ve un error genérico. Que diga qué pasa y ofrezca la copia local.
12. Progreso discreto del backfill en Configuración → Conectividad (*"recuperando histórico: 45 %"*).
    Sin bloquear nada: el bar ya está vendiendo.
13. Que se note que el histórico puede estar incompleto en pantallas de estadísticas de rango largo
    mientras el backfill corre. Un total que crece solo, sin explicación, parece un error de cálculo.

---

## 7. Tests

**Rust:**
- `INSERT OR IGNORE` no pisa una fila existente ← §4.1
- la fase 2 **no deja nada en `_Sync_Outbox`** ← §4.2, el test que evita el reenvío masivo
- el cursor avanza y una página repetida es no-op
- reanudar a mitad continúa donde quedó
- una tabla que esta versión no conoce se informa, no revienta (misma regla que el bootstrap)

- el job `reconciliacion` **no emite nada** con el backfill a medias, y vuelve a emitir al terminar ← §4.3

**Worker (vitest):**
- el bootstrap acotado incluye todos los maestros y sólo la ventana de los transaccionales
- las hijas no salen huérfanas
- `Ticket_Contador` **siempre** está
- el último `Cierres_Caja` está aunque quede fuera de ventana
- **con un periodo de caja abierto de más de 7 días, la ventana se estira hasta cubrirlo** ← §3.1.1
- la paginación por PK no salta ni repite filas

**A mano — el ensayo que de verdad valida esto:** sobre un tenant con datos reales, borrar `data.db`,
recuperar, y cronometrar **cuánto tarda el bar en poder vender**. Después dejar el backfill correr y
comprobar que el histórico converge.

---

## 8. Qué queda pendiente de medir (y qué ya no)

**La ventana ya no bloquea.** La decisión está tomada en §3.1: **7 días**, estirados hasta cubrir el
periodo de caja abierto. Se eligió corta a propósito, porque el resto llega solo en segundo plano y
no tiene sentido hacer esperar al bar por datos que no necesita para abrir. **Este plan se puede
implementar entero sin medir nada.**

Lo que las métricas de [METRICAS_PRODUCCION.md](METRICAS_PRODUCCION.md) darán después es la
oportunidad de **afinar el parámetro**, no de desbloquear el trabajo:

| Número | Para qué sirve una vez medido |
|---|---|
| Filas/día por tabla en un bar real | Subir la ventana si resulta barato… o, si el volumen es pequeño, bajarlo todo de una vez y **quitar la fase 2 entera** |
| Tamaño y duración del volcado acotado | Confirmar que el `db.batch` actual basta, o pasar a streaming |
| Meses hasta las 300.000 filas | Saber cuánta vida le queda al tope como guardia de la fase 1 |

Que la ventana sea un número en un sitio, y no una decisión repartida por el código, es parte del
diseño: cambiarla tiene que costar cinco minutos.

**Independiente de todo lo demás y se puede hacer ya:** el punto 11 (manejar `BootstrapTooLarge` en
la UI). No depende de este plan ni de ninguna medición, y quita el peor síntoma actual.

---

## 9. Verificación

```bash
cargo nextest run
cargo test -p tpv-contracts
pnpm --filter tpv-api test
pnpm --filter @tpv/main typecheck && pnpm --filter @tpv/main test
node scripts/check-migration-registry.mjs
```

---

## 10. Fuera de alcance

- **Retención/archivado (DB-14).** Es la otra mitad del problema: este plan hace que recuperar no
  tenga techo, DB-14 hace que la base no crezca sin freno. Complementarios, no sustitutos.
- **Branching de Turso.** Descartado en §2.3. Queda en la recámara si algún día hiciera falta una
  foto coherente de *todo*.
- **Snapshot a R2.** El diseño de dos fases lo hace innecesario: la reanudabilidad ya sale de la
  paginación.
- **Recuperación de la Handy.** No tiene BD local; no aplica.
