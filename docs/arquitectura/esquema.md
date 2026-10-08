# Esquema de base de datos y migraciones

Hay **un solo esquema** para la base local de la Main (`data.db`, libsql) y para la base de cada tenant
en Turso: los ficheros `.sql` de `packages/database/migrations/`, aplicados en orden.
`0001_inicial.sql` define la base y `0002_horarios_agrupados.sql` añade los conjuntos de turnos
partidos y las guardas de solape. `0003_cobros_pendientes.sql` añade la recuperación operativa local.
(La base central de licencias es otra cosa y no se migra desde el código:
[worker.md](worker.md#dos-bases-y-sólo-una-se-migra-desde-el-código).)

| Pieza | Archivo | Rol |
|---|---|---|
| El esquema | `packages/database/migrations/*.sql` | Fuente única |
| Runner de la Main | `crates/tpv-infra-sqlite/src/migrations.rs` | Embebe las migraciones con `include_dir!`, controla `_migrations (name, hash, applied_at)` |
| Runner de la nube | `apps/cloud-worker-licensing/src/server/tenantMigrations.ts` | El mismo control sobre cada base de tenant; registro a mano |
| Foto anti-deriva | `packages/database/schema.snapshot.sql` | El esquema resultante, comparado en un test |
| Esquema de los tests del worker | `apps/cloud-worker-licensing/test/helpers/esquemaTenant.ts` | Aplica las mismas migraciones sobre el SQLite del DO |
| Guardia del registro | `scripts/check-migration-registry.mjs` | En CI: todo `.sql` está registrado en `tenantMigrations.ts` |

## Cómo se aplica

Cada base lleva `_migrations`. Una base nueva se construye desde `0001`; una existente aplica sólo lo
que le falta. El hash es el SHA-256 del fichero entero con los finales de línea normalizados
(**incluidos los comentarios**): si una migración ya aplicada cambia, los dos runners fallan con
`migration_altered`. El runner de la Main aplica cada migración en su transacción con las FK apagadas
alrededor de la tanda y comprueba `foreign_key_check` antes de confirmar.

## Cambiar el esquema

Los cambios que deban conservar las bases de trabajo se añaden en una migración **nueva**.
No se modifica el hash de una migración aplicada ni se resetean bases como parte de una corrección.
Una consolidación del esquema de desarrollo requiere decidir expresamente el reset de sus datos.

En los dos casos:

1. Registrar el fichero en `tenantMigrations.ts` y en `test/helpers/esquemaTenant.ts` (el script de CI
   sólo vigila el primero).
2. Tocar `migrations.rs` para que `include_dir!` no sirva la copia vieja.
3. Regenerar la foto: `BLESS_SCHEMA_SNAPSHOT=1 cargo nextest run -p tpv-infra-sqlite schema_snapshot`.
4. **Redesplegar el worker antes** de que una Main escriba la columna nueva: lleva el esquema compilado
   dentro, y uno por detrás rechaza esa escritura (y la operación acaba apartada).

## Reglas del esquema

- **Toda `TEXT PRIMARY KEY` lleva `NOT NULL`** y su UUID se genera antes del `INSERT`, sin `DEFAULT` ni
  trigger ([sincronizacion.md](sincronizacion.md#escritor-único-y-captura)).
- **Ninguna columna tiene un `DEFAULT` de hora**: quien inserta la informa. Lo vigila
  `db.rs::ninguna_columna_del_esquema_elige_su_hora`.
- **Cada columna de dinero lleva `CHECK (typeof(col) IN ('integer','null'))`**: guarda céntimos enteros
  ([../decisiones/0005-dinero-en-centimos.md](../decisiones/0005-dinero-en-centimos.md)). El `CHECK` mira
  el valor ya convertido por la afinidad (`750.0` y `'750'` entran como 750). Una columna `INTEGER` que
  no sea dinero tiene que declararse como tal en
  `migrations.rs::todas_las_columnas_de_dinero_llevan_su_check`.
- **Las cantidades y los tipos de IVA son `REAL`** (0,5 kg; un 7,5 %). `Cantidad × Precio_Unitario` da
  un flotante, así que antes de sumar se vuelve a entero: `SUM(CAST(ROUND(Cantidad * Precio_Unitario) AS
  INTEGER))`. Nunca `ROUND(x, 2)` sobre dinero.
- **Toda cantidad de stock se escribe redondeada a milésimas** (RI-26): `ROUND(… , 3)` en el SQL y
  `redondear_cantidad` / `redondearCantidad` al calcularla (`tpv_domain::cantidad`, `lib/cantidad.ts`,
  con su tabla `cantidad_casos.json`). Sin eso, un kilo vendido en diez raciones de 0,1 dejaba
  `1,39e-16` en el lote y el FEFO lo seguía eligiendo.
- **El canal de una comanda**: `Comandas.Canal` es `'MESA'` (con `ID_Mesa`) o `'BARRA'` (venta rápida,
  sin mesa), con un `CHECK` que impide mezclarlos. `idx_comandas_una_abierta_por_mesa` garantiza una
  comanda abierta por mesa; los tickets de barra no compiten porque los `NULL` son distintos en un índice
  único. Un canal nuevo sólo amplía el `CHECK`.
- **Lo que tiene historia se archiva, no se borra** (RI-54): un producto con ventas o consumos
  (`Productos.Archivado_En`) y una mesa o zona con comandas o reservas (`Archivada_En`). Lo archivado
  sale de la carta, del inventario, del plano y de las reservas nuevas, y sigue en estadísticas,
  tickets y reconciliación. Sus `UNIQUE` de nombre sólo cuentan entre los activos (índices parciales,
  y los `ON CONFLICT` llevan su `WHERE`). Una lista nueva de catálogo filtra `Archivado_En IS NULL`.
- **«Línea cobrada»** se lee por la vista `v_lineas_cobradas` (pagos activos), no por `Pago_Detalles`
  ([caja.md](caja.md#dar-de-baja-un-cobro)).
- **Lo devuelto de una línea** se lee por la vista `v_unidades_devueltas` (devoluciones vigentes), no
  por `Devolucion_Lineas`. Un pago negativo con `ID_Pago_Origen` es una devolución de parte de un cobro
  ([caja.md](caja.md#devolver-parte-de-un-cobro)).
- **`Registros_Facturacion` y `Serie_Facturacion` no se purgan nunca** ([verifactu.md](verifactu.md)).

`Roles_Permisos` es negocio replicable: las concesiones por rol viajan por el outbox.
El rol Encargado y sus concesiones iniciales nacen de `0001`, igual en Main y Worker (RI-70).

## El andamiaje local (§16 del fichero)

`_Sync_Outbox`, `_Sync_Applied_Ops`, `_Sync_State`, `_Sync_Failed`, `_Sync_Encoladas`, `_Jobs_State`,
`_Verifactu_Envios`, `_Verifactu_Flujo`, `_Verifactu_Anomalias`, `_Recovery_State` y
`_Backfill_Historico` describen **este equipo**, se escriben por `raw()` y no se replican. Que se creen
también, vacías, en la base del tenant es deliberado: hay un único esquema, y el volcado de
recuperación descarta todo lo que empieza por `_`.

Al revés, `Applied_Operations`, `Sync_Changes` y `Sync_Main_Checkpoints` sólo las usa la nube y existen
vacías en la Main. Un volcado o una comparación que recorra tablas se las salta.

## Lo que hay que saber de los comentarios de `0001_inicial.sql`

Como el hash incluye los comentarios, cambiar uno equivale a cambiar la migración. Algunos citan
documentos que ya no existen (están en [pendientes.md](../pendientes.md#detectado-al-revisar-la-documentación));
se corrigen en el próximo cambio de esquema, con el reseteo que toque.
