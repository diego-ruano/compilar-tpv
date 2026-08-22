# D4 — Inventario (productos · categorías · lotes/FEFO · alérgenos · imágenes)

> **Ámbito.** Catálogo y control de existencias: productos, categorías, alérgenos, y **lotes** con
> caducidad (base del consumo FEFO que ejecuta [venta-rapida.md](venta-rapida.md)). Incluye la vista
> `v_inventario_producto_stock` y el canal de imágenes (R2).
> **Capas:** `crates/tpv-infra-sqlite/src/inventario.rs`, `use_cases/inventario.rs`,
> `crates/tpv-domain/src/inventario.rs`, `apps/cloud-worker-licensing/src/domains/inventario/*`,
> FE `apps/tpv-main/src/features/InventaryComponents/*` (React Query).

## Nota de alcance

El **consumo** de stock (FEFO, decrementos, `Lote_Consumos`) se analiza en
[venta-rapida.md](venta-rapida.md). Aquí se cubre la **gestión** del catálogo y los lotes (altas,
ajustes, coherencia de datos, borrados).

## Hallazgos abiertos

Ninguno.


### Ampliaciones futuras conocidas (no son hallazgos)
- `ID_Usuario` en `Movimientos_Stock` queda **NULLABLE sin poblar**: la capa de comando aún no
  propaga el usuario actor.
- `update_lote` no audita su cambio de stock (solo ALTA y AJUSTE cuentan como "movimientos").
