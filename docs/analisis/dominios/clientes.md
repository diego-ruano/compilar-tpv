# D5 — Clientes

> **Ámbito.** Ficha de clientes, ranking (por reservas / por gasto / recientes) y su gasto acumulado.
> Fue el **módulo piloto** de la migración hexagonal.
> **Capas:** `crates/tpv-infra-sqlite/src/clientes.rs`, `use_cases/clientes.rs`,
> `crates/tpv-domain/src/clientes.rs`, `apps/cloud-worker-licensing/src/domains/clientes/*`,
> FE `apps/tpv-main/src/features/ClientsComponents/*` (React Query; `clientesQueries.ts` es la
> referencia del patrón de caché).

## Hallazgos abiertos

Ninguno.

> **CLI-05 cerrado (2026-08-24).** Pedía un harness hermano que comparase lo que **devuelve** una
> consulta, no solo el efecto de una escritura. Ya existe: `tests/contract/lecturas/` cubre el
> overview en sus tres rankings y la ficha, y el contraste sacó dos divergencias reales que la
> revisión a mano no vio —el worker no normalizaba los textos opcionales, así que un email guardado
> como cadena vacía llegaba como `""` a la Handy y como `null` a la Main, y un teléfono con espacios
> salía sin recortar—. Ambas corregidas en `clientes.queries.ts`. La traza vive en el código y en
> git; ver [tests/contract/README.md §Harness de lectura](../../../tests/contract/README.md).
