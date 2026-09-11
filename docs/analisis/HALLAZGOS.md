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
> **Estado (2026-09-10, tarde):** los cinco puntos del área fiscal que bloqueaban un piloto están
> resueltos (FIS-01 a FIS-04) más HIG-01, HIG-03 y TEST-02. Lo que queda no impide entrar en un bar:
> CAJA-01 es el siguiente por severidad, y FIS-05 conviene decidirlo (es alcance, no bug).

| ID | Sev | Hallazgo | Estado |
|----|-----|----------|--------|
| FIS-01 | 🔴 | Un TPV recién instalado **no puede cobrar**, y el fallo es mudo | ✅ Hecho (2026-09-10) |
| FIS-02 | 🔴 | El **modo formación** rompe el vínculo ticket ↔ registro | ✅ Hecho (2026-09-10) |
| FIS-03 | 🟠 | Las facturas de prueba de diciembre **no se anulan nunca** | ✅ Hecho (2026-09-10) |
| FIS-04 | 🟠 | `remitir_ciclo` cruza el resultado de un ALTA con el de su ANULACIÓN | ✅ Hecho (2026-09-10) |
| FIS-05 | 🟡 | El modo formación sólo limpia lo fiscal: caja, stock y estadísticas quedan sucios | Sin empezar |
| SYNC-20 | 🔴 | El worker desplegado lleva un esquema **anterior a FISCAL-01**: declarar los datos fiscales atasca el outbox para siempre | Sin empezar |
| CAJA-01 | 🟠 | Editar un apunte comprueba el periodo de **origen**, no el de **destino** | Sin empezar |
| STOCK-01 | 🟡 | Doble abono cruzado de lotes al anular un cobro re-cobrado | Sin empezar |
| CFG-01 | 🟡 | `R2_PUBLIC_BASE_URL` apunta a **otro bucket** que la CSP y la app | Sin empezar |
| CFG-02 | 🟡 | `hono` 4.13.2 con tres avisos moderados | Sin empezar |
| CFG-03 | 🟡 | La firma interna del worker **falla abriendo** si el secreto está vacío | Sin empezar |
| CFG-04 | 🔵 | La guardia de fuentes de tiempo es un `debug_assert!`: en release no protege | Sin empezar |
| HIG-01 | 🔵 | Sin linter en ningún lenguaje, y ~20 `eslint-disable` decorativos | ✅ Hecho (2026-09-10) |
| HIG-02 | 🔵 | Drift numérico y de referencias en CLAUDE.md | Sin empezar |
| HIG-03 | 🔵 | `npx wrangler` contra la regla del repo | ✅ Hecho (2026-09-10) |
| HIG-04 | 🟡 | Promesas de la comanda que se pierden sin decir nada | Sin empezar |
| TEST-02 | 🟡 | Cero E2E del área fiscal, que es la más nueva y la legalmente vinculante | ✅ Hecho (2026-09-10) |

---

## FIS-01 ✅ · Un TPV recién instalado no podía cobrar, y el fallo era mudo (resuelto 2026-09-10)

`Business_Settings.CIF` y `Razon_Social` nacen vacíos y la activación de la licencia **no los
rellena** (el `legal_name` del formulario va a la licencia, no al obligado tributario). Pero
`datos_obligado` devuelve `DatosFiscalesIncompletos` sin ellos, y ese error se propaga con `?` desde
`emitir_cobro` **dentro de la transacción del cobro** → `ROLLBACK`.

Que **haga falta** el NIF es correcto y estaba decidido: desde 2027 cada cobro expide una factura.
Lo que faltaba eran las tres cosas que hacen que eso se descubra a tiempo, y las tres están hechas:

1. **El error ya no es mudo.** El `catch` de `MesaComandaModal` sólo hacía algo con
   `factura_completa_requerida`; para cualquier otro error era `console.error` y nada más — el
   camarero pulsaba «Confirmar cobro» y **no pasaba nada**. Ahora saca un toast con
   `toAppError(e).message`, que el catálogo de `ErrorCode` ya escribe en castellano y para humanos.
   No se ramifica por código: cualquier cosa que llegue ahí es algo que quien cobra tiene que ver.
2. **Venta rápida dice el motivo.** Avisaba, pero con un «Error / No se pudo completar el cobro»
   que no distingue un fallo pasajero de uno que va a repetirse en los siguientes cien intentos.
