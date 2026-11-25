// Generado por pnpm generate-types desde Rust y tauri-specta. No editar.

/* Types */
export type AccionEmparejamiento = "PAIR_FETCH" | "PAIR_CANCEL";

/**
 *  Ajuste de las existencias de un lote (RI-55). `stock_visto` es lo que enseñaba la pantalla al
 *  abrir el ajuste: si ya no es lo que hay, se rechaza en vez de pisar lo que se movió entre medias.
 */
export type AjusteLoteInput = {
	id_lote: string,
	stock_visto: number | null,
	stock_nuevo: number | null,
	motivo?: string | null,
};

/**
 *  Ajuste del stock suelto de un producto (RI-55), igual que `AjusteLoteInput`. `None` es «no lleva
 *  stock suelto»: en `stock_nuevo` lo desactiva y en `stock_visto` dice que no lo llevaba.
 */
export type AjusteStockSueltoInput = {
	id_producto: string,
	stock_visto?: number | null,
	stock_nuevo?: number | null,
	motivo?: string | null,
};

/**  Lo que se configura en Configuración → Reservas, en el bloque de la web. */
export type AjustesReservaWebDto = {
	/**  El interruptor general (`Business_Settings.Reserva_Web_Activa`). */
	activa: boolean,
	/**  Los días cerrados de hoy en adelante, por fecha. */
	cierres: CierreReservaWebDto[],
};

export type AlergenoInvDto = {
	ID_Alergeno: string,
	Nombre: string,
	Nombre_Imagen: string | null,
	Ruta_Imagen: string | null,
};

export type AlergenoMiniDto = {
	ID_Alergeno: string,
	Nombre: string,
	Ruta_Imagen: string | null,
};

/**  Lo que ha hecho la baja de un cobro. */
export type AnulacionPagoDto = {
	/**  `false` si el cobro no existía o ya estaba dado de baja: no se ha hecho nada. */
	anulado: boolean,
	lineas: DestinoLineasBaja,
	/**  El nombre de la mesa de la comanda, para decir adónde volvieron. `None` en la barra. */
	mesa: string | null,
};

/**
 *  Anular un cobro (CUENTA-07). **No lleva `id_usuario`**: quién anula sale de la sesión del
 *  backend (SEC-01). Una anulación firmada con el nombre que le pase la pantalla es una auditoría
 *  que da confianza sin merecerla.
 */
export type AnularPagoInput = {
	id_pago: string,
	/**  Obligatorio. Quién y cuándo los pone el sistema; el porqué sólo puede ponerlo quien anula. */
	motivo?: string | null,
	/**
	 *  FISCAL-01: `"ERROR"` (la venta no existió → RF de anulación) o `"DEVOLUCION"` (la venta
	 *  existió y se devuelve el dinero → factura rectificativa `R5`).
	 *
	 *  Ausente = `"ERROR"`, que es lo que hacía este comando antes de FISCAL-01. Son dos
	 *  instrumentos legales distintos y la pantalla tiene que explicar la diferencia en una frase,
	 *  no ofrecer dos botones parecidos.
	 */
	clase?: string | null,
};

/**  Cabeceras firmadas para el worker (campos en camelCase). */
export type ApiSignedHeaders = {
	authorization: string,
	xDeviceTs: string,
	xDeviceSig: string,
};

/**  Error tal y como lo recibe el frontend. Es el `Err` de **todos** los comandos Tauri. */
export type AppErrorDto = {
	/**  Código estable. Es lo único por lo que se debe ramificar. */
	code: ErrorCode,
	/**  Texto diagnóstico, legible. Se muestra y se registra; nunca se compara. */
	message: string,
};

export type AsignacionCreateInput = {
	id_trabajador: string,
	fecha: string,
	id_turno: string,
	area: string,
	hora_inicio?: string | null,
	hora_fin?: string | null,
	notas?: string | null,
};

export type AsignacionDeleteInput = {
	id_asignacion: string,
};

/**  RI-85: crear o sustituir el conjunto de tramos en una única transacción. */
export type AsignacionGuardarInput = {
	id_asignacion?: string | null,
	id_trabajador: string,
	fecha: string,
	id_turno: string,
	area: string,
	notas?: string | null,
	tramos: TramoHorarioInput[],
};

export type AsignacionRow = {
	ID_Grupo?: string | null,
	ID_Asignacion: string,
	ID_Trabajador: string,
	Fecha: string,
	ID_Turno: string,
	Area: string,
	Hora_Inicio: string | null,
	Hora_Fin: string | null,
	Notas: string | null,
	Nombre_Turno: string,
	/**  Es el día libre del trabajador (el turno LIBRE, sin horas): tapa la plantilla. */
	Libre?: boolean,
};

export type AsignacionUpdateInput = {
	id_asignacion: string,
	id_turno: string,
	area: string,
	hora_inicio?: string | null,
	hora_fin?: string | null,
	notas?: string | null,
};

export type AutorizacionUsuario = {
	rol: string,
	permisos: string[],
};

/**
 *  El cuerpo de `POST /v1/reservas-web/avisos`: el correo al cliente por un cambio del restaurante.
 *  Los datos son los de después del cambio. El destinatario **no** viaja: es el cliente de esa
 *  reserva en la nube, y sólo si es una reserva web.
 */
export type AvisoReservaWebInput = {
	/**  El id del aviso: el mismo aviso no manda dos correos. */
	id_aviso: string,
	id_reserva: string,
	tipo: TipoAvisoReservaWeb,
	dia_ymd: string,
	hora: string,
	personas: number,
	/**  El nombre de la mesa en la Main; `None` si no tiene. */
	mesa: string | null,
	/**
	 *  El cliente de la reserva en la Main tras el cambio. La nube sólo le escribe al de su copia si
	 *  es éste: si aún tiene otro (el cambio no ha subido), contesta 404 y se repite más tarde.
	 */
	id_cliente: string | null,
	/**
	 *  La huella del correo de ese cliente en la Main (`tpv_domain::reservas_web::huella_de_correo`).
	 *  Lo mismo: si la copia de la nube tiene otro correo (se corrigió y no ha subido), espera.
	 */
	huella_correo: string | null,
};

export type AvisoSocketHandy = {
	generacion: number,
	cambio: CambioReplicado,
};

/**
 *  Estado del backfill del histórico, para el panel de Conectividad y para el aviso de las
 *  estadísticas (mientras corre, un total de rango largo crece solo y parece un error de cálculo).
 */
export type BackfillEstado = {
	/**  Cuántas tablas quedan por completar. Cero = no hay backfill en curso. */
	tablas_pendientes: number,
	/**  Cuántas ha completado ya. */
	tablas_completadas: number,
	/**
	 *  Filas traídas hasta ahora. Es el único número que se mueve mientras una tabla grande baja,
	 *  así que es lo que hace que la barra no parezca colgada.
	 */
	filas_traidas: number,
	/**  La tabla que se está rellenando ahora mismo (la primera sin completar), si queda alguna. */
	tabla_actual: string | null,
	/**  Último error del job, si el anterior intento falló. Diagnóstico, no ramificación. */
	ultimo_error: string | null,
};

/**
 *  La factura que se acaba de emitir, tal como la devuelven las facturas completas de Cuentas.
 *
 *  **Estos datos no se pueden inventar en el cliente.** Salen de la fila que se acaba de escribir
 *  en `Registros_Facturacion` dentro de la misma transacción: el número es el que reservó el
 *  contador.
 */
export type BloqueFiscal = {
	/**
	 *  `2027/000001`. En un cobro es también `Pagos.Numero_Ticket`: un solo número para el papel,
	 *  el cobro y el registro — dos numeraciones paralelas serían dos cosas que pueden divergir.
	 */
	num_serie_factura: string,
	/**  `DD-MM-AAAA`. */
	fecha_expedicion: string,
	/**  `F1` | `F2` | `F3` | `R1`..`R5`. */
	tipo_factura: string,
};

/**
 *  Qué se restauró. `tablas_desconocidas` son las que la nube mandó y esta versión de la app no
 *  tiene en su esquema: se informan en vez de fallar (un TPV con una versión por detrás debe poder
 *  recuperarse igual), pero se dicen para que no pasen desapercibidas.
 */
export type BootstrapResultado = {
	seq: number,
	filas_restauradas: number,
	tablas_restauradas: string[],
	tablas_desconocidas: string[],
};

/**
 *  Respuesta de `/v1/sync/bootstrap`: el estado actual del tenant y el `seq` EXACTO en el que se
 *  tomó la foto (leído en la misma transacción). Ese `seq` pasa a ser el checkpoint local, de modo
 *  que el catch-up siga desde justo después sin huecos ni solapes.
 */
export type BootstrapSnapshot = {
	seq: number,
	total_filas: number,
	tablas: BootstrapTabla[],
	/**
	 *  SYNC-19: las tablas a rellenar en la fase 2, **en orden de padres primero**. El orden lo
	 *  decide el worker y se guarda tal cual: cada página del backfill es su propia transacción,
	 *  así que una hija insertada antes que su padre no tiene dónde apoyarse.
	 */
	backfill: string[],
	/**
	 *  DO-02: desde dónde llega entera cada tabla recortada (`AAAA-MM-DD HH:MM:SS`, hora del
	 *  equipo). Lo anterior baja por la fase 2. Se guarda con la cola del backfill: con él, el cierre
	 *  de caja sabe si lo del periodo abierto ya está aquí. `None` si el worker no lo dice.
	 */
	ventana_desde?: string | null,
};

/**
 *  Volcado de UNA tabla del tenant. `filas` es posicional respecto a `columnas` (con 41 tablas,
 *  repetir el nombre de cada columna en cada fila multiplicaría el tamaño sin añadir nada).
 */
export type BootstrapTabla = {
	nombre: string,
	columnas: string[],
	filas: unknown[][],
	/**
	 *  SYNC-19: lo que viene está recortado por la ventana de la fase 1, así que esta tabla queda
	 *  pendiente de backfill. Lo decide el worker, que es donde vive la clasificación.
	 */
	parcial: boolean,
};

export type BusinessSettings = {
	business_name: string,
	logo_data_url: string | null,
	direccion: string,
	telefono: string,
	cif: string,
	mensaje_footer: string,
	iva_percent: number | null,
	/**  A partir de cuánto descuadre el cierre de caja pide un motivo escrito (CUENTA-06). */
	umbral_descuadre: Dinero,
	/**
	 *  `NombreRazon` del obligado a expedir la factura. **No es `business_name`**: uno es el rótulo
	 *  («Bar La Plaza») y el otro quien factura («Francisco García SL»). El ticket enseña los dos;
	 *  el registro de facturación, sólo este.
	 */
	razon_social: string,
	/**
	 *  `DescripcionOperacion`, campo obligatorio de hasta 500 caracteres. Texto fijo configurable y
	 *  no un resumen de las líneas: los nombres de producto los escribe el usuario, y un campo
	 *  obligatorio que puede llegar vacío o con basura es un rechazo garantizado.
	 */
	descripcion_op: string,
	/**
	 *  Límite (IVA incluido) por encima del cual ya no cabe una simplificada (`F2`) y hay que
	 *  emitir factura completa. 3.000 € en hostelería (art. 4.2 RD 1619/2012).
	 */
	limite_simplif: Dinero,
	/**
	 *  `"produccion"` | `"pruebas"`. Decide la base de la URL del QR que guarda el registro. No tiene
	 *  pantalla en esta rama: es de la remisión a la AEAT (ver `docs/arquitectura/verifactu.md`).
	 */
	verifactu_entorno: string,
	/**  Minutos que dura una reserva que no elige su duración. */
	reserva_duracion_min: number,
	/**  `"avisar"` | `"prohibir"`: qué pasa cuando dos reservas de la misma mesa se pisan. */
	reserva_solape: string,
	/**
	 *  A los cuántos minutos de su hora se marca «No vino» una reserva a la que no ha llegado nadie;
	 *  0 = nunca. Lo aplica el job `reservas_no_vino` de la Main.
	 */
	reserva_no_vino_min: number,
	/**
	 *  Zona horaria IANA del negocio (`Europe/Madrid`, `Atlantic/Canary`). Sólo se lee: la pone el
	 *  job `zona_horaria` de la Main con la de su reloj. Con ella cada pantalla sabe qué día es «hoy»
	 *  en el negocio aunque el dispositivo tenga otra zona (INC-01).
	 */
	zona_horaria: string,
};

export type BusinessSettingsPatch = BusinessSettingsPatch_Serialize | BusinessSettingsPatch_Deserialize;

export type BusinessSettingsPatchInput = BusinessSettingsPatchInput_Serialize | BusinessSettingsPatchInput_Deserialize;

export type BusinessSettingsPatchInput_Deserialize = {
	patch: BusinessSettingsPatch_Deserialize,
};

export type BusinessSettingsPatchInput_Serialize = {
	patch: BusinessSettingsPatch_Serialize,
};

export type BusinessSettingsPatch_Deserialize = {
	business_name?: string,
	logo_data_url?: string | null,
	direccion?: string,
	telefono?: string,
	cif?: string,
	mensaje_footer?: string,
	iva_percent?: number,
	umbral_descuadre?: Dinero,
	razon_social?: string,
	descripcion_op?: string,
	limite_simplif?: Dinero,
	verifactu_entorno?: string,
	reserva_duracion_min?: number,
	reserva_solape?: string,
	reserva_no_vino_min?: number,
};

export type BusinessSettingsPatch_Serialize = {
	business_name?: string,
	logo_data_url?: string | null,
	direccion?: string,
	telefono?: string,
	cif?: string,
	mensaje_footer?: string,
	iva_percent?: number,
	umbral_descuadre?: Dinero,
	razon_social?: string,
	descripcion_op?: string,
	limite_simplif?: Dinero,
	verifactu_entorno?: string,
	reserva_duracion_min?: number,
	reserva_solape?: string,
	reserva_no_vino_min?: number,
};

/**
 *  Un cambio de caja que todavía no se ha hecho, para saber a qué cierres afectaría (CAJA-01).
 *
 *  Lleva sólo lo que le importa al arqueo de cada apunte: la fecha, el método y el importe, y si un
 *  gasto salió del cajón. El concepto o el proveedor no mueven ningún número.
 */
export type CambioCajaInput = { tipo: "editar_pago"; id_pago: string; fecha_hora: string; metodo: string } | { tipo: "anular_pago"; id_pago: string;
/**
 *  REV-08: `"ERROR"` o `"DEVOLUCION"`. De esto depende a qué cierre le toca el cambio, que
 *  es lo que la pantalla enseña antes de confirmar. Ausente = `"ERROR"`, como en
 *  `AnularPagoInput`.
 */
clase?: string | null } | { tipo: "crear_gasto"; fecha: string; importe: Dinero; pagado_con_caja: boolean } | { tipo: "editar_gasto"; id_gasto: string; fecha: string; importe: Dinero; pagado_con_caja: boolean } | { tipo: "borrar_gasto"; id_gasto: string };

/**
 *  Un ingrediente que se pide distinto en una línea: `tipo` es `"SIN"` o `"EXTRA"`. El nombre va
 *  porque la línea guarda el que tenía al pedirlo (`tpv_domain::ingredientes`).
 */
export type CambioIngredienteInput = {
	id_ingrediente: string,
	nombre: string,
	tipo: string,
};

export type CambioReplicado = {
	/**  None obliga a refrescar todas las consultas: una tabla sin clasificar nunca deja datos viejos. */
	tablas: string[] | null,
	comanda: ComandaReplicada,
};

/**  Lo que se pide desde la barra de arriba. */
export type CambioZoom = "acercar" | "alejar" |
/**  Volver a que lo decida el monitor. */
"automatico";

export type CambioZoomArgs = {
	cambio: CambioZoom,
};

/**
 *  Si el ticket de un cobro se puede canjear por una factura completa (DOC-INC-01). Lo pide
 *  Cuentas al elegir varios tickets para una factura, para no dejar marcar uno que se rechazaría.
 */
export type CanjeableDto = {
	id_pago: string,
	/**  `None` = se puede canjear. Si no, por qué, corto: «Ya facturado: 2026/000026». */
	motivo: string | null,
};

/**  Todas las categorías de ingredientes y todos los ingredientes, cada lista por nombre. */
export type CatalogoIngredientesDto = {
	categorias: CategoriaIngredienteDto[],
	ingredientes: IngredienteDto[],
};

/**  Una categoría de ingredientes (Pan, Salsas, Quesos…). */
export type CategoriaIngredienteDto = {
	ID_Categoria_Ingrediente: string,
	Nombre: string,
};

export type CategoriaInvDto = {
	ID_Categoria: string,
	Nombre: string,
	Nombre_Imagen: string | null,
	Ruta_Imagen: string | null,
	Vendible: number | null,
	Pasa_Cocina: number | null,
};

export type CategoriaProveedorDto = {
	id_categoria: string,
	nombre: string,
	nombre_imagen: string | null,
	ruta_imagen: string | null,
};

export type CategoriaRow = {
	ID_Categoria: string,
	Nombre: string,
	Nombre_Imagen: string | null,
	Ruta_Imagen: string | null,
	Vendible: number | null,
};

export type CategoriaVendibleOut = {
	ID_Categoria: string,
	Nombre: string,
	Ruta_Imagen: string | null,
	Pasa_Cocina: number,
};

export type ChartSerieDinero = {
	labels: string[],
	values: Dinero[],
};

export type ChartSeriesI64 = {
	labels: string[],
	values: number[],
};

/**
 *  Un cierre completo, con su doble recuento. Lo que pinta la ficha del histórico.
 *
 *  Las columnas de siempre son la **foto de esa noche** y no cambian nunca. Si después se corrige un
 *  apunte de su periodo, lo que el cierre marca hoy va en los `rect_*` (CAJA-01).
 */
export type CierreDto = {
	id_cierre: string,
	fecha_hora: string,
	id_usuario: string | null,
	/**  Nombre de quien cerró, resuelto al leer (la fila sólo guarda el id). */
	usuario_nombre: string | null,
	fondo_inicial: Dinero,
	ventas_efectivo: Dinero,
	esperado: Dinero,
	contado: Dinero,
	descuadre: Dinero,
	dejado: Dinero,
	retirado: Dinero,
	motivo: string | null,
	/**  `None` = el cierre sigue en pie (no se ha deshecho). */
	reabierto_en: string | null,
	reabierto_por: string | null,
	/**
	 *  Desde cuándo cuenta este cierre (exclusivo): la hora del cierre anterior. `None` en el
	 *  primero. Es lo que dice a qué cierre pertenece un apunte que se corrige después.
	 */
	periodo_desde: string | null,
	/**  Gastos pagados con dinero del cajón durante el periodo, tal como estaban al cerrar. */
	gastos_caja?: Dinero,
	/**
	 *  Lo que el cierre marca hoy tras corregir apuntes de su periodo. `None` = nunca se ha
	 *  rectificado.
	 */
	rect_ventas_efectivo: Dinero | null,
	rect_gastos_caja: Dinero | null,
	rect_esperado: Dinero | null,
	rect_descuadre: Dinero | null,
	contado_denoms: DenominacionDto[],
	dejado_denoms: DenominacionDto[],
	/**  Cada corrección que cambió sus números, de la más antigua a la más reciente. */
	rectificaciones?: RectificacionDto[],
};

