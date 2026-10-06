# Veri\*factu: el registro de facturación

Cada cobro expide una **factura** y produce un **registro de facturación** encadenado que se remite a
la AEAT. Es la obligación del RD 1007/2023 (RRSIF) y de la Orden HAC/1177/2024, exigible desde el
**1 de enero de 2027** a los contribuyentes del Impuesto sobre Sociedades y desde el 1 de julio de
2027 al resto.

El TPV opera en modalidad **VERI\*FACTU** y sólo en ella (`TipoUsoPosibleSoloVerifactu = "S"`):
remite todos los registros. Por eso no firma los registros (la firma XAdES es de la modalidad no
verificable) ni lleva registro de eventos (la NOTA 1 del apartado 15 del FAQ de desarrolladores de
la AEAT exime a los sistemas «solo VERI\*FACTU»). La integridad la da la cadena de huellas.

El principio que ordena todo: **el registro es el hecho fiscal**; el papel es una copia suya y el
envío a la AEAT, una consecuencia diferida. De ahí salen las tres reglas que no se negocian:

1. El registro se crea **en la misma transacción que el cobro**.
2. **No se modifica**: `Registros_Facturacion` es *append-only* y no se purga nunca (art. 7 RRSIF).
3. **Nada de lo que rodea al envío puede impedir cobrar.**

Cómo probarlo contra la AEAT: [docs/PRUEBAS_AEAT.md](../PRUEBAS_AEAT.md). Lo que falta para producción:
[docs/pendientes.md](../pendientes.md#verifactu).

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Aritmética fiscal | `crates/tpv-domain/src/verifactu.rs` | Huella, formato de importes, URL del QR, NIF, límite de la simplificada, comprobación del art. 7.i), saneado de texto. Sin BD, red ni reloj; aquí están los tres vectores oficiales de la huella como test |
| Desglose de IVA | `crates/tpv-domain/src/ticket.rs` | `desglose`, `prorratear`. Lo comparten el papel, la vista previa y el registro |
| Puertos | `tpv-application/src/ports/{verifactu,aeat}.rs` | `VerifactuRepository` y `AeatClient` (los cuatro endpoints, la cabecera, la respuesta) |
| Casos de uso | `tpv-application/src/use_cases/verifactu.rs` | `clasificar`, `puede_enviar`, `remitir_ciclo`, los tres avisos y el estado del certificado |
| Emisión y persistencia | `crates/tpv-infra-sqlite/src/verifactu.rs` | `emitir_cobro`, `emitir_alta`, `emitir_anulacion`, `emitir_baja_de_pago`, `emitir_sustitutiva`, `subsanar_rechazados`, `resembrar_cola_de_envio`, `estado_fiscal` |
| Exportación | `crates/tpv-infra-sqlite/src/verifactu_export.rs` | El ZIP del art. 8 RRSIF |
| Adaptador AEAT | `crates/tpv-infra-aeat/` | `xml.rs` (sobre SOAP y respuesta), `certificados.rs` (almacén de Windows), `transporte.rs` (WinHTTP con TLS mutuo), `esquemas/` (XSD, WSDL y `errores.properties` oficiales) |
| Job de remisión | `apps/tpv-main/src-tauri/src/jobs/registro.rs::verifactu_remitir` | Cada 60 s, `MainOperativa` |
| Comandos | `apps/tpv-main/src-tauri/src/commands/verifactu.rs` | Estado, listado, certificado, prueba de conexión, `F3`, subsanación, exportación, declaración responsable, modo prueba |
| Identidad del productor | `apps/tpv-main/src-tauri/src/lib.rs` (`PRODUCTOR_*`) | El bloque `SistemaInformatico`, inyectado al arrancar |
| QR en el papel | `apps/tpv-main/src-tauri/src/printing.rs` | `rasterizar_qr`, `lado_qr_dots` |
| Pantalla | `src/features/configuracion/sections/Fiscal.tsx` | Obligado, envío, entorno, modo prueba, certificado, exportación, declaración |
| Factura completa | `src/shared/ticket/DatosFiscalesModal.tsx` + `nif.ts` | Datos del destinatario, con el NIF validado al escribir |
| Escalera de avisos | `src/shared/stores/useEstadoFiscal.ts` + `src/shared/ticket/AvisoFiscalModal.tsx` | Los avisos de login y tras cobro |
| Veto en la nube | `apps/cloud-worker-licensing/src/lib/hub.ts` (`TABLAS_SOLO_MAIN`) | Ninguna escritura del worker toca `Registros_Facturacion` ni `Serie_Facturacion` |