3. **Alguien te lleva allí.** Un aviso al entrar, montado en `AvisoFiscalMontado` (que ya vivía en
   el layout), que dice que el equipo no puede cobrar y lleva a Configuración → Fiscal de un clic.

**Dónde va el aviso y por qué.** Después del login y no antes: `config_patch_business_settings`
exige Administrador, así que una pantalla anterior al login no podría guardar nada. Manda sobre los
dos peldaños de la escalera de atraso —aquéllos dicen «hay facturas sin remitir», éste dice que el
**siguiente cobro va a fallar**— y lleva su propio reconocimiento, porque cerrar uno no puede
silenciar el otro. Se puede cerrar: atrapar a un camarero que sólo quiere mirar las mesas no arregla
nada (él no puede rellenarlo) y la caja ya dice por qué no cobra.

**`datosFiscalesCompletos` arranca en `true`**, que es lo contrario de lo que pide la prudencia en
casi todo este repo, y aquí es lo correcto: en una **Handy** ese comando falla (no hay registros de
facturación) y antes de la primera respuesta no se sabe nada. Un `false` sacaría un modal bloqueante
en equipos que no tienen ese problema. Lo pesimista ya está donde importa — sin esos datos el cobro
se cancela pase lo que pase en la interfaz.

De paso, `Negocio.tsx` etiquetaba el CIF como **«Opcional»** mientras `Fiscal.tsx` edita esa misma
columna diciendo que sin ella no se cobra. Dos pantallas sobre el mismo dato diciendo lo contrario
es peor que una sola mal puesta: quien lee la primera se queda tranquilo. Ahora remite a Fiscal, que
es donde está el contexto y la validación del NIF.

Ocho tests nuevos del store, **tres comprobados en rojo** antes de darlos por buenos. Los defectos
del store estaban escritos dos veces (en `create` y en `_resetEstadoFiscal`), lo que hacía que el
test del arranque midiera el reset y no el store: ahora hay una sola constante.

## FIS-02 ✅ · El modo formación rompía el vínculo ticket ↔ registro (resuelto 2026-09-10)

El camino del cobro reservaba el número **antes** de saber si el negocio estaba en formación
(`reservar_numero_factura` iba siempre a la serie del ejercicio), lo escribía en
`Pagos.Numero_Ticket`, y después `emitir_alta` lo **descartaba** para numerar en `PRU<año>`.

Las tres consecuencias eran reales: el ticket salía **sin QR** —`verifactu_bloque_ticket` busca por
`Num_Serie_Factura` y no encontraba `2026/000045`— en el cobro y en la reimpresión, y sin una sola
queja, porque esa lectura devuelve `null` a propósito; `Pagos.Numero_Ticket` dejaba de ser el número
de la factura; y el contador de la serie real quedaba gastado, o sea **un hueco en el libro de
ventas por cada prueba** — justo lo que el comentario del código decía estar evitando.

**Resuelto por el otro lado**: en vez de corregir el número después, se pregunta por el modo
**antes de reservar** (`serie_del_cobro`). El número nace en la serie que le toca y no hay nada que
descartar. `emitir_alta` además se niega ahora a escribir un número que no sea de la serie que
corresponde, en vez de aceptarlo en silencio.

No hay carrera: la reserva y la emisión van en la misma transacción del cobro, y `set_formacion`
toma el mismo `WriteGuard`, que serializa a todo escritor.

**Por qué las suites no lo veían**: el helper de los tests de formación pasaba
`numero_reservado: None`, que es el único caso que **no** ocurre al cobrar. Ahora hay un helper que
emite por el camino real, y los cuatro tests nuevos se comprobaron en rojo antes de darlos por
buenos. El E2E cubre además los pasos 9 y 10 (`fiscal.e2e.ts`).

## FIS-03 ✅ · Las pruebas de otro ejercicio no se anulaban (resuelto 2026-09-10)

`facturas_de_formacion_vivas` y el barrido de `set_formacion(false)` buscaban por
`Serie = serie_formacion()`, que mira el **año en curso**. Unas pruebas del 28 de diciembre cerradas
el 2 de enero buscaban `PRU2028`, no encontraban nada y **no anulaban ninguna** — y el aviso rojo del
panel salía del mismo contador, así que tampoco avisaba. Quedaban facturas de prueba vivas para
Hacienda: exactamente lo que el modo existe para impedir.