export type CierreIdInput = {
	id_cierre: string,
};

export type CierreListarArgs = {
	limite?: number | null,
};

/**  Un día en que la web no acepta reservas. */
export type CierreReservaWebDto = {
	id_cierre: string,
	dia_ymd: string,
	motivo: string | null,
};

/**  Una fila del histórico. Sin el desglose por denominación, que sólo se pide al abrir la ficha. */
export type CierreResumenDto = {
	id_cierre: string,
	fecha_hora: string,
	usuario_nombre: string | null,
	esperado: Dinero,
	contado: Dinero,
	descuadre: Dinero,
	retirado: Dinero,
	motivo: string | null,
	reabierto_en: string | null,
	/**  CAJA-01: lo que marca hoy si se ha rectificado. */
	rect_esperado: Dinero | null,
	rect_descuadre: Dinero | null,
};

/**  Qué es una factura completa, para nombrarla en la lista. */
export type ClaseFactura =
/**  `F1`: la factura completa de un cobro. */
"factura" |
/**  `R1`..`R5`: corrige otra. */
"rectificativa" |
/**  `F3`: sustituye a uno o varios tickets (o anula una sustitutiva, en negativo). */
"sustitutiva";

/**  La clave pública del negocio y la línea que se pega en su web (`POST /v1/reservas-web/clave`). */
export type ClaveReservaWebDto = {
	clave: string,
	codigo: string,
};

/**  Una página de `/v1/sync/verificar/claves`: claves primarias de una tabla, en orden de clave. */
export type ClavesPagina = {
	tabla: string,
	columnas?: string[],
	claves?: unknown[][],
	/**  La última clave de la página si queda algo detrás; `None` si era la última. */
	siguiente_cursor?: unknown[] | null,
	hasta_seq?: number,
};

/**
 *  El cliente que ya tiene ese teléfono o ese email. Se busca primero por email, que identifica
 *  (índice único), y luego por teléfono. `coincide_por` es `"email"` o `"telefono"`: con el email
 *  no cabe «es otra persona», porque dos clientes no pueden compartirlo.
 */
export type ClienteCoincidente = {
	id_cliente: string,
	nombre: string,
	telefono: string | null,
	email: string | null,
	coincide_por: string,
};

/**  Datos del formulario de edición de un cliente. */
export type ClienteForm = {
	nombre: string,
	email: string | null,
	telefono: string | null,
	notas: string | null,
	/**  FISCAL-02: los datos para facturarle, si los tiene. */
	nif: string | null,
	razon_social: string | null,
	direccion_fiscal: string | null,
};

/**  Argumento con sólo el id de cliente. */
export type ClienteIdArgs = {
	id_cliente: string,
};

/**  Fila del overview de clientes (read model con campos calculados). */
export type ClienteOverview = {
	id_cliente: string,
	nombre: string,
	email: string | null,
	telefono: string | null,
	ultima_reserva_fecha: string | null,
	ultima_reserva_hora: string | null,
	ultima_reserva_num_personas: number | null,
	ultima_reserva_mesa: string | null,
	total_gastado_stored: Dinero,
	total_reservas: number,
	reservas_pendientes: number,
};

/**  Una ficha de cliente, con lo que hace falta para elegirla y facturarle. */
export type ClienteParaFactura = {
	id_cliente: string,
	nombre: string,
	nif: string | null,
	razon_social: string | null,
	direccion_fiscal: string | null,
};

/**  Argumentos del overview. */
export type ClientesOverviewArgs = {
	ranking: string,
};

/**  Las fichas entre las que se elige, y la del cliente de la comanda si se sabe (el de su reserva). */
export type ClientesParaFactura = {
	clientes: ClienteParaFactura[],
	id_cliente_de_la_comanda: string | null,
};

/**  La comanda que se cobra, si la hay: de ella sale su cliente (comanda → reserva → cliente). */
export type ClientesParaFacturaArgs = {
	id_comanda?: string | null,
};

export type ClientesStatsArgs = {
	range: StatsRange,
};

export type ClientesStatsResponse = {
	nuevos: number,
	recurrentes: number,
	no_recurrentes: number,
	ticket_medio_cliente: Dinero,
	nuevos_por_bucket: ChartSeriesI64,
	top_clientes_gasto: ChartSerieDinero,
};

/**  Un cobro visto para devolver parte de él. */
export type CobroDevolubleDto = {
	id_pago: string,
	numero_ticket: string | null,
	/**  El método del cobro: el que la pantalla propone para devolver. */
	metodo: string,
	importe: Dinero,
	/**  Lo ya devuelto por devoluciones parciales vigentes, en positivo. */
	devuelto: Dinero,
	lineas: LineaDevolubleDto[],
};

/**  RI-47: recuperación local compartida. La atribución la fija el backend al preparar el cobro. */
export type CobroPendienteDto = {
	cobro: VrCobrarFraccionadoInput,
	id_usuario: string | null,
	id_trabajador: string | null,
	creado_en_ms: number,
	ultimo_error: string | null,
};

/**
 *  Un código por correo ya va de camino (recuperar el PIN o confirmar un correo de recuperación).
 *  Sólo la pista del correo: el correo entero no sale de la nube.
 */
export type CodigoEnviado = {
	/**  `a***@bar.com`. */
	email_hint: string,
	minutos: number,
	/**  Segundos hasta poder pedir otro. La pantalla cuenta atrás con esto; quien manda es el worker. */
	reenvio_segundos?: number,
	/**
	 *  Sólo al cambiar el correo de recuperación: el pedido ya era el actual, así que no se ha
	 *  enviado nada ni hay que confirmar.
	 */
	sin_cambios?: boolean,
};

export type ComandaBarraRow = {
	ID_Comanda: string,
	Fecha_Hora_Apertura: string,
	Estado: string,
	Total_Pendiente: Dinero,
	Total_Comanda: Dinero,
	Pendientes_Cocina: number,
	Pendientes_Pago: number,
};

/**
 *  La comanda abierta de una mesa con sus líneas: lo que devuelve abrir o retomar la mesa, en un
 *  solo viaje para la Handy (`mesas_abrir_o_retomar`, `/v1/mesas/comandas/abrir-o-retomar`).
 */
export type ComandaConLineasOut = {
	comanda: ComandaRow,
	lineas: MesaLineaComandaRow[],
};

export type ComandaReplicada = {
	ids: string[],
	touchedComanda: boolean,
	uncertain: boolean,
	touchedCatalog: boolean,
};

export type ComandaRow = {
	id_comanda: string,
	id_mesa: string,
	id_trabajador: string | null,
	id_reserva: string | null,
	fecha_hora_apertura: string,
	fecha_hora_cierre: string | null,
	total_comanda: Dinero,
	estado: string,
};

/**
 *  El setup inicial NO lleva PIN actual (REV-06). Ocurre antes del primer login, así que no hay
 *  ninguno que confirmar —el que hay es el del seed, que es público—: quien autoriza es
 *  `Requiere_Setup = 1`. Llegó a viajar un `pin_actual` para el camino de la Handy, que la pantalla
 *  no rellenaba nunca y que sólo servía para que la nube lo verificara sin límite de intentos.
 */
export type CompleteInitialSetupInput = {
	id_usuario: string,
	pin_nuevo: string,
};

export type ConexionHandy = "pausada" | "sin_identidad" | "conectando" | "conectada" | "reintentando" | "rechazada";

export type ConfiguracionPermisos = {
	catalogo: PermisoDef[],
	roles: RolPermisos[],
};

/**  Sólo el código: la dirección que queda confirmada es la que se pidió, guardada en la nube. */
export type ConfirmarCambioCorreoInput = {
	codigo: string,
};

export type ConfirmarCierreInput = {
	/**
	 *  El id del cierre, un UUID que genera la pantalla al abrir el arqueo (RI-58).
	 *
	 *  Es lo que hace idempotente la confirmación: un doble clic o un reintento tras una respuesta
	 *  que no llegó devuelven el cierre ya guardado en vez de crear otro con el periodo vacío.
	 */
	id_cierre: string,
	/**
	 *  Sólo se usa en el primer cierre; en los demás manda el `dejado` del anterior y esto se
	 *  ignora, para que nadie pueda reescribir el punto de partida a posteriori.
	 */
	fondo_inicial?: Dinero | null,
	contado: DenominacionInput[],
	dejado: DenominacionInput[],
	motivo?: string | null,
	/**
	 *  CAJ-INC-01 · El esperado que enseñaba la pantalla al confirmar. **No se guarda**: lo que se
	 *  guarda es lo que recalcula el backend. Si no coincide —un cobro o un gasto entró mientras se
	 *  contaba—, se rechaza para que la pantalla vuelva a preparar y se cuente contra la cifra
	 *  buena. Ausente = no se comprueba.
	 */
	esperado_visto?: Dinero | null,
};

/**
 *  Código y PIN nuevo van JUNTOS, en un solo comando: si verificar el código y guardar el PIN
 *  fueran dos llamadas, cualquiera con el IPC podría hacer sólo la segunda.
 */
export type ConfirmarCodigoPinInput = {
	id_usuario: string,
	codigo: string,
	pin_nuevo: string,
};

/**
 *  SYNC-17: qué hace la Main respecto a la nube. **Ya no es una elección del usuario**: la
 *  conectividad es un estado derivado del WebSocket (se intenta siempre y el badge refleja lo que
 *  hay). Esto es solo la palanca de emergencia, sin UI ni comando, para el caso patológico —una red
 *  que tira el socket en bucle, o alguien que no quiere sus datos en la nube—: se toca a mano, en
 *  el campo `connectivity` de `device_config.json`. Nadie avisa al motor de la réplica: la ve en
 *  su siguiente comprobación (con la sesión abierta, a los 10 s como mucho con actividad y hasta
 *  30 s en reposo; en `Off`, al acabar su espera, de hasta un minuto).
 *
 *  `Auto` (por defecto, y lo que se asume si el campo falta): intentar conectar siempre.
 *  `Off`: no abrir el WebSocket. La Main sigue siendo Local-First y el outbox sigue capturando,
 *  así que al volver a `Auto` se drena lo acumulado.
 */
export type ConnectivityMode = "auto" | "off";

export type ContactSettings = {
	contact_email: string,
	contact_phone: string,
};

export type ContactSettingsPatch = ContactSettingsPatch_Serialize | ContactSettingsPatch_Deserialize;

export type ContactSettingsPatchInput = ContactSettingsPatchInput_Serialize | ContactSettingsPatchInput_Deserialize;

export type ContactSettingsPatchInput_Deserialize = {
	patch: ContactSettingsPatch_Deserialize,
};

export type ContactSettingsPatchInput_Serialize = {
	patch: ContactSettingsPatch_Serialize,
};

export type ContactSettingsPatch_Deserialize = {
	contact_email?: string,
	contact_phone?: string,
};

export type ContactSettingsPatch_Serialize = {
	contact_email?: string,
	contact_phone?: string,
};

/**  REC-INC-01 · Una copia guardada fuera con «Guardar fuera…», y dónde ha quedado. */
export type CopiaExportada = {
	donde: DondeQuedaLaCopia,
};

export type CopySemanaInput = {
	from_monday: string,
	to_monday: string,
	overwrite?: boolean | null,
};

/**
 *  Entrada para emitir una notificación manual (envío desde una pantalla de administración).
 *  El resto de módulos NO usan este DTO: emiten por el puerto `Notifier` en su caso de uso.
 */
export type CrearNotificacionInput = {
	tipo: string,
	severidad?: string | null,
	titulo: string,
	cuerpo?: string | null,
	destino_tipo: string,
	destino_valor?: string | null,
	accion?: string | null,
	/**  JSON (como string) con los datos de la acción. */
	payload?: string | null,
	clave_dedupe?: string | null,
	expira_en?: string | null,
};

/**  Entrada para crear un cliente (Local-First: sin op_id ni outbox). */
export type CreateClienteInput = {
	id_cliente?: string | null,
	nombre: string,
	email?: string | null,
	telefono?: string | null,
	notas?: string | null,
	/**
	 *  FISCAL-02: los datos para facturarle. Opcionales; se normalizan como el destinatario de la
	 *  factura (`tpv_domain::clientes::DatosFiscales`).
	 */
	nif?: string | null,
	razon_social?: string | null,
	direccion_fiscal?: string | null,
};

export type CreateGastoInput = {
	id_gasto?: string | null,
	fecha: string,
	tipo_gasto: string,
	concepto: string,
	importe: Dinero,
	proveedor_id?: string | null,
	/**  CAJA-01: el gasto se pagó con dinero del cajón. Ausente = no. */
	pagado_con_caja?: boolean | null,
};

export type CreateLoteInput = {
	id_lote?: string | null,
	id_producto: string,
	codigo_lote: string,
	caducidad?: string | null,
	stock_disponible: number | null,
	fecha_entrada?: string | null,
	coste_unitario?: Dinero | null,
	id_proveedor?: string | null,
	notas?: string | null,
};

export type CreateTareaInput = {
	titulo: string,
	descripcion?: string | null,
	fecha_limite?: string | null,
	ids_trabajadores?: string[],
};

export type CuentasRangoArgs = {
	del?: string | null,
	al?: string | null,
	/**  Búsqueda de texto (server-side): filtra por fecha/cliente/concepto/método/importe. */
	q?: string | null,
	/**  Tamaño de página. `None`/0 = sin paginar: se devuelven **todas** las filas (el PDF). */
	page_size?: number | null,
	/**
	 *  La página empieza justo después de esta fila (el `siguiente` de la página anterior, ver
	 *  [`CursorCuentas`]). Van planos y no como un objeto porque así los lee el worker, en el
	 *  cuerpo del listado. Sin los dos, es la primera página.
	 */
	cursor_fecha?: string | null,
	cursor_id?: string | null,
};

/**
 *  Dónde empieza la página siguiente de un listado de caja: la clave de orden de la ÚLTIMA fila de
 *  la página actual. Paginar por clave y no por `OFFSET` (RI-18) es lo que hace que la página 100 de
 *  un año cueste lo mismo que la primera: con `OFFSET` había que leer y descartar todo lo anterior.
 *
 *  `fecha` es la columna de orden tal cual (`Pagos.Fecha_Hora` con segundos, `Cuentas_Gastos.Fecha`
 *  sólo el día), no la que se enseña (`fecha_hora`, recortada): con la recortada, dos cobros del
 *  mismo minuto no tendrían un orden estable.
 */
export type CursorCuentas = {
	fecha: string,
	id: string,
};

/**  Los datos de quien reserva. Sólo en un alta, y sólo mientras la Main no la ha registrado. */
export type DatosAltaWebDto = {
	nombre: string,
	email: string,
	telefono: string,
	nota: string | null,
};

export type DeleteGastoInput = {
	id_gasto: string,
};

export type DeleteImageArgs = {
	/**  Ruta relativa tal cual se guarda en BD: `images/{subcarpeta}/{archivo}`. */
	rel_path: string,
};

/**  Una moneda o billete del recuento. */
export type DenominacionDto = {
	valor: Dinero,
	unidades: number,
};

export type DenominacionInput = {
	valor: Dinero,
	unidades: number,
};

/**  Lo que no cuadra en una tabla. */
export type DescuadreTabla = {
	tabla: string,
	/**  Filas que la Main tiene y la nube no. Se suben por estado. */
	faltan: number,
	/**
	 *  Filas que la nube tiene y la Main no. Es un borrado que no llegó a subir: se borran arriba
	 *  sólo si esta Main puede afirmar que está al día.
	 */
	sobran: number,
	/**  Filas que están en los dos sitios con contenido distinto. Se reparan con el de la Main. */
	distintas: number,
};

/**  RELOJ-01 · Cuánto se aparta el reloj de este equipo del de la nube, para el aviso del reloj. */
export type DesfaseReloj = {
	/**
	 *  Milisegundos que hay que sumarle a la hora del equipo para tener la de la nube: positivo, la
	 *  del equipo va atrasada; negativo, adelantada. `None` mientras no haya respondido la nube.
	 */
	desfaseMs: number | null,
};

/**
 *  Datos del cliente para emitir **factura completa** (FISCAL-02).
 *
 *  El registro de facturación guarda el nombre, el NIF y el domicilio en `Destinatario_Json`: el
 *  art. 6 ROF le exige a una factura el domicilio del destinatario, y de ahí sale el papel (RI-29).
 */
export type DestinatarioInput = {
	nombre_razon: string,
	nif: string,
	domicilio?: string | null,
};

/**  El cliente de una factura completa (`F1`/`F3`), tal como sale en el papel. */
export type DestinatarioTicket = DestinatarioTicket_Serialize | DestinatarioTicket_Deserialize;

/**  El cliente de una factura completa (`F1`/`F3`), tal como sale en el papel. */
export type DestinatarioTicket_Deserialize = {
	nombre_razon: string,
	nif: string,
	domicilio?: string | null,
};

/**  El cliente de una factura completa (`F1`/`F3`), tal como sale en el papel. */
export type DestinatarioTicket_Serialize = {
	nombre_razon: string,
	nif: string,
	domicilio?: string | null,
};

/**  Destino de impresión (`caja` | `cocina`). Ausente = `caja`. */
export type DestinoArgs = {
	destino?: string | null,
};

/**  Adónde fueron las líneas de un cobro dado de baja (CAJ-INC-02). */
export type DestinoLineasBaja =
/**
 *  No vuelven: es una devolución (el cliente se llevó la consumición), no se ha dado de baja
 *  nada o no quedaba nada sin cobrar.
 */
"no_vuelven" |
/**  A su comanda, que se ha reabierto. */
"su_comanda" |
/**  A su comanda, que seguía abierta: el cobro era de parte de una cuenta que no se ha cerrado. */
"su_cuenta_abierta" |
/**  A la comanda que ya estaba abierta en la misma mesa, con lo que tenía. */
"la_abierta";

export type DeviceFirmarEmparejamientoArgs = {
	accion: AccionEmparejamiento,
	pair_code: string,
	nonce_b64: string,
};

export type DeviceIdentity = {
	deviceId: string,
	devicePubkeyB64: string,
};