---

## Qué es una factura en este TPV

**Un cobro activo es una factura, con su número.** Una comanda pagada en tres veces son tres
facturas, cada una con su registro y su QR.

| Clave | Cuándo la emite el código |
|---|---|
| `F2` | El cobro normal: factura simplificada, sin destinatario |
| `F1` | El cobro lleva destinatario: el cliente la pide (casilla «El cliente pide factura con NIF» en mesas, opción equivalente en venta rápida) o el importe pasa del límite de la simplificada |
| `F3` | Desde Cuentas, «emitir factura de este ticket»: factura completa **en sustitución** de una `F2` ya expedida |
| `R5` | Devolución de un cobro (`ClaseBaja::Devolucion`): rectificativa por diferencias (`TipoRectificativa = I`), importe negativo, referencia a la factura original |
| Anulación | Baja de un cobro por error (`ClaseBaja::Error`): registro de anulación del art. 11.1 RRSIF |

Lo que **no** es una factura: la precuenta (sin número, sin registro, sin QR), el arqueo de caja
(documento interno) y una apertura de cajón.

### El límite de la simplificada

`Business_Settings.Limite_Simplif` (céntimos, por defecto `300000` = 3.000 €: la hostelería está en
el art. 4.2 del RD 1619/2012). Se mira sobre el **importe del cobro**, no sobre el total de la
comanda: una comanda de 4.000 € que pagan dos empresas a 2.000 € son dos `F2` correctas.

Si el cobro pasa del límite y no trae destinatario, `emitir_cobro` devuelve
`FacturaCompletaRequerida`, la transacción del cobro hace `ROLLBACK` y la pantalla abre
`DatosFiscalesModal` en modo obligatorio. No hay botón para «dividir el cobro»: partir el pago de
un mismo cliente para bajar del límite es fraccionar artificialmente una operación.

### Todo tramo es sujeto

Cada tramo del desglose (`tpv_domain::ticket::TramoIva`, uno por tipo de IVA) va como sujeto y no
exento: `CalificacionOperacion = S1` con su `TipoImpositivo` y su `CuotaRepercutida`. Un producto al
0 % es eso mismo con tipo y cuota a cero, que también se informan (error 1208).

No hay tramos exentos (`OperacionExenta`). En hostelería la comida y la bebida sólo están exentas
cuando las sirven a sus usuarios el propio hospital, el centro educativo o la entidad de asistencia
social ([art. 20.Uno LIVA](https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740)), no un bar; y la
lotería va fuera del registro (ver *Fuera de alcance*).

---

## El registro y su cadena

### La huella

SHA-256 de una cadena UTF-8 `nombre=valor&…` en el orden exacto del diseño de registro, en
hexadecimal y mayúsculas (`TipoHuella = "01"`). Los valores van recortados y un campo ausente se
escribe con su nombre y el `=` (`…&Huella=&…` en el primer registro).

- Alta: `IDEmisorFactura, NumSerieFactura, FechaExpedicionFactura, TipoFactura, CuotaTotal,
  ImporteTotal, Huella (anterior), FechaHoraHusoGenRegistro`.
- Anulación: `IDEmisorFacturaAnulada, NumSerieFacturaAnulada, FechaExpedicionFacturaAnulada,
  Huella (anterior), FechaHoraHusoGenRegistro`.

`FechaOperacion`, el desglose y el bloque `SistemaInformatico` **no** entran en la cadena.

### Lo que se guarda, y por qué así

- **Los importes son texto.** `ImporteTotal`, `CuotaTotal` y los del desglose se formatean una vez
  (`fmt_importe`, sobre `Dinero`) y se guardan como texto. El XML, el QR, la exportación, la
  rectificativa, la `F3` y la subsanación salen de ese texto: nadie recompone un importe.
- **`Cadena_Huella` se guarda** aunque se pueda recomputar: es lo que hace auditable la exportación
  sin nuestro código.
- **`Orden` es explícito.** El eslabón anterior es la fila de `MAX(Orden)`, no la de `rowid`: el
  orden de reinserción tras una restauración no está garantizado.
- **`Fecha_Hora_Huso` lleva huso** (`chrono::Local`, RFC 3339 con segundos) y se calcula en Rust, como
  un literal más.
- **`Sistema_Json`** congela el bloque `SistemaInformatico` tal como iba: el registro de ayer sigue
  diciendo con qué versión se generó.
- **`QR_Url`** guarda la URL exacta del papel: una reimpresión saca la misma.

### `FechaOperacion`

