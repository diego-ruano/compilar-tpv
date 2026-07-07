# D8 — Tareas

> **Ámbito.** Tareas internas del personal: alta/edición, asignación a trabajadores, "mis tareas",
> marcar finalizada.
> **Capas:** `crates/tpv-infra-sqlite/src/tareas.rs`, `use_cases/tareas.rs`,
> `crates/tpv-domain/src/tareas.rs`, `apps/cloud-worker-licensing/src/domains/tareas/*`,
> FE `apps/tpv-main/src/features/tareas/*` (React Query).

## Valoración general

**Uno de los dominios más limpios.** Transacciones bien delimitadas (BEGIN/COMMIT/ROLLBACK), IDs
UUIDv7 explícitos, y —a diferencia de mesas/cocina— usa el patrón **correcto** de fechas en
`get_mis_tareas` (`date(a.Finalizada_At) = date('now','localtime')`, sin doble conversión de zona
horaria). Los hallazgos son menores.

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| TAR-01 | 🟡 | `create_tarea` **omite `Fecha_Creacion`** → DEFAULT no determinista → diverge Main↔nube | `tareas.rs:356-374` (instancia DB-02) |
| TAR-02 | 🔵 | Re-asignar a quien ya finalizó **no reabre** su estado (`INSERT OR IGNORE` preserva FINALIZADA) | `tareas.rs:102-122` |
| TAR-03 | 🔵 | Sin validar existencia de trabajadores al asignar (depende de FK; incierto en nube) | `tareas.rs:376` |
| TAR-04 | 🔵 | Doble implementación Rust/worker (parity) | `tareas.rs` ↔ `tareas.commands.ts` |
| TAR-05 | 🔵 | Borrado es **hard delete**; sin reapertura de tarea finalizada ni papelera | `tareas.rs:456-495` |

---

## Detalle de hallazgos

### TAR-01 🟡 `Fecha_Creacion` diverge bajo sync
- **Ubicación:** `create_tarea` (`:356-374`) inserta `(ID_Tarea, Titulo, Descripcion, Fecha_Limite)`
  **sin** `Fecha_Creacion`, que cae en el `DEFAULT (datetime('now','localtime'))`.
- **Fallo:** instancia de **DB-02** — el default no viaja en el SQL replicado → la nube evalúa su
  propio instante → `Fecha_Creacion` distinta Main↔nube. Impacto bajo (el orden usa `ID_Tarea`
  UUIDv7), pero la fecha mostrada puede diferir entre dispositivos.
- **Arreglo:** insertar `Fecha_Creacion` con literal resuelto. Cruce con
  [esquema-db.md](../transversal/esquema-db.md) DB-02.

### TAR-02 🔵 Re-asignación no reabre estado finalizado
- **Ubicación:** `apply_set_asignaciones_core` (`:102-122`) usa `INSERT OR IGNORE`. Si un trabajador
  que ya finalizó la tarea se incluye de nuevo en el conjunto, la fila existe → no se toca → su
  `Estado` permanece `FINALIZADA`.
- **Fallo/duda:** puede ser deseado (no perder el histórico) o no (re-asignar debería "reabrir"). Es
  ambiguo y no está documentado.
- **Arreglo:** definir la semántica de re-asignación explícitamente.

### TAR-03 🔵 Asignación sin validar trabajador
- **Ubicación:** `:376` (y `set_asignaciones`): inserta en `Tarea_Asignaciones` confiando en la FK a
  `Trabajadores`. En la Main (FK activas) un id inválido aborta; en la nube (DB-03) podría quedar
  huérfano. **Arreglo:** validar existencia y/o cascada explícita.

### TAR-04 🔵 Doble implementación Rust/worker
- Parity risk habitual. **Arreglo:** tests de contrato.

### TAR-05 🔵 Hard delete sin papelera
- `delete_tarea` borra tarea + asignaciones definitivamente; no hay "cerrar" (Estado) ni reapertura.
  **Arreglo:** considerar borrado lógico (`Estado='CERRADA'`) si se quiere histórico.

---

## Workflow de corrección (D8)

1. **TAR-01 (determinismo).** Insertar `Fecha_Creacion` literal (coordinar con DB-02).
2. **TAR-02 (semántica de re-asignación).** Decidir y documentar.
3. **TAR-03/04/05 (robustez).** Validación de trabajadores, tests de contrato, política de borrado.

**Nota:** por su buen estado, este módulo puede servir de **patrón de referencia** de fechas y
transacciones para corregir los demás (p. ej. la doble conversión horaria de cocina, MESA-08).
