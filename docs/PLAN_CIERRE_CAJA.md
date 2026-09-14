# Cierre de caja (arqueo) — diseño e implementación

> **Estado: IMPLEMENTADO** (2026-08-25). Cierra **CUENTA-06** («no existía el concepto de sesión de
> caja: no se guardaba fondo inicial, ni cierre, ni descuadre»). Lo que sigue es el **diseño** —el
> modelo, las decisiones y sus porqués—, no una lista de tareas pendientes.
> **Escrito:** 2026-08-24 · **Implementado:** 2026-08-25 · **Decisiones acordadas con el responsable** (ver §0).
> **Ámbito:** el arqueo del cajón y qué pasa al corregir un cierre ya hecho. Toca `cuentas`, y de
> refilón `configuracion` (un ajuste) e impresión (un documento nuevo).
> **Revisado 2026-09-13 (CAJA-01):** cerrar ya **no bloquea** el periodo —corregir el pasado
> rectifica el cierre—, los gastos pagados con dinero del cajón restan del esperado y «reabrir» pasa a
> ser «deshacer», sólo el último. Las filas afectadas de §0 y las secciones §1.2 y §2.1 están
> reescritas con la decisión nueva.

---

## 0. Decisiones tomadas

| Decisión | Elección | Consecuencia de diseño |
|---|---|---|
| **Cuándo se cierra** | **Botón manual**, sin automatismo | El periodo va del cierre anterior al siguiente. **No hay fechas de por medio**: una cena de 23:30 a 01:30 es un servicio, no dos días |
| **Quién** | Cualquiera… pero ver la fila siguiente | Cerrar es rutina diaria, no un acto de autoridad |
| **Desde dónde** | **Escribe sólo la Main.** Y toda la sección Cuentas pasa a ser **sólo rol administrador** | La Handy **mira** la caja y el histórico, pero no cambia nada (§1.1) |
| **Efecto de cerrar** | **No bloquea nada** (CAJA-01). Corregir un apunte de un cierre hecho avisa antes, pide motivo si mueve un descuadre y **rectifica** el cierre. **Deshacer**, sólo el último | Cada uno usa el programa como quiera; lo que el programa garantiza es que tocar el pasado no pase desapercibido. Ver §2.1 |
| **Qué se cuadra** | **Sólo el efectivo** | El cajón es lo único que se puede perder físicamente. La tarjeta la cuadra el banco |
| **Qué entra en el esperado** | Fondo heredado **+ cobros en efectivo − gastos pagados con caja** | Un gasto por banco no toca el cajón; uno pagado del cajón sí, y sin restarlo salía como que faltaba. Ver §1.2 |
| **Recuento** | **Por denominación**, no sólo el total | «Faltan 50 €» y «falta un billete de 50» no se investigan igual |
| **Retirada** | Declaras **cuánto dejas**; lo demás es retirada | Lo que dejas es el fondo esperado del cierre siguiente: así se encadenan los periodos |
| **Descuadre** | Siempre se guarda; **motivo obligatorio** por encima de un umbral | Umbral configurable, **5 € por defecto** |
| **Comandas abiertas** | **Avisa y deja cerrar** | Puede haber una mesa legítimamente abierta a esa hora |
| **Primer cierre** | Pide también **con cuánto se empezó** | Cero configuración previa: se resuelve el día que hace falta |
| **Impresión** | Opcional, **documento interno** | Sin numeración de ticket ni datos fiscales (§5) |

**El principio que ordena todo lo demás:** el programa **no puede saber** si el dinero está en el
cajón. Sólo puede registrar lo que alguien declara y enseñar la diferencia. Cuadrar la caja lo hace
el encargado. Si el software intenta imponerlo, lo único que consigue es que se metan cifras falsas
para que le deje seguir.

### 0.1 Por qué el botón y no una hora programada

Dos razones, y la segunda es la definitiva:

1. **Un cierre automático se inventa el recuento.** Cerrar la caja *es* contar el dinero. A las 03:00
   el programa tendría el esperado pero no el contado, y guardaría un arqueo con descuadre 0 que
   nadie ha comprobado. Eso es peor que no tener arqueo: es un dato falso que parece bueno.
2. **La hora programada fallaría justo cuando hace falta.** El runner de tareas de fondo
   ([CLAUDE.md §10](../CLAUDE.md)) sólo corre con la app abierta, y el TPV se apaga al cerrar el bar.
   Un «cerrar todos los días a las 3:00» **no se ejecutaría nunca** en un local que apaga a las 2:30.

