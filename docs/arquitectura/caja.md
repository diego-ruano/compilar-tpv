# Caja: cobros, gastos, cierre y anulación

La sección Cuentas es el libro de caja: entradas (`Pagos`), salidas (`Cuentas_Gastos`), el cierre del
periodo (arqueo), la baja de un cobro y la devolución de parte de él. Sus tres reglas de fondo:

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
| Reglas de la devolución | `crates/tpv-domain/src/cuentas.rs` (`unidades_a_devolver`, `importe_devuelto`, `cabe_en_el_cobro`, `RechazoDevolucion`) · `pago.rs::es_efectivo` | Tope por línea y por cobro, el importe de cada parte, qué método pasa por el cajón |
| Espejo en pantalla | `apps/tpv-main/src/shared/lib/efectivo.ts` | El arqueo que se ve antes de confirmar, y el cambio del cobro. Redondea la mitad lejos del cero, como Rust; sus tablas de test repiten las del dominio |
| Casos de uso | `tpv-application/src/use_cases/cierre_caja.rs` | `preparar`, `confirmar`, `listar`, `detalle`, `reabrir` (deshacer) y el aviso de caja sin cerrar |
| Rectificación | `tpv-application/src/use_cases/rectificacion_caja.rs` | `previsualizar` y los cinco cambios: editar o anular un cobro, crear, editar o borrar un gasto |
| Persistencia del cierre | `crates/tpv-infra-sqlite/src/cierre_caja.rs` | `Cierres_Caja`, `Cierre_Denominaciones`, `Cierre_Rectificaciones`, `totales_desde` |
| Baja de un cobro | `crates/tpv-infra-sqlite/src/cuentas.rs::anular_pago` | Stock, gasto del cliente, estado, historial, comanda y registro fiscal en una transacción |
| Devolución de parte de un cobro | `crates/tpv-infra-sqlite/src/cuentas.rs::devolver_lineas` → `Pagos` (negativo) + `Devolucion_Lineas` | Lo mismo, por la parte devuelta |
| Historial | `crates/tpv-infra-sqlite/src/caja_movimientos.rs` → `Movimientos_Caja` | Una fila por hecho: `COBRO`, `ANULACION`, `DEVOLUCION`, `GASTO`, `GASTO_ANULADO` |
| «Línea cobrada» | vista `v_lineas_cobradas` (`0001_inicial.sql`) | `Pago_Detalles` unida a pagos **activos** |
| «Unidades devueltas» | vista `v_unidades_devueltas` | Lo devuelto de cada línea de un cobro por sus devoluciones **vigentes** |
| Comandos | `src-tauri/src/commands/{cierre_caja,cuentas}.rs` | Exigen Administrador, salvo los cobros y sus bajas, que hace también el camarero ([permisos.md](permisos.md)); quién firma sale de la sesión |
| Pantallas | `src/features/cuentas/CierreCajaModal.tsx` · `ImpactoCierreModal.tsx` · `DevolverModal.tsx` · `src/app/pages/Cuentas.tsx` | El cierre en cuatro pasos · el aviso antes de tocar un cierre hecho · devolver · el libro, el histórico y la baja |
| Papel | `src-tauri/src/printing.rs::build_arqueo` (`printer_print_arqueo`) | Documento interno |
| Aviso | `jobs/registro.rs::caja_sin_cerrar` | Notificación si el periodo lleva más de 20 h abierto |
| La Handy | `crates/tpv-infra-http/src/cierre_caja.rs` + worker `domains/cuentas/` (`soloLaMainEscribeCaja`) | Lee; las escrituras se rechazan en los dos sitios |

---

## Quién puede

- **La sección es del Administrador**, lecturas incluidas (SEC-01), **salvo los cobros y sus bajas**:
  el camarero ve la lista de cobros, reimprime, devuelve (entero o una parte) y da de baja por error.
  Gastos, totales, cierre, facturas con NIF y exportar no se le piden ni se le enseñan. Ver
  [permisos.md](permisos.md).
- **Escribe sólo la Main.** La Handy ve ingresos, gastos y cierres (el worker sirve
  `GET /v1/cuentas/cierres`, `…/cierres/ultimo` y `…/cierres/:id`), pero toda escritura de caja se
  rechaza en su adaptador HTTP y otra vez en el worker. El worker autentica por dispositivo, no por
  usuario: el filtro por rol dentro de la Handy es de la aplicación.
