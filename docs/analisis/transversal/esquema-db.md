# T1 — Esquema de base de datos + migraciones

> **Ámbito.** Modelo de datos único compartido por la app local (SQLite/libsql) y las BDs por-tenant
> de la nube (Turso), su sistema de migraciones espejo (Rust `include_dir!` ↔ worker registro
> manual), y la coherencia entre ambos runners. Ficheros:
> `packages/database/migrations/0001_inicial.sql`, `0002_contact_settings.sql`,
> `packages/database/schema.snapshot.sql`, `crates/tpv-infra-sqlite/src/migrations.rs`,
> `crates/tpv-infra-sqlite/src/db.rs` (`init_sync_tables`, `rewrite_now_literals`),
> `apps/cloud-worker-licensing/src/server/tenantMigrations.ts`.

## Cómo funciona hoy (resumen)

- **Fuente de verdad**: los ficheros `.sql` de `packages/database/migrations/`. El esquema se
  construye ejecutándolos en orden. **Ya no existe `schema.sql`** (aunque medio código y docs lo
  siguen citando — ver DB-10).
- **Runner Rust** (`migrations.rs`): embebe las migraciones con `include_dir!`, controla lo aplicado
  en la tabla `_migrations (name, hash, applied_at)`, verifica anti-tampering por hash SHA-256 y
  aplica cada pendiente en su propia transacción. Tests de humo + **anti-drift** contra
  `schema.snapshot.sql`.
- **Runner worker** (`tenantMigrations.ts`): espejo del anterior para las BDs de tenant en Turso;
  **registro manual** de migraciones (esbuild no soporta glob dinámico).
- **Tablas de sync locales** (`_Sync_Outbox`, `_Sync_Applied_Ops`, `_Sync_State`) NO están en las
  migraciones: las crea `init_sync_tables` en `db.rs` (solo en local).

---

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| DB-01 | 🟠 | Falta índice en `Detalle_Comanda(ID_Comanda)` — full scan en la ruta más caliente del POS | `0001_inicial.sql:318` |
| DB-02 | 🟠 | Columnas con `DEFAULT (datetime('now','localtime'))` **divergen** entre Main y nube cuando el INSERT omite la columna | `0001_inicial.sql` (múltiples) + `db.rs:116` |
| DB-03 | 🟠 | Aplicación de **foreign keys en Turso sin garantizar** (el `probe` fija el PRAGMA, pero puede no persistir entre peticiones HTTP) → riesgo de cascadas/`SET NULL`/integridad divergentes local↔nube | `tenantHub.ts:569,771` + `0001_inicial.sql:29` |
| DB-04 | 🟠 | `Email_Settings.Smtp_Password` en **texto plano** y (si se sincroniza) replicado a la nube | `0001_inicial.sql:565` |
| DB-05 | 🟡 | Índices ausentes en varias FKs muy consultadas (`Productos.ID_Categoria`, `Pago_Detalles.ID_Detalle`, `Reservas.ID_Cliente`, …) | varios |
| DB-06 | 🟡 | Sin `CHECK` en importes/cantidades (`Detalle_Comanda`, `Pagos`, `Comandas`) → permite negativos/0 | `0001_inicial.sql:318,444` |
| DB-07 | 🟡 | Doble tabla de idempotencia en local: `Applied_Operations` (del esquema, **sin uso** local) vs `_Sync_Applied_Ops` (la real) | `0001_inicial.sql:482` + `db.rs:531` |
| DB-08 | 🟡 | Doble versionado de esquema: `Schema_Meta.schema_version='2'` vestigial frente a `_migrations` | `0001_inicial.sql:510` |
| DB-09 | 🟡 | `PRAGMA foreign_keys = ON` dentro de la migración es **no-op** (dentro de tx / no persiste); depende de `tune()` | `0001_inicial.sql:29` |
| DB-10 | 🔵 | Deriva de documentación: se sigue citando `schema.sql` / `include_str!` / "Sin migraciones" en varios sitios | CLAUDE.md, `db.rs:459`, `util.rs:34`, `0001:1-15` |
| DB-11 | 🔵 | Seeds usan `datetime('now')` (UTC), no `localtime` → `Updated_At` de BARRA difiere local↔nube | `0001_inicial.sql:634,660` |
| DB-12 | 🔵 | `v_inventario_producto_stock`: subconsultas correlacionadas O(productos) | `0001_inicial.sql:583` |
| DB-13 | 🔵 | Redundancia `Facturas` vs `Pagos` — dos modelos de cobro, fuente de verdad ambigua | `0001_inicial.sql:351,444` |
| DB-14 | 🔵 | `Clientes.Total_Gastado` denormalizado: riesgo de deriva si no se actualiza atómicamente | `0001_inicial.sql:270` |
| DB-15 | 🔵 | `rewrite_now_literals` solo cubre las formas exactas; cualquier `datetime('now')` sin `localtime` o `strftime(...)` replicado diverge en silencio | `db.rs:116-124` |

