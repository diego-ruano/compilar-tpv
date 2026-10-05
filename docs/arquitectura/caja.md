# Caja: cobros, gastos, cierre y anulación

La sección Cuentas es el libro de caja: entradas (`Pagos`), salidas (`Cuentas_Gastos`), el cierre del
periodo (arqueo) y la baja de un cobro. Sus tres reglas de fondo:

1. **El programa no puede saber si el dinero está en el cajón.** Sólo registra lo que alguien declara
   y enseña la diferencia. Cuadrar la caja lo hace el encargado.
2. **Nada se borra para corregir.** Un cobro anulado se queda; un cierre corregido guarda su foto y
   su rectificación al lado.
3. **`Pagos` es la única fuente del dinero.** El arqueo deriva de ahí; `Movimientos_Caja` es para
   investigar, no para calcular.

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Aritmética del arqueo | `crates/tpv-domain/src/cierre_caja.rs` | Recuento, esperado, descuadre, umbral del motivo, fechas de apunte, `HORA_DE_UN_GASTO`. Sin BD ni reloj |
| Regla de la baja | `crates/tpv-domain/src/cuentas.rs::puede_anularse` | Ya anulado / falta motivo |
| Espejo en pantalla | `apps/tpv-main/src/shared/lib/efectivo.ts` | El arqueo que se ve antes de confirmar, y el cambio del cobro. Redondea la mitad lejos del cero, como Rust; sus tablas de test repiten las del dominio |
| Casos de uso | `tpv-application/src/use_cases/cierre_caja.rs` | `preparar`, `confirmar`, `listar`, `detalle`, `reabrir` (deshacer) y el aviso de caja sin cerrar |
| Rectificación | `tpv-application/src/use_cases/rectificacion_caja.rs` | `previsualizar` y los cinco cambios: editar o anular un cobro, crear, editar o borrar un gasto |
| Persistencia del cierre | `crates/tpv-infra-sqlite/src/cierre_caja.rs` | `Cierres_Caja`, `Cierre_Denominaciones`, `Cierre_Rectificaciones`, `totales_desde` |
| Baja de un cobro | `crates/tpv-infra-sqlite/src/cuentas.rs::anular_pago` | Stock, gasto del cliente, estado, historial, comanda y registro fiscal en una transacción |
| Historial | `crates/tpv-infra-sqlite/src/caja_movimientos.rs` → `Movimientos_Caja` | Una fila por hecho: `COBRO`, `ANULACION`, `DEVOLUCION`, `GASTO`, `GASTO_ANULADO` |
| «Línea cobrada» | vista `v_lineas_cobradas` (`0001_inicial.sql`) | `Pago_Detalles` unida a pagos **activos** |
| Comandos | `src-tauri/src/commands/{cierre_caja,cuentas}.rs` | Exigen Administrador, salvo los cobros y sus bajas, que hace también el camarero ([permisos.md](permisos.md)); quién firma sale de la sesión |
| Pantallas | `src/features/cuentas/CierreCajaModal.tsx` · `ImpactoCierreModal.tsx` · `src/app/pages/Cuentas.tsx` | El cierre en cuatro pasos · el aviso antes de tocar un cierre hecho · el libro, el histórico y la baja |
| Papel | `src-tauri/src/printing.rs::build_arqueo` (`printer_print_arqueo`) | Documento interno |
| Aviso | `jobs/registro.rs::caja_sin_cerrar` | Notificación si el periodo lleva más de 20 h abierto |
| La Handy | `crates/tpv-infra-http/src/cierre_caja.rs` + worker `domains/cuentas/` (`soloLaMainEscribeCaja`) | Lee; las escrituras se rechazan en los dos sitios |

---

## Quién puede

- **Toda la sección es del Administrador**, lecturas incluidas (SEC-01): los comandos lo exigen, y la
  ruta y el menú lo esconden. Ver [permisos.md](permisos.md).
- **Escribe sólo la Main.** La Handy ve ingresos, gastos y cierres (el worker sirve
  `GET /v1/cuentas/cierres`, `…/cierres/ultimo` y `…/cierres/:id`), pero toda escritura de caja se
  rechaza en su adaptador HTTP y otra vez en el worker. El worker autentica por dispositivo, no por
  usuario: el filtro por rol dentro de la Handy es de la aplicación.
