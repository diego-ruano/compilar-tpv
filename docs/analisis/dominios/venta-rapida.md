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
- **Decisión de negocio:** el cobro **no se bloquea por falta de stock**. Los lotes nunca quedan
  negativos (clamp a 0); el sobrante va al *stock suelto* por producto, que sí puede quedar negativo
  y es la señal de que hay descuadre. Vale igual para Main y Handy.

---

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| VR-05 | 🟡 | **Doble implementación** Rust/worker de FEFO (misma clase de riesgo que MESA-11) | `venta_rapida.rs` ↔ `venta_rapida.commands.ts` |
| VR-06 | 🟡 | Sin **reconciliación de stock** entre Main y nube; ante deriva previa, los repartos divergen | (transversal stock) |
| VR-07 | 🔵 | Muchos round-trips por venta (N lecturas de lotes + 2N updates) dentro de la tx | `venta_rapida.rs` (consumo FEFO) |

### VR-05 🟡 Doble implementación del FEFO
Mismo problema estructural que MESA-11: el reparto FEFO está codificado dos veces (Rust y TS) y
tiene que comportarse igual. Hoy están igualados a mano. **Arreglo:** tests de contrato (SQL
golden) → ARCH-01, ver [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

### VR-06 🟡 Sin reconciliación de stock entre Main y nube

El chequeo **local** ya existe (INV-06, cerrado): el job `reconciliacion` cuadra a diario cada lote
contra su propio historial (`SUM(Movimientos_Stock.Delta) − SUM(Lote_Consumos.Cantidad)`) y avisa.

Lo que queda abierto es **contrastar las dos copias entre sí**. Hoy nada lo hace: el canal de sync
(`/v1/sync/changes`, `sync.routes.ts`) reproduce el log de operaciones desde un número de secuencia,
no compara estados. Cada lado puede cuadrar consigo mismo y tener números distintos del otro.

**Cómo llegan a divergir.** El reparto FEFO de una venta de la Handy se calcula contra el stock de
la **nube** y se replica a la Main como deltas relativos (`Stock_Disponible - ?`), así que una
diferencia previa no se corrige sola: se arrastra. Y si la resta deja el lote por debajo de cero en
la Main, choca con el `CHECK (Stock_Disponible >= 0)` y la operación acaba en cuarentena
(`_Sync_Failed`) — a partir de ahí la divergencia ya no es de un número, es de una venta entera.

**Arreglo:** un contraste periódico de sumas por lote (o un hash por tabla) entre Main y nube, que
señale las filas divergentes. Barato si se hace por agregados; el detalle solo hace falta cuando el
agregado no cuadra.

### VR-07 🔵 Round-trips por venta
El consumo FEFO lee los lotes del producto y emite dos escrituras por lote dentro de la
transacción. Con pocas líneas es irrelevante; conviene tenerlo presente si algún día una venta pasa
a tener decenas de líneas. Sin impacto medido hoy.