- Quién cierra, deshace, anula, devuelve o corrige **lo pone la sesión**: `ConfirmarCierreInput`,
  `CierreIdInput`, `AnularPagoInput` y `DevolverLineasInput` no llevan `id_usuario`.

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
- **Un cobro nunca es negativo** (AUD-17): uno activo de −50 € en efectivo bajaría el esperado lo
  mismo que falta en el cajón, y el arqueo saldría cuadrado. Lo que se mira es lo que suma la base,
  que es lo que se guarda, no lo que manda la pantalla: el de mesa (`cobrar_detalles`) y el de barra
  (`ejecutar_cobro`, también al resolver un cobro pendiente) lo rechazan dentro de la transacción,
  antes de reservar el número, con «El importe no puede ser negativo.». Uno de 0 € (una invitación)
  entra. El único pago negativo es una devolución. En origen, ni el precio de venta ni el coste de un
  lote pueden ser negativos, en la Main (`ProductoUpsert::validar`, `LoteNuevo::validar`) y en el
  worker, con la misma regla y el mismo texto (`validacion_casos.json`); y una línea siempre copia
  el precio del catálogo (RI-27).
- **Un gasto sólo resta si lleva `Pagado_Con_Caja`.** Para decidir en qué periodo cae se compara
  por su **hora de caja** (`Cuentas_Gastos.Momento_Caja`, CAJ-INC-01), que pone quien escribe: al
  apuntarlo con la fecha de hoy, la hora de ese momento; con la de otro día, o al cambiarlo a otro
  día, ese día a las **12:00** (`HORA_DE_UN_GASTO`). Cambiar otra cosa no la mueve. Un gasto sin
  ella cuenta a las 12:00 de su día. Es la misma expresión en el SQL del arqueo
  (`COALESCE(Momento_Caja, …)`) y en `momento_de_gasto_guardado`, que usa la rectificación. Así, el
  hielo pagado a la 01:20 cuenta en el cierre de la 01:30, y el gasto de la tarde apuntado al día
  siguiente cae en el cierre de esa noche aunque se cierre de madrugada. El worker no escribe gastos
  (las rutas de caja se vetan a la Handy).
- **Lo que se deja en el cajón es el fondo del cierre siguiente.** El fondo sólo se acepta de la
  entrada en el **primer** cierre; en los demás lo manda el `Dejado` del anterior, para que nadie
  pueda reescribir el punto de partida y hacer desaparecer un descuadre.
- **El esperado se calcula en el backend**, nunca se recibe de la pantalla.
- **Motivo obligatorio** si `|descuadre|` supera `Business_Settings.Umbral_Descuadre` (céntimos, 500
  por defecto); un umbral ≤ 0 lo pide siempre que haya descuadre. No se puede dejar más de lo contado.