export type DeviceMode = "tpv" | "handy";

/**
 *  La devolución hecha: el pago negativo que la registra y su factura rectificativa, si la hay
 *  (un cobro anterior a la numeración no tiene ninguna que rectificar).
 */
export type DevolucionDto = {
	id_pago: string,
	/**  En negativo, como el pago. */
	importe: Dinero,
	num_factura: string | null,
};

/**  Devolver parte de un cobro. Como al anular, **no lleva quién**: sale de la sesión (SEC-01). */
export type DevolverLineasInput = {
	id_pago: string,
	lineas: LineaADevolverInput[],
	/**
	 *  Por dónde sale el dinero: `Efectivo`, `Tarjeta` u `Otro`. Sólo el efectivo resta del
	 *  arqueo.
	 */
	metodo: string,
	motivo?: string | null,
};

export type Dinero = number & { readonly __centimos: unique symbol };

/**  REC-INC-01 · Dónde ha quedado una copia guardada con «Guardar fuera…». */
export type DondeQuedaLaCopia =
/**
 *  Sigue dentro de este ordenador: el mismo disco de los datos, otra partición, otro disco
 *  interno, o no se ha podido saber. No protege de una avería ni de un robo del equipo, y la
 *  pantalla lo dice.
 */
"en_este_equipo" |
/**  En una unidad que se desconecta del ordenador: un USB, una tarjeta, un disco externo. */
"extraible" |
/**  En una carpeta de otro equipo de la red. */
"en_la_red";

export type EnsureImageArgs = {
	/**  Ruta relativa tal cual se guarda en BD: `images/{subcarpeta}/{archivo}`. */
	rel_path: string,
};

/**
 *  Fila de entradas (cobros). `id` es el `ID_Pago`, como texto.
 *
 *  Los cobros anulados **salen en esta lista** (CUENTA-07): es el único sitio donde se investiga un
 *  descuadre, y ahí esconderlos sería devolver el producto al estado que este cambio arregla. Lo
 *  que no hacen es contar en los totales de cabecera (ver `ResumenCajaDto`).
 */
export type EntradaDto = {
	id: string,
	fecha_hora: string,
	cliente: string,
	metodo: string,
	importe: Dinero,
	/**  `ACTIVO` o `ANULADO`. */
	estado: string,
	anulado_en: string | null,
	/**
	 *  Nombre de quien anuló, resuelto al leer (la fila sólo guarda el id). Es el dato por el que
	 *  se pregunta cuando falta dinero, así que no puede quedarse en un UUID.
	 */
	anulado_por: string | null,
	motivo_anulacion: string | null,
	/**
	 *  Es la devolución de parte de otro cobro: un pago negativo. Se reimprime, pero no se
	 *  factura, ni se edita, ni se da de baja por separado.
	 */
	es_devolucion?: boolean,
	/**
	 *  Lo que se ha devuelto de este cobro con devoluciones parciales vigentes, en positivo. Cero
	 *  si no tiene ninguna.
	 */
	devuelto?: Dinero,
	/**  El motivo de una devolución. */
	motivo_devolucion?: string | null,
};

export type EnviarPedidoEmailInput = {
	email_destino: string,
	nombre_proveedor: string,
	notas?: string | null,
	lineas: LineaEmailInput[],
	/**
	 *  La clave de este envío: la misma mientras se reintenta el mismo pedido (`claveDeEnvio.ts`).
	 *  Si el primer intento llegó a salir y se perdió la respuesta, la nube no lo vuelve a mandar.
	 */
	id_envio: string,
};

/**  Catálogo cerrado de códigos de error. Compartido por Rust, el worker y el frontend. */
export type ErrorCode =
/**  Entrada inválida o regla de dominio incumplida. El detalle va en `message`. */
"validation" |
/**  La entidad pedida no existe. */
"not_found" |
/**  El estado actual no admite la operación (comanda cerrada, stock insuficiente…). */
"conflict" |
/**
 *  Fallo de la base SQLite local de la Main. Sólo lo emite Rust: las bases de la nube (la de
 *  cada negocio, en el SQLite de su Durable Object, y la central, en el objeto `BaseCentral`)
 *  son cosa del worker, que no manda este código.
 */
"repository" |
/**  Fallo de un servicio externo (red, worker, licencias). */
"external" |
/**  Cualquier otro fallo inesperado. */
"internal" |
/**
 *  Emparejamiento Handy todavía sin aprobar en la Main. El polling de `AppBoot`
 *  lo trata como "sigue esperando", no como error: es el caso que obligaba a
 *  existir al antiguo `AppError::Raw`.
 */
"not_approved" |
/**  No hay ninguna Main conectada al TenantHub: las Handy congelan su UI. */
"main_offline" |
/**  El dispositivo fue revocado desde la Main. */
"device_revoked" |
/**  La licencia del tenant está caducada o bloqueada. */
"license_expired" |
/**  No existe licencia activa para este tenant. */
"license_not_found" |
/**
 *  El servidor confirma que el tenant no tiene base de datos aprovisionada. Sólo este caso
 *  permite ofrecer la creación de una base nueva; un timeout o un 500 genérico no.
 */
"tenant_db_not_provisioned" |
/**  El volcado completo excede el límite seguro del Worker. */
"bootstrap_too_large" |
/**  Una migración ya registrada cambió de contenido en el servidor. */
"tenant_migration_altered" |
/**  El fichero elegido no es una copia SQLite íntegra y utilizable. */
"backup_corrupt" |
/**
 *  Quien ha invocado el comando no tiene sesión, o su rol no basta para lo que pide
 *  (SEC-01). La UI ramifica por él para llevar al login en vez de enseñar un fallo
 *  genérico: "no puedes" y "ha fallado" piden cosas distintas de quien está delante.
 */
"permiso_denegado" |
/**
 *  Faltan el NIF o la razón social del obligado (o el NIF no es válido), así que no se puede
 *  generar el registro de facturación — y sin registro no se puede cobrar (art. 9 RRSIF: el
 *  registro se crea de forma simultánea o inmediatamente anterior a la expedición de la factura).
 *
 *  Es la única puerta que Veri*factu añade al camino de la venta. La pantalla **no** ramifica por
 *  él: enseña su mensaje, que dice qué falta, y lo que lleva al formulario de datos fiscales es el
 *  aviso de antes de cobrar (`verifactu_estado`), antes de la primera venta y no a mitad de
 *  servicio. Tiene código propio porque es lo que dice en el registro de fallos por qué no se
 *  cobró, y porque con la remisión (rama `con-verifactu`) el job lo distingue: no remite y lo
 *  dice con un mensaje, no con una traza.
 */
"datos_fiscales_incompletos" |
/**
 *  El importe del cobro **pasa del límite de la factura simplificada** (3.000 € con IVA en
 *  hostelería, art. 4.2 RD 1619/2012) y no se han dado los datos del cliente.
 *
 *  Por encima de esa cifra no cabe una `F2`: la AEAT la rechaza (error 1150), y una `F1` sin
 *  destinatario es imposible (el bloque `Destinatarios` es obligatorio, error 1189). O sea que
 *  no hay ninguna factura que emitir con lo que hay.
 *
 *  Tiene código propio porque la UI **hace algo distinto**: abre el formulario de datos
 *  fiscales y reintenta el mismo cobro con el NIF y el nombre. No es un fallo, es un dato que
 *  falta — y quien lo tiene es el cliente que está delante.
 */
"factura_completa_requerida" |
/**
 *  La reserva **se pisa con otra de la misma mesa**, o la mesa tiene una comanda abierta en ese
 *  rato, y el negocio tiene los solapes en «permitir con aviso» (RI-61).
 *
 *  Tiene código propio porque la UI **hace algo distinto**: enseña el choque y ofrece «guardar
 *  igualmente», que reenvía la misma reserva con `forzar_solape`. Con los solapes prohibidos
 *  el rechazo es un `Conflict` normal: no hay nada que ofrecer.
 */
"reserva_solapada" |
/**
 *  El usuario de la sesión **ya no está activo**: un administrador lo ha desactivado con la
 *  sesión abierta.
 *
 *  Tiene código propio porque la UI **hace algo distinto**: cierra la sesión y el login dice por
 *  qué. Con `PermisoDenegado` la aplicación se quedaba en una pantalla de error sin salida.
 */
"usuario_inactivo";

export type EstadoColaImagenes = {
	pendientes: number,
	total_apartadas: number,
	apartadas: ImagenApartada[],
};

/**  A dónde llegan los códigos para recuperar el PIN. */
export type EstadoCorreoRecuperacion = {
	/**  `a***@bar.com`. */
	email_hint: string,
	/**  `true` mientras nadie lo haya cambiado: es el correo con el que se compró la licencia. */
	es_el_de_la_compra: boolean,
};

/**  ¿Puede facturar el negocio? Lo leen el aviso de datos fiscales y Configuración → Negocio. */
export type EstadoFiscal = {
	/**
	 *  ¿Están el NIF y la razón social configurados? Sin ellos no se puede emitir la factura, y
	 *  por tanto no se puede cobrar.
	 */
	datos_fiscales_completos: boolean,
	nif: string | null,
	razon_social: string | null,
};

/**  RI-31: estado de réplica para la UI, sin SQL ni credenciales. */
export type EstadoReplicacion = {
	revision: number,
	estado: string,
	detalle: string | null,
	fase_recuperacion: string,
	fallos_recuperacion: number,
	/**
	 *  Las Handy siguen retenidas: desde el saludo de esta sesión (que las congela) hasta que la
	 *  Main, con el outbox vacío por primera vez, manda `recovery_ready`. Después, lo que quede por
	 *  subir en uso normal no las retiene. Fuera de `conectado` no significa nada.
	 */
	handy_retenidas: boolean,
};

export type EstadoSocketHandy = {
	revision: number,
	generacion: number,
	conexion: number,
	tenant_id: string | null,
	estado: ConexionHandy,
	main_online: boolean | null,
	volcando: boolean,
	rechazo: RechazoHandy | null,
};

/**  Por qué se emitió una `F3` en negativo. Se deduce de lo que sustituye. */
export type F3Negativa =
/**
 *  Sustituye a la rectificativa (`R5`) de una devolución de un ticket canjeado: es la factura
 *  completa de la devolución, con el cliente (FAQ de la AEAT, apartado 27, casos 2 y 3).
 */
"devolucion" |
/**
 *  Contrarresta una `F3` con los datos del cliente mal; tras ella va la buena con los mismos
 *  tickets (FISCAL-02). No sale dinero.
 */
"correccion_de_datos" |
/**
 *  Saca de una `F3` de varios tickets el de un cobro dado de baja por error: los demás siguen
 *  siendo ventas y esa `F3` no se puede anular.
 */
"baja_por_error";

/**  Una factura completa del cliente. */
export type FacturaDelCliente = {
	/**  El registro de facturación: es lo que se pide para el PDF. */
	id_registro: string,
	num_serie: string,
	/**  La fecha de expedición, `DD-MM-AAAA`, como la declara la factura. */
	fecha_expedicion: string,
	/**  `F1`, `F3` o `R1`..`R5`. */
	tipo_factura: string,
	clase: ClaseFactura,
	importe: Dinero,
	/**
	 *  El cobro con el que se reimprime su papel. `None` si no está en esta base (una `F3` de
	 *  tickets cuyos cobros no han bajado todavía).
	 */
	id_pago: string | null,
	/**
	 *  Anulada después de emitirla (la baja de su cobro por error): fiscalmente ya no existe. La
	 *  lista lo dice; su PDF es el que se emitió, sin marca (`tickets.md`).
	 */
	anulada: boolean,
	/**
	 *  El número de la factura que la sustituye tras corregir los datos del cliente (la
	 *  rectificativa de una `F1`, o la `F3` nueva de una `F3`): ya no es la vigente, y la lista lo
	 *  dice como dice una anulada.
	 */
	sustituida_por: string | null,
	/**
	 *  En la `F3` negativa de esa corrección de una `F3`, el número de la errónea que
	 *  contrarresta: la lista dice lo que es en vez de «Sustitutiva» suelta.
	 */
	contrarresta: string | null,
};

/**  Una factura de un cobro, para elegir qué papel se imprime. */
export type FacturaDelCobro = {
	num_serie: string,
	/**  `F1` | `F2` | `F3` | `R1`..`R5`. */
	tipo_factura: string,
	importe: Dinero,
	/**
	 *  En una `F3` en negativo, qué contrarresta: hay tres que se emiten así y la pantalla tiene
	 *  que llamar a cada una por lo que es. `None` en todas las demás.
	 */
	contrarresta: F3Negativa | null,
};

/**  El PDF de una factura completa. */
export type FacturaPdfArgs = {
	id_registro: string,
};

/**  Las facturas de una ficha, de la más reciente a la más antigua. */
export type FacturasDelCliente = {
	/**  El NIF de la ficha, normalizado. `None` si no tiene: sin él no se sabe cuáles son las suyas. */
	nif: string | null,
	facturas: FacturaDelCliente[],
	/**  Hay más antiguas que no caben en la lista. */
	hay_mas: boolean,
};

/**  Un comando que ha fallado, tal como lo cuenta la pantalla. */
export type FalloDeComando = {
	/**  Nombre del comando (`printer_imprimir_pago`). */
	comando: string,
	code: ErrorCode,
	gravedad: GravedadFallo,
	/**
	 *  El texto del error. Sólo viaja en los de `entorno` y `programa`: el de una respuesta
	 *  esperada puede llevar lo que ha escrito alguien, y para saber que pasa basta el código.
	 */
	mensaje: string | null,
	/**  Ruta de la pantalla desde la que se llamó. */
	pantalla: string | null,
	/**  Lo que tardó el comando en fallar. */
	duracion_ms: number,
	/**  Cuántas veces cuenta este aviso: 1, o las que se juntaron en la ventana de un minuto. */
	veces: number,
};

/**  Una página de `/v1/sync/verificar/filas`: las filas de los cubos que no cuadraban. */
export type FilasDeCubos = {
	tabla: string,
	columnas?: string[],
	filas?: unknown[][],
	/**  `None` = no quedan más. Cualquier otra cosa es «sigue pidiendo desde aquí». */
	siguiente_cursor?: number | null,
	hasta_seq?: number,
};

/**
 *  Respuesta de `/v1/sync/verificar/por-clave`: las filas de unas claves, estén o no en la ventana.
 *  Una clave pedida cuya fila no viene no está en la nube, salvo con `cortada`: entonces lo que no
 *  ha venido se vuelve a pedir.
 */
export type FilasPorClave = {
	tabla: string,
	columnas?: string[],
	filas?: unknown[][],
	cortada?: boolean,
	hasta_seq?: number,
};

export type FinalizarTareaInput = {
	id_tarea: string,
	id_trabajador: string,
};

export type FirmaDispositivo = {
	ts: number,
	sigB64: string,
};

/**
 *  Geometría del papel para preguntar por las columnas desde el frontend (previsualización).
 *  Es un subconjunto de [`PrintTicketPayload`]: la vista previa no necesita ni negocio ni líneas.
 */
export type GeometriaTicket = {
	paper_width_mm?: number,
	chars_per_line?: number,
	margin_left_mm?: number | null,
	margin_right_mm?: number | null,
};

/**
 *  Qué clase de fallo es. La decide la pantalla por el código, con una tabla exhaustiva
 *  (`fallosDeComandos.ts`): un código nuevo no compila hasta que alguien le asigne una.
 */
export type GravedadFallo =
/**  Una respuesta esperada: un dato que no vale, un PIN mal puesto, un permiso que no se tiene. */
"normal" |
/**  Algo de fuera que no es un fallo del programa: la red, la impresora, la Main apagada. */
"entorno" |
/**  Un fallo del programa: hay que mirarlo. */
"programa";

export type GuardarCategoriaIngredienteInput = {
	/**  Sin id, una categoría nueva. */
	id_categoria_ingrediente?: string | null,
	nombre: string,
};

/**
 *  Guardar en la ficha los datos con los que se acaba de facturar. Con `id_cliente`, se actualizan
 *  los de esa ficha; sin él, los de la ficha con ese NIF y, si no hay, se da de alta una con la razón
 *  social de nombre.
 *
 *  `ids_pago` son los cobros que se acaban de facturar: su gasto pasa a esa ficha (FISCAL-03). Quien
 *  pide la factura es quien paga, aunque la mesa fuera de la reserva de otro.
 */
export type GuardarDatosFiscalesInput = {
	id_cliente?: string | null,
	nif: string,
	razon_social: string,
	direccion_fiscal?: string | null,
	ids_pago?: string[],
};

export type GuardarIngredienteInput = {
	/**  Sin id, un ingrediente nuevo. */
	id_ingrediente?: string | null,
	id_categoria_ingrediente: string,
	nombre: string,
};

export type GuardarPermisosInput = {
	id_rol: string,
	permisos_vistos: string[],
	permisos: string[],
};

export type HandySetTokenArgs = {
	token: string,
	tenant_id: string,
};

/**
 *  Una página de `/v1/sync/historico`. `filas` es posicional respecto a `columnas`, igual que en
 *  el volcado; el cursor viaja aparte y **no** es una columna más.
 */
export type HistoricoPagina = {
	tabla: string,
	columnas: string[],
	filas: unknown[][],
	/**  `None` = esta tabla está completa. Cualquier otra cosa es "sigue pidiendo desde aquí". */
	siguiente_cursor: number | null,
};

/**  Marcar libre el día de un trabajador: sustituye lo que tuviera ese día. */
export type HorarioLibreInput = {
	id_trabajador: string,
	fecha: string,
};

export type HorariosSemanaArgs = {
	fecha_lunes: string,
};

export type IdCategoriaArgs = {
	id_categoria: string,
};

export type IdCategoriaIngredienteArgs = {
	id_categoria_ingrediente: string,
};

export type IdIngredienteArgs = {
	id_ingrediente: string,
};

export type IdProductoArgs = {
	id_producto: string,
};

export type ImagenApartada = {
	rel_path: string,
	motivo: string,
};

/**  A qué cierres ya hechos afectaría un cambio de caja, para avisar antes de hacerlo. */
export type ImpactoCajaDto = {
	/**  Vacío = el apunte es del periodo abierto: no hay nada que avisar. */
	cierres: ImpactoCierreDto[],
	/**  Algún descuadre cambia, así que el cambio necesita un motivo. */
	requiere_motivo: boolean,
};

/**  Cómo quedaría un cierre ya hecho si se hace un cambio (CAJA-01). */
export type ImpactoCierreDto = {
	id_cierre: string,
	fecha_hora: string,
	/**  Lo que marca hoy: lo rectificado si lo hay, la foto de esa noche si no. */
	esperado_antes: Dinero,
	esperado_despues: Dinero,
	descuadre_antes: Dinero,
	descuadre_despues: Dinero,
};

