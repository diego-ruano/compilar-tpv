# D4 — Inventario (productos · categorías · lotes/FEFO · alérgenos · imágenes)

> **Ámbito.** Catálogo y control de existencias: productos, categorías, alérgenos, y **lotes** con
> caducidad (base del consumo FEFO que ejecuta [venta-rapida.md](venta-rapida.md)). Incluye la vista
> `v_inventario_producto_stock` y el canal de imágenes (R2).
> **Capas:** `crates/tpv-infra-sqlite/src/inventario.rs`, `use_cases/inventario.rs`,
> `crates/tpv-domain/src/inventario.rs`, `apps/cloud-worker-licensing/src/domains/inventario/*`,
> FE `apps/tpv-main/src/features/InventaryComponents/*` (18 ficheros, ~3376 líneas, React Query).

## Nota de alcance

El **consumo** de stock (FEFO, decrementos, `Lote_Consumos`) se analiza en
[venta-rapida.md](venta-rapida.md) (VR-01..VR-06). Aquí se cubre la **gestión** del catálogo y los
lotes (altas, ajustes, coherencia de datos, borrados).

---

## Resumen de hallazgos

| ID | Sev | Estado | Título | Ubicación |
|----|-----|--------|--------|-----------|
| INV-01 | 🟡 | ✅ | Ajustes de stock **sin auditoría** y sin coherencia (`stock > cantidad_inicial` permitido) | `inventario.rs:553,590`; `domain/inventario.rs:186-221` |
| INV-02 | 🟡 | ✅ | `create_lote` upsert por `ID_Lote` **sobrescribe `Stock_Disponible`** → re-crear un lote borra su consumo | `inventario.rs:512-551` |
| INV-03 | 🟡 | ✅ | Sin validación de **`Caducidad`/`Fecha_Entrada`** (coherencia ni formato) → FEFO puede desordenarse | `domain/inventario.rs:186-221` |
| INV-04 | 🟡 | ✅ | `resumen` sobre la vista con **subconsultas correlacionadas** (DB-12) | `inventario.rs:203` |
| INV-05 | 🔵 | ✅ | `delete_producto` depende de CASCADE (nube incierta) y falla con `Detalle_Comanda` que lo referencia | `inventario.rs:431` |
| INV-06 | 🔵 | ⬜ | Sin **reconciliación** `Stock_Disponible == Cantidad_Inicial − SUM(Lote_Consumos)` | (transversal stock) |
| INV-07 | 🔵 | ⬜ | **Doble implementación** Rust/worker (parity risk) | `inventario.rs` ↔ `inventario.commands.ts` |
| INV-08 | 🔵 | ✅ | Imágenes por canal **R2 fuera de banda** del outbox → fila con `Ruta_Imagen` a imagen inexistente en otros dispositivos | `images_drain_pending`, `domains/images` |

