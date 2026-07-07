# D1 — Mesas (salón · comanda · cocina · barra)

> **Ámbito.** El núcleo del POS de servicio en mesa: layout del salón, apertura/cierre de comandas,
> alta/borrado de líneas, cobro fraccionado por detalle, venta rápida de barra, y tablero de cocina.
> Es el dominio con más lógica transaccional y donde vive el dinero.
> **Capas revisadas:** `crates/tpv-infra-sqlite/src/mesas.rs` (2035 líneas, SQL real),
> `crates/tpv-application/src/use_cases/mesas.rs`, `apps/tpv-main/src-tauri/src/commands/mesas.rs`,
> `apps/cloud-worker-licensing/src/domains/mesas/*` (implementación paralela para Handy), y FE
> `apps/tpv-main/src/features/mesasComponents/*` (API + modal + cocina).

## Observación estructural

Existen **dos implementaciones** completas del dominio: la de la **Main** (Rust, `mesas.rs`) y la
del **worker** (TS, `mesas.commands.ts`) que sirve las escrituras de la **Handy**. Ambas construyen
el mismo tipo de sentencias pero **por separado y a mano**, lo que genera divergencias reales (ver
MESA-04, MESA-07). Es la fuente de riesgo estructural principal del dominio.

---

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| MESA-01 | 🟠 | Las ventas **en mesa no descuentan stock/lotes** (asimetría con `venta_rapida`) | `mesas.rs:1061,1729` |
| MESA-02 | 🟠 | `cobrar_venta_rapida`: `INSERT … SELECT FROM Productos/Categorias` → **no determinista** bajo replicación | `mesas.rs:1088-1110` |
| MESA-03 | 🟠 | `abrir_comanda` no comprueba comanda abierta previa → **comandas duplicadas por mesa** (TOCTOU multi-dispositivo) | `mesas.rs:815`, `mesas.commands.ts:257` |
| MESA-04 | 🟠 | **Gasto de cliente divergente** Main↔Handy: Rust tiene fallback por reserva de la mesa; el worker no | `mesas.rs:164-194` vs `mesas.commands.ts:544-557` |
| MESA-05 | 🟠 | `cerrar_comanda` **confía en el `total` del cliente** (no recalcula desde detalles) | `mesas.rs:892`, `mesas.commands.ts:344` |
| MESA-06 | 🟡 | Error de `sumar_gasto_cliente_por_comanda` **solo se loguea** → pago commitea sin actualizar `Total_Gastado` | `mesas.rs:1823-1825` |
| MESA-07 | 🟡 | `add_linea` con determinismo **inconsistente**: Main usa literal; worker usa subquery embebida | `mesas.rs:1000` vs `mesas.commands.ts:407-411` |
| MESA-08 | 🟡 | **Doble conversión de zona horaria** en la query de cocina (ventana de 2 días sesgada) | `mesas.rs:1921` |
| MESA-09 | 🟡 | Predicado **legacy `ID_Trabajador <= 0`** sobre columna TEXT (UUID) → siempre falso | `mesas.rs:879,978`; `mesas.commands.ts:332,383` |
| MESA-10 | 🟡 | `abrir_comanda` autovincula la reserva **más recientemente creada**, no la del turno actual | `mesas.rs:824-838` |
| MESA-11 | 🟡 | **Doble implementación** del dominio mantenida a mano → riesgo de divergencia (saveLayout duplica ~140 líneas) | `mesas.rs` ↔ `mesas.commands.ts` |
| MESA-12 | 🔵 | `Notas` **sobrecargado** como clave de correlación de lote de VR (`VR:{ts}-{seq}`) | `mesas.rs:1082,1163` |
| MESA-13 | 🔵 | SQL construido con `format!`/interpolación (`limit`, `IN(...)`) — smell, preferir binding | `mesas.rs:1279`, `1738` |
| MESA-14 | 🔵 | `MesaComandaModal.tsx` (70 KB) / `KitchenBoard.tsx` (18 KB) monolíticos → mantenibilidad | `features/mesasComponents/` |
| MESA-15 | 🔵 | `try_exec` con fallback que **descarta silenciosamente** el cobrador si la FK no existe | `mesas.rs:1118-1156` |

---

## Detalle de hallazgos

