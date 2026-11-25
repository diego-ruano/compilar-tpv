# El registro de facturación (sin Veri\*factu)

Cada cobro expide una **factura** y produce un **registro de facturación** encadenado. Esta rama
**no remite a la AEAT**: Veri\*factu (el envío, el certificado, el QR del papel y todo lo que lo
rodea) vive en las ramas `con-verifactu` y `con-verifactu-windows-7`, tal como estaba el
25-10-2026. Cuándo hay que volver a ponerlo y cómo: [pendientes.md](../pendientes.md#verifactu).

El registro se sigue guardando **completo**: huella, URL del QR y bloque `SistemaInformatico`, igual
que con Veri\*factu. No se ve en ninguna pantalla ni en el papel, pero es lo que permite volver a
poner el envío sin tocar lo ya emitido. Las tablas de la cola de envío (`_Verifactu_Envios`,
`_Verifactu_Anomalias`, `_Verifactu_Flujo`) y las columnas `Verifactu_Entorno` y `Modo_Prueba` siguen
en el esquema, sin uso.

El principio que ordena todo: **el registro es el hecho fiscal**; el papel es una copia suya. De ahí
salen las tres reglas que no se negocian:

1. El registro se crea **en la misma transacción que el cobro**.
2. **No se modifica**: `Registros_Facturacion` es *append-only* y no se purga nunca.
3. **Nada de lo que rodea al registro puede impedir cobrar.**

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Aritmética fiscal | `crates/tpv-domain/src/verifactu.rs` | Huella, formato de importes, URL del QR, NIF, límite de la simplificada, saneado de texto. Sin BD, red ni reloj; aquí están los tres vectores oficiales de la huella como test |
| Desglose de IVA | `crates/tpv-domain/src/ticket.rs` | `desglose`, `prorratear`. Lo comparten el papel, la vista previa y el registro |
| Puerto | `tpv-application/src/ports/verifactu.rs` | `VerifactuRepository`: el estado de los datos fiscales y las facturas completas de Cuentas |
| Casos de uso | `tpv-application/src/use_cases/verifactu.rs` | `estado`, `emitir_sustitutiva`, `corregir_factura` |
| Emisión y persistencia | `crates/tpv-infra-sqlite/src/verifactu.rs` | `emitir_cobro`, `emitir_alta`, `emitir_anulacion`, `emitir_baja_de_pago`, `emitir_sustitutiva`, `estado_fiscal` |
| Comandos | `apps/tpv-main/src-tauri/src/commands/verifactu.rs` | Estado de los datos fiscales, `F3`, corrección del cliente |
| Identidad del productor | `apps/tpv-main/src-tauri/src/lib.rs` (`PRODUCTOR_*`) | El bloque `SistemaInformatico`, inyectado al arrancar |
| Pantalla | `src/features/configuracion/sections/Negocio.tsx` | NIF y razón social del obligado, con el NIF validado al escribir |
| Factura completa | `src/shared/ticket/DatosFiscalesModal.tsx` + `nif.ts` | Datos del destinatario, con el NIF validado al escribir |
| Aviso | `src/shared/stores/useEstadoFiscal.ts` + `src/shared/ticket/AvisoFiscalModal.tsx` | El aviso de que faltan los datos fiscales |
| Veto en la nube | `apps/cloud-worker-licensing/src/lib/hub.ts` (`TABLAS_SOLO_MAIN`) | Ninguna escritura del worker toca `Registros_Facturacion` ni `Serie_Facturacion` |

---

## Qué es una factura en este TPV

**Un cobro activo es una factura, con su número.** Una comanda pagada en tres veces son tres
facturas, cada una con su registro.

| Clave | Cuándo la emite el código |
|---|---|
| `F2` | El cobro normal: factura simplificada, sin destinatario |
| `F1` | El cobro lleva destinatario: el cliente la pide (casilla «El cliente pide factura con NIF» en mesas, opción equivalente en venta rápida) o el importe pasa del límite de la simplificada |
| `F3` | Desde Cuentas, «emitir factura de este ticket»: factura completa **en sustitución** de una `F2` ya expedida |
| `R5` | Devolución de un cobro (`ClaseBaja::Devolucion`): rectificativa por diferencias (`TipoRectificativa = I`), importe negativo, referencia a la factura original |
| Anulación | Baja de un cobro por error (`ClaseBaja::Error`): registro de anulación |

Lo que **no** es una factura: la precuenta (sin número ni registro), el arqueo de caja (documento
interno) y una apertura de cajón.

### El límite de la simplificada

`Business_Settings.Limite_Simplif` (céntimos, por defecto `300000` = 3.000 €: la hostelería está en
el art. 4.2 del RD 1619/2012). Se mira sobre el **importe del cobro**, no sobre el total de la
comanda: una comanda de 4.000 € que pagan dos empresas a 2.000 € son dos `F2` correctas.

Si el cobro pasa del límite y no trae destinatario, `emitir_cobro` devuelve
`FacturaCompletaRequerida`, la transacción del cobro hace `ROLLBACK` y la pantalla abre
`DatosFiscalesModal` en modo obligatorio. No hay botón para «dividir el cobro»: partir el pago de
un mismo cliente para bajar del límite es fraccionar artificialmente una operación.

### Todo tramo es sujeto

Cada tramo del desglose (`tpv_domain::ticket::TramoIva`, uno por tipo de IVA) se guarda como sujeto
y no exento: `CalificacionOperacion = S1` con su `TipoImpositivo` y su `CuotaRepercutida`. Un
producto al 0 % es eso mismo con tipo y cuota a cero.

No hay tramos exentos. En hostelería la comida y la bebida sólo están exentas cuando las sirven a
sus usuarios el propio hospital, el centro educativo o la entidad de asistencia social
([art. 20.Uno LIVA](https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740)), no un bar.

---

## El registro y su cadena

### La huella

SHA-256 de una cadena UTF-8 `nombre=valor&…` en el orden exacto del diseño de registro de la AEAT,
en hexadecimal y mayúsculas (`TipoHuella = "01"`). Los valores van recortados y un campo ausente se
escribe con su nombre y el `=` (`…&Huella=&…` en el primer registro).

- Alta: `IDEmisorFactura, NumSerieFactura, FechaExpedicionFactura, TipoFactura, CuotaTotal,
  ImporteTotal, Huella (anterior), FechaHoraHusoGenRegistro`.
- Anulación: `IDEmisorFacturaAnulada, NumSerieFacturaAnulada, FechaExpedicionFacturaAnulada,
  Huella (anterior), FechaHoraHusoGenRegistro`.

`FechaOperacion`, el desglose y el bloque `SistemaInformatico` **no** entran en la cadena. El
eslabón anterior es la fila de `MAX(Orden)`.

### Lo que se guarda, y por qué así

- **Los importes son texto.** `ImporteTotal`, `CuotaTotal` y los del desglose se formatean una vez
  (`fmt_importe`, sobre `Dinero`) y se guardan como texto. El papel, la rectificativa y la `F3`
  salen de ese texto: nadie recompone un importe.
- **`Cadena_Huella` se guarda** aunque se pueda recomputar: es lo que hace auditable la cadena sin
  nuestro código.
- **`Orden` es explícito.** El eslabón anterior es la fila de `MAX(Orden)`, no la de `rowid`: el
  orden de reinserción tras una restauración no está garantizado.
- **`Fecha_Hora_Huso` lleva huso** (`chrono::Local`, RFC 3339 con segundos) y se calcula en Rust, como
  un literal más.
- **`Sistema_Json`** congela el bloque `SistemaInformatico` tal como iba: el registro de ayer sigue
  diciendo con qué versión se generó.
- **`QR_Url`** guarda la URL de cotejo, aunque el papel no la imprima. Su base la decide
  `Business_Settings.Verifactu_Entorno`, que en esta rama no se cambia (ni pantalla ni ajuste en
  `config_patch_business_settings`): es siempre la de producción.

### `FechaOperacion`

Se informa sólo si es **distinta** de la de expedición (arts. 6.1.i y 7.1.c del RD 1619/2012); el
filtro está en `emitir_alta`, no en cada llamante. Sale de:

| Caso | Fecha de operación |
|---|---|
| Cobro de una comanda que cruza la medianoche | Apertura de la comanda |
| `R5` | La de la factura original (su `Fecha_Operacion`, o su expedición) |
| `F3` | La del ticket sustituido |

---

## La numeración

| Serie | Formato | Quién numera en ella |
|---|---|---|
| Ejercicio | `2027/000001` | Todos los cobros (`F1`, `F2`) y las `F3` |
| Rectificativas | `R2027/000001` | Las `R1`–`R5` (art. 6.1.a del RD 1619/2012: series específicas «en todo caso») |

La `F3` va en la serie ordinaria porque el art. 15.6 dice que las facturas de canje «no tendrán la
condición de rectificativas». La serie la decide el **tipo de factura** dentro de `emitir_alta`.

`reservar_numero` hace `INSERT OR IGNORE` de la serie y un `UPDATE … Ultimo = Ultimo + 1`
**relativo**, para que la sentencia que sale por el outbox converja. Antes compara el contador con
`MAX(Numero)` ya emitido en esa serie y, si va por detrás (una copia local restaurada), **salta
hacia adelante** con `MAX(Ultimo, ?)`: un hueco se explica, un número repetido no.

**El número del ticket ES el número de la factura.** El camino del cobro reserva el número
(`reservar_numero_factura`) **antes** del `INSERT INTO Pagos`, y `Pagos.Numero_Ticket` guarda ese
mismo valor. `emitir_alta` comprueba que un número reservado sea de la serie que toca y se niega si
no; una rectificativa no puede usar un número reservado.

---

## La emisión

`emitir_cobro` la llaman los tres caminos que cobran (`mesas` por detalles, `mesas` por productos y
`venta_rapida`), **dentro** de su transacción y **después** de enlazar `Pago_Detalles`, entre el
`INSERT INTO Pagos` y el `COMMIT`:

1. Lee y valida los datos del obligado (`datos_obligado`): sin NIF válido o sin razón social,
   `DatosFiscalesIncompletos` y el cobro no se hace.
2. Valida el destinatario si lo hay (`validar_destinatario`: nombre, NIF con dígito de control).
3. Decide la clave (`clave_de_factura`) o devuelve `FacturaCompletaRequerida`.
4. Lee las líneas cobradas de `Pago_Detalles ⋈ Detalle_Comanda`, con sus valores congelados. Si no
   hay líneas o no suman lo cobrado (un cobro parcial), reparte el importe en proporción con
   `ticket::prorratear`, que conserva el peso de cada tipo de IVA y cuadra al céntimo.
5. `emitir_alta`: desglose, importes en texto, eslabón anterior, huella, URL del QR e
   `INSERT INTO Registros_Facturacion`.

Devuelve el `BloqueFiscal` (número, fecha y tipo). El papel no viaja con él: `ticket_de_pago` lee
después el registro por el número del pago (RI-29), así que esos datos no pasan nunca por el cliente.

Si el cobro hace `ROLLBACK`, no queda registro ni se gasta número. Si falla la **impresión**, el
registro ya es correcto y el papel se reimprime.

`Registros_Facturacion` y `Serie_Facturacion` se escriben por `execute()`: son esquema compartido y
tienen que volver de la nube en una recuperación.

### Dar de baja un cobro

`cuentas_anular_pago` (Administrador o camarero) llama, dentro de la transacción de la baja, a
`emitir_baja_de_pago` con la `ClaseBaja` elegida en la pantalla:

- **`Error`** — la venta no existió. Emite un registro de **anulación** de la factura del cobro
  (su última fila), y las líneas vuelven a la comanda.
- **`Devolucion`** — la venta existió. Emite una rectificativa por diferencias con el desglose
  original negado (leído de `Desglose_Json`, no recalculado), referenciando la factura original. Las
  líneas no vuelven. La clave sale de la factura rectificada: una `F2` se rectifica con **`R5`**, sin
  destinatario, y una `F1` con **`R1`** (art. 80.Dos LIVA: la operación queda sin efecto), con el
  cliente de la `F1` (art. 15.5 del RD 1619/2012).

Un cobro cuyo ticket se canjeó tiene **dos altas** con el mismo `ID_Pago`: la `F2` y la `F3`.
`emitir_baja_de_pago` las busca por separado (la `F3` es la que lleva el ticket en
`FacturasSustituidas`):

- **Error**: se anulan **las dos**, la `F3` primero. La anulación deshace la expedición de una
  factura que no respondía a una operación real (FAQ de desarrolladores de la AEAT, apartado
  17.2.d), y la `F3` documenta esa misma operación. La FAQ no trata este caso de forma literal: es
  la aplicación del 17.2.d a las dos facturas.
- **Devolución**: la `R5` rectifica **el ticket**, no la `F3`, y a continuación se emite una `F3`
  negativa «con los mismos datos de R5», con el cliente, que sustituye a la `R5` (apartado 27,
  casos 2 y 3). Así el ticket y la `R5` suman cero para el IVA, y las dos `F3` suman cero para lo
  que el cliente puede deducir.

Fuente: [Aclaraciones a dudas de los desarrolladores, v1.3, 4-12-2025](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf), apartados 17 y 27.
Las claves de las rectificativas: [FAQ Veri*factu de la AEAT, procedimientos de facturación](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/procedimientos-facturacion.html),
[art. 80 LIVA](https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740#a80) y
[art. 15 del RD 1619/2012](https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696#a15). Lo fijan los tests de
`cuentas.rs::tests_baja_de_un_ticket_canjeado`.

Si el pago no tiene registro (un cobro anterior a la numeración), la baja sigue adelante sin emitir
nada. El efecto en la caja de cada clase está en [caja.md](caja.md).

### Devolver parte de un cobro

`cuentas_devolver_lineas` devuelve unas líneas o unas unidades de un cobro ([caja.md](caja.md#devolver-parte-de-un-cobro)).
Dentro de su transacción, `emitir_devolucion_parcial` emite **la misma rectificativa que la
devolución entera, por la parte devuelta**: `R5` si se rectifica un ticket o `R1` con el cliente si
es una `F1`, **por diferencias** (`I`) e importe negativo, rectificando la factura vigente. Una
devolución deja la operación «sin efecto total o parcialmente» (art. 80.Dos LIVA), y la rectificativa
por diferencias recoge sólo lo que cambia. Si el ticket se canjeó, detrás va la `F3` negativa con el
cliente que sustituye a la `R5`, como en la devolución entera. La rectificativa queda ligada a la
devolución (su `ID_Pago` es el del pago negativo, y su número es el `Numero_Ticket` de éste).

- **El desglose sale de las líneas devueltas**, salvo en la devolución que deja el cobro devuelto
  entero: ésa declara **lo que queda de lo declarado** (la factura vigente menos las rectificativas
  de las devoluciones anteriores). Calcular cada parte por su cuenta descuadra el céntimo: tres
  cañas de 3,33 € al 10 % son 9,08 + 0,91 en el ticket y 3 × (3,03 + 0,30) devueltas una a una. Así
  todas juntas suman al céntimo la base y la cuota facturadas.
- **Un ticket con una devolución ya no se canjea por una `F3`, ni una `F1` con una devolución se
  corrige**: «tiene una devolución». Una `R1` siempre es una devolución (corregir el cliente emite
  `R4`).
- **La baja por error del cobro anula sus rectificativas**, de la última a la primera y cada una
  después de su `F3` negativa, antes que la factura que rectifican: si la venta no existió, las
  devoluciones tampoco respondían a nada real (apartado 17.2.d). Es la aplicación de la FAQ a este
  caso, que no trata de forma literal.

Lo fijan los tests de `cuentas.rs::tests_devolucion_parcial`.

### La factura completa de un ticket ya expedido (`F3`)

`verifactu_emitir_factura_de_tickets` (Administrador, desde Cuentas) canjea uno o varios tickets
por una sola `F3`. Cada uno tiene que ser una `F2` sin `F3` vigente (se compara su número exacto) y
no anulada ni devuelta: la `F3` canjea simplificadas «facturadas y declaradas», y a esas no les
queda venta que facturar. Lleva `FacturasSustituidas` con todos y, como desglose, la **suma de los
declarados** por tipo, sin recalcular (`DatosFactura.desglose`): recalcular desde el total puede
mover un céntimo entre base y cuota. Los tickets no se tocan. Con un solo ticket la `F3` comparte su
pago; con varios no cuelga de ninguno y sus cobros la encuentran por `FacturasSustituidas`. Tras
emitirla se abre su papel para imprimir.

Esas comprobaciones están en una función (`canjeable`) que usan la emisión y
`verifactu_facturas_canjeables` (DOC-INC-01): al elegir varios tickets, Cuentas la pide con los
cobros de la página y enseña desactivada, con el motivo («Ya facturado: 2026/000026»), la casilla de
lo que la emisión rechazaría. La emisión rechaza igual.

Canjear varios tickets en una `F3` lo permite la FAQ de desarrolladores (apartado 27, consulta
vinculante V2543-06 de la DGT). Su fecha de operación es la del último ticket: es el criterio de
las facturas recapitulativas ([FAQ del SII 2.31](https://sede.agenciatributaria.gob.es/static_files/Sede/Procedimiento_ayuda/G417/FicherosSuministros/V_1_1/FaqGral/FAQs_SII_30_12_2025.pdf)), porque la FAQ no fija
ninguno para este caso.

### Corregir el cliente de una factura completa

`verifactu_corregir_factura` (Administrador; en Cuentas, el mismo botón de la factura cuando el
cobro ya la tiene) corrige la factura **vigente**:

- **Una `F3`** ([FAQ de desarrolladores](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf), apartado 27, caso 1): no se toca el ticket. Una
  `F3` negativa con los mismos importes, los mismos tickets y el cliente erróneo la contrarresta, y
  una `F3` nueva lleva el cliente bueno. Una `F3` deja de estar vigente cuando la contrarresta otra
  negativa con los mismos tickets y el importe opuesto (`f3_vigente`).
- **Una `F1`** (o la rectificativa que ya la sustituyó): un cliente erróneo incumple el art. 6 del
  RD 1619/2012, y eso obliga a rectificar (art. 15.1). Se emite una **`R4` por sustitución** (`S`)
  con los mismos importes, el cliente bueno e `ImporteRectificacion` con la base y la cuota de la
  sustituida ([FAQ del SII](https://sede.agenciatributaria.gob.es/static_files/Sede/Procedimiento_ayuda/G417/FicherosSuministros/V_1_1/FaqGral/FAQs_SII_30_12_2025.pdf) 2.7 y 2.8, opción 1). La clave `R4` («resto») es una
  deducción: un error material no es un error fundado de derecho ni una causa del art. 80 LIVA,
  que son las de `R1`–`R3`, y ninguna fuente oficial pone este caso como ejemplo. Lo que se
  rectifica o se anula después es siempre la última de la cadena (`cadena_de_sustitutivas`).

`ImporteRectificacion` se guarda dentro de `Referencias_Json` (`importe_rectificacion`), que es lo
que habla de la factura rectificada.

Las bajas siguen la factura vigente: una devolución tras corregir lleva el cliente bueno, y una
baja por error anula la vigente y el original. Dentro de una `F3` de varios tickets, la baja por
error de uno no anula la `F3` (los demás siguen siendo ventas): contrarresta sólo su parte con una
`F3` negativa que lo sustituye. Es la mecánica del caso 1 aplicada a una parte; la FAQ no trata
este caso de forma literal.

### El papel de una factura completa y de una rectificativa

Una `F1` o una `F3` sale titulada **FACTURA** y con su cliente: nombre, NIF y domicilio, leídos de
`Destinatario_Json`. El destinatario no entra en la huella. Una `F3` dice además qué factura
sustituye.

Las facturas de una devolución también tienen papel: son facturas expedidas, que se entregan al
destinatario ([art. 17 del RD 1619/2012](https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696#a17)).
La rectificativa sale titulada **FACTURA RECTIFICATIVA** con la referencia de la factura que
rectifica y su fecha (arts. 7.1.h y 15.4 del RD 1619/2012), las líneas del cobro en negativo y, si es
una `R1`, el cliente. La de una devolución parcial lleva sólo las líneas devueltas. Tras confirmar
una devolución, Cuentas abre el modal de impresión con ella elegida, sin imprimirla: se entrega si el
cliente la quiere.

Una reimpresión saca el mismo número, fecha y desglose, leídos del registro (`ticket_de_pago`,
RI-29), marcada COPIA. El orden completo del ticket está en [tickets.md](tickets.md).

### Los datos fiscales en la ficha del cliente

`Clientes.NIF`, `Razon_Social` y `Direccion_Fiscal` son los datos para facturarle a un cliente. Son
opcionales y se editan en su ficha (Clientes → Editar), en la Main y en la Handy. Se guardan como el
destinatario de una factura (`DatosFiscales::validar`, que usa `normalizar_nif`, `nif_valido` y
`sanear_texto`): el NIF sin blancos, guiones ni minúsculas y con su control comprobado, y la razón
social y la dirección saneadas y recortadas a 120 y 250 caracteres. El worker hace lo mismo
(`lib/fiscal.ts`), con los casos en `validacion_casos.json` y `nif_casos.json`. La ficha enseña
sus datos de facturación si los tiene.

En el worker, una clave que no viene en el cuerpo (`POST`/`PUT /v1/clientes`) no es lo mismo que una
que viene vacía: la columna de la que no viene no se toca. La Handy de la versión anterior no conoce
estos campos y no los manda, y convive con el worker nuevo, que se despliega antes; sin esto, al
editar el teléfono de una ficha le borraría los datos fiscales. La de ahora manda siempre los tres,
`null` si están vacíos. Lo prueba `guardasEnElLote.test.ts` (FISCAL-02).

El formulario de la factura completa (`DatosFiscalesModal`, en el cobro de la mesa, en la venta
rápida y en Cuentas) los usa en la Main:

- **Elegir cliente** busca las fichas por nombre, razón social o NIF y rellena los tres campos. Sobre
  lo escrito a mano, lo que la ficha no tiene se deja como estaba; si antes se había elegido otra
  ficha, se sustituye todo y lo que la nueva no tiene se vacía, para no facturar con el nombre de una
  y el NIF de otra (`rellenoConFicha`). **No es esta ficha** deja de elegirla y se lleva lo que ella
  puso: vuelve lo que había escrito antes de elegirla, y lo escrito después se queda
  (`camposSinLaFicha`). Así, decir que no es la ficha de la reserva y elegir otra sin NIF ni
  domicilio no factura con el NIF y el domicilio de la primera.
- Un NIF que es el de una ficha ofrece «Es <cliente>: rellenar con sus datos», y el nombre que se
  teclea sugiere las fichas que casan.
- Si el cliente de la comanda que se cobra (el suyo o el de su reserva) tiene ficha con NIF, el
  formulario empieza con sus datos.
- La casilla **Guardar en la ficha del cliente** sale siempre marcada; quien cobra la desmarca si no
  quiere guardar. Lo que se guarda va a la ficha elegida o a la que tiene ese NIF; si no hay
  ninguna, se da de alta una con la razón social de nombre. La elegida deja de serlo si el NIF con
  el que se factura es el de otra ficha (va a ésa) o distinto del que ya tenía (va a una nueva): la
  comida de empresa que reservó una persona no le cambia el NIF a su ficha (`fichaDestino`). La
  casilla lo dice.
- Con la casilla marcada, **el gasto de lo facturado pasa a esa ficha** (FISCAL-03): quien pide la
  factura es quien paga, aunque la mesa fuera de la reserva de otro. La comanda de cada cobro
  facturado queda a nombre de la ficha, y el gasto de ésta y el de quien lo tuviera antes se
  re-derivan de los cobros (`apuntar_gasto`, con la misma suma que la reconciliación). Lo hacen el
  cobro con factura de la mesa y de la venta rápida y la F3 y la corrección de Cuentas, que devuelven
  sus cobros a `trasFacturar` (`Facturado`). Se pasa la comanda entera: si una parte se cobró antes
  sin factura, también cuenta para la ficha.

El guardado va **después** de que el cobro o la emisión hayan entrado (`trasFacturar`), nunca dentro
ni antes, y si falla sólo se avisa: no impide ni deshace el cobro. Quien cobra puede no tener
`clientes.gestionar`, así que la lectura de las fichas y el guardado tienen sus propios comandos
(`clientes_para_factura`, `clientes_guardar_datos_fiscales`) con el permiso del cobro,
`servicio.vender`. Sólo existen en la Main: en la Handy, que no cobra, el formulario no ofrece nada de
esto. Lo que escriben pasa por el `WriteGuard` y se replica como cualquier edición de la ficha.

---

## Los datos del obligado y del productor

- **Obligado** (el bar): `Business_Settings.CIF`, `Razon_Social` (no es `Business_Name`: el rótulo
  frente a quien factura) y `Descripcion_Op` (texto fijo, por defecto «Servicios de hosteleria y
  restauracion», hasta 500 caracteres). Sin NIF válido o sin razón social no se cobra.
  `config_patch_business_settings` exige Administrador, así que el aviso de que faltan sale después
  del login (`AvisoFiscalMontado`) y lleva a Configuración → Negocio. `useEstadoFiscal` lo pregunta
  al entrar y cada dos minutos, sólo en la Main, y arranca con `datosFiscalesCompletos = true` para
  no sacar el aviso antes de la primera respuesta.
- **Productor** (quien hace el TPV): las constantes `PRODUCTOR_NOMBRE_RAZON`, `PRODUCTOR_NIF`,
  `PRODUCTOR_NOMBRE_SISTEMA` y `PRODUCTOR_ID_SISTEMA` de `lib.rs`, más la versión de
  `tauri.conf.json` y el `tenant_id` como `NumeroInstalacion`. Se inyectan en `setup()`; la
  activación de la licencia actualiza el número de instalación sin reiniciar
  (`set_numero_instalacion`). `PRODUCTOR_NIF` está vacío: el bloque no entra en la huella, así que
  rellenarlo después no cambia ninguna huella ya calculada.

## Tras restaurar

`Registros_Facturacion` se replica y vuelve con la recuperación. El cerrojo de escrituras de negocio
de la recuperación impide emitir mientras tanto, igual que impide vender. La fase 1 del volcado trae
`Registros_Facturacion` de la ventana más **siempre la última fila por `Orden`**, que es el eslabón
del que sigue la cadena; el resto llega en la fase 2.

## La Handy

No cobra (`cobro_solo_en_main`), así que no emite registros. El worker veta además cualquier
escritura a `Registros_Facturacion` y `Serie_Facturacion` (`lib/hub.ts`, `TABLAS_SOLO_MAIN`;
`test/fiscalSoloMain.test.ts`): el número correlativo y la cadena tienen un único escritor.

La Handy no pregunta el estado fiscal ni saca el aviso de los datos que faltan: `useEstadoFiscal`
y `AvisoFiscalMontado` miran el modo del equipo (un escritorio también puede ser una Handy). Si
aun así se pide algo que sólo existe en la Main —los registros de facturación, el ticket de un
cobro—, Rust contesta `conflict` con «…sólo … en el TPV principal»
(`AppState::base_de_la_main`), que es una respuesta esperada y no va a Sentry.

---

## Lo que no hay en esta rama

Todo esto está en `con-verifactu` y vuelve con ella:

- La remisión a la AEAT: el crate `tpv-infra-aeat` (XML, TLS mutuo con WinHTTP, esquemas oficiales),
  el job `verifactu_remitir`, su interruptor remoto y la cola `_Verifactu_Envios`.
- El certificado, el entorno de pruebas o producción y el botón de probar la conexión.
- El QR tributario y la leyenda «VERI\*FACTU» en el papel y en la vista previa.
- La subsanación de los rechazados y la reparación del bloque `SistemaInformatico`.
- La escalera de avisos por atraso, el aviso del certificado y las anomalías de la comprobación
  previa del art. 7.i) de la Orden HAC/1177/2024.
- La exportación de los registros (art. 8 RRSIF) y la declaración responsable (art. 13 RRSIF).
- El modo prueba.

## Fuera de alcance

- **TicketBAI** (País Vasco y Navarra) e **IGIC/IPSI** (Canarias, Ceuta y Melilla).
- La **lotería**: es un suplido, no un producto exento, y no entra en el registro
  ([FAQ de desarrolladores de la AEAT](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf),
  pregunta 22).
- Las **operaciones exentas**: ver *Todo tramo es sujeto*.
- **Varios obligados por instalación** y **varias cajas por negocio**: la cadena asume una única
  Main.

## Fuentes

- RD 1619/2012 (reglamento de facturación): arts. 4.2 (límite de 3.000 €), 6.1.a (serie de
  rectificativas), 6.1.i y 7.1.c (fecha de operación), 15.6 (canje de simplificadas).
  <https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696>
- RD 1007/2023 (RRSIF), art. 7. <https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840>
- AEAT, especificaciones de la huella v0.1.2 y del QR v0.5.0, y FAQ de desarrolladores, en
  <https://www.agenciatributaria.es/AEAT_Desarrolladores/>.

> Esto es documentación de ingeniería, no asesoramiento fiscal. Las decisiones con consecuencia
> tributaria conviene contrastarlas con un asesor antes de lanzar.