export type IndexRow = {
	ID_Comanda: string,
	Productos: string | null,
	NumLineas: number,
	Unidades: number | null,
};

export type IngredienteDto = {
	ID_Ingrediente: string,
	ID_Categoria_Ingrediente: string,
	Nombre: string,
};

/**  Catálogo cerrado de lo que se puede apagar desde la nube. */
export type Interruptor =
/**
 *  La parte que ESCRIBE del contraste con la nube (SYNC-22/24/25): se sigue comparando e
 *  informando, pero no se encola ninguna reparación ni ningún borrado.
 */
"reparacion_nube" |
/**  La descarga del histórico tras una recuperación (SYNC-19, fase 2). */
"backfill_historico" |
/**  La conversión de la PII del personal a texto cifrado (TRAB-03). */
"cifrado_pii" |
/**  La subida de imágenes pendientes a R2. */
"imagenes" |
/**
 *  Las rutas públicas de la reserva desde la web (docs/estudios/reservas-web.md): el widget dice
 *  que ahora no se puede reservar online. Sólo lo mira el worker; lo ya reservado sigue en la
 *  agenda y se entrega a la Main igual.
 */
"reservas_web" |
/**
 *  DO-SUBIDA: la subida completa de la base a una nube devuelta en modo «main». Sólo pausa sus
 *  pasos: el outbox, la bajada y el cobro siguen como siempre, y la subida sigue donde iba.
 */
"subida_nube";

/**  Un interruptor apagado ahora mismo para este equipo, tal como lo devuelve el worker. */
export type InterruptorApagado = {
	interruptor: Interruptor,
	/**  Por qué se apagó. Se enseña en pantalla: lo escribe soporte, no es un identificador. */
	motivo: string,
	/**
	 *  Hasta cuándo (epoch ms). Pasada esta hora vuelve a estar encendido aunque no se sepa nada
	 *  más de la nube: todo interruptor se enciende solo.
	 */
	hasta_ms: number,
};

export type InventarioResumenResponse = {
	proximosCaducar: ProductoResumenDto[],
	menosCantidad: ProductoResumenDto[],
};

/**
 *  Estado de un job periódico. Lo devuelve el comando `jobs_status`, una fila por job registrado
 *  (los que no aplican a este dispositivo —modo o plataforma— ni siquiera aparecen).
 */
export type JobStatus = {
	/**  Identificador estable: es la clave en `_Jobs_State` y lo que aparece en logs y telemetría. */
	nombre: string,
	/**  Cada cuánto vence el job, en segundos. */
	cada_secs: number,
	/**  Último intento, haya ido bien o mal. `null` si no se ha ejecutado nunca en este equipo. */
	last_run_ms: number | null,
	/**
	 *  Última ejecución CORRECTA. Es la que marca el vencimiento del siguiente ciclo, así que
	 *  sobrevive a reinicios de la app y a suspensiones del equipo.
	 */
	last_ok_ms: number | null,
	/**  Error del último intento fallido. `null` si el último intento fue bien. */
	last_error: string | null,
	/**  Fallos consecutivos (0 si el último intento fue bien). El runner los usa para el backoff. */
	fallos: number,
};

export type KitchenRow = {
	ID_Comanda: string,
	/**  `None` en un ticket de barra, que no tiene mesa (RI-69). */
	Numero_Mesa: string | null,
	Fecha_Hora_Apertura: string,
	ID_Detalle: string,
	Cantidad: number | null,
	Nombre_Producto: string,
	Notas: string | null,
	/**  Lo que se pidió distinto (array JSON, ver `MesaLineaComandaRow`). */
	Cambios_Ingredientes: string | null,
	Estado_Cocina: string | null,
	Pagado: number,
};

/**
 *  Datos del formulario de activación. `activation_key` y `business_name` son los únicos
 *  obligatorios; el resto son datos de contacto del negocio.
 */
export type LicenseActivateInput = {
	activation_key: string,
	business_name: string,
	legal_name?: string | null,
	phone?: string | null,
	country?: string | null,
	/**  Código de 6 dígitos del email. Solo hace falta al mover la licencia a otro equipo. */
	device_change_code?: string | null,
};

/**
 *  Resultado de `license_activate`. Si la licencia ya estaba en otro equipo, `outcome` es
 *  `"device_change_required"` y llega la pista del email para pedir el código; en el caso normal
 *  es `"activated"` con el estado ya guardado.
 */
export type LicenseActivateOutcome = LicenseActivateOutcome_Serialize | LicenseActivateOutcome_Deserialize;

/**
 *  Resultado de `license_activate`. Si la licencia ya estaba en otro equipo, `outcome` es
 *  `"device_change_required"` y llega la pista del email para pedir el código; en el caso normal
 *  es `"activated"` con el estado ya guardado.
 */
export type LicenseActivateOutcome_Deserialize = {
	outcome: string,
	state: LicenseLocalState_Deserialize | null,
	email_hint: string | null,
	/**  La licencia se ha trasladado desde otro equipo: los datos de éste se traen de la nube. */
	cambio_de_equipo?: boolean,
	/**
	 *  REV-13 · El código ha sumado su tiempo a la licencia que este equipo ya tenía, en vez de
	 *  estrenar un negocio nuevo. La pantalla lo dice con otras palabras («se han añadido N
	 *  meses») y no hay nada más que hacer.
	 */
	tiempo_sumado?: boolean,
	/**
	 *  AUD-06 · La licencia es de otro negocio que la base de este equipo: los datos del anterior se
	 *  guardan aparte al volver a arrancar, y el TPV se reinicia solo enseguida. La pantalla lo
	 *  avisa y no sigue.
	 */
	reinicia?: boolean,
};

/**
 *  Resultado de `license_activate`. Si la licencia ya estaba en otro equipo, `outcome` es
 *  `"device_change_required"` y llega la pista del email para pedir el código; en el caso normal
 *  es `"activated"` con el estado ya guardado.
 */
export type LicenseActivateOutcome_Serialize = {
	outcome: string,
	state: LicenseLocalState_Serialize | null,
	email_hint: string | null,
	/**  La licencia se ha trasladado desde otro equipo: los datos de éste se traen de la nube. */
	cambio_de_equipo: boolean,
	/**
	 *  REV-13 · El código ha sumado su tiempo a la licencia que este equipo ya tenía, en vez de
	 *  estrenar un negocio nuevo. La pantalla lo dice con otras palabras («se han añadido N
	 *  meses») y no hay nada más que hacer.
	 */
	tiempo_sumado: boolean,
	/**
	 *  AUD-06 · La licencia es de otro negocio que la base de este equipo: los datos del anterior se
	 *  guardan aparte al volver a arrancar, y el TPV se reinicia solo enseguida. La pantalla lo
	 *  avisa y no sigue.
	 */
	reinicia: boolean,
};

/**
 *  Args de `license_request_device_change`: pide al servidor que mande el OTP al email de la
 *  licencia. El `device_id` lo pone el backend (es el de este equipo).
 */
export type LicenseDeviceChangeInput = {
	activation_key: string,
};

export type LicenseGateResult = LicenseGateResult_Serialize | LicenseGateResult_Deserialize;

export type LicenseGateResult_Deserialize = {
	allowed: boolean,
	reason: string,
	state: LicenseLocalState_Deserialize | null,
	/**
	 *  Por qué se quedó este equipo sin licencia, cuando fue el servidor quien la rechazó
	 *  (`revoked`, `device_replaced`, `license_not_found`…). Sólo viene si NO hay `state`: es lo
	 *  que permite que la pantalla de activación explique por qué se está ahí en vez de parecer un
	 *  primer arranque.
	 */
	last_rejection: string | null,
};

export type LicenseGateResult_Serialize = {
	allowed: boolean,
	reason: string,
	state: LicenseLocalState_Serialize | null,
	/**
	 *  Por qué se quedó este equipo sin licencia, cuando fue el servidor quien la rechazó
	 *  (`revoked`, `device_replaced`, `license_not_found`…). Sólo viene si NO hay `state`: es lo
	 *  que permite que la pantalla de activación explique por qué se está ahí en vez de parecer un
	 *  primer arranque.
	 */
	last_rejection: string | null,
};

/**
 *  Estado local NO sensible de la licencia (fichero `license_state.json`). El **token** de sesión
 *  NO está aquí: es una credencial y vive solo en el keyring del SO (ver `device::*_license_token`).
 *  Nada lee el token de este fichero.
 */
export type LicenseLocalState = LicenseLocalState_Serialize | LicenseLocalState_Deserialize;

/**
 *  Estado local NO sensible de la licencia (fichero `license_state.json`). El **token** de sesión
 *  NO está aquí: es una credencial y vive solo en el keyring del SO (ver `device::*_license_token`).
 *  Nada lee el token de este fichero.
 */
export type LicenseLocalState_Deserialize = {
	status: string | null,
	/**  Plan de la licencia (`standard`). Lo refresca `/status`. */
	plan: string | null,
	/**
	 *  RI-36: tiempo sin conexión ya gastado desde la última comprobación correcta, contado de forma
	 *  que atrasar el reloj del equipo no lo devuelva (`tpv_domain::licensing::sumar_tiempo_sin_conexion`).
	 *  `None` en un fichero de antes: cuenta como cero.
	 */
	offline_consumido_ms?: number | null,
	/**  RI-36: hora del reloj de pared de la última vez que se contó ese tiempo. */
	marca_tiempo_ms?: number | null,
} & {
	tenant_id: string,
} | {
	tenantId: string,
} & {
	device_id: string,
} | {
	deviceId: string,
} & {
	/**  Caducidad en texto ISO (informativo para la UI). */
	expires_at: string | null,
} | {
	/**  Caducidad en texto ISO (informativo para la UI). */
	expiresAt: string | null,
} & {
	/**
	 *  Caducidad absoluta en ms. Es el dato con el que la UI calcula los días restantes del
	 *  banner de aviso; lo fija el servidor (firmado) en cada `/status`.
	 */
	expires_at_ms: number | null,
} | {
	/**
	 *  Caducidad absoluta en ms. Es el dato con el que la UI calcula los días restantes del
	 *  banner de aviso; lo fija el servidor (firmado) en cada `/status`.
	 */
	expiresAtMs: number | null,
} & {
	last_server_time_ms: number | null,
} | {
	lastServerTimeMs: number | null,
} & {
	last_check_ok_ms: number | null,
} | {
	lastCheckOkMs: number | null,
} & {
	last_check_attempt_ms: number | null,
} | {
	lastCheckAttemptMs: number | null,
} & {
	activated_at_ms: number,
} | {
	activatedAtMs: number,
};

/**
 *  Estado local NO sensible de la licencia (fichero `license_state.json`). El **token** de sesión
 *  NO está aquí: es una credencial y vive solo en el keyring del SO (ver `device::*_license_token`).
 *  Nada lee el token de este fichero.
 */
export type LicenseLocalState_Serialize = {
	tenant_id: string,
	device_id: string,
	status: string | null,
	/**  Caducidad en texto ISO (informativo para la UI). */
	expires_at: string | null,
	/**
	 *  Caducidad absoluta en ms. Es el dato con el que la UI calcula los días restantes del
	 *  banner de aviso; lo fija el servidor (firmado) en cada `/status`.
	 */
	expires_at_ms: number | null,
	/**  Plan de la licencia (`standard`). Lo refresca `/status`. */
	plan: string | null,
	last_server_time_ms: number | null,
	last_check_ok_ms: number | null,
	last_check_attempt_ms: number | null,
	activated_at_ms: number,
	/**
	 *  RI-36: tiempo sin conexión ya gastado desde la última comprobación correcta, contado de forma
	 *  que atrasar el reloj del equipo no lo devuelva (`tpv_domain::licensing::sumar_tiempo_sin_conexion`).
	 *  `None` en un fichero de antes: cuenta como cero.
	 */
	offline_consumido_ms: number | null,
	/**  RI-36: hora del reloj de pared de la última vez que se contó ese tiempo. */
	marca_tiempo_ms: number | null,
};

/**
 *  Args de `license_sumar_clave` (RI-52): una clave sin estrenar cuyo tiempo se suma a la licencia
 *  de este equipo, desde Configuración → Licencia.
 */
export type LicenseSumarClaveInput = {
	activation_key: string,
};

/**  Unas unidades de una línea que se devuelven. */
export type LineaADevolverInput = {
	id_detalle: string,
	cantidad: number | null,
};

export type LineaComandaRow = {
	ID_Detalle: string,
	ID_Comanda: string,
	ID_Producto: string,
	Cantidad: number | null,
	Precio_Unitario: Dinero,
	/**  Tipo de IVA con el que se vendió la línea (congelado al añadirla); `None` = el del negocio. */
	IVA_Percent: number | null,
	Notas: string | null,
	/**  Lo que se pidió distinto (array JSON de `Detalle_Comanda.Cambios_Ingredientes`). */
	Cambios_Ingredientes: string | null,
	Estado_Cocina: string | null,
	Pagado: number,
	Nombre: string,
	/**
	 *  El nombre de la categoría del producto, con el que el ticket agrupa sus líneas (INC-03).
	 *  `None` si el producto ya no existe.
	 */
	Categoria: string | null,
};

/**  Una línea de un cobro, con lo que queda por devolver de ella. */
export type LineaDevolubleDto = {
	id_detalle: string,
	nombre: string,
	/**  Las unidades que se cobraron (al peso, fraccionarias). */
	cantidad: number | null,
	/**  Las que ya se devolvieron. */
	devueltas: number | null,
	precio_unitario: Dinero,
};

export type LineaEmailInput = {
	nombre_producto: string,
	cantidad: number | null,
	precio_unitario?: Dinero | null,
	unidad?: string | null,
};

export type LineaPedidoDto = {
	id_linea: string,
	nombre_producto: string,
	cantidad: number | null,
	precio_unitario: Dinero | null,
	unidad: string | null,
};

export type LineaPedidoInput = {
	id_linea: string,
	nombre_producto: string,
	cantidad: number | null,
	precio_unitario?: Dinero | null,
	unidad?: string | null,
};

/**  Copia local disponible. `id` es opaco para la UI y sólo puede proceder del listado. */
export type LocalBackupInfo = {
	id: string,
	created_at_ms: number,
	size_bytes: number,
	/**
	 *  La ha traído una persona desde fuera del equipo (un USB). La retención de las copias
	 *  diarias no la alcanza, y la pantalla la distingue: su fecha no dice nada de este disco.
	 */
	importada: boolean,
};

export type LoginOk = {
	id_usuario: string,
	id_trabajador: string | null,
	nombre: string,
	apellido: string | null,
	rol: string,
	email: string,
	requiere_setup: number,
};

export type LoginUserArgs = {
	id_usuario: string,
	pin: string,
};

export type LoteDto = {
	ID_Lote: string,
	ID_Producto: string,
	Codigo_Lote: string,
	Fecha_Entrada: string,
	Caducidad: string | null,
	Stock_Disponible: number | null,
	Coste_Unitario: Dinero | null,
	ID_Proveedor: string | null,
	Notas: string | null,
};

export type MesaDto = {
	id_mesa: string,
	id_zona: string,
	numero_mesa: string,
	capacidad: number,
};

export type MesaIngresoRow = {
	mesa: string,
	zona: string,
	total: Dinero,
};

/**  Línea de comanda de mesa. (`Mesa`-prefijo para no colisionar con la de venta_rapida.) */
export type MesaLineaComandaRow = {
	ID_Detalle: string,
	ID_Comanda: string,
	ID_Producto: string,
	Cantidad: number | null,
	Precio_Unitario: Dinero,
	/**
	 *  Tipo de IVA con el que se vendió la línea (congelado al añadirla). `None` = el general
	 *  del negocio. Va al ticket para desglosar por tipo.
	 */
	IVA_Percent: number | null,
	Notas: string | null,
	/**  Lo que se pidió distinto: el array JSON de `Detalle_Comanda.Cambios_Ingredientes`, tal cual. */
	Cambios_Ingredientes: string | null,
	Estado_Cocina: string | null,
	Nombre: string,
	Pasa_Cocina: number,
	Pagado: number,
};

export type MesaMetaOut = MesaMetaOut_Serialize | MesaMetaOut_Deserialize;

export type MesaMetaOut_Deserialize = {
	ocupada: boolean,
	id_comanda: string,
	idComanda: string,
	totalPendiente: Dinero,
	pendientesPago: number,
	pendientesCocina: number,
	estado: string,
	reserva: ReservaMesaOut | null,
};

export type MesaMetaOut_Serialize = {
	ocupada: boolean,
	id_comanda: string,
	idComanda: string,
	totalPendiente: Dinero,
	pendientesPago: number,
	pendientesCocina: number,
	estado: string,
	reserva?: ReservaMesaOut | null,
};

export type MesasAbrirComandaInput = {
	id_mesa: string,
	id_trabajador?: string | null,
	id_usuario?: string | null,
	id_reserva?: string | null,
};

/**  RI-27: sin precio. El de la línea lo pone el catálogo, no la pantalla. */
export type MesasAddLineaComandaInput = {
	id_comanda: string,
	id_producto: string,
	cantidad: number | null,
	id_usuario?: string | null,
	id_trabajador?: string | null,
};

/**
 *  REV-17: quién cobra sale de la **sesión**, nunca de la entrada (SEC-01).
 *
 *  Es la misma regla que ya aplican anular un cobro, cerrar la caja y abrir el cajón, y faltaba
 *  justo donde más duele: el cobrador que se guarda con el pago es el rastro con el que se
 *  investiga un descuadre del cajón. Firmándolo con lo que le pase la pantalla, quien alcance el
 *  IPC puede cobrar en efectivo a nombre de otro — o sea, la sisa que ese rastro existe para poder
 *  ver. Y no hay sitio donde se cobre sin sesión: a las dos pantallas de venta sólo se llega
 *  pasando el login.
 */
export type MesasCobrarDetallesInput = {
	id_comanda: string,
	metodo: string,
	tipo: string,
	detalle_ids: string[],
	/**
	 *  FISCAL-02: si viene, se emite **factura completa** (`F1`) en vez de un ticket.
	 *
	 *  Se llega aquí por dos caminos: el cliente lo pide («Factura con NIF») o el importe pasa del
	 *  límite de la simplificada y entonces no hay alternativa. Si pasa del límite y esto va vacío,
	 *  el cobro se rechaza con `factura_completa_requerida` y la pantalla pide los datos.
	 */
	destinatario?: DestinatarioInput | null,
	/**
	 *  SYN-INC-05: «Cobrar todo». Si va a `true`, el cobro sólo entra si las líneas que lleva son
	 *  todas las que quedan por cobrar de la comanda: si mientras se cobraba otro equipo añadió una,
	 *  se rechaza (`Conflict`) en vez de cobrar la cuenta vieja y dejar la nueva línea suelta.
	 */
	todo?: boolean,
};

