# Esquema de base de datos y migraciones

Hay **un solo esquema** para la base local de la Main (`data.db`, rusqlite) y para la base de cada negocio
en la nube, que vive en el SQLite de su `TenantHub`: los ficheros `.sql` de
`packages/database/migrations/`, aplicados en orden.
Hoy son tres: `0001_inicial.sql`, con el esquema completo, `0002_negocio.sql`, el sello de la base
(AUD-06, [recuperacion.md](recuperacion.md#una-base-sólo-se-usa-con-la-licencia-de-su-negocio)), y
`0003_ingredientes.sql`, los ingredientes ([abajo](#los-ingredientes-0003)).
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
`migration_altered`. Los dos aplican cada migración en su transacción con las FK apagadas alrededor de
la tanda y comprueban `foreign_key_check` antes de confirmar.

Por eso los comentarios de `0001_inicial.sql` que hablan de Turso se quedan como están: son de cuando
la base del negocio en la nube estaba allí, y hoy esa base es el SQLite de su `TenantHub`
([0008](../decisiones/0008-la-base-del-negocio-en-su-durable-object.md)).

### Por qué con las FK apagadas

Una migración que le quita una restricción a una tabla tiene que reconstruirla: crear la nueva,
copiar, `DROP` de la vieja y renombrar. Con las FK activas, ese `DROP` borra las filas de la tabla y
ejecuta las acciones de las que la apuntan: las hijas con `ON DELETE CASCADE` **se borran, sin error
y sin dejar nada que `foreign_key_check` vea después**, y una hija sin acción lo hace fallar. Con
ellas apagadas la tabla se reconstruye sin tocar a las hijas, y `foreign_key_check` comprueba, antes
de confirmar, que la migración no ha dejado huérfanas.

En el SQLite del Durable Object eso tiene sus condiciones (`tenantHub.sqlite.ts::migrarBaseLocal`,
comprobadas en `test/sondaSqliteDo.test.ts`):

- `PRAGMA foreign_keys` **no hace nada, y no avisa, con una transacción abierta**. El DO abre una en
  cuanto se escribe algo y no la cierra hasta que lo escrito está confirmado: ni al acabar un
  `transactionSync` ni cediendo a las microtareas, sí tras `storage.sync()`. El runner da la orden,
  mira si ha surtido efecto y, si no, espera a esa confirmación y la repite; sin efecto, falla.
- **Es de la conexión**: lo que se deja apagado lo hereda todo lo que venga detrás en ese objeto.
  Por eso el runner comprueba que quedan encendidas también cuando no hay nada que migrar.
- **Mientras están apagadas no corre nada más en el objeto**: el motor migra dentro de
  `blockConcurrencyWhile` (`migrarEnExclusiva`), que tiene 30 s. Una migración que reconstruya una
  tabla grande tiene que caber ahí.

**La regla para escribir una migración**: una que reconstruya una tabla o borre filas que otras
apuntan cuenta con las FK apagadas; no las enciende ni las apaga por su cuenta (dentro de la
transacción de la migración el `PRAGMA` no haría nada), y no puede dejar huérfanas. Una vista que
lea la tabla reconstruida hay que quitarla antes y volver a crearla después: el `RENAME` falla si
alguna apunta a una tabla que en ese momento no existe.

### Si la migración falla en la nube

El DO migra la primera vez que toca su base tras un despliegue. Si no puede, cada petición de ese
negocio contesta 503 `tenant_db_migration_failed` (o el 500 `migration_altered` de una migración ya
aplicada que ha cambiado) hasta que se arregle; lo que la migración hubiera hecho se deshace. Para
una operación de la Main es un fallo pasajero: no se aparta ni gasta intentos
([sincronizacion.md](sincronizacion.md#subir-el-outbox)). El DO avisa una vez por instancia: a Sentry
(`tenant_db.migration`) y a Axiom (`migracion_fallida`).

## Cambiar el esquema

Los cambios que deban conservar las bases de trabajo se añaden en una migración **nueva**.
No se modifica el hash de una migración aplicada ni se resetean bases como parte de una corrección.
Una consolidación del esquema de desarrollo requiere decidir expresamente el reset de sus datos.

En los dos casos:

1. Registrar el fichero en `tenantMigrations.ts` y en `test/helpers/esquemaTenant.ts` (el script de CI
   sólo vigila el primero).
2. Regenerar la foto: `BLESS_SCHEMA_SNAPSHOT=1 cargo nextest run -p tpv-infra-sqlite schema_snapshot`.
3. **Redesplegar el worker antes** de que una Main escriba la columna nueva: lleva el esquema compilado
   dentro, y uno por detrás rechaza esa escritura (y la operación acaba apartada).
4. Una tabla de negocio nueva lleva su entrada en `apps/tpv-main/src/shared/lib/syncStatements.ts`: qué
   pantallas la enseñan ([frontend.md](frontend.md#datos-tanstack-query-y-zustand)). Sin ella, cada
   escritura en esa tabla hace releerlo todo a los demás equipos; lo vigila `test/syncStatements.test.ts`.

Cargo vigila la carpeta de migraciones mediante `tpv-infra-sqlite/build.rs`: al editar, añadir o
eliminar SQL se recompila lo embebido por `include_dir!`, sin tocar `migrations.rs`.

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
- **Los valores de dominio cerrados son triggers, no `CHECK`** (RI-48): métodos de pago y estados de
  cocina, reservas, tareas y fichajes. Un `RAISE(ABORT)` corta también un `INSERT OR IGNORE`, que ante
  un `CHECK` se saltaría la fila en silencio. Cocina (líneas que no pasan por ella), fichajes y
  movimientos de caja admiten `NULL`. Las guardas de solape de `Asignacion_Turnos` (RI-85) van igual.
- **«Línea cobrada»** se lee por la vista `v_lineas_cobradas` (pagos activos), no por `Pago_Detalles`
  ([caja.md](caja.md#dar-de-baja-un-cobro)). **«Línea por cobrar»**, por `v_lineas_por_cobrar`: ni
  cobrada ni devuelta entera por la baja (`DEVOLUCION`) de su cobro. Las dos se consultan con
  `EXISTS (… WHERE ID_Detalle = X)` para que SQLite las aplane.
- **Lo devuelto de una línea** se lee por la vista `v_unidades_devueltas` (devoluciones vigentes), no
  por `Devolucion_Lineas`. Un pago negativo con `ID_Pago_Origen` es una devolución de parte de un cobro
  ([caja.md](caja.md#devolver-parte-de-un-cobro)).
- **`Registros_Facturacion` y `Serie_Facturacion` no se purgan nunca** ([verifactu.md](verifactu.md)).

`Roles_Permisos` es negocio replicable: las concesiones por rol viajan por el outbox.
El rol Encargado y sus concesiones iniciales nacen de `0001`, igual en Main y Worker (RI-70).

## El andamiaje local (§16 de `0001`, y `0002`)

`_Sync_Outbox`, `_Sync_Applied_Ops`, `_Sync_State`, `_Sync_Failed`, `_Sync_Por_Contrastar` (las filas
que hay que traer de la nube porque su orden las dejó de otra forma aquí,
[sincronizacion.md](sincronizacion.md#el-orden-de-la-nube-manda-sync-29)), `_Jobs_State`,
`_Verifactu_Envios`, `_Verifactu_Flujo`, `_Verifactu_Anomalias` (sin uso en esta rama: son de la
remisión a la AEAT, ver [verifactu.md](verifactu.md)), `_Recovery_State`, `_Backfill_Historico`,
`_Verificacion_Nube` (cuándo se contrastó con la nube por última vez,
[jobs-e-interruptores.md](jobs-e-interruptores.md#cuándo-se-contrasta-con-la-nube-verif-02)) y
`_Negocio` (de qué negocio es la base) describen **este equipo**, se escriben por `raw()` y no se replican. Que se creen
también, vacías, en la base del tenant es deliberado: hay un único esquema, y el volcado de
recuperación descarta todo lo que empieza por `_`.

Al revés, `Applied_Operations`, `Sync_Changes` y `Sync_Main_Checkpoints` sólo las usa la nube y existen
vacías en la Main. Un volcado o una comparación que recorra tablas se las salta. `Sync_Changes` lleva
un índice por `Op_Id` (`idx_sync_changes_op_id`): el `TenantHub` busca por él el cambio de una
operación que vuelve a llegar ya aplicada (un reintento, un lote de la Main reenviado) para
contestar con su `Seq`, y sin el índice cada búsqueda recorrería el log entero.

## El resumen diario de las estadísticas (§17 de `0001`)

Las estadísticas de productos y de mesas de una semana, un mes o un año leen los días ya cerrados de
`_Estad_Producto_Dia` (lo vendido de cada día por producto y nombre de línea) y `_Estad_Mesa_Dia` (lo
cobrado de cada día por mesa, con tres recuentos de comandas), y de los cobros sólo lo de hoy. Con un
año de un bar de mucho movimiento, recorrer los cobros tardaba segundos por lectura, y en la nube la
base de un negocio es un solo hilo ([worker.md](worker.md#la-base-del-negocio-dentro-de-su-tenanthub)).

- **Es una caché local, no un agregado replicado.** La regla de los agregados (`Total_Comanda` y
  compañía se re-derivan en el SQL de cada escritura, nunca se escriben como literal) es para lo que
  se replica. Esto no se replica, no viaja en un volcado ni en una copia que se restaura, y la Main y
  el `TenantHub` mantienen cada uno el suyo con las mismas sentencias
  (`packages/database/estadisticas/`, que leen `tpv-infra-sqlite/src/estadisticas_diarias.rs` y
  `domains/stats/resumenDiario.ts`). La Main lo escribe por `raw()`; el `TenantHub`, fuera del motor,
  como el resto de su estado propio ([worker.md](worker.md#la-base-del-negocio-dentro-de-su-tenanthub)),
  y sólo con sentencias que escriben en estas tablas (`anotarResumen`).
- **Los triggers sólo apuntan días.** Cada cambio en `Pagos`, `Pago_Detalles`, `Detalle_Comanda` o
  `Comandas` que mueve una cifra apunta en `_Estad_Dias_Sucios` el día de los cobros afectados, con
  un `INSERT OR IGNORE … SELECT DISTINCT … WHERE … NOT IN (SELECT Dia FROM _Estad_Dias_Sucios)`: días
  que no son NULL, una vez cada uno y sólo los que no están, así que no hay restricción que pueda
  violar aunque la sentencia que lo dispara lleve otra cláusula de conflicto (que manda sobre la del
  trigger). No calculan nada: corren dentro del cobro, y nada de lo que lo rodea puede impedirlo.
  Todos van detrás de la escritura salvo `estad_pagos_reemplazo` y `estad_pagos_reemplazo_clave`,
  que van delante del alta de un cobro y del cambio de su clave: un `INSERT OR REPLACE` o un `UPDATE
  OR REPLACE` (prohibidos en el programa, pero la base no los impide) borrarían la fila que ocupa esa
  clave sin disparar el de borrado, que con `recursive_triggers` apagado no salta en un reemplazo, y
  su día se quedaría limpio. Son
  iguales en la Main y en la nube, y también saltan al aplicar lo que llega de la otra parte, en una
  restauración y en el histórico de la fase 2. Lo vigila
  `estadisticas_diarias::tests::los_triggers_solo_apuntan_dias`.
- **Un día se rehace entero**: se borran sus filas y se insertan con las dos sentencias compartidas, y
  se le quita la marca, todo en una transacción. Quien lee una estadística rehace antes los días
  sucios de su rango (hoy no, que se lee de los cobros), y la sentencia que lee no se fía de eso: el
  día que siga sucio (un cobro que ha entrado entre rehacerlo y leer) lo lee de los cobros, con la
  misma sentencia compartida y en la misma instantánea, así que nunca mezcla un día viejo con lo
  nuevo. En la Main lo adelanta el job
  `resumen_estadisticas`, y la reconciliación diaria contrasta los siete últimos días y siete más al
  azar con lo que sale de los cobros ([jobs-e-interruptores.md](jobs-e-interruptores.md)). En la nube
  cada lectura contrasta un día al azar de su rango. Un día que no cuadra se rehace y se avisa: es un
  cambio sin su trigger.
- **Un día por línea, el de su último cobro activo**: los rangos acaban ahora, así que una línea (o
  una comanda) entra en uno si tiene un cobro dentro, que es lo mismo que su último cobro caiga
  dentro. Por eso cobrar otra parte de una línea, o anular un cobro, apunta también los días de los
  demás cobros de la línea y de la comanda. Un cobro fechado después de «ahora» (el de un reloj
  adelantado) saca a su línea o a su comanda del día que era su último, y lo de hoy la vuelve a
  contar si tiene otro cobro dentro del rango: la lectura de hoy mira las líneas y las comandas con
  un cobro desde el principio de hoy, también los posteriores a ahora, y cuenta las que tienen uno
  dentro del rango.
- **Las unidades van en milésimas enteras** (`_Estad_Producto_Dia.Milesimas`; las cantidades se
  guardan redondeadas a milésimas, RI-26), también lo de hoy y lo que se lee de los cobros: sumadas
  por días y después por rango dan lo mismo que de una vez. Sumando `REAL` no pasa: el mismo 1,5
  sale 1,4999999999999998 según cómo se agrupe, y redondea a una unidad menos.
- **Tras restaurar la base se vacía**: `bootstrap_restaurar` y la copia que se va a instalar
  (`prepare_restore`) borran el resumen y apuntan como sucios todos los días con cobros
  (`estadisticas_diarias::reiniciar`).

## Los ingredientes (`0003`)

Qué lleva cada producto, para pedirlo «sin cebolla» o «con extra de queso». **Sin cantidades, sin stock
y sin precio**: nada de esto toca el cobro, el inventario ni el registro fiscal.

- `Categorias_Ingrediente` y `Ingredientes` son el catálogo, agrupado por categorías (Pan, Salsas…):
  el nombre de una categoría no se repite, y el de un ingrediente no se repite dentro de su categoría.
  Se gestionan en Inventario → Ingredientes, con el permiso `catalogo.editar`.
- `Producto_Ingredientes` dice qué lleva cada producto; se guarda con la ficha
  (`UpsertProductoInput.ids_ingredientes`). Sin la lista (`null`) no se tocan, para que un cliente que
  no los enseña no los borre al guardar. Un id que ya no existe no entra.
- `Detalle_Comanda.Cambios_Ingredientes` es lo que se pidió distinto en una línea: un array JSON de
  `{id, nombre, tipo}` con `tipo` `SIN` o `EXTRA`, o `NULL` si va como el producto. Guarda el nombre que
  tenía el ingrediente al pedirlo, como `Nombre_Producto`: renombrar o borrar un ingrediente no cambia lo
  ya pedido. La forma la fija `tpv_domain::ingredientes::cambios_de_linea` y el worker la escribe igual
  (`cambiosIngredientesSchema`), con su caso en `validacion_casos.json`. Como la nota, una línea cobrada
  no se cambia.
- Borrar una categoría se lleva sus ingredientes y los quita de los productos; borrar un ingrediente, lo
  mismo. Se hace con sentencias explícitas y en orden en los dos lados (`SQL_BORRAR_CATEGORIA`,
  `SQL_BORRAR_INGREDIENTE`), no con las cascadas de las FK, como `SQL_QUITAR_PRODUCTO`.
