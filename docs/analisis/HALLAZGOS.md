# Hallazgos del repaso completo (2026-09-10)

> Repaso del repo entero —crates, frontend, worker, esquema, CI— con las suites en verde delante.
> **No es una lista de sospechas**: cada punto se verificó leyendo el camino completo, y los que se
> apoyan en una suposición lo dicen.
>
> Estado de salud del que se parte, comprobado y no leído de los docs: `cargo check --workspace
> --all-targets` limpio · **891/891** tests de Rust · 354/354 del worker · 218/218 del frontend ·
> `tsc` limpio en app y worker · los dos scripts anti-drift en verde · cobertura de contrato 94 %
> escritura / 100 % lectura · **cero `unwrap()`** en Rust de producción · ningún secreto versionado.
>
> Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja
>
> **Orden sugerido:** FIS-01 y FIS-02 antes de que esto entre en un bar (los dos son de la semana
> pasada y los dos rompen algo que la aplicación no señala). FIS-03 y FIS-04 después. El resto,
> cuando toque.

| ID | Sev | Hallazgo | Estado |
|----|-----|----------|--------|
| FIS-01 | 🔴 | Un TPV recién instalado **no puede cobrar**, y el fallo es mudo | Sin empezar |
| FIS-02 | 🔴 | El **modo formación** rompe el vínculo ticket ↔ registro | Sin empezar |
| FIS-03 | 🟠 | Las facturas de prueba de diciembre **no se anulan nunca** | Sin empezar |
| FIS-04 | 🟠 | `remitir_ciclo` cruza el resultado de un ALTA con el de su ANULACIÓN | Sin empezar |
| FIS-05 | 🟡 | El modo formación sólo limpia lo fiscal: caja, stock y estadísticas quedan sucios | Sin empezar |
| CAJA-01 | 🟠 | Editar un apunte comprueba el periodo de **origen**, no el de **destino** | Sin empezar |
| STOCK-01 | 🟡 | Doble abono cruzado de lotes al anular un cobro re-cobrado | Sin empezar |
| CFG-01 | 🟡 | `R2_PUBLIC_BASE_URL` apunta a **otro bucket** que la CSP y la app | Sin empezar |
| CFG-02 | 🟡 | `hono` 4.13.2 con tres avisos moderados | Sin empezar |
| CFG-03 | 🟡 | La firma interna del worker **falla abriendo** si el secreto está vacío | Sin empezar |
| CFG-04 | 🔵 | La guardia de fuentes de tiempo es un `debug_assert!`: en release no protege | Sin empezar |
| HIG-01 | 🔵 | Sin linter en ningún lenguaje, y ~20 `eslint-disable` decorativos | Sin decidir |
| HIG-02 | 🔵 | Drift numérico y de referencias en CLAUDE.md | Sin empezar |
| HIG-03 | 🔵 | `npx wrangler` contra la regla del repo | ✅ Hecho (2026-09-10) |
| TEST-02 | 🟡 | Cero E2E del área fiscal, que es la más nueva y la legalmente vinculante | ✅ Hecho (2026-09-10) |

---

## FIS-01 🔴 · Un TPV recién instalado no puede cobrar, y el fallo es mudo

