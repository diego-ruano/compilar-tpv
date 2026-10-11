# Tests de contrato Main (Rust) ↔ worker (TS)

La lógica de hablar con la base de datos vive **dos veces**: en Rust (la Main, escritora única, contra su
SQLite) y en TypeScript (el worker, que sirve a las Handy contra Turso). Las dos tienen que comportarse
igual. Estos dos arneses convierten una divergencia en un **test rojo** en CI. No eliminan la duplicación
([ARCH-01](../../docs/pendientes.md#arch-01--doble-implementación-mainworker)); la fijan.

| | Qué fija | Si no estuviera | Dónde |
|---|---|---|---|
| **Escritura** | Mismo comando → **mismas filas** | La replicación no converge | `casos/` · `golden/` · `cobertura.json` |
| **Lectura** | Mismas filas → **mismo resultado, en el mismo orden** | Los datos convergen pero la Handy y la Main enseñan otra cosa | `lecturas/casos/` · `lecturas/golden/` |

El **golden lo bendice Rust** (el lado canónico) y el worker se conforma.

Los dos arneses entran **por debajo de la validación de entrada**: el lado Rust llama a los repositorios
y el del worker a los constructores de `*.commands.ts`, siempre con una entrada válida. Que los dos lados
acepten y rechacen lo mismo lo fija aparte la tabla
[`validacion_casos.json`](../../crates/tpv-domain/src/validacion_casos.json), que leen
`crates/tpv-domain/src/validacion_casos.rs` y `apps/cloud-worker-licensing/test/validacionCasos.test.ts`.

```
tests/contract/
├── casos/<modulo>/<caso>.json            # seed + entrada + snapshot (un SELECT por tabla)
├── golden/<modulo>/<caso>.json           # { tabla: [filas] }
├── cobertura.json                        # comandos excluidos, con motivo
└── lecturas/
    ├── casos/<modulo>/<caso>.json        # seed + entrada (+ omitir)
    └── golden/<modulo>/<caso>.json       # el valor devuelto
```

El nombre lógico de un caso es `<modulo>__<caso>` y es también el nombre del test.

## Dónde corre cada lado

| | Rust (Main) | Worker (Handy) |
|---|---|---|
| Escritura | `crates/tpv-infra-sqlite/src/contract_tests.rs` | `apps/cloud-worker-licensing/test/contract.test.ts` |
| Lectura | `crates/tpv-infra-sqlite/src/contract_read_tests.rs` | `apps/cloud-worker-licensing/test/contractLectura.test.ts` |

```bash
cargo nextest run -p tpv-infra-sqlite contract_tests          # escritura, lado Rust
cargo nextest run -p tpv-infra-sqlite contract_read_tests     # lectura, lado Rust
pnpm --filter tpv-api test contract                          # los dos, lado worker
BLESS_CONTRACT=1 cargo nextest run -p tpv-infra-sqlite contract_tests            # regenerar goldens
BLESS_CONTRACT_READ=1 cargo nextest run -p tpv-infra-sqlite contract_read_tests  # ídem, lecturas
```

- Rust abre una base SQLite local, siembra, corre el comando o la consulta y lee.
- El worker corre **dentro de workerd** (`@cloudflare/vitest-pool-workers`): levanta el `TenantHub` real,
  construye el esquema con las mismas migraciones (`test/helpers/esquemaTenant.ts`), siembra, construye el
  comando y lo aplica con el mismo sobre que el DO (`PRAGMA defer_foreign_keys = ON` en una transacción),
  y lee. Importa los JSON porque workerd no accede al disco.

## Escritura: se compara el efecto, no el texto

Los dos lados escribieron su SQL por separado, así que el texto difiere aunque el resultado sea el mismo.
Partiendo del mismo `seed`, cada lado aplica **su** implementación y se comparan las filas del `snapshot`
como **multiconjunto** (sin orden), con números comparados como números (tolerancia `1e-9`).

- Los `snapshot` **omiten** las columnas no deterministas (UUIDs generados, fechas): queda el efecto
  determinista (importes, stock por lote, consumos, qué líneas se cobraron).
- Que cada lado genere sus propios IDs no impide contrastar un comando: el snapshot los deja fuera y
  comprueba aparte que ninguno viene vacío y que no se repiten (`Tiene_Id`, `Ids_Unicos` en
  `horarios/copiar_semana.json` y `horarios/set_predeterminado_desde_semana.json`).
- Cuando el comando crea filas con un ID nuevo y hace falta saber a qué fila pertenecen, se ancla con un
  `LEFT JOIN` por una columna estable (el nombre), **con alias `AS`** en las columnas cualificadas (Rust
  parsea los nombres del texto del SELECT y el worker los lee de SQLite). `LEFT` para que una fila
  huérfana salga y rompa el test.
- **El guard del SQL replicable** (`SQL_NO_DETERMINISTA` en `contract.test.ts`): ninguna sentencia
  replicada puede llevar `randomblob()` ni `random()`. El snapshot no lo ve —cada lado genera IDs
  válidos— pero la Main volvería a evaluar la función al aplicar la sentencia. Tiene su propio test.

```jsonc
{
  "descripcion": "…",
  "comando": "venta_rapida.cobrar_fraccionado",
  "seed":     ["INSERT INTO …;"],
  "entrada":  { "id_comanda": "…", "metodo": "…", "detalles": ["…"] },
  "snapshot": { "Pagos": "SELECT … FROM Pagos", "Lotes_Producto": "SELECT … FROM Lotes_Producto" }
}
```

**Añadir un caso**: crear el JSON, añadir `<modulo>__<caso>` a `casos_de_contrato!` en `contract_tests.rs`
y su par caso/golden en `contract.test.ts`, bendecir desde Rust y correr el worker. Si sale rojo, es una
divergencia real (o el snapshot incluye algo no determinista). **Un comando nuevo** necesita además su
brazo en `aplicar_comando` (Rust) y `aplicarComando` (worker).

## Lectura: el orden es el contrato

El punto de comparación es el **DTO**: en modo Handy, `tpv-infra-http` deserializa la respuesta del worker
en el mismo struct que devuelve el repositorio SQLite (`HttpClientesRepository::overview` →
`Vec<ClienteOverview>`).

- Los arrays se comparan **posición a posición**.
- Los IDs sí entran en el golden: los fija el `seed`.
- Las fechas del seed son extremas (`2000-…`, `2099-…`), para que las consultas que comparan con
  `date('now','localtime')` den lo mismo hoy y dentro de años.
- Un `null` y un campo ausente son lo mismo (serde los acepta igual en un `Option<T>`).
- `"omitir": ["campo"]` borra campos a cualquier profundidad antes de comparar, para lo que depende del
  reloj dentro del propio resultado (`login.punch_status` devuelve la fecha de hoy).

```jsonc
{
  "descripcion": "…",
  "lectura": "cuentas.entradas",
  "seed":    ["INSERT INTO …;"],
  "entrada": { "del": "2026-05-01", "al": "2026-05-31", "q": null }
}
```

**Añadir una lectura**: el JSON, el nombre en `lecturas_de_contrato!` (`contract_read_tests.rs`), su par en
`contractLectura.test.ts` y, si la consulta es nueva, su brazo en `ejecutar_lectura` y `ejecutarLectura`.

El arnés de lectura no detecta diferencias de zona horaria: corre las dos implementaciones en la misma.
Eso lo cubre `test/lecturasEnHoraLocal.test.ts`.

## Cobertura

`node scripts/check-contract-coverage.mjs` compara:

- **Escritura**: los `export function` de los `*.commands.ts` del worker con los builders que importa el
  arnés.
- **Lectura**: los `export function` de los `*.queries.ts` que sirven a un GET con las consultas que
  importa el arnés de lectura (las comprobaciones previas de una escritura ya viajan en el de escritura).

Corre en CI (job `worker`) y **avisa sin romper**: anotaciones en el PR y una tabla en el resumen. Con
`--estricto` sale con código 1. Imprime cuántos comandos y lecturas tienen caso, cuántos están excluidos
y cuáles faltan.

### Excluido a propósito (`cobertura.json`)

- **`trabajadores.createTrabajador` / `updateTrabajador`**: escriben PII cifrada (que el worker ni escribe)
  y `Password_Hash` con sal aleatoria; sólo las columnas no sensibles serían comparables.

### Fuera por construcción

- `pedidos_proveedor`: sólo existe en Rust.
- `Pagos.Numero_Ticket` no entra en los snapshots de cobro: lo asigna sólo la Main, que es la única que
  cobra.
- `login.punch` se cubre llamando a `exec_punch`, el efecto, sin la verificación del PIN: autenticar no es
  parte del contrato de replicación. El snapshot comprueba que `ID_Fichaje` no viene vacío.
