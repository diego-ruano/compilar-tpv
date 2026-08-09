# T1 — Esquema de base de datos + migraciones

> **Ámbito.** Modelo de datos único compartido por la app local (SQLite/libsql) y las BDs por-tenant
> de la nube (Turso), su sistema de migraciones espejo (Rust `include_dir!` ↔ worker registro
> manual), y la coherencia entre ambos runners. Ficheros:
> `packages/database/migrations/0001_inicial.sql` (**única** migración: antes del lanzamiento se
> consolidaron aquí las incrementales 0002..0008, ver la cabecera del propio fichero),
> `packages/database/schema.snapshot.sql`, `crates/tpv-infra-sqlite/src/migrations.rs`,
> `crates/tpv-infra-sqlite/src/db.rs` (`init_sync_tables`, `rewrite_now_literals`),
> `apps/cloud-worker-licensing/src/server/tenantMigrations.ts`.

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

**Regla de oro al tocar el esquema:** nunca editar una migración ya publicada (rompe el hash →
error duro en ambos runners). Todo cambio va en una **migración nueva y aditiva**, registrada en los
**dos** runners (Rust `include_dir!` la recoge sola; el worker requiere añadir la línea en
`tenantMigrations.ts`), y luego **regenerar el snapshot**
(`BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite schema_snapshot`).
