# T5 — Arquitectura general (contracts · errores · cliente · React Query · patrones transversales)

> **Ámbito.** Los patrones que cruzan todos los dominios: generación de tipos (ts-rs), contrato de
> errores (`AppError`→String), cliente unificado (`invokeClient`), capa de datos (React Query), y —lo
> más importante— el **patrón de doble implementación** Main(Rust)/Handy(worker). Este documento
> **sintetiza** los temas recurrentes de los demás `.md`.
> **Capas:** `packages/contracts` (ts-rs), `packages/client` (`invokeClient`),
> `crates/tpv-application/src/error.rs`, `crates/tpv-domain`, worker `domains/*/*.schemas.ts`,
> FE `shared/lib/queryClient.ts` + `*Queries.ts`.

## Valoración general

La **arquitectura hexagonal** está bien lograda (separación domain/application/infra, comandos Tauri
finos, `ts-rs` como fuente única de tipos para el camino Main↔FE, Local-First coherente). El problema
transversal no es la estructura, sino la **duplicación de la lógica de negocio** entre la Main (Rust)
y la Handy (worker), que debe permanecer idéntica para que la sincronización converja.

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| ARCH-01 | 🟠 | **(Sistémico) Doble implementación** Main/Handy + doble tipado (ts-rs vs zod) + doble validación → deriva ya real | todo el repo |
| ARCH-02 | 🟡 | Errores cruzan la frontera como **strings opacos** (`AppError`→String) → el FE no distingue por tipo/código | `error.rs`, `commands/*` |
| ARCH-03 | 🟡 | Tipos del worker (zod) **no derivan** de la misma fuente que los contracts ts-rs → la Handy puede divergir | `contracts` vs `domains/*/schemas.ts` |
| ARCH-04 | 🟡 | `invalidateQueries()` **sin filtro** tras cada cambio de sync (patrón transversal de rendimiento) | `useMainSocket.ts:124`, `useHandySocket.ts:157` |
| ARCH-05 | 🔵 | `AppError::Raw` mezcla el **contrato de error** (unos con código, otros prosa) | `error.rs:42` |
| ARCH-06 | 🔵 | Deriva de documentación (CLAUDE.md/comentarios citan `schema.sql` y mecanismos retirados) | CLAUDE.md, varios (DB-10) |
| ARCH-07 | 🔵 | Aciertos arquitectónicos a **mantener** (hexagonal, ts-rs, Local-First, React Query) | — |

---

## Detalle de hallazgos

### ARCH-01 🟠 Doble implementación de la lógica de negocio — SISTÉMICO
- **Evidencia:** cada operación de **escritura** existe dos veces: en Rust (`crates/tpv-infra-sqlite/*`,
  para la Main) y en TS (`apps/cloud-worker-licensing/src/domains/*/*.commands.ts`, para la Handy).
  Además hay **dos sistemas de tipos** (ts-rs para el Main, zod `*.schemas.ts` para el worker) y
  **dos validaciones** (`tpv-domain` en Rust, zod en el worker).
- **Fallo:** ambas implementaciones deben producir **exactamente** las mismas sentencias/resultados
  para que el sync converja. Mantenerlas idénticas a mano es frágil, y la deriva **ya ha ocurrido**:
  - MESA-04: gasto de cliente distinto (Rust con fallback por mesa, worker sin él).
  - MESA-07: determinismo distinto en `add_linea` (Rust literal vs worker subquery).
  - CUENTA-03: dos `normalize_metodo` (case-sensitive vs insensitive).
- **Impacto:** divergencia de datos entre Main y nube/Handy; superficie de bug × 2; coste de
  mantenimiento doble; cada uno de los ~10 dominios lo arrastra (ver los `*-11/05/07/…` de cada doc).
