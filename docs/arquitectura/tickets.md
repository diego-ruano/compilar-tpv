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
| PDF de una factura completa | `src-tauri/src/factura_pdf.rs` + `src-tauri/src/pdf.rs` · `use_cases/facturas_pdf.rs` · job `facturas_pdf` | El mismo papel en A4, compuesto una vez y guardado en el equipo y en la nube ([abajo](#el-pdf-de-una-factura-completa)) |

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
  también `*** ANULADO ***`. Anular por ERROR devuelve las líneas a la mesa, y si después se retiran
  desaparecen también de la copia, que conserva el total del cobro: la vista previa lo explica en
  lugar de «No hay productos».
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
- **Una `F3` en negativo se llama por lo que contrarresta** (`F3Negativa` en
  `facturas_del_cobro`, deducido de lo que sustituye en `tickets.rs`): si sustituye a una
  rectificativa, «Factura de la devolución»; si después la vuelve a emitir en positivo con los
  mismos tickets, «Anulación de la factura (corrección de datos)»; si no, es la que saca de una `F3`
  de varios un cobro dado de baja por error.
- **Una `F3` de varios tickets** lleva las líneas de todos sus cobros y la lista de los que
  sustituye, sin método de pago ni origen (no es un cobro) y sin abrir el cajón. Se imprime desde
  cualquiera de esos cobros: cada uno la tiene en su lista de facturas. En Cuentas, «Factura de
  varios tickets» permite elegirlos (la selección sobrevive al cambiar de página); un ticket que no
  se puede facturar sale con la casilla desactivada y el motivo.
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
- **Un fallo de la impresora es `external`** (`fallo_de_impresora`): es del entorno, no del programa.
  Se registra como tal ([observabilidad.md](observabilidad.md#los-fallos-de-comandos)) y la pantalla
  enseña el motivo («La impresora … está sin papel»).
- **El logo es de un bit**: `rasterizar_logo` lo reduce al ancho del papel (múltiplo de 8 dots), compone
  la transparencia sobre blanco, difumina con Floyd–Steinberg y emite `GS v 0`. Su ancho sale del
  cabezal y los márgenes (`ancho_logo_dots`), no de `chars_per_line`, que es la densidad del texto.
- **El logo pasa al imprimir por las mismas cotas que al guardarlo** (AUD-30). `Logo_DataUrl` se
  replica y lo puede escribir cualquier dispositivo del negocio, así que no se da por bueno aunque
  la interfaz sólo guarde imágenes ya reconstruidas. `leer_imagen_local` sólo lee una imagen
  guardada (`images/{carpeta}/{archivo}`, la forma que valida `imagenes::ruta_segura`) o un data URL
  heredado, y no más de 5 MB; `rasterizar_logo` decodifica con `imagenes::decodificar`, la misma
  función de `save_image`. Lo que no se lee, no cumple las cotas o hace fallar al decodificador
  (también con un pánico) deja el ticket sin logo, con un aviso en el registro si es la imagen la
  que se rechaza.
- **Sólo se decodifican JPEG y PNG**, al guardar una imagen y al imprimir el logo: 8192 px de lado,
  24 Mpx y 128 MiB de imagen decodificada, comprobados con la cabecera antes de reservar los
  píxeles. WebP no se admite ni se compila (`image` va sin esa característica) y la interfaz no lo
  ofrece: su decodificador reserva lo que declara el fichero antes de comprobarlo, y con unos bytes
  pedía gigas. Un logo que ya estuviera guardado en WebP se sigue viendo en pantalla, que lo pinta
  la webview, pero no sale en el papel.
- **128 MiB acotan la imagen decodificada, no la memoria del proceso.** Con ella conviven otros
  búferes en cada paso. Al decodificarla, los coeficientes de un JPEG progresivo (hasta 8 bytes por
  píxel) o el perfil de color de un PNG (hasta otros 128 MiB). Al girarla por su orientación, la
  copia girada. Al rasterizarla, su copia RGBA de 8 bits mientras se convierte (una imagen que ya
  es RGBA no se copia); el plano gris se compone con el original ya liberado, y el intermedio del
  redimensionado (16 bytes por cada píxel del ancho original y del alto de salida), con esa copia
  ya liberada. El peor caso conocido de búferes son unos 256 MiB: una imagen de 128 MiB junto a su
  copia girada o a su perfil de color. Al rasterizar son 213 MiB, con un PNG RGB de 16 bits de
  4096 × 5461. No es un techo del proceso: se suman la entrada, lo que el decodificador guarda por
  dentro y lo que ya ocupe la Main.
- **El logo se lee y el ticket se maqueta en el hilo de bloqueo que lo manda a la impresora**, no en
  la tarea del comando. Si ese hilo se cae, la pantalla recibe «No se pudo completar la impresión.
  Vuelve a intentarlo.» y el detalle va al registro.
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

## El PDF de una factura completa

Cada factura completa (un alta de `Registros_Facturacion` con destinatario: `F1`, `F3` y las
rectificativas con cliente; no los tickets ni una `R5` sin cliente, y una subsanación no lleva PDF
propio) tiene su PDF A4, que se entrega al cliente y se ve desde su ficha.

- **Es el mismo papel.** El job pide su `ticket_de_pago` por el número de la factura y lo maqueta en A4
  (`factura_pdf::pdf_de_factura`): el emisor, el número, la fecha de expedición, el cliente, «Rectifica
  a…» / «Sustituye a…», las líneas, el desglose declarado y el total salen de ahí, y el dinero con
  `fmt_eur`, el formateador del papel. Lo vigila `la_factura_lleva_lo_que_lleva_su_papel`, que saca los
  importes del ticket ESC/POS y los busca en el PDF. Una `F3` de varios tickets, que no cuelga de
  ningún cobro, se compone desde el primero de los que canjea que esté en la base.
- **Lo que exige una factura sale siempre**: el rótulo, la razón social, el NIF y la dirección del
  emisor, aunque el ticket los oculte; el teléfono y el mensaje final, si el ticket los lleva. El logo,
  si el ticket lo lleva, en JPEG (la transparencia sobre blanco, 600 px como mucho) y con las mismas
  cotas que al imprimirlo (`imagenes::decodificar`, AUD-30); si no se puede leer, sale sin él. No
  lleva ni COPIA ni ANULADO: son marcas del papel de un cobro, no de la factura.
- **El escritor de PDF es propio** (`pdf.rs`), sin dependencias: Helvetica y Helvetica-Bold, las fuentes
  estándar del PDF, que no se incrustan, con `WinAnsiEncoding` (tildes, ñ, ü, ç, ¿, ¡, º y el €; lo que
  no está sale `?`). El contenido va sin comprimir y en ASCII (lo demás, en octal), y no lleva fecha
  ni nada al azar: **los mismos datos dan los mismos bytes**. Una tabla de muchas líneas sigue en otra
  página con su cabecera, y cada página lleva «FACTURA F-… · Página n de m».
- **Se compone una vez, después del cobro o de la emisión** y nunca dentro de su transacción: lo hace
  el job `facturas_pdf` cada minuto ([jobs-e-interruptores.md](jobs-e-interruptores.md)). Nada de esto
  puede impedir cobrar.
- **No se vuelve a componer.** Se guarda en `AppData/facturas/{ID_Registro}.pdf` (fuera del alcance de
  la webview: [permisos.md](permisos.md)) y se sube a la nube, que lo guarda en el bucket de las
  imágenes y no lo sobrescribe ([worker.md](worker.md#facturas-en-pdf)). Para documentar una factura
  sin PDF local, primero se pregunta a la nube: en un equipo restaurado, el bueno es el que se subió
  el día que se emitió, no uno compuesto con los datos del negocio de hoy. Si se compuso aquí sin red
  y al subirlo la nube ya tenía otro, se cambia el de aquí por el de la nube, y no se da por subido
  hasta haberlo cambiado: si la bajada falla, la pasada siguiente lo repite. Por eso un PDF compuesto
  aquí vuelve siempre a la subida, aunque constara que la nube tenía el suyo.
- **Con el histórico a medias no se compone** (tras restaurar desde la nube, SYNC-19): las líneas de
  una factura antigua pueden no haber bajado. Se baja de la nube lo que esté y lo demás espera; a la
  que la nube no tiene no se le vuelve a preguntar hasta pasados 15 minutos (`ESPERA_HISTORICO_MS`,
  sin contar como intento), así que la pasada sigue con las demás.
- **El estado de cada una** está en `_Facturas_Pdf` (`0006_facturas_pdf.sql`, local del equipo:
  [esquema.md](esquema.md#el-andamiaje-local-16-de-0001-y-0002)): la ruta, de dónde salió (`generado`
  o `bajado`), cuándo se generó y cuándo lo confirmó la nube, y los fallos al componerla, con una
  espera que se dobla desde un minuto hasta seis horas. Un rechazo de la nube por lo que es (400 o
  413) la aparta de la subida. Un fallo de la nube (sin red, credenciales, un fallo suyo) no es de la
  factura: no cuenta como intento, la pasada deja de hablar con ella y no vuelve hasta pasado un
  minuto, dos, cuatro… hasta media hora.
- **Para enseñar una**, `use_cases::facturas_pdf::pdf_de_factura` da la local; si no está, la de la
  nube (salvo que el job la haya dejado en pausa, para no esperar a una nube que no contesta); y si
  no la tiene, la compone en ese momento y se queda como si la hubiera hecho el job. Lo que no es una
  factura completa se contesta `not_found`, y con el histórico a medias, `conflict`. El job y la
  pantalla montan lo mismo (`factura_pdf::PiezasFacturas`), y cada escritura del PDF local va a su
  propio temporal antes de ponerse en su sitio, así que pueden guardar la misma factura a la vez.

### En la ficha del cliente

La ficha del cliente (Clientes → un cliente) tiene la sección **Facturas**, sólo en la Main: las
facturas completas cuyo destinatario tiene el NIF de la ficha (normalizado como `normalizar_nif`), de
la más reciente a la más antigua y 200 como mucho, con su número, su fecha de expedición, si es
factura (`F1`), rectificativa (`R1`..`R5`) o sustitutiva (`F3`) y su importe. Una ficha sin NIF no
tiene: la sección dice que añadiéndoselo saldrán. Una subsanación no sale aparte.

Una factura **anulada** (un registro de anulación de su número posterior a ella: la baja de su cobro
por error, `emitir_baja_de_pago`) sigue en la lista, porque el registro se conserva, pero dice
«Factura anulada» (o «Rectificativa anulada», «Sustitutiva anulada») y su importe sale tachado. Su
PDF es el que se emitió, sin marca, y se ofrece guardarlo como `factura_…_anulada.pdf`.

- **PDF** pide el nombre con el diálogo de guardar (`factura_2026-000012.pdf`) y escribe en él el PDF
  que da `clientes_factura_pdf` (el de arriba: local, nube o compuesto). La app no tiene con qué abrir
  un fichero con el visor del sistema; se guarda como el PDF de Cuentas.
- **Reimprimir** abre el `PrintTicketModal` con el papel de su cobro y su número, marcado COPIA. Una
  `F3` de varios tickets se reimprime desde el primero de los que canjea que esté en la base; si no
  hay ninguno, el botón queda apagado.

La lista la da `clientes_facturas` (`use_cases::facturas_pdf::facturas_de_cliente`), que lee el NIF
de la ficha y busca por el índice parcial de las facturas completas. Los dos comandos piden
`clientes.gestionar` y sólo existen en la Main ([permisos.md](permisos.md)). En la pantalla, React
Query (`useFacturasDelCliente`, `clientesQueries.ts`); cambiar el NIF de la ficha la vuelve a pedir.

## Los tests del generador

`printing/tests.rs` incluye un mini-intérprete ESC/POS: separa texto de comandos y **falla si encuentra
un byte que no es ninguna de las dos cosas**. Es la forma de comprobar el trabajo de impresión sin una
impresora delante.
