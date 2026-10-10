# libsql 0.9.30: cierre local idempotente

Fuente: paquete `libsql 0.9.30` de crates.io, checksum
`30fe980ac5693ed1f3db490559fb578885e913a018df64af8a1a46e1959a78df`.
Su commit de origen es `0653c5788d77ef16a97c56ff3e9fdc11717a72d9`, directorio `libsql`.
Se conserva la licencia MIT del repositorio de origen.

`Connection::disconnect` anula el puntero después de `sqlite3_close_v2`. Así, el cierre
repetido desde los destructores de `LibsqlConnection` y `Connection` recibe un puntero nulo
y no accede a memoria liberada. El control por `drop_ref` sigue conservando los handles
mientras existan clones o cursores.

Las cuatro firmas `columns()` indican explícitamente `Column<'_>` para conservar la
vida ligada a `self` y evitar avisos `mismatched_lifetime_syntaxes` con Rust 1.93.1.

Incidencia: https://github.com/tursodatabase/libsql/issues/2251
Corrección de referencia: https://github.com/tursodatabase/libsql/pull/2261

Cargo aplica esta copia mediante `[patch.crates-io]`; no forma parte de los miembros del
workspace. Los tests de TPV verifican el cierre repetido y la vida de los cursores.
Las dependencias `libsql-sys` y `libsql-ffi` conservan sus versiones del lock.