> **Resolución (2026-07-05).**
> - **INV-02:** el alta de lote es ahora **pura** (`ON CONFLICT(ID_Lote) DO NOTHING`) en Rust y worker;
>   re-crear un lote nunca resetea `Stock_Disponible`. La edición usa `update_lote`/`ajustar_lote`. La
>   idempotencia de reintentos sigue garantizada por el gate `Op_Id`/`_Sync_Applied_Ops`.
> - **INV-03:** `LoteNuevo::validar` valida formato ISO de `Caducidad`/`Fecha_Entrada` (rechaza fechas
>   imposibles vía `chrono::NaiveDate`) y exige `caducidad >= fecha_entrada`.
> - **INV-01:** coherencia `Stock_Disponible <= Cantidad_Inicial` en create/update (dominio) y en
>   `ajustar_lote` (validada en el repo, atómica con la lectura, sin TOCTOU; también en la ruta del
>   worker). **Auditoría:** nueva tabla `Movimientos_Stock` (migración `0004`) que registra cada ALTA
>   y AJUSTE (delta, stock resultante, motivo, fecha) en vez de sobrescribir a pelo; replicada por el
>   outbox/DO con IDs deterministas. Sienta la base de INV-06.
> - **INV-04:** la query de "menos stock" del `resumen` se reescribió sin subconsultas correlacionadas
>   (`GROUP BY` + `ROW_NUMBER()`), en Rust y worker, preservando el resultado exacto.
> - **INV-05:** `delete_producto` avisa con mensaje claro si el producto tiene histórico en
>   `Detalle_Comanda` (en vez del error crudo de FK); el borrado de hijos ya era explícito (no depende
>   de CASCADE), y ahora también limpia `Movimientos_Stock` explícitamente para replicar sin CASCADE.
> - **INV-08:** ya estaba resuelto en el código: `ImageWithFallback` (placeholder + reintentos) cubre
>   todo el catálogo, y `useMainSocket` drena las imágenes pendientes al conectar/reconectar y cada 3s.
>
> **Pendientes (no abordados):** **INV-06** (chequeo periódico de reconciliación de stock) — la tabla
> `Movimientos_Stock` es su cimiento pero el chequeo en sí queda para otra iteración; **INV-07** (tests
> de contrato Rust↔worker) — infra de tests, como STAT-06.
>
> **Notas de alcance de la auditoría:** `ID_Usuario` en `Movimientos_Stock` queda **NULLABLE sin
> poblar** (la capa de comando aún no propaga el usuario actor); `update_lote` no audita su cambio de
> stock (solo ALTA y AJUSTE se consideran "movimientos"). Ambos son ampliaciones futuras.

---

## Detalle de hallazgos

### INV-01 🟡 Ajustes de stock sin auditoría ni coherencia
- **Ubicación:** `ajustar_lote` (`:590`) y `update_lote` (`:553`) fijan `Stock_Disponible` directo. La
  validación de dominio (`domain/inventario.rs:206-210`) solo comprueba `>= 0` y `finite`; **no**
  valida `stock_disponible <= cantidad_inicial`.
- **Fallo:** un ajuste puede dejar más stock disponible del que jamás entró (incoherente), y no queda
  **traza** de quién ajustó, cuándo ni por qué (solo un `Notas` opcional que además puede pisarse).
- **Impacto:** correcciones de stock no auditables; datos incoherentes que confunden el FEFO y los
  informes.
- **Arreglo:** validar `stock <= cantidad_inicial` (o justificar lo contrario); registrar los ajustes
  en una tabla de movimientos (`Movimientos_Stock`: lote, delta, motivo, usuario, fecha) en vez de
  sobrescribir el valor a pelo.

### INV-02 🟡 Upsert de lote sobrescribe el stock consumido
- **Ubicación:** `create_lote` (`:521-530`): `ON CONFLICT(ID_Lote) DO UPDATE SET Stock_Disponible =
  excluded.Stock_Disponible …`.
- **Fallo:** si se "crea" un lote con un `ID_Lote` que ya existe (reintento, colisión, edición
  disfrazada de alta), se **resetea** `Stock_Disponible` al valor entrante, borrando el consumo ya
  registrado en `Lote_Consumos` (que no se toca) → `Stock_Disponible` deja de cuadrar con el consumo.
- **Arreglo:** que el alta sea alta pura (fallar si el id existe) y usar `update_lote`/`ajustar_lote`
  para modificar; o, si el upsert es intencional, no tocar `Stock_Disponible` en el `DO UPDATE`.

### INV-03 🟡 Sin validación de fechas de lote
- **Ubicación:** `LoteNuevo::validar` / `LoteUpdate::validar` (`domain/inventario.rs`) limpian
  `caducidad`/`fecha_entrada` pero **no** validan formato ni que `caducidad >= fecha_entrada`.
- **Fallo:** el FEFO ordena por `date(Caducidad)`/`datetime(Fecha_Entrada)`; una caducidad malformada
  o anterior a la entrada **desordena** el consumo (se puede consumir antes un lote que no toca) o la
  vista `Caducidad_Proxima` da resultados raros.
