# D6 — Reservas

> **Ámbito.** Reservas de mesa (calendario mensual, alta/edición, estado, borrado) y su vínculo con
> clientes y mesas. Incluye el `upsert_cliente` que crea/actualiza el cliente al reservar.
> **Capas:** `crates/tpv-infra-sqlite/src/reservas.rs`, `use_cases/reservas.rs`,
> `crates/tpv-domain/src/reservas.rs`, `apps/cloud-worker-licensing/src/domains/reservas/*`,
> FE `apps/tpv-main/src/features/reservas/*` (React Query).

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| RES-01 | 🟠 | `upsert_cliente` **sobrescribe el Nombre** de un cliente existente al reservar con su teléfono/email | `reservas.rs:99-123` |
| RES-02 | 🟡 | **Sin control de doble reserva** (misma mesa/día/hora/turno) → overbooking | `reservas.rs:229-281` |
| RES-03 | 🟡 | El INSERT de `Reservas` **omite `Created_At`** → depende del DEFAULT no determinista → diverge Main↔nube | `reservas.rs:266` (instancia de DB-02) |
| RES-04 | 🟡 | `mes` con **INNER JOIN** a Mesas/Zonas → reserva sin mesa/zona existente desaparece del listado | `reservas.rs:191-194` |
| RES-05 | 🔵 | **Tercer punto** de gestión de clientes (además de D5 y mesas) → lógica dispersa y dedup heurístico frágil | `reservas.rs:52-142` |
| RES-06 | 🔵 | `meta` con **fallback muerto** (`Es_Sistema` siempre existe) | `reservas.rs:167-170` |
| RES-07 | 🔵 | Doble implementación Rust/worker (parity) | `reservas.rs` ↔ `reservas.commands.ts` |

---

## Detalle de hallazgos

### RES-01 🟠 Reservar renombra a un cliente existente — CONFIRMADO
- **Ubicación:** `upsert_cliente` (`reservas.rs:52-142`) busca un cliente por **email** y, si no,
  por **teléfono** (`:76-89`); si encuentra uno, ejecuta `UPDATE Clientes SET Nombre = ?1, … WHERE
  ID_Cliente = ?` (`:99-123`) — el `Nombre` se **sobrescribe siempre** con el de la reserva.
- **Fallo:** si dos personas comparten teléfono (o email), reservar a nombre de una **renombra** el
  cliente de la otra. El match por teléfono/email es un **dedup heurístico** que fusiona identidades
  distintas y machaca datos existentes sin confirmación.
- **Escenario:** una familia comparte un móvil; reservar "Juan (mismo tel.)" cambia el nombre del
  cliente "María" a "Juan"; el histórico y el gasto de María quedan bajo "Juan".
- **Impacto:** corrupción silenciosa de la ficha de cliente.
- **Determinismo (nota):** además, la **decisión** de reusar-vs-crear cliente se toma consultando la
  BD; si la Main y la nube divergieran, podrían resolver a distinto `ID_Cliente`. Converge mientras
  Main (escritor único) y nube estén sincronizadas, pero el heurístico lo hace frágil.
- **Arreglo:** no sobrescribir el nombre de un cliente existente al reservar (o solo rellenar campos
  vacíos); ofrecer selección explícita de cliente en la UI en vez de dedup automático por
  teléfono/email; si se mantiene el match, no pisar datos no vacíos.

### RES-02 🟡 Sin control de doble reserva
- **Ubicación:** `guardar` (`:229-281`) inserta/actualiza sin comprobar que la mesa esté libre para
  ese `Dia_YMD`/`Hora`/`Turno`. Existe `idx_reservas_mesa_dia_hora` pero **no** es UNIQUE.
- **Fallo:** dos reservas pueden solaparse en la misma mesa y franja → overbooking.
- **Arreglo:** comprobar solapes antes de guardar (o índice único parcial sobre mesa+día+turno para
  reservas ACTIVAS), devolviendo un conflicto claro a la UI.

### RES-03 🟡 `Created_At` de reserva diverge bajo sync
- **Ubicación:** el `INSERT INTO Reservas (…)` (`:266`) **no** incluye `Created_At`, que cae en el
  `DEFAULT (datetime('now','localtime'))`.
- **Fallo:** instancia concreta de **DB-02**: el default no aparece en el SQL replicado → la nube lo
  evalúa en otro instante → `Created_At` distinto Main↔nube. Como `abrir_comanda` usa `Created_At` de
  la reserva para desempatar (MESA-10), esta divergencia puede afectar a qué reserva se autovincula.
- **Arreglo:** insertar `Created_At` con literal resuelto. Cruce con [esquema-db.md](../transversal/esquema-db.md) DB-02
  y [mesas.md](mesas.md) MESA-10.

### RES-04 🟡 `mes` pierde reservas sin mesa/zona
- **Ubicación:** `reservas.rs:191-194`: `JOIN Mesas … JOIN Zonas …` (INNER).
- **Fallo:** si la mesa o la zona de una reserva ya no existe, el INNER JOIN **excluye** esa reserva
  del calendario sin aviso. El borrado de layout evita dejar mesas con reservas, pero cualquier otro
  camino (o divergencia de sync) puede provocar reservas huérfanas invisibles.
- **Arreglo:** `LEFT JOIN` con manejo de nulos, o validar que nunca se borre una mesa/zona con
  reservas asociadas (en todos los caminos, incluida la nube).

### RES-05 🔵 Gestión de clientes dispersa
- La lógica de crear/actualizar clientes vive en **tres** sitios: D5 (clientes), `sumar_gasto_cliente`
  (mesas) y `upsert_cliente` (reservas), cada uno con reglas propias. Difícil de mantener coherente.
- **Arreglo:** centralizar la resolución/creación de cliente en un único servicio de dominio.

### RES-06 🔵 `meta` con fallback muerto
- **Ubicación:** `:167-170`: intenta la query con `Es_Sistema` y cae a la versión sin filtro si falla;
  `Es_Sistema` ya existe siempre en el esquema. **Arreglo:** eliminar el fallback.

### RES-07 🔵 Doble implementación Rust/worker
- Parity risk, incluida la lógica de `upsert_cliente`. **Arreglo:** tests de contrato.

---

## Workflow de corrección (D6)

1. **RES-01 (corrupción de cliente).** No sobrescribir datos de clientes existentes al reservar;
   revisar la política de dedup. Coordinar con [clientes.md](clientes.md) y RES-05.
2. **RES-02 (overbooking).** Comprobación de solape / índice único parcial.
3. **RES-03 (determinismo `Created_At`).** Insertar la fecha como literal. Coordinar con DB-02 y
   MESA-10.
4. **RES-04 (JOINs).** LEFT JOIN o invariante de integridad mesa↔reserva.
5. **RES-05/06/07 (limpieza).** Centralizar clientes, quitar fallback muerto, tests de contrato.

**Invariante clave:** una reserva no debe **modificar destructivamente** un cliente existente ni
depender de defaults no deterministas; la disponibilidad de mesa debe respetarse.
