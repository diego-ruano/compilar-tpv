# D7 — Proveedores + Pedidos a proveedor

> **Ámbito.** Gestión de proveedores (CRUD, vínculos con productos) y **pedidos de compra**
> (borrador → enviado, líneas, envío por email al proveedor).
> **Capas:** `crates/tpv-infra-sqlite/src/proveedores.rs`, `pedidos_proveedor.rs`,
> `use_cases/{proveedores,pedidos_proveedor}.rs`, `commands/{proveedores,pedidos_proveedor}.rs`,
> `apps/cloud-worker-licensing/src/domains/proveedores/*`,
> FE `apps/tpv-main/src/features/proveedores/*` (11 ficheros, ~1575 líneas, React Query).

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| PROV-01 | 🟡 | `actualizar` pedido borra+reinserta líneas **sin comprobar `Estado`** → líneas de un pedido enviado editables; `Ok(true)` engañoso | `pedidos_proveedor.rs:179-217` |
| PROV-02 | 🟡 | Envío por email **no transaccional** con el cambio de estado (enviado sin email, o email sin marcar) + sin traza de entrega | `pedidos_proveedor.rs:232`, flujo email |
| PROV-03 | 🟡 | `get_all` **sin paginación**: carga todos los pedidos y toda la tabla de líneas en memoria | `pedidos_proveedor.rs:54-106` |
| PROV-04 | 🟡 | Cascada de borrado de proveedor **incompleta/incoherente** (manual para Lotes/Productos, motor para Pedidos/Gastos) → dangling en nube (DB-03) | `proveedores.rs:188-225` |
| PROV-05 | 🔵 | `guardar` proveedor: `UNIQUE(Email/CIF)` puede fallar con **mensaje críptico** sin manejo amable del duplicado | `proveedores.rs:159-166` |
| PROV-06 | 🔵 | Credenciales SMTP en claro para el envío (DB-04) y sin trazabilidad de entrega | cross-ref D10, DB-04 |
| PROV-07 | 🔵 | Doble implementación Rust/worker (parity) | `proveedores.rs` ↔ `proveedores.commands.ts` |

---

## Detalle de hallazgos

### PROV-01 🟡 Editar un pedido enviado modifica sus líneas — CONFIRMADO
- **Ubicación:** `actualizar` (`pedidos_proveedor.rs:179-217`): el `UPDATE` del header lleva
  `AND Estado='borrador'` (`:182`), pero el **`DELETE` + reinserción de líneas** (`:193-216`) se
  ejecuta **incondicionalmente**.
- **Fallo:** llamar a `actualizar` sobre un pedido `enviado`/`cancelado` deja el header intacto (guard
  no aplica) pero **reemplaza sus líneas**, y devuelve `Ok(true)` como si todo se hubiera actualizado.
  Estado inconsistente: pedido "enviado" con líneas distintas a las que se enviaron.
- **Arreglo:** aplicar el guard `Estado='borrador'` a **toda** la operación (o abortar temprano si el
  pedido no es borrador); devolver un resultado veraz (no `Ok(true)` si no se tocó nada).

### PROV-02 🟡 Envío por email no transaccional
- **Ubicación:** `cambiar_estado` (`:232`) marca `enviado` + `Fecha_Envio` (valor del cliente); el
  **envío del correo** ocurre en un paso aparte (worker/SMTP), sin atomicidad con el cambio de estado.
- **Fallo:** si el email falla tras marcar `enviado`, el pedido figura enviado sin haberse mandado; si
  se marca antes de enviar y el envío falla, queda inconsistente. No hay registro del resultado del
  envío (entregado/rebotado). Además `cambiar_estado` no valida la transición ni exige `Fecha_Envio`.
- **Arreglo:** orquestar envío→estado con manejo de fallo (marcar solo tras confirmación del envío, o
  un estado intermedio `enviando`); registrar el resultado del envío; validar transiciones.

### PROV-03 🟡 `get_all` sin paginación
- **Ubicación:** `pedidos_proveedor.rs:54-106`: trae **todos** los pedidos y **toda** la tabla
  `Lineas_Pedido_Proveedor`, agrupando en memoria.
- **Arreglo:** paginar por pedido y cargar líneas solo de la página visible (o del pedido abierto).

### PROV-04 🟡 Cascada de borrado incompleta/incoherente
- **Ubicación:** `eliminar` (`proveedores.rs:188-225`) hace cascada **manual** de `Lotes_Producto` y
  `Productos` (`SET ID_Proveedor=NULL`), pero **no** toca `Pedidos_Proveedor` ni `Cuentas_Gastos`,
  delegando en el `ON DELETE SET NULL` del **motor**.
- **Fallo:** enfoque mixto — parte manual, parte motor. En la Main (FK activas) funciona; en la nube,
  si las FK no se aplican (DB-03), `Pedidos_Proveedor.ID_Proveedor` y `Cuentas_Gastos.ID_Proveedor`
  quedan **colgando** apuntando a un proveedor borrado.
- **Arreglo:** hacer **toda** la cascada explícita (también Pedidos/Gastos a NULL) para que sea
  determinista y replicable, sin depender del motor. Cruce con DB-03.

### PROV-05 🔵 Duplicado de proveedor con error críptico
- **Ubicación:** `guardar` usa `ON CONFLICT(ID_Proveedor)`, pero el esquema tiene `Email UNIQUE` y
  `CIF UNIQUE`. Un alta con email/CIF repetido (distinto id) viola esas constraints → error de motor
  ("UNIQUE constraint failed") propagado a la UI.
- **Arreglo:** validar duplicados antes y devolver un mensaje claro ("Ya existe un proveedor con ese
  CIF/email").

### PROV-06 🔵 Seguridad y trazabilidad del email
- El envío usa las credenciales de `Email_Settings` (SMTP en claro — DB-04) o el modo managed del
  worker. Sin registro de entregas/rebotes.
- **Arreglo:** mover el secreto SMTP fuera de la BD (keyring) o cifrarlo; registrar resultados de
  envío. Cruce con [configuracion.md](configuracion.md) y DB-04.

### PROV-07 🔵 Doble implementación Rust/worker
- Parity risk habitual. **Arreglo:** tests de contrato.

---

## Workflow de corrección (D7)

1. **PROV-01 (guard de estado).** Bloquear edición de líneas de pedidos no-borrador; resultado veraz.
2. **PROV-02 (envío/estado).** Orquestación robusta envío↔estado + registro de entrega.
3. **PROV-04 (cascada explícita).** Completar el borrado manual; coordinar con DB-03.
4. **PROV-03 (paginación).** Listado paginado.
5. **PROV-05/06/07 (calidad y seguridad).** Duplicados amables, seguridad SMTP, tests de contrato.

**Invariante clave:** un pedido `enviado` es **inmutable**; el estado de envío refleja el resultado
real del email; el borrado de proveedor deja el resto de datos **consistente** en Main y nube.
