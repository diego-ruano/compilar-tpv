# Tests de contrato Main (Rust) ↔ worker (TS) — ARCH-01

La lógica de convertir un comando de negocio (un cobro, un ajuste de stock…) en **sentencias SQL
replicables** vive **dos veces**: en Rust (la Main, escritora única) y en TypeScript (el worker, que
escribe por las Handy). Las dos tienen que comportarse **igual** para que la replicación converja, se
igualan a mano y ya han divergido (MESA-04/MESA-07). Este harness pincha esa igualdad: convierte una
divergencia futura en un **test rojo** en CI.

No elimina la duplicación (para eso está el WASM del futuro, ver
[BACKLOG §Unificación](../../docs/analisis/BACKLOG.md#unificación-de-la-doble-implementación-mainworker));
la **fija**. Es el máximo retorno por esfuerzo, sin cambio de arquitectura.

## Qué se compara: el EFECTO, no el texto SQL

Los dos lados escribieron su SQL por separado, así que el **texto** difiere aunque el resultado sea
idéntico (`INSERT … VALUES` vs `INSERT … SELECT`, distinto orden de columnas…). Comparar el texto
daría falsos positivos. Lo que importa para la convergencia es que, **partiendo del mismo estado
sembrado**, aplicar el comando deje **las mismas filas**. Así que:

1. Los dos lados **siembran el mismo estado** (`seed` del caso).
2. Cada uno corre **su** implementación del comando por su camino real.
3. Se leen las filas resultantes (`snapshot`) y se comparan con el **golden**.

Los `snapshot` **omiten a propósito** las columnas no deterministas (UUIDs generados, `Fecha_Hora`):
lo que queda es el efecto determinista (importes, stock por lote, consumos, qué detalles se cobraron).
La comparación es por **multiconjunto** de filas (sin orden) con igualdad estructural (números como
números, con tolerancia `1e-9`).

El **golden lo bendice Rust** (lado canónico: es el escritor único). El worker se conforma; si diverge,
su test se pone rojo.

## Estructura

Los ficheros se organizan **por módulo** en subcarpetas. El nombre lógico del caso es
`<modulo>__<caso>` (en las listas `CASOS`), y vive en `<modulo>/<caso>.json`:

```
tests/contract/
├── casos/<modulo>/<caso>.json      # seed + entrada + snapshot (SELECT por tabla)
└── golden/<modulo>/<caso>.json     # { tabla: [filas] } — el efecto esperado, bendecido por Rust
```

Ej.: el caso `venta_rapida__cobro_fraccionado_un_lote` está en
`casos/venta_rapida/cobro_fraccionado_un_lote.json` y `golden/venta_rapida/cobro_fraccionado_un_lote.json`.

Un **caso** (`casos/<modulo>/<caso>.json`):

```jsonc
{
  "descripcion": "…",
  "comando": "venta_rapida.cobrar_fraccionado",   // clave que despacha al comando en cada lado
  "seed":     ["INSERT INTO …;", "…"],             // estado de partida (idéntico en ambos lados)
  "entrada":  { "id_comanda": "…", "metodo": "…", "detalles": ["…"] },
  "snapshot": { "Pagos": "SELECT … FROM Pagos", "Lotes_Producto": "SELECT … FROM Lotes_Producto" }
}
```

## Dónde corre cada lado

| Lado | Fichero | Se ejecuta con |
|---|---|---|
| Rust (Main) | `crates/tpv-infra-sqlite/src/contract_tests.rs` | `cargo test -p tpv-infra-sqlite contrato_` |
| Worker (Handy) | `apps/cloud-worker-licensing/test/contract.test.ts` | `pnpm --filter tpv-api test contract` |

- Rust abre un libsql local, siembra, corre el comando (que captura su efecto en la BD) y lee las filas.
- El worker corre **dentro de workerd** (`@cloudflare/vitest-pool-workers`): levanta el TenantHub real,
  construye el esquema de tenant con las **mismas migraciones** (`test/helpers/esquemaTenant.ts`),
  siembra, corre `cobrarPlan → cobrarFraccionado → buildApplyBatch`, aplica las sentencias y lee.

Ambos leen el mismo `golden`. Como workerd no accede al disco, el worker **importa** el JSON (esbuild
lo empaqueta); Rust lo lee del disco y es quien lo **bendice**.

## Añadir un CASO nuevo (mismo comando)

1. Crea `casos/<modulo>/<caso>.json` con su `seed`, `entrada` y `snapshot`.
2. Añade el nombre lógico `<modulo>__<caso>` a `CASOS` en `contract_tests.rs` (Rust deriva la subcarpeta
   del nombre) y su par `caso/golden` en `contract.test.ts` (imports con la ruta `<modulo>/<caso>.json`).
3. Bendice el golden desde Rust: `BLESS_CONTRACT=1 cargo test -p tpv-infra-sqlite contrato_`.
4. Corre el worker: `pnpm --filter tpv-api test contract`. Si sale rojo, **has encontrado una
   divergencia real** entre las dos implementaciones (o el snapshot incluye algo no determinista).

## Añadir un DOMINIO/comando nuevo (p. ej. cobro de mesas)

Además de lo anterior, añade el **brazo de despacho** del comando en los dos sitios:
- Rust: `aplicar_comando` en `contract_tests.rs` (un `match` por `caso["comando"]`).
- Worker: `aplicarComando` en `contract.test.ts` (un `switch` por `caso.comando`).

Cada brazo invoca la implementación real de ese comando en su lado. El resto (siembra, snapshot,
comparación, golden) es común y no se toca.

## Cobertura actual

- `venta_rapida.cobrar_fraccionado` (VR-05): cobro de barra por FEFO.
  - `…_un_lote`: caso mínimo (un lote cubre la venta).
  - `…_fefo_multilote`: reparto FEFO entre dos lotes (agota el que caduca antes) — ejercita el orden
    FEFO, que es donde las dos implementaciones pueden divergir.
- `mesas.cobrar_detalles` (MESA-11): cobro de una comanda de mesa por FEFO + cierre de comanda.

Pendiente (incremental, un dominio cada vez): el resto de comandos de mesas/venta rápida, inventario
(lotes), clientes, proveedores, reservas, tareas, trabajadores/horarios, login y configuración — la
familia `-parity` (ver [00-indice.md](../../docs/analisis/00-indice.md)).

**No contrastables** (no hay segunda implementación que comparar): `pedidos_proveedor` (solo existe en
Rust, ausente en el worker) y `stats` (solo lectura). Los comandos de `trabajadores`/`login` que
escriben `Password_Hash` (PBKDF2 con salt aleatorio → distinto por diseño) o PII cifrada (el worker ni
la escribe) se cubren **excluyendo esas columnas** del snapshot; el resto del efecto sí se compara.
