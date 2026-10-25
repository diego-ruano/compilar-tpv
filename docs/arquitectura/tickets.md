# Tickets e impresión (ESC/POS)

El ticket se genera **en Rust** (`apps/tpv-main/src-tauri/src/printing.rs`) y se manda en crudo a la
impresora. La vista previa del frontend (`src/shared/ticket/TicketPaper.tsx`) es un **espejo** de ese
generador: pinta el mismo `PrintTicketPayload` que se imprime. Al cambiar el maquetado hay que
cambiar los dos; el frontend pregunta el ancho a Rust (`printer_ticket_cols`) en vez de calcularlo.

Hay dos papeles y salen de sitios distintos (RI-29):

- **El ticket de un cobro lo compone Rust desde la base** (`use_cases::tickets::ticket_de_pago`): las
  líneas que cobró ese pago (`Pago_Detalles`) y, de su registro de facturación, el número, el NIF y la
  razón social declarados, la fecha de expedición, el QR, el desglose y el total. La pantalla lo pide
  para enseñarlo (`printer_ticket_de_pago`) y lo imprime por el id del pago
  (`printer_imprimir_pago`): el papel no viaja, así que no puede no ser el de su factura.
- **La precuenta la compone la pantalla** (`payloadDePrecuenta`) con las líneas de la comanda, y
  `printer_imprimir_precuenta` le quita todo lo fiscal (`como_precuenta`) aunque se lo manden.

| Pieza | Archivo | Rol |
|---|---|---|
| Generador | `src-tauri/src/printing.rs` | Ancho, columnas, desglose, QR, logo, corte, cajón, arqueo |
| Comandos | `src-tauri/src/lib.rs` | `printer_ticket_de_pago`, `printer_imprimir_pago`, `printer_imprimir_precuenta`, `printer_print_arqueo`, `printer_ticket_cols`, `printer_open_drawer`, `printer_print_test`, selección de impresora |
| Ticket de un cobro | `crates/tpv-application/src/use_cases/tickets.rs` + `crates/tpv-infra-sqlite/src/tickets.rs` | El payload desde el pago y su factura |
| Desglose de IVA y agrupación | `crates/tpv-domain/src/ticket.rs` | Papel, vista previa y registro fiscal ([verifactu.md](verifactu.md)); `agrupar_lineas` es la gemela de `agruparLineas` |
| Vista previa | `src/shared/ticket/TicketPaper.tsx` + `ticketMath.ts` | Espejo; lo compartido con el papel está en `ticketMath.ts`, sin React |
| Payload | `crates/tpv-contracts/src/impresion.rs` + `src/features/configuracion/api/printerApis.ts` | El DTO; la pantalla sólo arma la precuenta (`payloadDePrecuenta`) |
| Modal de impresión | `src/shared/ticket/PrintTicketModal.tsx` | Un botón por cada factura del cobro (`facturas_del_cobro`: el ticket, la `F3` del canje, la rectificativa, la `F3` de la devolución), sin elegir líneas; o la precuenta de todo, de lo pendiente o de una selección |
| Reimpresión y devolución | `src/app/pages/Cuentas.tsx` | El mismo modal con el pago y `es_copia`; tras una devolución (entera o de una parte) se abre con la rectificativa elegida, sin imprimir |
| Tests | `src-tauri/src/printing/tests.rs` · `test/ticketMath.test.ts` | Goldens duplicados a propósito |

## Orden del ticket

**Datos del negocio → líneas → totales → desglose de IVA → mensaje → logo → corte.**