- Quién cierra, deshace, anula o corrige **lo pone la sesión**: `ConfirmarCierreInput`,
  `CierreIdInput` y `AnularPagoInput` no llevan `id_usuario`.

---

## El cierre de caja (arqueo)

**El periodo va de un cierre al siguiente**, sin fechas de por medio: una cena de 23:30 a 01:30 es un
servicio, no dos días. Lo dispara un botón, nunca un reloj: un cierre automático tendría el esperado
pero no el contado, y guardaría un descuadre 0 que no ha comprobado nadie. La red contra el olvido es
el job `caja_sin_cerrar` (cada hora; avisa con más de 20 h abiertas, con una clave de dedupe que se
cierra sola al cerrar la caja).

```
esperado  = fondo heredado + cobros ACTIVOS en efectivo − devoluciones de ventas de otros periodos
            − gastos pagados con caja
descuadre = contado − esperado
retirado  = contado − dejado
```

- **Sólo se cuadra el efectivo.** Cuenta como efectivo todo cobro cuyo `Metodo_Pago` no sea
  exactamente `Tarjeta`.
- **Un gasto sólo resta si lleva `Pagado_Con_Caja`.** Un gasto no tiene hora: para decidir en qué
  periodo cae se toma a las **12:00 de su día** (`HORA_DE_UN_GASTO`, la misma expresión en el SQL de
  `totales_desde` y en `momento_de_gasto`). El gasto de la tarde cae en el cierre de esa noche aunque
  se cierre de madrugada.
- **Lo que se deja en el cajón es el fondo del cierre siguiente.** El fondo sólo se acepta de la
  entrada en el **primer** cierre; en los demás lo manda el `Dejado` del anterior, para que nadie
  pueda reescribir el punto de partida y hacer desaparecer un descuadre.
- **El esperado se calcula en el backend**, nunca se recibe de la pantalla.
- **Motivo obligatorio** si `|descuadre|` supera `Business_Settings.Umbral_Descuadre` (céntimos, 500
  por defecto); un umbral ≤ 0 lo pide siempre que haya descuadre. No se puede dejar más de lo contado.
- **Las comandas abiertas se avisan y no bloquean.**
- Las **anulaciones del periodo** (por `Anulado_En`, de las dos clases) se enseñan al lado, como dato
  informativo fuera del cálculo: «3 anulaciones por 40 €» junto a un descuadre de 40 € se explica solo.

### La pantalla y el papel

`CierreCajaModal` va en cuatro pasos: resumen del periodo (desde cuándo, fondo, cobros y gastos de
caja, esperado, comandas abiertas), recuento del cajón por denominación, descuadre (con el motivo si
hace falta) y qué se deja, también por denominación. El histórico de cierres vive en Cuentas, con el
detalle, la reimpresión, la marca de rectificado y «deshacer» en el último.

El papel (`build_arqueo`) es un **documento interno**: no reserva número de la serie de facturas, no
lleva datos fiscales ni desglose de IVA y no abre el cajón. Lleva el periodo, quién, fondo, cobrado en
efectivo, gastos de caja, esperado, contado, descuadre, el desglose por denominación, el motivo, lo
rectificado después (con cada corrección) y lo dejado y retirado.

### Lo que se guarda

`Cierres_Caja` guarda la **foto de esa noche**: `Periodo_Desde`, `Fondo_Inicial`, `Ventas_Efectivo`,
`Gastos_Caja`, `Esperado`, `Contado`, `Descuadre`, `Dejado`, `Retirado` y `Motivo`, en céntimos.
`Cierre_Denominaciones` lleva los dos recuentos (`CONTADO` y `DEJADO`). Todo va por `execute()`: un
cierre es un dato de negocio y se replica.

Confirmar es **idempotente y atómico** (RI-58):

- El id del cierre lo genera la pantalla al abrir el arqueo y se reutiliza en cada intento: un doble
  clic o un reintento devuelven el cierre ya guardado.