**La red contra el olvido** es un aviso, no una acción. Va como **job** (`caja_sin_cerrar`, cada
hora, umbral 20 h): si el periodo lleva demasiado abierto, emite una notificación deduplicada que se
resuelve sola al cerrar. Como job y no "al arrancar" porque el runner sólo corre con la app abierta
—que es justo cuando el aviso sirve— y así también salta en un TPV que lleva días encendido. Avisa;
no cierra solo.

Las 20 horas dejan pasar una jornada larga (un bar que abre a las 09:00 y cierra a las 03:00 sigue
dentro) y saltan cuando de verdad se ha saltado un cierre.

---

## 1. Dos cosas que conviene leer antes de escribir código

### 1.1 La Handy MIRA la caja; no la toca

Decisión final (2026-08-25), que corrige lo que este plan decía antes. Toda la sección Cuentas es
**sólo del rol administrador**, y desde la **Handy es de sólo lectura**: puede ver los ingresos, los
gastos y el histórico de arqueos, pero no cambiar nada. Cerrar y reabrir viven únicamente en la Main,
donde están el cajón, el recuento y la impresora.

Consecuencias en el código:

- El worker **sí** implementa las lecturas de cierres (tres rutas `GET /v1/cuentas/cierres…`), y sus
  casos de contrato de lectura entran con ellas.
- Las escrituras de caja se rechazan **dos veces**: en el adaptador HTTP de la Handy y otra vez en el
  worker (`soloLaMainEscribeCaja`). No es redundancia por gusto — una regla que sólo vive en el
  cliente es una sugerencia, y esconder el botón deja la puerta abierta a cualquiera con el token de
  un Handy.
- El rol se comprueba en el menú y en la **ruta**, porque un menú no es un permiso: sin el candado de
  ruta bastaba con escribir la URL.

### 1.2 Los gastos cuentan sólo si salieron del cajón

La primera versión dejó los gastos fuera del esperado («de esta caja no se paga a proveedores ni a
nómina») y tapaba el hueco con un texto en la pantalla. CAJA-01 lo cambió: un gasto lleva
**`Pagado_Con_Caja`** y los que lo tienen restan. No es un método de pago completo a propósito —la
única pregunta que le importa al arqueo es si ese dinero estaba en el cajón—.

```
esperado  = fondo heredado + cobros ACTIVOS en efectivo − gastos pagados con caja
descuadre = contado − esperado
```

**Un gasto no tiene hora, y el periodo sí.** Para decidir en qué cierre cae se toma **a las 12:00 de
su día** (`HORA_DE_UN_GASTO` en el dominio; la misma expresión en el SQL). Un bar abre por la mañana
y cierra de madrugada, así que el mediodía cae dentro del servicio de ese día: el gasto de la tarde
entra en el cierre de esa noche, no en el de la noche anterior.

Sacar dinero para algo que no se apunta como gasto sigue saliendo como que falta, y eso se dice en la
pantalla («si has sacado dinero para otra cosa, apúntalo como gasto pagado con caja o explícalo en el
motivo»).

---

## 2. Modelo de datos

Dos tablas nuevas. Van en `packages/database/migrations/0001_inicial.sql` **mientras no haya ningún
cliente real con datos** (hoy es el caso: sólo existe esa migración). Si al implementarlo ya lo
hubiera, van en `0002_cierre_caja.sql` **sin tocar la anterior**.

