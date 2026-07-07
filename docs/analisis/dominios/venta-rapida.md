# D2 — Venta rápida (POS de mostrador)

> **Ámbito.** Ventas de mostrador (barra) con descuento de inventario por **lotes FEFO**: cobro
> directo, cobro fraccionado por detalle, resta de stock y trazabilidad `Lote_Consumos`. Es el
> **único** flujo que descuenta inventario (ver MESA-01).
> **Capas:** `crates/tpv-infra-sqlite/src/venta_rapida.rs` (~1350 líneas),
> `crates/tpv-application/src/use_cases/venta_rapida.rs`,
> `apps/tpv-main/src-tauri/src/commands/venta_rapida.rs`,
> `apps/cloud-worker-licensing/src/domains/venta_rapida/*` (implementación paralela Handy + cálculo
> del `plan` FEFO), FE `apps/tpv-main/src/features/ventaRapida/*`.

## Cómo funciona hoy

- **Main (Rust):** `cobrar_fraccionado` valida suficiencia (todo-o-nada por producto), inserta el
  pago, enlaza `Pago_Detalles`, y **consume FEFO dentro de la misma transacción** (lee lotes →
  calcula reparto → `UPDATE Lotes_Producto` + `INSERT Lote_Consumos` con **valores literales**).
- **Handy (worker):** la ruta calcula un **`plan` FEFO** (lectura de lotes) **antes** de construir el
  comando, y emite `UPDATE Lote X -= take` literales que el DO aplica en Turso y replica a la Main.

---

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| VR-01 | 🟠 | Handy: el **plan FEFO se calcula fuera** de la transacción de apply → TOCTOU de sobreventa | ruta + `venta_rapida.commands.ts:361-382` |
| VR-02 | 🟠 | **Clamp de stock inconsistente**: `cobrar_fraccionado` decrementa sin clamp (permite negativo); `restar_stock` clampa a 0 (oculta sobreventa) | `venta_rapida.rs:1002` vs `:1160`; worker `:366` vs `:425` |
| VR-03 | 🟡 | Suficiencia validada por **suma total de lotes**, no atómica con el consumo → dos cobros concurrentes pueden sobrevender | `venta_rapida.rs:869-908` |
| VR-04 | 🟡 | Producto **sin lotes** vende sin descontar y **sin avisar** (solo se controla si `n_lots > 0`) | `venta_rapida.rs:901`, `:1115` |
| VR-05 | 🟡 | **Doble implementación** Rust/worker de FEFO (misma clase de riesgo que MESA-11) | `venta_rapida.rs` ↔ `venta_rapida.commands.ts` |
| VR-06 | 🟡 | Sin **reconciliación de stock** entre Main y nube; ante deriva previa, clamp/negativo divergen | (transversal stock) |
| VR-07 | 🔵 | Muchos round-trips por venta (N lecturas de lotes + 2N updates) dentro de la tx | `venta_rapida.rs:958-1023` |
| VR-08 | 🔵 | Predicado legacy `ID_Trabajador <= 0` (TEXT/UUID) | `venta_rapida.rs:786` |
| VR-09 | 🔵 | SQL con `format!` para placeholders `IN` (smell) | `venta_rapida.rs:794,834` |
| VR-10 | 🔵 | FE: `vrBootstrap` entrelaza catálogo + estado de comanda (no cacheado); complejidad concentrada | `features/ventaRapida/*` |

---

## Detalle de hallazgos

### VR-01 🟠 El plan FEFO del Handy se calcula fuera de la transacción de apply — PLAUSIBLE
- **Ubicación:** el builder `cobrarFraccionado`/`restarStock` recibe un `plan` ya calculado
  (`plan.allocations`) por la ruta (una **lectura** de lotes), y luego el DO aplica los `UPDATE Lote
  X -= take` literales (`venta_rapida.commands.ts:361-382`). El cálculo del plan **no** ocurre dentro
  de la transacción que aplica los decrementos.
- **Fallo:** entre el cálculo del plan y su aplicación puede colarse otra escritura que reduzca el
  stock del lote. El `UPDATE` de `cobrar_fraccionado` **no clampa** (`- take` a secas) → el lote
  puede quedar **negativo** (sobreventa silenciosa); `restar_stock` clampa a 0 → se pierde el exceso
  del `Lote_Consumos`.
- **Escenario:** dos Handy cobran el mismo producto casi a la vez; ambas leen "quedan 5", ambas
  planean tomar 5; el DO aplica ambos → lote a -5.
- **Impacto:** stock negativo/incorrecto, contabilidad FEFO corrupta.
- **Arreglo:** calcular y aplicar el reparto FEFO **dentro de la misma transacción** (o con un
  `UPDATE … WHERE Stock_Disponible >= take` que falle y fuerce recomputar), o un decremento
  condicional atómico que rechace si no hay suficiente. La Main (Rust) sí lo hace atómico; alinear el
  worker.

### VR-02 🟠 Clamp de stock inconsistente — CONFIRMADO
- **Ubicación:** `cobrar_fraccionado` (Rust `:1002`, worker `:366`) hace
  `Stock_Disponible = COALESCE(Stock_Disponible,0) - ?2` **sin clamp**. `restar_stock` (Rust `:1160`,
  worker `:425`) hace `CASE WHEN … - ?2 < 0 THEN 0 ELSE … END` (**clamp a 0**).