### MESA-01 🟠 Las ventas en mesa no descuentan stock/lotes — CONFIRMADO (verificar intención)
- **Evidencia:** los únicos `UPDATE Lotes_Producto SET Stock_Disponible …` / `INSERT INTO Lote_Consumos`
  del repo están en `venta_rapida.rs` (`:1002,1012`) y su espejo en el worker. En `mesas.rs`, ni
  `cobrar_venta_rapida`, ni `cobrar_detalles`, ni `add_linea_comanda` tocan lotes ni stock.
- **Fallo:** todo lo vendido por **servicio en mesa** (comanda + cobro fraccionado) **no reduce el
  inventario**. El stock/FEFO solo refleja las ventas del mostrador (`venta_rapida`).
- **Impacto:** inventario inflado; roturas de stock no detectadas; KPIs de consumo incorrectos para
  el grueso del negocio (restaurante).
- **Duda a resolver:** ¿es intencionado (p. ej. platos elaborados no descuentan materia prima)? Si
  no, es un bug de negocio grave. **Arreglo:** unificar el descuento de stock en una función común
  invocada por ambas rutas de cobro (mesa y mostrador), o documentar por qué mesa no consume lotes.

### MESA-02 🟠 `cobrar_venta_rapida`: INSERT…SELECT no determinista — CONFIRMADO
- **Ubicación:** `mesas.rs:1088-1110`: `INSERT INTO Detalle_Comanda (…) SELECT ?1,…, CASE WHEN
  cat.Pasa_Cocina=1 THEN 'PENDIENTE' ELSE NULL END FROM Productos p JOIN Categorias_Producto cat …`.
- **Fallo:** la sentencia se captura **verbatim** en el outbox y se re-ejecuta en la nube. El
  `Estado_Cocina` (y **la existencia misma de la línea**) dependen del catálogo del lado que aplica:
  si en la nube el producto no existe todavía (o su categoría tiene otro `Pasa_Cocina`), la línea se
  inserta **distinta o no se inserta**, y el `INSERT … Pago_Detalles … WHERE Notas=batch` posterior
  tampoco encuentra filas → **el pago queda sin detalles en la nube** y los totales divergen.
- **Escenario:** venta rápida de un producto recién creado que aún no se ha replicado a la nube.
- **Arreglo:** resolver `Pasa_Cocina` con una lectura previa y **insertar el `Estado_Cocina` como
  literal** (como ya hace `add_linea_comanda` en la Main); no depender de `INSERT…SELECT` sobre
  catálogo en sentencias replicables. Cruce con [sync-tenanthub.md](../transversal/sync-tenanthub.md).

### MESA-03 🟠 `abrir_comanda` permite comandas duplicadas por mesa — CONFIRMADO
- **Ubicación:** `mesas.rs:815-859` y worker `mesas.commands.ts:257`: **siempre** `INSERT` una
  comanda nueva; no hay `WHERE NOT EXISTS (comanda abierta en la mesa)` ni UNIQUE que lo impida.
- **Fallo:** dos aperturas concurrentes de la misma mesa (Main + Handy, o doble toque) crean **dos
  comandas abiertas** para una mesa. Las líneas siguientes pueden repartirse entre ambas; la
  ocupación y los totales quedan confusos.
- **Escenario:** camarero abre la mesa desde el Handy mientras otro la abre desde la Main.
- **Arreglo:** hacer la apertura idempotente por mesa: `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1
  FROM Comandas WHERE ID_Mesa=? AND Estado='Abierta')`, o un índice único parcial sobre
  `(ID_Mesa)` con `Estado='Abierta'`. Devolver la comanda existente si ya hay una.

### MESA-04 🟠 Gasto de cliente divergente Main↔Handy — CONFIRMADO
- **Ubicación:** Rust `sumar_gasto_cliente_por_comanda` (`mesas.rs:164-194`) tiene **fallback**: si la
  comanda no tiene `ID_Reserva`, busca una reserva **ACTIVA en la misma mesa** y le acredita el gasto.
  El worker `cobrarDetalles` (`mesas.commands.ts:544-557`) solo acredita vía
  `Comandas.ID_Reserva → Reservas.ID_Cliente` (sin fallback).
- **Fallo:** cobrar una comanda sin reserva sobre una mesa que tiene una reserva activa **acredita el
  gasto a ese cliente si cobra la Main, y a nadie si cobra la Handy** → `Clientes.Total_Gastado`
  distinto según el dispositivo.
- **Impacto:** divergencia de datos de cliente entre dispositivos; además el propio fallback es un
  heurístico discutible (acreditar a un cliente con reserva el consumo de un walk-in en su mesa).