`Business_Settings.CIF` y `Razon_Social` nacen vacíos
([`0001_inicial.sql:931,942`](../../packages/database/migrations/0001_inicial.sql#L931)), y la
activación de la licencia **no los rellena**: el `legal_name` del formulario de activación viaja en
el payload de `license_activate` y se queda en la licencia, no en `Business_Settings`.

Pero [`datos_obligado`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L248) devuelve
`DatosFiscalesIncompletos` sin ellos, y ese error se propaga con `?` desde `emitir_cobro`
**dentro de la transacción del cobro** ([`mesas.rs:2134`](../../crates/tpv-infra-sqlite/src/mesas.rs#L2134),
[`venta_rapida.rs:1070`](../../crates/tpv-infra-sqlite/src/venta_rapida.rs#L1070)) → `ROLLBACK`.

Que **haga falta** el NIF es correcto y está decidido: desde 2027 cada cobro expide una factura y
una factura necesita saber quién la emite. `Fiscal.tsx` lo dice con todas las letras («Sin esto no
se puede cobrar»). Lo que falta son las tres cosas que hacen que eso se descubra a tiempo:

1. **Nada lleva al usuario allí.** El estreno va de la licencia al PIN y del PIN al menú. El
   siguiente sitio donde se entera es la caja, con un cliente delante.
2. **El error no dice nada.** `DatosFiscalesIncompletos` no lo trata **nadie** en el frontend (grep
   en `apps/tpv-main/src`: cero coincidencias).
3. **Y en mesas ni siquiera se ve.** El `catch` de
   [`MesaComandaModal.tsx:923-935`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L923)
   sólo hace algo con `factura_completa_requerida` y con el formulario de factura abierto. Para
   cualquier otro error: `console.error` y punto. El camarero pulsa «Confirmar cobro» y **no pasa
   nada**. Ni toast, ni mensaje, ni cobro.

**Qué haría falta.** Un gate en el arranque (como el de la licencia o el del PIN) que pida los datos
del obligado antes de dejar entrar; que `DatosFiscalesIncompletos` se traduzca en la caja a «faltan
los datos fiscales, ve a Configuración → Fiscal»; y que el `catch` del cobro no se trague un error
que no reconoce. Y de paso, [`Negocio.tsx:224`](../../apps/tpv-main/src/features/configuracion/sections/Negocio.tsx#L224)
sigue etiquetando el CIF como **«Opcional»** mientras `Fiscal.tsx` edita esa misma columna diciendo
que sin ella no se cobra: dos pantallas sobre el mismo dato diciendo lo contrario.

> Efecto colateral ya resuelto: esto dejaba `venta.e2e.ts` en rojo desde el 9 de septiembre. El
> recorrido ya declara los datos fiscales (commit `bd8acb6`).

## FIS-02 🔴 · El modo formación rompe el vínculo ticket ↔ registro

El camino real de cobro reserva el número **antes** de saber si el negocio está en formación:

- [`mesas.rs:1275`](../../crates/tpv-infra-sqlite/src/mesas.rs#L1275),
  [`mesas.rs:1989`](../../crates/tpv-infra-sqlite/src/mesas.rs#L1989) y
  [`venta_rapida.rs:790`](../../crates/tpv-infra-sqlite/src/venta_rapida.rs#L790) llaman a
  `reservar_numero_factura()`, que va siempre a `serie_actual()`.
- Ese número se escribe en `Pagos.Numero_Ticket` y se devuelve como `numero_ticket`.
- Después, [`verifactu.rs:535`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L535) lo **descarta**
  si `obligado.formacion` y reserva en `PRU<año>`. El `BloqueFiscal` que devuelve `emitir_cobro` se
  ignora en los tres caminos.

Consecuencias, las tres reales:

1. **El ticket sale sin QR tributario.**
   [`PrintTicketModal.tsx:98`](../../apps/tpv-main/src/shared/ticket/PrintTicketModal.tsx#L98)
   pregunta por `datos.numeroTicket` (`2026/000045`) y
   [`bloque_por_numero`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L3345) busca
   `WHERE Num_Serie_Factura = ?1`, que vale `PRU2026/000001`. No hay fila → `null` → papel sin QR,
   en el cobro y en la reimpresión. Y sin ningún error: esa llamada tiene un `catch` que devuelve
   `null` a propósito, porque nada de lo que rodea al ticket puede impedir imprimirlo.
2. **`Pagos.Numero_Ticket` deja de ser el número de la factura**, que es la invariante escrita en
   CLAUDE.md §11.
3. **Hueco permanente en la serie real.** El contador de `2026` ya se incrementó. Cada venta de
   formación quema un número de la serie de ventas — que es exactamente lo que el comentario del
   código dice estar evitando.

**Por qué las suites no lo ven.** El helper
[`emitir_una`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L2403) de los tests de formación llama
a `emitir_alta` con `numero_reservado: None`, que es el único caso que **no** ocurre en un cobro
real. El test `la_factura_de_formacion_NO_gasta_numero_de_la_serie_de_ventas` pasa por eso.

**Qué haría falta.** Que el camino del cobro pregunte por el modo antes de reservar (una lectura más
en la transacción), o que `emitir_alta` devuelva el número que de verdad usó y el cobro actualice
`Pagos.Numero_Ticket` con él. La segunda es más barata y cierra también cualquier futuro caso en que
la serie no sea la que el llamante creía.

Cuando se arregle, el paso entra en `e2e/specs/fiscal.e2e.ts`, que hoy lo deja fuera a propósito.

## FIS-03 🟠 · Las facturas de prueba de diciembre no se anulan nunca

[`serie_formacion()`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L321) es `PRU<año actual>`, y
tanto [`facturas_de_formacion_vivas`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L1968) como el
barrido de [`set_formacion(false)`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L2009) filtran por
esa serie **calculada en el momento de apagar**.

Formación abierta el 28 de diciembre y cerrada el 2 de enero: se buscan las `PRU2027`, no hay
ninguna, se anulan **cero**. Y el aviso rojo de «Quedan N facturas de prueba sin anular» de
[`Fiscal.tsx:695`](../../apps/tpv-main/src/features/configuracion/sections/Fiscal.tsx#L695) tampoco
las ve, porque sale del mismo contador. Quedan facturas reales sin anular y el panel dice que todo
está bien.

Que el caso sea raro no lo hace menos grave: es exactamente el fallo que el modo formación existe
para impedir («dejarlo a que alguien se acuerde es dejar que el día que se le olvide quede una venta
ficticia contada como real»).

**Qué haría falta.** Buscar por `Serie LIKE 'PRU%'` en vez de por la serie del año en curso. Las dos
consultas ya excluyen las que tienen anulación, así que no hay que tocar nada más.

## FIS-04 🟠 · `remitir_ciclo` cruza el resultado de un ALTA con el de su ANULACIÓN

[`use_cases/verifactu.rs:686`](../../crates/tpv-application/src/use_cases/verifactu.rs#L686):

```rust
.find(|l| l.num_serie_factura == enviado.num_serie_factura)
```

El comentario de arriba explica que se casa por número «y no por posición» para que una línea omitida
por la AEAT no desplace todos los estados. El razonamiento es bueno; el problema es que **el número
no es único dentro del lote**: un registro de anulación lleva el mismo `Num_Serie_Factura` que su
alta, y [`pendientes()`](../../crates/tpv-infra-sqlite/src/verifactu.rs#L3379) no filtra por `Tipo`.

Basta cobrar por error y anular dentro del mismo ciclo de 60 s —o apagar el modo formación antes de
que la cola se drene— para que los dos vayan juntos. `.find()` devuelve la **misma línea** para
ambos.

**El caso silencioso**, que es el que importa: si la AEAT acepta el alta y rechaza la anulación, la
anulación queda anotada como aceptada. Como `subsanar_rechazados` sólo mira los `RECHAZADO`, esa
anulación **no se reintenta jamás** — la AEAT sigue teniendo la factura viva y el panel dice que todo
salió bien.

**Qué haría falta.** El dato para distinguirlas ya se lee y se tira:
[`xml.rs:417`](../../crates/tpv-infra-aeat/src/xml.rs#L417) hace
`extraer("NumSerieFactura").or_else(|| extraer("NumSerieFacturaAnulada"))` y colapsa las dos formas
en un campo. Conservar cuál de las dos era y casar por `(tipo, num_serie_factura)` cierra el hueco.

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

## CAJA-01 🟠 · Editar un apunte comprueba el periodo de origen, no el de destino

[`commands/cuentas.rs:107-115`](../../apps/tpv-main/src-tauri/src/commands/cuentas.rs#L107) llama a
`exigir_periodo_abierto` con el `id_pago`, que lee la fecha **actual** de la fila. Ni el comando ni
[`update_pago`](../../crates/tpv-application/src/use_cases/cuentas.rs#L121) comprueban la fecha
**nueva**. Igual en `cuentas_update_gasto`.

Un administrador puede retrodatar un cobro de hoy a un periodo ya cerrado y arqueado.
[`ventas_efectivo_desde`](../../crates/tpv-infra-sqlite/src/cierre_caja.rs#L185) filtra
`datetime(Fecha_Hora) > datetime(?1)`, así que el `esperado` del periodo abierto baja exactamente el
importe retrodatado. Si además falta ese efectivo del cajón, `contado` baja lo mismo y **el descuadre
sale cero**.

Es el agujero de CUENTA-07 por la otra puerta: no se borra la fila, se la saca del periodo. Que exija
rol de Administrador lo hace menos probable que la sisa de un camarero, pero el control de caja
existe precisamente para que las cifras no dependan de en quién se confía.

**Qué haría falta.** Comprobar el periodo de las **dos** fechas: la que tiene el apunte y la que se
le va a poner. El gate ya está escrito; es pasarle también la fecha entrante.

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

## CFG-01 🟡 · `R2_PUBLIC_BASE_URL` apunta a otro bucket

[`wrangler.json:60`](../../apps/cloud-worker-licensing/wrangler.json#L60) declara
`R2_PUBLIC_BASE_URL = https://pub-772c917409c148e3b39e41b7209e3b1d.r2.dev`. La app usa
`https://pub-6814391221e444b8b1747ab67ce3c21f.r2.dev`, hardcodeado en
[`imageUrl.ts:31`](../../apps/tpv-main/src/shared/lib/imageUrl.ts#L31) y repetido en las dos CSP de
`tauri.conf.json`.

La variable **no se usa en ninguna parte del código** (grep en el worker, en los crates y en el
frontend: cero). No rompe nada hoy; el problema es lo que invita a hacer mañana. Alguien la lee como
la fuente de verdad, «arregla» la CSP para que case con ella, y las imágenes del Handy dejan de
cargar en el build empaquetado — donde, además, la CSP no se ve en `tauri dev` (§8 de CLAUDE.md).

**Qué haría falta.** Borrar la variable, o —si algún día el worker tiene que componer URLs de
imagen— dejarla con el valor bueno y que el frontend la reciba en vez de hardcodearla. Encaja con
INFRA-03 del backlog (dominio propio para el bucket), que resolvería las dos cosas a la vez.

## CFG-02 🟡 · `hono` 4.13.2 con tres avisos moderados

`pnpm audit --prod` saca tres avisos de `hono`, los tres parcheados en **4.13.5**: el parser de
`parseBody()` con anidamiento sin límite (agotamiento de memoria), y dos del parser de query
(interpretación de parámetros tras el fragmento, con diferenciales de cache-key y proxy).

El rango declarado ya es `^4.13.2`, así que basta actualizar el lockfile. Que no haya saltado en CI
es porque `audit.yml` sigue en `continue-on-error: true` — decisión consciente de 2026-08-15
«mientras se ve el ruido real». Con un aviso real encima, quizá toca quitar esa línea.

## CFG-03 🟡 · La firma interna del worker falla abriendo si el secreto está vacío

[`internalAuth.ts`](../../apps/cloud-worker-licensing/src/lib/internalAuth.ts) usa
`String(secret || "")` tanto al firmar como al verificar. Si `LICENSE_JWT_SECRET` faltara o llegara
vacío, las dos mitades usarían la misma clave vacía y el HMAC **pasaría** — con lo que cualquiera que
alcanzara `/internal/apply` podría aplicar comandos en el DO.

No es explotable hoy (el secreto está puesto), y es posible que `crypto.subtle.importKey` rechace una
clave de longitud cero antes de llegar ahí — no lo he comprobado contra workerd, así que lo dejo
dicho como suposición. Da igual: una comprobación de seguridad no debería depender de eso.

**Qué haría falta.** Un `if (!secret) throw` al principio de las dos funciones. Tres líneas.

## CFG-04 🔵 · La guardia de fuentes de tiempo es un `debug_assert!`

[`db.rs:371`](../../crates/tpv-infra-sqlite/src/db.rs#L371) comprueba con `debug_assert!` que ningún
SQL replicable lleve una fuente de tiempo no determinista fuera de las dos formas canónicas. En
release no hace nada, así que una escritura nueva por un camino sin test viajaría al outbox con su
`datetime('now')` sin resolver y la nube la reevaluaría en otro instante.

Está decidido así («en release no penaliza») y la cobertura de contrato al 94 % cubre casi todo. Se
anota por si algún día conviene convertirlo en un error devuelto en vez de en un panic de debug: la
comprobación es una búsqueda de subcadenas sobre un SQL que ya se está recorriendo, así que el coste
real de dejarla en release es difícil de medir.

## HIG-01 🔵 · Sin linter, y ~20 `eslint-disable` decorativos

No hay ESLint, ni Biome, ni configuración de clippy o rustfmt. `pnpm lint` sólo tiene tarea en los
tres `packages/` y es un `tsc --noEmit`: ni la app ni el worker pasan por ahí. Mientras tanto hay
~20 `// eslint-disable-next-line react-hooks/exhaustive-deps` repartidos por el frontend, que no
suprimen nada porque no hay nada que suprimir.

**Datos para decidir**, medidos hoy: `cargo clippy --workspace --all-targets` saca **223 avisos**, de
los cuales **sólo ~24 son lints de clippy** (`redundant_closure`, `unnecessary_map_or`,
`needless_range_loop`… todos cosméticos). El resto son avisos de rustc que ya salen en un `cargo
check` normal, casi todos `dead_code` en código de test. O sea: **el lado Rust está esencialmente
limpio** y activar clippy en CI costaría una tarde de arreglos triviales.

Del lado JS no hay medida porque no hay configuración. Ver la nota de decisión más abajo.

## HIG-02 🔵 · Drift en CLAUDE.md

- §11 cita «`Aperturas_Cajon` (migración 0006)» y sólo existe `0001_inicial.sql`.
- §6 dice «los 224 tests» — son 891.
- §7 dice «`cargo test -p tpv-contracts` (176 ok)».

Nada de esto rompe, pero CLAUDE.md es el documento del que se fía todo el mundo antes de tocar algo,
y una referencia a una migración que no existe hace dudar del resto.

## HIG-03 ✅ · `npx wrangler` (resuelto 2026-09-10)

`scripts/generate-license-keypair.mjs` imprimía `npx wrangler secret put …`. Cambiado a `pnpx`
(commit `b22b0c3`).

> ⚠️ **Ojo con la tabla de equivalencias de CLAUDE.md §8**, que prescribe `pnpm exec <bin>` para este
> caso. `pnpx` es un alias histórico de `pnpm dlx`, que **descarga** el paquete en vez de usar el
> `wrangler` que ya está en las devDependencies del worker. Funciona, pero no es lo que dice la
> convención escrita. Conviene decidir cuál de las dos gana y dejar sólo una.

## TEST-02 ✅ · E2E del área fiscal (resuelto 2026-09-10)

Los cinco recorridos cubrían venta, copias (×3) y licencia. El área más nueva, menos rodada y
legalmente vinculante —Veri\*factu— era la única sin recorrido de punta a punta, y los dos primeros
hallazgos de esta lista viven precisamente en esa costura.

**Resuelto** con `e2e/specs/fiscal.e2e.ts` (commit `bd8acb6`): datos del obligado, registro de alta
con su desglose, `num_serie_factura == Pagos.Numero_Ticket`, QR del ticket estable entre
reimpresiones, cadena sin anomalías y cola de envío. El modo formación se deja fuera hasta que FIS-02
esté arreglado.
