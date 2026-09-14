# Hallazgos del repaso completo (2026-09-10)

> Repaso del repo entero —crates, frontend, worker, esquema, CI— con las suites en verde delante.
> **No es una lista de sospechas**: cada punto se verificó leyendo el camino completo, y los que se
> apoyan en una suposición lo dicen.
>
> **Aquí sólo queda lo abierto.** Un hallazgo resuelto se borra: su traza vive en el código, en un
> comentario con su ID (`grep -rn "SYNC-20" crates/ apps/`); lo que enseñó, en CLAUDE.md o junto al
> código al que afecta; y el relato del arreglo, en su commit. Si buscas un ID que no aparece, está
> resuelto.
>
> Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja
>
> **Estado (2026-09-14):** nada de lo que queda impide entrar en un bar. FIS-05 y STOCK-01 son
> decisiones de alcance (la segunda, junto con VENTA-01), TEST-03 salió de arreglar
> SYNC-20, y CFG-04 es mantenimiento.

| ID | Sev | Hallazgo | Estado |
|----|-----|----------|--------|
| FIS-05 | 🟡 | El modo formación sólo limpia lo fiscal: caja, stock y estadísticas quedan sucios | Sin empezar |
| TEST-03 | 🟡 | Cada recorrido E2E estrena su equipo y su tenant: seis bases de Turso por tanda | Sin empezar |
| STOCK-01 | 🟡 | Doble abono cruzado de lotes al anular un cobro re-cobrado | Sin empezar |
| CFG-04 | 🔵 | La guardia de fuentes de tiempo es un `debug_assert!`: en release no protege | Sin empezar |

---

## FIS-05 🟡 · El modo formación sólo limpia lo fiscal

[`set_formacion(false)`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L1998) emite las anulaciones
de los registros y actualiza el interruptor. No toca nada más — y una venta de formación es una venta
completa por todos los demás caminos:

- deja su fila en `Pagos` con `Estado='ACTIVO'`, así que **cuenta en el `esperado` del arqueo** y en
  las estadísticas;
- consume stock real por FEFO;
- cierra la comanda y libera la mesa.

La pantalla, mientras tanto, promete lo contrario: *«Para formar a alguien sin dejar ventas de mentira
en la contabilidad»* ([`Fiscal.tsx:666`](../../apps/tpv-main/src/features/configuracion/sections/Fiscal.tsx#L666)).

Puede que el alcance sea deliberado —el modo nació para resolver una obligación fiscal concreta— pero
entonces el subtítulo hay que cambiarlo, porque hoy dice que hace algo que no hace. Y si el alcance
se amplía, la decisión de fondo es qué significa «deshacer» una venta que ya descontó stock: lo más
probable es que sea anular los cobros por el camino de CUENTA-07 (`ClaseBaja::Error`), que ya revierte
stock y gasto y ya emite el registro de anulación.


## TEST-03 🟡 · Cada recorrido E2E estrena su equipo, y son seis

`wdio.conf.ts` prepara el equipo por receta en `beforeSession`, así que cada uno de los seis ficheros
de recorrido monta su AppData, activa su licencia y **crea su tenant de Turso**. Son seis bases por
tanda que no se borran solas, y el arranque completo se repite cinco veces para probar cinco cosas
distintas que podrían compartirlo.

**Qué haría falta.** Mover la preparación del equipo del `beforeSession` al `describe`, y encadenar
dentro los pasos que hoy son ficheros distintos. No todos pueden agruparse, y conviene saber cuáles
antes de empezar:

- **Sí pueden**: `venta` y `fiscal` estrenan los dos un equipo limpio, sin nube, y hacen recorridos
  contiguos (vender y cobrar / mirar la factura de ese cobro).
- **Los tres de copias YA son uno partido en tres**, y lo están por una razón que no se puede
  deshacer: en medio hay que **apagar la aplicación** (en Windows la base no se reemplaza con SQLite
  teniéndola abierta). Agruparlos es unificar su receta y su licencia, no sus `describe`.
- **`licencia` no puede**: necesita anular y caducar su propia licencia, así que compartirla con otro
  recorrido lo rompería.

⚠️ **El aislamiento no es negociable** y es lo que hay que vigilar al agruparlos: cada recorrido
estrena su licencia (y por tanto su tenant) **a propósito** — CLAUDE.md §16 explica que con una
licencia fija el catch-up arrastra lo que dejaron las tandas anteriores, y eso se vio como un fichaje
que la app rechazaba unas veces sí y otras no. Agrupar tiene que reducir el número de tenants
compartiendo uno **dentro** de un grupo, no reutilizando uno **entre** tandas.

## STOCK-01 🟡 · Doble abono cruzado de lotes al anular

[`anular_pago`](../../crates/tpv-infra-sqlite/src/cuentas.rs#L685) devuelve stock uniendo
`Lote_Consumos ⋈ Pago_Detalles` **por `ID_Detalle`**, sin filtrar por qué cobro generó cada consumo.
Y `consumir_stock_fefo` inserta con `ON CONFLICT(ID_Detalle, ID_Lote) DO NOTHING`, así que una línea
cobrada → anulada → re-cobrada **desde otro lote** acaba con dos filas de `Lote_Consumos` para el
mismo `ID_Detalle`. La segunda anulación abona **los dos** lotes.

El guardia por `Estado` que el código documenta impide anular dos veces el mismo pago; no impide
esto. La secuencia hace falta que sea justo ésa (que el lote original se agote entre las dos ventas),
así que es raro — y la reconciliación lo detecta, porque compara `Stock_Disponible` contra los
consumos vigentes. Pero cuando lo detecta el stock ya está mal y el aviso no explica por qué.

**Qué haría falta.** Que `Lote_Consumos` sepa de qué cobro viene, o que el abono se limite a los
lotes que ese cobro consumió. Lo primero es un cambio de esquema; lo segundo exige guardar algo que
hoy no se guarda. Conviene decidirlo con VENTA-01 (devoluciones) delante, que va a tocar lo mismo.


## CFG-04 🔵 · La guardia de fuentes de tiempo es un `debug_assert!`

[`db.rs:371`](../../crates/tpv-infra-sqlite/src/db.rs#L371) comprueba con `debug_assert!` que ningún
SQL replicable lleve una fuente de tiempo no determinista fuera de las dos formas canónicas. En
release no hace nada, así que una escritura nueva por un camino sin test viajaría al outbox con su
`datetime('now')` sin resolver y la nube la reevaluaría en otro instante.

Está decidido así («en release no penaliza») y la cobertura de contrato al 94 % cubre casi todo. Se
anota por si algún día conviene convertirlo en un error devuelto en vez de en un panic de debug: la
comprobación es una búsqueda de subcadenas sobre un SQL que ya se está recorriendo, así que el coste
real de dejarla en release es difícil de medir.
