# T1 — Esquema de base de datos + migraciones

> **Ámbito.** Modelo de datos único compartido por la app local (SQLite/libsql) y las BDs por-tenant
> de la nube (Turso), su sistema de migraciones espejo (Rust `include_dir!` ↔ worker registro
> manual), y la coherencia entre ambos runners. Ficheros:
> `packages/database/migrations/0001_inicial.sql` (**única** migración: antes del lanzamiento se
> consolidaron aquí las incrementales 0002..0008, ver la cabecera del propio fichero),
> `packages/database/schema.snapshot.sql`, `crates/tpv-infra-sqlite/src/migrations.rs`,
> `crates/tpv-infra-sqlite/src/db.rs` (`init_sync_tables`, `rewrite_now_literals`),
> `apps/cloud-worker-licensing/src/server/tenantMigrations.ts`.
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: DB-01 a DB-13 y DB-15.

## Cómo funciona hoy (resumen)

- **Fuente de verdad**: los ficheros `.sql` de `packages/database/migrations/`. El esquema se
  construye ejecutándolos en orden.
- **Runner Rust** (`migrations.rs`): embebe las migraciones con `include_dir!`, controla lo aplicado
  en la tabla `_migrations (name, hash, applied_at)`, verifica anti-tampering por hash SHA-256 y
  aplica cada pendiente en su propia transacción. Tests de humo + **anti-drift** contra
  `schema.snapshot.sql`.
- **Runner worker** (`tenantMigrations.ts`): espejo del anterior para las BDs de tenant en Turso;
  **registro manual** de migraciones (esbuild no soporta glob dinámico), con guard anti-drift en CI
  (`scripts/check-migration-registry.mjs`).
- **Tablas de sync locales** (`_Sync_Outbox`, `_Sync_Applied_Ops`, `_Sync_State`) NO están en las
  migraciones: las crea `init_sync_tables` en `db.rs` (solo en local).

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| DB-14 | 🔵 | `Clientes.Total_Gastado` denormalizado: riesgo de deriva si no se actualiza atómicamente | `0001_inicial.sql` (`Clientes`) |

### DB-14 🔵 `Total_Gastado` denormalizado
El gasto acumulado del cliente se mantiene como columna, actualizada en el cobro. Si esa
actualización falla, el pago **commitea igualmente** (decisión de MESA-06: best-effort explícito con
telemetría, porque el dato es reconciliable). Falta el reconciliador que lo recalcule desde `Pagos`
y avise de la deriva. Misma familia que INV-06/VR-06 (chequeos de reconciliación).

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| DB-01 | Índice `idx_dc_comanda` sobre `Detalle_Comanda(ID_Comanda)`: la ruta más caliente del POS deja de ser un full scan. |
| DB-02 | Las sentencias replicables escriben las columnas de fecha **explícitamente** con `datetime('now','localtime')`, que el capturador resuelve a literal. Cerradas también sus instancias RES-03 y TAR-01. |
| DB-03 | Ya no se depende de que `foreign_keys=ON` persista en Turso: las cascadas críticas se hacen **explícitas** en los comandos (ver PROV-04) y las validaciones de existencia se hacen en código (TAR-03). |
| DB-04 | `Email_Settings` y `Smtp_Password` **eliminados** del esquema: el correo sale por el worker, sin credenciales locales ni replicadas. |
| DB-05 | Índices añadidos en las FKs más consultadas (`idx_productos_categoria`, `idx_productos_proveedor`, `idx_reservas_cliente`, `idx_pago_detalles_detalle`, `idx_dc_producto`, …). |
| DB-06 | `CHECK` donde se podía añadir sin recrear tablas muy referenciadas (`Cantidad > 0`, `Cantidad_Inicial >= 0`); en el resto, validación en la capa de aplicación, anotada en el propio esquema. |
| DB-07 | Reparto de idempotencia documentado: `Applied_Operations` es de la **nube**; en local manda `_Sync_Applied_Ops`. |
| DB-08 | `Schema_Meta`/`schema_version` retirada: el versionado real es `_migrations`. |
| DB-09 | Fuera el `PRAGMA foreign_keys` no-op de la migración (con la nota de por qué); el PRAGMA se fija por conexión en `tune()`. |
| DB-10 | Documentación al día: ya no se cita `schema.sql` ni `include_str!` ni "sin migraciones". |
| DB-11 | Los seeds usan `localtime`, no UTC. |
| DB-12 | `v_inventario_producto_stock` reescrita sin subconsultas correlacionadas. |
| DB-13 | Tabla `Facturas` retirada: el cobro vive íntegramente en `Pagos` + `Pago_Detalles`. |
| DB-15 | Guard `uncovered_time_source` + `debug_assert` en `build_stmt`: una escritura replicable con una fuente de tiempo no canónica (`datetime('now')` sin `localtime`, `strftime`, `CURRENT_TIMESTAMP`, `julianday`) **revienta en debug**. Se restringe a una única forma canónica en vez de ampliar la reescritura. |

**Regla de oro al tocar el esquema:** nunca editar una migración ya publicada (rompe el hash →
error duro en ambos runners). Todo cambio va en una **migración nueva y aditiva**, registrada en los
**dos** runners (Rust `include_dir!` la recoge sola; el worker requiere añadir la línea en
`tenantMigrations.ts`), y luego **regenerar el snapshot**
(`BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite schema_snapshot`).