- **Arreglo (estratégico):**
  1. **Corto plazo:** **tests de contrato** que, para los mismos inputs, comparen las sentencias/planes
     que producen Rust y el worker (y los resultados), fallando ante cualquier divergencia. Es la
     mitigación de mayor retorno y desbloquea corregir el resto con red de seguridad.
  2. **Medio plazo:** **una sola fuente** de generación de comandos replicables (p. ej. que la Main
     sea siempre la que construye la sentencia y la Handy delegue, o un generador compartido de SQL),
     eliminando la duplicación de raíz.
  3. Unificar validación y tipos (extender ts-rs / compartir un esquema) para que la Handy no tenga
     su propio dialecto.

### ARCH-02 🟡 Errores opacos en la frontera
- **Ubicación:** `AppError` tiene variantes ricas (`Validation`, `Conflict`, `NotFound`, `Repository`,
  `External`, `Raw`), pero en la frontera Tauri se **aplanan a `String`** (`Result<_, String>` en los
  comandos). El FE recibe una cadena.
- **Fallo:** el FE no puede ramificar por **tipo** de error (mostrar "stock insuficiente" recuperable
  vs un error técnico), solo hacer string-matching frágil. Conviven códigos-máquina
  (`insufficient_stock:...`, `not_approved`) con prosa en español.
- **Arreglo:** serializar el error como objeto estructurado `{ kind, code, message }` en la frontera
  (Tauri permite devolver JSON de error); definir un **catálogo de códigos** estable que FE y worker
  compartan.

### ARCH-03 🟡 Tipos del worker fuera del sistema ts-rs
- **Ubicación:** el FE del Main importa tipos generados por ts-rs (`@tpv/contracts`); el worker define
  sus DTOs con **zod** (`*.schemas.ts`), sin relación con los contracts.
- **Fallo:** la Handy (que consume el worker por REST) puede divergir de los DTOs que la Main y la
  nube esperan; no hay verificación cruzada.
- **Arreglo:** generar/validar los tipos del worker desde la misma fuente (o test de contrato de
  formas de payload).

### ARCH-04 🟡 Invalidación de caché sin filtro
- Igual que **SYNC-06**: `queryClient.invalidateQueries()` sin clave en cada lote de cambios. Patrón
  transversal. **Arreglo:** invalidar solo las claves de feature afectadas (derivadas de `statements`).

### ARCH-05 🔵 Contrato de error inconsistente (`Raw`)
- `AppError::Raw` propaga códigos verbatim (necesario para `not_approved` del pairing), pero mezcla
  con las demás variantes que son prosa. **Arreglo:** migrar a un catálogo de **códigos estables** y
  reservar la prosa para el `message` humano.

### ARCH-06 🔵 Deriva de documentación
- Igual que **DB-10**: CLAUDE.md, cabeceras de migración y comentarios (`db.rs`, `util.rs`) siguen
  citando `schema.sql`/`include_str!`/`dualCall` ya retirados. **Arreglo:** pasada de actualización de
  documentación al cerrar las correcciones.

### ARCH-07 🔵 Aciertos a mantener
- **Hexagonal** limpia; **ts-rs** elimina la deriva de tipos FE↔Rust en el camino Main; **Local-First**
  coherente (invoke directo, sin red para datos); **React Query** bien encapsulado por feature
  (`*Queries.ts`, `queryClient` único). No tocar salvo lo indicado.

---

## Workflow de corrección (T5)

1. **ARCH-01 (prioridad estratégica).** Introducir **tests de contrato Rust↔worker** como red de
   seguridad **antes** de corregir los dominios; planificar la unificación a medio plazo. Es
   habilitador de casi todas las correcciones de los `.md` de dominio.
2. **ARCH-02 / ARCH-05 (contrato de error).** Error estructurado + catálogo de códigos compartido.
3. **ARCH-03 (tipos worker).** Acercar los tipos del worker a la fuente única.
4. **ARCH-04 (caché).** Invalidación selectiva (con T2/SYNC-06).
5. **ARCH-06 (docs).** Actualizar la documentación al cerrar el resto.

**Invariante clave:** la lógica de negocio replicable debe tener **una sola fuente de verdad** (o
estar verificada por contrato) para garantizar la **convergencia** del sync; el contrato de errores y
tipos debe ser **compartido** entre Main, worker y FE.
