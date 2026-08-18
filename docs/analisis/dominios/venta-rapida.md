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

### VR-06 🟡 Sin reconciliación de stock

> **Parcialmente cubierto (INV-06 cerrado).** El job `reconciliacion` ya comprueba a diario el
> invariante LOCAL de cada lote (`SUM(movimientos) − SUM(consumos)`) y avisa de lo que no cuadre.
> Lo que sigue abierto es la comparación **Main ↔ nube**: si las dos copias divergen (una op en
> cuarentena, por ejemplo), cada una cuadra consigo misma y nadie las contrasta entre sí.
No hay ningún proceso que verifique `Stock_Disponible == Cantidad_Inicial − SUM(Lote_Consumos)`.
Con el modelo actual (no se bloquea por falta de stock, el sobrante va al stock suelto), un
descuadre solo se ve mirando los números a mano. Gemelo de **INV-06**; su cimiento (la tabla
`Lote_Consumos` y `Movimientos_Stock`) ya existe. Falta decidir dónde corre y qué alerta.

### VR-07 🔵 Round-trips por venta
El consumo FEFO lee los lotes del producto y emite dos escrituras por lote dentro de la
transacción. Con pocas líneas es irrelevante; conviene tenerlo presente si algún día una venta pasa
a tener decenas de líneas. Sin impacto medido hoy.