- Leer el último cierre, sumar el periodo y guardar el cierre con sus denominaciones es **una sola
  transacción del escritor** (`cerrar_periodo`). La hora del cierre es también el límite superior de
  sus totales, y antes de soltar el escritor se espera a que cambie el segundo: un cobro guardado
  después nunca lleva la misma hora que el cierre, que no contaría ningún periodo.
- `idx_cierres_un_periodo` impide dos cierres vigentes con el mismo `Periodo_Desde`.

### Deshacer

Sólo el **último** cierre (`reabrir`): marca `Reabierto_En`/`Reabierto_Por` y el periodo vuelve a
estar abierto desde el cierre anterior. Un cierre antiguo no se deshace: su dinero quedaría sin contar
en ningún periodo, porque los siguientes ya empezaron desde él. Sirve para un recuento mal hecho; lo
demás se corrige rectificando.

---

## Corregir un apunte de un cierre ya hecho (rectificación)

**Cerrar no bloquea nada.** Editar o anular un cobro, o crear, editar o borrar un gasto, que caiga en
un cierre hecho —por su fecha de **origen** o por la de **destino**— pasa por `rectificacion_caja`:

1. **Aviso antes**: la pantalla llama a `cuentas_previsualizar_cambio` y enseña a qué cierres afecta y
   cómo quedarían (`ImpactoCierreModal`).
2. **Motivo sólo si cambia un descuadre** (`motivo_rectificacion`). Un gasto por banco o un cambio de
   concepto no piden nada.
3. **Después**, el cierre guarda lo que marca ahora en `Rect_Ventas_Efectivo`, `Rect_Gastos_Caja`,
   `Rect_Esperado` y `Rect_Descuadre`, y una fila en `Cierre_Rectificaciones` (qué, quién, cuándo,
   por qué, esperado y descuadre de antes y de después). La foto no se toca.

Reglas:

- **Se rectifica sumando el cambio a lo que el cierre ya dice** (su última rectificación o la foto),
  no volviendo a sumar el periodo desde la base. Tras una recuperación el histórico baja por partes
  ([recuperacion.md](recuperacion.md)) y un periodo sumado a medias grabaría un descuadre falso. Así,
  además, lo que se previsualiza es exactamente lo que se guarda.
- **Rectificar un cierre no mueve a los siguientes**: cada uno arranca con lo que se dejó, que es
  dinero contado.
- Un cierre pertenece a `(Periodo_Desde, Fecha_Hora]`; los deshechos no cuentan.
- La fecha de origen se lee de la base, no de la entrada. Una fecha de cobro tecleada se valida con
  `fecha_de_apunte` (`AAAA-MM-DD[ HH:MM[:SS]]`) antes de guardarla: lo que SQLite no reconoce como
  fecha dejaría de contar en cualquier periodo.
- No se anota lo que no cambia el esperado.
- Si el cambio se guarda y la rectificación falla, el cambio se queda y el error lo dice.

---

## Dar de baja un cobro

`cuentas_anular_pago` (Administrador o camarero, ruta del worker `POST /v1/cuentas/pagos/:id/anular`, vetada a la
Handy). El motivo es obligatorio siempre, sin umbral: la sisa que esto caza son importes pequeños
repetidos. La pantalla obliga a elegir una de las dos clases, cada una explicada en una frase:

