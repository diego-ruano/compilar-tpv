# D5 — Clientes

> **Ámbito.** Ficha de clientes, ranking (por reservas / por gasto / recientes) y su gasto acumulado.
> Fue el **módulo piloto** de la migración hexagonal.
> **Capas:** `crates/tpv-infra-sqlite/src/clientes.rs`, `use_cases/clientes.rs`,
> `crates/tpv-domain/src/clientes.rs`, `apps/cloud-worker-licensing/src/domains/clientes/*`,
> FE `apps/tpv-main/src/features/ClientsComponents/*` (React Query; `clientesQueries.ts` es la
> referencia del patrón de caché).

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| CLI-01 | 🟠 | Métrica de **gasto poco fiable**: `Facturas` nunca se escribe (calculado siempre 0) y el stored deriva | `clientes.rs:75-81,108-111` |
| CLI-02 | 🟡 | Ranking **"Reciente" sin LIMIT** + subconsultas correlacionadas + `Reservas` sin índice por `ID_Cliente` | `clientes.rs:113`, DB-05 |
| CLI-03 | 🟡 | `Facturas` es **tabla muerta** referenciada en las queries (dead code confuso) | `clientes.rs:76`, esquema |
| CLI-04 | 🔵 | Sin validación de email/teléfono ni unicidad → **clientes duplicados** | `use_cases/clientes.rs`, esquema |
| CLI-05 | 🔵 | **Doble implementación** Rust/worker del overview (parity) | `clientes.rs` ↔ `clientes.queries.ts` |
| CLI-06 | 🔵 | `create` es **upsert** (ON CONFLICT DO UPDATE) — nombre semántico engañoso | `clientes.rs:187-227` |

---

## Detalle de hallazgos

### CLI-01 🟠 La métrica de gasto del cliente no es fiable — CONFIRMADO
- **Ubicación:** `overview` calcula `Total_Gastado_Calculado = SUM(Facturas.Total_Pagado)`
  (`clientes.rs:75-79`) y `Total_Gastado_Stored = Clientes.Total_Gastado` (`:81`), y **rankea por la
  suma de ambos** (`:108,111`).
- **Fallos combinados:**
  1. **`Facturas` no se escribe en ningún punto del código** (verificado: cero `INSERT/UPDATE
     Facturas` en Rust y worker) → `Total_Gastado_Calculado` es **siempre 0**. La reconciliación que
     el diseño insinúa (calculado vs stored) nunca ocurre.
  2. El único origen real, `Clientes.Total_Gastado`, solo lo incrementa `cobrar_detalles`
     (mesas) — **no** `cobrar_venta_rapida`— y **diverge Main↔Handy** (MESA-04) y puede quedar sin
     actualizar por error tragado (MESA-06). Además nunca se decrementa al anular un cobro (CUENTA-01).
  3. Sumar un valor **muerto (0)** con uno **derivable** produce un "total gastado" que en el mejor
     caso es solo el stored no fiable, y que si algún día se poblara `Facturas`, **doble-contaría**.
- **Impacto:** el ranking "por gasto" y el gasto mostrado en la ficha son incorrectos/inconsistentes.
- **Arreglo:** elegir **una** fuente de verdad. Recomendado: calcular el gasto **desde `Pagos`**
  (la tabla que sí se escribe) uniendo comanda→reserva→cliente, y retirar `Total_Gastado` denormalizado
  y las referencias a `Facturas` (o poblar `Facturas` de verdad si se quiere el modelo fiscal). Cruce
  con DB-13/DB-14, MESA-04/06 y CUENTA-01.

### CLI-02 🟡 Ranking "Reciente" sin límite y costoso
- **Ubicación:** `clientes.rs:113`: `ORDER BY c.ID_Cliente DESC;` **sin LIMIT**, con las ~6
  subconsultas correlacionadas del `overview` por cada cliente, y `Reservas` sin índice por
  `ID_Cliente` (DB-05).
- **Fallo:** con muchos clientes/reservas, coste O(clientes × reservas) y devolución de **toda** la
  tabla de clientes de golpe.
- **Arreglo:** paginar/limitar; añadir índice `Reservas(ID_Cliente)`; considerar precalcular la
  "última reserva" por cliente. Cruce con [esquema-db.md](../transversal/esquema-db.md) DB-05.

### CLI-03 🟡 `Facturas` como tabla muerta
- **Ubicación:** referenciada en `overview` (`:76`) y presente en el esquema, pero nunca poblada.
- **Fallo:** código y esquema que sugieren un modelo (facturación) que no existe → confusión y
  mantenimiento de una columna/tabla inútil.
- **Arreglo:** decidir: implementar facturación real (poblar `Facturas` en el cobro) o retirar la
  tabla y sus referencias. Cruce con DB-13.

### CLI-04 🔵 Sin validación ni unicidad de contacto
- **Fallo:** `Clientes.Email` no es UNIQUE y no se valida formato de email/teléfono → clientes
  duplicados y datos sucios.
- **Arreglo:** validar formato en el dominio; decidir si el email debe ser único (con la salvedad de
  clientes sin email).

### CLI-05 🔵 Doble implementación del overview
- Rust y worker replican la misma query (con las mismas subconsultas y la misma referencia muerta a
  `Facturas`). Parity risk. **Arreglo:** unificar la fuente del gasto (CLI-01) resuelve buena parte.

### CLI-06 🔵 `create` es un upsert
- **Ubicación:** `clientes.rs:187-227`: `INSERT … ON CONFLICT(ID_Cliente) DO UPDATE`.
- **Fallo:** "crear" con un id existente **actualiza** silenciosamente. Útil para idempotencia de
  sync, pero el nombre engaña. **Arreglo:** documentar la semántica idempotente o separar create/update.

---

## Workflow de corrección (D5)

1. **CLI-01 / CLI-03 (fuente de verdad del gasto).** Decidir modelo (calcular desde `Pagos` vs poblar
   `Facturas`); retirar el sumatorio calculado+stored. Coordinar con DB-13/14, [mesas.md](mesas.md) y
   [cuentas.md](cuentas.md). Test: el gasto mostrado coincide con la suma real de cobros del cliente.
2. **CLI-02 (rendimiento).** LIMIT + índice `Reservas(ID_Cliente)` + precálculo de última reserva.
3. **CLI-04 (validación).** Formato de email/teléfono; política de unicidad.
4. **CLI-05 / CLI-06 (parity y semántica).** Unificar y documentar.

**Invariante clave:** un único origen de verdad para el gasto del cliente, **consistente** entre Main
y Handy y **reversible** al anular cobros.
