# D3 — Cuentas / Caja

> **Ámbito.** El "libro de caja": entradas (pagos), salidas (gastos), y la edición/borrado de pagos y
> gastos. Es la vista contable del negocio.
> **Capas:** `crates/tpv-infra-sqlite/src/cuentas.rs`, `crates/tpv-application/src/use_cases/cuentas.rs`,
> `crates/tpv-domain/src/cuentas.rs`, `apps/cloud-worker-licensing/src/domains/cuentas/*`,
> FE `apps/tpv-main/src/features/cuentas/*` (React Query).

## Cómo funciona hoy

- **Entradas** = `Pagos` unidos a comanda/mesa/cliente, clasificados como `Tarjeta`/`Efectivo`.
- **Salidas** = `Cuentas_Gastos` (con tipo y proveedor opcional).
- CRUD de gastos y **edición/borrado directos de pagos**. El balance de caja lo calcula el FE.

---

## Resumen de hallazgos

| ID | Sev | Título | Ubicación | Estado |
|----|-----|--------|-----------|--------|
| CUENTA-01 | 🟠 | `eliminar_pago` **no revierte** estado de comanda, gasto de cliente ni stock | `cuentas.rs:257-288`, worker `deletePago` | ✅ Corregido (reversión completa atómica) |
| CUENTA-02 | 🟠 | `actualizar_pago` permite cambiar `Importe_Total` **desacoplado** de los detalles → caja manipulable | `cuentas.rs:236-255`, worker `updatePago` | ✅ Corregido (recalcula desde detalles) |
| CUENTA-03 | 🟡 | **Dos `normalize_metodo` divergentes**: cuentas (case-sensitive) vs mesas (case-insensitive) | `cuentas.rs:13` vs `mesas.rs:26` | ✅ Corregido (normalizador único `tpv_domain::pago`) |
| CUENTA-04 | 🟡 | Solo dos métodos (Tarjeta/Efectivo); cualquier otro se colapsa a Efectivo (limitación + fragilidad de match exacto) | `cuentas.rs:91`, dominio | ✅ Aceptado como está (won't fix): solo Efectivo/Tarjeta; mitigado por CUENTA-03 |
| CUENTA-05 | 🟡 | `entradas`/`salidas` **sin límite/paginación** → históricos grandes traen todo | `cuentas.rs:99,141` | ✅ Corregido (paginación + búsqueda server-side + resumen agregado) |
| CUENTA-06 | 🔵 | No hay **cierre/arqueo de caja** persistido (fondo inicial, sesiones, descuadre) | dominio | ⏸️ Aplazado (decisión del responsable: revisar en el futuro) |

---

## Detalle de hallazgos

### CUENTA-01 🟠 Borrar un pago no revierte los efectos del cobro — ✅ CORREGIDO
- **Ubicación:** `cuentas.rs` (Rust) y worker `deletePago`: antes hacían
  `DELETE FROM Pago_Detalles … ; DELETE FROM Pagos …` y nada más.
- **Fallo:** al borrar un pago la comanda seguía `'Pagada'` con líneas impagadas, `Total_Gastado`
  quedaba inflado y el stock consumido no se devolvía.
- **Arreglo aplicado:** `eliminar_pago` es ahora una **reversión completa y atómica** (transacción):
  1. Devuelve el stock: suma de vuelta a cada lote lo consumido por los detalles del pago (join
     `Lote_Consumos`↔`Pago_Detalles`) y borra esos `Lote_Consumos`. *(Verificado: `Lote_Consumos`
     solo se escribe en el cobro de venta rápida, ligado a `ID_Detalle`, así que revertirlo aquí es
     correcto y es no-op para cobros de mesa que no consumen stock.)*
  2. Resta el importe del pago a `Clientes.Total_Gastado` (vía `Comandas`→`Reservas`), sin bajar de 0.
  3. Borra `Pago_Detalles` y **reabre la comanda** (`Estado='Abierta'`, `Fecha_Hora_Cierre=NULL`,
     recalcula `Total_Comanda`) si al liberar sus detalles quedan líneas pendientes.
  4. Borra el `Pago`.
  Implementado en Rust (`tpv-infra-sqlite`) y con **paridad en el worker** (pasos de la transacción
  del DO, en el orden correcto: liberar detalles → reabrir comanda con `Pagos` aún presente → borrar
  `Pagos`).

### CUENTA-02 🟠 Editar un pago desacopla el importe de las ventas — ✅ CORREGIDO
- **Ubicación:** `cuentas.rs` y worker `updatePago`: `UPDATE Pagos SET Importe_Total = ?4 …`.
- **Fallo:** se podía fijar cualquier importe (validado solo `> 0`), rompiendo la conciliación
  `Pagos`↔`Pago_Detalles`.
- **Arreglo aplicado (decisión: recalcular desde detalles):** `actualizar_pago` permite editar solo
  **método y fecha**; el `Importe_Total` se **recalcula en el UPDATE** como
  `SUM(Cantidad*Precio_Unitario)` de los `Pago_Detalles` del pago (Rust + worker). El caso de uso ya
  no valida ni usa el importe del input. El FE deja el campo importe **de solo lectura** con una nota
  ("se calcula automáticamente").

### CUENTA-03 🟡 Dos implementaciones de `normalize_metodo` divergentes — ✅ CORREGIDO
- **Ubicación:** `tpv-domain/src/cuentas.rs` (case-sensitive) vs `tpv-domain/src/mesas.rs`
  (case-insensitive).
- **Arreglo aplicado:** función única `tpv_domain::pago::normalize_metodo` (case-insensitive);
  `cuentas` y `mesas` la **reexportan** (`pub use`), así todos los llamadores comparten la misma
  implementación. El worker añade el mismo `normalizeMetodo` en `updatePago` para paridad.

### CUENTA-04 🟡 Solo Tarjeta/Efectivo (match exacto frágil) — ✅ ACEPTADO COMO ESTÁ (won't fix)
- **Decisión (responsable):** el negocio solo usa **Efectivo y Tarjeta**; un cobro por Bizum se
  registra como Tarjeta. No se van a modelar más métodos. Se deja así a propósito.
- **Corrección:** la fragilidad del `CASE WHEN Metodo_Pago = 'Tarjeta'` queda **resuelta** por el
  normalizador unificado (CUENTA-03): toda escritura es canónica (`Tarjeta`/`Efectivo`), así que la
  clasificación caja/tarjeta es coherente. No hay acción pendiente.

### CUENTA-05 🟡 Listados de caja sin paginación — ✅ CORREGIDO (paginación completa)
- **Ubicación:** `entradas`/`salidas` devolvían **todas** las filas del rango sin `LIMIT`.
- **Arreglo aplicado (decisión: paginación completa):**
  - **Listado paginado server-side** (`page`/`page_size`, `pageSize=50`) con `LIMIT/OFFSET` y
    **búsqueda de texto en SQL** (`q`, `LIKE` sobre fecha/cliente/concepto/método/importe; en salidas
    también nombre de proveedor vía join). `page`/`page_size` omitidos ⇒ se devuelven todas las filas.
  - **Resumen agregado** (`cuentas_get_resumen` / `GET /v1/cuentas/resumen`): totales (entradas,
    salidas, efectivo, tarjeta) y conteos sobre **todo el rango + búsqueda**, de modo que la cabecera
    y el balance son correctos aunque la lista esté paginada.
  - **FE:** búsqueda con debounce → `q` server-side; totales de cabecera desde el resumen; controles
    Anterior/Siguiente por panel (deshabilitados según los conteos del resumen); el **PDF** trae el
    conjunto completo sin paginar (page/pageSize omitidos) para no salir incompleto.
  - Implementado en las **tres** capas de repositorio (`tpv-infra-sqlite`, `tpv-infra-http` para
    Handy, y worker `cuentas.queries/routes/schemas`).

### CUENTA-06 🔵 Sin cierre/arqueo de caja persistido — ⏸️ APLAZADO
- **Decisión (responsable):** funcionalidad a valorar **en el futuro**; no se implementa ahora.
- **Alcance cuando se retome:** ampliación grande (nueva tabla `Cierres_Caja` + migración + casos de
  uso Rust/worker + UI de apertura/cierre), a coordinar con
  [esquema-db.md](../transversal/esquema-db.md).

---

## Workflow de corrección (D3)

1. **CUENTA-01 / CUENTA-02 (integridad de caja).** Diseñar la **reversión completa** de un pago
   (comanda + cliente + stock) y decidir si se permite editar importe. Implementar en Rust **y**
   worker con paridad; tests que verifiquen el estado tras anular un cobro (comanda reabierta, stock
   devuelto, gasto de cliente restado).
2. **CUENTA-03 (normalize unificado).** Una sola función compartida; test.
3. **CUENTA-05 (paginación).** Limitar y paginar los listados.
4. **CUENTA-04 / CUENTA-06 (producto).** Decidir con negocio si hacen falta más métodos de pago y un
   cierre de caja formal; planificar el cambio de esquema.

**Invariante clave:** toda mutación de un `Pago` debe mantener la **coherencia contable** —
`Pagos` ↔ `Pago_Detalles` ↔ `Comandas.Estado` ↔ `Clientes.Total_Gastado` ↔ stock— de forma atómica;
nunca dejar una comanda "Pagada" con saldo pendiente ni gasto/stock sin revertir.
