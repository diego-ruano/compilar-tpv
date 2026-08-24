# Cierre de caja (arqueo) — diseño e implementación

> **Estado: DISEÑO CERRADO, sin implementar.** Cierra **CUENTA-06** («no existe el concepto de sesión
> de caja: no se guarda fondo inicial, ni cierre, ni descuadre»).
> **Escrito:** 2026-08-24 · **Decisiones acordadas con el responsable** (ver §0).
> **Ámbito:** el arqueo del cajón y el bloqueo del periodo cerrado. Toca `cuentas`, y de refilón
> `configuracion` (un ajuste) e impresión (un documento nuevo).

---

## 0. Decisiones tomadas

| Decisión | Elección | Consecuencia de diseño |
|---|---|---|
| **Cuándo se cierra** | **Botón manual**, sin automatismo | El periodo va del cierre anterior al siguiente. **No hay fechas de por medio**: una cena de 23:30 a 01:30 es un servicio, no dos días |
| **Quién** | Cualquiera… pero ver la fila siguiente | Cerrar es rutina diaria, no un acto de autoridad |
| **Desde dónde** | **Sólo Main.** Y toda la sección Cuentas pasa a ser **sólo rol administrador** | La Handy deja de ver Cuentas entera (ver §1.1: contradice una respuesta anterior, y manda ésta) |
| **Efecto de cerrar** | **Bloquea** los cobros y gastos del periodo; **reabrir puede cualquiera** y queda registrado | El bloqueo es un badén, no una puerta: hace que tocar el pasado sea deliberado y deje rastro |
| **Qué se cuadra** | **Sólo el efectivo** | El cajón es lo único que se puede perder físicamente. La tarjeta la cuadra el banco |
| **Qué entra en el esperado** | Fondo heredado **+ cobros en efectivo**. **Nada de gastos** | De esta caja no se paga a proveedores ni a nómina. Ver §1.2 |
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

**La red contra el olvido** es un aviso, no una acción: al arrancar, si el periodo abierto lleva más
de N horas, se propone cerrar. Avisa; no cierra solo.

---

## 1. Dos cosas que conviene leer antes de escribir código

### 1.1 «Cuentas sólo Main» contradice una respuesta anterior, y manda ésta

En la ronda de preguntas se dijo que **la Handy podría ver el cierre** sin modificarlo. Después se
decidió que **toda la sección Cuentas es sólo rol administrador y sólo desde la Main**. La segunda
decisión es posterior y más amplia, así que gana: **la Handy no ve Cuentas, ni el cierre.**

Consecuencia práctica: **no hace falta implementar nada del cierre en el worker**, y por tanto
tampoco casos de contrato de lectura para él. Lo único que el worker necesita saber es **rechazar**
las escrituras de cuentas que le lleguen de una Handy, igual que ya hace con el cobro
(`cobro_solo_en_main`).

### 1.2 Sin gastos, el esperado es más simple — y eso hay que decirlo en la pantalla

Se descartó añadir el método de pago a los gastos, porque de la caja del bar no se paga a
proveedores ni a personal. Entonces:

```
esperado  = fondo heredado + cobros en efectivo del periodo
descuadre = contado − esperado
```

**El riesgo** es que alguien saque dinero del cajón para pagar algo y el arqueo lo cante como que
falta. No se resuelve con código: se resuelve **diciéndolo en la pantalla** («esta caja sólo cuenta
ventas en efectivo; si has sacado dinero para otra cosa, explícalo en el motivo»). Es una decisión
consciente, no un olvido, y por eso queda escrita aquí.

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
si mañana alguien reabre el periodo y corrige un cobro, el arqueo de ayer no puede cambiar
retroactivamente, porque entonces dejaría de explicar por qué faltaban 20 € aquella noche.

**Por qué `ID_Cierre` es TEXT y se genera fuera del INSERT.** Regla del repo ([CLAUDE.md §9](../CLAUDE.md)):
toda `TEXT PRIMARY KEY` lleva su UUID generado en un paso previo, nunca con `randomblob` dentro de la
sentencia replicada — es justo lo que rompió TRAB-08.

**Ajuste nuevo** en `Business_Settings` (o `Ticket_Settings`, donde encaje mejor al implementarlo):
`Umbral_Descuadre REAL NOT NULL DEFAULT 5`.

### 2.1 El bloqueo del periodo

No hay columna «bloqueado» en `Pagos` ni en `Cuentas_Gastos`: se deduce. Una fila está bloqueada si
su fecha es **anterior al último cierre no reabierto**. Es una sola consulta y no hay estado que
mantener sincronizado, que es el tipo de campo que siempre acaba mintiendo.

