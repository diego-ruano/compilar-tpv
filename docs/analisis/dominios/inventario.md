# D4 — Inventario (productos · categorías · lotes/FEFO · alérgenos · imágenes)

> **Ámbito.** Catálogo y control de existencias: productos, categorías, alérgenos, y **lotes** con
> caducidad (base del consumo FEFO que ejecuta [venta-rapida.md](venta-rapida.md)). Incluye la vista
> `v_inventario_producto_stock` y el canal de imágenes (R2).
> **Capas:** `crates/tpv-infra-sqlite/src/inventario.rs`, `use_cases/inventario.rs`,
> `crates/tpv-domain/src/inventario.rs`, `apps/cloud-worker-licensing/src/domains/inventario/*`,
> FE `apps/tpv-main/src/features/InventaryComponents/*` (React Query).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: INV-01 a INV-05, INV-08.

## Nota de alcance

El **consumo** de stock (FEFO, decrementos, `Lote_Consumos`) se analiza en
[venta-rapida.md](venta-rapida.md). Aquí se cubre la **gestión** del catálogo y los lotes (altas,
ajustes, coherencia de datos, borrados).

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| INV-06 | 🔵 | Sin **reconciliación** `Stock_Disponible == Cantidad_Inicial − SUM(Lote_Consumos)` | (transversal stock) |
| INV-07 | 🔵 | **Doble implementación** Rust/worker (parity risk) | `inventario.rs` ↔ `inventario.commands.ts` |

### INV-06 🔵 Sin reconciliación de stock
El cimiento ya existe (`Movimientos_Stock` registra cada alta y ajuste), pero no hay ningún chequeo
que compare el stock declarado con el consumo real. Gemelo de **VR-06**; falta decidir dónde corre
(¿tick en la Main? ¿informe bajo demanda?) y qué alerta genera.

### INV-07 🔵 Doble implementación
Instancia de **ARCH-01**; misma infraestructura de tests que STAT-06 → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

### Ampliaciones futuras conocidas (no son hallazgos)
- `ID_Usuario` en `Movimientos_Stock` queda **NULLABLE sin poblar**: la capa de comando aún no
  propaga el usuario actor.
- `update_lote` no audita su cambio de stock (solo ALTA y AJUSTE cuentan como "movimientos").

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| INV-01 | Coherencia `Stock_Disponible <= Cantidad_Inicial` en create/update (dominio) y en `ajustar_lote` (validada en el repo, atómica con la lectura, sin TOCTOU; también en la ruta del worker). **Auditoría:** tabla `Movimientos_Stock` que registra cada ALTA y AJUSTE (delta, stock resultante, motivo, fecha), replicada por el outbox con IDs deterministas. |
| INV-02 | El alta de lote es **pura** (`ON CONFLICT(ID_Lote) DO NOTHING`) en Rust y worker: re-crear un lote nunca resetea `Stock_Disponible`. La edición va por `update_lote`/`ajustar_lote`; la idempotencia de reintentos la da el gate `Op_Id`/`_Sync_Applied_Ops`. |
| INV-03 | `LoteNuevo::validar` valida el formato ISO de `Caducidad`/`Fecha_Entrada` (rechaza fechas imposibles vía `chrono::NaiveDate`) y exige `caducidad >= fecha_entrada`. |
| INV-04 | La query de "menos stock" del resumen se reescribió sin subconsultas correlacionadas (`GROUP BY` + `ROW_NUMBER()`), en Rust y worker, con resultado idéntico. |
| INV-05 | `delete_producto` avisa con mensaje claro si el producto tiene histórico en `Detalle_Comanda`; el borrado de hijos es explícito (no depende de CASCADE) e incluye `Movimientos_Stock`. |
| INV-08 | `ImageWithFallback` (placeholder + reintentos) cubre todo el catálogo y `useMainSocket` drena las imágenes pendientes al conectar/reconectar y cada 3 s. |