/**
 *  INC-20261030-007: enlazar la reserva que acaba de llegar con la comanda que ya estaba abierta
 *  en su mesa, si el camarero dice que es suya.
 */
export type MesasComandaSetReservaInput = {
	id_comanda: string,
	id_reserva: string,
};

export type MesasComandaSetTrabajadorInput = {
	id_comanda: string,
	id_usuario?: string | null,
	id_trabajador?: string | null,
};

export type MesasDeleteDetalleInput = {
	id_detalle: string,
};

export type MesasIdCategoriaArgs = {
	id_categoria: string,
};

export type MesasIdComandaArgs = {
	id_comanda: string,
};

export type MesasIdMesaArgs = {
	id_mesa: string,
};

export type MesasKitchenSetLineStateInput = {
	id_detalle: string,
	id_usuario_cocinero: string,
	estado: string,
};

/**  El estado del plano: lo de cada mesa (por su id) y cuándo cambiará solo, con la hora. */
export type MesasMetaOut = MesasMetaOut_Serialize | MesasMetaOut_Deserialize;

/**  El estado del plano: lo de cada mesa (por su id) y cuándo cambiará solo, con la hora. */
export type MesasMetaOut_Deserialize = {
	mesas: { [key in string]: MesaMetaOut_Deserialize },
	/**
	 *  MESAS-02 · Segundos hasta que la reserva de alguna mesa cambie con la hora (sus minutos, o
	 *  que aparezca una hora antes); `None` si nada va a cambiar solo. La pantalla relee entonces
	 *  y no cada minuto: en la Handy, cada relectura es una petición al worker.
	 */
	proximo_cambio_s: number | null,
};

/**  El estado del plano: lo de cada mesa (por su id) y cuándo cambiará solo, con la hora. */
export type MesasMetaOut_Serialize = {
	mesas: { [key in string]: MesaMetaOut_Serialize },
	/**
	 *  MESAS-02 · Segundos hasta que la reserva de alguna mesa cambie con la hora (sus minutos, o
	 *  que aparezca una hora antes); `None` si nada va a cambiar solo. La pantalla relee entonces
	 *  y no cada minuto: en la Handy, cada relectura es una petición al worker.
	 */
	proximo_cambio_s: number | null,
};

export type MesasRemoveOnePendingDetalleInput = {
	id_comanda: string,
	id_producto: string,
};

export type MesasSaveLayoutInput = {
	salons: SalonInput[],
};

export type MesasSearchProductosArgs = {
	q?: string | null,
	query?: string | null,
	texto?: string | null,
};

export type MesasSetReservaEstadoInput = {
	id_reserva: string,
	estado: string,
};

export type MesasStatsResponse = {
	total_mesas: number,
	ocupadas: number,
	ticket_medio_por_mesa: Dinero,
	mesa_top_comandas: MesasTopComandas | null,
	servicios: ChartSeriesI64,
	top_mesas_ingresos: MesaIngresoRow[],
};

export type MesasTopComandas = {
	mesa: string,
	zona: string,
	comandas: number,
};

/**
 *  Lo que se pide distinto en una línea, entero: sustituye a lo que hubiera. Vacío, la línea vuelve
 *  a ir como el producto. Vale para mesas y para venta rápida (es la misma tabla).
 */
export type MesasUpdateDetalleIngredientesInput = {
	id_detalle: string,
	cambios?: CambioIngredienteInput[],
};

export type MesasUpdateDetalleNotaInput = {
	id_detalle: string,
	nota?: string | null,
};

/**  Argumento con sólo el id de trabajador (mis tareas). */
export type MisTareasArgs = {
	id_trabajador: string,
};

export type MisTareasRow = {
	ID_Tarea: string,
	Titulo: string,
	Descripcion: string | null,
	Fecha_Limite: string | null,
	Asignada_At: string,
	Estado: string,
	Finalizada_At: string | null,
};

/**
 *  El globito de la campana: cuántas no leídas tiene quien ha iniciado sesión, cuántas puede ver en
 *  total (también las de la papelera) y cuándo se creó la más reciente de ésas (`Creada_En`, la hora
 *  del negocio). El aviso «Tienes una nueva notificación» sale cuando sube el número de no leídas
 *  **y** llega una que no estaba: sube el total, o avanza esa fecha. Restaurar una de la papelera
 *  sube el número, pero ni el total ni la fecha: no es nueva.
 */
export type NoLeidasDto = {
	count: number,
	/**
	 *  Cuántas puede ver, también en la papelera. Una nueva lo sube aunque se haya creado en el mismo
	 *  segundo que la anterior o con un reloj atrasado, que no mueven la fecha.
	 */
	total: number,
	ultima_creada_en: string | null,
};

/**
 *  Identifica una notificación: para marcarla leída y para las acciones de la papelera
 *  (descartar, restaurar, eliminar).
 *
 *  El estado de la papelera es de la NOTIFICACIÓN, no del usuario que la mira: una notificación es
 *  un aviso del negocio (stock bajo, pedido por aprobar) y borrarla es decir "esto ya está visto",
 *  no "no me lo enseñes a mí". Lo que sí es por usuario es la lectura, que tiene su propia tabla. Y
 *  la papelera sólo actúa sobre lo que ve quien la usa.
 */
export type NotificacionIdInput = {
	id_notificacion: string,
};

/**
 *  Fila del centro de notificaciones **para un usuario concreto**: incluye `leida`, que se calcula
 *  respecto a ese usuario (una notificación "a todos" está leída para unos y no para otros).
 */
export type NotificacionRow = {
	id_notificacion: string,
	tipo: string,
	severidad: string,
	titulo: string,
	cuerpo: string | null,
	destino_tipo: string,
	destino_valor: string | null,
	accion: string | null,
	payload: string | null,
	estado: string,
	creada_en: string,
	expira_en: string | null,
	/**  ¿La ha leído el usuario por el que se consulta? */
	leida: boolean,
};

/**  Args para listar las notificaciones visibles de quien ha iniciado sesión. */
export type NotificacionesListArgs = {
	/**  Si es `true`, solo devuelve las no leídas por ese usuario. */
	solo_no_leidas?: boolean | null,
};

/**  Una operación pendiente del outbox (Main → nube). La envía exclusivamente el motor nativo. */
export type OutboxEntry = {
	seq: number,
	op_id: string,
	command_name: string,
	statements: SqlStatement[],
};

/**
 *  Lo que el drenado necesita saber tras un `apply_ack` fallido (SYNC-20): si esta operación se
 *  aparta o se sigue reintentando, y con qué contexto contarlo.
 */
export type OutboxFallo = {
	/**  Rechazos acumulados por esta operación. */
	intentos: number,
	/**  `true` si acaba de apartarse: el drenado debe SEGUIR con la siguiente, no parar. */
	apartada: boolean,
	/**
	 *  Para el informe de telemetría. El `Statements_Json` NO sale de aquí: lleva datos del
	 *  negocio y PII, y lo que hace falta para diagnosticar es qué comando falló, no con qué datos.
	 */
	command_name: string,
	/**
	 *  SYNC-22: filas cuya reparación se ha encolado al apartar esta operación. Cero puede
	 *  significar dos cosas distintas y las dos importan: que no había nada que reparar, o que las
	 *  sentencias no se supieron leer (queda en el log). Nunca significa "ya está igualado": eso
	 *  sólo lo prueba que la reparación llegue a subir.
	 */
	reparadas: number,
};

/**  Una página de entradas. `siguiente` es `None` cuando no hay más filas (o no se pidió paginar). */
export type PaginaEntradas = {
	filas: EntradaDto[],
	siguiente: CursorCuentas | null,
};

/**  Una página de salidas. Ver [`PaginaEntradas`]. */
export type PaginaSalidas = {
	filas: SalidaDto[],
	siguiente: CursorCuentas | null,
};

/**
 *  Resultado de `POST /v1/pair/create`: código de emparejamiento recién generado por el
 *  worker. Campos en camelCase, como los manda el worker y los lee la pantalla (`pairCode`,
 *  `pairSecret`, `expiresAtMs`).
 */
export type PairCreateResult = {
	ok: boolean,
	pairCode: string,
	pairSecret: string,
	expiresAtMs: number,
};

/**
 *  El paquete ya compuesto. Nunca es un error: lo que no se ha podido leer va dentro, explicado, y
 *  su nombre en `secciones_con_error`.
 */
export type PaqueteDiagnostico = {
	/**  Nombre propuesto para el fichero (`diagnostico-tpv-20261120-1030.json`). */
	nombre_fichero: string,
	/**  El fichero entero: JSON legible, ya filtrado de datos personales y acotado de tamaño. */
	contenido: string,
	/**  Las partes que no se han podido leer (su motivo va dentro del paquete). */
	secciones_con_error: string[],
};

export type PedidoProveedorDto = {
	id_pedido: string,
	id_proveedor: string | null,
	nombre_proveedor: string | null,
	email_destino: string | null,
	estado: string,
	fecha_creacion: string,
	fecha_envio: string | null,
	notas: string | null,
	lineas: LineaPedidoDto[],
};

export type PedidosActualizarInput = {
	id_pedido: string,
	id_proveedor?: string | null,
	email_destino?: string | null,
	notas?: string | null,
	lineas: LineaPedidoInput[],
};

export type PedidosCambiarEstadoInput = {
	id_pedido: string,
	estado: string,
	fecha_envio?: string | null,
};

export type PedidosCrearInput = {
	id_pedido: string,
	id_proveedor?: string | null,
	email_destino?: string | null,
	notas?: string | null,
	lineas: LineaPedidoInput[],
};

export type PedidosGetPageInput = {
	limit: number,
	offset: number,
	search?: string | null,
};

/**
 *  Página de pedidos (PROV-03): el listado se sirve paginado en vez de cargar todos los
 *  pedidos y toda la tabla de líneas en memoria. `total` es el nº de pedidos que casan con
 *  el filtro (para saber si quedan más páginas).
 */
export type PedidosPageDto = {
	pedidos: PedidoProveedorDto[],
	total: number,
};

/**  La respuesta de `POST /v1/reservas-web/pendientes`. */
export type PendientesReservaWebDto = {
	peticiones: PeticionReservaWebDto[],
	/**  Quedan más: la Main vuelve a pedir después de contestar éstas. */
	hay_mas: boolean,
};

export type PermisoDef = {
	codigo: string,
	nombre: string,
	grupo: string,
};

/**
 *  Una petición de la agenda para la Main: un alta (con el `ID_Reserva` que puso la agenda) o la
 *  cancelación de una que ya le entregó.
 */
export type PeticionReservaWebDto = {
	id_peticion: string,
	tipo: TipoPeticionWeb,
	id_reserva: string,
	id_mesa: string | null,
	dia_ymd: string,
	hora: string,
	personas: number,
	/**  El instante del alta en la hora del negocio: el `Created_At` que escribe la Main. */
	creada_local: string,
	datos: DatosAltaWebDto | null,
};

/**  Lo que la pantalla necesita saber **antes** de que nadie cuente nada. */
export type PreparacionCierreDto = {
	/**
	 *  Desde cuándo está abierto el periodo. `None` = no hay ningún cierre previo, así que éste es
	 *  el primero y la pantalla tiene que pedir además el fondo de partida.
	 */
	desde: string | null,
	/**  `true` en el primer cierre de la vida del negocio. */
	es_primer_cierre: boolean,
	/**  Lo que dejó el cierre anterior. En el primero es 0 y lo declara el usuario. */
	fondo_inicial: Dinero,
	ventas_efectivo: Dinero,
	/**  Gastos del periodo pagados con dinero del cajón (CAJA-01). Restan del esperado. */
	gastos_caja: Dinero,
	esperado: Dinero,
	/**
	 *  Mesas abiertas con algo sin cobrar ahora mismo (CAJ-INC-04). No impide cerrar: se avisa y
	 *  se sigue. Una mesa abierta sin nada pendiente no cuenta.
	 */
	mesas_sin_cobrar: number,
	/**  Tickets de barra abiertos con algo sin cobrar. Un ticket vacío no cuenta. */
	tickets_sin_cobrar: number,
	/**  A partir de cuánto descuadre hay que escribir un motivo. */
	umbral_descuadre: Dinero,
	/**
	 *  Cobros anulados durante este periodo. **No entran en el cálculo** (el esperado sale de los
	 *  cobros activos, como siempre): es una línea informativa. Y es justo el dato que no existía
	 *  antes de CUENTA-07 — un descuadre de 40 € junto a "3 anulaciones por 40 €" se explica solo.
	 */
	anulaciones: number,
	anulaciones_importe: Dinero,
	/**
	 *  DO-02 · El histórico de una recuperación que todavía se está descargando, cuando por eso el
	 *  esperado puede salir corto: en el primer cierre, que suma desde el principio, y la
	 *  recuperación sólo trajo lo reciente. Con un cierre anterior no pasa: la recuperación trae
	 *  siempre todo lo que hay desde él. `None` = nada que avisar. **No impide cerrar.**
	 */
	historico_pendiente: BackfillEstado | null,
};

/**  Lo que hace falta para imprimir un arqueo. CUENTA-06. */
export type PrintArqueoPayload = {
	printer_name?: string | null,
	business_name?: string,
	fecha_hora?: string,
	desde?: string | null,
	usuario?: string | null,
	fondo_inicial?: Dinero,
	ventas_efectivo?: Dinero,
	esperado?: Dinero,
	contado?: Dinero,
	descuadre?: Dinero,
	dejado?: Dinero,
	retirado?: Dinero,
	motivo?: string | null,
	/**  Gastos pagados con dinero del cajón (CAJA-01). Restan del esperado. */
	gastos_caja?: Dinero,
	/**  Lo que el cierre marca hoy, si se corrigió un apunte de su periodo (CAJA-01). */
	rect_esperado?: Dinero | null,
	rect_descuadre?: Dinero | null,
	rectificaciones?: RectificacionArqueo[],
	/**
	 *  `(valor, unidades)` de lo contado, para el desglose. Las unidades de un recuento no pasan
	 *  de 2^53, así que viajan como `number` y no como `bigint` (§4.3).
	 */
	contado_denoms?: ([Dinero, number])[],
	paper_width_mm?: number,
	paper_dpi?: number,
	chars_per_line?: number,
	margin_left_mm?: number | null,
	margin_right_mm?: number | null,
	margin_top_mm?: number | null,
	margin_bottom_mm?: number | null,
};

/**  Una línea (producto agrupado) del ticket. */
export type PrintTicketLine = PrintTicketLine_Serialize | PrintTicketLine_Deserialize;

/**  Una línea (producto agrupado) del ticket. */
export type PrintTicketLine_Deserialize = {
	nombre: string,
	cantidad: number,
	precio_unitario: Dinero,
	/**
	 *  Tipo de IVA con el que se vendió esta línea. `None` = el general del negocio.
	 *  Viene congelado de `Detalle_Comanda`, no del producto: una reimpresión tiene que enseñar
	 *  el tipo del día de la venta.
	 */
	iva_percent?: number | null,
};

/**  Una línea (producto agrupado) del ticket. */
export type PrintTicketLine_Serialize = {
	nombre: string,
	cantidad: number,
	precio_unitario: Dinero,
	/**
	 *  Tipo de IVA con el que se vendió esta línea. `None` = el general del negocio.
	 *  Viene congelado de `Detalle_Comanda`, no del producto: una reimpresión tiene que enseñar
	 *  el tipo del día de la venta.
	 */
	iva_percent?: number | null,
};

/**
 *  Todo lo que lleva un papel: los datos del negocio, la personalización y el contenido.
 *
 *  **El ticket de un cobro lo compone Rust desde la base** (`ticket_de_pago`, RI-29): las líneas
 *  de `Pago_Detalles`, y el número, la fecha, el desglose y el total del registro de
 *  facturación. La pantalla lo recibe sólo para enseñarlo. Lo único que la pantalla compone es la
 *  **precuenta**, y el comando que la imprime le quita todo lo fiscal (`como_precuenta`): un papel
 *  con número no puede salir de lo que diga la pantalla.
 */
export type PrintTicketPayload = PrintTicketPayload_Serialize | PrintTicketPayload_Deserialize;

/**
 *  Todo lo que lleva un papel: los datos del negocio, la personalización y el contenido.
 *
 *  **El ticket de un cobro lo compone Rust desde la base** (`ticket_de_pago`, RI-29): las líneas
 *  de `Pago_Detalles`, y el número, la fecha, el desglose y el total del registro de
 *  facturación. La pantalla lo recibe sólo para enseñarlo. Lo único que la pantalla compone es la
 *  **precuenta**, y el comando que la imprime le quita todo lo fiscal (`como_precuenta`): un papel
 *  con número no puede salir de lo que diga la pantalla.
 */