El gate va en el **caso de uso**, no en la UI: `cuentas_update_pago`, `cuentas_delete_pago`,
`cuentas_update_gasto` y `cuentas_delete_gasto` comprueban antes de tocar nada y devuelven
`ErrorCode` propio (`periodo_cerrado`) para que el frontend pueda ofrecer «reabrir» en vez de un
mensaje genérico. Añadir ese código al catálogo cerrado está justificado: **se ramifica** por él.

---

## 3. Capas (patrón hexagonal del repo)

| Capa | Fichero | Qué va |
|---|---|---|
| Dominio | `crates/tpv-domain/src/cierre_caja.rs` | `RecuentoCaja` (denominaciones → total), `CierreCalculado` (esperado/descuadre/retirado) y la validación «motivo obligatorio si \|descuadre\| > umbral». **Puro y con tests**: es aritmética de dinero, se prueba sin BD |
| Puerto | `tpv-application/src/ports/cierre_caja.rs` | `CierreCajaRepository`: `ultimo_cierre`, `ventas_efectivo_desde`, `crear`, `listar`, `detalle`, `reabrir` |
| Casos de uso | `tpv-application/src/use_cases/cierre_caja.rs` | `preparar_cierre` (calcula el esperado y avisa de comandas abiertas), `confirmar_cierre`, `reabrir_cierre`. Y el gate `periodo_cerrado` que consumen los casos de uso de cuentas |
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
cada uno. Ahí vive el botón de reabrir (con su confirmación) y el de reimprimir.

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
- **Contrato de escritura.** `cierre_caja.confirmar` y `cierre_caja.reabrir`… **sólo si el worker
  llega a implementarlos**. Como la Handy no toca Cuentas (§1.1), lo correcto es **no** implementarlo
  en el worker y anotarlo en `tests/contract/cobertura.json` con ese motivo. Un comando que sólo
  existe en un lado no tiene contrato que fijar.
- **Impresión.** Golden del ESC/POS en `printing/tests.rs` y su gemelo en `test/ticketMath.test.ts`.
- **El gate.** Un test por cada uno de los cuatro comandos de cuentas: con periodo cerrado devuelven
  `periodo_cerrado` y **no tocan la fila**.

---

## 7. Orden de implementación

1. Esquema + el ritual de migraciones: registrar en `tenantMigrations.ts` y en
   `test/helpers/esquemaTenant.ts`, tocar `migrations.rs` para que `include_dir!` no sirva la copia
   vieja, y **rebendecir el snapshot** (`BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite schema_snapshot`).
2. Dominio + sus tests. Es donde vive el riesgo real (dinero) y donde es más barato probarlo.
3. Puerto, repositorio e infra.
4. Casos de uso, incluido el gate `periodo_cerrado` en los cuatro comandos de cuentas.
5. Contratos (`pnpm generate-types`) y comandos Tauri.
6. Pantalla: el modal de cuatro pasos y el histórico; retirar «Entrada de Caja» como pantalla suelta.
7. Impresión + espejo + goldens.
8. El aviso de arranque (periodo abierto desde hace demasiado).
9. **Cuentas sólo admin y sólo Main** — ver §8, va aparte.

---

## 8. Lo que va aparte: Cuentas sólo administrador y sólo Main

Es una decisión del mismo día pero **no es parte del cierre**: afecta a la sección entera y se puede
hacer antes o después. Tres piezas:

1. **Rol.** El gate por rol de administrador en la ruta del frontend y, sobre todo, **en los comandos
   Tauri** — un gate que sólo vive en la UI no es un gate.
2. **Modo.** Rechazar en modo Handy. En el worker, devolver el error de dominio que corresponda a
   cualquier escritura de cuentas, igual que ya se hace con `cobro_solo_en_main`.
3. **Navegación.** Que Cuentas no aparezca en el menú de una Handy ni de un usuario sin el rol.

---

## 9. Fuera de alcance (a propósito)

- **Cierre automático o programado**, por lo dicho en §0.1.
- **Cuadre de tarjeta contra datáfono.** Decidido: sólo efectivo.
- **Método de pago en los gastos.** Descartado: de esta caja no se paga a proveedores ni a nómina.
- **Múltiples cajas o cajones.** Un local, una caja.
- **Cierre en blanco** (cortar el periodo sin recuento). Queda anotado como salida si algún día se
  quiere un automatismo honrado, pero no entra en la primera versión.