- **Arreglo:** unificar la regla en ambas implementaciones (preferiblemente **sin** el fallback por
  mesa, salvo que sea un requisito de negocio explícito). Cruce con DB-14 y [clientes.md](clientes.md).

### MESA-05 🟠 `cerrar_comanda` confía en el total del cliente — CONFIRMADO
- **Ubicación:** `mesas.rs:892-905` (y worker `:344`): `UPDATE Comandas SET Total_Comanda = ?2` con
  el `total` recibido del frontend; el use case solo valida `finite && >= 0`.
- **Fallo:** el total registrado no se recalcula desde `Detalle_Comanda`. Un cliente con bug (o
  manipulado) puede cerrar con un total arbitrario (p. ej. 0), descuadrando caja/KPIs.
- **Contraste:** `cobrar_detalles` **sí** recalcula el total server-side; `cerrar_comanda` no.
- **Arreglo:** recalcular `Total_Comanda` desde las líneas dentro del propio `UPDATE` (subquery
  `SUM`), ignorando el valor del cliente, o validarlo contra el cómputo real y rechazar discrepancias.

### MESA-06 🟡 Gasto de cliente: error tragado
- **Ubicación:** `mesas.rs:1823-1825`: `if let Err(e) = sumar_gasto_cliente_por_comanda(...) {
  eprintln!("[WARN] …") }` — el error se ignora dentro de la transacción del pago.
- **Fallo:** si la actualización del cliente falla, el pago **igualmente commitea** sin actualizar
  `Total_Gastado`. Divergencia silenciosa (liga DB-14).
- **Arreglo:** decidir política: o es parte atómica del pago (propagar y hacer rollback) o es
  best-effort explícito y reconciliable. En cualquier caso, no tragar el error sin telemetría.

### MESA-07 🟡 `add_linea` con determinismo inconsistente
- **Ubicación:** Main (`mesas.rs:986-1004`) hace una **pre-query** de `Pasa_Cocina` e inserta
  `Estado_Cocina` **literal** (determinista). Worker (`mesas.commands.ts:407-411`) usa una **subquery
  embebida** en el `INSERT` (no determinista al replicarse a la Main).
- **Fallo:** una línea añadida desde Handy puede materializarse con `Estado_Cocina` distinto en la
  Main si el catálogo difiere (mismo patrón que MESA-02, en menor escala).
- **Arreglo:** unificar al patrón determinista (resolver el valor y mandarlo literal) en ambas rutas.

### MESA-08 🟡 Doble conversión de zona horaria en cocina
- **Ubicación:** `mesas.rs:1921`: `datetime(c.Fecha_Hora_Apertura,'localtime') >= datetime('now','localtime','-2 days')`.
- **Fallo:** `Fecha_Hora_Apertura` ya se almacena en hora **local**; aplicarle `'localtime'` la trata
  como UTC y le suma el offset otra vez → la ventana "últimos 2 días" del tablero de cocina queda
  **sesgada** por el offset horario (p. ej. 2 h en UTC+2).
- **Arreglo:** comparar sin re-convertir: `datetime(c.Fecha_Hora_Apertura) >= datetime('now','localtime','-2 days')`
  (ambos lados en el mismo sistema). Revisar el resto del repo por el mismo patrón.

### MESA-09 🟡 Predicado legacy `ID_Trabajador <= 0`
- **Ubicación:** `mesas.rs:879,978` y worker `:332,383`.
- **Fallo:** `ID_Trabajador` es TEXT (UUID). `ID_Trabajador <= 0` es una comparación numérica que en
  SQLite es **siempre falsa** para texto → cláusula muerta, vestigio de cuando los IDs eran enteros.
  Funciona por el `IS NULL` que la acompaña, pero engaña al lector.
- **Arreglo:** eliminar `OR ID_Trabajador <= 0` en los cuatro sitios.

### MESA-10 🟡 Autovinculación de reserva incorrecta
- **Ubicación:** `mesas.rs:824-838`: al abrir sin reserva explícita, toma la reserva ACTIVA de la
  mesa con `ORDER BY datetime(Created_At) DESC LIMIT 1`.
- **Fallo:** elige la reserva **creada más recientemente**, no la del **turno/hora actual**. Una mesa
  con reserva de comida y de cena enlaza la última creada, que puede ser la del turno equivocado.
- **Arreglo:** elegir la reserva por proximidad de `Dia_YMD`/`Hora`/`Turno` al momento de apertura.