export type PrintTicketPayload_Deserialize = {
	/**  Impresora destino; si es `None`, el comando resuelve la seleccionada en `device_config.json`. */
	printer_name?: string | null,
	business_name?: string,
	direccion?: string,
	telefono?: string,
	/**
	 *  NIF del emisor. En una factura es el del registro (`NIF_Emisor`), no el de los ajustes de
	 *  hoy: una reimpresión dice lo que se declaró.
	 */
	cif?: string,
	/**
	 *  Razón social del emisor (`Nombre_Razon_Emisor` en una factura). No es el rótulo
	 *  (`business_name`) y, a diferencia de él, no se puede ocultar.
	 */
	razon_social?: string,
	mensaje_footer?: string,
	iva_percent?: number | null,
	show_logo?: boolean,
	/**
	 *  Ruta relativa del logo en AppData (`images/…`) o un data URL heredado. La lee el comando,
	 *  no el builder: aquí dentro no se toca el disco.
	 */
	logo_path?: string | null,
	show_business_name?: boolean,
	show_address?: boolean,
	show_phone?: boolean,
	show_footer_message?: boolean,
	/**  Ancho de papel en mm (58 / 80 / 112). Acota físicamente las columnas imprimibles. */
	paper_width_mm?: number,
	/**  DPI de la impresora (203 | 300). Convierte mm→dots para márgenes y ancho útil. */
	paper_dpi?: number,
	/**  Caracteres por línea deseados (fuente A). Se acota al ancho físico disponible. */
	chars_per_line?: number,
	margin_top_mm?: number | null,
	margin_bottom_mm?: number | null,
	margin_left_mm?: number | null,
	margin_right_mm?: number | null,
	/**  Escala de fuente (0.5–2.0). ≥1.5 imprime el cuerpo a doble alto (sin perder columnas). */
	font_scale?: number | null,
	/**
	 *  Número correlativo del ticket. `None` = **precuenta**: lo que se le enseña al cliente antes
	 *  de cobrar, que no es un ticket de venta y se marca como tal.
	 */
	numero_ticket?: string | null,
	/**
	 *  La fecha que se imprime (`DD/MM/AAAA HH:MM`). En una factura es la de expedición, leída
	 *  del registro: una copia de mañana dice el día de la venta. `None` = ahora (la precuenta).
	 */
	fecha?: string | null,
	/**  Cómo se cobró (`Efectivo` | `Tarjeta`). `None` en una precuenta. */
	metodo_pago?: string | null,
	/**  De dónde sale la venta: `Mesa 5`, `Barra`… Ayuda a localizar el cobro después. */
	origen?: string | null,
	/**
	 *  Reimpresión de un ticket ya emitido: sale el MISMO número, marcado como copia para que dos
	 *  papeles iguales no parezcan dos ventas.
	 */
	es_copia?: boolean,
	/**
	 *  El cobro está anulado (CUENTA-07). Reimprimirlo sigue permitido —es la prueba de qué
	 *  contenía— pero el papel tiene que decirlo: sin la marca circularía como un cobro válido.
	 */
	es_anulado?: boolean,
	/**
	 *  Si el papel lleva el pulso que abre el cajón. Sólo el ticket ORIGINAL de un cobro en
	 *  efectivo, que es cuando hay que meter el dinero y dar el cambio: ni una copia, ni la `F3` de
	 *  un canje, ni una rectificativa, ni una precuenta. Lo decide `ticket_de_pago`, no el
	 *  generador.
	 */
	abre_cajon?: boolean,
	items?: PrintTicketLine_Deserialize[],
	/**
	 *  El desglose de IVA de la factura, leído de su `Desglose_Json`. Es el hecho fiscal: el papel
	 *  dice lo que se declaró, no un recálculo. `None` = se calcula de las líneas (la precuenta).
	 */
	desglose?: TramoTicket[] | null,
	/**  El `Importe_Total` de la factura. `None` = la suma de las líneas (la precuenta). */
	total?: Dinero | null,
	/**  `F1` | `F2` | `F3`. Una completa (`F1`/`F3`) sale titulada FACTURA y con su cliente. */
	tipo_factura?: string | null,
	/**  El cliente de una factura completa, leído de su registro. */
	destinatario?: DestinatarioTicket_Deserialize | null,
	/**
	 *  En una `F3`, los números de las facturas que sustituye: el ticket que canjea, los de un
	 *  canje de varios o, tras una devolución, la rectificativa.
	 */
	sustituye?: string[],
	/**
	 *  En una rectificativa, el número de la factura que rectifica (art. 7.1.h y 15.4 del RD
	 *  1619/2012: la referencia «expresa e inequívoca» de la factura rectificada).
	 */
	rectifica?: string | null,
	/**  La fecha de expedición de la factura rectificada (`DD/MM/AAAA`). */
	rectifica_fecha?: string | null,
	/**
	 *  Todas las facturas del cobro. **No se imprime**: la pantalla lo usa para ofrecer cada papel
	 *  (el ticket, la `F3` del canje, la rectificativa de una devolución…).
	 */
	facturas_del_cobro?: FacturaDelCobro[],
};

/**
 *  Todo lo que lleva un papel: los datos del negocio, la personalización y el contenido.
 *
 *  **El ticket de un cobro lo compone Rust desde la base** (`ticket_de_pago`, RI-29): las líneas
 *  de `Pago_Detalles`, y el número, la fecha, el desglose y el total del registro de
 *  facturación. La pantalla lo recibe sólo para enseñarlo. Lo único que la pantalla compone es la
 *  **precuenta**, y el comando que la imprime le quita todo lo fiscal (`como_precuenta`): un papel
 *  con número no puede salir de lo que diga la pantalla.
 */
export type PrintTicketPayload_Serialize = {
	/**  Impresora destino; si es `None`, el comando resuelve la seleccionada en `device_config.json`. */
	printer_name?: string | null,
	business_name: string,
	direccion: string,
	telefono: string,
	/**
	 *  NIF del emisor. En una factura es el del registro (`NIF_Emisor`), no el de los ajustes de
	 *  hoy: una reimpresión dice lo que se declaró.
	 */
	cif: string,
	/**
	 *  Razón social del emisor (`Nombre_Razon_Emisor` en una factura). No es el rótulo
	 *  (`business_name`) y, a diferencia de él, no se puede ocultar.
	 */
	razon_social: string,
	mensaje_footer: string,
	iva_percent: number | null,
	show_logo: boolean,
	/**
	 *  Ruta relativa del logo en AppData (`images/…`) o un data URL heredado. La lee el comando,
	 *  no el builder: aquí dentro no se toca el disco.
	 */
	logo_path?: string | null,
	show_business_name: boolean,
	show_address: boolean,
	show_phone: boolean,
	show_footer_message: boolean,
	/**  Ancho de papel en mm (58 / 80 / 112). Acota físicamente las columnas imprimibles. */
	paper_width_mm: number,
	/**  DPI de la impresora (203 | 300). Convierte mm→dots para márgenes y ancho útil. */
	paper_dpi: number,
	/**  Caracteres por línea deseados (fuente A). Se acota al ancho físico disponible. */
	chars_per_line: number,
	margin_top_mm: number | null,
	margin_bottom_mm: number | null,
	margin_left_mm: number | null,
	margin_right_mm: number | null,
	/**  Escala de fuente (0.5–2.0). ≥1.5 imprime el cuerpo a doble alto (sin perder columnas). */
	font_scale: number | null,
	/**
	 *  Número correlativo del ticket. `None` = **precuenta**: lo que se le enseña al cliente antes
	 *  de cobrar, que no es un ticket de venta y se marca como tal.
	 */
	numero_ticket?: string | null,
	/**
	 *  La fecha que se imprime (`DD/MM/AAAA HH:MM`). En una factura es la de expedición, leída
	 *  del registro: una copia de mañana dice el día de la venta. `None` = ahora (la precuenta).
	 */
	fecha?: string | null,
	/**  Cómo se cobró (`Efectivo` | `Tarjeta`). `None` en una precuenta. */
	metodo_pago?: string | null,
	/**  De dónde sale la venta: `Mesa 5`, `Barra`… Ayuda a localizar el cobro después. */
	origen?: string | null,
	/**
	 *  Reimpresión de un ticket ya emitido: sale el MISMO número, marcado como copia para que dos
	 *  papeles iguales no parezcan dos ventas.
	 */
	es_copia: boolean,
	/**
	 *  El cobro está anulado (CUENTA-07). Reimprimirlo sigue permitido —es la prueba de qué
	 *  contenía— pero el papel tiene que decirlo: sin la marca circularía como un cobro válido.
	 */
	es_anulado: boolean,
	/**
	 *  Si el papel lleva el pulso que abre el cajón. Sólo el ticket ORIGINAL de un cobro en
	 *  efectivo, que es cuando hay que meter el dinero y dar el cambio: ni una copia, ni la `F3` de
	 *  un canje, ni una rectificativa, ni una precuenta. Lo decide `ticket_de_pago`, no el
	 *  generador.
	 */
	abre_cajon: boolean,
	items: PrintTicketLine_Serialize[],
	/**
	 *  El desglose de IVA de la factura, leído de su `Desglose_Json`. Es el hecho fiscal: el papel
	 *  dice lo que se declaró, no un recálculo. `None` = se calcula de las líneas (la precuenta).
	 */
	desglose?: TramoTicket[] | null,
	/**  El `Importe_Total` de la factura. `None` = la suma de las líneas (la precuenta). */
	total?: Dinero | null,
	/**  `F1` | `F2` | `F3`. Una completa (`F1`/`F3`) sale titulada FACTURA y con su cliente. */
	tipo_factura?: string | null,
	/**  El cliente de una factura completa, leído de su registro. */
	destinatario?: DestinatarioTicket_Serialize | null,
	/**
	 *  En una `F3`, los números de las facturas que sustituye: el ticket que canjea, los de un
	 *  canje de varios o, tras una devolución, la rectificativa.
	 */
	sustituye: string[],
	/**
	 *  En una rectificativa, el número de la factura que rectifica (art. 7.1.h y 15.4 del RD
	 *  1619/2012: la referencia «expresa e inequívoca» de la factura rectificada).
	 */
	rectifica?: string | null,
	/**  La fecha de expedición de la factura rectificada (`DD/MM/AAAA`). */
	rectifica_fecha?: string | null,
	/**
	 *  Todas las facturas del cobro. **No se imprime**: la pantalla lo usa para ofrecer cada papel
	 *  (el ticket, la `F3` del canje, la rectificativa de una devolución…).
	 */
	facturas_del_cobro: FacturaDelCobro[],
};

/**  Una impresora detectada por el sistema. */
export type PrinterInfo = {
	name: string,
	is_default: boolean,
};

export type ProductDetailResponse = {
	producto: ProductoBaseDto | null,
	alergenos: AlergenoInvDto[],
};

export type ProductoBaseDto = {
	ID_Producto: string,
	ID_Categoria: string,
	ID_Proveedor: string | null,
	Nombre: string,
	Precio_Venta: Dinero | null,
	Stock_Minimo: number | null,
	Unidad_Medida: string | null,
	Nombre_Imagen: string | null,
	Ruta_Imagen: string | null,
	Cantidad_Pedido_Esperada: number | null,
	/**  VR-04: stock "suelto" fuera de lotes. `None` = el producto no lo usa. Puede ser negativo. */
	Stock_Suelto: number | null,
	/**
	 *  Tipo de IVA propio. `None` = hereda el del negocio (lo normal en hostelería: el consumo
	 *  en local va todo al tipo reducido). Se fija solo en lo que tributa distinto.
	 */
	IVA_Percent: number | null,
};

export type ProductoDetalleDto = {
	alergs: AlergenoMiniDto[],
} & ProductoBaseDto;

export type ProductoListDto = {
	Stock_Actual: number | null,
	Caducidad_Proxima: string | null,
	Lote_Proximo: string | null,
} & ProductoBaseDto;

export type ProductoProveedorDto = {
	id_producto: string,
	id_categoria: string | null,
	id_proveedor: string | null,
	nombre: string,
	precio_venta: Dinero | null,
	stock_actual: number | null,
	stock_minimo: number | null,
	unidad_medida: string | null,
	nombre_imagen: string | null,
	ruta_imagen: string | null,
	cantidad_pedido_esperada: number | null,
	ultima_entrada: string | null,
	caducidad_proxima: string | null,
};

export type ProductoResumenDto = {
	Nombre: string,
	Stock_Actual: number | null,
	Unidad_Medida: string | null,
	Caducidad_Proxima: string | null,
	Lote: string | null,
	Precio_Venta: Dinero | null,
};

export type ProductoRow = {
	ID_Producto: string,
	ID_Categoria: string,
	Nombre: string,
	Precio_Venta: Dinero,
	Stock_Actual: number | null,
	Stock_Minimo: number | null,
	Unidad_Medida: string | null,
	Nombre_Imagen: string | null,
	Ruta_Imagen: string | null,
};

export type ProductoVendibleOut = {
	ID_Producto: string,
	ID_Categoria: string,
	Nombre: string,
	Precio_Venta: Dinero,
	Ruta_Imagen: string | null,
};

export type ProductosStatsArgs = {
	range: StatsRange,
	categoria_top_id: string | null,
	categoria_worst_id: string | null,
};

export type ProductosStatsResponse = {
	mejor_producto: string | null,
	peor_producto_vendible: string | null,
	top10_mejores: ChartSeriesI64,
	top10_peores: ChartSeriesI64,
};

export type ProveedorDto = {
	id_proveedor: string,
	nombre_empresa: string,
	contacto: string | null,
	telefono: string | null,
	email: string | null,
	cif: string | null,
	informacion_adicional: string | null,
	nombre_imagen: string | null,
	ruta_imagen: string | null,
};

export type ProveedorMiniDto = {
	ID_Proveedor: string,
	Nombre_Empresa: string,
	Email: string | null,
};

export type ProveedorSaveInput = {
	id_proveedor?: string | null,
	nombre_empresa: string,
	contacto?: string | null,
	telefono?: string | null,
	email?: string | null,
	cif?: string | null,
	informacion_adicional?: string | null,
	nombre_imagen?: string | null,
	ruta_imagen?: string | null,
};

export type ProveedorTop = {
	nombre: string,
	total: Dinero,
};

export type ProveedoresDeleteInput = {
	id_proveedor: string,
};

export type ProveedoresGetProductosArgs = {
	id_proveedor: string,
};

export type ProveedoresSetVinculosInput = {
	id_proveedor: string,
	producto_ids: string[],
};

export type ProveedoresStatsArgs = {
	range: StatsRange,
};

export type ProveedoresStatsResponse = {
	total_gasto: Dinero,
	num_gastos: number,
	gasto_medio: Dinero,
	porcentaje_sobre_total_gastos: number | null,
	proveedor_top: ProveedorTop | null,
	gastos_evolucion: ChartSerieDinero,
	gasto_por_proveedor: ChartSerieDinero,
	ultimos_gastos: UltimoGastoProveedor[],
};

/**
 *  El fichaje NO lleva fecha ni hora: las pone el equipo que ficha — la Main con su reloj, y la
 *  Handy con el suyo vía `X-Client-Now` (CFG-04/REV-03). Estuvieron aquí, el TPV las calculaba y
 *  las mandaba en cada fichaje, y los cuatro sitios que las recibían las descartaban. Un campo que
 *  se envía y nadie lee es peor que no tenerlo: el día que alguien lo cablee, el control horario
 *  pasa a creerse un valor del cuerpo de la petición, que es cualquier cosa.
 */
export type PunchInput = {
	id_usuario: string,
	pin: string,
	tipo: string,
};

export type PunchParte = {
	parte: number,
	entrada: string | null,
	salida: string | null,
	estado: string,
};

export type PunchStatus = {
	fecha: string,
	turno_partido: number,
	partes: PunchParte[],
	/**
	 *  La jornada es de un día anterior al de hoy (un turno de noche en curso). Lo decide el
	 *  backend con el mismo «hoy» con el que eligió la jornada, no la pantalla con el reloj del
	 *  dispositivo, que en otra zona o cerca de medianoche decía «Jornada de ayer» de la de hoy
	 *  (AUT-INC-02).
	 *
	 *  `default`: una Handy actualizada antes que el worker recibe el estado sin este campo, y sin
	 *  el `default` no podía leerlo y nadie podía fichar ni entrar. Ausente = la de hoy.
	 */
	jornada_anterior?: boolean,
};

export type PunchStatusArgs = {
	id_usuario: string,
};

export type PuntualidadInfo = {
	puntual: boolean,
	programado: string,
	entrada: string,
	minutos_retraso: number,
};

export type RechazoHandy = "dispositivo" | "licencia";

/**  Una línea de `POST /v1/reservas-web/recogidas`. */
export type RecogidaReservaWebDto = {
	id_peticion: string,
	resultado: ResultadoRecogidaWeb,
	/**  En una `fallida`, el código del error (nunca su texto, que podría llevar datos). */
	codigo: string | null,
};

/**  El cuerpo de `POST /v1/reservas-web/recogidas`. */
export type RecogidasReservaWebInput = {
	resultados: RecogidaReservaWebDto[],
};

/**  Estado que decide si la aplicación puede abrir el login o debe permanecer bloqueada. */
export type RecoveryState = "ready" | "data_missing" | "reconciliation_pending" |
/**
 *  La licencia se trasladó a este equipo desde otro. Lo que tenga la base local es de antes
 *  del traslado, así que no se puede trabajar con ella: se reconstruye desde la nube, igual que
 *  un equipo nuevo. Sólo con la nube — una copia local también sería de antes.
 */
"transfer_pending" |
/**
 *  SYNC-32 · La base de este equipo se cambió por fuera del programa y es anterior a lo que la
 *  nube ya ha purgado: no se puede poner al día con ella. Como en un traslado, lo que tenía
 *  pendiente se guarda aparte y se reconstruye desde la nube. Sólo con la nube.
 */
"older_than_cloud";

export type RecoveryStatus = {
	state: RecoveryState,
};

/**  Una corrección de un cierre ya hecho, tal como sale en el papel (CAJA-01). */
export type RectificacionArqueo = {
	fecha_hora?: string,
	descripcion?: string,
	motivo?: string | null,
};

/**  Una corrección de un apunte que cambió los números de un cierre ya hecho (CAJA-01). */
export type RectificacionDto = {
	id_rectificacion: string,
	fecha_hora: string,
	/**  Nombre de quien corrigió, resuelto al leer. */
	usuario_nombre: string | null,
	/**  Qué se tocó, en una frase: «Cobro 2026/000045 de 12,50 €: Efectivo → Tarjeta». */
	descripcion: string,
	motivo: string | null,
	esperado_antes: Dinero,
	esperado_despues: Dinero,
	descuadre_antes: Dinero,
	descuadre_despues: Dinero,
};

export type ReintentarImagenArgs = {
	rel_path: string,
};

/**
 *  RI-61: ¿el teléfono o el email que se acaban de escribir ya son de un cliente? Se pregunta antes
 *  de guardar, para que la pantalla ofrezca asignarle la reserva en vez de hacerlo por detrás.
 */
export type ReservaBuscarClienteArgs = {
	telefono?: string | null,
	email?: string | null,
};

/**
 *  Cancelar una reserva que aún no ha llegado: se queda en la lista, cancelada, y deja libre la
 *  mesa. A la de una reserva web le llega un correo (docs/estudios/reservas-web.md §5.6).
 */
export type ReservaCancelarInput = {
	id_reserva: string,
};

/**  Entrada de borrado de reserva. */
export type ReservaDeleteInput = {
	id_reserva: string,
};

export type ReservaDto = {
	id_reserva: string,
	id_mesa: string,
	dia_ymd: string,
	hora: string,
	turno: string | null,
	comensales: number,
	/**  Minutos que ocupa la mesa; `None` = la duración por defecto del negocio (RI-61). */
	duracion_min: number | null,
	nota: string | null,
	estado: string,
	/**
	 *  De dónde vino: `TPV` (la Main o una Handy) o `WEB` (la hizo el cliente desde el widget,
	 *  docs/estudios/reservas-web.md). `Reservas.Origen`.
	 */
	origen: string,
	/**  `None` si la reserva no tiene cliente (RI-61); entonces `nombre_cliente` llega vacío. */
	id_cliente: string | null,
	nombre_cliente: string,
	telefono_cliente: string | null,
	email_cliente: string | null,
	id_zona: string,
	numero_mesa: string,
	capacidad: number,
	nombre_zona: string,
};

