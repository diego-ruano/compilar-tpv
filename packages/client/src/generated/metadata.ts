// Generado por pnpm generate-types desde Rust y tauri-specta. No editar.

type Comandos = typeof import("./commands").commands;

export const nombresComandos = {
    "get_device_mode": "getDeviceMode",
    "set_device_mode": "setDeviceMode",
    "get_connection_mode": "getConnectionMode",
    "set_connection_mode": "setConnectionMode",
    "init_main": "initMain",
    "device_reset_mode": "deviceResetMode",
    "save_image": "saveImage",
    "images_drain_pending": "imagesDrainPending",
    "images_upload_status": "imagesUploadStatus",
    "images_retry_upload": "imagesRetryUpload",
    "images_delete": "imagesDelete",
    "images_ensure_local": "imagesEnsureLocal",
    "images_backfill": "imagesBackfill",
    "updater_check": "updaterCheck",
    "updater_status": "updaterStatus",
    "updater_install": "updaterInstall",
    "printer_list": "printerList",
    "printer_get_selected": "printerGetSelected",
    "printer_set_selected": "printerSetSelected",
    "printer_imprimir_precuenta": "printerImprimirPrecuenta",
    "printer_ticket_de_pago": "printerTicketDePago",
    "printer_imprimir_pago": "printerImprimirPago",
    "printer_print_arqueo": "printerPrintArqueo",
    "printer_ticket_cols": "printerTicketCols",
    "printer_open_drawer": "printerOpenDrawer",
    "printer_print_test": "printerPrintTest",
    "list_login_users": "listLoginUsers",
    "setup_pendiente": "setupPendiente",
    "login_user": "loginUser",
    "logout": "logout",
    "get_today_punch_status": "getTodayPunchStatus",
    "punch": "punch",
    "complete_initial_setup": "completeInitialSetup",
    "set_turno_partido_hoy": "setTurnoPartidoHoy",
    "login_recuperar_pin_solicitar": "loginRecuperarPinSolicitar",
    "login_recuperar_pin_confirmar": "loginRecuperarPinConfirmar",
    "correo_recuperacion_estado": "correoRecuperacionEstado",
    "correo_recuperacion_solicitar": "correoRecuperacionSolicitar",
    "correo_recuperacion_confirmar": "correoRecuperacionConfirmar",
    "correo_recuperacion_usar_el_de_la_compra": "correoRecuperacionUsarElDeLaCompra",
    "recovery_status": "recoveryStatus",
    "recovery_list_backups": "recoveryListBackups",
    "recovery_create_backup": "recoveryCreateBackup",
    "recovery_export_backup": "recoveryExportBackup",
    "recovery_import_backup": "recoveryImportBackup",
    "recovery_restore_backup": "recoveryRestoreBackup",
    "save_layout": "saveLayout",
    "load_layout": "loadLayout",
    "set_reserva_estado": "setReservaEstado",
    "get_comanda_abierta_by_mesa": "getComandaAbiertaByMesa",
    "abrir_comanda": "abrirComanda",
    "mesas_abrir_o_retomar": "mesasAbrirORetomar",
    "comanda_set_trabajador_if_null": "comandaSetTrabajadorIfNull",
    "comanda_set_reserva_if_null": "comandaSetReservaIfNull",
    "get_lineas_comanda": "getLineasComanda",
    "add_linea_comanda": "addLineaComanda",
    "mesas_meta_all": "mesasMetaAll",
    "list_categorias_vendibles": "listCategoriasVendibles",
    "list_productos_by_categoria": "listProductosByCategoria",
    "search_productos_by_nombre": "searchProductosByNombre",
    "remove_one_pending_detalle": "removeOnePendingDetalle",
    "delete_detalle": "deleteDetalle",
    "update_detalle_nota": "updateDetalleNota",
    "update_detalle_ingredientes": "updateDetalleIngredientes",
    "cobrar_detalles": "cobrarDetalles",
    "kitchen_list_today_pending": "kitchenListTodayPending",
    "kitchen_set_line_state": "kitchenSetLineState",
    "inventario_list_categorias": "inventarioListCategorias",
    "inventario_create_categoria": "inventarioCreateCategoria",
    "inventario_list_proveedores_mini": "inventarioListProveedoresMini",
    "inventario_list_productos_by_categoria": "inventarioListProductosByCategoria",
    "inventario_get_resumen": "inventarioGetResumen",
    "inventario_list_alergenos": "inventarioListAlergenos",
    "inventario_get_product_detail": "inventarioGetProductDetail",
    "inventario_delete_producto": "inventarioDeleteProducto",
    "inventario_borrar_categoria": "inventarioBorrarCategoria",
    "inventario_upsert_producto": "inventarioUpsertProducto",
    "inventario_list_lotes_by_producto": "inventarioListLotesByProducto",
    "inventario_create_lote": "inventarioCreateLote",
    "inventario_update_lote": "inventarioUpdateLote",
    "inventario_ajustar_lote": "inventarioAjustarLote",
    "inventario_ajustar_stock_suelto": "inventarioAjustarStockSuelto",
    "inventario_catalogo_ingredientes": "inventarioCatalogoIngredientes",
    "inventario_ingredientes_de_producto": "inventarioIngredientesDeProducto",
    "inventario_guardar_categoria_ingrediente": "inventarioGuardarCategoriaIngrediente",
    "inventario_borrar_categoria_ingrediente": "inventarioBorrarCategoriaIngrediente",
    "inventario_guardar_ingrediente": "inventarioGuardarIngrediente",
    "inventario_borrar_ingrediente": "inventarioBorrarIngrediente",
    "tareas_get_trabajadores": "tareasGetTrabajadores",
    "tareas_create_tarea": "tareasCreateTarea",
    "tareas_get_tareas_admin": "tareasGetTareasAdmin",
    "tareas_get_tarea_by_id": "tareasGetTareaById",
    "tareas_update_tarea": "tareasUpdateTarea",
    "tareas_get_tarea_asignados": "tareasGetTareaAsignados",
    "tareas_set_asignaciones_tarea": "tareasSetAsignacionesTarea",
    "tareas_delete_tarea": "tareasDeleteTarea",
    "tareas_get_papelera": "tareasGetPapelera",
    "tareas_restaurar_tarea": "tareasRestaurarTarea",
    "tareas_vaciar_papelera": "tareasVaciarPapelera",
    "tareas_get_mis_tareas": "tareasGetMisTareas",
    "tareas_marcar_tarea_finalizada": "tareasMarcarTareaFinalizada",
    "trabajadores_get_roles": "trabajadoresGetRoles",
    "trabajadores_get_all": "trabajadoresGetAll",
    "trabajadores_get_detail": "trabajadoresGetDetail",
    "trabajadores_get_trabajador_id_by_usuario": "trabajadoresGetTrabajadorIdByUsuario",
    "trabajadores_create": "trabajadoresCreate",
    "trabajadores_update": "trabajadoresUpdate",
    "trabajadores_eliminar": "trabajadoresEliminar",
    "horarios_marcar_libre": "horariosMarcarLibre",
    "turnos_get_all": "turnosGetAll",
    "horarios_get_asignaciones_semana": "horariosGetAsignacionesSemana",
    "horarios_create_asignacion": "horariosCreateAsignacion",
    "horarios_guardar_asignacion": "horariosGuardarAsignacion",
    "horarios_update_asignacion": "horariosUpdateAsignacion",
    "horarios_delete_asignacion": "horariosDeleteAsignacion",
    "horarios_copy_semana_asignaciones": "horariosCopySemanaAsignaciones",
    "horarios_set_predeterminado_desde_semana": "horariosSetPredeterminadoDesdeSemana",
    "cuentas_get_entradas": "cuentasGetEntradas",
    "cuentas_get_salidas": "cuentasGetSalidas",
    "cuentas_get_resumen": "cuentasGetResumen",
    "cuentas_create_gasto": "cuentasCreateGasto",
    "cuentas_update_gasto": "cuentasUpdateGasto",
    "cuentas_delete_gasto": "cuentasDeleteGasto",
    "cuentas_update_pago": "cuentasUpdatePago",
    "cuentas_anular_pago": "cuentasAnularPago",
    "cuentas_lineas_devolubles": "cuentasLineasDevolubles",
    "cuentas_devolver_lineas": "cuentasDevolverLineas",
    "cuentas_previsualizar_cambio": "cuentasPrevisualizarCambio",
    "cierre_preparar": "cierrePreparar",
    "cierre_confirmar": "cierreConfirmar",
    "cierre_listar": "cierreListar",
    "cierre_detalle": "cierreDetalle",
    "cierre_reabrir": "cierreReabrir",
    "clientes_get_overview": "clientesGetOverview",
    "clientes_get_cliente_form": "clientesGetClienteForm",
    "clientes_create_cliente": "clientesCreateCliente",
    "clientes_update_cliente": "clientesUpdateCliente",
    "clientes_recalcular_gasto": "clientesRecalcularGasto",
    "reservas_get_meta": "reservasGetMeta",
    "reservas_get_mes": "reservasGetMes",
    "reservas_save": "reservasSave",
    "reservas_buscar_cliente": "reservasBuscarCliente",
    "reservas_delete": "reservasDelete",
    "reservas_cancelar": "reservasCancelar",
    "reserva_web_ajustes": "reservaWebAjustes",
    "reserva_web_activar": "reservaWebActivar",
    "reserva_web_cerrar_dia": "reservaWebCerrarDia",
    "reserva_web_quitar_cierre": "reservaWebQuitarCierre",
    "reserva_web_clave": "reservaWebClave",
    "reserva_web_mesas": "reservaWebMesas",
    "reserva_web_guardar_mesa": "reservaWebGuardarMesa",
    "proveedores_get_all": "proveedoresGetAll",
    "proveedores_save": "proveedoresSave",
    "proveedores_delete": "proveedoresDelete",
    "proveedores_get_productos": "proveedoresGetProductos",
    "proveedores_get_categorias": "proveedoresGetCategorias",
    "proveedores_get_productos_all": "proveedoresGetProductosAll",
    "proveedores_set_vinculos": "proveedoresSetVinculos",
    "pedidos_proveedor_get_page": "pedidosProveedorGetPage",
    "pedidos_proveedor_crear": "pedidosProveedorCrear",
    "pedidos_proveedor_actualizar": "pedidosProveedorActualizar",
    "pedidos_proveedor_cambiar_estado": "pedidosProveedorCambiarEstado",
    "notificaciones_listar": "notificacionesListar",
    "notificaciones_no_leidas": "notificacionesNoLeidas",
    "notificaciones_marcar_leida": "notificacionesMarcarLeida",
    "notificaciones_marcar_todas_leidas": "notificacionesMarcarTodasLeidas",
    "notificaciones_descartar": "notificacionesDescartar",
    "notificaciones_papelera": "notificacionesPapelera",
    "notificaciones_restaurar": "notificacionesRestaurar",
    "notificaciones_eliminar": "notificacionesEliminar",
    "vr_list_categorias_vendibles": "vrListCategoriasVendibles",
    "vr_list_productos_by_categoria": "vrListProductosByCategoria",
    "vr_search_productos": "vrSearchProductos",
    "vr_create_comanda_barra": "vrCreateComandaBarra",
    "vr_list_comandas_barra": "vrListComandasBarra",
    "vr_get_lineas_comanda": "vrGetLineasComanda",
    "vr_add_linea_comanda": "vrAddLineaComanda",
    "vr_remove_last_unpaid_linea": "vrRemoveLastUnpaidLinea",
    "vr_delete_linea_if_unpaid": "vrDeleteLineaIfUnpaid",
    "vr_update_nota_detalle": "vrUpdateNotaDetalle",
    "vr_cobrar_fraccionado": "vrCobrarFraccionado",
    "vr_guardar_cobro_pendiente": "vrGuardarCobroPendiente",
    "vr_listar_cobros_pendientes": "vrListarCobrosPendientes",
    "vr_resolver_cobro_pendiente": "vrResolverCobroPendiente",
    "vr_cancelar_cobro_pendiente": "vrCancelarCobroPendiente",
    "vr_delete_comanda_if_safe": "vrDeleteComandaIfSafe",
    "vr_get_index_rows": "vrGetIndexRows",
    "vr_get_detalles_ver_ticket": "vrGetDetallesVerTicket",
    "verifactu_estado": "verifactuEstado",
    "verifactu_emitir_factura_de_tickets": "verifactuEmitirFacturaDeTickets",
    "verifactu_facturas_canjeables": "verifactuFacturasCanjeables",
    "verifactu_corregir_factura": "verifactuCorregirFactura",
    "stats_mesas_get": "statsMesasGet",
    "stats_productos_list_categorias": "statsProductosListCategorias",
    "stats_productos_resumen": "statsProductosResumen",
    "stats_reservas_resumen": "statsReservasResumen",
    "stats_trabajadores_resumen": "statsTrabajadoresResumen",
    "stats_clientes_resumen": "statsClientesResumen",
    "stats_proveedores_resumen": "statsProveedoresResumen",
    "license_get_state": "licenseGetState",
    "license_activate": "licenseActivate",
    "license_sumar_clave": "licenseSumarClave",
    "license_request_device_change": "licenseRequestDeviceChange",
    "license_clear_state": "licenseClearState",
    "license_gate": "licenseGate",
    "license_check_now": "licenseCheckNow",
    "handy_set_token": "handySetToken",
    "handy_get_tenant": "handyGetTenant",
    "handy_url_imagenes": "handyUrlImagenes",
    "device_get_identity": "deviceGetIdentity",
    "device_firmar_emparejamiento": "deviceFirmarEmparejamiento",
    "device_hora_para_firmar": "deviceHoraParaFirmar",
    "reloj_desfase": "relojDesfase",
    "tpv_server_post_json": "tpvServerPostJson",
    "pair_create": "pairCreate",
    "sync_health": "syncHealth",
    "permisos_sesion": "permisosSesion",
    "permisos_configuracion": "permisosConfiguracion",
    "permisos_guardar": "permisosGuardar",
    "handy_socket_estado": "handySocketEstado",
    "handy_socket_reintentar": "handySocketReintentar",
    "sync_estado": "syncEstado",
    "sync_reintentar": "syncReintentar",
    "sync_backfill_estado": "syncBackfillEstado",
    "sync_subida_estado": "syncSubidaEstado",
    "sync_bootstrap_desde_nube": "syncBootstrapDesdeNube",
    "sync_inicializar_tenant_vacio": "syncInicializarTenantVacio",
    "jobs_status": "jobsStatus",
    "interruptores_apagados": "interruptoresApagados",
    "telemetria_fallo_de_comando": "telemetriaFalloDeComando",
    "diagnostico_generar_paquete": "diagnosticoGenerarPaquete",
    "ventana_zoom_estado": "ventanaZoomEstado",
    "ventana_zoom_cambiar": "ventanaZoomCambiar",
    "config_get_business_settings": "configGetBusinessSettings",
    "config_patch_business_settings": "configPatchBusinessSettings",
    "config_get_ticket_settings": "configGetTicketSettings",
    "config_patch_ticket_settings": "configPatchTicketSettings",
    "config_get_contact_settings": "configGetContactSettings",
    "config_patch_contact_settings": "configPatchContactSettings",
    "email_enviar_pedido": "emailEnviarPedido",
} as const;