```sql
-- Un cierre de caja. El periodo va del cierre anterior a este: no hay fechas de corte, las decide
-- el boton. Fondo_Inicial es lo que dejo el cierre previo (o lo declarado, en el primero).
CREATE TABLE IF NOT EXISTS Cierres_Caja (
  ID_Cierre        TEXT PRIMARY KEY,
  Fecha_Hora       DATETIME NOT NULL,
  ID_Usuario       TEXT,                              -- quien lo cerro
  Fondo_Inicial    REAL NOT NULL,
  Ventas_Efectivo  REAL NOT NULL,                     -- congelado al cerrar, no se recalcula
  Esperado         REAL NOT NULL,                     -- Fondo_Inicial + Ventas_Efectivo
  Contado          REAL NOT NULL,
  Descuadre        REAL NOT NULL,                     -- Contado - Esperado
  Dejado           REAL NOT NULL,                     -- fondo del periodo siguiente
  Retirado         REAL NOT NULL,                     -- Contado - Dejado
  Motivo           TEXT,
  Reabierto_En     DATETIME,                          -- NULL = sigue cerrado
  Reabierto_Por    TEXT,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

-- Indice de trabajo: "cual es el ultimo cierre" se pregunta en cada apertura de la pantalla.
CREATE INDEX IF NOT EXISTS idx_cierres_fecha ON Cierres_Caja(Fecha_Hora DESC);

-- El recuento por denominacion, tanto del contado como de lo que se deja. Sin esto un descuadre
-- pasado solo dice cuanto falto, nunca en que.
CREATE TABLE IF NOT EXISTS Cierre_Denominaciones (
  ID_Cierre   TEXT NOT NULL,
  Momento     TEXT NOT NULL,                          -- 'CONTADO' | 'DEJADO'
  Valor       REAL NOT NULL,                          -- 0.01 … 200
  Unidades    INTEGER NOT NULL,
  PRIMARY KEY (ID_Cierre, Momento, Valor),
  CHECK (Momento IN ('CONTADO','DEJADO')),
  FOREIGN KEY (ID_Cierre) REFERENCES Cierres_Caja(ID_Cierre) ON DELETE CASCADE
);
```

**Por qué los importes se congelan y no se recalculan.** `Ventas_Efectivo`, `Esperado` y `Descuadre`
se guardan como números, no se derivan al leer. Un arqueo es una **foto de lo que se vio ese día**:
si mañana alguien corrige un cobro de esa noche, la foto no cambia —dejaría de explicar por qué
faltaban 20 € aquella noche—; lo que cambia es el **rectificado**, que se guarda al lado (§2.1).

Lo que CAJA-01 añadió a `Cierres_Caja`: `Periodo_Desde` (desde cuándo contó, para saber después a
qué cierre pertenece un apunte), `Gastos_Caja` y las cuatro `Rect_*` (lo que el cierre marca ahora;
`NULL` = nunca rectificado). Y una tabla `Cierre_Rectificaciones` con una fila por corrección: qué se
tocó, quién, cuándo, por qué y el esperado y el descuadre de antes y de después.

**Por qué `ID_Cierre` es TEXT y se genera fuera del INSERT.** Regla del repo ([CLAUDE.md §9](../CLAUDE.md)):
toda `TEXT PRIMARY KEY` lleva su UUID generado en un paso previo, nunca con `randomblob` dentro de la
sentencia replicada — es justo lo que rompió TRAB-08.

**Ajuste nuevo** en `Business_Settings` (o `Ticket_Settings`, donde encaje mejor al implementarlo):
`Umbral_Descuadre REAL NOT NULL DEFAULT 5`.

### 2.1 Corregir un cierre ya hecho (CAJA-01)

La primera versión **bloqueaba** el periodo cerrado: editar, anular o borrar un apunte de antes del
corte se negaba (`periodo_cerrado`) y había que reabrir. Tenía además un agujero —comprobaba la fecha
de **origen** del apunte y no la de **destino**, así que mover un cobro de hoy a una noche cerrada
pasaba— y, sobre todo, imponía una forma de trabajar. Se decidió lo contrario: **no se bloquea
nada**, y lo que hace el programa es que el cambio no pase desapercibido. Vive en
`use_cases/rectificacion_caja.rs`:

1. **Aviso antes.** `cuentas_previsualizar_cambio` dice a qué cierres hechos afecta el cambio —el de
   origen **y** el de destino— y cómo quedarían. La pantalla lo enseña antes de guardar.
2. **Motivo si cambia un descuadre.** Si el cambio no mueve ningún descuadre (un gasto por banco,
   una edición del concepto) no se pregunta nada. Si lo mueve, el motivo es obligatorio: quien corrige
   es el único que sabe por qué.
3. **Rectificación después.** El cierre guarda lo que marca ahora (`Rect_*`) sin tocar la foto, y
   una fila en `Cierre_Rectificaciones`.

Tres reglas que no se ven a simple vista:

- **Rectificar un cierre no mueve a los siguientes.** Cada cierre arranca con lo que se *dejó*, que
  es dinero contado, no con el esperado del anterior.
- **Se rectifica sumando el cambio a lo que el cierre ya dice, no volviendo a sumar el periodo.** Tras
  recuperar un equipo el histórico baja por partes (SYNC-19, fase 2), y un cierre viejo sumado a mitad
  de descarga saldría descuadrado por cobros que aún no han llegado — y se grabaría para siempre.
