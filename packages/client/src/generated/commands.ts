// Generado por pnpm generate-types desde Rust y tauri-specta. No editar.

import { invocar as __TAURI_INVOKE } from "../transporte";
import type { AccionEmparejamiento, AjusteLoteInput, AjusteStockSueltoInput, AjustesReservaWebDto, AlergenoInvDto, AlergenoMiniDto, AnularPagoInput, ApiSignedHeaders, AplicacionSync, AppErrorDto, ApplySyncChangesArgs, AsignacionCreateInput, AsignacionDeleteInput, AsignacionGuardarInput, AsignacionRow, AsignacionUpdateInput, AutorizacionUsuario, AvisoReservaWebInput, AvisoSocketHandy, BackfillEstado, BloqueFiscal, BootstrapResultado, BootstrapSnapshot, BootstrapTabla, BusinessSettings, BusinessSettingsPatch, BusinessSettingsPatchInput, BusinessSettingsPatchInput_Deserialize, BusinessSettingsPatchInput_Serialize, BusinessSettingsPatch_Deserialize, BusinessSettingsPatch_Serialize, CambioCajaInput, CambioReplicado, CambioZoom, CambioZoomArgs, CategoriaInvDto, CategoriaProveedorDto, CategoriaRow, CategoriaVendibleOut, ChartSerieDinero, ChartSeriesI64, CierreDto, CierreIdInput, CierreListarArgs, CierreReservaWebDto, CierreResumenDto, ClaveReservaWebDto, ClavesPagina, ClienteCoincidente, ClienteForm, ClienteIdArgs, ClienteOverview, ClientesOverviewArgs, ClientesStatsArgs, ClientesStatsResponse, CobroDevolubleDto, CobroPendienteDto, CodigoEnviado, ComandaBarraRow, ComandaConLineasOut, ComandaReplicada, ComandaRow, CompleteInitialSetupInput, ConexionHandy, ConfiguracionPermisos, ConfirmarCambioCorreoInput, ConfirmarCierreInput, ConfirmarCodigoPinInput, ConnectivityMode, ContactSettings, ContactSettingsPatch, ContactSettingsPatchInput, ContactSettingsPatchInput_Deserialize, ContactSettingsPatchInput_Serialize, ContactSettingsPatch_Deserialize, ContactSettingsPatch_Serialize, CopySemanaInput, CrearNotificacionInput, CreateClienteInput, CreateGastoInput, CreateLoteInput, CreateTareaInput, CuentasRangoArgs, CursorCuentas, DatosAltaWebDto, DeleteGastoInput, DeleteImageArgs, DenominacionDto, DenominacionInput, DescuadreTabla, DestinatarioInput, DestinatarioTicket, DestinatarioTicket_Deserialize, DestinatarioTicket_Serialize, DestinoArgs, DeviceFirmarEmparejamientoArgs, DeviceIdentity, DeviceMode, DevolucionDto, DevolverLineasInput, Dinero, EnsureImageArgs, EntradaDto, EnviarPedidoEmailInput, ErrorCode, EstadoColaImagenes, EstadoCorreoRecuperacion, EstadoFiscal, EstadoReplicacion, EstadoSocketHandy, FacturaDelCobro, FalloDeComando, FilasDeCubos, FilasPorClave, FinalizarTareaInput, FirmaDispositivo, GeometriaTicket, GravedadFallo, GuardarPermisosInput, HandySetTokenArgs, HistoricoPagina, HorariosSemanaArgs, IdCategoriaArgs, IdProductoArgs, ImagenApartada, ImpactoCajaDto, ImpactoCierreDto, IndexRow, Interruptor, InterruptorApagado, InventarioResumenResponse, JobStatus, KitchenRow, LicenseActivateInput, LicenseActivateOutcome, LicenseActivateOutcome_Deserialize, LicenseActivateOutcome_Serialize, LicenseDeviceChangeInput, LicenseGateResult, LicenseGateResult_Deserialize, LicenseGateResult_Serialize, LicenseLocalState, LicenseLocalState_Deserialize, LicenseLocalState_Serialize, LicenseSumarClaveInput, LineaADevolverInput, LineaComandaRow, LineaDevolubleDto, LineaEmailInput, LineaPedidoDto, LineaPedidoInput, LocalBackupInfo, LoginOk, LoginUserArgs, LoteDto, MesaDto, MesaIngresoRow, MesaLineaComandaRow, MesaMetaOut, MesaMetaOut_Deserialize, MesaMetaOut_Serialize, MesasAbrirComandaInput, MesasAddLineaComandaInput, MesasCobrarDetallesInput, MesasComandaSetReservaInput, MesasComandaSetTrabajadorInput, MesasDeleteDetalleInput, MesasIdCategoriaArgs, MesasIdComandaArgs, MesasIdMesaArgs, MesasKitchenSetLineStateInput, MesasMetaOut, MesasMetaOut_Deserialize, MesasMetaOut_Serialize, MesasRemoveOnePendingDetalleInput, MesasSaveLayoutInput, MesasSearchProductosArgs, MesasSetReservaEstadoInput, MesasStatsResponse, MesasTopComandas, MesasUpdateDetalleNotaInput, MisTareasArgs, MisTareasRow, NotificacionIdInput, NotificacionRow, NotificacionesListArgs, OutboxEntry, OutboxFallo, PaginaEntradas, PaginaSalidas, PairCreateResult, PedidoProveedorDto, PedidosActualizarInput, PedidosCambiarEstadoInput, PedidosCrearInput, PedidosGetPageInput, PedidosPageDto, PendientesReservaWebDto, PermisoDef, PeticionReservaWebDto, PreparacionCierreDto, PrintArqueoPayload, PrintTicketLine, PrintTicketLine_Deserialize, PrintTicketLine_Serialize, PrintTicketPayload, PrintTicketPayload_Deserialize, PrintTicketPayload_Serialize, PrinterInfo, ProductDetailResponse, ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProductoProveedorDto, ProductoResumenDto, ProductoRow, ProductoVendibleOut, ProductosStatsArgs, ProductosStatsResponse, ProveedorDto, ProveedorMiniDto, ProveedorSaveInput, ProveedorTop, ProveedoresDeleteInput, ProveedoresGetProductosArgs, ProveedoresSetVinculosInput, ProveedoresStatsArgs, ProveedoresStatsResponse, PunchInput, PunchParte, PunchStatus, PunchStatusArgs, PuntualidadInfo, RechazoHandy, RecogidaReservaWebDto, RecogidasReservaWebInput, RecoveryState, RecoveryStatus, RectificacionArqueo, RectificacionDto, ReintentarImagenArgs, ReservaBuscarClienteArgs, ReservaCancelarInput, ReservaDeleteInput, ReservaDto, ReservaMesaOut, ReservaSaveInput, ReservaWebActivarInput, ReservaWebAltaInput, ReservaWebCierreInput, ReservaWebMesaDto, ReservaWebMesaInput, ReservaWebQuitarCierreInput, ReservasGetMesArgs, ReservasMesasTurno, ReservasMetaDto, ReservasStatsArgs, ReservasStatsResponse, ResolverCobroPendienteInput, ResultadoRecogidaWeb, ResultadoVerificacion, ResumenCajaDto, ResumenNube, ResumenTabla, RolPermisos, RolRow, RoomPoly, SalidaDto, SalonInput, SalonOut, SaveImageArgs, SetAsignacionesTareaInput, SetConnectionModeArgs, SetDeviceModeArgs, SetPredeterminadoInput, SetPrinterArgs, SetTurnoPartidoInput, SetupPendiente, SolicitarCambioCorreoInput, SolicitarCodigoPinInput, SpoolEvent, SqlStatement, StatsCategoriaRow, StatsRange, StatsTurno, SummaryArgs, SyncChange, SyncHealth, TableInput, TableOut, TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TicketDePagoInput, TicketDePagoInput_Deserialize, TicketDePagoInput_Serialize, TicketSettings, TicketSettingsPatch, TicketSettingsPatchInput, TicketSettingsPatchInput_Deserialize, TicketSettingsPatchInput_Serialize, TicketSettingsPatch_Deserialize, TicketSettingsPatch_Serialize, TipoAvisoReservaWeb, TipoPeticionWeb, TpvServerPostJsonArgs, TpvServerSignedHeadersArgs, TrabajadorCardStats, TrabajadorCardStats_Deserialize, TrabajadorCardStats_Serialize, TrabajadorCreateInput, TrabajadorDetailArgs, TrabajadorDetailRow, TrabajadorIdByUsuarioArgs, TrabajadorRow, TrabajadorUI, TrabajadorUpdateInput, TrabajadoresStatsArgs, TrabajadoresStatsResponse, TrabajadoresStatsResponse_Deserialize, TrabajadoresStatsResponse_Serialize, TramoHorarioInput, TramoTicket, TurnoRow, UltimoGastoProveedor, UpdateClienteInput, UpdateGastoInput, UpdateInfo, UpdateLoteInput, UpdatePagoInput, UpdateStatus, UpdateTareaInput, UpsertCategoriaInput, UpsertProductoInput, UpsertProductoResult, UserListItem, VerTicketsDetalleRow, VrAddLineaComandaInput, VrCobrarFraccionadoInput, VrCreateComandaBarraInput, VrDeleteComandaIfSafeInput, VrDeleteLineaIfUnpaidInput, VrIdCategoriaArgs, VrIdComandaArgs, VrIdsArgs, VrLineaAnadida, VrListComandasArgs, VrRemoveLastUnpaidLineaInput, VrSearchProductosArgs, VrUpdateNotaDetalleInput, ZonaDto, ZoomVentana } from "@tpv/contracts";