### MESA-11 🟡 Doble implementación mantenida a mano
- **Ubicación:** todo el dominio duplicado en `mesas.rs` (Rust) y `mesas.commands.ts` (worker);
  `saveLayout` replica ~140 líneas de lógica de borrado/renombrado de zonas y mesas.
- **Fallo:** cada cambio hay que hacerlo dos veces y mantenerlo idéntico; las divergencias ya
  ocurren (MESA-04, MESA-07).
- **Arreglo:** a medio plazo, generar las sentencias replicables desde una **única fuente** (p. ej.
  que la Main sea siempre la que construye y la Handy delegue), o tests de contrato que comparen el
  SQL producido por ambas para los mismos inputs.

### MESA-12 🔵 `Notas` como clave de correlación de VR
- **Ubicación:** `mesas.rs:1082`: `batch = "VR:{now_ms}-{seq}"` se guarda en `Detalle_Comanda.Notas`
  y luego se usa para enlazar `Pago_Detalles` (`:1163`).
- **Fallo:** sobrecarga la columna de notas del usuario como identificador técnico; frágil y confuso.
- **Arreglo:** correlacionar por los `ID_Detalle` recién insertados (recogerlos y usarlos en el
  `INSERT … Pago_Detalles`), sin tocar `Notas`.

### MESA-13 🔵 SQL por interpolación de cadena
- **Ubicación:** `mesas.rs:1279` (`LIMIT {limit}`), `estado_filter` interpolado, `build_in_placeholders`.
- **Fallo:** aunque los valores actuales no son inyectables (enteros clamped, constantes), construir
  SQL con `format!` es un smell y facilita futuros errores.
- **Arreglo:** bindear `LIMIT` como parámetro; mantener las listas `IN` con placeholders (ya se hace).

### MESA-14 🔵 Componentes de UI monolíticos
- **Ubicación:** `MesaComandaModal.tsx` (~70 KB), `KitchenBoard.tsx` (~18 KB).
- **Fallo:** difícil de leer, testear y evolucionar; concentra estado del ticket, cobro, cocina y
  reservas en un único archivo.
- **Arreglo:** extraer subcomponentes (ticket, panel de cobro, selector de productos) y hooks.

### MESA-15 🔵 `try_exec` descarta el cobrador en silencio
- **Ubicación:** `mesas.rs:1118-1156` (y análogo en `cobrar_detalles`): si el INSERT con
  `ID_Trabajador_Cobrador` falla (FK inexistente), reintenta un INSERT **sin** ese campo.
- **Fallo:** se pierde la trazabilidad del cobrador sin aviso cuando el id no resuelve.
- **Arreglo:** resolver/validar el cobrador antes (ya hay helpers) y registrar un warning con
  telemetría si se cae al fallback, en vez de degradar callado.

---

## Workflow de corrección (D1)

Orden sugerido (dinero e integridad primero):

1. **MESA-05 (total de cierre) y MESA-01 (stock).** Recalcular `Total_Comanda` server-side en el
   cierre; decidir y (si procede) implementar el descuento de stock unificado para ventas en mesa.
   Tests de caja y de stock.
2. **MESA-03 (comandas duplicadas).** Apertura idempotente por mesa + índice único parcial. Test
   concurrente Main+Handy.
3. **MESA-02 / MESA-07 (determinismo de replicación).** Sustituir `INSERT…SELECT`/subqueries de
   catálogo por valores literales resueltos. Coordinar con [sync-tenanthub.md](../transversal/sync-tenanthub.md).
4. **MESA-04 / MESA-06 (gasto de cliente).** Unificar la regla en Rust y worker; decidir atomicidad
   vs best-effort del `Total_Gastado`. Coordinar con [clientes.md](clientes.md).
5. **MESA-08 / MESA-09 / MESA-10 (correcciones puntuales).** Zona horaria, predicado muerto,
   selección de reserva.
6. **MESA-11 (deuda estructural).** Tests de contrato Rust↔worker; plan para unificar la generación
   de sentencias.
7. **Calidad (MESA-12/13/14/15).** Correlación sin `Notas`, binding de SQL, troceo de UI, telemetría
   del fallback de cobrador.

**Invariantes a preservar:** cobros y totales **recalculados server-side**; sentencias replicables
**deterministas** (sin depender del catálogo del lado que aplica); paridad de comportamiento entre la
implementación Rust (Main) y la del worker (Handy).