---

## Detalle de hallazgos

### DB-01 🟠 Falta índice en `Detalle_Comanda(ID_Comanda)` (y `ID_Producto`) — CONFIRMADO
- **Ubicación:** tabla `Detalle_Comanda` (`0001_inicial.sql:318-330`). Índices existentes:
  `idx_dc_cocinero_fecha (ID_Usuario_Cocinero, Fecha_Hora_Cocina)` y
  `idx_dc_estado_fecha (Estado_Cocina, Fecha_Hora_Cocina)`. **No hay índice por `ID_Comanda`.**
- **Fallo:** la consulta más frecuente del POS es "dame las líneas de esta comanda"
  (`SELECT … FROM Detalle_Comanda WHERE ID_Comanda = ?`). Sin índice, SQLite hace **full scan** de
  toda la tabla de líneas en cada apertura/refresco de comanda, cobro y ticket.
- **Escenario:** restaurante con historial → `Detalle_Comanda` acumula decenas de miles de filas
  (no se purga). Abrir una mesa recorre toda la tabla. La latencia crece linealmente con el histórico.
- **Impacto:** degradación progresiva del núcleo de ventas; empeora cuanto más se usa el TPV.
- **Arreglo:** nueva migración `0003_indices_fk.sql` con
  `CREATE INDEX IF NOT EXISTS idx_dc_comanda ON Detalle_Comanda(ID_Comanda);` y
  `CREATE INDEX IF NOT EXISTS idx_dc_producto ON Detalle_Comanda(ID_Producto);`. Registrar también en
  `tenantMigrations.ts`. Verificar con `EXPLAIN QUERY PLAN`.

### DB-02 🟠 `DEFAULT (datetime('now','localtime'))` diverge bajo sync — CONFIRMADO (raíz de esquema)
- **Ubicación:** columnas con default temporal no determinista: `Clientes.Created_At`,
  `Reservas.Created_At`, `Lotes_Producto.Fecha_Entrada`, `Pedidos_Proveedor.Fecha_Creacion`,
  `Tareas.Fecha_Creacion`, `Tarea_Asignaciones.Asignada_At`, y los `Updated_At` de los singletons.
- **Fallo:** `rewrite_now_literals` (`db.rs:116`) solo reescribe la función **cuando aparece
  literalmente en el texto SQL** de la sentencia replicada. Si un `INSERT` **omite** una de estas
  columnas y confía en su `DEFAULT`, el default NUNCA aparece en el SQL capturado en el outbox → la
  nube (y cualquier re-apply) evalúa `datetime('now','localtime')` en **otro instante y zona** → la
  misma fila queda con `Created_At` distinto en Main y en Turso.
- **Escenario:** Handy consulta por REST una fila creada en Main; el `Created_At` que ve no coincide
  con el local. Si alguna lógica ordena/filtra por esas fechas (listados "recientes", KPIs por día),
  los resultados difieren según el dispositivo.
- **Impacto:** divergencia silenciosa de datos entre dispositivos; sutil y difícil de depurar.
- **Arreglo:** dos opciones complementarias — (a) que **todos** los constructores de sentencias
  (Rust y `*.commands.ts`) inserten SIEMPRE estas columnas con el literal ya resuelto (patrón
  "value-step" que ya se aplica a los UUID de PK); (b) auditar que ningún `INSERT` replicable dependa
  del `DEFAULT` temporal. Ver cruce con [sync-tenanthub.md](sync-tenanthub.md) (DB-15).