export const commands = {
	getDeviceMode: () => __TAURI_INVOKE<"tpv" | "handy" | null>("get_device_mode"),
	setDeviceMode: (args: SetDeviceModeArgs) => __TAURI_INVOKE<string>("set_device_mode", { args }),
	/**
	 *  Lee la palanca de conectividad de `device_config.json`. `None` = nunca se tocó = `Auto`
	 *  (el frontend asume `auto`): SYNC-17, conectar es el comportamiento por defecto.
	 */
	getConnectionMode: () => __TAURI_INVOKE<"auto" | "off" | null>("get_connection_mode"),
	/**
	 *  Persiste la palanca de conectividad en `device_config.json`. **Sin UI**: es la salida de
	 *  emergencia de SYNC-17 (ver [`ConnectivityMode`]), no un ajuste que se ofrezca al usuario.
	 *
	 *  La captura de escrituras para el outbox está SIEMPRE activa (el outbox es el log de cambios
	 *  local), así que apagar y volver a encender no pierde nada: al volver a `Auto` se drena.
	 *
	 *  Aquí ya NO se valida la licencia. Antes se hacía porque activar "online" era una acción
	 *  explícita del usuario; ahora la autoridad es el worker (`/v1/ws/ticket` exige JWT + device
	 *  proof y rechaza una licencia no activa) y, antes que eso, el gate de AppBoot ya bloquea la app
	 *  entera si la licencia no deja pasar. Duplicar la comprobación aquí solo añadía una llamada de
	 *  red a un camino que no la necesita.
	 */
	setConnectionMode: (args: SetConnectionModeArgs) => __TAURI_INVOKE<string>("set_connection_mode", { args }),
	initMain: () => __TAURI_INVOKE<string>("init_main"),
	/**
	 *  Reversibilidad: vuelve al menú de selección de modo. Persiste `mode = None`, suelta los
	 *  backends activos (BD local y cliente de nube) y, si el dispositivo estaba en Handy,
	 *  lo **desvincula** (borra el token Handy del keyring) para forzar un emparejamiento limpio
	 *  al re-elegir. Tras esto, `get_device_mode` devuelve `null` y la UI muestra de nuevo el
	 *  selector Main/Handy. La licencia local (modo Main) NO se toca: si se vuelve a elegir Main,
	 *  el gate de licencia sigue resolviéndose con el estado guardado.
	 */
	deviceResetMode: () => __TAURI_INVOKE<string>("device_reset_mode"),
	/**  RI-07: reconstruye una imagen en su formato real y devuelve su ruta relativa. */
	saveImage: (args: SaveImageArgs) => __TAURI_INVOKE<string>("save_image", { args }),
	imagesDrainPending: () => __TAURI_INVOKE<string>("images_drain_pending"),
	imagesUploadStatus: () => __TAURI_INVOKE<EstadoColaImagenes>("images_upload_status"),
	imagesRetryUpload: (args: ReintentarImagenArgs) => __TAURI_INVOKE<null>("images_retry_upload", { args }),
	/**
	 *  Borra una imagen: del disco local y (best-effort) del bucket R2. Se usa al reemplazar la
	 *  imagen de un producto/categoría/proveedor para no dejar huérfanos ni servir caché obsoleta.
	 */
	imagesDelete: (args: DeleteImageArgs) => __TAURI_INVOKE<string>("images_delete", { args }),
	/**
	 *  Garantiza que la imagen `rel_path` exista en el disco local, bajándola de R2 si falta
	 *  (camino R2 → Main). La Main sirve las imágenes desde disco, pero las creadas en otra Handy
	 *  solo viven en R2: su fila llega por sync, pero el binario no. Este comando lo resuelve de
	 *  forma perezosa y auto-curativa: lo llama el frontend al resolver la URL de una imagen.
	 *
	 *  Devuelve `true` si tras la llamada el fichero está en local (ya estaba o se bajó), `false`
	 *  si no se pudo (sin modo, aún no está en R2, u offline). Nunca es un error "duro": el UI
	 *  degrada al placeholder y reintenta en la siguiente recarga.
	 */
	imagesEnsureLocal: (args: EnsureImageArgs) => __TAURI_INVOKE<boolean>("images_ensure_local", { args }),
	/**
	 *  Backfill único: encola todas las imágenes existentes en disco que aún no estén en el bucket.
	 *  Pensado para Mains que ya tenían imágenes antes de existir R2. Se protege con un marcador
	 *  para no re-escanear en cada arranque. La subida real la hace `images_drain_pending`.
	 */
	imagesBackfill: () => __TAURI_INVOKE<string>("images_backfill"),
	/**  Comprueba el feed y devuelve los metadatos de la nueva versión, o `None` si ya está al día. */
	updaterCheck: () => __TAURI_INVOKE<{
	/**  Versión nueva publicada en el feed (p. ej. "0.2.0"). */
	version: string,
	/**  Versión actualmente instalada en este equipo. */
	current_version: string,
	/**  Notas de la versión (texto libre del feed), si las hay. */
	notes: string | null,
} | null>("updater_check"),
	/**
	 *  Estado para la pantalla de actualizaciones: versión instalada + resultado de comprobar el feed.
	 *  Comprueba de verdad (no devuelve nada cacheado), así que el botón "Buscar actualizaciones"
	 *  también dispara el aviso si aparece una versión nueva.
	 */
	updaterStatus: () => __TAURI_INVOKE<UpdateStatus>("updater_status"),
	/**
	 *  Descarga, verifica e instala la última actualización y reinicia la app. Vuelve a comprobar el
	 *  feed antes de instalar (no se fía de un estado cacheado). Pensado para invocarse cuando el
	 *  usuario lo decida (p. ej. al cerrar caja), no en automático.
	 */
	updaterInstall: () => __TAURI_INVOKE<null>("updater_install"),
	/**
	 *  Lista las impresoras visibles por el SO (locales + conexiones de red/WiFi). Se ejecuta en un
	 *  hilo bloqueante para no congelar el runtime async (la API de Windows es síncrona).
	 */
	printerList: () => __TAURI_INVOKE<PrinterInfo[]>("printer_list"),
	/**  Devuelve la impresora seleccionada para un destino (o `None`). */
	printerGetSelected: (args: {
	destino?: string | null,
} | null) => __TAURI_INVOKE<string | null>("printer_get_selected", { args }),
	/**  Persiste la impresora de un destino en `device_config.json` (nombre vacío => deselecciona). */
	printerSetSelected: (args: SetPrinterArgs) => __TAURI_INVOKE<string>("printer_set_selected", { args }),
	/**
	 *  Imprime una **precuenta**: lo que se le enseña al cliente antes de cobrar, compuesto en la
	 *  pantalla. Sale sin número, sin QR y sin marca de copia aunque la pantalla los mande
	 *  (`como_precuenta`, RI-29): el ticket de un cobro sólo sale de `printer_imprimir_pago`.
	 */
	printerImprimirPrecuenta: (payload: PrintTicketPayload_Deserialize) => __TAURI_INVOKE<string>("printer_imprimir_precuenta", { payload }),
	/**
	 *  El ticket de un cobro, compuesto desde la base (RI-29): las líneas que cobró ese pago y su
	 *  factura. Es lo que enseña la vista previa, y lo mismo que imprime `printer_imprimir_pago`.
	 *
	 *  Basta con estar identificado: lo imprime quien acaba de cobrar, a mitad de servicio.
	 */
	printerTicketDePago: (args: TicketDePagoInput_Deserialize) => __TAURI_INVOKE<PrintTicketPayload_Serialize>("printer_ticket_de_pago", { args }),
	/**
	 *  Imprime el ticket de un cobro. No recibe el papel: lo vuelve a componer desde la base, así que
	 *  lo que sale es siempre lo que dice la factura.
	 */
	printerImprimirPago: (args: TicketDePagoInput_Deserialize) => __TAURI_INVOKE<string>("printer_imprimir_pago", { args }),
	/**
	 *  Imprime el papel de un arqueo (CUENTA-06).
	 *
	 *  Documento **interno**: no gasta numero de ticket ni abre el cajon -que ya esta abierto, se acaba
	 *  de contar-. Va aparte del ticket de venta a proposito: compartir el camino del ticket de
	 *  venta invitaria a que un cambio en uno se colara en el otro.
	 */
	printerPrintArqueo: (payload: PrintArqueoPayload) => __TAURI_INVOKE<string>("printer_print_arqueo", { payload }),
	/**
	 *  Columnas de caracteres que de verdad caben con la configuración actual de papel y márgenes.
	 *
	 *  Lo pregunta la previsualización para enseñar el ancho real (y recortar los nombres donde los
	 *  recorta el papel) en vez de una versión más amable. Vive aquí y no duplicado en TypeScript
	 *  porque es la MISMA cuenta que usa el builder ESC/POS: dos copias acabarían discrepando, que es
	 *  justo lo que hace que una previsualización deje de servir para nada.
	 */
	printerTicketCols: (args: GeometriaTicket) => __TAURI_INVOKE<number>("printer_ticket_cols", { args }),
	/**
	 *  Abre el cajón portamonedas sin imprimir nada.
	 *
	 *  Existe para dar cambio o cuadrar caja, que es algo que el camarero necesita hacer, así que no
	 *  se pide permiso de administrador. Lo que sí se hace es **dejarlo anotado** con quién y cuándo:
	 *  una apertura sin venta detrás es la única por la que alguien pregunta cuando falta dinero.
	 *
	 *  SEC-01: por eso pide `sesion()` —basta estar identificado, da igual el rol— y el `id_usuario`
	 *  sale de ahí, no de los args. Una fila de auditoría firmada con el nombre que le pase la
	 *  pantalla no registra quién abrió el cajón; registra quién dijo alguien que lo abrió.
	 *
	 *  El registro es best-effort a propósito: si la BD fallara, el cajón se abre igual. Bloquear el
	 *  cambio de un cliente porque no se pudo escribir una fila de auditoría sería peor que la falta
	 *  de esa fila. El gate NO es best-effort: sin sesión no se abre.
	 */
	printerOpenDrawer: () => __TAURI_INVOKE<string>("printer_open_drawer"),
	/**  Imprime un ticket de prueba en la impresora indicada (o la seleccionada) para verificarla. */
	printerPrintTest: (args: {
	name: string,
	/**  Destino al que se asigna (`caja` | `cocina`). Ausente = `caja`. */
	destino?: string | null,
} | null) => __TAURI_INVOKE<string>("printer_print_test", { args }),
	listLoginUsers: () => __TAURI_INVOKE<UserListItem[]>("list_login_users"),
	/**
	 *  ¿Queda por elegir el PIN del primer arranque? Lo pregunta la app ANTES del login para saber
	 *  qué pantalla enseñar.
	 */
	setupPendiente: () => __TAURI_INVOKE<SetupPendiente>("setup_pendiente"),
	/**
	 *  Valida el PIN y **establece la sesión del backend** (SEC-01).
	 *
	 *  El rol que se guarda es el que devuelve el repositorio —SQLite en la Main, el worker en la
	 *  Handy—, nunca uno que venga en `args`: es todo el sentido del gate. Los dos modos pasan por
	 *  aquí, así que un comando gateado funciona igual en la Handy que en la Main.
	 */
	loginUser: (args: LoginUserArgs) => __TAURI_INVOKE<LoginOk>("login_user", { args }),
	/**
	 *  Cierra la sesión del backend.
	 *
	 *  Lo llaman `useAuth.logout()` (y con él el cierre por inactividad) y el arranque del
	 *  frontend. Esto último no es cosmético: si el webview se recarga (F5), el store de Zustand se
	 *  vacía y la UI vuelve al login, pero la sesión de aquí seguiría puesta — quedaría una sesión
	 *  de administrador viva detrás de una pantalla de login.
	 *
	 *  No falla nunca ni exige haber iniciado sesión: cerrar lo que ya está cerrado es un no-op, y
	 *  un error aquí sólo serviría para que el frontend no se atreviera a llamarlo.
	 */
	logout: () => __TAURI_INVOKE<null>("logout"),
	getTodayPunchStatus: (args: PunchStatusArgs) => __TAURI_INVOKE<PunchStatus>("get_today_punch_status", { args }),
	punch: (args: PunchInput) => __TAURI_INVOKE<PunchStatus>("punch", { args }),
	completeInitialSetup: (args: CompleteInitialSetupInput) => __TAURI_INVOKE<string>("complete_initial_setup", { args }),
	setTurnoPartidoHoy: (args: SetTurnoPartidoInput) => __TAURI_INVOKE<string>("set_turno_partido_hoy", { args }),
	/**  Manda un código al correo del titular de la licencia. */
	loginRecuperarPinSolicitar: (args: SolicitarCodigoPinInput) => __TAURI_INVOKE<CodigoEnviado>("login_recuperar_pin_solicitar", { args }),
	/**  Verifica el código y, sólo si vale, guarda el PIN nuevo. Las dos cosas aquí dentro. */
	loginRecuperarPinConfirmar: (args: ConfirmarCodigoPinInput) => __TAURI_INVOKE<string>("login_recuperar_pin_confirmar", { args }),
	correoRecuperacionEstado: () => __TAURI_INVOKE<EstadoCorreoRecuperacion>("correo_recuperacion_estado"),
	/**  Manda un código al correo nuevo. Hasta confirmarlo no cambia nada. */
	correoRecuperacionSolicitar: (args: SolicitarCambioCorreoInput) => __TAURI_INVOKE<CodigoEnviado>("correo_recuperacion_solicitar", { args }),
	correoRecuperacionConfirmar: (args: ConfirmarCambioCorreoInput) => __TAURI_INVOKE<EstadoCorreoRecuperacion>("correo_recuperacion_confirmar", { args }),
	correoRecuperacionUsarElDeLaCompra: () => __TAURI_INVOKE<EstadoCorreoRecuperacion>("correo_recuperacion_usar_el_de_la_compra"),
	recoveryStatus: () => __TAURI_INVOKE<RecoveryStatus>("recovery_status"),
	recoveryListBackups: () => __TAURI_INVOKE<LocalBackupInfo[]>("recovery_list_backups"),
	/**
	 *  Copia manual desde Configuración. El job diario cubre el día a día, pero antes de una
	 *  actualización o de tocar el catálogo entero se quiere una copia de AHORA, no la de esta
	 *  madrugada.
	 */
	recoveryCreateBackup: () => __TAURI_INVOKE<LocalBackupInfo>("recovery_create_backup"),
	/**
	 *  Guarda una copia fuera del equipo. Las copias diarias viven en el mismo disco que protegen:
	 *  cubren un borrado o una corrupción, no un disco muerto.
	 *
	 *  REV-19: lo que decía aquí de la PII del personal era **al revés**. `DNI`, `IBAN` y el nº de la
	 *  Seguridad Social se cifran antes de construir la sentencia, así que lo que sale por el outbox
	 *  —y lo que acaba en Turso— es el texto cifrado, no un hueco; y la DEK no se queda en el equipo:
	 *  el worker la guarda en el control-plane y la reentrega en cada activación (TRAB-03). De modo
	 *  que esa PII **sí vuelve** de la nube, y esta copia no es lo único que la conserva. Lo que no
	 *  vuelve es cualquier fila que nunca llegara a subir, que es el motivo de sacar copias.
	 */
	recoveryExportBackup: (backupId: string, destino: string) => __TAURI_INVOKE<null>("recovery_export_backup", { backupId, destino }),
	/**
	 *  Trae una copia de fuera al almacén local. No restaura: deja la copia disponible para que la
	 *  restauración siga siendo el mismo camino guardado que las demás.
	 */
	recoveryImportBackup: (origen: string) => __TAURI_INVOKE<LocalBackupInfo>("recovery_import_backup", { origen }),
	/**
	 *  Sustituye la BD completa por una copia local ya validada. El mutex de `AppState` permanece
	 *  tomado desde que se comprueba que se puede reemplazar hasta que la base nueva está abierta:
	 *  ningún comando ni job puede adquirir una conexión nueva en ese intervalo (REV-18).
	 */
	recoveryRestoreBackup: (backupId: string) => __TAURI_INVOKE<LocalBackupInfo>("recovery_restore_backup", { backupId }),
	saveLayout: (args: MesasSaveLayoutInput) => __TAURI_INVOKE<string>("save_layout", { args }),
	loadLayout: () => __TAURI_INVOKE<SalonOut[]>("load_layout"),
	setReservaEstado: (args: MesasSetReservaEstadoInput) => __TAURI_INVOKE<string>("set_reserva_estado", { args }),
	getComandaAbiertaByMesa: (args: MesasIdMesaArgs) => __TAURI_INVOKE<{
	id_comanda: string,
	id_mesa: string,
	id_trabajador: string | null,
	id_reserva: string | null,
	fecha_hora_apertura: string,
	fecha_hora_cierre: string | null,
	total_comanda: Dinero,
	estado: string,
} | null>("get_comanda_abierta_by_mesa", { args }),
	abrirComanda: (args: MesasAbrirComandaInput) => __TAURI_INVOKE<{
	id_comanda: string,
	id_mesa: string,
	id_trabajador: string | null,
	id_reserva: string | null,
	fecha_hora_apertura: string,
	fecha_hora_cierre: string | null,
	total_comanda: Dinero,
	estado: string,
} | null>("abrir_comanda", { args }),
	/**
	 *  Abrir o retomar la mesa: su comanda abierta (creada si no hay ninguna, con el trabajador de la
	 *  sesión si le faltaba) y sus líneas, en un paso. Es lo que pide la pantalla de la mesa al
	 *  abrirse; en la Handy, un viaje en vez de cuatro.
	 */
	mesasAbrirORetomar: (args: MesasAbrirComandaInput) => __TAURI_INVOKE<ComandaConLineasOut>("mesas_abrir_o_retomar", { args }),
	comandaSetTrabajadorIfNull: (args: MesasComandaSetTrabajadorInput) => __TAURI_INVOKE<boolean>("comanda_set_trabajador_if_null", { args }),
	/**
	 *  INC-20261030-007: lo pide el modal de la mesa al marcar la llegada, si el camarero dice que la
	 *  cuenta que ya estaba abierta es de los clientes de la reserva.
	 */
	comandaSetReservaIfNull: (args: MesasComandaSetReservaInput) => __TAURI_INVOKE<boolean>("comanda_set_reserva_if_null", { args }),
	getLineasComanda: (args: MesasIdComandaArgs) => __TAURI_INVOKE<MesaLineaComandaRow[]>("get_lineas_comanda", { args }),
	addLineaComanda: (args: MesasAddLineaComandaInput) => __TAURI_INVOKE<MesaLineaComandaRow[]>("add_linea_comanda", { args }),
	mesasMetaAll: () => __TAURI_INVOKE<MesasMetaOut_Serialize>("mesas_meta_all"),
	listCategoriasVendibles: () => __TAURI_INVOKE<CategoriaVendibleOut[]>("list_categorias_vendibles"),
	listProductosByCategoria: (args: MesasIdCategoriaArgs) => __TAURI_INVOKE<ProductoVendibleOut[]>("list_productos_by_categoria", { args }),
	searchProductosByNombre: (args: MesasSearchProductosArgs) => __TAURI_INVOKE<ProductoVendibleOut[]>("search_productos_by_nombre", { args }),
	removeOnePendingDetalle: (args: MesasRemoveOnePendingDetalleInput) => __TAURI_INVOKE<string>("remove_one_pending_detalle", { args }),
	deleteDetalle: (args: MesasDeleteDetalleInput) => __TAURI_INVOKE<string>("delete_detalle", { args }),
	updateDetalleNota: (args: MesasUpdateDetalleNotaInput) => __TAURI_INVOKE<string>("update_detalle_nota", { args }),
	cobrarDetalles: (args: MesasCobrarDetallesInput) => __TAURI_INVOKE<string>("cobrar_detalles", { args }),
	kitchenListTodayPending: () => __TAURI_INVOKE<KitchenRow[]>("kitchen_list_today_pending"),
	kitchenSetLineState: (args: MesasKitchenSetLineStateInput) => __TAURI_INVOKE<string>("kitchen_set_line_state", { args }),
	inventarioListCategorias: () => __TAURI_INVOKE<CategoriaInvDto[]>("inventario_list_categorias"),
	inventarioCreateCategoria: (args: UpsertCategoriaInput) => __TAURI_INVOKE<string>("inventario_create_categoria", { args }),
	inventarioListProveedoresMini: () => __TAURI_INVOKE<ProveedorMiniDto[]>("inventario_list_proveedores_mini"),
	inventarioListProductosByCategoria: (args: IdCategoriaArgs) => __TAURI_INVOKE<ProductoListDto[]>("inventario_list_productos_by_categoria", { args }),
	inventarioGetResumen: (args: SummaryArgs) => __TAURI_INVOKE<InventarioResumenResponse>("inventario_get_resumen", { args }),
	inventarioListAlergenos: () => __TAURI_INVOKE<AlergenoInvDto[]>("inventario_list_alergenos"),
	inventarioGetProductDetail: (args: IdProductoArgs) => __TAURI_INVOKE<ProductDetailResponse>("inventario_get_product_detail", { args }),
	inventarioDeleteProducto: (args: IdProductoArgs) => __TAURI_INVOKE<string>("inventario_delete_producto", { args }),
	inventarioUpsertProducto: (args: UpsertProductoInput) => __TAURI_INVOKE<UpsertProductoResult>("inventario_upsert_producto", { args }),
	inventarioListLotesByProducto: (args: IdProductoArgs) => __TAURI_INVOKE<LoteDto[]>("inventario_list_lotes_by_producto", { args }),
	inventarioCreateLote: (args: CreateLoteInput) => __TAURI_INVOKE<string>("inventario_create_lote", { args }),
	inventarioUpdateLote: (args: UpdateLoteInput) => __TAURI_INVOKE<string>("inventario_update_lote", { args }),
	inventarioAjustarLote: (args: AjusteLoteInput) => __TAURI_INVOKE<string>("inventario_ajustar_lote", { args }),
	/**  RI-55: el stock suelto de un producto se cambia aquí, con su movimiento, y no al guardar la ficha. */
	inventarioAjustarStockSuelto: (args: AjusteStockSueltoInput) => __TAURI_INVOKE<string>("inventario_ajustar_stock_suelto", { args }),
	tareasGetTrabajadores: () => __TAURI_INVOKE<TrabajadorUI[]>("tareas_get_trabajadores"),
	tareasCreateTarea: (args: CreateTareaInput) => __TAURI_INVOKE<boolean>("tareas_create_tarea", { args }),
	tareasGetTareasAdmin: () => __TAURI_INVOKE<TareaAdminRow[]>("tareas_get_tareas_admin"),
	tareasGetTareaById: (args: TareaIdArgs) => __TAURI_INVOKE<{
	ID_Tarea: string,
	Titulo: string,
	Descripcion: string | null,
	Fecha_Creacion: string,
	Fecha_Limite: string | null,
} | null>("tareas_get_tarea_by_id", { args }),
	tareasUpdateTarea: (args: UpdateTareaInput) => __TAURI_INVOKE<boolean>("tareas_update_tarea", { args }),
	tareasGetTareaAsignados: (args: TareaIdArgs) => __TAURI_INVOKE<TareaAsignadoRow[]>("tareas_get_tarea_asignados", { args }),
	tareasSetAsignacionesTarea: (args: SetAsignacionesTareaInput) => __TAURI_INVOKE<boolean>("tareas_set_asignaciones_tarea", { args }),
	tareasDeleteTarea: (args: TareaIdArgs) => __TAURI_INVOKE<boolean>("tareas_delete_tarea", { args }),
	/**
	 *  Papelera (TAR-05). El borrado manda a la papelera; estos tres comandos son el resto del ciclo:
	 *  verla, sacar una tarea de ella y vaciarla (lo único que borra de verdad).
	 */
	tareasGetPapelera: () => __TAURI_INVOKE<TareaAdminRow[]>("tareas_get_papelera"),
	tareasRestaurarTarea: (args: TareaIdArgs) => __TAURI_INVOKE<boolean>("tareas_restaurar_tarea", { args }),
	tareasVaciarPapelera: () => __TAURI_INVOKE<number>("tareas_vaciar_papelera"),
	tareasGetMisTareas: (args: MisTareasArgs) => __TAURI_INVOKE<MisTareasRow[]>("tareas_get_mis_tareas", { args }),
	tareasMarcarTareaFinalizada: (args: FinalizarTareaInput) => __TAURI_INVOKE<boolean>("tareas_marcar_tarea_finalizada", { args }),
	trabajadoresGetRoles: () => __TAURI_INVOKE<RolRow[]>("trabajadores_get_roles"),
	trabajadoresGetAll: () => __TAURI_INVOKE<TrabajadorRow[]>("trabajadores_get_all"),
	trabajadoresGetDetail: (args: TrabajadorDetailArgs) => __TAURI_INVOKE<{
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
} | null>("trabajadores_get_detail", { args }),
	trabajadoresGetTrabajadorIdByUsuario: (args: TrabajadorIdByUsuarioArgs) => __TAURI_INVOKE<string | null>("trabajadores_get_trabajador_id_by_usuario", { args }),
	trabajadoresCreate: (args: TrabajadorCreateInput) => __TAURI_INVOKE<boolean>("trabajadores_create", { args }),
	trabajadoresUpdate: (args: TrabajadorUpdateInput) => __TAURI_INVOKE<boolean>("trabajadores_update", { args }),
	turnosGetAll: () => __TAURI_INVOKE<TurnoRow[]>("turnos_get_all"),
	horariosGetAsignacionesSemana: (args: HorariosSemanaArgs) => __TAURI_INVOKE<AsignacionRow[]>("horarios_get_asignaciones_semana", { args }),
	horariosCreateAsignacion: (args: AsignacionCreateInput) => __TAURI_INVOKE<boolean>("horarios_create_asignacion", { args }),
	horariosGuardarAsignacion: (args: AsignacionGuardarInput) => __TAURI_INVOKE<boolean>("horarios_guardar_asignacion", { args }),
	horariosUpdateAsignacion: (args: AsignacionUpdateInput) => __TAURI_INVOKE<boolean>("horarios_update_asignacion", { args }),
	horariosDeleteAsignacion: (args: AsignacionDeleteInput) => __TAURI_INVOKE<boolean>("horarios_delete_asignacion", { args }),
	horariosCopySemanaAsignaciones: (args: CopySemanaInput) => __TAURI_INVOKE<boolean>("horarios_copy_semana_asignaciones", { args }),
	horariosSetPredeterminadoDesdeSemana: (args: SetPredeterminadoInput) => __TAURI_INVOKE<boolean>("horarios_set_predeterminado_desde_semana", { args }),
	cuentasGetEntradas: (args: CuentasRangoArgs) => __TAURI_INVOKE<PaginaEntradas>("cuentas_get_entradas", { args }),
	cuentasGetSalidas: (args: CuentasRangoArgs) => __TAURI_INVOKE<PaginaSalidas>("cuentas_get_salidas", { args }),
	cuentasGetResumen: (args: CuentasRangoArgs) => __TAURI_INVOKE<ResumenCajaDto>("cuentas_get_resumen", { args }),
	cuentasCreateGasto: (args: CreateGastoInput, motivoRectificacion: string | null) => __TAURI_INVOKE<boolean>("cuentas_create_gasto", { args, motivoRectificacion }),
	cuentasUpdateGasto: (args: UpdateGastoInput, motivoRectificacion: string | null) => __TAURI_INVOKE<boolean>("cuentas_update_gasto", { args, motivoRectificacion }),
	cuentasDeleteGasto: (args: DeleteGastoInput, motivoRectificacion: string | null) => __TAURI_INVOKE<boolean>("cuentas_delete_gasto", { args, motivoRectificacion }),
	cuentasUpdatePago: (args: UpdatePagoInput, motivoRectificacion: string | null) => __TAURI_INVOKE<boolean>("cuentas_update_pago", { args, motivoRectificacion }),
	/**
	 *  Anula un cobro (CUENTA-07). Antes lo borraba, y ése era el agujero: el arqueo calcula
	 *  `esperado = fondo + cobros en efectivo`, así que borrar la fila de una venta en efectivo bajaba
	 *  el esperado exactamente lo mismo que faltaba en el cajón y el descuadre salía cero.
	 *
	 *  Quién anula sale de la **sesión** (SEC-01) y nunca del input: una anulación firmada con el
	 *  nombre que le pase la pantalla es una auditoría que da confianza sin merecerla.
	 *
	 *  La hace también el camarero, las dos clases: el cliente que vuelve a por su dinero no espera
	 *  al encargado, y lo que deja rastro es la firma de la sesión, no el rol.
	 */
	cuentasAnularPago: (args: AnularPagoInput) => __TAURI_INVOKE<boolean>("cuentas_anular_pago", { args }),
	/**
	 *  Las líneas de un cobro con lo que queda por devolver de cada una: lo que enseña la pantalla
	 *  de devolver.
	 */
	cuentasLineasDevolubles: (idPago: string) => __TAURI_INVOKE<CobroDevolubleDto>("cuentas_lineas_devolubles", { idPago }),
	/**
	 *  Devuelve parte de un cobro: unas líneas, o unas unidades de una línea (`docs/arquitectura/caja.md`).
	 *
	 *  Quién devuelve sale de la **sesión** (SEC-01), como al anular. No pasa por la rectificación de
	 *  cierres: la devolución cae ahora, en el periodo abierto, que es donde sale el dinero.
	 */
	cuentasDevolverLineas: (args: DevolverLineasInput) => __TAURI_INVOKE<DevolucionDto>("cuentas_devolver_lineas", { args }),
	/**
	 *  A qué cierres ya hechos afectaría un cambio y cómo quedarían. No toca nada.
	 *
	 *  El de una baja lo pide también el camarero, porque la pantalla lo enseña antes de darla; el
	 *  resto de cambios son del administrador.
	 */
	cuentasPrevisualizarCambio: (args: CambioCajaInput) => __TAURI_INVOKE<ImpactoCajaDto>("cuentas_previsualizar_cambio", { args }),
	cierrePreparar: () => __TAURI_INVOKE<PreparacionCierreDto>("cierre_preparar"),
	cierreConfirmar: (args: ConfirmarCierreInput) => __TAURI_INVOKE<CierreDto>("cierre_confirmar", { args }),
	cierreListar: (args: {
	limite?: number | null,
} | null) => __TAURI_INVOKE<CierreResumenDto[]>("cierre_listar", { args }),
	cierreDetalle: (idCierre: string) => __TAURI_INVOKE<CierreDto>("cierre_detalle", { idCierre }),
	cierreReabrir: (args: CierreIdInput) => __TAURI_INVOKE<boolean>("cierre_reabrir", { args }),
	clientesGetOverview: (args: ClientesOverviewArgs) => __TAURI_INVOKE<ClienteOverview[]>("clientes_get_overview", { args }),
	clientesGetClienteForm: (args: ClienteIdArgs) => __TAURI_INVOKE<{
	nombre: string,
	email: string | null,
	telefono: string | null,
	notas: string | null,
} | null>("clientes_get_cliente_form", { args }),
	clientesCreateCliente: (args: CreateClienteInput) => __TAURI_INVOKE<boolean>("clientes_create_cliente", { args }),
	clientesUpdateCliente: (args: UpdateClienteInput) => __TAURI_INVOKE<boolean>("clientes_update_cliente", { args }),
	/**
	 *  Rehace el gasto acumulado de un cliente desde sus pagos (DB-14).
	 *
	 *  Acción MANUAL: el job de reconciliación solo avisa del descuadre; corregirlo es una decisión
	 *  de quien lleva el negocio, y este comando es el botón que la ejecuta.
	 */
	clientesRecalcularGasto: (args: ClienteIdArgs) => __TAURI_INVOKE<Dinero | null>("clientes_recalcular_gasto", { args }),
	reservasGetMeta: () => __TAURI_INVOKE<ReservasMetaDto>("reservas_get_meta"),
	reservasGetMes: (args: ReservasGetMesArgs) => __TAURI_INVOKE<ReservaDto[]>("reservas_get_mes", { args }),
	reservasSave: (args: ReservaSaveInput) => __TAURI_INVOKE<boolean>("reservas_save", { args }),
	/**  RI-61: el cliente que ya tiene ese teléfono o ese email, para preguntar antes de asignárselo. */
	reservasBuscarCliente: (args: ReservaBuscarClienteArgs) => __TAURI_INVOKE<{
	id_cliente: string,
	nombre: string,
	telefono: string | null,
	email: string | null,
	coincide_por: string,
} | null>("reservas_buscar_cliente", { args }),
	reservasDelete: (args: ReservaDeleteInput) => __TAURI_INVOKE<boolean>("reservas_delete", { args }),
	/**  Cancela una reserva que aún no ha llegado; a la de una reserva web le llega un correo. */
	reservasCancelar: (args: ReservaCancelarInput) => __TAURI_INVOKE<boolean>("reservas_cancelar", { args }),
	reservaWebAjustes: () => __TAURI_INVOKE<AjustesReservaWebDto>("reserva_web_ajustes"),
	reservaWebActivar: (args: ReservaWebActivarInput) => __TAURI_INVOKE<null>("reserva_web_activar", { args }),
	reservaWebCerrarDia: (args: ReservaWebCierreInput) => __TAURI_INVOKE<string>("reserva_web_cerrar_dia", { args }),
	reservaWebQuitarCierre: (args: ReservaWebQuitarCierreInput) => __TAURI_INVOKE<boolean>("reserva_web_quitar_cierre", { args }),
	/**
	 *  La línea que se pega en la web del negocio, con su clave pública (la crea el worker si no
	 *  tiene). Hace falta conexión: la clave vive en la nube.
	 */
	reservaWebClave: () => __TAURI_INVOKE<ClaveReservaWebDto>("reserva_web_clave"),
	/**
	 *  Qué mesas se pueden reservar desde la web y cuándo. Se configura en el editor del plano, así
	 *  que lo puede quien edita el plano (`plano.gestionar`), igual que el resto de cada mesa. El
	 *  interruptor general y los días cerrados siguen siendo del administrador.
	 */
	reservaWebMesas: () => __TAURI_INVOKE<ReservaWebMesaDto[]>("reserva_web_mesas"),
	reservaWebGuardarMesa: (args: ReservaWebMesaInput) => __TAURI_INVOKE<null>("reserva_web_guardar_mesa", { args }),
	proveedoresGetAll: () => __TAURI_INVOKE<ProveedorDto[]>("proveedores_get_all"),
	proveedoresSave: (args: ProveedorSaveInput) => __TAURI_INVOKE<boolean>("proveedores_save", { args }),
	proveedoresDelete: (args: ProveedoresDeleteInput) => __TAURI_INVOKE<boolean>("proveedores_delete", { args }),
	proveedoresGetProductos: (args: ProveedoresGetProductosArgs) => __TAURI_INVOKE<ProductoProveedorDto[]>("proveedores_get_productos", { args }),
	proveedoresGetCategorias: () => __TAURI_INVOKE<CategoriaProveedorDto[]>("proveedores_get_categorias"),
	proveedoresGetProductosAll: () => __TAURI_INVOKE<ProductoProveedorDto[]>("proveedores_get_productos_all"),
	proveedoresSetVinculos: (args: ProveedoresSetVinculosInput) => __TAURI_INVOKE<boolean>("proveedores_set_vinculos", { args }),
	pedidosProveedorGetPage: (args: PedidosGetPageInput) => __TAURI_INVOKE<PedidosPageDto>("pedidos_proveedor_get_page", { args }),
	pedidosProveedorCrear: (args: PedidosCrearInput) => __TAURI_INVOKE<string>("pedidos_proveedor_crear", { args }),
	pedidosProveedorActualizar: (args: PedidosActualizarInput) => __TAURI_INVOKE<boolean>("pedidos_proveedor_actualizar", { args }),
	pedidosProveedorCambiarEstado: (args: PedidosCambiarEstadoInput) => __TAURI_INVOKE<boolean>("pedidos_proveedor_cambiar_estado", { args }),
	notificacionesListar: (args: NotificacionesListArgs) => __TAURI_INVOKE<NotificacionRow[]>("notificaciones_listar", { args }),
	notificacionesNoLeidas: () => __TAURI_INVOKE<number>("notificaciones_no_leidas"),
	notificacionesMarcarLeida: (args: NotificacionIdInput) => __TAURI_INVOKE<boolean>("notificaciones_marcar_leida", { args }),
	notificacionesMarcarTodasLeidas: () => __TAURI_INVOKE<number>("notificaciones_marcar_todas_leidas"),
	notificacionesDescartar: (args: NotificacionIdInput) => __TAURI_INVOKE<boolean>("notificaciones_descartar", { args }),
	notificacionesPapelera: () => __TAURI_INVOKE<NotificacionRow[]>("notificaciones_papelera"),
	notificacionesRestaurar: (args: NotificacionIdInput) => __TAURI_INVOKE<boolean>("notificaciones_restaurar", { args }),
	notificacionesEliminar: (args: NotificacionIdInput) => __TAURI_INVOKE<boolean>("notificaciones_eliminar", { args }),
	vrListCategoriasVendibles: () => __TAURI_INVOKE<CategoriaRow[]>("vr_list_categorias_vendibles"),
	vrListProductosByCategoria: (args: VrIdCategoriaArgs) => __TAURI_INVOKE<ProductoRow[]>("vr_list_productos_by_categoria", { args }),
	vrSearchProductos: (args: VrSearchProductosArgs) => __TAURI_INVOKE<ProductoRow[]>("vr_search_productos", { args }),
	vrCreateComandaBarra: (args: VrCreateComandaBarraInput) => __TAURI_INVOKE<string>("vr_create_comanda_barra", { args }),
	vrListComandasBarra: (args: VrListComandasArgs) => __TAURI_INVOKE<ComandaBarraRow[]>("vr_list_comandas_barra", { args }),
	vrGetLineasComanda: (args: VrIdComandaArgs) => __TAURI_INVOKE<LineaComandaRow[]>("vr_get_lineas_comanda", { args }),
	vrAddLineaComanda: (args: VrAddLineaComandaInput) => __TAURI_INVOKE<VrLineaAnadida>("vr_add_linea_comanda", { args }),
	vrRemoveLastUnpaidLinea: (args: VrRemoveLastUnpaidLineaInput) => __TAURI_INVOKE<boolean>("vr_remove_last_unpaid_linea", { args }),
	vrDeleteLineaIfUnpaid: (args: VrDeleteLineaIfUnpaidInput) => __TAURI_INVOKE<boolean>("vr_delete_linea_if_unpaid", { args }),
	vrUpdateNotaDetalle: (args: VrUpdateNotaDetalleInput) => __TAURI_INVOKE<boolean>("vr_update_nota_detalle", { args }),
	vrCobrarFraccionado: (args: VrCobrarFraccionadoInput) => __TAURI_INVOKE<string>("vr_cobrar_fraccionado", { args }),
	vrGuardarCobroPendiente: (args: VrCobrarFraccionadoInput) => __TAURI_INVOKE<null>("vr_guardar_cobro_pendiente", { args }),
	vrListarCobrosPendientes: () => __TAURI_INVOKE<CobroPendienteDto[]>("vr_listar_cobros_pendientes"),
	vrResolverCobroPendiente: (args: ResolverCobroPendienteInput) => __TAURI_INVOKE<string>("vr_resolver_cobro_pendiente", { args }),
	vrCancelarCobroPendiente: (idPago: string) => __TAURI_INVOKE<boolean>("vr_cancelar_cobro_pendiente", { idPago }),
	vrDeleteComandaIfSafe: (args: VrDeleteComandaIfSafeInput) => __TAURI_INVOKE<boolean>("vr_delete_comanda_if_safe", { args }),
	vrGetIndexRows: (args: VrIdsArgs) => __TAURI_INVOKE<IndexRow[]>("vr_get_index_rows", { args }),
	vrGetDetallesVerTicket: (args: VrIdComandaArgs) => __TAURI_INVOKE<VerTicketsDetalleRow[]>("vr_get_detalles_ver_ticket", { args }),
	/**
	 *  ¿Están los datos fiscales del negocio? Lo leen el aviso de datos fiscales y Configuración →
	 *  Fiscal.
	 *
	 *  Sin exigir rol: el aviso sale a quien esté delante, porque sin esos datos el siguiente cobro
	 *  va a fallar.
	 */
	verifactuEstado: () => __TAURI_INVOKE<EstadoFiscal>("verifactu_estado"),
	/**
	 *  Emite una **factura completa en sustitución** de los tickets de unos cobros (`F3`,
	 *  FISCAL-02): uno, o varios del mismo cliente en una sola factura.
	 *
	 *  Es el camino del cliente que vuelve con el ticket —o con los de un periodo— y pide factura. Los
	 *  tickets **no se tocan**: canjearlos por una completa no es rectificarlos (art. 15.6 ROF), así
	 *  que se emite una `F3` que los sustituye y que sí lleva destinatario.
	 *
	 *  Es de Administrador, como el resto de Cuentas: emite un documento fiscal nuevo.
	 */
	verifactuEmitirFacturaDeTickets: (idPagos: string[], destinatario: DestinatarioInput) => __TAURI_INVOKE<BloqueFiscal>("verifactu_emitir_factura_de_tickets", { idPagos, destinatario }),
	/**
	 *  Corrige los datos del cliente de una factura completa ya expedida (una `F3` o una `F1`).
	 *  Devuelve la factura nueva, que es la que se imprime. Administrador, como emitirla.
	 */
	verifactuCorregirFactura: (numFactura: string, destinatario: DestinatarioInput) => __TAURI_INVOKE<BloqueFiscal>("verifactu_corregir_factura", { numFactura, destinatario }),
	statsMesasGet: (range: StatsRange) => __TAURI_INVOKE<MesasStatsResponse>("stats_mesas_get", { range }),
	statsProductosListCategorias: () => __TAURI_INVOKE<StatsCategoriaRow[]>("stats_productos_list_categorias"),
	statsProductosResumen: (args: ProductosStatsArgs) => __TAURI_INVOKE<ProductosStatsResponse>("stats_productos_resumen", { args }),
	statsReservasResumen: (args: ReservasStatsArgs) => __TAURI_INVOKE<ReservasStatsResponse>("stats_reservas_resumen", { args }),
	statsTrabajadoresResumen: (args: TrabajadoresStatsArgs) => __TAURI_INVOKE<TrabajadoresStatsResponse_Serialize>("stats_trabajadores_resumen", { args }),
	statsClientesResumen: (args: ClientesStatsArgs) => __TAURI_INVOKE<ClientesStatsResponse>("stats_clientes_resumen", { args }),
	statsProveedoresResumen: (args: ProveedoresStatsArgs) => __TAURI_INVOKE<ProveedoresStatsResponse>("stats_proveedores_resumen", { args }),
	licenseGetState: () => __TAURI_INVOKE<{
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
} | null>("license_get_state"),
	/**
	 *  Si la activación trasladó la licencia desde otro equipo, lo que hubiera en la base local es de
	 *  antes del traslado: se marca para reconstruirla desde la nube (`recovery::marcar_traslado`) y se
	 *  cierran ya las escrituras de negocio, antes de que la aplicación arranque nada encima.
	 */
	licenseActivate: (args: LicenseActivateInput) => __TAURI_INVOKE<LicenseActivateOutcome_Serialize>("license_activate", { args }),
	/**
	 *  RI-52: añade el tiempo de otra clave a la licencia de este equipo (Configuración → Licencia).
	 *
	 *  De administrador: es la pantalla de Configuración, y gastar una clave pagada no es algo que
	 *  haga cualquiera a mitad de servicio. Después se comprueba la licencia contra el servidor, como
	 *  `license_check_now`, para que la caducidad nueva llegue firmada y la vea toda la interfaz.
	 */
	licenseSumarClave: (args: LicenseSumarClaveInput) => __TAURI_INVOKE<LicenseActivateOutcome_Serialize>("license_sumar_clave", { args }),
	/**  Pide al servidor que envíe el OTP de cambio de dispositivo al email de la licencia. */
	licenseRequestDeviceChange: (args: LicenseDeviceChangeInput) => __TAURI_INVOKE<string>("license_request_device_change", { args }),
	licenseClearState: () => __TAURI_INVOKE<string>("license_clear_state"),
	licenseGate: () => __TAURI_INVOKE<LicenseGateResult_Serialize>("license_gate"),
	/**
	 *  Comprueba la licencia contra el servidor AHORA, sin esperar al pulso del job.
	 *
	 *  Emite `license:changed` con el resultado, igual que hace el job: quien llame a esto puede no ser
	 *  la pantalla —lo llama también el WebSocket cuando la nube le rechaza el ticket por licencia—, y
	 *  sin el evento el veredicto se quedaba en el fichero de estado mientras la interfaz seguía
	 *  vendiendo tan tranquila hasta la siguiente vuelta del job, seis horas después.
	 */
	licenseCheckNow: () => __TAURI_INVOKE<LicenseGateResult_Serialize>("license_check_now"),
	handySetToken: (args: HandySetTokenArgs) => __TAURI_INVOKE<string>("handy_set_token", { args }),
	handyGetTenant: () => __TAURI_INVOKE<string | null>("handy_get_tenant"),
	deviceGetIdentity: () => __TAURI_INVOKE<DeviceIdentity>("device_get_identity"),
	deviceFirmarEmparejamiento: (args: DeviceFirmarEmparejamientoArgs) => __TAURI_INVOKE<FirmaDispositivo>("device_firmar_emparejamiento", { args }),
	/**
	 *  PROD-04: la hora con la que el frontend firma el saludo del WebSocket y el emparejamiento. Es
	 *  la de la nube, no la del equipo: con un reloj desfasado más de 2 min la nube rechaza la firma.
	 *  Sin sesión, como los comandos de firma acotada: se usa en el emparejamiento de la Handy, antes de que nadie
	 *  entre.
	 */
	deviceHoraParaFirmar: () => __TAURI_INVOKE<number>("device_hora_para_firmar"),
	tpvServerPostJson: (args: TpvServerPostJsonArgs) => __TAURI_INVOKE<unknown>("tpv_server_post_json", { args }),
	/**
	 *  Genera un nuevo código de emparejamiento (lo pide al worker) y lo devuelve tipado a la UI.
	 *
	 *  SEC-01: es la otra mitad de la administración de dispositivos —lo llama únicamente
	 *  Configuración → Vincular Handy—, así que va con el mismo candado que las rutas de
	 *  `/v1/pair/…` del proxy. Repartir un código de emparejamiento es dar acceso al negocio.
	 */
	pairCreate: () => __TAURI_INVOKE<PairCreateResult>("pair_create"),
	/**  El checkpoint es diagnóstico, no permite modificar el cursor. */
	syncHealth: () => __TAURI_INVOKE<SyncHealth>("sync_health"),
	permisosSesion: () => __TAURI_INVOKE<AutorizacionUsuario>("permisos_sesion"),
	permisosConfiguracion: () => __TAURI_INVOKE<ConfiguracionPermisos>("permisos_configuracion"),
	permisosGuardar: (args: GuardarPermisosInput) => __TAURI_INVOKE<null>("permisos_guardar", { args }),
	handySocketEstado: () => __TAURI_INVOKE<EstadoSocketHandy>("handy_socket_estado"),
	handySocketReintentar: (forzar: boolean) => __TAURI_INVOKE<void>("handy_socket_reintentar", { forzar }),
	/**  Sólo lectura/control de transporte: ningún comando acepta SQL ni confirmaciones. */
	syncEstado: () => __TAURI_INVOKE<EstadoReplicacion>("sync_estado"),
	syncReintentar: () => __TAURI_INVOKE<void>("sync_reintentar"),
	/**
	 *  SYNC-19: progreso del backfill del histórico (fase 2). Lo pinta el panel de Conectividad y lo
	 *  mira Estadísticas para avisar de que un total de rango largo todavía puede crecer.
	 *
	 *  Es sólo lectura de una tabla de control local: en un equipo que nunca ha perdido su base
	 *  devuelve todo a cero, que es lo que hace que quien lo consulte no tenga que preguntar antes si
	 *  hay recuperación en curso.
	 */
	syncBackfillEstado: () => __TAURI_INVOKE<BackfillEstado>("sync_backfill_estado"),
	/**
	 *  Reconstruye la BD local desde la nube. Es la salida de una Main que ha perdido su `data.db`:
	 *  la pantalla de recuperación (a la que lleva `setup_pendiente.requiere_recuperacion`) lo llama y
	 *  después ya se puede iniciar sesión con las credenciales de siempre.
	 *
	 *  Lo hace Rust de punta a punta —descarga firmada + restauración— en vez de bajar el volcado al
	 *  frontend y devolverlo: son las tablas enteras del negocio, y cruzarlas dos veces por el puente
	 *  IPC sólo para reenviarlas es copiar megabytes a cambio de nada.
	 */
	syncBootstrapDesdeNube: () => __TAURI_INVOKE<BootstrapResultado>("sync_bootstrap_desde_nube"),
	/**
	 *  Inicialización destructiva sólo para el caso explícito `tenant_db_not_provisioned`. El servidor
	 *  vuelve a comprobarlo antes de crear nada; una respuesta ambigua nunca llega a esta rama.
	 */
	syncInicializarTenantVacio: () => __TAURI_INVOKE<BootstrapResultado>("sync_inicializar_tenant_vacio"),
	/**
	 *  Foto de las tareas periódicas para el panel de Configuración → Conectividad: cuándo corrió cada
	 *  una por última vez, si va bien y, si no, con qué error.
	 */
	jobsStatus: () => __TAURI_INVOKE<JobStatus[]>("jobs_status"),
	/**
	 *  PROD-06: lo que la nube tiene apagado en este equipo ahora mismo. Lo leen Conectividad y Fiscal
	 *  para decir por qué una cola crece, y `socketMain.ts` para decidir si puede volcar el atraso.
	 *
	 *  Sin sesión a propósito: no revela nada que el equipo no esté haciendo ya, y el socket lo
	 *  pregunta antes del login.
	 */
	interruptoresApagados: () => __TAURI_INVOKE<InterruptorApagado[]>("interruptores_apagados"),
	telemetriaFalloDeComando: (args: FalloDeComando) => __TAURI_INVOKE<null>("telemetria_fallo_de_comando", { args }),
	ventanaZoomEstado: () => __TAURI_INVOKE<ZoomVentana>("ventana_zoom_estado"),
	/**  Acercar o alejar lo fija a mano en este equipo; `automatico` lo devuelve al monitor. */
	ventanaZoomCambiar: (args: CambioZoomArgs) => __TAURI_INVOKE<ZoomVentana>("ventana_zoom_cambiar", { args }),
	configGetBusinessSettings: () => __TAURI_INVOKE<BusinessSettings>("config_get_business_settings"),
	configPatchBusinessSettings: (args: BusinessSettingsPatchInput_Deserialize) => __TAURI_INVOKE<string>("config_patch_business_settings", { args }),
	configGetTicketSettings: () => __TAURI_INVOKE<TicketSettings>("config_get_ticket_settings"),
	configPatchTicketSettings: (args: TicketSettingsPatchInput_Deserialize) => __TAURI_INVOKE<string>("config_patch_ticket_settings", { args }),
	configGetContactSettings: () => __TAURI_INVOKE<ContactSettings>("config_get_contact_settings"),
	configPatchContactSettings: (args: ContactSettingsPatchInput_Deserialize) => __TAURI_INVOKE<string>("config_patch_contact_settings", { args }),
	/**
	 *  SEC-01: exige Administrador. Mandar un pedido compromete dinero con un proveedor y sale
	 *  firmado con el correo del negocio; «Proveedores y Pedidos» ya era una sección suya en el
	 *  menú, y esto es el candado que le faltaba detrás.
	 */
	emailEnviarPedido: (args: EnviarPedidoEmailInput) => __TAURI_INVOKE<null>("email_enviar_pedido", { args }),
};