**Resuelto**: se buscan por prefijo (`Serie LIKE 'PRU%'`), que no depende del calendario. Con test
que reetiqueta un registro a `PRU2019` y comprueba que el panel lo ve y el barrido lo anula.

## FIS-04 ✅ · `remitir_ciclo` cruzaba el ALTA con su ANULACIÓN (resuelto 2026-09-10)

Se casaba la respuesta de la AEAT **sólo por `num_serie_factura`**, y un registro de anulación lleva
el mismo número que el alta que anula (su `IDFactura` **es** el de esa factura). `pendientes()` no
filtra por tipo, así que los dos podían ir en el mismo envío — basta cobrar por error y anular dentro
del mismo ciclo de 60 s, o apagar el modo formación antes de que la cola se drene. `find` devolvía la
primera línea para ambos.

El daño no se veía: si la AEAT aceptaba el alta y rechazaba la anulación, la anulación quedaba
anotada como **aceptada**. Y como `pendientes()` sólo coge los `PENDIENTE` y `subsanar_rechazados`
sólo los `RECHAZADO`, esa anulación no se reintentaba jamás — la factura seguía viva para Hacienda
mientras el panel decía que todo salió bien.

**Resuelto.** El dato para distinguirlas ya se leía y se tiraba: la AEAT no manda un campo «tipo»,
lo dice la **forma** del `IDFactura` (`NumSerieFacturaAnulada` en la anulación). `LineaRespuesta`
gana `anulacion: bool`, el parser lo rellena y `remitir_ciclo` casa por **(tipo, número)**.

Tres tests nuevos, y los dos del caso de uso **se comprobaron en rojo** revirtiendo el arreglo antes
de darlos por buenos: un test de regresión que pasa por el motivo equivocado no vale nada.

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

## SYNC-20 🔴 · El worker desplegado va por detrás del esquema, y eso atasca el outbox entero

**Lo encontró el E2E, y no lo habría encontrado nada más.** `copias-1` empezó a fallar esperando a
que la nube se pusiera al día: `{"outbox_pending":6,"last_seq":0}` durante los 3 minutos de espera.

Leyendo `_Sync_Outbox` de la base del recorrido, el diagnóstico es exacto: **las operaciones 1 a 4
se drenaron** (ya no están) y la cola se para en la 5, que es la primera que toca una columna de
FISCAL-01:

```sql
UPDATE Business_Settings SET Business_Name = ?, …, Razon_Social = ?, Updated_At = '…' WHERE ID = 1;
```

Detrás de ella se acumulan la categoría y cuatro notificaciones. **La cola está ordenada a propósito
—sus operaciones se apoyan unas en otras— así que una que no pasa detiene TODA la replicación
posterior, para siempre y en silencio**: `sync_health` no lo marca como fallo (`failing` cuenta los
cambios de ENTRADA en cuarentena, no los de salida), y `drainOutbox` se limita a un `console.warn` y
a salir del bucle.

**La causa.** `tenantMigrations.ts` del worker importa `0001_inicial.sql` **en tiempo de
compilación** (`import m0001 from "…/0001_inicial.sql"`, por la regla `type: "Text"` de
`wrangler.json`). O sea que el worker **desplegado** aprovisiona los tenants con el esquema que tenía
el fichero el día que se desplegó. `Razon_Social` entró el **2026-09-08** (`41ebcde`, tramo 1/8 de
Veri\*factu) y el fichero se siguió tocando hasta el 09-09; si no se ha desplegado desde entonces,
todo tenant nuevo nace sin esas columnas y el `UPDATE` de arriba falla en Turso.

> ⚠️ **No lo he confirmado del todo**, y la confirmación toca producción: hay que desplegar el worker
> (o consultar el esquema de un tenant), y eso es una decisión tuya, no mía. Lo que sí está
> confirmado es el síntoma —la cola se para exactamente en la primera sentencia con una columna de
> FISCAL-01, con las anteriores ya drenadas— y que `licencia.e2e.ts`, que también espera a la nube
> pero nunca escribe `Business_Settings`, sincroniza sin problema.

**Por qué importa más de lo que parece.** No es un fallo del área fiscal: es que **declarar los datos
del obligado deja al equipo sin replicar nada más**. Y como FIS-01 ahora empuja a todo el mundo a
rellenarlos nada más estrenar, sería lo primero que haría cualquier instalación nueva. El equipo
seguiría vendiendo (es Local-First) pero la nube se quedaría en el día uno: sin Handy, sin catch-up y
sin nada que restaurar el día de la avería.