export type ReservaMesaOut = {
	idReserva: string,
	clienteNombre: string,
	diaYMD: string,
	hora: string,
	estado: string,
	minutosPara: number,
};

/**  Entrada de guardado de reserva (Local-First: sin op_id/outbox/remote_id). */
export type ReservaSaveInput = {
	id_reserva?: string | null,
	dia_ymd: string,
	hora: string,
	turno?: string | null,
	comensales: number,
	/**  RI-61: minutos que ocupa la mesa. Sin ella, la duración por defecto del negocio. */
	duracion_min?: number | null,
	/**
	 *  RI-61: guardar aunque se pise con otra reserva de la mesa (o con una comanda abierta). Lo
	 *  manda la pantalla después de enseñar el aviso `reserva_solapada` y de que se confirme. Con
	 *  los solapes prohibidos no sirve de nada.
	 */
	forzar_solape?: boolean | null,
	nota?: string | null,
	id_mesa?: string | null,
	/**
	 *  RI-61: el cliente es opcional y explícito. `id_cliente` asigna uno que ya existe (lo que se
	 *  escriba abajo sólo rellena sus huecos); sin id, un `nombre_cliente` crea uno nuevo; y sin
	 *  nada, la reserva va sin cliente. Antes de asignar por teléfono o email, la pantalla pregunta
	 *  con `reservas_buscar_cliente`.
	 */
	id_cliente?: string | null,
	nombre_cliente?: string | null,
	telefono?: string | null,
	email?: string | null,
	/**
	 *  RES-INC-03: al editar, la reserva tal como la cargó el formulario (los valores de su
	 *  `ReservaDto`). Si ya no está así cuando llega, no se guarda. Sin ella (un alta, o un
	 *  cliente de antes) no se comprueba.
	 */
	visto?: ReservaVistaDto | null,
};

/**  RES-INC-03: lo que el formulario vio de la reserva que edita. */
export type ReservaVistaDto = {
	id_mesa: string,
	dia_ymd: string,
	hora: string,
	comensales: number,
	duracion_min: number | null,
	nota: string | null,
	id_cliente: string | null,
};

export type ReservaWebActivarInput = {
	activa: boolean,
};

/**
 *  El alta de una reserva desde el widget (`POST /v1/publico/reservas/:clave/reservas`). La valida
 *  el worker y, al registrarla, la Main: `tpv_domain::reservas_web::AltaWebValidada`, con la tabla
 *  de casos compartida (`validacion_casos.json`, dominio `reserva_web`).
 */
export type ReservaWebAltaInput = {
	dia_ymd: string,
	hora: string,
	personas: number,
	id_mesa: string,
	nombre: string,
	email: string,
	telefono: string,
	nota: string | null,
};

export type ReservaWebCierreInput = {
	dia_ymd: string,
	motivo: string | null,
};

/**
 *  Cómo se puede reservar una mesa desde la web: la casilla y su franja. La pantalla edita una
 *  franja por mesa aunque el esquema admita varias.
 *
 *  `dias_semana` es la máscara de `Reserva_Web_Franjas` (1 lunes … 64 domingo; 127 = todos). Sin
 *  franja guardada, las horas llegan vacías.
 */
export type ReservaWebMesaDto = {
	id_mesa: string,
	activa: boolean,
	dias_semana: number,
	fecha_desde: string | null,
	fecha_hasta: string | null,
	hora_desde: string | null,
	hora_hasta: string | null,
};

/**  Lo que guarda la pantalla para una mesa. Mismos campos que [`ReservaWebMesaDto`]. */
export type ReservaWebMesaInput = {
	id_mesa: string,
	activa: boolean,
	dias_semana: number,
	fecha_desde: string | null,
	fecha_hasta: string | null,
	hora_desde: string | null,
	hora_hasta: string | null,
};

export type ReservaWebQuitarCierreInput = {
	id_cierre: string,
};

/**  Argumentos del rango mensual. */
export type ReservasGetMesArgs = {
	desde: string,
	hasta: string,
};

export type ReservasMesasTurno = {
	turno: StatsTurno,
	mesas_reservadas: number,
	mesas_no_reservadas: number,
};

export type ReservasMetaDto = {
	zonas: ZonaDto[],
	mesas: MesaDto[],
};

export type ReservasStatsArgs = {
	range: StatsRange,
	turno: StatsTurno,
};

export type ReservasStatsResponse = {
	total_reservas: number,
	cancelaciones: number,
	mesas_turno: ReservasMesasTurno,
	reservas_por_bucket: ChartSeriesI64,
	estado: ChartSeriesI64,
	franjas: ChartSeriesI64,
};

export type ResolverCobroPendienteInput = {
	id_pago: string,
	destinatario?: DestinatarioInput | null,
};

/**  Cómo le ha ido a la Main con una petición. */
export type ResultadoRecogidaWeb =
/**  Guardada (o ya lo estaba). */
"registrada" |
/**
 *  Guardada, pero pisa otra reserva o una comanda, o su mesa ya no está: el restaurante la
 *  tiene que mover. Una reserva web confirmada nunca se rechaza.
 */
"solapada" |
/**  No se ha podido guardar: al cliente se le avisa por correo. */
"fallida";

/**  Lo que dejó una pasada del contraste. */
export type ResultadoVerificacion = {
	descuadres: DescuadreTabla[],
	/**  Filas cuya reparación se ha encolado en esta pasada. */
	reparadas: number,
	/**
	 *  La nube no pudo resumir la ventana: sólo se han comparado los conteos (y las claves de lo
	 *  que no cuadraba).
	 */
	ventana_omitida: boolean,
	/**  Filas de más en la nube cuyo borrado se ha encolado. */
	borradas?: number,
	/**
	 *  Se encontraron diferencias que NO se han tocado: esta Main no podía afirmar que estuviera
	 *  al día (un fallo de bajada, histórico por bajar, la base se movió antes de escribir), la
	 *  reparación está apagada, o la pasada llegó a su tope antes de mirarlo todo.
	 *
	 *  Se informa: es la diferencia entre «no hay nada que arreglar» y «lo hay y no me atrevo».
	 */
	aplazado?: boolean,
	/**
	 *  Filas que se han bajado de la nube para compararlas una a una: las de los cubos que no
	 *  cuadraban. Cero es lo normal.
	 */
	filas_examinadas?: number,
	/**
	 *  Tablas que no se han podido comparar por valores: sin clave primaria, con otras columnas
	 *  que en la nube (otra versión del programa), o cuyas filas no llegaron como en el resumen.
	 */
	tablas_sin_comparar?: string[],
};

/**
 *  Resumen agregado de caja para un rango (+ búsqueda opcional). Se calcula en SQL sobre TODO el
 *  rango, de modo que las cifras de cabecera son correctas aunque la lista esté paginada.
 */
export type ResumenCajaDto = {
	total_entradas: Dinero,
	total_salidas: Dinero,
	total_efectivo: Dinero,
	total_tarjeta: Dinero,
	count_entradas: number,
	count_salidas: number,
	/**
	 *  Cobros anulados del rango. **No entran en los totales de arriba** y por eso viajan aparte:
	 *  un cobro anulado no es una venta, pero cuántos hay y por cuánto importe es exactamente el
	 *  dato que no existía y que hace visible la sisa (CUENTA-07).
	 */
	count_anuladas: number,
	total_anulado: Dinero,
};

/**
 *  Respuesta de `/v1/sync/verificar/resumen`: lo que la nube dice de cada tabla para que la Main
 *  lo compare con su base **sin bajarse las filas**.
 *
 *  O bien es un resumen (`aplazar = false`), o bien la nube dice que ahora no (`aplazar = true`,
 *  con su `motivo`): el negocio está escribiendo, o a esta Main le falta por aplicar algo de lo que
 *  hay en el log. Lo segundo no es un fallo: se reintenta más tarde.
 */
export type ResumenNube = {
	aplazar?: boolean,
	/**  Por qué se aplaza: `actividad`, `por_delante` o `desfase`. Diagnóstico, no ramificación. */
	motivo?: string | null,
	/**
	 *  El checkpoint que mandó la Main, devuelto: por encima de él no hay en el log de la nube
	 *  nada que no sea de esta Main. `None` si la nube no lo ha comprobado.
	 */
	checkpoint?: number | null,
	/**
	 *  El `Seq` del final del log de la nube en la foto de la que sale el resumen. Las páginas
	 *  de filas y de claves traen el suyo: si no es éste, la nube se ha movido entre medias.
	 */
	hasta_seq?: number,
	/**  Límite inferior de la ventana. Vuelve tal cual al pedir las filas de un cubo. */
	desde?: string,
	/**  La ventana no cabía en lo que la nube resume de una vez: sólo vienen los conteos. */
	ventana_omitida?: boolean,
	tablas?: ResumenTabla[],
};

/**
 *  Lo que el resumen dice de una tabla.
 *
 *  `sql` es la sentencia de su ventana, la que la nube ha resumido. La Main **ejecuta esa misma
 *  sentencia** en su base: la definición de la ventana vive en el worker y en ningún otro sitio.
 */
export type ResumenTabla = {
	nombre: string,
	/**
	 *  `COUNT(*)` de la tabla ENTERA en la nube: lo único que ve lo que falta o sobra fuera de la
	 *  ventana.
	 */
	total?: number,
	/**  Sin ella (ventana omitida), de esta tabla sólo se compara `total`. */
	sql?: string | null,
	args?: unknown[],
	/**  Las columnas de la ventana, en su orden: el de los valores de cada fila resumida. */
	columnas?: string[],
	/**  Las columnas de la clave primaria. Vacío: la tabla no tiene, y no se compara por valores. */
	claves?: string[],
	/**  Filas de la ventana en la nube. */
	filas?: number,
	/**  En cuántos cubos viene resumida (`tpv_domain::contraste`). */
	cubos?: number,
	/**  Filas de cada cubo. */
	cuentas?: number[],
	/**  La suma de los hashes de las filas de cada cubo: dieciséis cifras hexadecimales. */
	sumas?: string[],
};

export type RolPermisos = {
	id_rol: string,
	nombre: string,
	permisos: string[],
};

export type RolRow = {
	ID_Rol: string,
	Nombre_Rol: string,
};

export type RoomPoly = {
	type: string,
	points: (number | null)[],
};

/**  Fila de salidas (gastos). */
export type SalidaDto = {
	id: string,
	fecha_hora: string,
	tipo_gasto: string,
	concepto: string,
	importe: Dinero,
	proveedor_id: string | null,
	/**  El dinero salió del cajón (CAJA-01). Sólo estos gastos restan del esperado del arqueo. */
	pagado_con_caja?: boolean,
	/**
	 *  El proveedor de un gasto cuyo proveedor se borró: al borrarlo, el gasto se queda sin
	 *  `proveedor_id` y con su nombre (`Cuentas_Gastos.Nombre_Proveedor`). Es la etiqueta que se
	 *  enseña, la misma que en Estadísticas → Proveedores: «Pescados Norte (borrado)», o
	 *  «Proveedor borrado» si no tenía nombre. `None` si tiene proveedor en la ficha o no lo ha
	 *  tenido nunca. Sin él, Cuentas enseñaba ese gasto como si no fuera de ningún proveedor.
	 */
	proveedor_borrado?: string | null,
};

export type SalonInput = {
	id: string,
	name: string,
	room: RoomPoly,
	tables: TableInput[],
};

export type SalonOut = {
	id: string,
	name: string,
	room: RoomPoly,
	tables: TableOut[],
};

export type SaveImageArgs = {
	subfolder: string,
	base64_data: string,
};

export type SetAsignacionesTareaInput = {
	id_tarea: string,
	ids_trabajadores?: string[],
};

export type SetDeviceModeArgs = {
	mode: DeviceMode,
};

export type SetPredeterminadoInput = {
	fecha_lunes: string,
};

export type SetPrinterArgs = {
	name: string,
	/**  Destino al que se asigna (`caja` | `cocina`). Ausente = `caja`. */
	destino?: string | null,
};

export type SetTurnoPartidoInput = {
	id_usuario: string,
	turno_partido: boolean,
	fecha?: string | null,
};

/**
 *  ¿Queda por hacer el setup inicial? Se consulta SIN sesión, al arrancar, para decidir cuál es la
 *  primera pantalla: elegir PIN, recuperar los datos, o el login de siempre.
 */
export type SetupPendiente = {
	pendiente: boolean,
	/**
	 *  La BD local no tiene NI UN usuario. En una instalación nueva es imposible (el arranque
	 *  siembra el admin), así que sólo se llega aquí por la guardia de aprovisionamiento: el
	 *  dispositivo tiene licencia pero ha perdido su `data.db`. La primera pantalla es la de
	 *  recuperación, que reconstruye la BD desde la nube.
	 */
	requiere_recuperacion?: boolean,
	id_usuario: string | null,
	nombre: string | null,
};

export type SolicitarCambioCorreoInput = {
	correo: string,
};

export type SolicitarCodigoPinInput = {
	id_usuario: string,
};

/**
 *  Un evento de log estructurado, ya enriquecido con el contexto de correlación del momento en que
 *  se emitió.
 */
export type SpoolEvent = {
	/**  Marca temporal RFC3339 (UTC) de captura. */
	ts: string,
	/**  Severidad: `ERROR` | `WARN` | `INFO`. */
	level: string,
	/**  `target` del evento (módulo Rust que lo emitió). */
	target: string,
	/**  Mensaje principal (campo `message` de la macro `tracing`). */
	message: string,
	/**  Campos estructurados adicionales del evento. */
	fields: { [key in string]: unknown },
	device_id: string,
	device_mode: string,
	tenant_id: string,
	app_version: string,
	environment: string,
};

/**
 *  Una sentencia de escritura ya resuelta. `args` son escalares JSON (string/number/bool/null)
 *  que se enlazan a los `?` del `sql`.
 */
export type SqlStatement = {
	sql: string,
	args: unknown[],
};

export type StatsCategoriaRow = {
	ID_Categoria: string,
	Nombre: string,
};

export type StatsRange = "hoy" | "semana" | "mes" | "anio";

export type StatsTurno = "COMIDA" | "CENA" | "TODOS";

/**
 *  DO-SUBIDA: cómo va la subida completa de la base a una nube devuelta en modo «main». Lo enseña
 *  Configuración → Conectividad mientras dura; terminada o abandonada no se enseña (`None`).
 */
export type SubidaNubeEstado = {
	/**  `subiendo` o `contrastando` (subida entregada, esperando a que el contraste la confirme). */
	estado: string,
	/**  `empezando`, `vivos`, `imprescindible`, `reciente`, `historico`, `revisando` o `contrastando`. */
	fase: string,
	filas_leidas: number,
	filas_total: number,
	tablas_pendientes: number,
	/**  Filas que la nube no ha dejado entrar y quedan para el contraste. */
	filas_por_revisar: number,
	/**
	 *  La nube rechazó el último intento sin decir por qué: se reintenta solo. Se apaga en cuanto
	 *  un paso entra.
	 */
	reintentando: boolean,
	/**
	 *  Tablas que la nube no admite en esta subida: no se reintentan, y lo que falte de ellas lo
	 *  repara la comprobación con la nube (el contraste).
	 */
	tablas_fallidas: number,
};

export type SummaryArgs = {
	limit?: number | null,
};

/**
 *  Una operación a aplicar de forma atómica e idempotente (por `op_id`). `seq` es el cursor
 *  monotono del log de la nube; la Main lo usa como checkpoint del catch-up.
 */
export type SyncChange = {
	op_id: string,
	seq: number,
	statements: SqlStatement[],
};

/**
 *  Foto de SALUD de la sincronización local (SYNC-14). La expone el comando `sync_health` para el
 *  panel de Configuración → Conectividad, de modo que un fallo de convergencia deje de ser invisible.
 */
export type SyncHealth = {
	/**  Operaciones aún sin subir a la nube (profundidad del outbox). */
	outbox_pending: number,
	/**  Último `seq` aplicado localmente (checkpoint del catch-up). */
	last_seq: number,
	/**  Operaciones en CUARENTENA (SYNC-01): fallaron al aplicarse y se saltaron para no bloquear. */
	quarantined: number,
	/**  Operaciones que están fallando pero aún NO en cuarentena (reintentándose). */
	failing: number,
	/**
	 *  SYNC-20 · dirección SUBIDA: operaciones del outbox que ya se han llevado algún rechazo de
	 *  la nube pero siguen en camino. Es el aviso temprano, antes de que se aparten.
	 *
	 *  Los cuatro campos de arriba miran sólo la dirección nube→Main. Mientras fue así, un TPV
	 *  cuyo outbox estaba parado porque la nube rechazaba su primera operación enseñaba un panel
	 *  de salud impecable: `failing: 0`, `quarantined: 0`. El único síntoma era que `last_seq` no
	 *  subía, y eso no lo mira nadie.
	 */
	subida_fallando: number,
	/**
	 *  SYNC-20 · dirección SUBIDA: operaciones APARTADAS. La nube no las tiene y no va a tenerlas
	 *  sin que alguien arregle la causa; el resto de la cola sigue subiendo por encima de ellas.
	 */
	subida_en_cuarentena: number,
	/**
	 *  SYNC-36 · Lo que la nube ha cambiado y lleva una semana (`BAJADA_ATASCADA_TRAS_MS`) sin poder
	 *  escribirse aquí: de las de `quarantined`, las que no pueden salir solas (las filas que tocan
	 *  son inciertas o dudosas) o que la salida ya ha intentado y siguen ahí, mientras el contraste
	 *  diario no repara nada; y (SYNC-38) las filas apuntadas para traerlas de la nube que no entran,
	 *  que el contraste no toca. Lo arregla traer el estado actual de la nube, y se avisa al
	 *  administrador.
	 */
	bajada_atascada: number,
};

export type TableInput = {
	id: string,
	name: string,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number | null,
	seats: number,
	shape: string,
};

export type TableOut = {
	id: string,
	name: string,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number | null,
	seats: number,
	shape: string,
};

export type TareaAdminRow = {
	ID_Tarea: string,
	Titulo: string,
	Descripcion: string | null,
	Fecha_Creacion: string,
	Fecha_Limite: string | null,
	Total_Asignados: number,
	Total_Finalizadas: number,
};

export type TareaAsignadoRow = {
	ID_Trabajador: string,
	Nombre: string,
	Apellido: string | null,
	Puesto: string | null,
	Asignada_At: string,
	Estado: string,
	Finalizada_At: string | null,
};

/**  Argumento con sólo el id de tarea (get por id, asignados, borrar). */
export type TareaIdArgs = {
	id_tarea: string,
};