Se informa sólo si es **distinta** de la de expedición (arts. 6.1.i y 7.1.c del RD 1619/2012); el
filtro está en `emitir_alta`, no en cada llamante. Sale de:

| Caso | Fecha de operación |
|---|---|
| Cobro de una comanda que cruza la medianoche | Apertura de la comanda |
| `R5` | La de la factura original (su `Fecha_Operacion`, o su expedición) |
| `F3` | La del ticket sustituido |

### La comprobación previa del art. 7.i)

Antes de generar cada alta o anulación, `estado_de_la_cadena` lee las **dos** últimas filas (la
misma consulta que da el eslabón anterior) y `comprobar_registro_previo` mira dos cosas: que el
último registro esté bien encadenado con el suyo y que no esté fechado más de 60 s **por delante**
del reloj actual (un reloj que ha ido hacia atrás).

**Nunca impide facturar** (el FAQ de la AEAT: «la facturación por este motivo NUNCA debe
interrumpirse»). Lo detectado se anota en `_Verifactu_Anomalias` (local, por `raw()`, best-effort),
se registra como error en el log, sale lo primero en Configuración → Fiscal y genera una
notificación al Administrador. «Reconocer» las marca como vistas sin borrarlas.

---

## La numeración

| Serie | Formato | Quién numera en ella |
|---|---|---|
| Ejercicio | `2027/000001` | Todos los cobros (`F1`, `F2`) y las `F3` |
| Rectificativas | `R2027/000001` | Las `R1`–`R5` (art. 6.1.a del RD 1619/2012: series específicas «en todo caso») |
| Modo prueba | `PRUEBA/000001` | Los cobros con el modo prueba activado (temporal, ver abajo) |

La `F3` va en la serie ordinaria porque el art. 15.6 dice que las facturas de canje «no tendrán la
condición de rectificativas». La serie la decide el **tipo de factura** dentro de `emitir_alta`.

`reservar_numero` hace `INSERT OR IGNORE` de la serie y un `UPDATE … Ultimo = Ultimo + 1`
**relativo**, para que la sentencia que sale por el outbox converja. Antes compara el contador con
`MAX(Numero)` ya emitido en esa serie y, si va por detrás (una copia local restaurada), **salta
hacia adelante** con `MAX(Ultimo, ?)`: un hueco se explica, un número repetido es un registro que
la AEAT rechaza.

**El número del ticket ES el número de la factura.** El camino del cobro reserva el número
(`reservar_numero_factura`, que elige la serie con `serie_del_cobro`) **antes** del `INSERT INTO
Pagos`, y `Pagos.Numero_Ticket` guarda ese mismo valor. `emitir_alta` comprueba que un número
reservado sea de la serie que toca y se niega si no; una rectificativa no puede usar un número
reservado.

---

## La emisión

`emitir_cobro` la llaman los tres caminos que cobran (`mesas` por detalles, `mesas` por productos y
`venta_rapida`), **dentro** de su transacción y **después** de enlazar `Pago_Detalles`, entre el
`INSERT INTO Pagos` y el `COMMIT`:

1. Si el número es de la serie `PRUEBA`, no emite nada (modo prueba).
2. Lee y valida los datos del obligado (`datos_obligado`): sin NIF válido o sin razón social,
   `DatosFiscalesIncompletos` y el cobro no se hace.
3. Valida el destinatario si lo hay (`validar_destinatario`: nombre, NIF con dígito de control).
4. Decide la clave (`clave_de_factura`) o devuelve `FacturaCompletaRequerida`.
5. Lee las líneas cobradas de `Pago_Detalles ⋈ Detalle_Comanda`, con sus valores congelados. Si no
   hay líneas o no suman lo cobrado (un cobro parcial), reparte el importe en proporción con
   `ticket::prorratear`, que conserva el peso de cada tipo de IVA y cuadra al céntimo.
6. `emitir_alta`: desglose, importes en texto, eslabón anterior y comprobación del art. 7.i),
   huella, URL del QR, `INSERT INTO Registros_Facturacion`, `_Verifactu_Envios` en `PENDIENTE` (por
   `raw()`), y la anomalía si la hubo.

Devuelve el `BloqueFiscal` (número, fecha, URL del QR, huella, tipo y si es entorno de pruebas) al
camino del cobro. El papel no viaja con él: `ticket_de_pago` lee después el registro por el número
del pago (RI-29), así que esos datos no pasan nunca por el cliente.

Si el cobro hace `ROLLBACK`, no queda registro ni se gasta número. Si falla la **impresión**, el
registro ya es correcto y el papel se reimprime.