- **Las comandas abiertas se avisan y no bloquean.**
- **Lo del periodo que aún baja tras una recuperación se avisa y no bloquea** (DO-02,
  `historico_pendiente`). Una recuperación desde la nube trae lo que hay desde el último cierre no
  reabierto si cabe en la primera descarga; si no cabe, sólo lo imprescindible para trabajar, y lo
  del periodo abierto baja después por la fase 2
  ([recuperacion.md](recuperacion.md#desde-la-nube-dos-fases-sync-19)). Mientras falte algo de lo
  que suma el arqueo (los cobros y los gastos desde el último cierre o, en el primero, desde el
  principio), sólo cuenta lo que haya bajado: el cierre lo dice con el progreso de la descarga y deja
  cerrar igual. Lo decide `caja_por_bajar`: `Pagos` o `Cuentas_Gastos` sin completar en
  `_Backfill_Historico` y un periodo que empieza antes de lo que trajo entero la primera descarga
  (`Ventana_Desde`), o sin saberlo. Con lo del periodo ya aquí no se avisa, aunque siga bajando lo
  anterior; tampoco en un cierre hecho después de recuperar.
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
- **La preparación suma con el mismo límite** (`totales_desde`, hasta ahora), para que lo que enseña
  la pantalla sea lo que se va a guardar (CAJ-INC-01). Y la confirmación lleva el esperado que vio la
  pantalla (`esperado_visto`): si al recalcularlo dentro de la transacción sale otro —algo entró o
  salió del cajón mientras se contaba—, se rechaza con un `conflict` («El esperado ha cambiado
  mientras contabas: revísalo.») y la pantalla vuelve a preparar sin perder el recuento. Lo que se
  guarda es siempre el cálculo del backend.
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
  `delete_detalle` y `remove_one_pending_detalle`. Cuando el ticket se borra desde la Handy, la
  condición va dentro de los dos `DELETE` que se replican (`deleteComandaIfSafe`): la Main la vuelve a
  evaluar al aplicarlos, y un ticket que allí está cobrado, con el cobro aún sin subir, no se borra
  (AUD-14). Tampoco se borra si alguna de sus líneas está en `v_lineas_cobradas`, aunque el cobro sea
  de otra comanda: o se borra entero o no se borra nada.
- **Los anulados se ven pero no cuentan**: salen tachados en Cuentas y en los PDF, y no suman en los
  totales, las estadísticas ni el pendiente de una comanda.
- **Una reimpresión** de un ticket anulado sale marcada `COPIA` y `*** ANULADO ***`, con el mismo
  número.
- **Un cobro con devoluciones parciales no se devuelve entero**: lo que queda se devuelve desde
  «Devolver» (la pantalla lleva allí al elegir «le devuelvo todo»). Y **una devolución no se da de baja
  por separado** ni se edita: la deshace la baja por error de su cobro.
- **La baja por error de un cobro con devoluciones lo deshace todo**: si la venta no existió, lo
  devuelto de ella tampoco. Sus devoluciones quedan `ANULADO` con la misma firma; el stock recupera
  sólo lo que ellas no habían repuesto (`sql_ya_repuesto`) y al cliente se le resta lo que quedaba;
  se rectifica también el cierre en que cayó cada devolución; y sus rectificativas se anulan antes que
  la factura que rectifican ([verifactu.md](verifactu.md#devolver-parte-de-un-cobro)).

## Devolver parte de un cobro

`cuentas_devolver_lineas` (Administrador o camarero; sólo en la Main, como cobrar y anular). El
cliente devuelve unas líneas, o unas unidades de una línea —una caña de las tres—, y se le devuelve
su dinero. Se elige qué, **por dónde sale el dinero** (`Efectivo`, `Tarjeta` u `Otro`, con el del
cobro propuesto) y por qué. No hay devolución por un importe libre ni descuentos: sólo líneas y
unidades. `cuentas_lineas_devolubles` da lo que queda por devolver de cada línea.

Es dinero que sale por una venta real, así que **va como un pago, no como una baja**:

| | |
|---|---|
| `Pagos` | Un pago **negativo** de la misma comanda: `Tipo = 'DEVOLUCION'`, `ID_Pago_Origen` = el cobro, `Motivo_Devolucion`, el método elegido y quien devuelve como cobrador. El cobro sigue `ACTIVO`: se vendió |
| `Devolucion_Lineas` | Qué línea y cuántas unidades, y lo devuelto por ellas. `Pago_Detalles` no sirve: no guarda cantidades, y la línea seguiría cobrada dos veces |
| Importe | Por línea, lo devuelto en total después menos lo devuelto antes, cada uno redondeado como se cobró (`importe_devuelto`): devolver una línea en varias veces suma exactamente lo que se cobró por ella, también al peso |
| Stock | La parte devuelta de lo que consumió la línea en **ese** cobro, de cada lote y del suelto, con la misma resta a milésimas: al acabar de devolverla, exactamente lo consumido |
| Líneas | Siguen cobradas: no vuelven a la comanda |
| Gasto del cliente | Se resta lo devuelto (sin bajar de 0) |
| Historial | `Movimientos_Caja` tipo `DEVOLUCION`, con el método y el motivo |
| Registro fiscal | Rectificativa por diferencias por lo devuelto (`R5`, o `R1` si era una `F1`), ligada a la devolución ([verifactu.md](verifactu.md#devolver-parte-de-un-cobro)) |
| Caja | Resta de **su** periodo, el día que el dinero sale, y sólo si salió en efectivo |

Reglas:

- **Sólo el efectivo pasa por el cajón.** El arqueo cuenta expresamente `Efectivo`
  (`pago::es_efectivo`, y `Metodo_Pago = 'Efectivo'` en SQL). Los cobros admiten efectivo y tarjeta;
  `Otro` sólo lo lleva una devolución. Rust y el Worker rechazan cualquier método desconocido (RI-48).
- **Se devuelve por líneas, así que el cobro tiene que ser la suma de sus líneas.** Uno que no lo es
  (un cobro prorrateado) no dice cuánto se pagó de cada una: queda la devolución entera. Lo mismo un
  cobro con una línea en negativo (AUD-17): por partes, lo devuelto de las otras pasaría de lo
  cobrado y esa línea no tiene nada que devolver, así que se rechaza desde la primera parcial y la
  devolución entera queda abierta.
- **No se devuelve más de lo que queda**: ni de una línea, ni del cobro, que en total no devuelve
  nunca más de lo cobrado (`cabe_en_el_cobro`); ni de un cobro dado de baja, ni una devolución, ni lo
  que se cobró a 0 €. Un rechazo no deja nada escrito: todo va en una transacción.
- **En las estadísticas resta dinero, pero no es un cobro**: no cuenta como cobro de un camarero ni
  como mesa servida.
- Al acabar, la pantalla abre su rectificativa en el modal de impresión, sin imprimirla.

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
