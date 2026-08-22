# D2 — Venta rápida (POS de mostrador)

> **Ámbito.** Ventas de mostrador (barra) con descuento de inventario por **lotes FEFO**: cobro
> directo, cobro fraccionado por detalle, resta de stock y trazabilidad `Lote_Consumos`.
> **Capas:** `crates/tpv-infra-sqlite/src/venta_rapida.rs`,
> `crates/tpv-application/src/use_cases/venta_rapida.rs`,
> `apps/tpv-main/src-tauri/src/commands/venta_rapida.rs`,
> `apps/cloud-worker-licensing/src/domains/venta_rapida/*` (implementación paralela Handy + cálculo
> del `plan` FEFO), FE `apps/tpv-main/src/features/ventaRapida/*`.

## Cómo funciona hoy

- **Main (Rust):** `cobrar_fraccionado` inserta el pago, enlaza `Pago_Detalles` y **consume FEFO
  dentro de la misma transacción** (lee lotes → calcula reparto → `UPDATE Lotes_Producto` +
  `INSERT Lote_Consumos` con **valores literales**).
- **Handy (worker):** la ruta calcula el reparto FEFO con el estado de los lotes **en memoria** (se
  decrementa según se asigna, de modo que varias líneas del mismo producto consumen en cascada) y
  emite `UPDATE Lote X -= take` literales que el DO aplica en Turso y replica a la Main.
- **Decisión de negocio:** el cobro **no se bloquea por falta de stock**. El descuento es un delta
  relativo (`Stock -= take`) idéntico en Main y Handy; aplicarlo **a secas, sin clamp a 0**, es lo que
  hace que las dos copias converjan al replicarse. Como consecuencia **un lote puede quedar negativo**:
  es la señal honesta de sobreventa, que el bar cuadra a mano (el `CHECK (Stock_Disponible >= 0)` se
  quitó en la migración 0003). El job `stock_negativo` avisa —una notificación por producto— cuando el
  stock total de un producto cae por debajo de cero. El sobrante que los lotes no cubren va al *stock
  suelto* por producto, que también puede quedar negativo.

**Coste del consumo FEFO (medido, no es un hallazgo).** El cobro hace 1 `SELECT` de lotes por línea
y 2 escrituras por lote consumido, dentro de la transacción. Medido sobre SQLite local: un ticket
**extremo** de 100 líneas con 2 lotes cada una (100 lecturas + 400 escrituras contando la captura
del outbox) se resuelve en ~15 ms. Un ticket real anda por dos órdenes de magnitud menos. Sería otra
historia si este bucle corriera contra una BD remota —ahí cada sentencia es un salto de red—, pero
en la Main es local y en una sola transacción. Decisión (2026-08-22): se deja como está.

---

## Hallazgos abiertos

Ninguno.