### DB-03 🟠 Aplicación de FK en Turso sin garantizar — PLAUSIBLE (verificar)
- **Ubicación:** `tune()` activa `PRAGMA foreign_keys=ON` en cada conexión **local** (Rust,
  `db.rs:205`). En la nube, `TenantHub.probeTenantDb` **sí** ejecuta `PRAGMA foreign_keys=ON` al
  resolver la conexión del tenant (`tenantHub.ts:569`, autocommit, cacheado 6 h) y el batch de
  escritura antepone `PRAGMA defer_foreign_keys=ON` (`:771`). El único PRAGMA de la migración `0001`
  (línea 29) es **no-op** (ver DB-09).
- **Fallo (duda):** `foreign_keys` es un ajuste **por conexión**. Con `@libsql/client/web` (HTTP), no
  está garantizado que el PRAGMA fijado en el `probe` **persista** hasta los `db.batch(...)`
  posteriores (peticiones HTTP distintas). Si el protocolo no reutiliza la misma conexión servidor,
  el batch podría ejecutarse **sin** `foreign_keys` activo (y dentro de la transacción ya no puede
  activarse) → la nube no aplicaría `ON DELETE CASCADE`/`SET NULL` ni la integridad referencial.
- **Escenario a comprobar:** borrar una `Zona` en Main → localmente cascada a `Mesas`. El outbox
  replica solo `DELETE FROM Zonas WHERE …`; si en Turso la FK no está activa en el batch, las `Mesas`
  hijas quedan **huérfanas**. Igual con `Trabajadores`→`Horario_Predeterminado`, `Pedidos`→`Lineas`.
- **Impacto:** posible divergencia estructural local↔nube; filas huérfanas que una Handy podría leer.
- **Arreglo:** **verificar empíricamente** (una escritura que viole una FK contra Turso: ¿la
  rechaza?). Si no se garantiza, **no depender de cascadas del motor** en la nube: que los comandos
  borren explícitamente los hijos (cascada "manual" replicada por el outbox), que además es la forma
  correcta para que ambos lados converjan. Ver nota en [sync-tenanthub.md](sync-tenanthub.md).

### DB-04 🟠 SMTP password en texto plano (y potencialmente replicado) — CONFIRMADO (parcial)
- **Ubicación:** `Email_Settings.Smtp_Password TEXT NOT NULL DEFAULT ''` (`0001_inicial.sql:571`).
- **Fallo:** la contraseña SMTP se guarda en claro en el SQLite local. Si `Email_Settings` entra en
  la ruta de sincronización, viaja **en claro** a Turso y podría verse desde el worker/Handy.
- **Impacto:** exposición de credenciales de correo del negocio.
- **Arreglo:** (1) verificar si `Email_Settings` se sincroniza; si sí, **excluirla** del outbox o
  cifrar el campo; (2) idealmente almacenar el secreto en el keyring del SO (ya se usa para
  licensing) en vez de en la BD. Ver cruce con [configuracion.md](../dominios/configuracion.md).

### DB-05 🟡 Índices ausentes en FKs consultadas
- **Ubicación / faltantes:** `Productos(ID_Categoria)` (rejilla de productos filtra por categoría),
  `Productos(ID_Proveedor)`, `Pago_Detalles(ID_Detalle)` (la PK es `(ID_Pago, ID_Detalle)`; buscar
  por `ID_Detalle` no usa índice), `Reservas(ID_Cliente)`, `Facturas(ID_Cliente)`.
- **Impacto:** scans en listados y en borrados/comprobaciones de integridad.
- **Arreglo:** añadir índices en la migración `0003_indices_fk.sql`. Priorizar `Productos(ID_Categoria)`
  y `Pago_Detalles(ID_Detalle)`.

### DB-06 🟡 Sin `CHECK` en importes/cantidades
- **Ubicación:** `Detalle_Comanda.Cantidad` / `Precio_Unitario`, `Pagos.Importe_Total`,
  `Comandas.Total_Comanda`, `Facturas.*`, `Cuentas_Gastos.Importe`.
- **Fallo:** el motor acepta cantidades 0/negativas o importes negativos si la capa de aplicación
  falla en validar. `Lotes_Producto` sí tiene `CHECK (… >= 0)`; el resto no.