**Qué hacer.** Desplegar el worker (`pnpm --filter tpv-api exec wrangler deploy`) y **resetear los
tenants de desarrollo** que ya tengan grabado el hash anterior — el runner rechaza con
`migration_altered` una migración ya aplicada cuyo hash cambie (CLAUDE.md §3). Después, `copias-1`
vuelve a `declararDatosFiscales` en vez de descartar el aviso (el comentario del recorrido lo dice).

**Y hay una lección aparte**, que conviene arreglar aunque el despliegue lo resuelva: una operación
que la nube rechaza **para siempre** debería verse. Hoy no sale en `sync_health`, ni en el panel de
Conectividad, ni en ningún sitio: el único síntoma es que `last_seq` no sube. Un contador de
«operaciones rechazadas al subir» con el `Op_Id` y el error convertiría tres minutos de espera y una
consulta a mano en una línea en pantalla.

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

## HIG-01 ✅ · Sin linter en ningún lenguaje (resuelto 2026-09-10)

No había ESLint, ni Biome, ni configuración de clippy. Y mientras tanto había ~20
`// eslint-disable-next-line react-hooks/exhaustive-deps` repartidos por el frontend que no
suprimían nada, porque no había nada que suprimir.

**Resuelto**, y no como formateador: tres reglas de análisis (`rules-of-hooks`, `exhaustive-deps`,
`no-floating-promises`) más clippy, los dos en CI. El criterio y lo que se apagó —con su motivo—
están en `eslint.config.mjs` y resumidos en CLAUDE.md §8.

**Lo que encontró al encenderlo**, que es la respuesta a si servía de algo:

- **72 promesas sin gestionar.** 25 eran invalidaciones de TanStack en `onSuccess` (fuego y olvido
  legítimo, ahora marcado con `void`); 4 eran `setAlarm` del `TenantHub` **sin esperar** — y un
  `setAlarm` perdido deja la cola de SYNC-18 sin drenar, que es justo lo que el comentario de ese
  fichero dice que no puede pasar. Ahora se esperan (o van por `waitUntil` donde la función es
  síncrona).
- **`pnpm lint` estaba roto**: 0 de 3 tareas pasaban. Los tres `packages/*` declaraban
  `"lint": "tsc --noEmit"` y **no tienen `tsconfig.json`**, así que el comando fallaba siempre.
  Nadie lo notó porque el script no estaba en CI.
- **4 de los ~20 `eslint-disable` de `exhaustive-deps` estaban obsoletos** (`AppBoot.tsx` ×2,
  `Proveedores.tsx`, `KitchenBoard.tsx`): la regla ya no salta ahí. ESLint los retiró.
- Del lado Rust, **223 avisos de los que sólo ~24 eran de clippy** y todos cosméticos. Se
  arreglaron; dos se silenciaron con su motivo (los alias FFI `HANDLE`/`BOOL`, que son los nombres
  de Win32, y los nombres de test que usan MAYÚSCULAS o `dominio__caso` a propósito).
- Y **una pieza de código muerto real**: `PairingAdapter` guardaba una `app_data_dir` que nadie
  leía desde que sus credenciales se movieron al `secret_store`.

**Lo que queda fuera y por qué**: los `packages/*` no entran en el análisis con tipos —sin
`tsconfig.json` no hay tipos—, así que `invokeClient.ts`, que es la frontera del IPC, no está
cubierto por `no-floating-promises`. Darles un `tsconfig.json` es la forma de arreglarlo.

## HIG-04 🟡 · Promesas de la comanda que se pierden sin decir nada

Lo destapó `no-floating-promises`. `void` marca la intención de «fuego y olvido», pero **no** dice
que el callee gestione sus errores, y en el camino de la comanda hay al menos uno que no:

- [`MesaComandaModal.tsx:828`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L828)
  `eliminarLineaTicket` hace `await deleteDetalleById(...)` y `await reloadTicket()` **sin
  `try`/`catch`**. Si el borrado falla, la línea se queda en pantalla y nadie dice por qué.

Es la misma forma que FIS-01: un fallo mudo en la ruta caliente. La diferencia es que aquí el
arreglo es pequeño (un `.catch` con un aviso), pero conviene hacerlo con la lista delante y no de
uno en uno: el linter ya marcó los 47 sitios de fuego y olvido, y falta repasar **cuáles de ellos
tragan errores** en vez de contarlos.

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