- **Arreglo:** validar formato ISO y coherencia temporal en el dominio; rechazar caducidades
  inválidas.

### INV-04 🟡 `resumen` sobre vista con subconsultas correlacionadas
- **Ubicación:** `inventario.rs:203` usa `v_inventario_producto_stock` (ver DB-12).
- **Arreglo:** medir con `EXPLAIN QUERY PLAN`; si pesa con catálogos grandes, materializar o
  precalcular "lote próximo". Cruce con [esquema-db.md](../transversal/esquema-db.md).

### INV-05 🔵 Borrado de producto: CASCADE incierto + histórico no borrable
- **Ubicación:** `delete_producto` (`:431`). El esquema define `ON DELETE CASCADE` para
  `Lotes_Producto` y `Producto_Alergenos`, pero **no** para `Detalle_Comanda` (FK sin cascade).
- **Fallo:** (a) en la nube la cascada puede no aplicarse (DB-03) → lotes/alérgenos huérfanos; (b) si
  el producto aparece en alguna `Detalle_Comanda` histórica y la FK está activa, el borrado **falla**
  → el producto no se puede eliminar (comportamiento confuso si además localmente y en nube difiere).
- **Arreglo:** decidir política (borrado lógico/`Activo=0` para productos con histórico) y hacer el
  borrado de hijos explícito y replicado (no depender de CASCADE del motor). Cruce con DB-03.

### INV-06 🔵 Sin reconciliación de stock
- Igual que VR-06: no hay invariante ni chequeo de `Stock_Disponible == Cantidad_Inicial −
  SUM(Lote_Consumos)`. Los ajustes manuales la rompen a propósito, pero sin auditoría no se distingue
  ajuste legítimo de deriva por bug.
- **Arreglo:** chequeo periódico de reconciliación (excluyendo ajustes registrados) con alerta.

### INV-07 🔵 Doble implementación Rust/worker
- Como MESA-11/VR-05: catálogo y lotes duplicados en Rust y worker. Riesgo de divergencia (upsert,
  validaciones, orden FEFO).
- **Arreglo:** tests de contrato.

### INV-08 🔵 Imágenes fuera de banda del outbox
- **Ubicación:** las imágenes se suben a R2 por un canal aparte (`images_drain_pending`,
  `domains/images`), no por el outbox SQL. La fila del producto (`Ruta_Imagen`/`Nombre_Imagen`)
  sincroniza por outbox de forma independiente.
- **Fallo:** si la fila sincroniza pero la imagen aún no se ha subido (o falla), otros dispositivos
  ven una `Ruta_Imagen` que apunta a una imagen **inexistente** hasta que el drain de imágenes se
  complete. Desincronización temporal dato↔binario.
- **Arreglo:** tolerar el hueco en la UI (placeholder) y garantizar reintentos del drain; considerar
  no exponer la ruta hasta confirmar la subida, o un fallback determinista.

---

## Workflow de corrección (D4)

1. **INV-03 / INV-01 (integridad de datos de lote).** Validar fechas y coherencia de cantidades;
   añadir auditoría de ajustes. Tests de FEFO con datos límite.
2. **INV-02 (upsert seguro).** Separar alta de edición; no resetear stock en conflicto.
3. **INV-05 (borrado).** Definir borrado lógico para productos con histórico; borrado de hijos
   explícito. Coordinar con DB-03.
4. **INV-06 (reconciliación).** Chequeo de stock. Coordinar con [venta-rapida.md](venta-rapida.md).
5. **INV-04 / INV-07 / INV-08 (rendimiento, parity, imágenes).** Medir la vista; tests de contrato;
   robustez del canal de imágenes.

**Invariante clave:** `Stock_Disponible` debe ser siempre trazable a `Cantidad_Inicial` menos el
consumo (`Lote_Consumos`) más los ajustes **auditados**; las fechas de lote deben ser válidas para
que el FEFO sea correcto.