export type TareaRow = {
	ID_Tarea: string,
	Titulo: string,
	Descripcion: string | null,
	Fecha_Creacion: string,
	Fecha_Limite: string | null,
};

/**  Qué ticket de cobro se pide (RI-29): el de un pago, leído entero de la base. */
export type TicketDePagoInput = TicketDePagoInput_Serialize | TicketDePagoInput_Deserialize;

/**  Qué ticket de cobro se pide (RI-29): el de un pago, leído entero de la base. */
export type TicketDePagoInput_Deserialize = {
	id_pago: string,
	/**  Reimpresión: el papel sale marcado COPIA, con el mismo número. */
	es_copia?: boolean,
	/**  Otra factura del mismo pago: la `F3` que canjeó su ticket. `None` = la del número del pago. */
	num_factura?: string | null,
};

/**  Qué ticket de cobro se pide (RI-29): el de un pago, leído entero de la base. */
export type TicketDePagoInput_Serialize = {
	id_pago: string,
	/**  Reimpresión: el papel sale marcado COPIA, con el mismo número. */
	es_copia: boolean,
	/**  Otra factura del mismo pago: la `F3` que canjeó su ticket. `None` = la del número del pago. */
	num_factura?: string | null,
};

export type TicketSettings = {
	show_logo: boolean,
	show_business_name: boolean,
	show_address: boolean,
	show_phone: boolean,
	show_footer_message: boolean,
	paper_width_mm: number,
	/**  DPI de la impresora térmica (203 | 300). Usado para convertir márgenes mm→dots/líneas. */
	paper_dpi: number,
	/**  Caracteres por línea del cuerpo del ticket (fuente A). Autoritativo sobre el ancho de papel. */
	chars_per_line: number,
	/**  Márgenes del ticket en milímetros. */
	margin_top_mm: number | null,
	margin_bottom_mm: number | null,
	margin_left_mm: number | null,
	margin_right_mm: number | null,
	/**  Escala global de la fuente (0.5–2.0). El builder ESC/POS la mapea a magnificación entera. */
	font_scale: number | null,
};

export type TicketSettingsPatch = TicketSettingsPatch_Serialize | TicketSettingsPatch_Deserialize;

export type TicketSettingsPatchInput = TicketSettingsPatchInput_Serialize | TicketSettingsPatchInput_Deserialize;

export type TicketSettingsPatchInput_Deserialize = {
	patch: TicketSettingsPatch_Deserialize,
};

export type TicketSettingsPatchInput_Serialize = {
	patch: TicketSettingsPatch_Serialize,
};

export type TicketSettingsPatch_Deserialize = {
	show_logo?: boolean,
	show_business_name?: boolean,
	show_address?: boolean,
	show_phone?: boolean,
	show_footer_message?: boolean,
	paper_width_mm?: number,
	paper_dpi?: number,
	chars_per_line?: number,
	margin_top_mm?: number,
	margin_bottom_mm?: number,
	margin_left_mm?: number,
	margin_right_mm?: number,
	font_scale?: number,
};

export type TicketSettingsPatch_Serialize = {
	show_logo?: boolean,
	show_business_name?: boolean,
	show_address?: boolean,
	show_phone?: boolean,
	show_footer_message?: boolean,
	paper_width_mm?: number,
	paper_dpi?: number,
	chars_per_line?: number,
	margin_top_mm?: number,
	margin_bottom_mm?: number,
	margin_left_mm?: number,
	margin_right_mm?: number,
	font_scale?: number,
};

/**  Qué le ha hecho el restaurante a una reserva web. */
export type TipoAvisoReservaWeb =
/**  Ha cambiado el día, la hora, las personas o la mesa. */
"modificada" |
/**  La ha cancelado (o la ha borrado, que en una reserva web es cancelarla). */
"cancelada";

/**  Qué pide una petición de la agenda. */
export type TipoPeticionWeb = "alta" | "cancelacion";

export type TpvServerPostJsonArgs = {
	mode: string,
	path: string,
	body: unknown,
};

export type TrabajadorCardStats = TrabajadorCardStats_Serialize | TrabajadorCardStats_Deserialize;

export type TrabajadorCardStats_Deserialize = {
	id_trabajador: string,
	nombre: string,
	rol: string,
	tareas_asignadas: number,
	tareas_finalizadas: number,
	puntualidad: PuntualidadInfo | null,
	horas_trabajadas: number | null,
	comandas_preparadas: number | null,
	comandas_tomadas: number | null,
	cobros_realizados: number | null,
	ticket_medio: Dinero | null,
};

export type TrabajadorCardStats_Serialize = {
	id_trabajador: string,
	nombre: string,
	rol: string,
	tareas_asignadas: number,
	tareas_finalizadas: number,
	puntualidad: PuntualidadInfo | null,
	horas_trabajadas: number | null,
	comandas_preparadas?: number | null,
	comandas_tomadas?: number | null,
	cobros_realizados?: number | null,
	ticket_medio?: Dinero | null,
};

/**
 *  Alta de trabajador (crea Usuario + Trabajador en local). Local-First.
 *
 *  RI-63: llega el PIN, no su hash. Lo hashea quien lo guarda (la Main o el worker), que así puede
 *  exigir la política del PIN y no guarda un hash con las iteraciones que alguien quiera.
 *
 *  `sin_pin`: el login y el fichaje no se lo piden. El PIN llega igual —la pantalla pone uno al azar
 *  si no se escribe ninguno—, para que quitarle la opción después no deje la cuenta sin PIN.
 */
export type TrabajadorCreateInput = {
	id_rol: string,
	email: string,
	pin: string,
	nombre: string,
	apellido?: string | null,
	estado: string,
	dni?: string | null,
	telefono?: string | null,
	puesto?: string | null,
	iban?: string | null,
	numero_seguridad_social?: string | null,
	fecha_inicio_contrato?: string | null,
	fecha_fin_contrato?: string | null,
	sin_pin?: boolean,
};

export type TrabajadorDetailArgs = {
	id_trabajador: string,
};

export type TrabajadorDetailRow = {
	ID_Trabajador: string,
	ID_Usuario: string,
	ID_Rol: string,
	Email: string,
	Nombre: string,
	Apellido: string | null,
	Estado: string,
	DNI: string | null,
	Telefono: string | null,
	Puesto: string | null,
	IBAN: string | null,
	Numero_Seguridad_Social: string | null,
	Fecha_Inicio_Contrato: string | null,
	Fecha_Fin_Contrato: string | null,
	Sin_PIN?: boolean,
};

/**
 *  Cómo ha quedado. `retirado`: tenía historia (fichajes, cobros, comandas…), así que sigue en la
 *  base con `Archivado_En`, sin poder entrar y fuera de las listas; si no, se ha borrado.
 */
export type TrabajadorEliminado = {
	retirado: boolean,
};

/**  Eliminar a un trabajador: se borra si no tiene historia y se retira si la tiene. */
export type TrabajadorEliminarInput = {
	id_trabajador: string,
};

export type TrabajadorIdByUsuarioArgs = {
	id_usuario: string,
};

export type TrabajadorRow = {
	ID_Trabajador: string,
	ID_Usuario: string,
	Nombre: string,
	Apellido: string | null,
	Email: string,
	Estado: string,
	Nombre_Rol: string,
	Telefono: string | null,
	Puesto: string | null,
};

export type TrabajadorUI = {
	ID_Trabajador: string,
	ID_Usuario: string,
	Nombre: string,
	Apellido: string | null,
	Puesto: string | null,
	Email: string,
};

/**
 *  Edición de trabajador (actualiza Usuario + Trabajador). `pin` opcional: si viene, cambia el
 *  PIN; si no, se mantiene el actual. Como en el alta, llega el PIN y no su hash (RI-63).
 *  `sin_pin` igual: ausente, se queda el que tenga (una pantalla que no lo conoce no lo pisa).
 *  Local-First.
 */
export type TrabajadorUpdateInput = {
	id_trabajador: string,
	id_usuario: string,
	id_rol: string,
	email: string,
	nombre: string,
	apellido?: string | null,
	estado: string,
	dni?: string | null,
	telefono?: string | null,
	puesto?: string | null,
	iban?: string | null,
	numero_seguridad_social?: string | null,
	fecha_inicio_contrato?: string | null,
	fecha_fin_contrato?: string | null,
	pin?: string | null,
	sin_pin?: boolean | null,
};

export type TrabajadoresStatsArgs = {
	range: StatsRange,
};

export type TrabajadoresStatsResponse = TrabajadoresStatsResponse_Serialize | TrabajadoresStatsResponse_Deserialize;

export type TrabajadoresStatsResponse_Deserialize = {
	cocineros: TrabajadorCardStats_Deserialize[],
	camareros: TrabajadorCardStats_Deserialize[],
	limpieza: TrabajadorCardStats_Deserialize[],
	ranking_ventas: ChartSerieDinero,
};

export type TrabajadoresStatsResponse_Serialize = {
	cocineros: TrabajadorCardStats_Serialize[],
	camareros: TrabajadorCardStats_Serialize[],
	limpieza: TrabajadorCardStats_Serialize[],
	ranking_ventas: ChartSerieDinero,
};

export type TramoHorarioInput = {
	hora_inicio: string,
	hora_fin: string,
};

/**  Un tramo del desglose de IVA tal como sale en el papel. Gemelo de `tpv_domain::ticket::TramoIva`. */
export type TramoTicket = {
	tipo: number | null,
	base: Dinero,
	cuota: Dinero,
};

export type TurnoRow = {
	ID_Turno: string,
	Nombre_Turno: string,
};

export type UltimoGastoProveedor = {
	fecha: string,
	proveedor: string,
	concepto: string,
	importe: Dinero,
};

/**  Entrada para actualizar un cliente (Local-First: sin op_id ni outbox). */
export type UpdateClienteInput = {
	id_cliente: string,
	nombre: string,
	email?: string | null,
	telefono?: string | null,
	notas?: string | null,
	/**
	 *  FISCAL-02: los datos para facturarle. Opcionales; se normalizan como el destinatario de la
	 *  factura (`tpv_domain::clientes::DatosFiscales`).
	 */
	nif?: string | null,
	razon_social?: string | null,
	direccion_fiscal?: string | null,
};

export type UpdateGastoInput = {
	id_gasto: string,
	fecha: string,
	tipo_gasto: string,
	concepto: string,
	importe: Dinero,
	proveedor_id?: string | null,
	/**  CAJA-01: el gasto se pagó con dinero del cajón. Ausente = no. */
	pagado_con_caja?: boolean | null,
};

/**  Metadatos de una actualización disponible (lo que la UI necesita para avisar). */
export type UpdateInfo = {
	/**  Versión nueva publicada en el feed (p. ej. "0.2.0"). */
	version: string,
	/**  Versión actualmente instalada en este equipo. */
	current_version: string,
	/**  Notas de la versión (texto libre del feed), si las hay. */
	notes: string | null,
};

/**  Los datos de un lote, **sin sus existencias** (RI-55): esas se cambian con `AjusteLoteInput`. */
export type UpdateLoteInput = {
	id_lote: string,
	id_producto: string,
	codigo_lote: string,
	caducidad?: string | null,
	fecha_entrada?: string | null,
	coste_unitario?: Dinero | null,
	id_proveedor?: string | null,
	notas?: string | null,
};

export type UpdatePagoInput = {
	id_pago: string,
	fecha_hora: string,
	metodo: string,
	importe: Dinero,
};

/**
 *  Estado completo para la pantalla Configuración → Actualizaciones. A diferencia de
 *  `updater_check`, NUNCA falla: quedarse sin internet o un feed caído se reportan en `error`, para
 *  que la pantalla siga pudiendo pintar la versión instalada en vez de quedarse en blanco.
 */
export type UpdateStatus = {
	/**  Versión instalada en este equipo (siempre disponible, haya feed o no). */
	current_version: string,
	/**  `false` en plataformas sin updater (móvil/Handy Android): la UI oculta los botones. */
	supported: boolean,
	/**  Actualización pendiente de instalar, si la hay. */
	update: UpdateInfo | null,
	/**  Motivo por el que no se pudo comprobar (sin conexión, feed caído…). */
	error: string | null,
};

export type UpdateTareaInput = {
	id_tarea: string,
	titulo: string,
	descripcion?: string | null,
	fecha_limite?: string | null,
};

export type UpsertCategoriaInput = {
	id_categoria?: string | null,
	nombre: string,
	nombre_imagen: string,
	ruta_imagen: string,
	vendible: boolean,
	pasa_cocina: boolean,
};

export type UpsertProductoInput = {
	id_producto?: string | null,
	id_categoria: string,
	id_proveedor?: string | null,
	nombre: string,
	precio_venta?: Dinero | null,
	stock_minimo?: number | null,
	unidad_medida?: string | null,
	nombre_imagen?: string | null,
	ruta_imagen?: string | null,
	cantidad_pedido_esperada?: number | null,
	/**
	 *  VR-04: stock suelto fuera de lotes (opcional; None = el producto no lo usa).
	 *
	 *  **Sólo cuenta al crear el producto** (RI-55): editando la ficha se ignora, y el stock suelto
	 *  se cambia con `AjusteStockSueltoInput`, que deja su movimiento.
	 */
	stock_suelto?: number | null,
	/**  Tipo de IVA propio (opcional; None = hereda el del negocio). */
	iva_percent?: number | null,
	ids_alergenos?: string[],
	/**  Los ingredientes que lleva. Ausente o `null` = no tocarlos. */
	ids_ingredientes?: string[] | null,
};

export type UpsertProductoResult = {
	id_producto: string,
};

export type UserListItem = {
	id_usuario: string,
	nombre: string,
	apellido: string | null,
	nombre_rol: string,
	/**
	 *  Entra sin PIN: la pantalla no se lo pide y el backend no lo comprueba (`Usuarios.Sin_PIN`).
	 *  `default` para que una Handy nueva siga listando contra un worker que aún no lo devuelve.
	 */
	sin_pin?: boolean,
};

export type VerTicketsDetalleRow = {
	ID_Detalle: string,
	ID_Producto: string,
	Nombre: string,
	Cantidad: number | null,
	Precio_Unitario: Dinero,
	/**  Tipo de IVA con el que se vendió la línea (congelado al añadirla); `None` = el del negocio. */
	IVA_Percent: number | null,
	Estado_Cocina: string,
	Pagado: number,
	Notas: string | null,
	/**  Lo que se pidió distinto (array JSON de `Detalle_Comanda.Cambios_Ingredientes`). */
	Cambios_Ingredientes: string | null,
};

/**  RI-27: sin precio. El de la línea lo pone el catálogo, no la pantalla. */
export type VrAddLineaComandaInput = {
	id_comanda: string,
	id_producto: string,
	cantidad: number | null,
};

/**
 *  REV-17: quién cobra sale de la **sesión**, nunca de la entrada (SEC-01).
 *
 *  Es la misma regla que ya aplican anular un cobro, cerrar la caja y abrir el cajón, y faltaba
 *  justo donde más duele: el cobrador que se guarda con el pago es el rastro con el que se
 *  investiga un descuadre del cajón. Firmándolo con lo que le pase la pantalla, quien alcance el
 *  IPC puede cobrar en efectivo a nombre de otro — o sea, la sisa que ese rastro existe para poder
 *  ver. Y no hay sitio donde se cobre sin sesión: a las dos pantallas de venta sólo se llega
 *  pasando el login.
 */
export type VrCobrarFraccionadoInput = {
	/**
	 *  El id del cobro (`Pagos.ID_Pago`), un UUID que genera la pantalla al encolarlo.
	 *
	 *  Es lo que hace idempotente el cobro: si la aplicación se cae después de guardarlo y antes de
	 *  quitarlo de la cola, al volver se reintenta con el mismo id y se devuelve el número del cobro
	 *  que ya existe, en vez de rechazarlo por no quedar líneas pendientes.
	 */
	id_pago: string,
	id_comanda: string,
	metodo: string,
	importe_total: Dinero,
	detalles: string[],
	/**
	 *  FISCAL-02: si viene, se emite **factura completa** (`F1`) en vez de un ticket.
	 *
	 *  Se llega aquí por dos caminos: el cliente lo pide («Factura con NIF») o el importe pasa del
	 *  límite de la simplificada y entonces no hay alternativa. Si pasa del límite y esto va vacío,
	 *  el cobro se rechaza con `factura_completa_requerida` y la pantalla pide los datos.
	 */
	destinatario?: DestinatarioInput | null,
	/**
	 *  SYN-INC-05: «Cobrar todo». Si va a `true`, el cobro sólo entra si las líneas que lleva son
	 *  todas las que quedan por cobrar de la comanda: si mientras se cobraba otro equipo añadió una,
	 *  se rechaza (`Conflict`) en vez de cobrar la cuenta vieja y dejar la nueva línea suelta.
	 */
	todo?: boolean,
};

export type VrCreateComandaBarraInput = {
	id_trabajador?: string | null,
	/**  Si es `true`, reutiliza la comanda de barra abierta si existe (get-or-create). */
	get_or_create?: boolean | null,
};

export type VrDeleteComandaIfSafeInput = {
	id_comanda: string,
};

export type VrDeleteLineaIfUnpaidInput = {
	id_comanda: string,
	id_detalle: string,
};

export type VrIdCategoriaArgs = {
	id_categoria: string,
};

export type VrIdComandaArgs = {
	id_comanda: string,
};

export type VrIdsArgs = {
	ids: string[],
};

/**
 *  La línea recién añadida, con el precio que se le ha puesto: el del catálogo en ese momento, que
 *  puede no ser el de la carta en caché de la pantalla (RI-27).
 */
export type VrLineaAnadida = {
	id_detalle: string,
	precio_unitario: Dinero,
};

export type VrListComandasArgs = {
	limit?: number | null,
};

export type VrRemoveLastUnpaidLineaInput = {
	id_comanda: string,
	id_producto: string,
};

export type VrSearchProductosArgs = {
	query: string,
	limit: number,
};

export type VrUpdateNotaDetalleInput = {
	id_detalle: string,
	nota?: string | null,
};

export type ZonaDto = {
	id_zona: string,
	nombre_zona: string,
};

/**  El zoom de la ventana tal como está ahora. */
export type ZoomVentana = {
	/**
	 *  El aplicado, en tanto por ciento (`85` es el 85 %). Entero a propósito: un `f64` viaja como
	 *  `number | null`, porque un NaN se serializa como `null`.
	 */
	porcentaje: number,
	/**  `true` si lo decide el monitor; `false` si alguien lo ha fijado en este equipo. */
	automatico: boolean,
	/**  Si quedan pasos hacia arriba y hacia abajo: los límites sólo los sabe Rust. */
	puede_acercar: boolean,
	puede_alejar: boolean,
};
