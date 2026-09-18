# Tests de contrato Main (Rust) ↔ worker (TS) — ARCH-01

La lógica de hablar con la base de datos vive **dos veces**: en Rust (la Main, escritora única, contra
su SQLite local) y en TypeScript (el worker, que sirve a las Handy contra Turso). Las dos tienen que
comportarse **igual**, se igualan a mano y ya han divergido (MESA-04/MESA-07). Estos harness pinchan
esa igualdad: convierten una divergencia futura en un **test rojo** en CI.

No eliminan la duplicación (para eso está el WASM del futuro, ver
[BACKLOG §Unificación](../../docs/analisis/BACKLOG.md#unificación-de-la-doble-implementación-mainworker));
la **fijan**. Es el máximo retorno por esfuerzo, sin cambio de arquitectura.

## Son dos, y comparan cosas distintas

| | Qué fija | Qué falla si no está | Dónde vive |
|---|---|---|---|
| **Escritura** | Mismo comando → **mismas filas** en la BD | La replicación **no converge**: los dos lados guardan cosas distintas | `casos/` · `golden/` |
| **Lectura** | Mismas filas → **mismo resultado devuelto** | Los datos convergen pero **se presentan distinto**: el camarero mira la Handy y la Main y ve otra cosa | `lecturas/` |

La diferencia de fondo está en el **orden**. En una escritura el orden en que SQLite deje las filas
de una tabla no es parte del contrato, así que se comparan como **multiconjunto**. Una lectura, en
cambio, es una lista que se pinta en la pantalla en ese orden: dos implementaciones que devuelvan lo
mismo desordenado **no** son equivalentes, y se comparan **por secuencia**.

El resto de este documento describe el harness de **escritura**; el de **lectura** tiene su sección
propia (§[Harness de lectura](#harness-de-lectura-cli-05)) y comparte con él la filosofía, el
formato de los casos y el script de cobertura.

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
├── golden/<modulo>/<caso>.json     # { tabla: [filas] } — el efecto esperado, bendecido por Rust
├── cobertura.json                  # comandos excluidos, con motivo
└── lecturas/                       # el harness hermano (ver §Harness de lectura)
    ├── casos/<modulo>/<caso>.json  # seed + entrada
    ├── golden/<modulo>/<caso>.json # el valor devuelto, bendecido por Rust
    └── cobertura.json              # lecturas excluidas, con motivo
```

Ej.: el caso `venta_rapida__cobro_fraccionado_un_lote` está en
`casos/venta_rapida/cobro_fraccionado_un_lote.json` y `golden/venta_rapida/cobro_fraccionado_un_lote.json`.

### Cuando el ID lo genera cada lado (snapshot con JOIN)

Si el comando **crea filas** con un ID nuevo, ese ID es distinto en cada lado (Rust usa `new_id()`,
el worker `crypto.randomUUID()`) y no puede entrar en el snapshot. Cuando además hace falta saber
**a qué otra fila pertenece** cada una (una mesa y su zona, por ejemplo), el ancla es un JOIN por una
columna estable —el nombre— en lugar del ID:

```sql
SELECT Z.Nombre_Zona AS Zona, M.Numero_Mesa AS Mesa, …
FROM Mesas M LEFT JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
```

**Pon siempre un alias `AS`** en las columnas cualificadas: el lado worker lee los nombres que
devuelve SQLite y el lado Rust los parsea del texto del SELECT, y el alias es lo que garantiza que
ambos usen la misma clave. `LEFT JOIN` (no `INNER`) a propósito: si una fila se quedase huérfana,
tiene que salir en el snapshot y romper el test, no desaparecer sin ruido.

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
| Rust (Main) | `crates/tpv-infra-sqlite/src/contract_tests.rs` | `cargo test -p tpv-infra-sqlite contract_tests` |
| Worker (Handy) | `apps/cloud-worker-licensing/test/contract.test.ts` | `pnpm --filter tpv-api test contract` |

- Rust abre un libsql local, siembra, corre el comando (que captura su efecto en la BD) y lee las filas.
- El worker corre **dentro de workerd** (`@cloudflare/vitest-pool-workers`): levanta el TenantHub real,
  construye el esquema de tenant con las **mismas migraciones** (`test/helpers/esquemaTenant.ts`),
  siembra, corre `cobrarPlan → cobrarFraccionado → buildApplyBatch`, aplica las sentencias y lee.

Ambos leen el mismo `golden`. Como workerd no accede al disco, el worker **importa** el JSON (esbuild
lo empaqueta); Rust lo lee del disco y es quien lo **bendice**.

## Añadir un CASO nuevo (mismo comando)

1. Crea `casos/<modulo>/<caso>.json` con su `seed`, `entrada` y `snapshot`.
2. Añade el nombre lógico `<modulo>__<caso>` a la macro `casos_de_contrato!` en `contract_tests.rs`
   (genera un `#[tokio::test]` por caso; Rust deriva la subcarpeta del nombre) y su par `caso/golden` en
   `contract.test.ts` (imports con la ruta `<modulo>/<caso>.json`).
3. Bendice el golden desde Rust: `BLESS_CONTRACT=1 cargo test -p tpv-infra-sqlite contract_tests`.
4. Corre el worker: `pnpm --filter tpv-api test contract`. Si sale rojo, **has encontrado una
   divergencia real** entre las dos implementaciones (o el snapshot incluye algo no determinista).

## Añadir un DOMINIO/comando nuevo (p. ej. cobro de mesas)

Además de lo anterior, añade el **brazo de despacho** del comando en los dos sitios:
- Rust: `aplicar_comando` en `contract_tests.rs` (un `match` por `caso["comando"]`).
- Worker: `aplicarComando` en `contract.test.ts` (un `switch` por `caso.comando`).

Cada brazo invoca la implementación real de ese comando en su lado. El resto (siembra, snapshot,
comparación, golden) es común y no se toca.

## Cobertura actual

**66 casos, todos verdes** — y **ningún comando con doble implementación sin cubrir**: los que no
tienen caso están excluidos con motivo en [`cobertura.json`](cobertura.json). Por dominio:

- **Venta rápida** (VR-05) — completo: `cobrar_fraccionado` (un lote + FEFO multilote), `create_comanda_barra`,
  `add_linea`, `remove_last_unpaid_linea`, `delete_linea_if_unpaid`, `update_nota_detalle`, `restar_stock`,
  `delete_comanda_if_safe`.
- **Mesas** (MESA-11) — líneas/cocina/cobro: `cobrar_detalles`, `abrir_comanda`, `set_trabajador_if_null`,
  `cerrar_comanda`, `add_linea`, `remove_one_pending_detalle`, `delete_detalle`, `update_detalle_nota`,
  `kitchen_set_line_state`, `set_reserva_estado`, **`save_layout`** (el caso grande: intercambio de
  nombres entre zonas, zona borrada con mesa libre, zona que sobrevive porque su mesa tiene comanda,
  y zona/mesa nuevas).
- **Cuentas / caja** (CUENTA-01/02/03/07) — completo: `create_gasto`, `update_gasto`,
  `delete_gasto`, `update_pago` (con el recálculo del importe desde las líneas cobradas) y
  `anular_pago`, el caso grande: devuelve stock por lote y suelto, resta el gasto del cliente,
  marca el pago sin borrarlo —con quién y por qué—, deja su fila en `Movimientos_Caja` y reabre la
  comanda porque sus líneas, que se conservan, vuelven a estar pendientes.
- **Notificaciones** — completo: `crear` (y el caso de dedupe, que NO crea una segunda),
  `marcar_leida`, `marcar_leidas_batch`, `resolver_por_clave` y la papelera —`descartar`,
  `restaurar` y `eliminar`, el único que borra de verdad y cuyo caso comprueba que los recibos de
  lectura caen con la fila por `ON DELETE CASCADE`—.
- **Inventario** (INV-07) — completo: `create_lote`, `create_categoria`, `upsert_producto`, `set_alergenos`,
  `delete_producto`, `update_lote`, `ajustar_lote`.
- **Clientes**: `crear`, `actualizar` (ojo: CLI-05 es la paridad del **overview**, una lectura, y sigue abierta). **Tareas** (TAR-04): `crear`, `actualizar`, `set_asignaciones`,
  `eliminar`, `restaurar`, `vaciar_papelera` (la papelera de TAR-05: borrar es `Estado='ELIMINADA'`
  conservando las asignaciones, y vaciar es el único borrado real), `marcar_finalizada`. **Proveedores** (PROV-07): `guardar`, `eliminar`, `set_vinculos`,
  `crear_producto`. **Reservas** (RES-07/RES-05): `guardar` (cliente nuevo + merge de existente), `eliminar`.
  **Configuración** (CONF-06): `patch_business`, `patch_contact`, `patch_ticket`.
- **Login/Horarios** (parcial): `login.punch` (**entrada y salida**, TRAB-07), `login.set_turno_partido`,
  `horarios.create/update/delete_asignacion` y `horarios.copiar_semana` (TRAB-08).

## Qué falta por cubrir (y quién lo vigila)

La cobertura es una lista escrita a mano en dos ficheros, así que el punto débil del harness no es
lo que tiene caso: es lo que **entra sin caso**. Un comando nuevo es justo cuando más fácil es que
las dos implementaciones nazcan distintas, y hasta ahora nadie se enteraba.

`node scripts/check-contract-coverage.mjs` vigila **las dos vertientes**:

- **Escritura**: los `export function` de los `*.commands.ts` del worker (si el worker construye SQL
  para algo, ese algo está implementado dos veces) frente a los builders que el harness importa de
  verdad.
- **Lectura**: los `export function` de los `*.queries.ts` **que sirven a un GET**, frente a las
  consultas que importa el harness de lectura. El recorte a los GET es deliberado: media docena de
  esos ficheros son comprobaciones previas de una escritura (`cobrarPlan`, `hasPaidLines`, el
  throttle del login) que ya viajan dentro del harness de escritura al correr su comando. Contarlas
  llenaría el aviso de deuda que no existe, y un aviso que nadie puede vaciar deja de leerse.

Lo que está fuera **a propósito** va en el `cobertura.json` de cada vertiente con su motivo; lo demás
sale como pendiente.

Corre en CI (job `worker`) y **avisa sin romper**: sale siempre con código 0 y deja anotaciones en
el PR y una tabla en el resumen del job. Algo sin contrastar es deuda que hay que ver, no un push que
haya que bloquear. Con `--estricto` sí sale 1, para cuando quieras usarlo a mano.

Hoy dice **63/67 comandos** y **61/61 lecturas** — las lecturas al **100 %, sin una sola exclusión**
— con 0 pendientes en las dos. La primera vez que se ejecutó encontró 10 comandos sin caso que no estaban
documentados en ninguna parte —todo `cuentas`, todo `notificaciones` y `mesas.setReservaEstado`—, y
dos de ellos escondían divergencias reales. Por eso existe. Y lo volvió a hacer: los tres comandos de
la papelera de notificaciones (del commit `eed739b`) entraron **después** de montarse el harness y
salieron aquí; ya tienen caso.

## Harness de lectura (CLI-05)

El hermano del de arriba. Fija que, **partiendo de las mismas filas**, la consulta de la Main y la
del worker devuelvan **lo mismo y en el mismo orden**.

### Por qué hace falta

Los datos convergen —de eso se encarga la replicación—, pero el SQL que los lee **no es el mismo
código**: está en `crates/tpv-infra-sqlite` para la Main y en `domains/*/*.queries.ts` para la Handy.
Las mismas filas pueden acabar presentadas distinto: un JOIN de más, un filtro de borrados que sólo
está en un lado, un `ROUND` en otro sitio, los límites de un rango de fechas (`<` vs `<=`), un `NULL`
que uno normaliza y el otro no. El fallo que produce no es corrupción de datos, es **discrepancia**:
el camarero mira el total en la Handy y la Main dice otra cosa, y nadie sabe cuál creer.

El punto exacto donde se comparan es el **DTO**, y no es una elección arbitraria: en modo Handy,
`tpv-infra-http` deserializa la respuesta JSON del worker **dentro del mismo struct** que devuelve el
repositorio SQLite (`HttpClientesRepository::overview` → `Vec<ClienteOverview>`). El contrato ya es
exactamente ése; el harness sólo lo pincha.

### Reglas de los casos

- **El orden es el contrato.** Los arrays se comparan posición a posición, no como multiconjunto.
- **Los IDs sí entran en el golden.** Al revés que en las escrituras: aquí no los genera nadie, los
  fija el `seed`. Lo que se lee es lo que se sembró.
- **Las fechas del seed son extremas a propósito** (`2000-…` para el pasado, `2099-…` para el
  futuro). Varias consultas comparan contra `date('now','localtime')` —reservas pendientes, tareas
  de hoy, el cuadrante que se rellena con el horario predeterminado— y un seed con fechas cercanas
  convertiría el golden en algo que caduca. Con los extremos, el lado de la comparación en el que
  cae cada fila es el mismo hoy y dentro de setenta años.
- **Un `null` y un campo ausente son lo mismo.** Es lo que hace serde al deserializar la respuesta
  del worker en el DTO (`Option<T>` acepta las dos formas), así que exigir que coincidan sería
  inventarse un requisito que el sistema real no tiene.

Un **caso** (`lecturas/casos/<modulo>/<caso>.json`):

```jsonc
{
  "descripcion": "…",
  "lectura": "cuentas.entradas",          // clave que despacha a la consulta en cada lado
  "seed":     ["INSERT INTO …;", "…"],    // estado de partida (idéntico en ambos lados)
  "entrada":  { "del": "2026-05-01", "al": "2026-05-31", "q": null }
}
```

El **golden** (`lecturas/golden/<modulo>/<caso>.json`) es el valor devuelto tal cual: una lista, un
objeto o `null`.

### Dónde corre cada lado

| Lado | Fichero | Se ejecuta con |
|---|---|---|
| Rust (Main) | `crates/tpv-infra-sqlite/src/contract_read_tests.rs` | `cargo test -p tpv-infra-sqlite contract_read_tests` |
| Worker (Handy) | `apps/cloud-worker-licensing/test/contractLectura.test.ts` | `pnpm --filter tpv-api test contractLectura` |

Regenerar los goldens: `BLESS_CONTRACT_READ=1 cargo test -p tpv-infra-sqlite contract_read_tests`.

### Añadir una lectura

1. Crea `lecturas/casos/<modulo>/<caso>.json`.
2. Añade el nombre lógico `<modulo>__<caso>` a la macro `lecturas_de_contrato!` en
   `contract_read_tests.rs`, y su par caso/golden en `contractLectura.test.ts`.
3. Si la consulta es nueva, añade su brazo de despacho en los dos sitios (`ejecutar_lectura` en Rust,
   `ejecutarLectura` en el worker).
4. Bendice el golden desde Rust y corre el worker. Si sale rojo, **has encontrado una divergencia
   real**.

### Cobertura actual

**65 casos sobre las 61 lecturas**, todos verdes: **cobertura completa, sin exclusiones**. Entre ellos `clientes.overview` (los tres rankings) y
`clientes.form` —que son el CLI-05 original—, `cuentas.entradas` (llano y con búsqueda + paginación),
`cuentas.salidas`, `cuentas.resumen`, `inventario.productos_por_categoria`, `inventario.resumen`,
`mesas.lineas_comanda`, `venta_rapida.comandas_barra`, `venta_rapida.lineas_comanda`, `tareas.admin`,
`tareas.mias` y `trabajadores.asignaciones_semana` (semana pasada y semana futura, que es la que
dispara el relleno con el horario predeterminado: ahí no se contrasta un SQL sino dos algoritmos,
uno con un `BTreeMap` de Rust y otro con un `sort` de JS).

El resto del catálogo también está cubierto: el plano y el estado de las mesas, la pantalla de
cocina, los catálogos y buscadores de los dos POS, el inventario entero (categorías, alérgenos,
lotes, ficha completa), configuración, login, notificaciones, proveedores, reservas, tareas y
trabajadores.

**Casos con `omitir`.** Un caso puede declarar `"omitir": ["campo"]`: esos campos se borran, a
cualquier profundidad, antes de comparar. Es el equivalente de lectura a los SELECT del harness de
escritura, que dejan fuera las columnas no deterministas. Hace falta cuando la consulta devuelve
**dentro del resultado** algo que depende del reloj —`login.punch_status` echa la fecha de hoy en el
propio objeto— y ahí no hay seed que valga: el golden caducaría a medianoche.

### No cubierto (por qué)

Nada. Las cinco consultas de `stats` que estuvieron excluidas —el módulo del worker era una
implementación parcial del de la Main, con métricas a cero fijo (STAT-07)— **ya están portadas y en
verde**, así que `lecturas/cobertura.json` desapareció por innecesario. Si algún día vuelve a hacer
falta excluir una lectura, se crea de nuevo con su motivo y el script de cobertura lo lee solo.

## El guard de SQL replicable determinista (TRAB-08)

Comparar el efecto **no basta** cuando el fallo está en la propia sentencia. `copiar semana`
generaba el ID con `lower(hex(randomblob(16)))` **dentro** del INSERT: cada lado aplicaba eso por su
cuenta y obtenía filas correctas —IDs válidos, distintos entre sí—, así que el snapshot daba verde.
Pero lo que viaja a la Main es el **texto** de la sentencia (el DO solo resuelve a literal
`datetime('now')` y los `$ref`), de modo que la Main volvía a evaluar el `randomblob` y se quedaba
con **otras** claves para las mismas filas.

Por eso `aplicar()` comprueba, en cada caso, que ninguna sentencia **replicada** lleve SQL no
determinista (`SQL_NO_DETERMINISTA`). Es una comprobación sobre el texto, no sobre el efecto, y
protege a todos los comandos del harness a la vez —no solo al que motivó el guard—. Tiene su propio
test, para que relajarlo salga rojo antes de que el fallo pueda volver.

## No cubiertos (por qué)

> Los cuatro primeros están además en [`cobertura.json`](cobertura.json), que es lo que el script de
> cobertura lee: este texto explica, ese fichero es el que hace que no vuelvan a salir como aviso.
> Los **pendientes de verdad** (hoy: todo `cuentas`, `mesas.setReservaEstado` y `notificaciones`) no
> están ahí a propósito — nadie ha decidido nada sobre ellos, así que deben seguir avisando.

- **No hay segunda implementación**: `pedidos_proveedor` (solo Rust, ausente en el worker) y `stats`
  (solo lectura) — nada que contrastar.
- **El número de ticket (`Pagos.Numero_Ticket`) no entra en los snapshots de cobro**: lo asigna la
  Main y solo la Main, porque solo ella cobra. Los constructores de cobro del worker siguen ahí
  como referencia y sus casos contrastan el efecto que sí es compartido (dinero, stock, líneas
  cobradas); la numeración no forma parte de ese contrato.
- **`login.complete_initial_setup`**: ya **no hay segunda implementación** (REV-06). La nube
  ofrecía una con el cerrojo cambiado —verificaba el PIN, sin freno, y no miraba `Requiere_Setup`—
  y se retiró: elegir el PIN inicial es de la Main. Que nadie comparara este comando es parte de
  por qué aquello duró tanto, pero no era cubrible de todos modos: escribe `Password_Hash` con salt
  aleatorio, distinto por diseño en cada lado.
- **`login.punch` sí está cubierto desde el 2026-08-22.** El lado Rust verifica el PIN dentro de
  `repo.punch`, que es lo que lo mantenía fuera; el caso llama a `exec_punch` —el efecto— y se salta
  esa verificación a propósito: **autenticar no es parte del contrato de replicación**, y lo que
  tiene que converger es la fila del fichaje. El snapshot comprueba explícitamente que `ID_Fichaje`
  no viene vacío, porque el bug que motivó el caso (TRAB-07) era justo ese: `TEXT PRIMARY KEY`
  admite NULL en SQLite, así que un INSERT que se deje la columna **no da error**, solo deja una
  fila que luego nadie puede actualizar.
- **`trabajadores.crear/actualizar`**: escriben **PII cifrada** (DNI/IBAN/nº SS — el worker ni la
  escribe) y `Password_Hash` (salt aleatorio → distinto por diseño); solo las columnas no sensibles
  serían comparables, y hace falta cablear el *field cipher*. Cubrible parcialmente, bajo valor.
- **`horarios.set_predeterminado`**: genera los IDs nuevos de forma distinta en cada lado (Rust
  `new_id` vs `randomUUID`), así que solo el resto de columnas sería comparable. (`copiar_semana`
  **sí** está cubierto desde el 2026-08-23: su caso excluye el ID del snapshot pero comprueba que no
  viene vacío ni repetido.)