- **Impacto:** posibilidad de líneas/pagos corruptos que descuadran caja y stock.
- **Arreglo:** añadir `CHECK (Cantidad > 0)`, `CHECK (Precio_Unitario >= 0)`,
  `CHECK (Importe_Total >= 0)` **en tablas nuevas** (SQLite no permite añadir CHECK con `ALTER`; para
  las existentes hay que validarlo en la capa de aplicación y documentarlo). Confirmar primero que no
  haya casos legítimos de negativos (devoluciones/abonos) — ver [cuentas.md](../dominios/cuentas.md).

### DB-07 🟡 Doble tabla de idempotencia en local
- **Ubicación:** `Applied_Operations` (esquema compartido, `0001:482`) vs `_Sync_Applied_Ops`
  (`db.rs:531`, la que usa el Main).
- **Fallo:** `Applied_Operations` la usa la **nube**; en local se crea pero no se usa. Sus 3 índices
  se mantienen sin aportar valor. Confunde sobre cuál es la fuente de idempotencia real.
- **Arreglo:** documentar explícitamente el reparto (nube→`Applied_Operations`, Main→
  `_Sync_Applied_Ops`) o, si se quiere limpiar, mover `Applied_Operations` fuera del esquema
  compartido a una migración solo-nube (requiere separar los runners, mayor coste).

### DB-08 🟡 Doble versionado de esquema
- **Ubicación:** `Schema_Meta` con `schema_version='2'` (`0001:510-517`) frente a `_migrations`.
- **Fallo:** dos mecanismos de versión conviven; `Schema_Meta.schema_version` quedó congelado en '2'
  y no lo actualiza nadie. Fuente de confusión.
- **Arreglo:** marcar `Schema_Meta` como vestigial en un comentario o retirarlo si nada lo lee
  (grep `schema_version` en Rust/worker antes de tocar).

### DB-09 🟡 `PRAGMA foreign_keys = ON` en la migración es no-op
- **Ubicación:** `0001_inicial.sql:29`.
- **Fallo:** (1) `foreign_keys` es un ajuste **por conexión**, no persiste en el fichero; (2) además
  se ejecuta dentro de la transacción del runner, donde el PRAGMA es no-op en SQLite. La aplicación
  real de FK local la da `tune()`, no la migración.
- **Impacto:** engaña al lector (parece que el esquema garantiza FK). Ver DB-03 para la nube.
- **Arreglo:** quitar la línea de la migración (o comentar que es informativa) y dejar claro que la
  aplicación de FK es responsabilidad de cada runner de conexión.

