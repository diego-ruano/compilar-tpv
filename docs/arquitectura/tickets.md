# Tickets e impresión (ESC/POS)

El ticket se genera **en Rust** (`apps/tpv-main/src-tauri/src/printing.rs`) y se manda en crudo a la
impresora. La vista previa del frontend (`src/shared/ticket/TicketPaper.tsx`) es un **espejo** de ese
generador: no imprime, enseña lo que va a salir. Al cambiar el maquetado hay que cambiar los dos; el
frontend pregunta el ancho a Rust (`printer_ticket_cols`) en vez de calcularlo.

| Pieza | Archivo | Rol |
|---|---|---|
| Generador | `src-tauri/src/printing.rs` | Ancho, columnas, desglose, QR, logo, corte, cajón, arqueo |
| Comandos | `src-tauri/src/lib.rs` | `printer_print_ticket`, `printer_print_arqueo`, `printer_ticket_cols`, `printer_open_drawer`, `printer_print_test`, selección de impresora |
| Desglose de IVA | `crates/tpv-domain/src/ticket.rs` | Papel, vista previa y registro fiscal ([verifactu.md](verifactu.md)) |
| Vista previa | `src/shared/ticket/TicketPaper.tsx` + `ticketMath.ts` | Espejo; lo compartido con el papel está en `ticketMath.ts`, sin React |
| Payload | `src/features/configuracion/api/printerApis.ts` + `crates/tpv-contracts/src/impresion.rs` | `buildTicketPayload` agrupa con `agruparLineas`, la misma función que la vista previa; el tipo es el DTO generado |
| Reimpresión | `src/app/pages/Cuentas.tsx` | Copia marcada, mismo número |
| Tests | `src-tauri/src/printing/tests.rs` · `test/ticketMath.test.ts` | Goldens duplicados a propósito |

## Orden del ticket

**QR tributario → «VERI\*FACTU» → datos del negocio → líneas → totales → desglose de IVA → mensaje →
logo → corte.**

- El **QR** va lo primero porque lo exige la norma; los detalles en
  [verifactu.md](verifactu.md#el-qr-y-el-papel). La URL no se compone al imprimir: sale del registro.
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
  reimpresión reusa número, QR y huella y sale marcada `COPIA`; si el cobro está anulado, también
  `*** ANULADO ***`.
- **La precuenta** no lleva número ni registro ni QR, y dice que no es un ticket de venta.
- **El cajón se abre con la impresora**: dentro del ticket (`ESC p`) o suelto (`DLE DC4`, que la
  impresora atiende aunque tenga cola). Toda apertura fuera de un cobro se anota en `Aperturas_Cajon`
  con quien tenga la sesión. Abrirlo no pide rol, pero sí estar identificado.
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
recorte del nombre— vive en `ticketMath.ts`, y el payload que va a la impresora agrupa con esa misma
función. Hay tablas de golden en los dos lados (`printing/tests.rs` y `test/ticketMath.test.ts`): si uno
cambia de criterio, el otro falla. El formateador del papel no lleva separador de miles (en 32 columnas
un punto de millar se confunde con el decimal) y es distinto del de pantalla.

Dos trampas: `Intl.NumberFormat` mete el punto de los miles y un espacio duro que el papel no lleva, y
`String.slice` cuenta unidades UTF-16 (parte un emoji) donde Rust cuenta caracteres.

## Los tests del generador

`printing/tests.rs` incluye un mini-intérprete ESC/POS: separa texto de comandos y **falla si encuentra
un byte que no es ninguna de las dos cosas**. Es la forma de comprobar el trabajo de impresión sin una
impresora delante.