- **Fallo:** dos comportamientos distintos para el mismo concepto. El clamp **oculta** la sobreventa
  (el stock nunca baja de 0 aunque se venda de más), y el no-clamp deja stock negativo. Además
  difieren entre operaciones, dificultando el diagnóstico.
- **Arreglo:** unificar la política. Recomendado: **prohibir** llegar a negativo con un decremento
  condicional (`WHERE Stock_Disponible >= take`) y tratar el fallo como "stock insuficiente" real, en
  lugar de clampar en silencio.

### VR-03 🟡 Suficiencia no atómica con el consumo
- **Ubicación:** `venta_rapida.rs:869-908`: valida `SUM(Stock_Disponible) >= requested` por producto
  y luego consume. La validación y el consumo son pasos separados dentro de la tx local (atómicos en
  la Main), pero la **decisión** se basa en una foto previa; en el Handy además el plan es externo
  (VR-01).
- **Fallo:** en la Main es correcto (misma tx, escritor único). En el Handy, la ventana entre plan y
  apply reintroduce la carrera (ver VR-01).
- **Arreglo:** como VR-01/VR-02, decremento condicional atómico.

### VR-04 🟡 Producto sin lotes vende sin control ni aviso
- **Ubicación:** el check `if n_lots > 0 && requested > available` (`:901`) solo dispara si el
  producto **tiene** lotes. Un producto sin lotes pasa siempre y no descuenta nada.
- **Fallo:** comportamiento intencionado (productos no inventariados) pero **silencioso**: no hay
  señal de que la venta no afectó al stock. Difícil distinguir "no inventariado" de "sin stock
  configurado".
- **Arreglo:** documentar la semántica y/o marcar explícitamente los productos "no inventariados"
  (bandera de categoría), para que la ausencia de lotes sea intención y no un olvido.

### VR-05 🟡 Doble implementación de FEFO
- Igual que MESA-11: el cálculo y consumo FEFO existe en Rust (Main) y en el worker (Handy) por
  separado. Riesgo de divergencia de reglas (orden FEFO, clamp, trazabilidad).
- **Arreglo:** tests de contrato que comparen las allocaciones producidas por ambos para el mismo
  estado de lotes.

### VR-06 🟡 Sin reconciliación de stock Main↔nube
- Los decrementos se replican como sentencias literales; convergen si ambos lados parten del mismo
  estado, pero **no hay** un mecanismo que detecte/corrija deriva de `Stock_Disponible` entre Main y
  Turso (que VR-01/VR-02 pueden introducir).
- **Arreglo:** un chequeo periódico de reconciliación (suma de `Cantidad_Inicial` − `Lote_Consumos`
  vs `Stock_Disponible`) con alerta.

### VR-07 🔵 Round-trips por venta
- `cobrar_fraccionado` hace, por producto cobrado, una lectura de lotes + (por lote) un `UPDATE` y un
  `INSERT`. En local es tolerable; el worker lo aplana a batch, pero el **plan** sigue haciendo
  lecturas.
- **Arreglo:** medir; si pesa, considerar un decremento FEFO en una sola sentencia recursiva/CTE.

### VR-08 🔵 Predicado legacy `ID_Trabajador <= 0`
- `venta_rapida.rs:786`. Igual que MESA-09. Eliminar.

### VR-09 🔵 SQL por interpolación de placeholders
- `venta_rapida.rs:794,834`. Igual que MESA-13. Los valores no son inyectables, pero es un smell.

### VR-10 🔵 Complejidad del bootstrap de FE
- `vrBootstrap` entrelaza catálogo con el estado de la comanda y **no está cacheado** en React Query
  (decisión documentada en CLAUDE.md). Es el punto más complejo del FE de ventas.
- **Arreglo:** ninguno urgente; vigilar la complejidad y aislar la lógica de bootstrap en un hook
  testeable.

---

## Workflow de corrección (D2)

1. **VR-01 / VR-02 / VR-03 (integridad de stock).** Unificar a un **decremento condicional atómico**
   (`WHERE Stock_Disponible >= take`) en Rust y worker; el plan FEFO debe calcularse/aplicarse en la
   misma transacción. Tests de concurrencia (dos cobros del mismo producto).
2. **MESA-01 (asimetría mesa↔mostrador).** Coordinar con [mesas.md](mesas.md): extraer una función de
   consumo de stock común y decidir si las ventas en mesa deben descontar.
3. **VR-06 (reconciliación).** Chequeo periódico de stock con alerta.
4. **VR-04 (semántica sin lotes).** Marcar productos no inventariados explícitamente.
5. **VR-05 (doble impl).** Tests de contrato Rust↔worker de las allocaciones FEFO.
6. **Calidad (VR-07/08/09/10).** Round-trips, predicado muerto, binding de SQL, aislar bootstrap.

**Invariante clave:** el stock **nunca** debe poder quedar negativo ni clamparse en silencio; la
decisión FEFO y su aplicación deben ser **atómicas** y **deterministas** (valores literales por
lote), idénticas en Main y worker.