### DB-10 🔵 Deriva de documentación (`schema.sql` fantasma)
- **Ubicación:** CLAUDE.md (§9 y mapa), cabecera de `0001_inicial.sql:1-15` ("Sin migraciones:
  pensado para borrar DB y recrear", `include_str! en main.rs`, "import como módulo Text en
  server/index.ts"), `db.rs:459`, `util.rs:34`.
- **Fallo:** describen un mecanismo (`schema.sql`) que ya **no existe**; el real es migraciones.
- **Arreglo:** actualizar las referencias. La cabecera de `0001` es especialmente engañosa porque
  afirma justo lo contrario del sistema actual.

### DB-11 🔵 Seeds con `datetime('now')` (UTC) en vez de `localtime`
- **Ubicación:** `INSERT … Zonas BARRA` (`0001:634`) y `Mesas BARRA` (`0001:660`) usan `datetime('now')`.
- **Fallo:** UTC en el seed vs `localtime` en el resto. Como cada runner siembra por su lado, el
  `Updated_At` de BARRA puede diferir local↔nube (además de estar en otra zona horaria que el resto
  de timestamps de la app).
- **Arreglo:** usar `datetime('now','localtime')` por coherencia, o un literal fijo dado que es un
  seed determinista.

### DB-12 🔵 Vista de stock con subconsultas correlacionadas
- **Ubicación:** `v_inventario_producto_stock` (`0001:583-610`): dos subconsultas correlacionadas por
  producto (caducidad próxima y lote próximo) sobre `Lotes_Producto`.
- **Impacto:** coste O(productos × lotes) al materializar la vista completa; aceptable con catálogos
  pequeños, a vigilar con inventarios grandes.
- **Arreglo:** medir con `EXPLAIN QUERY PLAN`; si pesa, considerar materialización periódica o
  precalcular "lote próximo" con una tabla auxiliar mantenida por FEFO. Los índices `idx_lotes_*` ya
  ayudan.

### DB-13 🔵 Redundancia `Facturas` vs `Pagos`
- **Ubicación:** `Facturas` (1 por comanda, `ID_Comanda UNIQUE`) y `Pagos` (N por comanda, con
  `Tipo`/`Metodo_Pago`).
- **Fallo:** dos representaciones del cobro; no está claro cuál manda para KPIs/arqueo ni cómo se
  mantienen consistentes (p. ej. pagos parciales vs una única factura).
- **Arreglo:** documentar la relación (¿`Facturas` = resumen fiscal, `Pagos` = movimientos?) y
  asegurar que se escriben en la misma transacción. Cruce con [cuentas.md](../dominios/cuentas.md) y
  [mesas.md](../dominios/mesas.md).

### DB-14 🔵 `Clientes.Total_Gastado` denormalizado
- **Ubicación:** `Clientes.Total_Gastado REAL NOT NULL DEFAULT 0`.
- **Fallo:** agregado mantenido a mano; si algún cobro no lo actualiza (o lo hace fuera de la
  transacción del pago), deriva del total real de facturas del cliente.
- **Arreglo:** garantizar que se actualiza en la misma transacción que el cobro; añadir una
  comprobación de reconciliación. Cruce con [clientes.md](../dominios/clientes.md).

### DB-15 🔵 `rewrite_now_literals` cubre solo formas exactas
- **Ubicación:** `db.rs:116-124`.
- **Fallo:** solo reescribe `datetime('now','localtime')` y `date('now','localtime')`. Cualquier
  sentencia replicable que use `datetime('now')` (sin `localtime`), `strftime(...)`, `CURRENT_TIMESTAMP`
  o `julianday('now')` **no se resuelve** y divergiría en la nube.
- **Arreglo:** ampliar la cobertura (o prohibir por lint esas formas en sentencias replicables) y
  añadir un test que escanee los `*.commands.ts` y el SQL Rust replicable en busca de funciones de
  tiempo no cubiertas. Cruce con [sync-tenanthub.md](sync-tenanthub.md).

---

## Workflow de corrección (T1)

Orden sugerido (de mayor impacto/menor riesgo a mayor):

1. **Rendimiento — índices (DB-01, DB-05).** Crear `packages/database/migrations/0003_indices_fk.sql`
   (solo `CREATE INDEX IF NOT EXISTS`). Registrar la línea en `tenantMigrations.ts` (`m0003`).
   Verificar con `cargo test -p tpv-infra-sqlite` (el test anti-drift exigirá **regenerar el
   snapshot**: `BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite schema_snapshot`). Comprobar
   `EXPLAIN QUERY PLAN` de la carga de comanda.
2. **Determinismo temporal (DB-02, DB-15).** Auditar constructores de sentencias replicables (Rust +
   `*.commands.ts`); asegurar que insertan las columnas de fecha con literal resuelto. Ampliar
   `rewrite_now_literals` + test de escaneo. (Coordinar con T2 Sync.)
3. **Integridad referencial en nube (DB-03).** Verificar FK en Turso; si están OFF, migrar las
   cascadas críticas a borrado explícito en los comandos. (Coordinar con T2 y los dominios afectados.)
4. **Seguridad (DB-04).** Confirmar si `Email_Settings` se sincroniza; excluir/cifrar el password o
   moverlo al keyring. (Coordinar con D10 Configuración.)
5. **Robustez de datos (DB-06).** Decidir política de importes negativos (¿abonos?) y añadir `CHECK`
   donde aplique en tablas nuevas + validación de aplicación en las existentes.
6. **Limpieza/consistencia (DB-07, DB-08, DB-09, DB-10, DB-11).** Documentar/retirar duplicados,
   quitar el PRAGMA no-op, actualizar la deriva de documentación, unificar `localtime` en seeds.
7. **Vigilancia (DB-12, DB-13, DB-14).** Medir la vista de stock; documentar el modelo de cobro;
   añadir reconciliación de `Total_Gastado`.

**Regla de oro al tocar el esquema:** nunca editar una migración ya publicada (rompe el hash →
error duro en ambos runners). Todo cambio va en una **migración nueva y aditiva**, registrada en los
**dos** runners (Rust `include_dir!` la recoge sola; el worker requiere añadir la línea en
`tenantMigrations.ts`), y luego **regenerar el snapshot**.