- **Deshacer sólo el último.** Deshacer un cierre antiguo dejaría su dinero sin contar en ningún
  periodo. Lo que queda de «reabrir» es lo que la rectificación no arregla: un recuento mal hecho.

---

## 3. Capas (patrón hexagonal del repo)

| Capa | Fichero | Qué va |
|---|---|---|
| Dominio | `crates/tpv-domain/src/cierre_caja.rs` | `RecuentoCaja` (denominaciones → total), `CierreCalculado` (esperado/descuadre/retirado) y la validación «motivo obligatorio si \|descuadre\| > umbral». **Puro y con tests**: es aritmética de dinero, se prueba sin BD |
| Puerto | `tpv-application/src/ports/cierre_caja.rs` | `CierreCajaRepository`: `ultimo_cierre`, `totales_desde`, `crear`, `listar`, `detalle`, `reabrir`, y para rectificar `cierre_de_momento`, `apunte`, `guardar_rectificacion` |
| Casos de uso | `tpv-application/src/use_cases/cierre_caja.rs` | `preparar` (calcula el esperado y avisa de comandas abiertas), `confirmar`, `reabrir` (deshacer, sólo el último) |
| Rectificación | `tpv-application/src/use_cases/rectificacion_caja.rs` | `previsualizar` y los cinco cambios de caja (editar/anular cobro, crear/editar/borrar gasto) con su rectificación (§2.1) |
| Infra | `tpv-infra-sqlite/src/cierre_caja.rs` | El SQL. **Por `execute()`, no por `raw()`**: un cierre es un dato de negocio y se replica |
| Contratos | `tpv-contracts/src/cierre_caja.rs` | DTOs con `#[derive(TS)]` y `export_to = "../../../packages/contracts/src/generated/bindings.ts"` |
| Comandos | `src-tauri/src/commands/cierre_caja.rs` | Finos. `cierre_preparar`, `cierre_confirmar`, `cierre_listar`, `cierre_detalle`, `cierre_reabrir`, `cierre_imprimir` |

**Los importes en `f64` y redondeados a 2 al guardar**, como el resto del sistema (`Importe_Total`,
`Total_Comanda`). No se introduce aquí un tipo de dinero nuevo: sería el único del repo y la
inconsistencia costaría más que el rigor que aporta.

---

## 4. La pantalla

**La actual «Entrada de Caja» desaparece como pantalla suelta** y su contador por denominaciones pasa
a ser el paso 2 del cierre. Se aprovecha lo que ya funciona (`DenomsGrid`, `cashTotal`, `incCash`…,
en `cuentasApis.ts`) y deja de haber dos sitios donde contar el mismo dinero, que es como se acaba
con dos cifras distintas.

Flujo, en un modal de cuatro pasos:

1. **Resumen del periodo** — desde cuándo está abierto, cobros en efectivo, fondo heredado y
   **esperado**. Si hay comandas abiertas, el aviso aquí (no bloquea).
2. **Cuenta el cajón** — el `DenomsGrid` de siempre. Total contado en vivo.
3. **Descuadre** — la diferencia, con su signo y su color. Si supera el umbral, el campo de motivo
   se vuelve obligatorio y el botón de confirmar no habilita sin él.
4. **Qué dejas** — segundo recuento por denominación. La app calcula la **retirada** y avisa de que
   eso será el fondo de mañana.

Y una **pestaña de histórico**: la lista de cierres con su descuadre, quién cerró, y el detalle de
cada uno. Ahí vive el botón de deshacer (sólo en el último, con su confirmación), el de reimprimir y
la marca de los cierres rectificados.

`localStorage` deja de usarse para esto: el fondo predeterminado ya no hace falta como preferencia
local, porque el fondo del siguiente periodo **es un dato del cierre anterior**. Hay que borrar la
clave `cuentas_x_fondo_v1` al migrar para no dejar basura.

---

## 5. El papel

Un **documento interno**, no un ticket de venta. Consecuencias concretas:

- **No consume numeración.** No llama a `siguiente_numero_ticket` ([CLAUDE.md §11](../CLAUDE.md)): si
  gastara un correlativo, la numeración de ventas tendría huecos sin explicación.
- **Sin datos fiscales**: ni CIF del cliente, ni desglose de IVA. Sí el nombre del negocio y la fecha,
  para saber de quién y de cuándo es el papel.