| | `ERROR` — «este cobro nunca debió existir» | `DEVOLUCION` — «le devuelvo el dinero al cliente» |
|---|---|---|
| Stock | Se repone lo que consumió **ese** cobro (`Lote_Consumos.ID_Pago`, `Suelto_Consumos.ID_Pago`) | Igual: lo devuelto vuelve al almacén, y lo que ya no se pueda vender se ajusta desde el inventario |
| Líneas | Vuelven a la comanda, que se reabre si no hay otra abierta en esa mesa | No vuelven |
| Gasto del cliente | Se resta al cliente de la comanda (sin bajar de 0) | Se resta |
| `Pagos` | `Estado = 'ANULADO'`, `Anulado_En`, `Anulado_Por`, `Motivo_Anulacion`, `Motivo_Baja = 'ERROR'` | Igual, con `Motivo_Baja = 'DEVOLUCION'` |
| Historial | `Movimientos_Caja` tipo `ANULACION` | Tipo `DEVOLUCION` |
| Registro fiscal | Registro de **anulación** | Rectificativa **`R5`**, o **`R1`** si era una `F1` ([verifactu.md](verifactu.md#dar-de-baja-un-cobro)) |
| Caja | Rectifica el cierre en que cayó la venta (aquel esperado contaba un dinero que no estaba) | No toca el cierre de la venta; resta del **periodo abierto**, el día que el dinero sale |

Todo ocurre en una transacción con `defer_foreign_keys`. Reglas:

- **El guardia anti-doble-abono es el `Estado`.** Las trazas de consumo se conservan, así que lo único
  que impide reponer el stock dos veces es que `anular_pago` salga antes si el pago ya está anulado.
  Si el `UPDATE` no afecta a ninguna fila, tampoco se emite registro fiscal.
- **Una devolución dentro de su propio periodo no se resta dos veces**: el cobro deja de sumar al ser
  `ANULADO` (entra y sale, neto cero). La resta extra de `totales_desde` sólo coge devoluciones en
  efectivo de ventas con `Fecha_Hora <= desde` y `Anulado_En > desde`; sin cierre anterior no resta
  nada.
- **`totales_desde` filtra por `Estado = 'ACTIVO'`, y ese filtro es lo que hace útil el arqueo.** Si
  anular borrara la fila, el esperado bajaría lo mismo que falta en el cajón y el descuadre saldría
  cero.
- **«Cobrada» es estar en `v_lineas_cobradas`**, no tener fila en `Pago_Detalles`: toda lectura que
  pregunte si una línea está cobrada va por la vista (las escrituras, contra la tabla).
- **La reconciliación de stock cuenta un consumo mientras su cobro esté activo** (`reconciliacion.rs`):
  las dos clases de baja reponen el stock.
- **El consumo de stock se escribe después del pago**: la FK de `ID_Pago` se comprueba sentencia a
  sentencia también al replicar.
- **El gasto se acredita y se resta al cliente de la comanda** (`Comandas.ID_Cliente`), que se fija
  al cobrar desde el de su reserva (RI-61). Así, borrar o reasignar la reserva después de cobrar no le
  quita el gasto al cliente; la reconciliación cuenta igual (el de la comanda y, si no lo tiene, el de
  la reserva).
- **Un cobro anulado queda congelado**: no se edita (moverlo de fecha cambiaría de periodo una
  anulación) ni se «desanula» (se vuelve a cobrar).
- **Borrar una comanda se niega si tiene cualquier cobro**, activo o anulado: `Pagos.ID_Comanda` va
  en cascada y se llevaría la prueba. `Pago_Detalles.ID_Detalle` sí va en cascada, para que una línea
  devuelta a la mesa se pueda quitar; lo que protege a un cobro activo son las guardias de
  `delete_detalle` y `remove_one_pending_detalle`.
- **Los anulados se ven pero no cuentan**: salen tachados en Cuentas y en los PDF, y no suman en los
  totales, las estadísticas ni el pendiente de una comanda.
- **Una reimpresión** de un ticket anulado sale marcada `COPIA` y `*** ANULADO ***`, con el mismo
  número.

## El historial de caja

`Movimientos_Caja` lleva una fila por hecho (cobro, anulación, devolución, gasto, gasto anulado), con
`ID_Movimiento` generado antes del `INSERT` e `Importe` siempre positivo (el signo lo da el `Tipo`).
Es **idempotente por (`Tipo`, apunte)** (`WHERE NOT EXISTS`): un reintento del mismo cobro o gasto no
deja dos filas. Ampliar los tipos es tocar su `CHECK`. Nadie suma el esperado desde aquí: serían dos
fuentes para la misma cifra.

---

## Fuera de alcance

- Cierre automático o programado, y «cierre en blanco» sin recuento.
- Cuadre de tarjeta contra el datáfono.
- Método de pago completo en los gastos: al arqueo sólo le importa si salió del cajón.
- Varias cajas o cajones por local.