`Registros_Facturacion` y `Serie_Facturacion` se escriben por `execute()`: son esquema compartido y
tienen que volver de la nube en una recuperación. Las tablas `_Verifactu_*` van por `raw()`: son
estado local y por `execute()` cada tick del job se replicaría.

### Dar de baja un cobro

`cuentas_anular_pago` (Administrador o camarero) llama, dentro de la transacción de la baja, a
`emitir_baja_de_pago` con la `ClaseBaja` elegida en la pantalla:

- **`Error`** — la venta no existió. Emite un registro de **anulación** de la factura del cobro
  (su última fila, por si se subsanó), y las líneas vuelven a la comanda.
- **`Devolucion`** — la venta existió. Emite una rectificativa por diferencias con el desglose
  original negado (leído de `Desglose_Json`, no recalculado), referenciando la factura original. Las
  líneas no vuelven. La clave sale de la factura rectificada: una `F2` se rectifica con **`R5`**, sin
  destinatario (error 1190), y una `F1` con **`R1`** (art. 80.Dos LIVA: la operación queda sin
  efecto), con el cliente de la `F1` (art. 15.5 del RD 1619/2012; error 1189 si falta).

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

Si el pago no tiene registro (un cobro de modo prueba), la baja sigue
adelante sin emitir nada. El efecto en la caja de cada clase está en [caja.md](caja.md).

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
- Un cobro de modo prueba se devuelve sin emitir nada.