- **Cabecera clara**: «CIERRE DE CAJA», el periodo (desde el cierre anterior hasta ahora) y quién.
- **Cuerpo**: fondo, ventas en efectivo, esperado, contado, **descuadre destacado**, retirado, dejado,
  y el motivo si lo hay. El desglose por denominación, si cabe en el ancho.
- Va en `printing.rs` con su propia función, y **el espejo del frontend** correspondiente, con la
  misma regla de siempre: si cambia uno, cambia el otro, y los golden duplicados a propósito lo
  sujetan.

---

## 6. Tests

- **Dominio (Rust puro).** El grueso: aritmética del recuento, el descuadre con sus signos, el
  redondeo y la regla del umbral. Sin BD, como `ticketMath`.
- **Contrato de lectura.** Las tres lecturas de cierres (último, listado y detalle) tienen su caso:
  la Handy las usa de verdad, así que tienen dos implementaciones que pueden divergir.
- **Contrato de escritura.** No aplica: cerrar y reabrir sólo existen en la Main. Un comando que sólo
  está en un lado no tiene contrato que fijar.
- **Impresión.** Golden del ESC/POS en `printing/tests.rs` y su gemelo en `test/ticketMath.test.ts`.
- **La rectificación** (`tpv-infra-sqlite/src/cierre_caja.rs`): un gasto de caja apuntado tarde
  rectifica, uno por banco no pide nada, sin motivo no se toca ninguna fila, la segunda corrección
  parte de la primera, con el histórico a medias se rectifica con lo que dice el cierre, y sólo se
  deshace el último.

---

## 7. Orden de implementación

1. Esquema + el ritual de migraciones: registrar en `tenantMigrations.ts` y en
   `test/helpers/esquemaTenant.ts`, tocar `migrations.rs` para que `include_dir!` no sirva la copia
   vieja, y **rebendecir el snapshot** (`BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite schema_snapshot`).
2. Dominio + sus tests. Es donde vive el riesgo real (dinero) y donde es más barato probarlo.
3. Puerto, repositorio e infra.
4. Casos de uso (la rectificación de §2.1 llegó después, con CAJA-01).
5. Contratos (`pnpm generate-types`) y comandos Tauri.
6. Pantalla: el modal de cuatro pasos y el histórico; retirar «Entrada de Caja» como pantalla suelta.
7. Impresión + espejo + goldens.
8. El aviso de caja sin cerrar. Va como **job** (`jobs/registro.rs`) y no "al arrancar": el runner
   sólo corre con la app abierta —que es justo cuando el aviso sirve— y así también salta en un TPV
   que lleva días encendido. Avisa por notificación, deduplicada, y se resuelve sola al cerrar.
9. **Cuentas sólo admin, y sólo escribe la Main** — ver §8.

---

## 8. Cuentas: sólo administrador, y sólo escribe la Main

Es una decisión del mismo día pero **no es parte del cierre**: afecta a la sección entera y se puede
hacer antes o después. Tres piezas:

1. **Rol.** El gate por rol de administrador en la ruta del frontend y, sobre todo, **en los comandos
   Tauri** — un gate que sólo vive en la UI no es un gate.
2. **Modo.** La Handy lee pero no escribe: rechazo en el adaptador HTTP y otra vez en el worker
   (`soloLaMainEscribeCaja`, hermano de `cobro_solo_en_main`).
3. **Navegación.** Cuentas no aparece en el menú de quien no es administrador, y la ruta lo
   comprueba también.

**Lo que este candado NO cubre, dicho claro:** el worker autentica por **dispositivo**, no por
usuario, así que no puede saber qué persona está mirando la Handy. El filtro por rol es de la
aplicación. Cerrarlo del todo pediría que el token llevara el usuario de la sesión, y eso es otro
trabajo.

---

## 9. Fuera de alcance (a propósito)

- **Cierre automático o programado**, por lo dicho en §0.1.
- **Cuadre de tarjeta contra datáfono.** Decidido: sólo efectivo.
- **Método de pago completo en los gastos.** Basta con saber si salió del cajón (`Pagado_Con_Caja`,
  §1.2): el arqueo no necesita distinguir un gasto por tarjeta de uno por transferencia.
- **Múltiples cajas o cajones.** Un local, una caja.
- **Cierre en blanco** (cortar el periodo sin recuento). Queda anotado como salida si algún día se
  quiere un automatismo honrado, pero no entra en la primera versión.
