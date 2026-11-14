# 0003 · Replicación por sentencias SQL con un escritor único

**Estado:** vigente. La base del negocio ya no está en Turso, sino en el SQLite de su Durable Object: ver
[0008](0008-la-base-del-negocio-en-su-durable-object.md).

## Contexto

La Main escribe en su SQLite y la nube tiene que acabar con las mismas filas. Las Handy escriben en la
nube y la Main tiene que recibirlo. Hace falta que el resultado converja aunque una operación llegue dos
veces, tarde o por otro camino.

## Decisión

- **Se replican sentencias**, no filas ni eventos de dominio: cada escritura de la Main se captura en
  `_Sync_Outbox` en la misma transacción (`WriteGuard::execute`) y sube por WebSocket; el `TenantHub` la
  aplica en Turso y la difunde.
- **Cada operación tiene un `Op_Id`**, y las dos partes la aplican una sola vez (`Applied_Operations` en la
  nube, `_Sync_Applied_Ops` en la Main).
- **Las sentencias son deterministas**: los IDs se generan antes del `INSERT` y la hora se fija a literal
  ([0004](0004-la-hora-la-pone-quien-escribe.md)). Nada de `randomblob()` ni `random()` en una sentencia
  replicada.
- **Los agregados se re-derivan en SQL** (`Total_Comanda = SUM(…)`), porque tienen dos escritores.
- **Las escrituras de la Handy las construye el worker** (`domains/*/*.commands.ts`) y las aplica el
  `TenantHub`, que también las manda a la Main.
- **Una divergencia se repara mandando el estado actual de la fila**, nunca reintentando la sentencia.

## Consecuencias

- La lógica de las escrituras existe dos veces (Rust y TypeScript). La sujetan los arneses de contrato
  ([tests/contract/README.md](../../tests/contract/README.md)) y queda como deuda
  ([ARCH-01](../pendientes.md#arch-01--doble-implementación-mainworker)).
- Lo que es estado local de un equipo no se replica: va por `WriteGuard::raw()` y en tablas `_*`.
- El orden importa: el outbox se sube en orden y un rechazo hay que clasificarlo (permanente, pasajero o
  desconocido) para no parar la cola ni tirar datos.
