# PLAN — CUENTA-07 · Anulaciones con rastro e historial de caja

**Estado:** plan, sin ejecutar · **Escrito:** 2026-09-03 · **Ficha:** [BACKLOG.md](analisis/BACKLOG.md#cuenta-07--anular-un-cobro-borra-la-fila)

> **Este documento se borra cuando el plan esté cumplido.**

---

## 1. El problema, en una frase

Anular un cobro hace `DELETE` de la fila de `Pagos`, y como el arqueo calcula
`esperado = fondo + cobros en efectivo`, una venta en efectivo anulada baja el esperado exactamente
lo mismo que falta en el cajón. **El descuadre sale cero.** El único control de caja que tiene el
producto es ciego ante la forma más común de sisa en un bar.

No es un fallo de cálculo: los números son correctos. El fallo es que la fila desaparece, así que no
hay nada contra lo que comparar.

---

## 2. Qué hace hoy exactamente

`eliminar_pago` ([cuentas.rs:491-700](../crates/tpv-infra-sqlite/src/cuentas.rs#L491)) hace seis
cosas dentro de una transacción con `defer_foreign_keys`:

| # | Acción | Nota |
|---|--------|------|
| 1 | Lee `ID_Comanda` e `Importe_Total` del pago | Para poder revertir; si no existe, `Ok(false)` |
| 2 | Devuelve stock de lotes (`Lote_Consumos`) y **borra esas trazas** | El borrado *es* la protección anti-doble-abono |
| 2-bis | Devuelve stock suelto (`Suelto_Consumos`) y **borra esas trazas** | Igual (VR-04) |
| 3 | Resta `Clientes.Total_Gastado` vía `Reservas`, con suelo en 0 | Redondea a céntimos antes |
| 4 | **`DELETE FROM Detalle_Comanda`** de las líneas cobradas | *"conservarlas… crearía un ticket fantasma y permitiría cobrarlas de nuevo"* |
| 5 | `DELETE FROM Pago_Detalles` y `DELETE FROM Pagos` | |
| 6 | Recalcula la comanda: la reabre sólo si quedan líneas pendientes y la mesa no tiene otra abierta | |

**Lo que hay que entender antes de tocar nada:** el paso 4 borra las **líneas**, no sólo el pago. Hoy
anular significa *"esta venta nunca ocurrió"* — los artículos se esfuman y el stock vuelve. Cualquier
diseño de soft-delete tiene que decidir qué pasa con esas líneas, y esa decisión es la parte difícil
de este plan (§4).

---

## 3. Los dos cambios, y por qué el orden importa

Son dos cosas que se confunden fácilmente:

**(a) Dejar de destruir la venta.** Un `Estado` en `Pagos` en vez del `DELETE`.
**(b) El historial de caja.** Una tabla nueva de eventos.

**(a) es la que tapa el agujero.** Si sólo se hace (b), el log dirá *"se anuló el pago X"* pero el
pago ya no existe: no se puede reimprimir, ni recalcular el arqueo de aquella noche, ni demostrar qué
contenía. (b) sin (a) es un diario de sucesos sobre pruebas destruidas.

**Regla de diseño que no se puede romper:** `Pagos` sigue siendo la **única fuente de verdad** del
dinero. La tabla de eventos es para investigar, **no** para calcular. En cuanto el arqueo sume desde
la tabla de eventos habrá dos fuentes para la misma cifra y divergirán. El arqueo sigue derivando de
`Pagos`, sólo que ahora filtrando por estado.

---

## 4. DECIDIDO (2026-09-04) — Opción A: las líneas vuelven a estar pendientes

Hay que elegir antes de escribir código. Las tres opciones dejan el mismo rastro de auditoría; se
diferencian en la experiencia de uso.

### Opción A — las líneas vuelven a estar pendientes ⭐ recomendada

Se **conservan** `Detalle_Comanda` y `Pago_Detalles`, y se cambia el predicado de "línea cobrada":

```
hoy:    la línea tiene fila en Pago_Detalles
nuevo:  la línea tiene fila en Pago_Detalles ligada a un Pago con Estado='ACTIVO'
```

- ✅ La auditoría queda **completa**: se sabe exactamente qué líneas cubría el pago anulado, así que
  el ticket se puede reimprimir tal como se emitió.
- ✅ **No hace falta ninguna columna nueva en `Detalle_Comanda`.**
- ✅ Mejor uso real: si el cobro fue un error, los artículos siguen en la mesa pendientes de cobrar,
  que es lo que el camarero espera. Hoy hay que volver a añadirlos a mano.
- ⚠️ **Es un cambio de comportamiento.** Hoy los artículos se esfuman; con esto reaparecen como
  pendientes. Hay que quererlo.

### Opción B — las líneas quedan marcadas como anuladas

Igual que A pero además una marca en `Detalle_Comanda`, y las líneas no vuelven a estar cobrables:
para rehacer el cobro hay que volver a añadirlas.

- ✅ Idéntica al comportamiento actual de cara al camarero.
- ❌ Columna nueva y un estado más que mantener, a cambio de nada que A no dé.

### Opción C — se borran las líneas, como hoy, y sólo se conserva el pago

- ✅ El cambio más pequeño.
- ❌ El pago anulado queda sin detalle: no se puede reimprimir ni saber qué se cobró. La auditoría
  queda coja justo en lo que más importa.

**Elegida: A** (decisión del responsable, 2026-09-04). Da la auditoría completa, es la que menos
esquema toca y la que mejor se comporta. Se acepta el cambio de comportamiento — si el cobro fue un
error, la consumición sigue estando en la mesa, que es lo razonable.

**Caso límite aceptado a sabiendas:** si el producto se borró del catálogo entre la venta y la
anulación, sus líneas vuelven a la mesa pero **no se pueden volver a añadir** (`add_linea_comanda`
necesita el producto). Se pueden quitar y se puede cobrar lo que hay. Es raro —implica borrar del
catálogo algo vendido y luego anular ese cobro— y la salida existe, así que no se le pone más
maquinaria.

⚠️ **Consecuencia que hace falta para que A funcione: ver §6.5.2.** Conservar `Pago_Detalles`
convierte esas líneas en «cobradas» a ojos de media aplicación. Sin tocar eso, vuelven a la mesa
**congeladas**: visibles y sin poder quitarlas.

---

## 5. Esquema

Mientras no haya clientes en producción, esto se edita **dentro de `0001_inicial.sql`** y se resetean
`data.db` y los tenants Turso de desarrollo (CLAUDE.md §3). Desde el lanzamiento sería una migración
nueva.

### 5.1 `Pagos` — cuatro columnas

```sql
Estado TEXT NOT NULL DEFAULT 'ACTIVO',
Anulado_En TEXT NULL,
Anulado_Por TEXT NULL,          -- ID_Usuario que anula
Motivo_Anulacion TEXT NULL,
...
FOREIGN KEY (Anulado_Por) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
CHECK (Estado IN ('ACTIVO','ANULADO')),
-- Un pago anulado tiene que decir cuándo y quién; uno activo no puede tenerlo.
CHECK ((Estado = 'ANULADO') = (Anulado_En IS NOT NULL AND Anulado_Por IS NOT NULL))
```

> `Motivo_Anulacion` **no** entra en el `CHECK`: obligarlo por esquema convierte cualquier anulación
> sin texto en un error de base de datos. Si se quiere obligatorio, se valida en el caso de uso, que
> es donde se puede dar un mensaje decente. Ver §6.2.

Índice, porque **todas** las lecturas de caja van a filtrar por él:

```sql
CREATE INDEX IF NOT EXISTS idx_pagos_estado_fecha ON Pagos(Estado, Fecha_Hora);
```

### 5.2 `Movimientos_Caja` — la tabla de eventos

Nombre y forma calcados de `Movimientos_Stock`, que ya hace esto mismo para el inventario.

```sql
CREATE TABLE IF NOT EXISTS Movimientos_Caja (
  ID_Movimiento TEXT PRIMARY KEY,
  Fecha_Hora TEXT NOT NULL,
  Tipo TEXT NOT NULL,
  ID_Pago TEXT NULL,
  ID_Gasto TEXT NULL,
  ID_Usuario TEXT NULL,
  ID_Trabajador TEXT NULL,
  Importe REAL NOT NULL DEFAULT 0,
  Metodo_Pago TEXT NULL,
  Motivo TEXT NULL,
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago) ON DELETE SET NULL,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL,
  CHECK (Tipo IN ('COBRO','ANULACION','GASTO','GASTO_ANULADO'))
);
CREATE INDEX IF NOT EXISTS idx_movcaja_fecha ON Movimientos_Caja(Fecha_Hora);
```

Notas de diseño:

- **`ID_Movimiento` es `TEXT PRIMARY KEY`**, así que el UUID se genera en un paso `kind:"value"`
  **antes** del INSERT, nunca por DEFAULT ni trigger (CLAUDE.md §9, «IDs deterministas»). Si no,
  nube y Main acaban con filas distintas.
- **`ON DELETE SET NULL` en `ID_Pago`** aunque ya no vayamos a borrar pagos: un movimiento es un
  hecho histórico y no puede desaparecer porque desaparezca aquello a lo que apunta.
- **Ampliar `Tipo` es sólo tocar el `CHECK`.** Cuando se hagan devoluciones (VENTA-01) o llegue
  Veri*factu, entran ahí.
- **`Importe` en positivo siempre**; el signo lo da el `Tipo`. Mezclar signos en una columna que
  luego alguien sumará es pedir un error.

### 5.3 Lo que hay que tocar en el mismo movimiento

Cambiar el esquema arrastra cinco sitios más (CLAUDE.md §3). Si se olvida uno, el anti-drift o el
worker fallan:

1. `packages/database/migrations/0001_inicial.sql`
2. `apps/cloud-worker-licensing/src/server/tenantMigrations.ts` (registro manual)
3. `apps/cloud-worker-licensing/test/helpers/esquemaTenant.ts`
4. `crates/tpv-infra-sqlite/src/migrations.rs` — tocarlo para que `include_dir!` no sirva la copia vieja
5. Rebendecir el snapshot: `BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite`

Y resetear `data.db` local y los tenants Turso de desarrollo que ya tengan hash.

---

## 6. Implementación

### 6.1 Dominio — `crates/tpv-domain/src/cuentas.rs`

Función pura, con tests, que decide si una anulación es válida:

```rust
pub fn puede_anularse(estado: &str, fecha_pago: &str, ultimo_cierre: Option<&str>) -> Result<(), MotivoRechazo>
```

Dos reglas:
- Un pago **ya anulado** no se vuelve a anular (idempotencia visible, no silenciosa).
- Un pago de un **periodo de caja ya cerrado** no se anula sin reabrir antes. Esto ya existe como
  concepto: `cierre_caja` tiene un gate por fecha del apunte contra el último cierre no reabierto
  ([cierre_caja.rs:151](../crates/tpv-infra-sqlite/src/cierre_caja.rs#L151) lee `Fecha_Hora` del
  pago justamente para eso). **Reutilizar ese gate, no escribir otro.**

### 6.2 Caso de uso — `tpv-application/src/use_cases/cuentas.rs`

`delete_pago` pasa a `anular_pago(repo, input)` con `AnularPagoInput { id_pago, id_usuario, motivo }`.

- Valida `id_pago` no vacío (hoy devuelve `Ok(false)`; mantener).
- Valida el motivo si se decide obligatorio. **Recomendación: obligatorio a partir de un importe**,
  reutilizando la idea de `Umbral_Descuadre` de `Business_Settings` — anular un café no debería pedir
  redacción, anular 200 € sí. Si se prefiere simple: obligatorio siempre, o nunca.
- El `id_usuario` **no llega del frontend**: sale de la sesión del backend. Eso es
  [PLAN_SEC_01_ROLES.md](PLAN_SEC_01_ROLES.md) y es **prerrequisito** — ver §9.

### 6.3 Puerto — `tpv-application/src/ports/cuentas.rs`

`eliminar_pago(&str)` → `anular_pago(&AnularPagoArgs) -> AppResult<bool>`.

### 6.4 Persistencia — `crates/tpv-infra-sqlite/src/cuentas.rs`

Reescribir `eliminar_pago`. Mantiene la transacción y los pasos 1, 2, 2-bis y 3 **idénticos**
(revertir stock y gasto del cliente sigue siendo correcto). Cambian el 4, el 5 y el 6:

- **Paso 4 (líneas):** desaparece. Las líneas se conservan (Opción A).
- **Paso 5 (borrado):** `UPDATE Pagos SET Estado='ANULADO', Anulado_En=…, Anulado_Por=…, Motivo_Anulacion=…`.
  `Pago_Detalles` se conserva intacto.
- **Paso 5-bis (nuevo):** `INSERT INTO Movimientos_Caja` con `Tipo='ANULACION'`, el UUID generado
  antes de la sentencia.
- **Paso 6 (comanda):** el `EXISTS` que decide si reabrir tiene que mirar el estado del pago. Pasa de
  «la línea no tiene `Pago_Detalles`» a «la línea no tiene `Pago_Detalles` ligado a un pago activo».

⚠️ **La trampa del anti-doble-abono.** Hoy lo que impide revertir el stock dos veces es que los
`Lote_Consumos`/`Suelto_Consumos` se borran (lo dice su test: *"su traza se retira, para que una
segunda anulación no las sume otra vez"*). Con soft-delete, **el guardia pasa a ser el `Estado`**: si
el pago ya está `ANULADO`, la función sale antes de tocar el stock (§6.1). Si se conserva el borrado
de trazas *y además* el guardia, no pasa nada; si se quitan los dos, se abona el stock cada vez que
alguien pulse el botón. **Este es el punto donde más fácil es meter un bug silencioso.**

Además, `crear_pago` gana su `INSERT` en `Movimientos_Caja` con `Tipo='COBRO'`, y los gastos
(`create_gasto` / `delete_gasto`) los suyos.

### 6.5 Las lecturas — el trabajo de verdad

**Aquí está el riesgo real del cambio.** Al dejar de borrar la fila, toda consulta que sume, cuente o
liste pagos empieza a ver los anulados. Hay que revisarlas **una por una**.

Y son **dos superficies distintas**, no una: las que leen `Pagos` (aquí abajo, 36) y las que deciden
si una línea está cobrada mirando `Pago_Detalles` (§6.5.2, otras 27). **En total unos 63 sitios**, y
es de largo la mayor parte del trabajo de este plan.

**Las que leen `Pagos`:**

- **19 sitios en Rust** — `cierre_caja.rs` (4), `cuentas.rs` (4, uno es el propio borrado),
  `reconciliacion.rs` (2), `stats.rs` (8), `venta_rapida.rs` (1).
- **17 sitios en el worker** — `cuentas.queries.ts`, `stats.queries.ts`, `venta_rapida.queries.ts`,
  `cuentas.commands.ts`.

```bash
grep -rn "FROM Pagos\|JOIN Pagos" crates/tpv-infra-sqlite/src/*.rs
grep -rn "FROM Pagos\|JOIN Pagos" apps/cloud-worker-licensing/src --include=*.ts
```

Criterio por familia:

| Consulta | Qué hacer |
|---|---|
| `ventas_efectivo_desde` ([cierre_caja.rs:164](../crates/tpv-infra-sqlite/src/cierre_caja.rs#L164)) | `AND Estado='ACTIVO'`. **La más importante del plan**: es la que hoy hace que la sisa cuadre |
| Saldo pendiente de comanda ([venta_rapida.rs:282](../crates/tpv-infra-sqlite/src/venta_rapida.rs#L282)) | `AND Estado='ACTIVO'`, o el pendiente se descuadra |
| Estadísticas (`stats.rs`, 8 sitios) | `AND Estado='ACTIVO'`: un ticket anulado no es una venta |
| Reconciliación (`reconciliacion.rs`) | **Las tres consultas llevan `Estado='ACTIVO'`.** Obligatorio, no opcional — ver §6.5.1 |
| Listado de cuentas (`cuentas.rs:122`, `:427`) | **NO filtrar.** Aquí sí se quieren ver, marcados como anulados: es el sitio donde se investiga |
| Búsqueda por id (`cuentas.rs:505`) | Sin filtro; el estado se comprueba en el dominio |

#### 6.5.1 La reconciliación — obligatorio, y una de las tres corrompe datos

El job de reconciliación recalcula desde el origen lo que otras columnas guardan sumado. Hoy funciona
porque **al anular se borra el rastro**: su propio comentario lo dice — *"al anular un pago, la fila
de `Lote_Consumos` se borra, así que la resta desaparece sola y no hace falta modelar devoluciones
aparte"*. El soft-delete rompe ese supuesto.

Son **tres** consultas en [`reconciliacion.rs`](../crates/tpv-infra-sqlite/src/reconciliacion.rs), y
hay que tocar las tres:

| Consulta | Qué se rompe sin el filtro |
|---|---|
| `SQL_LOTES` | El stock volvió al lote, pero la fila de consumo sigue contando → «faltan N unidades», **cada día, para siempre** |
| `SQL_CLIENTES` | `Total_Gastado` se decrementó al anular, pero la suma sigue incluyendo el pago → cliente descuadrado |
| `SQL_GASTO_DE_UNO` | ⚠️ **Corrompe el dato, y lo replica** |

⚠️ **La tercera no es un aviso: escribe.** `recalcular_gasto` calcula y hace
`UPDATE Clientes SET Total_Gastado = ?` **por `execute`**, así que sale por el outbox a la nube. Sin
el filtro, un usuario que vea el aviso de descuadre y pulse «recalcular» **grabaría un total que
incluye el pago anulado** — inflando el gasto del cliente de forma permanente, en local y en la nube.
El aviso falso induce a la acción que rompe el dato.

**Regla única para las tres: la reconciliación sólo cuenta pagos activos.** Un `JOIN` a `Pagos` con
`Estado='ACTIVO'` en cada una.

> Se descartó la alternativa (seguir borrando `Lote_Consumos` al anular). Habría arreglado sólo
> `SQL_LOTES`: las otras dos cuentan el **pago**, que es justo lo que este plan conserva. Como hay
> que entrar en el fichero igualmente, se aplica una sola regla y a cambio se conserva la
> trazabilidad por lote del ticket anulado.

#### 6.5.2 «Línea cobrada» — la otra mitad, y es más grande que la de `Pagos`

La lista de §6.5 son las consultas que leen `Pagos`. Pero **una línea no se considera cobrada
mirando `Pagos`, sino mirando `Pago_Detalles`**: el patrón repartido por todo el código es
`LEFT JOIN Pago_Detalles … WHERE pd.ID_Detalle IS NULL` o `NOT EXISTS (SELECT 1 FROM Pago_Detalles …)`.
Son sitios **distintos** de los anteriores:

- **18 en Rust** — `mesas.rs` (11), `venta_rapida.rs` (5), `cuentas.rs` (2)
- **9 en el worker** — `mesas.queries.ts`, `mesas.commands.ts`, `venta_rapida.*`, `cuentas.commands.ts`

```bash
grep -rn "Pago_Detalles" crates/tpv-infra-sqlite/src/*.rs | grep -iE "not exists|left join"
grep -rn "Pago_Detalles" apps/cloud-worker-licensing/src --include=*.ts | grep -iE "not exists|left join"
```

**La regla, en todos:** de `«tiene fila en Pago_Detalles»` a
`«tiene fila en Pago_Detalles ligada a un Pago con Estado='ACTIVO'»`.

Dos merecen mención aparte, porque son **guardias de escritura**, no lecturas:

| Función | Qué pasa si se olvida |
|---|---|
| `remove_one_pending_detalle` ([mesas.rs:1823](../crates/tpv-infra-sqlite/src/mesas.rs#L1823)) | Se niega a quitar una línea devuelta: *"está cobrada"* |
| `delete_detalle` ([mesas.rs:1869](../crates/tpv-infra-sqlite/src/mesas.rs#L1869)) | Lo mismo, borrando una línea concreta |

**Sin estas dos, la Opción A no funciona**: las 3 cañas y las 2 tapas vuelven a la mesa y el camarero
no puede ni quitarlas. Visibles y congeladas — peor que el comportamiento de hoy.

> **Detalle de UI a comprobar al implementar:** `remove_one_pending_detalle` busca por
> `ID_Producto`. Si el producto se borró del catálogo, la línea lo tiene a `NULL` y **NULL no casa
> con nada en SQL**, así que ese camino no la encuentra. `delete_detalle` (por `ID_Detalle`) sí
> funciona. Cuál use la pantalla decide si el camarero puede quitar esas líneas o no.

### 6.6 Worker — paridad obligatoria

- `cuentas.commands.ts`: `deletePago` → `anularPago`, con los mismos pasos y el UUID determinista.
- `cuentas.schemas.ts`: el schema gana `motivo`, y hay que actualizar el **drift-guard**
  (`Assert<SameKeys<…>>`) o el worker no compila (CLAUDE.md §8).
- Las 5 rutas de escritura de caja siguen vetadas a la Handy por `soloLaMainEscribeCaja`
  ([tenant.ts:74](../apps/cloud-worker-licensing/src/middleware/tenant.ts#L74)). **Eso no cambia**,
  pero el command builder tiene que actualizarse igual porque lo ejercita el harness de contrato.
- `tests/contract/casos/cuentas/delete_pago.json` y su golden: renombrar y rebendecir. **Canónico =
  Rust**; el worker se conforma.

### 6.7 Frontend

- `Cuentas.tsx`: los pagos anulados salen tachados o con distintivo, nunca ocultos, con quién y
  cuándo. Los totales de cabecera ya no los cuentan.
- Modal de anulación: pide motivo (según §6.2) y avisa de que la acción queda registrada.
- Reimpresión: un ticket anulado se puede reimprimir marcado como **ANULADO**. Nunca gasta número
  nuevo (regla ya existente de CLAUDE.md §11).
- Arqueo (`CierreCajaModal.tsx`): línea informativa de «anulaciones del periodo: N por X €». No entra
  en el cálculo — es exactamente el dato que hoy no existe y que hace visible la sisa.

---

## 7. Tests

**Dominio** (`tpv-domain`, sin BD):
- un pago activo se puede anular; uno ya anulado, no
- un pago de un periodo cerrado se rechaza; tras reabrir, se acepta
- la regla del motivo según el umbral

**Persistencia** (`tpv-infra-sqlite`):
- anular **no** borra la fila: sigue ahí con `Estado='ANULADO'`
- anular devuelve el stock de lotes y suelto **exactamente una vez**
- **anular dos veces no abona el stock dos veces** ← el test que justifica §6.4
- `Clientes.Total_Gastado` baja una vez y no cae por debajo de 0
- `ventas_efectivo_desde` **ignora** los anulados ← *el test que prueba que el agujero está tapado*
- las líneas del pago anulado vuelven a contar como pendientes (Opción A)
- **una línea devuelta se puede quitar** (`delete_detalle` y `remove_one_pending_detalle`) ← §6.5.2,
  el test que impide entregar las líneas congeladas
- **una línea de un pago ACTIVO sigue sin poder quitarse** — la guardia no se puede aflojar de más
- la comanda se reabre igual que antes
- `Movimientos_Caja` recibe una fila por cobro y otra por anulación
- **el outbox captura todo**: el `UPDATE` de `Pagos` y el `INSERT` de `Movimientos_Caja` (si esto
  falla, la nube y la Main divergen y no se nota hasta que alguien mira)

**Reconciliación** (§6.5.1) — los tres, y el tercero es el importante:
- tras anular, el lote **no** sale como descuadrado
- tras anular, el cliente **no** sale como descuadrado
- **`recalcular_gasto` sobre un cliente con un pago anulado escribe el total SIN ese pago** ← el que
  impide corromper el dato y replicarlo

**Contrato** (`tests/contract/`): caso de anulación, comparando el estado resultante.

**Worker** (`vitest`): que la Handy sigue recibiendo un veto al intentar anular.

---

## 8. Verificación final

```bash
BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite   # sólo la primera vez, para el snapshot
cargo nextest run                                        # NO `cargo test` (CLAUDE.md §6)
cargo test -p tpv-contracts                              # regenera bindings.ts si cambian DTOs
pnpm --filter tpv-api test
pnpm --filter @tpv/main typecheck && pnpm --filter @tpv/main test
node scripts/check-migration-registry.mjs
```

Y a mano, con la app arrancada: cobrar en efectivo → cerrar caja y anotar el esperado → anular ese
cobro → volver a preparar el cierre. **El esperado no debe haber bajado, y el arqueo debe salir
descuadrado.** Ese es el criterio de aceptación del plan entero.

---

## 9. Orden y dependencias

1. **Antes que nada: [PLAN_SEC_01_ROLES.md](PLAN_SEC_01_ROLES.md).** `Anulado_Por` tiene que salir de
   una sesión que el backend conozca. Si sale de un argumento del frontend, cualquiera puede firmar
   la anulación con el nombre de otro y la auditoría no vale para nada — que es justo lo que este
   plan viene a arreglar.
2. Esquema (§5) + reset de bases de desarrollo.
3. Dominio y caso de uso (§6.1-6.3).
4. Persistencia (§6.4) con sus tests.
5. **Las ~63 consultas**: las 36 de `Pagos` (§6.5) y las 27 de `Pago_Detalles` (§6.5.2). Sin prisa:
   es donde están los bugs. Las dos guardias de escritura de §6.5.2 van primero — sin ellas, lo que
   se entrega está peor que lo que había.
6. Worker y contrato (§6.6).
7. Frontend (§6.7).

Estimación: **3-4 días** de trabajo concentrado. El paso 5 es claramente más de la mitad.

---

## 10. Fuera de alcance (a propósito)

- **Encadenamiento por hash de Veri*factu (FISCAL-01).** `Movimientos_Caja` es la tabla que después
  lo llevará, y por eso las columnas se diseñan pensando en ello — pero implementarlo ahora sería
  hacerlo sin conocer el reglamento en detalle.
- **Devoluciones y abonos (VENTA-01).** Son un `Tipo` más en la tabla. Otro plan.
- **Historial de cambios de líneas de comanda.** Esto es la caja, no la comanda.
- **Anular desde la Handy.** Sigue vetado, y está bien así: el número de ticket y el cajón viven en
  la Main.