- Esta rama no imprime el QR tributario ni la leyenda «VERI\*FACTU»: van con la remisión, en la rama
  `con-verifactu` ([verifactu.md](verifactu.md#lo-que-no-hay-en-esta-rama)).
- La **cabecera** son los datos del negocio alineados a la izquierda: lo primero que se lee es de quién
  es y cuánto se ha pagado.
- El **logo cierra el ticket**, centrado.

## Reglas

- **Lo que exige una factura no se puede ocultar.** Configuración sólo apaga el logo, el rótulo, la
  dirección, el teléfono y el mensaje final; el NIF, la fecha, las líneas, el desglose de IVA y el
  total salen siempre (RI-29).
- **El ancho manda.** `cols_efectivas()` sale del papel (58 / 80 / 112 mm: 32 / 48 / 64 columnas), los
  márgenes y `chars_per_line`. Nada se maqueta con anchos fijos: un nombre largo se trunca contra ese
  ancho.
- **El IVA es por producto** (`Productos.IVA_Percent`, congelado en la línea). El pie lleva una línea de
  base y cuota por tipo. El `iva_percent` del payload es sólo el defecto.
- **La cuota es lo que falta hasta el total**: se redondea la base y la cuota se despeja. Base más IVA
  tienen que dar el total (0,39 € al 4 % es el primer caso en que redondear por separado falla). La AEAT
  no detecta una `CuotaTotal` descuadrada, así que esta regla y sus goldens son la única red.
- **El número de ticket es el número de la factura** (`Pagos.Numero_Ticket` = `Num_Serie_Factura`). Una
  reimpresión reusa número, fecha y desglose y sale marcada `COPIA`; si el cobro está anulado,
  también `*** ANULADO ***`.
- **La fecha de un ticket es la de expedición** de su factura, con la hora en que se generó el
  registro (`fecha_del_papel`). Sólo la precuenta lleva la de ahora, y un cobro sin registro (anterior a la
  numeración), la del pago.
- **Lo fiscal del papel es lo declarado**: el NIF y la razón social del registro, su `Desglose_Json` y
  su `Importe_Total`, no un recálculo ni los ajustes de hoy.
- **El último cobro se olvida al cambiar de comanda**: el modal sólo ofrece el ticket del último
  cobro de la comanda abierta; el de otro se reimprime desde Cuentas.
- **La precuenta** no lleva número ni registro ni QR, y dice que no es un ticket de venta.
- **Una factura completa** (`F1`/`F3`) se titula FACTURA y lleva el nombre, el NIF y el domicilio del
  cliente (`bloque_tipo_de_factura`); una `F3` dice qué factura sustituye. Un ticket canjeado se
  sigue reimprimiendo como ticket, y el modal ofrece también su `F3`
  ([verifactu.md](verifactu.md#el-papel-de-una-factura-completa-y-de-una-rectificativa)).
- **Una `F3` de varios tickets** lleva las líneas de todos sus cobros y la lista de los que
  sustituye, sin método de pago ni origen (no es un cobro) y sin abrir el cajón. Se imprime desde
  cualquiera de esos cobros: cada uno la tiene en su lista de facturas. En Cuentas, «Factura de
  varios tickets» permite elegirlos (la selección sobrevive al cambiar de página).
- **Una rectificativa** (`R1`–`R5`) se titula FACTURA RECTIFICATIVA y dice qué factura rectifica y
  de qué fecha. Sus líneas son las del cobro **en negativo**, y su total y su desglose los
  declarados. No lleva método de pago, así que no abre el cajón, ni la marca ANULADO, que es de la
  copia del cobro dado de baja.
- **El papel de una devolución de parte de un cobro** es el de su pago negativo: lleva sólo las
  líneas devueltas (`Devolucion_Lineas`), en negativo, con su rectificativa. Una línea cuya parte
  devuelta no es unidades × precio (la última de una línea al peso) sale como una unidad por lo
  devuelto. Sin rectificativa (un cobro sin registro), igual en negativo y sin abrir el cajón.
- **El cajón sólo lo abre el ticket original de un cobro en efectivo** (`abre_cajon`, que decide
  `ticket_de_pago`). Ni una copia, ni la `F3` de un canje, ni una rectificativa, ni una precuenta. El
  original sale una vez por sesión (`TicketsImpresos`): imprimirlo otra vez desde la pantalla del
  cobro saca una COPIA, y Cuentas pide siempre la copia. Se anota después de imprimir, así que si la
  impresora no estaba, el siguiente intento sigue siendo el original.
- **El cajón se abre con la impresora**: dentro del ticket (`ESC p`) o suelto (`DLE DC4`, que la
  impresora atiende aunque tenga trabajos en su memoria; la cola de Windows, en cambio, lo pone detrás
  de los que esperan). Toda apertura fuera de un cobro se anota en `Aperturas_Cajon` con quien tenga
  la sesión. Abrirlo no pide rol, pero sí estar identificado.
- **Con la impresora no disponible no se manda nada** (RI-29). `WritePrinter` sólo deja el trabajo en
  la cola de Windows, así que antes `print_raw` lee el estado (`GetPrinterW` nivel 2): desconectada,
  en pausa, sin papel, atascada, con la tapa abierta o con error, y el trabajo no se manda y se
  avisa. Si el driver no informa, se manda. Además borra de la cola los trabajos del TPV (los que
  empiezan por `TPV · `) que lleven más de cinco minutos: al encender la impresora no salen de golpe
  los atrasados ni se abre el cajón por cada uno.
- **El logo es de un bit**: `rasterizar_logo` lo reduce al ancho del papel (múltiplo de 8 dots), compone
  la transparencia sobre blanco, difumina con Floyd–Steinberg y emite `GS v 0`. Su ancho sale del
  cabezal y los márgenes (`ancho_logo_dots`), no de `chars_per_line`, que es la densidad del texto. Si
  la imagen no se lee, el ticket sale sin logo.
- **Nada de lo que rodea al ticket puede impedir cobrar**: ni el logo, ni el QR, ni la impresora.
- **Un carácter, un byte**: `encode_cp858` mapea uno a uno y lo que no está en la tabla sale `?`. Los
  bytes de control se convierten en espacio: el nombre de un producto lo escribe una persona, y un
  `ESC` ahí sería un comando.
- **Cobrar es de la Main** (`cobro_solo_en_main` en el worker): el número correlativo y el cajón viven
  ahí.
- **El arqueo** (`build_arqueo`) es un documento interno: sin número, sin IVA, sin cajón
  ([caja.md](caja.md#la-pantalla-y-el-papel)).

## La vista previa como espejo

Lo que la previa comparte con el papel —agrupación de líneas, desglose de IVA, formato del dinero y
recorte del nombre— vive en `ticketMath.ts`. La previa pinta el payload tal cual: con desglose y total
declarados los usa, y sólo en la precuenta los calcula con `ticketMath`. Hay tablas de golden en los dos lados (`printing/tests.rs` y `test/ticketMath.test.ts`): si uno
cambia de criterio, el otro falla. El formateador del papel no lleva separador de miles (en 32 columnas
un punto de millar se confunde con el decimal) y es distinto del de pantalla.

Dos trampas: `Intl.NumberFormat` mete el punto de los miles y un espacio duro que el papel no lleva, y
`String.slice` cuenta unidades UTF-16 (parte un emoji) donde Rust cuenta caracteres.

## Los tests del generador

`printing/tests.rs` incluye un mini-intérprete ESC/POS: separa texto de comandos y **falla si encuentra
un byte que no es ninguna de las dos cosas**. Es la forma de comprobar el trabajo de impresión sin una
impresora delante.