export type NombreComando = keyof typeof nombresComandos;
type Argumentos = {
    "get_device_mode": {  };
    "set_device_mode": { args: Parameters<Comandos["setDeviceMode"]>[0] };
    "get_connection_mode": {  };
    "set_connection_mode": { args: Parameters<Comandos["setConnectionMode"]>[0] };
    "init_main": {  };
    "device_reset_mode": {  };
    "save_image": { args: Parameters<Comandos["saveImage"]>[0] };
    "images_drain_pending": {  };
    "images_upload_status": {  };
    "images_retry_upload": { args: Parameters<Comandos["imagesRetryUpload"]>[0] };
    "images_delete": { args: Parameters<Comandos["imagesDelete"]>[0] };
    "images_ensure_local": { args: Parameters<Comandos["imagesEnsureLocal"]>[0] };
    "images_backfill": {  };
    "updater_check": {  };
    "updater_status": {  };
    "updater_install": {  };
    "printer_list": {  };
    "printer_get_selected": { args: Parameters<Comandos["printerGetSelected"]>[0] };
    "printer_set_selected": { args: Parameters<Comandos["printerSetSelected"]>[0] };
    "printer_imprimir_precuenta": { payload: Parameters<Comandos["printerImprimirPrecuenta"]>[0] };
    "printer_ticket_de_pago": { args: Parameters<Comandos["printerTicketDePago"]>[0] };
    "printer_imprimir_pago": { args: Parameters<Comandos["printerImprimirPago"]>[0] };
    "printer_print_arqueo": { payload: Parameters<Comandos["printerPrintArqueo"]>[0] };
    "printer_ticket_cols": { args: Parameters<Comandos["printerTicketCols"]>[0] };
    "printer_open_drawer": {  };
    "printer_print_test": { args: Parameters<Comandos["printerPrintTest"]>[0] };
    "list_login_users": {  };
    "setup_pendiente": {  };
    "login_user": { args: Parameters<Comandos["loginUser"]>[0] };
    "logout": {  };
    "get_today_punch_status": { args: Parameters<Comandos["getTodayPunchStatus"]>[0] };
    "punch": { args: Parameters<Comandos["punch"]>[0] };
    "complete_initial_setup": { args: Parameters<Comandos["completeInitialSetup"]>[0] };
    "set_turno_partido_hoy": { args: Parameters<Comandos["setTurnoPartidoHoy"]>[0] };
    "login_recuperar_pin_solicitar": { args: Parameters<Comandos["loginRecuperarPinSolicitar"]>[0] };
    "login_recuperar_pin_confirmar": { args: Parameters<Comandos["loginRecuperarPinConfirmar"]>[0] };
    "correo_recuperacion_estado": {  };
    "correo_recuperacion_solicitar": { args: Parameters<Comandos["correoRecuperacionSolicitar"]>[0] };
    "correo_recuperacion_confirmar": { args: Parameters<Comandos["correoRecuperacionConfirmar"]>[0] };
    "correo_recuperacion_usar_el_de_la_compra": {  };
    "recovery_status": {  };
    "recovery_list_backups": {  };
    "recovery_create_backup": {  };
    "recovery_export_backup": { backupId: Parameters<Comandos["recoveryExportBackup"]>[0]; destino: Parameters<Comandos["recoveryExportBackup"]>[1] };
    "recovery_import_backup": { origen: Parameters<Comandos["recoveryImportBackup"]>[0] };
    "recovery_restore_backup": { backupId: Parameters<Comandos["recoveryRestoreBackup"]>[0] };
    "save_layout": { args: Parameters<Comandos["saveLayout"]>[0] };
    "load_layout": {  };
    "set_reserva_estado": { args: Parameters<Comandos["setReservaEstado"]>[0] };
    "get_comanda_abierta_by_mesa": { args: Parameters<Comandos["getComandaAbiertaByMesa"]>[0] };
    "abrir_comanda": { args: Parameters<Comandos["abrirComanda"]>[0] };
    "mesas_abrir_o_retomar": { args: Parameters<Comandos["mesasAbrirORetomar"]>[0] };
    "comanda_set_trabajador_if_null": { args: Parameters<Comandos["comandaSetTrabajadorIfNull"]>[0] };
    "comanda_set_reserva_if_null": { args: Parameters<Comandos["comandaSetReservaIfNull"]>[0] };
    "get_lineas_comanda": { args: Parameters<Comandos["getLineasComanda"]>[0] };
    "add_linea_comanda": { args: Parameters<Comandos["addLineaComanda"]>[0] };
    "mesas_meta_all": {  };
    "list_categorias_vendibles": {  };
    "list_productos_by_categoria": { args: Parameters<Comandos["listProductosByCategoria"]>[0] };
    "search_productos_by_nombre": { args: Parameters<Comandos["searchProductosByNombre"]>[0] };
    "remove_one_pending_detalle": { args: Parameters<Comandos["removeOnePendingDetalle"]>[0] };
    "delete_detalle": { args: Parameters<Comandos["deleteDetalle"]>[0] };
    "update_detalle_nota": { args: Parameters<Comandos["updateDetalleNota"]>[0] };
    "update_detalle_ingredientes": { args: Parameters<Comandos["updateDetalleIngredientes"]>[0] };
    "cobrar_detalles": { args: Parameters<Comandos["cobrarDetalles"]>[0] };
    "kitchen_list_today_pending": {  };
    "kitchen_set_line_state": { args: Parameters<Comandos["kitchenSetLineState"]>[0] };
    "inventario_list_categorias": {  };
    "inventario_create_categoria": { args: Parameters<Comandos["inventarioCreateCategoria"]>[0] };
    "inventario_list_proveedores_mini": {  };
    "inventario_list_productos_by_categoria": { args: Parameters<Comandos["inventarioListProductosByCategoria"]>[0] };
    "inventario_get_resumen": { args: Parameters<Comandos["inventarioGetResumen"]>[0] };
    "inventario_list_alergenos": {  };
    "inventario_get_product_detail": { args: Parameters<Comandos["inventarioGetProductDetail"]>[0] };
    "inventario_delete_producto": { args: Parameters<Comandos["inventarioDeleteProducto"]>[0] };
    "inventario_borrar_categoria": { args: Parameters<Comandos["inventarioBorrarCategoria"]>[0] };
    "inventario_upsert_producto": { args: Parameters<Comandos["inventarioUpsertProducto"]>[0] };
    "inventario_list_lotes_by_producto": { args: Parameters<Comandos["inventarioListLotesByProducto"]>[0] };
    "inventario_create_lote": { args: Parameters<Comandos["inventarioCreateLote"]>[0] };
    "inventario_update_lote": { args: Parameters<Comandos["inventarioUpdateLote"]>[0] };
    "inventario_ajustar_lote": { args: Parameters<Comandos["inventarioAjustarLote"]>[0] };
    "inventario_ajustar_stock_suelto": { args: Parameters<Comandos["inventarioAjustarStockSuelto"]>[0] };
    "inventario_catalogo_ingredientes": {  };
    "inventario_ingredientes_de_producto": { args: Parameters<Comandos["inventarioIngredientesDeProducto"]>[0] };
    "inventario_guardar_categoria_ingrediente": { args: Parameters<Comandos["inventarioGuardarCategoriaIngrediente"]>[0] };
    "inventario_borrar_categoria_ingrediente": { args: Parameters<Comandos["inventarioBorrarCategoriaIngrediente"]>[0] };
    "inventario_guardar_ingrediente": { args: Parameters<Comandos["inventarioGuardarIngrediente"]>[0] };
    "inventario_borrar_ingrediente": { args: Parameters<Comandos["inventarioBorrarIngrediente"]>[0] };
    "tareas_get_trabajadores": {  };
    "tareas_create_tarea": { args: Parameters<Comandos["tareasCreateTarea"]>[0] };
    "tareas_get_tareas_admin": {  };
    "tareas_get_tarea_by_id": { args: Parameters<Comandos["tareasGetTareaById"]>[0] };
    "tareas_update_tarea": { args: Parameters<Comandos["tareasUpdateTarea"]>[0] };
    "tareas_get_tarea_asignados": { args: Parameters<Comandos["tareasGetTareaAsignados"]>[0] };
    "tareas_set_asignaciones_tarea": { args: Parameters<Comandos["tareasSetAsignacionesTarea"]>[0] };
    "tareas_delete_tarea": { args: Parameters<Comandos["tareasDeleteTarea"]>[0] };
    "tareas_get_papelera": {  };
    "tareas_restaurar_tarea": { args: Parameters<Comandos["tareasRestaurarTarea"]>[0] };
    "tareas_vaciar_papelera": {  };
    "tareas_get_mis_tareas": { args: Parameters<Comandos["tareasGetMisTareas"]>[0] };
    "tareas_marcar_tarea_finalizada": { args: Parameters<Comandos["tareasMarcarTareaFinalizada"]>[0] };
    "trabajadores_get_roles": {  };
    "trabajadores_get_all": {  };
    "trabajadores_get_detail": { args: Parameters<Comandos["trabajadoresGetDetail"]>[0] };
    "trabajadores_get_trabajador_id_by_usuario": { args: Parameters<Comandos["trabajadoresGetTrabajadorIdByUsuario"]>[0] };
    "trabajadores_create": { args: Parameters<Comandos["trabajadoresCreate"]>[0] };
    "trabajadores_update": { args: Parameters<Comandos["trabajadoresUpdate"]>[0] };
    "trabajadores_eliminar": { args: Parameters<Comandos["trabajadoresEliminar"]>[0] };
    "horarios_marcar_libre": { args: Parameters<Comandos["horariosMarcarLibre"]>[0] };
    "turnos_get_all": {  };
    "horarios_get_asignaciones_semana": { args: Parameters<Comandos["horariosGetAsignacionesSemana"]>[0] };
    "horarios_create_asignacion": { args: Parameters<Comandos["horariosCreateAsignacion"]>[0] };
    "horarios_guardar_asignacion": { args: Parameters<Comandos["horariosGuardarAsignacion"]>[0] };
    "horarios_update_asignacion": { args: Parameters<Comandos["horariosUpdateAsignacion"]>[0] };
    "horarios_delete_asignacion": { args: Parameters<Comandos["horariosDeleteAsignacion"]>[0] };
    "horarios_copy_semana_asignaciones": { args: Parameters<Comandos["horariosCopySemanaAsignaciones"]>[0] };
    "horarios_set_predeterminado_desde_semana": { args: Parameters<Comandos["horariosSetPredeterminadoDesdeSemana"]>[0] };
    "cuentas_get_entradas": { args: Parameters<Comandos["cuentasGetEntradas"]>[0] };
    "cuentas_get_salidas": { args: Parameters<Comandos["cuentasGetSalidas"]>[0] };
    "cuentas_get_resumen": { args: Parameters<Comandos["cuentasGetResumen"]>[0] };
    "cuentas_create_gasto": { args: Parameters<Comandos["cuentasCreateGasto"]>[0]; motivoRectificacion: Parameters<Comandos["cuentasCreateGasto"]>[1] };
    "cuentas_update_gasto": { args: Parameters<Comandos["cuentasUpdateGasto"]>[0]; motivoRectificacion: Parameters<Comandos["cuentasUpdateGasto"]>[1] };
    "cuentas_delete_gasto": { args: Parameters<Comandos["cuentasDeleteGasto"]>[0]; motivoRectificacion: Parameters<Comandos["cuentasDeleteGasto"]>[1] };
    "cuentas_update_pago": { args: Parameters<Comandos["cuentasUpdatePago"]>[0]; motivoRectificacion: Parameters<Comandos["cuentasUpdatePago"]>[1] };
    "cuentas_anular_pago": { args: Parameters<Comandos["cuentasAnularPago"]>[0] };
    "cuentas_lineas_devolubles": { idPago: Parameters<Comandos["cuentasLineasDevolubles"]>[0] };
    "cuentas_devolver_lineas": { args: Parameters<Comandos["cuentasDevolverLineas"]>[0] };
    "cuentas_previsualizar_cambio": { args: Parameters<Comandos["cuentasPrevisualizarCambio"]>[0] };
    "cierre_preparar": {  };
    "cierre_confirmar": { args: Parameters<Comandos["cierreConfirmar"]>[0] };
    "cierre_listar": { args: Parameters<Comandos["cierreListar"]>[0] };
    "cierre_detalle": { idCierre: Parameters<Comandos["cierreDetalle"]>[0] };
    "cierre_reabrir": { args: Parameters<Comandos["cierreReabrir"]>[0] };
    "clientes_get_overview": { args: Parameters<Comandos["clientesGetOverview"]>[0] };
    "clientes_get_cliente_form": { args: Parameters<Comandos["clientesGetClienteForm"]>[0] };
    "clientes_create_cliente": { args: Parameters<Comandos["clientesCreateCliente"]>[0] };
    "clientes_update_cliente": { args: Parameters<Comandos["clientesUpdateCliente"]>[0] };
    "clientes_recalcular_gasto": { args: Parameters<Comandos["clientesRecalcularGasto"]>[0] };
    "reservas_get_meta": {  };
    "reservas_get_mes": { args: Parameters<Comandos["reservasGetMes"]>[0] };
    "reservas_save": { args: Parameters<Comandos["reservasSave"]>[0] };
    "reservas_buscar_cliente": { args: Parameters<Comandos["reservasBuscarCliente"]>[0] };
    "reservas_delete": { args: Parameters<Comandos["reservasDelete"]>[0] };
    "reservas_cancelar": { args: Parameters<Comandos["reservasCancelar"]>[0] };
    "reserva_web_ajustes": {  };
    "reserva_web_activar": { args: Parameters<Comandos["reservaWebActivar"]>[0] };
    "reserva_web_cerrar_dia": { args: Parameters<Comandos["reservaWebCerrarDia"]>[0] };
    "reserva_web_quitar_cierre": { args: Parameters<Comandos["reservaWebQuitarCierre"]>[0] };
    "reserva_web_clave": {  };
    "reserva_web_mesas": {  };
    "reserva_web_guardar_mesa": { args: Parameters<Comandos["reservaWebGuardarMesa"]>[0] };
    "proveedores_get_all": {  };
    "proveedores_save": { args: Parameters<Comandos["proveedoresSave"]>[0] };
    "proveedores_delete": { args: Parameters<Comandos["proveedoresDelete"]>[0] };
    "proveedores_get_productos": { args: Parameters<Comandos["proveedoresGetProductos"]>[0] };
    "proveedores_get_categorias": {  };
    "proveedores_get_productos_all": {  };
    "proveedores_set_vinculos": { args: Parameters<Comandos["proveedoresSetVinculos"]>[0] };
    "pedidos_proveedor_get_page": { args: Parameters<Comandos["pedidosProveedorGetPage"]>[0] };
    "pedidos_proveedor_crear": { args: Parameters<Comandos["pedidosProveedorCrear"]>[0] };
    "pedidos_proveedor_actualizar": { args: Parameters<Comandos["pedidosProveedorActualizar"]>[0] };
    "pedidos_proveedor_cambiar_estado": { args: Parameters<Comandos["pedidosProveedorCambiarEstado"]>[0] };
    "notificaciones_listar": { args: Parameters<Comandos["notificacionesListar"]>[0] };
    "notificaciones_no_leidas": {  };
    "notificaciones_marcar_leida": { args: Parameters<Comandos["notificacionesMarcarLeida"]>[0] };
    "notificaciones_marcar_todas_leidas": {  };
    "notificaciones_descartar": { args: Parameters<Comandos["notificacionesDescartar"]>[0] };
    "notificaciones_papelera": {  };
    "notificaciones_restaurar": { args: Parameters<Comandos["notificacionesRestaurar"]>[0] };
    "notificaciones_eliminar": { args: Parameters<Comandos["notificacionesEliminar"]>[0] };
    "vr_list_categorias_vendibles": {  };
    "vr_list_productos_by_categoria": { args: Parameters<Comandos["vrListProductosByCategoria"]>[0] };
    "vr_search_productos": { args: Parameters<Comandos["vrSearchProductos"]>[0] };
    "vr_create_comanda_barra": { args: Parameters<Comandos["vrCreateComandaBarra"]>[0] };
    "vr_list_comandas_barra": { args: Parameters<Comandos["vrListComandasBarra"]>[0] };
    "vr_get_lineas_comanda": { args: Parameters<Comandos["vrGetLineasComanda"]>[0] };
    "vr_add_linea_comanda": { args: Parameters<Comandos["vrAddLineaComanda"]>[0] };
    "vr_remove_last_unpaid_linea": { args: Parameters<Comandos["vrRemoveLastUnpaidLinea"]>[0] };
    "vr_delete_linea_if_unpaid": { args: Parameters<Comandos["vrDeleteLineaIfUnpaid"]>[0] };
    "vr_update_nota_detalle": { args: Parameters<Comandos["vrUpdateNotaDetalle"]>[0] };
    "vr_cobrar_fraccionado": { args: Parameters<Comandos["vrCobrarFraccionado"]>[0] };
    "vr_guardar_cobro_pendiente": { args: Parameters<Comandos["vrGuardarCobroPendiente"]>[0] };
    "vr_listar_cobros_pendientes": {  };
    "vr_resolver_cobro_pendiente": { args: Parameters<Comandos["vrResolverCobroPendiente"]>[0] };
    "vr_cancelar_cobro_pendiente": { idPago: Parameters<Comandos["vrCancelarCobroPendiente"]>[0] };
    "vr_delete_comanda_if_safe": { args: Parameters<Comandos["vrDeleteComandaIfSafe"]>[0] };
    "vr_get_index_rows": { args: Parameters<Comandos["vrGetIndexRows"]>[0] };
    "vr_get_detalles_ver_ticket": { args: Parameters<Comandos["vrGetDetallesVerTicket"]>[0] };
    "verifactu_estado": {  };
    "verifactu_emitir_factura_de_tickets": { idPagos: Parameters<Comandos["verifactuEmitirFacturaDeTickets"]>[0]; destinatario: Parameters<Comandos["verifactuEmitirFacturaDeTickets"]>[1] };
    "verifactu_facturas_canjeables": { idPagos: Parameters<Comandos["verifactuFacturasCanjeables"]>[0] };
    "verifactu_corregir_factura": { numFactura: Parameters<Comandos["verifactuCorregirFactura"]>[0]; destinatario: Parameters<Comandos["verifactuCorregirFactura"]>[1] };
    "stats_mesas_get": { range: Parameters<Comandos["statsMesasGet"]>[0] };
    "stats_productos_list_categorias": {  };
    "stats_productos_resumen": { args: Parameters<Comandos["statsProductosResumen"]>[0] };
    "stats_reservas_resumen": { args: Parameters<Comandos["statsReservasResumen"]>[0] };
    "stats_trabajadores_resumen": { args: Parameters<Comandos["statsTrabajadoresResumen"]>[0] };
    "stats_clientes_resumen": { args: Parameters<Comandos["statsClientesResumen"]>[0] };
    "stats_proveedores_resumen": { args: Parameters<Comandos["statsProveedoresResumen"]>[0] };
    "license_get_state": {  };
    "license_activate": { args: Parameters<Comandos["licenseActivate"]>[0] };
    "license_sumar_clave": { args: Parameters<Comandos["licenseSumarClave"]>[0] };
    "license_request_device_change": { args: Parameters<Comandos["licenseRequestDeviceChange"]>[0] };
    "license_clear_state": {  };
    "license_gate": {  };
    "license_check_now": {  };
    "handy_set_token": { args: Parameters<Comandos["handySetToken"]>[0] };
    "handy_get_tenant": {  };
    "handy_url_imagenes": {  };
    "device_get_identity": {  };
    "device_firmar_emparejamiento": { args: Parameters<Comandos["deviceFirmarEmparejamiento"]>[0] };
    "device_hora_para_firmar": {  };
    "reloj_desfase": {  };
    "tpv_server_post_json": { args: Parameters<Comandos["tpvServerPostJson"]>[0] };
    "pair_create": {  };
    "sync_health": {  };
    "permisos_sesion": {  };
    "permisos_configuracion": {  };
    "permisos_guardar": { args: Parameters<Comandos["permisosGuardar"]>[0] };
    "handy_socket_estado": {  };
    "handy_socket_reintentar": { forzar: Parameters<Comandos["handySocketReintentar"]>[0] };
    "sync_estado": {  };
    "sync_reintentar": {  };
    "sync_backfill_estado": {  };
    "sync_subida_estado": {  };
    "sync_bootstrap_desde_nube": {  };
    "sync_inicializar_tenant_vacio": {  };
    "jobs_status": {  };
    "interruptores_apagados": {  };
    "telemetria_fallo_de_comando": { args: Parameters<Comandos["telemetriaFalloDeComando"]>[0] };
    "diagnostico_generar_paquete": {  };
    "ventana_zoom_estado": {  };
    "ventana_zoom_cambiar": { args: Parameters<Comandos["ventanaZoomCambiar"]>[0] };
    "config_get_business_settings": {  };
    "config_patch_business_settings": { args: Parameters<Comandos["configPatchBusinessSettings"]>[0] };
    "config_get_ticket_settings": {  };
    "config_patch_ticket_settings": { args: Parameters<Comandos["configPatchTicketSettings"]>[0] };
    "config_get_contact_settings": {  };
    "config_patch_contact_settings": { args: Parameters<Comandos["configPatchContactSettings"]>[0] };
    "email_enviar_pedido": { args: Parameters<Comandos["emailEnviarPedido"]>[0] };
};
export type ArgsComando<N extends NombreComando> = Argumentos[N];
export type RetornoComando<N extends NombreComando> = Awaited<ReturnType<Comandos[(typeof nombresComandos)[N]]>>;