Lo fijan los tests de `cuentas.rs::tests_devolucion_parcial`, y la AEAT acepta todos estos registros en
preproducción (`pnpm verifactu:devoluciones`, [PRUEBAS_AEAT.md](../PRUEBAS_AEAT.md#devoluciones-canjes-y-correcciones)).

### La factura completa de un ticket ya expedido (`F3`)

`verifactu_emitir_factura_de_tickets` (Administrador, desde Cuentas) canjea uno o varios tickets
por una sola `F3`. Cada uno tiene que ser una `F2` sin `F3` vigente (se compara su número exacto) y
no anulada ni devuelta: la `F3` canjea simplificadas «facturadas y declaradas», y a esas no les
queda venta que facturar. Lleva `FacturasSustituidas` con todos y, como desglose, la **suma de los
declarados** por tipo, sin recalcular (`DatosFactura.desglose`): recalcular desde el total puede
mover un céntimo entre base y cuota. Los tickets no se tocan. Con un solo ticket la `F3` comparte su
pago; con varios no cuelga de ninguno y sus cobros la encuentran por `FacturasSustituidas`. Tras
emitirla se abre su papel para imprimir.

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
que habla de la factura rectificada; el XML lo escribe entre `FacturasSustituidas` y
`FechaOperacion`, su sitio en el XSD, y la subsanación lo copia.

Las bajas siguen la factura vigente: una devolución tras corregir lleva el cliente bueno, y una
baja por error anula la vigente y el original. Dentro de una `F3` de varios tickets, la baja por
error de uno no anula la `F3` (los demás siguen siendo ventas): contrarresta sólo su parte con una
`F3` negativa que lo sustituye. Es la mecánica del caso 1 aplicada a una parte; la FAQ no trata
este caso de forma literal.

### El papel de una factura completa y de una rectificativa

Una `F1` o una `F3` sale titulada **FACTURA** y con su cliente: nombre, NIF y domicilio, leídos de
`Destinatario_Json`. El domicilio se guarda ahí sólo para el papel: el adaptador de la AEAT lee
`NombreRazon` y `NIF` y nada más (`xml.rs::el_domicilio_del_cliente_no_va_al_xml`), y el
destinatario no entra en la huella. Una `F3` dice además qué factura sustituye.

Las facturas de una devolución también tienen papel: son facturas expedidas, que se entregan al
destinatario ([art. 17 del RD 1619/2012](https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696#a17))
y que impresas llevan su QR ([art. 20 de la Orden HAC/1177/2024](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138#a2-2)).
La rectificativa sale titulada **FACTURA RECTIFICATIVA** con la referencia de la factura que
rectifica y su fecha (arts. 7.1.h y 15.4 del RD 1619/2012), las líneas del cobro en negativo y, si es
una `R1`, el cliente. La de una devolución parcial lleva sólo las líneas devueltas. Tras confirmar
una devolución, Cuentas abre el modal de impresión con ella elegida, sin imprimirla: se entrega si el
cliente la quiere.

El esquema tiene `Clientes.NIF`, `Razon_Social` y `Direccion_Fiscal`, pero hoy ningún camino los lee
ni los escribe: el formulario de datos fiscales siempre empieza vacío.

---

## El QR y el papel

- URL: `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=…&numserie=…&fecha=…&importe=…`
  (`prewww2.aeat.es` en pruebas), con los valores codificados en UTF-8 (`url_qr`). Se compone al
  emitir y se guarda; el papel la lee de la fila.
- Código ISO/IEC 18004 con corrección **M**, de **30 a 40 mm** de lado según el papel, con 2 mm de
  zona de silencio, rasterizado por el mismo camino que el logo (`GS v 0`), no con `GS ( k`.
- Va lo primero, centrado, precedido de «QR tributario:» y seguido de «VERI\*FACTU». En pruebas
  añade «-- ENTORNO DE PRUEBAS --».
- Si la URL no cabe en un QR o el papel no da para un módulo, el ticket sale sin código: nada de lo
  que rodea al ticket puede impedir cobrar.
- Una reimpresión saca el mismo número, fecha, QR y desglose, leídos del registro
  (`ticket_de_pago`, RI-29), marcada COPIA.

El orden completo del ticket está en [tickets.md](tickets.md).

---

## La remisión

`verifactu_remitir` es un job del runner ([jobs-e-interruptores.md](jobs-e-interruptores.md)): cada
60 s, primer intento al minuto del arranque, `Requiere::MainOperativa`. Remitir no puede ser una
llamada dentro del cobro porque el art. 16.2 de la Orden impone un control de flujo entre envíos.

⚠️ **El job no depende de `connectivity: "off"`.** Ese ajuste apaga el WebSocket de nuestra nube;
remitir a la AEAT es una obligación tributaria. Cumplir la regla consiste en no añadir esa
comprobación al job. El interruptor remoto `verifactu_remitir` sí lo pausa, pero lo decide soporte,
caduca a las 24 h como mucho y se ve en Configuración → Fiscal.

Cada vuelta, en este orden:

1. Con el modo prueba activado, no hace nada.
2. Sin identidad del productor (`productor_configurado`: `PRODUCTOR_NIF` con dígito de control
   válido), no remite: un registro mandado con `"NIF":""` lo rechazaría la AEAT por formato y la
   fila no se recompone. Lo dice una vez por arranque en el log y evalúa el aviso de atraso.
3. Evalúa el aviso del certificado y el de anomalías.
4. Si el certificado elegido ya no está o caducó, no lo intenta. Si pide PIN, sí.
5. `asegurar_sistema_reparado`: si el bloque `SistemaInformatico` ha cambiado desde la última vez
   (arranque, activación con `tenant_id`), rellena con `json_set` el `NIF`/`NombreRazon` o el
   `NumeroInstalacion` que falten en registros que la AEAT no tiene aceptados. Si falla, no remite.
   Es la única escritura sobre registros ya emitidos, y es legítima porque ese bloque no entra en la
   huella ni en los datos de la factura.
6. `remitir_ciclo`:
   - Sin pendientes, sin datos del obligado o sin certificado, no envía (no es un error del job).
   - `puede_enviar`: han pasado los `Espera_Segundos` desde el último envío **o** hay al menos 1000
     pendientes. Un reloj que retrocede cuenta como «ya ha pasado».
   - Hasta 1000 `PENDIENTE` por `Orden` ascendente.
   - `Incidencia = "S"` en la cabecera si hay más de 1000 pendientes o el último envío fue hace más
     de una hora.
   - Endpoint según entorno y tipo de certificado (persona → `www1`/`prewww1`; sello →
     `www10`/`prewww10`).
   - Guarda el `TiempoEsperaEnvio` devuelto (acotado a 1–3600 s) **antes** de procesar las líneas.
   - Casa cada línea por **tipo y número** (un alta y su anulación comparten número). El tipo sale
     de `Operacion/TipoOperacion`: el `IDFactura` de la respuesta lleva `NumSerieFactura` también en
     una anulación. Una línea que no aparece en la respuesta, o que no dice su tipo, se queda
     `PENDIENTE` con un intento más; también si dos líneas, o dos registros del lote, comparten
     tipo y número, porque no se sabe cuál es de cuál.
   - Los resultados del lote se anotan en una sola transacción, y los intentos en una sola sentencia.
   - Un fallo de transporte o un *Fault* anota un intento a todo el lote, que sigue `PENDIENTE`, y
     devuelve `Err` (backoff del runner).
7. Evalúa el aviso de atraso y emite `verifactu:cambio` para que la pantalla se refresque.

### Qué significa cada respuesta (`clasificar`)

| La AEAT dice | Estado | Qué pasa después |
|---|---|---|
| `Correcto` | `ACEPTADO` | Se guarda el CSV del envío |
| `AceptadoConErrores`, o un código 2000–2999 | `ACEPTADO_CON_ERRORES` | Está en la AEAT; se guarda el CSV; hay que subsanarlo salvo el `2004` |
| `Incorrecto` con `3000` (duplicado) | `ACEPTADO` | Es la idempotencia del sistema: reenviar lo que la AEAT ya tiene converge |
| `Incorrecto` con otro código | `RECHAZADO` | No se reintenta solo |
| Un estado desconocido | `PENDIENTE` | Se reintenta: no se da por bueno nada que no se entiende |

Se clasifica **por rango**, no por lista: el catálogo de la AEAT crece.

### Subsanación

`pendientes()` sólo coge `PENDIENTE`, así que un rechazo se queda quieto hasta que alguien pulsa
«Volver a mandarlas corregidas» (`verifactu_subsanar_rechazados`, Administrador). Por cada rechazado
sin subsanación previa, `subsanar_rechazados` emite un alta nueva con:

- el **mismo `IDFactura`** (serie, número y fecha), sin gastar número;
- `Subsanacion = "S"` y `RechazoPrevio = "X"`;
- los mismos datos fiscales del original, reconstruidos de su fila;
- su propio `Orden`, huella y hora, encadenada al final.

El índice único de la terna (`ux_regfact_idfactura`) excluye las subsanaciones para que la segunda
entre. Es manual a propósito: un rechazo casi siempre es un fallo del programa que arregla una
versión nueva, y reintentarlo solo repetiría el rechazo cada minuto. Hoy sólo se subsanan
rechazados; `marcas_de_subsanacion` ya sabe las marcas de un aceptado con errores (`S` sin
`RechazoPrevio`), pero ningún botón lo dispara. La columna `Sin_Registro_Previo` existe y viaja al
XML, pero ningún camino la rellena.

---

## El certificado

- **Lo usa Windows, no el programa.** El TLS mutuo va por **WinHTTP** (schannel), al que se le pasa
  el `CERT_CONTEXT` del almacén. La clave privada no sale nunca del almacén, no hay `.p12` que leer
  ni contraseña que guardar. Sirve un certificado con clave en un KSP de CNG, en un **CSP heredado**
  (como queda un `.p12` importado con doble clic) o en una tarjeta. `rustls-cng` no valdría: habla
  NCrypt, que no ve los CSP heredados.
- **Se guarda sólo la huella**, en `device_config.json` (`verifactu_cert`). No es un secreto. Al
  elegirlo se comprueba que exista en el almacén.
- **Dos almacenes**: `CurrentUser\My` y `LocalMachine\My`. Sólo aparecen certificados con clave
  privada, y la lista dice en qué almacén está cada uno (el personal es por usuario de Windows).
- El tipo (persona o **sello de entidad**, detectado por OID de política o por el sujeto) sólo
  decide el endpoint. La interfaz no habla del sello.
- **Uso silencioso**: un certificado que pide PIN o contraseña no puede remitir solo. La pantalla lo
  marca; el estado da `certificado_pide_pin`. El indicador no es infalible (lectores con *pinpad*).
- **«Probar»** (`verifactu_probar_conexion`) hace un *handshake* real contra el entorno configurado
  mandando un sobre **sin registros**. Con los datos del obligado configurados, la cabecera los
  lleva y la prueba comprueba también que el titular esté autorizado sobre ese NIF.
- El estado del certificado lo completa el shell (`completar_con_el_certificado`): el almacén no está
  en la base. Da `sin_certificado`, `certificado_no_encontrado`, `certificado_caducado` o
  `certificado_pide_pin` como `motivo_no_remite`, sin pisar un motivo que ya viniera de la capa de
  datos.
- **Aviso de caducidad** a 30 días (aviso) y a 7 (error), aparte del aviso de atraso, que llega
  tarde por definición.

## El entorno

`Business_Settings.Verifactu_Entorno` (`produccion` | `pruebas`) cambia **a la vez** el endpoint y
la base del QR. Cualquier valor que no sea exactamente `pruebas` se trata como producción. En pruebas
el panel lo dice en amarillo, el QR apunta a `prewww2.aeat.es` y el papel lleva el aviso. Pasar a
producción con registros ya emitidos muestra un aviso en rojo: los emitidos contra preproducción
ocupan la cadena local y Hacienda no los tiene (cómo partir de cero: [PRUEBAS_AEAT.md](../PRUEBAS_AEAT.md)).

## Los datos del obligado y del productor

- **Obligado** (el bar): `Business_Settings.CIF`, `Razon_Social` (no es `Business_Name`: el rótulo
  frente a quien factura) y `Descripcion_Op` (texto fijo, por defecto «Servicios de hosteleria y
  restauracion», hasta 500 caracteres). Sin NIF válido o sin razón social no se cobra.
  `config_patch_business_settings` exige Administrador, así que el aviso de que faltan sale después
  del login y lleva a Configuración → Fiscal. El NIF sigue siendo editable con registros emitidos;
  la pantalla sólo avisa de que cambiarlo empieza otra cadena.
- **Productor** (quien hace el TPV): las constantes `PRODUCTOR_NOMBRE_RAZON`, `PRODUCTOR_NIF`,
  `PRODUCTOR_NOMBRE_SISTEMA` y `PRODUCTOR_ID_SISTEMA` de `lib.rs`, más la versión de
  `tauri.conf.json` y el `tenant_id` como `NumeroInstalacion`. Se inyectan en `setup()`; la
  activación de la licencia actualiza el número de instalación sin reiniciar
  (`set_numero_instalacion`). Es dato declarado: la AEAT valida el formato, no la actividad.
  `PRODUCTOR_NIF` está vacío hoy, y por eso el job no remite (ver arriba).

## La escalera de avisos

Se mide sobre la **antigüedad del pendiente más viejo** (`_Verifactu_Envios.Creado_En_Ms`), no sobre
el tiempo sin conexión. La calcula `escalon_aviso`.

| Antigüedad | Escalón | Dónde se ve |
|---|---|---|
| < 1 h | `ninguno` | — (es el funcionamiento normal) |
| 1–6 h | `visible` | Configuración → Fiscal |
| 6–24 h | `notificacion` | Notificación al Administrador, emitida por el job |
| 24–72 h | `modal_login` | Aviso al entrar, una vez por sesión, con reconocimiento |
| > 72 h | `modal_cobro` | Aviso **después** de cada cobro (y el de login) |

- **Nunca bloquea el cobro**, y el aviso de cobro va después de cobrar: un diálogo delante sería una
  pulsación más en la ruta más caliente.
- Una sola clave de dedupe (`verifactu_atraso`): subir de escalón actualiza el aviso que hay (título
  y severidad nuevos, y vuelve a salir como no leído) en vez de abrir otro, y el aviso **se cierra
  solo** cuando la cola baja. El del certificado hace lo mismo con los días que le quedan.
- Si lo que impide remitir es la identidad del productor, el texto dice que el problema es del
  programa, no del equipo ni de la conexión.
- El aviso de que **faltan los datos fiscales** manda sobre los dos de la escalera: aquéllos hablan
  de facturas sin remitir; éste, de que el siguiente cobro va a fallar.
- `useEstadoFiscal` refresca cada 2 minutos y al recibir `verifactu:cambio`. Arranca con
  `datosFiscalesCompletos = true` para no sacar el aviso en una Handy (donde el comando falla) ni
  antes de la primera respuesta.

## Tras restaurar

`Registros_Facturacion` se replica y vuelve con la recuperación; `_Verifactu_Envios` es local y no.
`recovery::mark_reconciliation_pending` llama a `resembrar_cola_de_envio`, que encola como
`PENDIENTE` todo registro sin estado de envío, con `Creado_En_Ms` = ahora (la escalera mide cuánto
lleva el equipo sin remitir desde la restauración). Lo que la AEAT ya tenga vuelve como `3000` y se
da por aceptado. No se usa `ConsultaFactuSistemaFacturacion`.

El cerrojo de escrituras de negocio de la recuperación impide emitir mientras tanto, igual que
impide vender. La fase 1 del volcado trae `Registros_Facturacion` de la ventana más **siempre la
última fila por `Orden`**, que es el eslabón del que sigue la cadena; el resto llega en la fase 2.

## La exportación (art. 8 RRSIF)

Configuración → Fiscal → «Exportar los registros de facturación», por rango de fechas, a un ZIP que
el usuario guarda donde quiera (`verifactu_exportar`, Administrador):

| Fichero | Qué lleva |
|---|---|
| `registros.xml` | Los registros en el formato del diseño oficial |
| `registros.csv` | Lo mismo, para una hoja de cálculo |
| `cadena.txt` | Número, cadena hasheada y huella de cada registro: con un SHA-256 cualquiera verifica la cadena sin nuestro código |
| `manifiesto.json` | Obligado, productor, sistema, versión, entorno, rango y recuento |

Sólo lee y no abre transacciones: si falta `_Verifactu_Envios`, el estado sale vacío y los registros
salen igual.

## La declaración responsable (art. 13 RRSIF)

`verifactu_declaracion_responsable` (sin rol: es pública) devuelve los datos del productor, la
versión real y el texto `TEXTO_DECLARACION`. Mientras `PRODUCTOR_NIF` esté vacío devuelve el texto
vacío y `completa = false`, y la pantalla dice que está incompleta en vez de enseñarla a medias. El
texto actual es un borrador.

## Modo prueba (temporal)

Etiqueta `MODO-PRUEBA` en el código (`git grep -n MODO-PRUEBA`). Se quita entero antes del 1 de enero
de 2027 ([pendientes.md](../pendientes.md#verifactu)).

- `Business_Settings.Modo_Prueba = 1` (Configuración → Fiscal, Administrador).
- Los cobros numeran en la serie `PRUEBA`, que se fija **antes** de reservar el número
  (`serie_del_cobro`), y no emiten registro: ni QR, ni envío, ni datos del obligado. El papel sale
  marcado «\*\*\* MODO PRUEBA \*\*\*» / «SIN VALOR FISCAL».
- Lo que decide es el número (`es_numero_de_prueba`), así que una reimpresión de mañana dice lo que
  fue aunque el modo ya esté apagado.
- El estado no dice que falten datos fiscales y el motivo de no remitir es `modo_prueba`; el job no
  hace nada.
- Las ventas de prueba cuentan en la caja y en las estadísticas como cualquier otra.

## La Handy

No cobra (`cobro_solo_en_main`), así que no emite registros. El worker veta además cualquier
escritura a `Registros_Facturacion` y `Serie_Facturacion` (`lib/hub.ts`, `TABLAS_SOLO_MAIN`;
`test/fiscalSoloMain.test.ts`): el número correlativo y la cadena tienen un único escritor. En la
Handy, el adaptador AEAT existe pero devuelve error, y el estado fiscal falla sin consecuencias.

---

## Fuera de alcance

- **TicketBAI** (País Vasco y Navarra) e **IGIC/IPSI** (Canarias, Ceuta y Melilla): `Impuesto` no se
  informa (IVA) y `ClaveRegimen` es siempre `01`.
- La **lotería**: es un suplido, no un producto exento, y no entra en el registro
  ([FAQ de desarrolladores de la AEAT](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf),
  pregunta 22).
- Las **operaciones exentas** (`OperacionExenta`, causas `E1`…`E6`): ver *Todo tramo es sujeto*.
- La modalidad **NO VERI\*FACTU** (firma XAdES y registro de eventos).
- **Varios obligados por instalación** (`TipoUsoPosibleMultiOT = N`) y **varias cajas por negocio**:
  la cadena asume una única Main.
- Que el worker remita en nombre de los clientes (apoderamiento): el certificado y el envío se
  quedan en el equipo del bar.
- Los endpoints, `IDVersion` (`1.0`) y la base del QR son constantes del binario: cambiarlos es
  publicar una versión.

## Fuentes

- RD 1007/2023 (RRSIF): arts. 7, 8, 9, 11, 13, 15 y 16. <https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840>
- Orden HAC/1177/2024: art. 7.i (comprobación previa), 16.2 (control de flujo), 20–21 (QR).
  <https://www.boe.es/diario_boe/txt.php?id=BOE-A-2024-22138>
- RD 1619/2012 (reglamento de facturación): arts. 4.2 (límite de 3.000 €), 6.1.a (serie de
  rectificativas), 6.1.i y 7.1.c (fecha de operación), 15.6 (canje de simplificadas).
  <https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696>
- AEAT, especificaciones de la huella v0.1.2, del QR v0.5.0, descripción del servicio web v1.0.3,
  validaciones y errores v1.2.2 y FAQ de desarrolladores, en
  <https://www.agenciatributaria.es/AEAT_Desarrolladores/>. El WSDL, los XSD y el catálogo de errores
  vendorizados están en `crates/tpv-infra-aeat/esquemas/`.
- Portal de pruebas externas: <https://preportal.aeat.es>.

> Esto es documentación de ingeniería, no asesoramiento fiscal. Las decisiones con consecuencia
> tributaria conviene contrastarlas con un asesor antes de lanzar.
