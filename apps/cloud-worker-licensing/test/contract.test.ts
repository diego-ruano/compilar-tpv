// test/contract.test.ts
//
// Tests de contrato Main(Rust) ↔ worker(TS) — ARCH-01. Ver `tests/contract/README.md`.
//
// La lógica de convertir un cobro en SQL vive dos veces (Rust en la Main, este worker para la Handy)
// y tiene que dejar el MISMO efecto para que la replicación converja. Aquí el worker siembra el mismo
// estado que el lado Rust, corre SU cobro, aplica las sentencias y comprueba que las filas resultantes
// coinciden con el `golden` que bendijo Rust (el lado canónico: escritor único).
//
// Se compara el EFECTO (las filas), no el texto SQL: los dos lados escribieron su SQL por separado y
// difiere aunque el resultado sea idéntico; comparar el texto daría falsos positivos.

import { describe, it, expect } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";
import { clienteLocal, GuardaIncumplida, loteEnBruto } from "../src/durableObjects/tenantHub.sqlite";

import { createCliente, updateCliente } from "../src/domains/clientes/clientes.commands";
import { punchEntrada, punchSalida, setTurnoPartido } from "../src/domains/login/login.commands";
import { getOpenPunch } from "../src/domains/login/login.queries";
import {
	anularPago,
	createGasto,
	deleteGasto,
	updateGasto,
	updatePago,
} from "../src/domains/cuentas/cuentas.commands";
import {
	actualizar as actualizarNotificacion,
	crear as crearNotificacion,
	descartar as descartarNotificacion,
	eliminar as eliminarNotificacion,
	marcarLeida,
	marcarLeidasBatch,
	normalizar as normalizarNotificacion,
	resolverPorClave,
	restaurar as restaurarNotificacion,
} from "../src/domains/notificaciones/notificaciones.commands";
import {
	activaPorClave,
	idsNoLeidas,
} from "../src/domains/notificaciones/notificaciones.queries";
import {
	copySemana,
	guardarAsignacion,
	deleteAsignacion,
	eliminarTrabajador,
	marcarLibre,
	setPredeterminadoDesdeSemana,
} from "../src/domains/trabajadores/trabajadores.commands";
import {
	filasSemana,
	predeterminadoDesdeSemanaItems,
	usuarioDeTrabajador,
} from "../src/domains/trabajadores/trabajadores.queries";
import {
	patchBusiness,
	patchContact,
	patchTicket,
} from "../src/domains/configuracion/configuracion.commands";
import {
	ajustarLote,
	ajustarStockSuelto,
	borrarCategoria,
	createCategoria,
	createLote,
	deleteProducto,
	updateLote,
	upsertProducto,
} from "../src/domains/inventario/inventario.commands";
import {
	borrarCategoriaIngrediente,
	borrarIngrediente,
	guardarCategoriaIngrediente,
	guardarIngrediente,
} from "../src/domains/inventario/ingredientes.commands";
import {
	abrirComanda,
	addLinea as addLineaMesa,
	cobrarDetalles,
	deleteDetalle,
	kitchenSetLineState,
	removeOnePendingDetalle,
	saveLayout,
	setReservaEstado,
	setReservaIfNull,
	setTrabajadorIfNull,
	updateDetalleIngredientes,
	updateDetalleNota,
} from "../src/domains/mesas/mesas.commands";
import { planAbrirORetomar } from "../src/domains/mesas/abrirORetomar";
import { cobrarDetallesPlan, datosDeLinea } from "../src/domains/mesas/mesas.queries";
import {
	eliminarProveedor,
	guardarProveedor,
	setVinculos,
} from "../src/domains/proveedores/proveedores.commands";
import {
	actualizar as actualizarPedido,
	cambiarEstado as cambiarEstadoPedido,
	crear as crearPedido,
} from "../src/domains/pedidos_proveedor/pedidos_proveedor.commands";
import { cancelarReserva, deleteReserva, saveReserva } from "../src/domains/reservas/reservas.commands";
import { estadoYOrigen, resolverCliente } from "../src/domains/reservas/reservas.queries";
import { reservaSaveSchema } from "../src/domains/reservas/reservas.schemas";
import {
	createTarea,
	deleteTarea,
	marcarFinalizada,
	setAsignacionesTarea,
	updateTarea,
	restaurarTarea,
	vaciarPapelera,
} from "../src/domains/tareas/tareas.commands";
import {
	addLinea,
	cobrarFraccionado,
	createComandaBarra,
	deleteComandaIfSafe,
	deleteLineaIfUnpaid,
	removeLastUnpaidLinea,
	updateNotaDetalle,
} from "../src/domains/venta_rapida/venta_rapida.commands";
import { cobrarPlan, hasPaidLines } from "../src/domains/venta_rapida/venta_rapida.queries";

// Casos del harness. Los goldens los bendice Rust (lado canónico). Añadir uno: crear el fixture,
// bendecir su golden y sumar aquí su par caso/golden (workerd no lee del disco: los imports son
// estáticos y esbuild los empaqueta). La misma lista, en Rust, vive en `contract_tests.rs::CASOS`.
import casoVrUnLote from "../../../tests/contract/casos/venta_rapida/cobro_fraccionado_un_lote.json";
import goldenVrUnLote from "../../../tests/contract/golden/venta_rapida/cobro_fraccionado_un_lote.json";
import casoVrMultilote from "../../../tests/contract/casos/venta_rapida/cobro_fraccionado_fefo_multilote.json";
import goldenVrMultilote from "../../../tests/contract/golden/venta_rapida/cobro_fraccionado_fefo_multilote.json";
import casoVr120 from "../../../tests/contract/casos/venta_rapida/cobro_fraccionado_120_lineas.json";
import goldenVr120 from "../../../tests/contract/golden/venta_rapida/cobro_fraccionado_120_lineas.json";
import casoMesasCobro from "../../../tests/contract/casos/mesas/cobrar_detalles_un_lote.json";
import goldenMesasCobro from "../../../tests/contract/golden/mesas/cobrar_detalles_un_lote.json";
import casoMesasCobroCliente from "../../../tests/contract/casos/mesas/cobrar_detalles_con_cliente.json";
import goldenMesasCobroCliente from "../../../tests/contract/golden/mesas/cobrar_detalles_con_cliente.json";
import casoMesasCobroSuelto from "../../../tests/contract/casos/mesas/cobrar_detalles_lote_y_suelto.json";
import goldenMesasCobroSuelto from "../../../tests/contract/golden/mesas/cobrar_detalles_lote_y_suelto.json";
import casoMesasCobroDecimos from "../../../tests/contract/casos/mesas/cobrar_detalles_decimos.json";
import goldenMesasCobroDecimos from "../../../tests/contract/golden/mesas/cobrar_detalles_decimos.json";
import casoMesasCobro120 from "../../../tests/contract/casos/mesas/cobrar_detalles_120_lineas.json";
import goldenMesasCobro120 from "../../../tests/contract/golden/mesas/cobrar_detalles_120_lineas.json";
import casoCliCrear from "../../../tests/contract/casos/clientes/crear.json";
import goldenCliCrear from "../../../tests/contract/golden/clientes/crear.json";
import casoCliActualizar from "../../../tests/contract/casos/clientes/actualizar.json";
import goldenCliActualizar from "../../../tests/contract/golden/clientes/actualizar.json";
import casoTareaCrear from "../../../tests/contract/casos/tareas/crear.json";
import goldenTareaCrear from "../../../tests/contract/golden/tareas/crear.json";
import casoTareaActualizar from "../../../tests/contract/casos/tareas/actualizar.json";
import goldenTareaActualizar from "../../../tests/contract/golden/tareas/actualizar.json";
import casoTareaSetAsig from "../../../tests/contract/casos/tareas/set_asignaciones.json";
import casoTareaSetAsig120 from "../../../tests/contract/casos/tareas/set_asignaciones_120.json";
import goldenTareaSetAsig120 from "../../../tests/contract/golden/tareas/set_asignaciones_120.json";
import goldenTareaSetAsig from "../../../tests/contract/golden/tareas/set_asignaciones.json";
import casoTareaEliminar from "../../../tests/contract/casos/tareas/eliminar.json";
import goldenTareaEliminar from "../../../tests/contract/golden/tareas/eliminar.json";
import casoTareaRestaurar from "../../../tests/contract/casos/tareas/restaurar.json";
import goldenTareaRestaurar from "../../../tests/contract/golden/tareas/restaurar.json";
import casoTareaVaciar from "../../../tests/contract/casos/tareas/vaciar_papelera.json";
import goldenTareaVaciar from "../../../tests/contract/golden/tareas/vaciar_papelera.json";
import casoTareaFinalizar from "../../../tests/contract/casos/tareas/marcar_finalizada.json";
import goldenTareaFinalizar from "../../../tests/contract/golden/tareas/marcar_finalizada.json";
import casoInvCreateLote from "../../../tests/contract/casos/inventario/create_lote.json";
import goldenInvCreateLote from "../../../tests/contract/golden/inventario/create_lote.json";
import casoInvCreateLoteExistente from "../../../tests/contract/casos/inventario/create_lote_id_existente.json";
import goldenInvCreateLoteExistente from "../../../tests/contract/golden/inventario/create_lote_id_existente.json";
import casoInvCategoria from "../../../tests/contract/casos/inventario/create_categoria.json";
import goldenInvCategoria from "../../../tests/contract/golden/inventario/create_categoria.json";
import casoInvUpsertProd from "../../../tests/contract/casos/inventario/upsert_producto.json";
import goldenInvUpsertProd from "../../../tests/contract/golden/inventario/upsert_producto.json";
import casoInvDeleteProd from "../../../tests/contract/casos/inventario/delete_producto.json";
import goldenInvDeleteProd from "../../../tests/contract/golden/inventario/delete_producto.json";
import casoInvDeleteLoteVendido from "../../../tests/contract/casos/inventario/delete_producto_con_lote_vendido.json";
import goldenInvDeleteLoteVendido from "../../../tests/contract/golden/inventario/delete_producto_con_lote_vendido.json";
import casoInvDeleteSinHistoria from "../../../tests/contract/casos/inventario/delete_producto_sin_historia.json";
import goldenInvDeleteSinHistoria from "../../../tests/contract/golden/inventario/delete_producto_sin_historia.json";
import casoInvUpdateLote from "../../../tests/contract/casos/inventario/update_lote.json";
import goldenInvUpdateLote from "../../../tests/contract/golden/inventario/update_lote.json";
import casoInvAjustarLote from "../../../tests/contract/casos/inventario/ajustar_lote.json";
import goldenInvAjustarLote from "../../../tests/contract/golden/inventario/ajustar_lote.json";
import casoInvAjustarLoteTarde from "../../../tests/contract/casos/inventario/ajustar_lote_stock_cambiado.json";
import goldenInvAjustarLoteTarde from "../../../tests/contract/golden/inventario/ajustar_lote_stock_cambiado.json";
import casoInvAjustarSuelto from "../../../tests/contract/casos/inventario/ajustar_stock_suelto.json";
import goldenInvAjustarSuelto from "../../../tests/contract/golden/inventario/ajustar_stock_suelto.json";
import casoInvUpsertSuelto from "../../../tests/contract/casos/inventario/upsert_producto_con_suelto.json";
import goldenInvUpsertSuelto from "../../../tests/contract/golden/inventario/upsert_producto_con_suelto.json";
import casoInvUpsertNoSuelto from "../../../tests/contract/casos/inventario/upsert_producto_no_toca_suelto.json";
import goldenInvUpsertNoSuelto from "../../../tests/contract/golden/inventario/upsert_producto_no_toca_suelto.json";
import casoCfgBusiness from "../../../tests/contract/casos/configuracion/patch_business.json";
import goldenCfgBusiness from "../../../tests/contract/golden/configuracion/patch_business.json";
import casoCfgContact from "../../../tests/contract/casos/configuracion/patch_contact.json";
import goldenCfgContact from "../../../tests/contract/golden/configuracion/patch_contact.json";
import casoCfgTicket from "../../../tests/contract/casos/configuracion/patch_ticket.json";
import goldenCfgTicket from "../../../tests/contract/golden/configuracion/patch_ticket.json";
import casoProvGuardar from "../../../tests/contract/casos/proveedores/guardar.json";
import goldenProvGuardar from "../../../tests/contract/golden/proveedores/guardar.json";
import casoProvEliminar from "../../../tests/contract/casos/proveedores/eliminar.json";
import goldenProvEliminar from "../../../tests/contract/golden/proveedores/eliminar.json";
import casoProvVinculos from "../../../tests/contract/casos/proveedores/set_vinculos.json";
import goldenProvVinculos from "../../../tests/contract/golden/proveedores/set_vinculos.json";
import casoPedCrear from "../../../tests/contract/casos/pedidos_proveedor/crear.json";
import goldenPedCrear from "../../../tests/contract/golden/pedidos_proveedor/crear.json";
import casoPedCrearSinProv from "../../../tests/contract/casos/pedidos_proveedor/crear_sin_proveedor.json";
import goldenPedCrearSinProv from "../../../tests/contract/golden/pedidos_proveedor/crear_sin_proveedor.json";
import casoPedActualizar from "../../../tests/contract/casos/pedidos_proveedor/actualizar.json";
import goldenPedActualizar from "../../../tests/contract/golden/pedidos_proveedor/actualizar.json";
import casoPedActualizarEnviado from "../../../tests/contract/casos/pedidos_proveedor/actualizar_enviado.json";
import goldenPedActualizarEnviado from "../../../tests/contract/golden/pedidos_proveedor/actualizar_enviado.json";
import casoPedEnviar from "../../../tests/contract/casos/pedidos_proveedor/cambiar_estado_enviar.json";
import goldenPedEnviar from "../../../tests/contract/golden/pedidos_proveedor/cambiar_estado_enviar.json";
import casoPedProvBorrado from "../../../tests/contract/casos/pedidos_proveedor/cambiar_estado_proveedor_borrado.json";
import goldenPedProvBorrado from "../../../tests/contract/golden/pedidos_proveedor/cambiar_estado_proveedor_borrado.json";
import casoPedYaEnviado from "../../../tests/contract/casos/pedidos_proveedor/cambiar_estado_ya_enviado.json";
import goldenPedYaEnviado from "../../../tests/contract/golden/pedidos_proveedor/cambiar_estado_ya_enviado.json";
import casoResNuevo from "../../../tests/contract/casos/reservas/guardar_cliente_nuevo.json";
import goldenResNuevo from "../../../tests/contract/golden/reservas/guardar_cliente_nuevo.json";
import casoResExistente from "../../../tests/contract/casos/reservas/guardar_cliente_existente.json";
import goldenResExistente from "../../../tests/contract/golden/reservas/guardar_cliente_existente.json";
import casoResSinMesa from "../../../tests/contract/casos/reservas/guardar_sin_mesa.json";
import goldenResSinMesa from "../../../tests/contract/golden/reservas/guardar_sin_mesa.json";
import casoResConDuracion from "../../../tests/contract/casos/reservas/guardar_con_duracion.json";
import goldenResConDuracion from "../../../tests/contract/golden/reservas/guardar_con_duracion.json";
import casoResWebOrigen from "../../../tests/contract/casos/reservas/editar_web_conserva_origen.json";
import goldenResWebOrigen from "../../../tests/contract/golden/reservas/editar_web_conserva_origen.json";
import casoResSinCliente from "../../../tests/contract/casos/reservas/guardar_sin_cliente.json";
import goldenResSinCliente from "../../../tests/contract/golden/reservas/guardar_sin_cliente.json";
import casoResOtraPersona from "../../../tests/contract/casos/reservas/guardar_otra_persona_mismo_telefono.json";
import goldenResOtraPersona from "../../../tests/contract/golden/reservas/guardar_otra_persona_mismo_telefono.json";
import casoResEliminar from "../../../tests/contract/casos/reservas/eliminar.json";
import goldenResEliminar from "../../../tests/contract/golden/reservas/eliminar.json";
import casoResEditarEstado from "../../../tests/contract/casos/reservas/editar_conserva_estado.json";
import goldenResEditarEstado from "../../../tests/contract/golden/reservas/editar_conserva_estado.json";
import casoResCancelarWeb from "../../../tests/contract/casos/reservas/cancelar_web.json";
import goldenResCancelarWeb from "../../../tests/contract/golden/reservas/cancelar_web.json";
import casoVrCrearComanda from "../../../tests/contract/casos/venta_rapida/create_comanda_barra.json";
import goldenVrCrearComanda from "../../../tests/contract/golden/venta_rapida/create_comanda_barra.json";
import casoVrAddLinea from "../../../tests/contract/casos/venta_rapida/add_linea.json";
import goldenVrAddLinea from "../../../tests/contract/golden/venta_rapida/add_linea.json";
import casoVrAddLineaSinPrecio from "../../../tests/contract/casos/venta_rapida/add_linea_sin_precio.json";
import goldenVrAddLineaSinPrecio from "../../../tests/contract/golden/venta_rapida/add_linea_sin_precio.json";
import casoVrRemoveLast from "../../../tests/contract/casos/venta_rapida/remove_last_unpaid_linea.json";
import goldenVrRemoveLast from "../../../tests/contract/golden/venta_rapida/remove_last_unpaid_linea.json";
import casoVrDeleteLinea from "../../../tests/contract/casos/venta_rapida/delete_linea_if_unpaid.json";
import goldenVrDeleteLinea from "../../../tests/contract/golden/venta_rapida/delete_linea_if_unpaid.json";
import casoVrUpdateNota from "../../../tests/contract/casos/venta_rapida/update_nota_detalle.json";
import goldenVrUpdateNota from "../../../tests/contract/golden/venta_rapida/update_nota_detalle.json";
import casoVrDeleteComanda from "../../../tests/contract/casos/venta_rapida/delete_comanda_if_safe.json";
import goldenVrDeleteComanda from "../../../tests/contract/golden/venta_rapida/delete_comanda_if_safe.json";
import casoMesaSaveLayout from "../../../tests/contract/casos/mesas/save_layout.json";
import goldenMesaSaveLayout from "../../../tests/contract/golden/mesas/save_layout.json";
import casoMesaSaveLayoutArchiva from "../../../tests/contract/casos/mesas/save_layout_archiva.json";
import casoMesaSaveLayout120 from "../../../tests/contract/casos/mesas/save_layout_120_mesas.json";
import goldenMesaSaveLayout120 from "../../../tests/contract/golden/mesas/save_layout_120_mesas.json";
import goldenMesaSaveLayoutArchiva from "../../../tests/contract/golden/mesas/save_layout_archiva.json";
import casoMesaAbrir from "../../../tests/contract/casos/mesas/abrir_comanda.json";
import goldenMesaAbrir from "../../../tests/contract/golden/mesas/abrir_comanda.json";
import casoMesaSetTrab from "../../../tests/contract/casos/mesas/set_trabajador_if_null.json";
import goldenMesaSetTrab from "../../../tests/contract/golden/mesas/set_trabajador_if_null.json";
import casoMesaAbrirORetomar from "../../../tests/contract/casos/mesas/abrir_o_retomar.json";
import goldenMesaAbrirORetomar from "../../../tests/contract/golden/mesas/abrir_o_retomar.json";
import casoMesaAbrirORetomarSinAbierta from "../../../tests/contract/casos/mesas/abrir_o_retomar_sin_abierta.json";
import goldenMesaAbrirORetomarSinAbierta from "../../../tests/contract/golden/mesas/abrir_o_retomar_sin_abierta.json";
import casoMesaAbrirORetomarConTrab from "../../../tests/contract/casos/mesas/abrir_o_retomar_con_trabajador.json";
import goldenMesaAbrirORetomarConTrab from "../../../tests/contract/golden/mesas/abrir_o_retomar_con_trabajador.json";
import casoMesaSetReservaIfNull from "../../../tests/contract/casos/mesas/set_reserva_if_null.json";
import goldenMesaSetReservaIfNull from "../../../tests/contract/golden/mesas/set_reserva_if_null.json";
import casoMesaAddLinea from "../../../tests/contract/casos/mesas/add_linea.json";
import goldenMesaAddLinea from "../../../tests/contract/golden/mesas/add_linea.json";
import casoMesaAddLineaSinPrecio from "../../../tests/contract/casos/mesas/add_linea_sin_precio.json";
import goldenMesaAddLineaSinPrecio from "../../../tests/contract/golden/mesas/add_linea_sin_precio.json";
import casoMesaRemoveOne from "../../../tests/contract/casos/mesas/remove_one_pending_detalle.json";
import goldenMesaRemoveOne from "../../../tests/contract/golden/mesas/remove_one_pending_detalle.json";
import casoMesaDeleteDet from "../../../tests/contract/casos/mesas/delete_detalle.json";
import goldenMesaDeleteDet from "../../../tests/contract/golden/mesas/delete_detalle.json";
import casoInvGuardarCatIngr from "../../../tests/contract/casos/inventario/guardar_categoria_ingrediente.json";
import goldenInvGuardarCatIngr from "../../../tests/contract/golden/inventario/guardar_categoria_ingrediente.json";
import casoInvRenombrarCatIngr from "../../../tests/contract/casos/inventario/guardar_categoria_ingrediente_renombrar.json";
import goldenInvRenombrarCatIngr from "../../../tests/contract/golden/inventario/guardar_categoria_ingrediente_renombrar.json";
import casoInvGuardarIngr from "../../../tests/contract/casos/inventario/guardar_ingrediente.json";
import goldenInvGuardarIngr from "../../../tests/contract/golden/inventario/guardar_ingrediente.json";
import casoInvMoverIngr from "../../../tests/contract/casos/inventario/guardar_ingrediente_mover.json";
import goldenInvMoverIngr from "../../../tests/contract/golden/inventario/guardar_ingrediente_mover.json";
import casoInvBorrarCatIngr from "../../../tests/contract/casos/inventario/borrar_categoria_ingrediente.json";
import goldenInvBorrarCatIngr from "../../../tests/contract/golden/inventario/borrar_categoria_ingrediente.json";
import casoInvBorrarIngr from "../../../tests/contract/casos/inventario/borrar_ingrediente.json";
import goldenInvBorrarIngr from "../../../tests/contract/golden/inventario/borrar_ingrediente.json";
import casoInvUpsertConIngr from "../../../tests/contract/casos/inventario/upsert_producto_con_ingredientes.json";
import goldenInvUpsertConIngr from "../../../tests/contract/golden/inventario/upsert_producto_con_ingredientes.json";
import casoInvUpsertSinListaIngr from "../../../tests/contract/casos/inventario/upsert_producto_sin_lista_de_ingredientes.json";
import goldenInvUpsertSinListaIngr from "../../../tests/contract/golden/inventario/upsert_producto_sin_lista_de_ingredientes.json";
import casoInvDeleteConIngr from "../../../tests/contract/casos/inventario/delete_producto_con_ingredientes.json";
import goldenInvDeleteConIngr from "../../../tests/contract/golden/inventario/delete_producto_con_ingredientes.json";
import casoInvBorrarCategoria from "../../../tests/contract/casos/inventario/borrar_categoria.json";
import goldenInvBorrarCategoria from "../../../tests/contract/golden/inventario/borrar_categoria.json";
import casoMesaUpdateIngr from "../../../tests/contract/casos/mesas/update_detalle_ingredientes.json";
import goldenMesaUpdateIngr from "../../../tests/contract/golden/mesas/update_detalle_ingredientes.json";
import casoMesaQuitarIngr from "../../../tests/contract/casos/mesas/update_detalle_ingredientes_quitar.json";
import goldenMesaQuitarIngr from "../../../tests/contract/golden/mesas/update_detalle_ingredientes_quitar.json";
import casoMesaUpdateNota from "../../../tests/contract/casos/mesas/update_detalle_nota.json";
import goldenMesaUpdateNota from "../../../tests/contract/golden/mesas/update_detalle_nota.json";
import casoMesaKitchen from "../../../tests/contract/casos/mesas/kitchen_set_line_state.json";
import goldenMesaKitchen from "../../../tests/contract/golden/mesas/kitchen_set_line_state.json";
import casoCuentasCrearGasto from "../../../tests/contract/casos/cuentas/create_gasto.json";
import goldenCuentasCrearGasto from "../../../tests/contract/golden/cuentas/create_gasto.json";
import casoCuentasUpdateGasto from "../../../tests/contract/casos/cuentas/update_gasto.json";
import goldenCuentasUpdateGasto from "../../../tests/contract/golden/cuentas/update_gasto.json";
import casoCuentasUpdateGastoMismoDia from "../../../tests/contract/casos/cuentas/update_gasto_mismo_dia.json";
import goldenCuentasUpdateGastoMismoDia from "../../../tests/contract/golden/cuentas/update_gasto_mismo_dia.json";
import casoCuentasDeleteGasto from "../../../tests/contract/casos/cuentas/delete_gasto.json";
import goldenCuentasDeleteGasto from "../../../tests/contract/golden/cuentas/delete_gasto.json";
import casoCuentasUpdatePago from "../../../tests/contract/casos/cuentas/update_pago.json";
import goldenCuentasUpdatePago from "../../../tests/contract/golden/cuentas/update_pago.json";
import casoCuentasAnularPago from "../../../tests/contract/casos/cuentas/anular_pago.json";
import goldenCuentasAnularPago from "../../../tests/contract/golden/cuentas/anular_pago.json";
import casoCuentasAnularSinReserva from "../../../tests/contract/casos/cuentas/anular_pago_reserva_borrada.json";
import goldenCuentasAnularSinReserva from "../../../tests/contract/golden/cuentas/anular_pago_reserva_borrada.json";
import casoCuentasAnularDevolucion from "../../../tests/contract/casos/cuentas/anular_pago_devolucion.json";
import goldenCuentasAnularDevolucion from "../../../tests/contract/golden/cuentas/anular_pago_devolucion.json";
import casoCuentasAnularConParcial from "../../../tests/contract/casos/cuentas/anular_pago_con_devolucion_parcial.json";
import goldenCuentasAnularConParcial from "../../../tests/contract/golden/cuentas/anular_pago_con_devolucion_parcial.json";
import casoCuentasAnularMesaVacia from "../../../tests/contract/casos/cuentas/anular_pago_mesa_reabierta_vacia.json";
import goldenCuentasAnularMesaVacia from "../../../tests/contract/golden/cuentas/anular_pago_mesa_reabierta_vacia.json";
import casoCuentasAnularMesaConLineas from "../../../tests/contract/casos/cuentas/anular_pago_mesa_reabierta_con_lineas.json";
import goldenCuentasAnularMesaConLineas from "../../../tests/contract/golden/cuentas/anular_pago_mesa_reabierta_con_lineas.json";
import casoCuentasAnularConDevuelta from "../../../tests/contract/casos/cuentas/anular_pago_con_linea_devuelta.json";
import goldenCuentasAnularConDevuelta from "../../../tests/contract/golden/cuentas/anular_pago_con_linea_devuelta.json";
import casoMesaSetReserva from "../../../tests/contract/casos/mesas/set_reserva_estado.json";
import goldenMesaSetReserva from "../../../tests/contract/golden/mesas/set_reserva_estado.json";
import casoNotifCrear from "../../../tests/contract/casos/notificaciones/crear.json";
import goldenNotifCrear from "../../../tests/contract/golden/notificaciones/crear.json";
import casoNotifCrearDedupe from "../../../tests/contract/casos/notificaciones/crear_dedupe.json";
import goldenNotifCrearDedupe from "../../../tests/contract/golden/notificaciones/crear_dedupe.json";
import casoNotifActualiza from "../../../tests/contract/casos/notificaciones/crear_actualiza.json";
import goldenNotifActualiza from "../../../tests/contract/golden/notificaciones/crear_actualiza.json";
import casoNotifActualizaSinReleer from "../../../tests/contract/casos/notificaciones/crear_actualiza_sin_releer.json";
import goldenNotifActualizaSinReleer from "../../../tests/contract/golden/notificaciones/crear_actualiza_sin_releer.json";
import casoNotifLeida from "../../../tests/contract/casos/notificaciones/marcar_leida.json";
import goldenNotifLeida from "../../../tests/contract/golden/notificaciones/marcar_leida.json";
import casoNotifBatch from "../../../tests/contract/casos/notificaciones/marcar_leidas_batch.json";
import goldenNotifBatch from "../../../tests/contract/golden/notificaciones/marcar_leidas_batch.json";
import casoNotifDescartar from "../../../tests/contract/casos/notificaciones/descartar.json";
import goldenNotifDescartar from "../../../tests/contract/golden/notificaciones/descartar.json";
import casoNotifRestaurar from "../../../tests/contract/casos/notificaciones/restaurar.json";
import goldenNotifRestaurar from "../../../tests/contract/golden/notificaciones/restaurar.json";
import casoNotifEliminar from "../../../tests/contract/casos/notificaciones/eliminar.json";
import goldenNotifEliminar from "../../../tests/contract/golden/notificaciones/eliminar.json";
import casoNotifLeidaAjena from "../../../tests/contract/casos/notificaciones/marcar_leida_ajena.json";
import goldenNotifLeidaAjena from "../../../tests/contract/golden/notificaciones/marcar_leida_ajena.json";
import casoNotifDescartarAjena from "../../../tests/contract/casos/notificaciones/descartar_ajena.json";
import goldenNotifDescartarAjena from "../../../tests/contract/golden/notificaciones/descartar_ajena.json";
import casoNotifEliminarRestaurada from "../../../tests/contract/casos/notificaciones/eliminar_restaurada.json";
import goldenNotifEliminarRestaurada from "../../../tests/contract/golden/notificaciones/eliminar_restaurada.json";
import casoNotifResolver from "../../../tests/contract/casos/notificaciones/resolver_por_clave.json";
import goldenNotifResolver from "../../../tests/contract/golden/notificaciones/resolver_por_clave.json";
import casoHorariosCopiar from "../../../tests/contract/casos/horarios/copiar_semana.json";
import goldenHorariosCopiar from "../../../tests/contract/golden/horarios/copiar_semana.json";
import casoHorariosPredeterminado from "../../../tests/contract/casos/horarios/set_predeterminado_desde_semana.json";
import casoMarcarLibre from "../../../tests/contract/casos/horarios/marcar_libre.json";
import goldenMarcarLibre from "../../../tests/contract/golden/horarios/marcar_libre.json";
import casoEliminarConHistoria from "../../../tests/contract/casos/trabajadores/eliminar_con_historia.json";
import goldenEliminarConHistoria from "../../../tests/contract/golden/trabajadores/eliminar_con_historia.json";
import casoEliminarSinHistoria from "../../../tests/contract/casos/trabajadores/eliminar_sin_historia.json";
import goldenEliminarSinHistoria from "../../../tests/contract/golden/trabajadores/eliminar_sin_historia.json";
import goldenHorariosPredeterminado from "../../../tests/contract/golden/horarios/set_predeterminado_desde_semana.json";
import casoLoginPunchEntrada from "../../../tests/contract/casos/login/punch_entrada.json";
import goldenLoginPunchEntrada from "../../../tests/contract/golden/login/punch_entrada.json";
import casoLoginPunchSalida from "../../../tests/contract/casos/login/punch_salida.json";
import goldenLoginPunchSalida from "../../../tests/contract/golden/login/punch_salida.json";
import casoLoginPunchSalidaNoche from "../../../tests/contract/casos/login/punch_salida_turno_noche.json";
import goldenLoginPunchSalidaNoche from "../../../tests/contract/golden/login/punch_salida_turno_noche.json";
import casoLoginTurno from "../../../tests/contract/casos/login/set_turno_partido.json";
import goldenLoginTurno from "../../../tests/contract/golden/login/set_turno_partido.json";
import casoHorGuardar from "../../../tests/contract/casos/horarios/guardar_asignacion.json";
import goldenHorGuardar from "../../../tests/contract/golden/horarios/guardar_asignacion.json";
import casoHorDelete from "../../../tests/contract/casos/horarios/delete_asignacion.json";
import goldenHorDelete from "../../../tests/contract/golden/horarios/delete_asignacion.json";

const CASOS = [
	{ nombre: "vr_un_lote", caso: casoVrUnLote, golden: goldenVrUnLote },
	{ nombre: "vr_fefo_multilote", caso: casoVrMultilote, golden: goldenVrMultilote },
	{ nombre: "vr_120_lineas", caso: casoVr120, golden: goldenVr120 },
	{ nombre: "mesas_cobro_un_lote", caso: casoMesasCobro, golden: goldenMesasCobro },
	{ nombre: "mesas_cobro_con_cliente", caso: casoMesasCobroCliente, golden: goldenMesasCobroCliente },
	{ nombre: "mesas_cobro_lote_y_suelto", caso: casoMesasCobroSuelto, golden: goldenMesasCobroSuelto },
	{ nombre: "mesas_cobro_decimos", caso: casoMesasCobroDecimos, golden: goldenMesasCobroDecimos },
	{ nombre: "mesas_cobro_120_lineas", caso: casoMesasCobro120, golden: goldenMesasCobro120 },
	{ nombre: "clientes_crear", caso: casoCliCrear, golden: goldenCliCrear },
	{ nombre: "clientes_actualizar", caso: casoCliActualizar, golden: goldenCliActualizar },
	{ nombre: "tareas_crear", caso: casoTareaCrear, golden: goldenTareaCrear },
	{ nombre: "tareas_actualizar", caso: casoTareaActualizar, golden: goldenTareaActualizar },
	{ nombre: "tareas_set_asignaciones", caso: casoTareaSetAsig, golden: goldenTareaSetAsig },
	{ nombre: "tareas_set_asignaciones_120", caso: casoTareaSetAsig120, golden: goldenTareaSetAsig120 },
	{ nombre: "tareas_eliminar", caso: casoTareaEliminar, golden: goldenTareaEliminar },
	{ nombre: "tareas_restaurar", caso: casoTareaRestaurar, golden: goldenTareaRestaurar },
	{ nombre: "tareas_vaciar_papelera", caso: casoTareaVaciar, golden: goldenTareaVaciar },
	{ nombre: "tareas_marcar_finalizada", caso: casoTareaFinalizar, golden: goldenTareaFinalizar },
	{ nombre: "inventario_create_lote", caso: casoInvCreateLote, golden: goldenInvCreateLote },
	{
		nombre: "inventario_create_lote_id_existente",
		caso: casoInvCreateLoteExistente,
		golden: goldenInvCreateLoteExistente,
	},
	{ nombre: "inventario_create_categoria", caso: casoInvCategoria, golden: goldenInvCategoria },
	{ nombre: "inventario_upsert_producto", caso: casoInvUpsertProd, golden: goldenInvUpsertProd },
	{ nombre: "inventario_delete_producto", caso: casoInvDeleteProd, golden: goldenInvDeleteProd },
	{ nombre: "inventario_delete_producto_con_lote_vendido", caso: casoInvDeleteLoteVendido, golden: goldenInvDeleteLoteVendido },
	{ nombre: "inventario_delete_producto_sin_historia", caso: casoInvDeleteSinHistoria, golden: goldenInvDeleteSinHistoria },
	{ nombre: "inventario_update_lote", caso: casoInvUpdateLote, golden: goldenInvUpdateLote },
	{ nombre: "inventario_ajustar_lote", caso: casoInvAjustarLote, golden: goldenInvAjustarLote },
	{ nombre: "inventario_ajustar_lote_stock_cambiado", caso: casoInvAjustarLoteTarde, golden: goldenInvAjustarLoteTarde },
	{ nombre: "inventario_ajustar_stock_suelto", caso: casoInvAjustarSuelto, golden: goldenInvAjustarSuelto },
	{ nombre: "inventario_upsert_producto_con_suelto", caso: casoInvUpsertSuelto, golden: goldenInvUpsertSuelto },
	{ nombre: "inventario_upsert_producto_no_toca_suelto", caso: casoInvUpsertNoSuelto, golden: goldenInvUpsertNoSuelto },
	{ nombre: "config_patch_business", caso: casoCfgBusiness, golden: goldenCfgBusiness },
	{ nombre: "config_patch_contact", caso: casoCfgContact, golden: goldenCfgContact },
	{ nombre: "config_patch_ticket", caso: casoCfgTicket, golden: goldenCfgTicket },
	{ nombre: "proveedores_guardar", caso: casoProvGuardar, golden: goldenProvGuardar },
	{ nombre: "proveedores_eliminar", caso: casoProvEliminar, golden: goldenProvEliminar },
	{ nombre: "proveedores_set_vinculos", caso: casoProvVinculos, golden: goldenProvVinculos },
	{ nombre: "pedidos_proveedor_crear", caso: casoPedCrear, golden: goldenPedCrear },
	{ nombre: "pedidos_proveedor_crear_sin_proveedor", caso: casoPedCrearSinProv, golden: goldenPedCrearSinProv },
	{ nombre: "pedidos_proveedor_actualizar", caso: casoPedActualizar, golden: goldenPedActualizar },
	{ nombre: "pedidos_proveedor_actualizar_enviado", caso: casoPedActualizarEnviado, golden: goldenPedActualizarEnviado },
	{ nombre: "pedidos_proveedor_cambiar_estado_enviar", caso: casoPedEnviar, golden: goldenPedEnviar },
	{ nombre: "pedidos_proveedor_cambiar_estado_proveedor_borrado", caso: casoPedProvBorrado, golden: goldenPedProvBorrado },
	{ nombre: "pedidos_proveedor_cambiar_estado_ya_enviado", caso: casoPedYaEnviado, golden: goldenPedYaEnviado },
	{ nombre: "reservas_guardar_cliente_nuevo", caso: casoResNuevo, golden: goldenResNuevo },
	{ nombre: "reservas_guardar_cliente_existente", caso: casoResExistente, golden: goldenResExistente },
	{ nombre: "reservas_guardar_sin_mesa", caso: casoResSinMesa, golden: goldenResSinMesa },
	{ nombre: "reservas_guardar_sin_cliente", caso: casoResSinCliente, golden: goldenResSinCliente },
	{ nombre: "reservas_guardar_con_duracion", caso: casoResConDuracion, golden: goldenResConDuracion },
	{ nombre: "reservas_editar_web_conserva_origen", caso: casoResWebOrigen, golden: goldenResWebOrigen },
	{ nombre: "reservas_editar_conserva_estado", caso: casoResEditarEstado, golden: goldenResEditarEstado },
	{
		nombre: "reservas_guardar_otra_persona_mismo_telefono",
		caso: casoResOtraPersona,
		golden: goldenResOtraPersona,
	},
	{ nombre: "reservas_eliminar", caso: casoResEliminar, golden: goldenResEliminar },
	{ nombre: "reservas_cancelar_web", caso: casoResCancelarWeb, golden: goldenResCancelarWeb },
	{ nombre: "vr_create_comanda_barra", caso: casoVrCrearComanda, golden: goldenVrCrearComanda },
	{ nombre: "vr_add_linea", caso: casoVrAddLinea, golden: goldenVrAddLinea },
	{ nombre: "vr_add_linea_sin_precio", caso: casoVrAddLineaSinPrecio, golden: goldenVrAddLineaSinPrecio },
	{ nombre: "vr_remove_last_unpaid_linea", caso: casoVrRemoveLast, golden: goldenVrRemoveLast },
	{ nombre: "vr_delete_linea_if_unpaid", caso: casoVrDeleteLinea, golden: goldenVrDeleteLinea },
	{ nombre: "vr_update_nota_detalle", caso: casoVrUpdateNota, golden: goldenVrUpdateNota },
	{ nombre: "vr_delete_comanda_if_safe", caso: casoVrDeleteComanda, golden: goldenVrDeleteComanda },
	{ nombre: "mesas_save_layout", caso: casoMesaSaveLayout, golden: goldenMesaSaveLayout },
	{ nombre: "mesas_save_layout_archiva", caso: casoMesaSaveLayoutArchiva, golden: goldenMesaSaveLayoutArchiva },
	{ nombre: "mesas_save_layout_120_mesas", caso: casoMesaSaveLayout120, golden: goldenMesaSaveLayout120 },
	{ nombre: "mesas_abrir_comanda", caso: casoMesaAbrir, golden: goldenMesaAbrir },
	{ nombre: "mesas_set_trabajador_if_null", caso: casoMesaSetTrab, golden: goldenMesaSetTrab },
	{ nombre: "mesas_abrir_o_retomar", caso: casoMesaAbrirORetomar, golden: goldenMesaAbrirORetomar },
	{ nombre: "mesas_abrir_o_retomar_sin_abierta", caso: casoMesaAbrirORetomarSinAbierta, golden: goldenMesaAbrirORetomarSinAbierta },
	{ nombre: "mesas_abrir_o_retomar_con_trabajador", caso: casoMesaAbrirORetomarConTrab, golden: goldenMesaAbrirORetomarConTrab },
	{ nombre: "mesas_set_reserva_if_null", caso: casoMesaSetReservaIfNull, golden: goldenMesaSetReservaIfNull },
	{ nombre: "mesas_add_linea", caso: casoMesaAddLinea, golden: goldenMesaAddLinea },
	{ nombre: "mesas_add_linea_sin_precio", caso: casoMesaAddLineaSinPrecio, golden: goldenMesaAddLineaSinPrecio },
	{ nombre: "mesas_remove_one_pending", caso: casoMesaRemoveOne, golden: goldenMesaRemoveOne },
	{ nombre: "mesas_delete_detalle", caso: casoMesaDeleteDet, golden: goldenMesaDeleteDet },
	{ nombre: "mesas_update_detalle_nota", caso: casoMesaUpdateNota, golden: goldenMesaUpdateNota },
	{ nombre: "inventario_guardar_categoria_ingrediente", caso: casoInvGuardarCatIngr, golden: goldenInvGuardarCatIngr },
	{ nombre: "inventario_guardar_categoria_ingrediente_renombrar", caso: casoInvRenombrarCatIngr, golden: goldenInvRenombrarCatIngr },
	{ nombre: "inventario_guardar_ingrediente", caso: casoInvGuardarIngr, golden: goldenInvGuardarIngr },
	{ nombre: "inventario_guardar_ingrediente_mover", caso: casoInvMoverIngr, golden: goldenInvMoverIngr },
	{ nombre: "inventario_borrar_categoria_ingrediente", caso: casoInvBorrarCatIngr, golden: goldenInvBorrarCatIngr },
	{ nombre: "inventario_borrar_ingrediente", caso: casoInvBorrarIngr, golden: goldenInvBorrarIngr },
	{ nombre: "inventario_upsert_producto_con_ingredientes", caso: casoInvUpsertConIngr, golden: goldenInvUpsertConIngr },
	{ nombre: "inventario_upsert_producto_sin_lista_de_ingredientes", caso: casoInvUpsertSinListaIngr, golden: goldenInvUpsertSinListaIngr },
	{ nombre: "inventario_delete_producto_con_ingredientes", caso: casoInvDeleteConIngr, golden: goldenInvDeleteConIngr },
	{ nombre: "inventario_borrar_categoria", caso: casoInvBorrarCategoria, golden: goldenInvBorrarCategoria },
	{ nombre: "mesas_update_detalle_ingredientes", caso: casoMesaUpdateIngr, golden: goldenMesaUpdateIngr },
	{ nombre: "mesas_update_detalle_ingredientes_quitar", caso: casoMesaQuitarIngr, golden: goldenMesaQuitarIngr },
	{ nombre: "mesas_kitchen_set_line_state", caso: casoMesaKitchen, golden: goldenMesaKitchen },
	{ nombre: "cuentas_create_gasto", caso: casoCuentasCrearGasto, golden: goldenCuentasCrearGasto },
	{ nombre: "cuentas_update_gasto", caso: casoCuentasUpdateGasto, golden: goldenCuentasUpdateGasto },
	{
		nombre: "cuentas_update_gasto_mismo_dia",
		caso: casoCuentasUpdateGastoMismoDia,
		golden: goldenCuentasUpdateGastoMismoDia,
	},
	{ nombre: "cuentas_delete_gasto", caso: casoCuentasDeleteGasto, golden: goldenCuentasDeleteGasto },
	{ nombre: "cuentas_update_pago", caso: casoCuentasUpdatePago, golden: goldenCuentasUpdatePago },
	{ nombre: "cuentas_anular_pago", caso: casoCuentasAnularPago, golden: goldenCuentasAnularPago },
	{
		nombre: "cuentas_anular_pago_reserva_borrada",
		caso: casoCuentasAnularSinReserva,
		golden: goldenCuentasAnularSinReserva,
	},
	{
		nombre: "cuentas_anular_pago_devolucion",
		caso: casoCuentasAnularDevolucion,
		golden: goldenCuentasAnularDevolucion,
	},
	{
		nombre: "cuentas_anular_pago_con_devolucion_parcial",
		caso: casoCuentasAnularConParcial,
		golden: goldenCuentasAnularConParcial,
	},
	{
		nombre: "cuentas_anular_pago_mesa_reabierta_vacia",
		caso: casoCuentasAnularMesaVacia,
		golden: goldenCuentasAnularMesaVacia,
	},
	{
		nombre: "cuentas_anular_pago_mesa_reabierta_con_lineas",
		caso: casoCuentasAnularMesaConLineas,
		golden: goldenCuentasAnularMesaConLineas,
	},
	{
		nombre: "cuentas_anular_pago_con_linea_devuelta",
		caso: casoCuentasAnularConDevuelta,
		golden: goldenCuentasAnularConDevuelta,
	},
	{ nombre: "mesas_set_reserva_estado", caso: casoMesaSetReserva, golden: goldenMesaSetReserva },
	{ nombre: "notificaciones_crear", caso: casoNotifCrear, golden: goldenNotifCrear },
	{ nombre: "notificaciones_crear_dedupe", caso: casoNotifCrearDedupe, golden: goldenNotifCrearDedupe },
	{ nombre: "notificaciones_crear_actualiza", caso: casoNotifActualiza, golden: goldenNotifActualiza },
	{
		nombre: "notificaciones_crear_actualiza_sin_releer",
		caso: casoNotifActualizaSinReleer,
		golden: goldenNotifActualizaSinReleer,
	},
	{ nombre: "notificaciones_marcar_leida", caso: casoNotifLeida, golden: goldenNotifLeida },
	{ nombre: "notificaciones_marcar_leidas_batch", caso: casoNotifBatch, golden: goldenNotifBatch },
	{ nombre: "notificaciones_resolver_por_clave", caso: casoNotifResolver, golden: goldenNotifResolver },
	{ nombre: "notificaciones_descartar", caso: casoNotifDescartar, golden: goldenNotifDescartar },
	{ nombre: "notificaciones_restaurar", caso: casoNotifRestaurar, golden: goldenNotifRestaurar },
	{ nombre: "notificaciones_eliminar", caso: casoNotifEliminar, golden: goldenNotifEliminar },
	{ nombre: "notificaciones_marcar_leida_ajena", caso: casoNotifLeidaAjena, golden: goldenNotifLeidaAjena },
	{ nombre: "notificaciones_descartar_ajena", caso: casoNotifDescartarAjena, golden: goldenNotifDescartarAjena },
	{
		nombre: "notificaciones_eliminar_restaurada",
		caso: casoNotifEliminarRestaurada,
		golden: goldenNotifEliminarRestaurada,
	},
	{ nombre: "horarios_copiar_semana", caso: casoHorariosCopiar, golden: goldenHorariosCopiar },
	{
		nombre: "horarios_set_predeterminado_desde_semana",
		caso: casoHorariosPredeterminado,
		golden: goldenHorariosPredeterminado,
	},
	{ nombre: "horarios_marcar_libre", caso: casoMarcarLibre, golden: goldenMarcarLibre },
	{ nombre: "trabajadores_eliminar_con_historia", caso: casoEliminarConHistoria, golden: goldenEliminarConHistoria },
	{ nombre: "trabajadores_eliminar_sin_historia", caso: casoEliminarSinHistoria, golden: goldenEliminarSinHistoria },
	{ nombre: "login_punch_entrada", caso: casoLoginPunchEntrada, golden: goldenLoginPunchEntrada },
	{ nombre: "login_punch_salida", caso: casoLoginPunchSalida, golden: goldenLoginPunchSalida },
	{
		nombre: "login_punch_salida_turno_noche",
		caso: casoLoginPunchSalidaNoche,
		golden: goldenLoginPunchSalidaNoche,
	},
	{ nombre: "login_set_turno_partido", caso: casoLoginTurno, golden: goldenLoginTurno },
	{ nombre: "horarios_guardar_asignacion", caso: casoHorGuardar, golden: goldenHorGuardar },
	{ nombre: "horarios_delete_asignacion", caso: casoHorDelete, golden: goldenHorDelete },
];

// ── Comparación estructural (misma spec que el lado Rust) ────────────────────────
const TOL = 1e-9;

const aNumero = (v: any): number => (typeof v === "bigint" ? Number(v) : v);

function celdaIgual(a: any, b: any): boolean {
	if (a === null && b === null) return true;
	const numericos =
		["number", "bigint"].includes(typeof a) || ["number", "bigint"].includes(typeof b);
	if (numericos) return Math.abs(aNumero(a) - aNumero(b)) < TOL;
	return a === b;
}

function filaIgual(a: any, b: any): boolean {
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => k in b && celdaIgual(a[k], b[k]));
}

/** Compara dos tablas como multiconjuntos (sin depender del orden). Devuelve el error o `null`. */
function multiconjuntoIgual(got: any[], want: any[]): string | null {
	if (got.length !== want.length) {
		return `${got.length} filas frente a ${want.length} esperadas`;
	}
	const restantes = [...want];
	for (const fila of got) {
		const i = restantes.findIndex((w) => filaIgual(fila, w));
		if (i < 0) return `fila sin equivalente en el golden: ${JSON.stringify(fila)}`;
		restantes.splice(i, 1);
	}
	return null;
}

/**
 * Resuelve un `BuiltCommand` con el DO real y ejecuta sus sentencias contra el SQLite del tenant.
 *
 * Reproduce el **sobre** con el que el hub aplica de verdad un batch: el mismo lote atómico
 * (`loteEnBruto`) con `PRAGMA defer_foreign_keys = ON` delante (ver `loteDe`: "[PRAGMA defer FK]
 * + [gate idempotente] + [trabajo] + [log de sync]"). No es un detalle: un comando que borra en un
 * orden que deja referencias colgantes hasta el COMMIT —la anulación de un cobro borra las líneas
 * antes que sus `Pago_Detalles`— revienta por FK sin el pragma. Sin esto el harness diría que hay
 * divergencia donde solo había un envoltorio distinto. Y las guardas del comando (SYNC-30) deciden
 * como en la nube: una que no se cumple lanza `GuardaIncumplida` y no deja nada.
 */
// TRAB-08: lo que viaja a la Main es el TEXTO de las sentencias replicadas. Una funcion no
// determinista dentro (randomblob, random) se evalua OTRA VEZ alli y da otro valor: mismas filas
// con claves distintas. El snapshot NO lo ve --cada lado genera IDs validos por su cuenta-- asi que
// hay que mirar la sentencia, no solo su efecto. Los IDs van como argumento, ya resueltos.
export const SQL_NO_DETERMINISTA = /\brandomblob\s*\(|\brandom\s*\(/i;

function aplicar(hub: any, _sql: any, built: any): void {
	const batch = buildApplyBatch(built.command);
	for (const st of batch.replicated) {
		expect(
			SQL_NO_DETERMINISTA.test(st.sql),
			`sentencia replicada con SQL no determinista (se re-evaluaria en la Main): ${st.sql}`,
		).toBe(false);
	}
	loteEnBruto(hub.state.storage, [{ sql: "PRAGMA defer_foreign_keys = ON;", args: [] }, ...batch.middle]);
}

/** Un ajuste de existencias que llega tarde lo rechaza su guarda: no es un fallo del caso. */
function aplicarSalvoStockCambiado(hub: any, sql: any, built: any): void {
	try {
		aplicar(hub, sql, built);
	} catch (e) {
		if (!(e instanceof GuardaIncumplida && e.code === "stock_cambiado")) throw e;
	}
}

/** Corre el comando del caso por su camino real (plan → builder → apply). El `switch` es el punto de
 *  extensión: un dominio nuevo añade su brazo aquí y en el lado Rust (`aplicar_comando`). */
async function aplicarComando(hub: any, sql: any, db: any, caso: any): Promise<void> {
	switch (caso.comando) {
		case "venta_rapida.cobrar_fraccionado": {
			const entrada = {
				id_comanda: caso.entrada.id_comanda,
				metodo: caso.entrada.metodo,
				detalles: caso.entrada.detalles,
				id_usuario_cobrador: null,
				id_trabajador_cobrador: null,
			};
			const plan = await cobrarPlan(db, entrada as any);
			expect(plan.ok, "el plan de cobro debe resolverse").toBe(true);
			aplicar(hub, sql, cobrarFraccionado(entrada as any, plan as any));
			return;
		}
		case "mesas.cobrar_detalles": {
			const entrada = {
				id_comanda: caso.entrada.id_comanda,
				detalle_ids: caso.entrada.detalle_ids,
				metodo: caso.entrada.metodo,
				tipo: caso.entrada.tipo,
				id_usuario: null,
			};
			const plan = await cobrarDetallesPlan(db, entrada as any);
			expect(plan.ok, "el plan de cobro de mesa debe resolverse").toBe(true);
			aplicar(hub, sql, cobrarDetalles(entrada as any, plan as any));
			return;
		}
		case "clientes.crear": {
			aplicar(hub, sql, createCliente({
				id_cliente: caso.entrada.id_cliente,
				nombre: caso.entrada.nombre,
				email: caso.entrada.email,
				telefono: caso.entrada.telefono,
				notas: caso.entrada.notas,
				nif: caso.entrada.nif,
				razon_social: caso.entrada.razon_social,
				direccion_fiscal: caso.entrada.direccion_fiscal,
			} as any));
			return;
		}
		case "clientes.actualizar": {
			aplicar(hub, sql, updateCliente(caso.entrada.id_cliente, {
				nombre: caso.entrada.nombre,
				email: caso.entrada.email,
				telefono: caso.entrada.telefono,
				notas: caso.entrada.notas,
				nif: caso.entrada.nif,
				razon_social: caso.entrada.razon_social,
				direccion_fiscal: caso.entrada.direccion_fiscal,
			} as any));
			return;
		}
		case "tareas.crear": {
			aplicar(
				hub,
				sql,
				createTarea({
					titulo: caso.entrada.titulo,
					descripcion: caso.entrada.descripcion,
					fecha_limite: caso.entrada.fecha_limite,
					ids_trabajadores: caso.entrada.ids_trabajadores,
				} as any),
			);
			return;
		}
		case "tareas.actualizar": {
			aplicar(
				hub,
				sql,
				updateTarea(caso.entrada.id_tarea, {
					titulo: caso.entrada.titulo,
					descripcion: caso.entrada.descripcion,
					fecha_limite: caso.entrada.fecha_limite,
				} as any),
			);
			return;
		}
		case "tareas.set_asignaciones": {
			aplicar(
				hub,
				sql,
				setAsignacionesTarea(caso.entrada.id_tarea, {
					ids_trabajadores: caso.entrada.ids_trabajadores,
				} as any),
			);
			return;
		}
		case "tareas.eliminar": {
			aplicar(hub, sql, deleteTarea(caso.entrada.id_tarea));
			return;
		}
		case "tareas.restaurar": {
			aplicar(hub, sql, restaurarTarea(caso.entrada.id_tarea));
			return;
		}
		case "tareas.vaciar_papelera": {
			aplicar(hub, sql, vaciarPapelera());
			return;
		}
		case "tareas.marcar_finalizada": {
			aplicar(
				hub,
				sql,
				marcarFinalizada(caso.entrada.id_tarea, {
					id_trabajador: caso.entrada.id_trabajador,
				} as any),
			);
			return;
		}
		case "inventario.create_lote": {
			aplicar(
				hub,
				sql,
				createLote({
					id_lote: caso.entrada.id_lote,
					id_producto: caso.entrada.id_producto,
					codigo_lote: caso.entrada.codigo_lote,
					fecha_entrada: caso.entrada.fecha_entrada,
					caducidad: caso.entrada.caducidad,
					stock_disponible: caso.entrada.stock_disponible,
					coste_unitario: caso.entrada.coste_unitario,
					id_proveedor: caso.entrada.id_proveedor,
					notas: caso.entrada.notas,
				} as any, caso.entrada.id_usuario),
			);
			return;
		}
		case "inventario.create_categoria": {
			aplicar(hub, sql, createCategoria(caso.entrada as any));
			return;
		}
		case "inventario.upsert_producto": {
			// La ruta mira si el producto existe: el stock suelto sólo cuenta al crearlo (RI-55).
			const ex = await db.execute({
				sql: "SELECT 1 FROM Productos WHERE ID_Producto=?1;",
				args: [caso.entrada.id_producto ?? ""],
			});
			aplicar(hub, sql, upsertProducto(caso.entrada as any, ex.rows.length === 0, caso.entrada.id_usuario));
			return;
		}
		case "inventario.guardar_categoria_ingrediente": {
			aplicar(hub, sql, guardarCategoriaIngrediente(caso.entrada as any));
			return;
		}
		case "inventario.borrar_categoria_ingrediente": {
			aplicar(hub, sql, borrarCategoriaIngrediente(caso.entrada.id_categoria_ingrediente));
			return;
		}
		case "inventario.guardar_ingrediente": {
			aplicar(hub, sql, guardarIngrediente(caso.entrada as any));
			return;
		}
		case "inventario.borrar_ingrediente": {
			aplicar(hub, sql, borrarIngrediente(caso.entrada.id_ingrediente));
			return;
		}
		case "inventario.borrar_categoria": {
			aplicar(hub, sql, borrarCategoria(caso.entrada.id_categoria));
			return;
		}
		case "inventario.delete_producto": {
			aplicar(hub, sql, deleteProducto(caso.entrada.id_producto));
			return;
		}
		case "inventario.update_lote": {
			aplicar(hub, sql, updateLote(caso.entrada.id_lote, caso.entrada as any));
			return;
		}
		case "inventario.ajustar_lote": {
			// Si lo visto no es lo que hay, la guarda del comando lo rechaza (`stock_cambiado`) y no
			// queda nada (RI-55, SYNC-30); lo que se compara es el efecto, como en la Main, que
			// contesta un `Conflict`.
			aplicarSalvoStockCambiado(hub, sql, ajustarLote(caso.entrada.id_lote, caso.entrada as any, caso.entrada.id_usuario));
			return;
		}
		case "inventario.ajustar_stock_suelto": {
			aplicarSalvoStockCambiado(hub, sql, ajustarStockSuelto(caso.entrada.id_producto, caso.entrada as any, caso.entrada.id_usuario));
			return;
		}
		case "config.patch_business": {
			aplicar(hub, sql, patchBusiness(caso.entrada.patch));
			return;
		}
		case "config.patch_contact": {
			aplicar(hub, sql, patchContact(caso.entrada.patch));
			return;
		}
		case "config.patch_ticket": {
			aplicar(hub, sql, patchTicket(caso.entrada.patch));
			return;
		}
		case "proveedores.guardar": {
			aplicar(hub, sql, guardarProveedor(caso.entrada as any));
			return;
		}
		case "proveedores.eliminar": {
			aplicar(hub, sql, eliminarProveedor(caso.entrada.id_proveedor));
			return;
		}
		case "proveedores.set_vinculos": {
			aplicar(
				hub,
				sql,
				setVinculos(caso.entrada.id_proveedor, {
					producto_ids: caso.entrada.producto_ids,
				} as any),
			);
			return;
		}
		case "pedidos_proveedor.crear": {
			aplicar(hub, sql, crearPedido(caso.entrada as any));
			return;
		}
		case "pedidos_proveedor.actualizar": {
			const { id_pedido, rechazo, ...edicion } = caso.entrada;
			try {
				aplicar(hub, sql, actualizarPedido(id_pedido, edicion as any));
				expect(rechazo, "el worker escribió lo que la Main rechaza").toBeUndefined();
			} catch (e) {
				// Lo que la Main rechaza con `conflict`, aquí lo rechaza la guarda del comando (SYNC-30).
				if (!(rechazo === "conflict" && e instanceof GuardaIncumplida && e.code === "pedido_no_editable")) throw e;
			}
			return;
		}
		case "pedidos_proveedor.cambiar_estado": {
			const { id_pedido, ...estado } = caso.entrada;
			aplicar(hub, sql, cambiarEstadoPedido(id_pedido, estado as any));
			return;
		}
		case "reservas.guardar": {
			// Como la ruta: el schema normaliza la entrada y RI-61 resuelve el cliente (ninguno, uno
			// existente o uno nuevo) antes de construir el comando.
			const datos = reservaSaveSchema.parse(caso.entrada);
			const cliente = await resolverCliente(db, datos);
			if ("error" in cliente) throw new Error(`reservas.guardar: ${cliente.error}`);
			aplicar(hub, sql, saveReserva({ ...datos, turno: caso.entrada.turno } as any, cliente));
			return;
		}
		case "reservas.eliminar": {
			aplicar(hub, sql, deleteReserva(caso.entrada.id_reserva));
			return;
		}
		case "reservas.cancelar": {
			// Sólo se cancela la que aún no ha llegado: lo decide la guarda del comando (SYNC-30).
			aplicar(hub, sql, cancelarReserva(caso.entrada.id_reserva));
			return;
		}
		case "venta_rapida.create_comanda_barra": {
			aplicar(
				hub,
				sql,
				createComandaBarra(
					{ id_comanda: caso.entrada.id_comanda, id_trabajador: null, get_or_create: false } as any,
					null,
				),
			);
			return;
		}
		case "venta_rapida.add_linea": {
			// El tipo de IVA, el nombre y el precio los resuelve el route, no el builder: se entra a
			// la misma altura.
			const datosVr = await datosDeLinea(db, caso.entrada.id_producto);
			aplicar(
				hub,
				sql,
				addLinea(caso.entrada as any, datosVr.ivaPercent, datosVr.nombre, datosVr.precio),
			);
			return;
		}
		case "venta_rapida.remove_last_unpaid_linea": {
			aplicar(hub, sql, removeLastUnpaidLinea(caso.entrada as any));
			return;
		}
		case "venta_rapida.delete_linea_if_unpaid": {
			aplicar(hub, sql, deleteLineaIfUnpaid(caso.entrada as any));
			return;
		}
		case "venta_rapida.update_nota_detalle": {
			aplicar(hub, sql, updateNotaDetalle(caso.entrada as any));
			return;
		}
		case "venta_rapida.delete_comanda_if_safe": {
			aplicar(hub, sql, deleteComandaIfSafe(caso.entrada.id_comanda));
			return;
		}
		case "mesas.save_layout": {
			aplicar(hub, sql, saveLayout({ salons: caso.entrada.salons } as any));
			return;
		}
		case "mesas.set_reserva_estado": {
			// Como la ruta: con el estado que lee, que la guarda exige que siga igual (SYNC-30).
			const actual = await estadoYOrigen(db, caso.entrada.id_reserva);
			if (!actual) throw new Error("mesas.set_reserva_estado: la reserva no existe");
			aplicar(hub, sql, setReservaEstado(caso.entrada.id_reserva, caso.entrada.estado, actual.estado));
			return;
		}
		case "cuentas.create_gasto": {
			aplicar(hub, sql, createGasto(caso.entrada as any));
			return;
		}
		case "cuentas.update_gasto": {
			aplicar(hub, sql, updateGasto(caso.entrada.id_gasto, caso.entrada as any));
			return;
		}
		case "cuentas.delete_gasto": {
			aplicar(hub, sql, deleteGasto(caso.entrada.id_gasto));
			return;
		}
		case "cuentas.update_pago": {
			// El importe NO se pasa: el comando lo recalcula desde las líneas cobradas (CUENTA-02).
			aplicar(
				hub,
				sql,
				updatePago(caso.entrada.id_pago, {
					fecha_hora: caso.entrada.fecha_hora,
					metodo: caso.entrada.metodo,
				} as any),
			);
			return;
		}
		case "cuentas.anular_pago": {
			aplicar(
				hub,
				sql,
				anularPago(caso.entrada.id_pago, {
					id_usuario: caso.entrada.id_usuario,
					motivo: caso.entrada.motivo,
					clase: caso.entrada.clase,
				}),
			);
			return;
		}
		case "notificaciones.crear": {
			// El dedupe vive en el route (una consulta previa), no en el builder: si ya hay una
			// activa con esa clave se actualiza (RI-12) o, si no cambia nada, no se emite nada. En la
			// Main eso pasa dentro del repo, así que aquí se reproduce el camino del route.
			const nueva = normalizarNotificacion(caso.entrada as any);
			if (nueva.clave_dedupe) {
				const activa = await activaPorClave(db, nueva.clave_dedupe);
				if (activa) {
					const cambio = actualizarNotificacion(activa.id, activa.contenido, nueva);
					if (cambio) aplicar(hub, sql, cambio);
					return;
				}
			}
			aplicar(hub, sql, crearNotificacion(caso.entrada as any));
			return;
		}
		case "notificaciones.marcar_leida": {
			aplicar(
				hub,
				sql,
				marcarLeida(caso.entrada.id_notificacion, caso.entrada.id_usuario),
			);
			return;
		}
		case "notificaciones.marcar_leidas_batch": {
			// Igual que el route: los ids no leídos se resuelven ANTES y se emite un INSERT por
			// cada uno (nunca un INSERT ... SELECT, que la nube reevaluaría en otro estado).
			const ids = await idsNoLeidas(db, caso.entrada.id_usuario);
			if (!ids.length) return;
			aplicar(hub, sql, marcarLeidasBatch(ids, caso.entrada.id_usuario));
			return;
		}
		case "notificaciones.resolver_por_clave": {
			// Como el route: sin una activa con esa clave no se escribe nada.
			if (!(await activaPorClave(db, caso.entrada.clave_dedupe))) return;
			aplicar(hub, sql, resolverPorClave(caso.entrada.clave_dedupe));
			return;
		}
		case "mesas.abrir_comanda": {
			aplicar(hub, sql, abrirComanda({ id_mesa: caso.entrada.id_mesa } as any, null, null));
			return;
		}
		case "mesas.set_trabajador_if_null": {
			// El route pasa el ID_Trabajador ya resuelto; en el caso base es directo.
			aplicar(
				hub,
				sql,
				setTrabajadorIfNull(
					{ id_comanda: caso.entrada.id_comanda } as any,
					caso.entrada.id_trabajador_o_usuario,
				),
			);
			return;
		}
		case "mesas.abrir_o_retomar": {
			// Como el route: lee, decide qué escribir (si algo) y lo aplica.
			const plan = await planAbrirORetomar(db, {
				id_mesa: caso.entrada.id_mesa,
				id_trabajador_o_usuario: caso.entrada.id_trabajador_o_usuario ?? null,
				id_reserva: caso.entrada.id_reserva ?? null,
			});
			if (plan) aplicar(hub, sql, plan);
			return;
		}
		case "mesas.set_reserva_if_null": {
			aplicar(hub, sql, setReservaIfNull({ id_comanda: caso.entrada.id_comanda, id_reserva: caso.entrada.id_reserva }));
			return;
		}
		case "mesas.add_linea": {
			// Estado_Cocina, el tipo de IVA, el nombre y el precio los resuelve el ROUTE, no el
			// builder, así que hay que entrar a la misma altura: se leen de la BD igual que en
			// producción. (Estado_Cocina se excluye del snapshot; lo demás no, que es lo que se
			// quiere comprobar.)
			const datos = await datosDeLinea(db, caso.entrada.id_producto);
			aplicar(
				hub,
				sql,
				addLineaMesa(
					{
						id_comanda: caso.entrada.id_comanda,
						id_producto: caso.entrada.id_producto,
						cantidad: caso.entrada.cantidad,
						id_trabajador_o_usuario: null,
					} as any,
					datos.pasaCocina ? "PENDIENTE" : null,
					datos.ivaPercent,
					datos.nombre,
					datos.precio,
				),
			);
			return;
		}
		case "mesas.remove_one_pending_detalle": {
			aplicar(
				hub,
				sql,
				removeOnePendingDetalle(caso.entrada.id_comanda, caso.entrada.id_producto),
			);
			return;
		}
		case "mesas.delete_detalle": {
			aplicar(hub, sql, deleteDetalle(caso.entrada.id_detalle, caso.entrada.id_comanda));
			return;
		}
		case "mesas.update_detalle_ingredientes": {
			aplicar(hub, sql, updateDetalleIngredientes(caso.entrada.id_detalle, caso.entrada.cambios));
			return;
		}
		case "mesas.update_detalle_nota": {
			aplicar(hub, sql, updateDetalleNota(caso.entrada.id_detalle, caso.entrada.nota));
			return;
		}
		case "mesas.kitchen_set_line_state": {
			aplicar(
				hub,
				sql,
				kitchenSetLineState(
					caso.entrada.id_detalle,
					caso.entrada.id_usuario_cocinero,
					caso.entrada.estado,
				),
			);
			return;
		}
		case "login.punch": {
			// El lado worker parte la operacion en dos comandos (la ruta decide cual segun el tipo);
			// el efecto que se contrasta es el mismo que el de `exec_punch` en Rust.
			if (caso.entrada.tipo === "entrada") {
				aplicar(
					hub,
					sql,
					punchEntrada({
						id_usuario: caso.entrada.id_usuario,
						fecha: caso.entrada.fecha,
						parte: caso.entrada.parte,
					}),
				);
			} else {
				// RI-05: el fichaje que se cierra lo elige la misma consulta que usa la ruta, y no el
				// caso: qué jornada cierra la salida (la de ayer en un turno de noche, nunca una
				// olvidada) es parte de lo que se contrasta con `exec_punch`.
				const enCurso = await getOpenPunch(db, caso.entrada.id_usuario);
				if (!enCurso) throw new Error("login.punch: no hay jornada en curso que cerrar");
				aplicar(
					hub,
					sql,
					punchSalida({
						id_usuario: caso.entrada.id_usuario,
						id_fichaje: enCurso.id_fichaje,
						fecha: enCurso.fecha,
					}),
				);
			}
			return;
		}
		case "login.set_turno_partido": {
			// El caso trae la fecha; la ruta la resuelve igual cuando no viene.
			aplicar(hub, sql, setTurnoPartido(caso.entrada as any, caso.entrada.fecha));
			return;
		}
		case "horarios.copiar_semana": {
			// Igual que la ruta: primero se leen las filas origen, y con ellas se construye el
			// comando (cada copia con su ID ya resuelto).
			const filas = await filasSemana(db, caso.entrada.from_monday);
			aplicar(hub, sql, copySemana(caso.entrada as any, filas));
			return;
		}
		case "horarios.marcar_libre": {
			aplicar(hub, sql, marcarLibre(caso.entrada as any));
			return;
		}
		case "trabajadores.eliminar": {
			// Igual que la ruta: el usuario de la ficha se lee antes, y con él se construye el comando.
			const idUsuario = (await usuarioDeTrabajador(db, caso.entrada.id_trabajador)) ?? "";
			aplicar(hub, sql, eliminarTrabajador(caso.entrada.id_trabajador, idUsuario));
			return;
		}
		case "horarios.set_predeterminado_desde_semana": {
			// Igual que la ruta: la semana se lee antes, y con sus filas se construye el comando.
			const items = await predeterminadoDesdeSemanaItems(db, caso.entrada.fecha_lunes);
			aplicar(hub, sql, setPredeterminadoDesdeSemana(caso.entrada.fecha_lunes, items));
			return;
		}
		case "horarios.guardar_asignacion": {
			aplicar(hub, sql, guardarAsignacion(caso.entrada as any));
			return;
		}
		case "horarios.delete_asignacion": {
			aplicar(hub, sql, deleteAsignacion(caso.entrada.id_asignacion));
			return;
		}
		// AUD-26: con el usuario que la toca, y la condición dentro de la sentencia. Un caso con
		// `rechazo` no cambia nada: el otro lado contesta not_found antes de escribir.
		case "notificaciones.descartar": {
			aplicar(hub, sql, descartarNotificacion(caso.entrada.id_notificacion, caso.entrada.id_usuario));
			return;
		}
		case "notificaciones.restaurar": {
			aplicar(hub, sql, restaurarNotificacion(caso.entrada.id_notificacion, caso.entrada.id_usuario));
			return;
		}
		case "notificaciones.eliminar": {
			aplicar(hub, sql, eliminarNotificacion(caso.entrada.id_notificacion, caso.entrada.id_usuario));
			return;
		}
		default:
			throw new Error(`comando sin soporte en el harness de contrato: ${caso.comando}`);
	}
}

describe("contrato Main↔worker · efecto == golden", () => {
	for (const { nombre, caso, golden } of CASOS) {
		it(`${nombre}: deja el mismo efecto que la Main`, async () => {
			await enElHub(`contract-${nombre}`, async (hub: any) => {
				const sql = hub.state.storage.sql;
				const db = clienteLocal(hub.state.storage);

				// 1) Esquema real + siembra del caso (idéntica al lado Rust).
				crearEsquemaTenant(sql);
				for (const s of (caso as any).seed) sql.exec(s);

				// 2) El comando por su camino real.
				await aplicarComando(hub, sql, db, caso);

				// 3) Estado resultante frente al golden, tabla a tabla.
				for (const [tabla, select] of Object.entries((caso as any).snapshot)) {
					const rs = await db.execute(select as string);
					const err = multiconjuntoIgual(rs.rows, (golden as any)[tabla]);
					expect(err, `${tabla}: ${err}`).toBeNull();
				}
			});
		});
	}
});

// El guard de arriba es la parte del harness que mira la SENTENCIA y no su efecto, así que conviene
// que él mismo tenga una prueba: si alguien lo relaja, esto se pone rojo antes que el bug vuelva.
describe("guard de SQL replicable determinista (TRAB-08)", () => {
	it("reconoce el patrón que rompía copiar semana", () => {
		expect(
			SQL_NO_DETERMINISTA.test(
				"INSERT INTO Asignacion_Turnos (...) SELECT lower(hex(randomblob(16))), a.ID_Trabajador FROM Asignacion_Turnos a",
			),
		).toBe(true);
		expect(SQL_NO_DETERMINISTA.test("SELECT random();")).toBe(true);
	});

	it("no marca el SQL que sí se replica bien", () => {
		// Los IDs viajan como argumento (?1), y `datetime('now')` lo resuelve el DO a literal antes
		// de replicar, así que ninguno de los dos es un falso positivo.
		expect(
			SQL_NO_DETERMINISTA.test(
				"INSERT INTO Asignacion_Turnos (ID_Asignacion, Fecha) VALUES (?1, date(?2));",
			),
		).toBe(false);
		expect(
			SQL_NO_DETERMINISTA.test(
				"INSERT INTO Fichajes (ID_Fichaje, Hora_Entrada) VALUES (?1, datetime('now','localtime'));",
			),
		).toBe(false);
	});
});


// RI-70: una edición de catálogo sin permiso de precios conserva el valor actual,
// aunque el formulario de la Handy siga mostrando un precio anterior.
describe("edición de catálogo sin cambiar precios", () => {
    it("no crea un producto borrado desde la lectura de una ficha sin permiso de precios", async () => {
        await enElHub("catalogo-producto-borrado", async (hub: any) => {
            const sql = hub.state.storage.sql;
            crearEsquemaTenant(sql);
            sql.exec("INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Categoría')");
            aplicar(hub, sql, upsertProducto({id_producto:'p',id_categoria:'cat',nombre:'Editado',precio_venta:100,iva_percent:10,ids_alergenos:[]}, false, 'actor', true));
            const filas = await clienteLocal(hub.state.storage).execute("SELECT ID_Producto FROM Productos WHERE ID_Producto='p'");
            expect(filas.rows).toEqual([]);
        });
    });

	it("conserva precio e IVA al editar la ficha desde un formulario antiguo", async () => {
		await enElHub("catalogo-sin-precios", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec("INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Categoría')");
			sql.exec("INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta,IVA_Percent) VALUES ('p','cat','Anterior',200,21)");
			aplicar(hub, sql, upsertProducto({ id_producto:'p',id_categoria:'cat',nombre:'Editado',precio_venta:100,iva_percent:10,ids_alergenos:[] }, false, 'actor', true));
			const filas = await clienteLocal(hub.state.storage).execute("SELECT Nombre,Precio_Venta,IVA_Percent FROM Productos WHERE ID_Producto='p'");
			expect(filas.rows).toEqual([{Nombre:'Editado',Precio_Venta:200,IVA_Percent:21}]);
		});
	});
});

// INC-20261030-016: una comanda cobrada no admite líneas nuevas. La Main lo rechaza con
// `COMANDA_COBRADA`, y eso el harness de arriba no lo ve: sólo compara casos que salen bien. Aquí, la
// guarda con la que la nube lo rechaza dentro del lote (SYNC-30) y la condición del propio INSERT,
// que es lo que llega a la Main: allí puede estar cobrada sin haberlo subido.
describe("una comanda cobrada no admite líneas (INC-20261030-016)", () => {
	const SIEMBRA = [
		"INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Bar')",
		"INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta) VALUES ('cafe','cat','Cafe',130)",
		"INSERT INTO Zonas (ID_Zona,Nombre_Zona) VALUES ('z','Sala')",
		"INSERT INTO Mesas (ID_Mesa,ID_Zona,Numero_Mesa,Capacidad,Ubicacion_X,Ubicacion_Y,Shape,Width,Height) VALUES ('m','z','1',4,0,0,'rect',80,80)",
		"INSERT INTO Comandas (ID_Comanda,ID_Mesa,Canal,Fecha_Hora_Apertura,Fecha_Hora_Cierre,Estado) VALUES ('mesa_cobrada','m','MESA','2026-10-30 23:00:00','2026-10-30 23:30:00','Pagada')",
		"INSERT INTO Comandas (ID_Comanda,ID_Mesa,Canal,Fecha_Hora_Apertura,Estado) VALUES ('mesa_abierta','m','MESA','2026-10-30 23:35:00','Abierta')",
		"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Fecha_Hora_Cierre,Estado) VALUES ('barra_cobrada','BARRA','2026-10-30 23:00:00','2026-10-30 23:10:00','Pagada')",
	];

	async function lineasDe(hub: any, idComanda: string): Promise<number> {
		const rs = await clienteLocal(hub.state.storage).execute({
			sql: "SELECT COUNT(*) AS n FROM Detalle_Comanda WHERE ID_Comanda = ?1",
			args: [idComanda],
		});
		return Number((rs.rows[0] as any).n);
	}

	const lineaMesa = (idComanda: string) =>
		addLineaMesa(
			{ id_comanda: idComanda, id_producto: "cafe", cantidad: 1, id_trabajador_o_usuario: null } as any,
			"PENDIENTE",
			null,
			"Cafe",
			130 as any,
		);
	const lineaBarra = (idComanda: string) =>
		addLinea({ id_comanda: idComanda, id_producto: "cafe", cantidad: 1 } as any, null, "Cafe", 130 as any);

	/** El error con el que la nube rechaza el comando, o `null` si entra. */
	function rechazo(hub: any, sql: any, built: any): string | null {
		try {
			aplicar(hub, sql, built);
			return null;
		} catch (e) {
			if (e instanceof GuardaIncumplida) return e.code;
			throw e;
		}
	}

	/** Como aplica la Main un cambio que le llega: sólo lo replicado, sin las guardas. */
	function comoLaMain(hub: any, sql: any, built: any) {
		hub.state.storage.transactionSync(() => {
			for (const st of buildApplyBatch(built.command).replicated) sql.exec(st.sql, ...(st.args ?? []));
		});
	}

	it("Mesas: la nube la rechaza en la cobrada y la mete en la abierta", async () => {
		await enElHub("inc016-mesas", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			expect(rechazo(hub, sql, lineaMesa("mesa_cobrada"))).toBe("comanda_cobrada");
			expect(rechazo(hub, sql, lineaMesa("mesa_abierta"))).toBeNull();
			expect(await lineasDe(hub, "mesa_cobrada")).toBe(0);
			expect(await lineasDe(hub, "mesa_abierta")).toBe(1);
		});
	});

	it("la barra: la nube la rechaza en el ticket cobrado, y uno que aún no existe se crea con ella", async () => {
		await enElHub("inc016-barra", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			expect(rechazo(hub, sql, lineaBarra("barra_cobrada"))).toBe("comanda_cobrada");
			expect(await lineasDe(hub, "barra_cobrada")).toBe(0);
			expect(rechazo(hub, sql, lineaBarra("aun_no_existe"))).toBeNull();
			expect(await lineasDe(hub, "aun_no_existe")).toBe(1);
		});
	});

	it("la Main, que aplica sólo lo replicado, tampoco la mete en la que tiene cobrada", async () => {
		await enElHub("inc016-main", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			comoLaMain(hub, sql, lineaMesa("mesa_cobrada"));
			comoLaMain(hub, sql, lineaBarra("barra_cobrada"));
			expect(await lineasDe(hub, "mesa_cobrada")).toBe(0);
			expect(await lineasDe(hub, "barra_cobrada")).toBe(0);
		});
	});
});

// AUD-14: borrar un ticket desde la Handy (`delete-if-safe`). La ruta decide con `hasPaidLines`, que
// lee la nube, pero lo que llega a la Main son los `DELETE`, y la Main los aplica con lo suyo: puede
// tener ese ticket cobrado y sin subir. Sin la condición dentro de la sentencia, la cascada de
// `Pagos.ID_Comanda` se llevaba allí el cobro, sus líneas cobradas y sus consumos; y en la nube pasaba
// lo mismo si el cobro subía entre la lectura y el lote (SYNC-30).
describe("borrar un ticket no se lleva su cobro (AUD-14)", () => {
	const SIEMBRA = [
		"INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Bebidas')",
		"INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta) VALUES ('cana','cat','Caña',200)",
		"INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Stock_Disponible) VALUES ('lote','cana','L1','2026-11-01 10:00:00',7)",
		"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Estado) VALUES ('ticket','BARRA','2026-11-08 12:00:00','Abierta')",
		"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Cantidad,Precio_Unitario) VALUES ('linea','ticket','cana',3,200)",
	];
	// Lo esencial de un cobro en efectivo de la Main: el pago, su línea, la traza del lote y el apunte
	// de caja.
	const COBRO = [
		"UPDATE Comandas SET Estado='Pagada', Total_Comanda=600, Fecha_Hora_Cierre='2026-11-08 12:05:00' WHERE ID_Comanda='ticket'",
		"INSERT INTO Pagos (ID_Pago,ID_Comanda,Fecha_Hora,Metodo_Pago,Importe_Total,Tipo) VALUES ('pago','ticket','2026-11-08 12:05:00','Efectivo',600,'FRACCIONADO')",
		"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('pago','linea')",
		"INSERT INTO Lote_Consumos (ID_Detalle,ID_Lote,ID_Pago,Cantidad) VALUES ('linea','lote','pago',3)",
		"INSERT INTO Movimientos_Caja (ID_Movimiento,Fecha_Hora,Tipo,ID_Pago,Importe,Metodo_Pago) VALUES ('mov','2026-11-08 12:05:00','COBRO','pago',600,'Efectivo')",
	];
	const COBRADO = {
		comanda: 1,
		lineas: 1,
		pagos: 1,
		efectivo_que_cuenta: 600,
		pago_detalles: 1,
		lote_consumos: 1,
		pago_del_cobro_en_caja: "pago",
	};
	// El texto exacto que recibe la Main. El test de la Main
	// (`venta_rapida.rs::tests_borrado_desde_la_handy`) aplica estas mismas sentencias.
	const SIN_COBROS =
		"NOT EXISTS (SELECT 1 FROM Pagos WHERE ID_Comanda = ?1)" +
		" AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas v JOIN Detalle_Comanda dc ON dc.ID_Detalle = v.ID_Detalle WHERE dc.ID_Comanda = ?1)";
	const REPLICADO = [
		{ sql: `DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1 AND ${SIN_COBROS};`, args: ["ticket"] },
		{ sql: `DELETE FROM Comandas WHERE ID_Comanda = ?1 AND ${SIN_COBROS};`, args: ["ticket"] },
	];

	function estado(sql: any) {
		const n = (q: string) => Number(Object.values(sql.exec(q).toArray()[0] ?? {})[0] ?? 0);
		return {
			comanda: n("SELECT COUNT(*) FROM Comandas WHERE ID_Comanda='ticket'"),
			lineas: n("SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='ticket'"),
			pagos: n("SELECT COUNT(*) FROM Pagos WHERE ID_Pago='pago'"),
			efectivo_que_cuenta: n(
				"SELECT COALESCE(SUM(Importe_Total),0) FROM Pagos WHERE Metodo_Pago='Efectivo' AND Estado='ACTIVO'",
			),
			pago_detalles: n("SELECT COUNT(*) FROM Pago_Detalles WHERE ID_Pago='pago'"),
			lote_consumos: n("SELECT COUNT(*) FROM Lote_Consumos WHERE ID_Pago='pago'"),
			pago_del_cobro_en_caja:
				sql.exec("SELECT ID_Pago AS id FROM Movimientos_Caja WHERE ID_Movimiento='mov'").toArray()[0]?.id ?? null,
		};
	}

	/** Como aplica la Main un cambio que le llega (`apply_one`): una transacción, FK diferidas. */
	function aplicarComoLaMain(hub: any, sql: any, sentencias: { sql: string; args: any[] }[]) {
		hub.state.storage.transactionSync(() => {
			sql.exec("PRAGMA defer_foreign_keys = ON;");
			for (const st of sentencias) sql.exec(st.sql, ...(st.args ?? []));
		});
	}

	it("lo que se replica a la Main lleva la condición", () => {
		expect(buildApplyBatch(deleteComandaIfSafe("ticket").command as any).replicated).toEqual(REPLICADO);
	});

	it("aplicado donde el ticket ya está cobrado (la Main, sin haberlo subido), conserva el cobro", async () => {
		await enElHub("aud14-main", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of [...SIEMBRA, ...COBRO]) sql.exec(s);
			expect(estado(sql)).toEqual(COBRADO);
			aplicarComoLaMain(hub, sql, buildApplyBatch(deleteComandaIfSafe("ticket").command as any).replicated);
			expect(estado(sql)).toEqual(COBRADO);
		});
		// Donde no hay cobro (la nube cuando la Handy pulsa), se borra el ticket entero, como antes.
		await enElHub("aud14-nube", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			aplicar(hub, sql, deleteComandaIfSafe("ticket"));
			expect(estado(sql)).toMatchObject({ comanda: 0, lineas: 0 });
		});
	});

	// La condición mira también las líneas: una cobrada por el cobro de OTRA comanda no se borra, ni
	// el ticket que la tiene. Es una subconsulta sobre la misma tabla del `DELETE`; el test de la Main
	// (`una_linea_cobrada_por_otra_comanda_no_se_borra`) la comprueba en su SQLite.
	it("una línea del ticket cobrada por el cobro de otra comanda no se borra, ni el ticket", async () => {
		await enElHub("aud14-linea-de-otro-cobro", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of [
				...SIEMBRA,
				"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Cantidad,Precio_Unitario) VALUES ('linea-2','ticket','cana',1,200)",
				"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Fecha_Hora_Cierre,Estado,Total_Comanda) VALUES ('otra','BARRA','2026-11-08 11:00:00','2026-11-08 11:30:00','Pagada',200)",
				"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Cantidad,Precio_Unitario) VALUES ('linea-otra','otra','cana',1,200)",
				"INSERT INTO Pagos (ID_Pago,ID_Comanda,Fecha_Hora,Metodo_Pago,Importe_Total,Tipo) VALUES ('pago-otra','otra','2026-11-08 11:30:00','Efectivo',800,'FRACCIONADO')",
				"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('pago-otra','linea-otra')",
				"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('pago-otra','linea')",
				"INSERT INTO Lote_Consumos (ID_Detalle,ID_Lote,ID_Pago,Cantidad) VALUES ('linea','lote','pago-otra',3)",
				"INSERT INTO Suelto_Consumos (ID_Detalle,ID_Producto,ID_Pago,Cantidad) VALUES ('linea','cana','pago-otra',1)",
				// Otro ticket sin nada cobrado: ése sí se borra.
				"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Estado) VALUES ('libre','BARRA','2026-11-08 12:30:00','Abierta')",
				"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Cantidad,Precio_Unitario) VALUES ('linea-libre','libre','cana',1,200)",
			]) {
				sql.exec(s);
			}
			const n = (q: string) => Number(Object.values(sql.exec(q).toArray()[0] ?? {})[0] ?? 0);
			const foto = () => ({
				ticket: n("SELECT COUNT(*) FROM Comandas WHERE ID_Comanda='ticket'"),
				lineas_del_ticket: n("SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='ticket'"),
				pago_detalles: n("SELECT COUNT(*) FROM Pago_Detalles WHERE ID_Pago='pago-otra'"),
				lote_consumos: n("SELECT COUNT(*) FROM Lote_Consumos WHERE ID_Pago='pago-otra'"),
				suelto_consumos: n("SELECT COUNT(*) FROM Suelto_Consumos WHERE ID_Pago='pago-otra'"),
			});
			const INTACTO = { ticket: 1, lineas_del_ticket: 2, pago_detalles: 2, lote_consumos: 1, suelto_consumos: 1 };
			expect(foto()).toEqual(INTACTO);

			aplicar(hub, sql, deleteComandaIfSafe("ticket"));
			expect(foto()).toEqual(INTACTO);

			aplicar(hub, sql, deleteComandaIfSafe("libre"));
			expect(n("SELECT COUNT(*) FROM Comandas WHERE ID_Comanda='libre'")).toBe(0);
			expect(n("SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='libre'")).toBe(0);
			expect(foto()).toEqual(INTACTO);
		});
	});

	it("si el cobro sube a la nube entre `hasPaidLines` y el lote, tampoco se pierde allí", async () => {
		await enElHub("aud14-carrera", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			// El motor real del TenantHub, sobre su SQLite.
			const db = clienteLocal(hub.state.storage);
			hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			hub.maybePurgeSyncLog = async () => {};
			const difundidos: any[] = [];
			hub.broadcastAuthed = (m: any) => {
				if (m?.type === "change") difundidos.push(m);
			};

			// La ruta lee: todavía no hay cobro.
			expect(await hasPaidLines(db as any, "ticket")).toBe(false);
			// La Main sube el cobro justo entonces.
			for (const s of COBRO) sql.exec(s);
			const built = deleteComandaIfSafe("ticket");
			const { result } = await hub.applyInternalCommandIdempotent({
				tenantId: "t-aud14",
				cmd: built.command,
				opId: "op-borrar-ticket",
				commandName: built.commandName,
				deviceId: "handy",
				requestPayloadJson: JSON.stringify(built.cloudPayload),
				clientNow: "2026-11-08 12:10:00",
			});

			expect(estado(sql)).toEqual(COBRADO);
			// Lo que mira la ruta para contestar `comanda_has_paid_lines`: no se ha borrado nada.
			expect(result).toBe(0);
			expect(difundidos.map((m) => m.statements)).toEqual([REPLICADO]);
		});
	});
});

// AUD-16: las dos altas de venta rápida usan como clave el id que manda el dispositivo. Con
// `ON CONFLICT … DO UPDATE` pisaban la fila que ya tuviera ese id: una línea cobrada cambiaba de
// ticket, de producto, de cantidad, de precio y de IVA sin salir de su cobro, y una comanda cobrada
// se reabría como ticket de barra, sin mesa y con otro camarero. Ahora son altas puras.
describe("un alta con un id que ya existe no toca la fila (AUD-16)", () => {
	const SIEMBRA = [
		"INSERT INTO Usuarios (ID_Usuario,ID_Rol,Email,Password_Hash,Nombre) VALUES ('u-ana','00000000-0000-7000-8000-000000000002','ana@ejemplo.test','x','Ana')",
		"INSERT INTO Usuarios (ID_Usuario,ID_Rol,Email,Password_Hash,Nombre) VALUES ('u-luis','00000000-0000-7000-8000-000000000002','luis@ejemplo.test','x','Luis')",
		"INSERT INTO Trabajadores (ID_Trabajador,ID_Usuario) VALUES ('t-ana','u-ana')",
		"INSERT INTO Trabajadores (ID_Trabajador,ID_Usuario) VALUES ('t-luis','u-luis')",
		"INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Bar')",
		"INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta,IVA_Percent) VALUES ('cafe','cat','Cafe',130,10)",
		"INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta,IVA_Percent) VALUES ('gin','cat','Gin',900,21)",
		"INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Stock_Disponible) VALUES ('lote-cafe','cafe','C1','2026-10-01 10:00:00',9)",
		"INSERT INTO Zonas (ID_Zona,Nombre_Zona) VALUES ('z','Sala')",
		"INSERT INTO Mesas (ID_Mesa,ID_Zona,Numero_Mesa,Capacidad,Ubicacion_X,Ubicacion_Y,Shape,Width,Height) VALUES ('m','z','1',4,0,0,'rect',80,80)",
		// Ticket de barra cobrado: dos cafés (uno del lote, otro del suelto), 2,60 € en efectivo.
		"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Fecha_Hora_Cierre,Estado,Total_Comanda,ID_Trabajador) VALUES ('barra_cobrada','BARRA','2026-10-30 23:00:00','2026-10-30 23:10:00','Pagada',260,'t-ana')",
		"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Nombre_Producto,Cantidad,Precio_Unitario,IVA_Percent) VALUES ('L','barra_cobrada','cafe','Cafe',2,130,10)",
		"INSERT INTO Pagos (ID_Pago,ID_Comanda,Fecha_Hora,Metodo_Pago,Importe_Total,Tipo) VALUES ('P1','barra_cobrada','2026-10-30 23:10:00','Efectivo',260,'FRACCIONADO')",
		"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('P1','L')",
		"INSERT INTO Lote_Consumos (ID_Detalle,ID_Lote,ID_Pago,Cantidad) VALUES ('L','lote-cafe','P1',1)",
		"INSERT INTO Suelto_Consumos (ID_Detalle,ID_Producto,ID_Pago,Cantidad) VALUES ('L','cafe','P1',1)",
		// Mesa cobrada, atendida por Ana: tres cafés con tarjeta.
		"INSERT INTO Comandas (ID_Comanda,ID_Mesa,Canal,Fecha_Hora_Apertura,Fecha_Hora_Cierre,Estado,Total_Comanda,ID_Trabajador) VALUES ('mesa_cobrada','m','MESA','2026-10-30 23:00:00','2026-10-30 23:30:00','Pagada',390,'t-ana')",
		"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Nombre_Producto,Cantidad,Precio_Unitario,IVA_Percent) VALUES ('LM','mesa_cobrada','cafe','Cafe',3,130,10)",
		"INSERT INTO Pagos (ID_Pago,ID_Comanda,Fecha_Hora,Metodo_Pago,Importe_Total,Tipo) VALUES ('P2','mesa_cobrada','2026-10-30 23:30:00','Tarjeta',390,'FRACCIONADO')",
		"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('P2','LM')",
	];

	const filas = (sql: any, q: string) => sql.exec(q).toArray();
	const n = (sql: any, q: string) => Number(Object.values(filas(sql, q)[0] ?? {})[0] ?? 0);

	/** El tenant sembrado, dentro de su propio DO. */
	async function conTenant(nombre: string, cuerpo: (hub: any, sql: any) => Promise<void> | void) {
		await enElHub(nombre, async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			await cuerpo(hub, sql);
		});
	}

	const lineaGin = (idDetalle: string, idComanda: string) =>
		addLinea({ id_detalle: idDetalle, id_comanda: idComanda, id_producto: "gin", cantidad: 50 } as any, 21, "Gin", 900 as any);
	const lineaCafe = (idDetalle: string, idComanda: string, cantidad: number) =>
		addLinea({ id_detalle: idDetalle, id_comanda: idComanda, id_producto: "cafe", cantidad } as any, 10, "Cafe", 130 as any);
	const ticket = (idComanda: string, idTrabajador: string) =>
		createComandaBarra({ id_comanda: idComanda, id_trabajador: null, get_or_create: false } as any, idTrabajador);

	it("lo que se replica a la Main es un alta pura", () => {
		for (const built of [lineaGin("L", "T"), ticket("mesa_cobrada", "t-luis")]) {
			const replicado = buildApplyBatch(built.command as any).replicated.map((s) => s.sql);
			expect(replicado.some((s) => /DO UPDATE/i.test(s)), replicado.join("\n")).toBe(false);
		}
	});

	it("una línea con el id de otra ya cobrada no la mueve ni la reescribe", async () => {
		await conTenant("aud16-mover", (hub, sql) => {
			const antes = filas(sql, "SELECT * FROM Detalle_Comanda WHERE ID_Detalle='L'");
			aplicar(hub, sql, lineaGin("L", "T"));
			expect(filas(sql, "SELECT * FROM Detalle_Comanda WHERE ID_Detalle='L'")).toEqual(antes);
			expect(n(sql, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='barra_cobrada'")).toBe(1);
			expect(n(sql, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='T'")).toBe(0);
			expect(filas(sql, "SELECT ID_Pago FROM v_lineas_cobradas WHERE ID_Detalle='L'")).toEqual([{ ID_Pago: "P1" }]);
		});
	});

	it("y borrar después el ticket al que iba no se lleva la línea cobrada ni sus trazas", async () => {
		await conTenant("aud16-borrar", (hub, sql) => {
			aplicar(hub, sql, lineaGin("L", "T"));
			// `T` lo creó vacío el alta de la línea, y sin cobros se borra.
			aplicar(hub, sql, deleteComandaIfSafe("T"));
			expect(n(sql, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda='T'")).toBe(0);
			expect(n(sql, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Detalle='L'")).toBe(1);
			expect({
				pago_detalles: n(sql, "SELECT COUNT(*) FROM Pago_Detalles WHERE ID_Pago='P1'"),
				lote_consumos: n(sql, "SELECT COUNT(*) FROM Lote_Consumos WHERE ID_Pago='P1'"),
				suelto_consumos: n(sql, "SELECT COUNT(*) FROM Suelto_Consumos WHERE ID_Pago='P1'"),
			}).toEqual({ pago_detalles: 1, lote_consumos: 1, suelto_consumos: 1 });
		});
	});

	it("un ticket con el id de una mesa cobrada no la reabre ni le cambia el camarero", async () => {
		await conTenant("aud16-reabrir", (hub, sql) => {
			const antes = filas(sql, "SELECT * FROM Comandas WHERE ID_Comanda='mesa_cobrada'");
			aplicar(hub, sql, ticket("mesa_cobrada", "t-luis"));
			expect(filas(sql, "SELECT * FROM Comandas WHERE ID_Comanda='mesa_cobrada'")).toEqual(antes);
			// Sigue cobrada, así que tampoco admite líneas (INC-20261030-016): la guarda la rechaza.
			expect(() => aplicar(hub, sql, lineaCafe("nueva-1", "mesa_cobrada", 1))).toThrow(GuardaIncumplida);
			expect(n(sql, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='mesa_cobrada'")).toBe(1);
		});
	});

	it("el alta con un id nuevo entra; otra con el mismo id no duplica ni cambia nada", async () => {
		await conTenant("aud16-legitimo", (hub, sql) => {
			aplicar(hub, sql, ticket("nuevo", "t-ana"));
			aplicar(hub, sql, lineaCafe("nueva-1", "nuevo", 2));
			const linea = "SELECT ID_Comanda,ID_Producto,Cantidad,Precio_Unitario,IVA_Percent FROM Detalle_Comanda WHERE ID_Detalle='nueva-1'";
			const comanda = "SELECT Estado,Canal,ID_Mesa,ID_Trabajador,Total_Comanda FROM Comandas WHERE ID_Comanda='nuevo'";
			const LINEA = [{ ID_Comanda: "nuevo", ID_Producto: "cafe", Cantidad: 2, Precio_Unitario: 130, IVA_Percent: 10 }];
			const COMANDA = [{ Estado: "Abierta", Canal: "BARRA", ID_Mesa: null, ID_Trabajador: "t-ana", Total_Comanda: 260 }];
			expect(filas(sql, linea)).toEqual(LINEA);
			expect(filas(sql, comanda)).toEqual(COMANDA);

			aplicar(hub, sql, ticket("nuevo", "t-luis"));
			aplicar(hub, sql, lineaCafe("nueva-1", "nuevo", 5));
			expect(filas(sql, linea)).toEqual(LINEA);
			expect(filas(sql, comanda)).toEqual(COMANDA);
		});
	});
});

// AUD-20: el alta de un lote es pura (INV-02), pero su movimiento 'ALTA' entraba sin condición. Con
// el id de un lote que ya existe, el lote no cambiaba y aparecía otra entrada de existencias: la
// reconciliación de la Main avisaba de un descuadre que ningún ajuste cerraba, porque un ajuste
// mueve a la vez lo guardado y lo calculado. Ahora el movimiento va delante del alta y sólo entra si
// el lote no existe, y la condición viaja en la sentencia: cada base la vuelve a evaluar al aplicar
// la réplica. Lo mismo el ALTA del stock suelto de un producto nuevo, que la ruta decide leyendo
// fuera del lote (SYNC-30): dos altas del mismo id a la vez dejaban dos.
describe("un alta con un id que ya existe no anota otro movimiento ALTA (AUD-20)", () => {
	const SIEMBRA = [
		"INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Bebidas')",
		"INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta) VALUES ('cerveza','cat','Cerveza',200)",
		"INSERT INTO Usuarios (ID_Usuario,ID_Rol,Email,Password_Hash,Nombre) VALUES ('autor','00000000-0000-7000-8000-000000000001','autor@ejemplo.test','x','Autor')",
	];

	const filas = (sql: any, q: string) => sql.exec(q).toArray();

	async function conTenant(nombre: string, cuerpo: (hub: any, sql: any) => Promise<void> | void) {
		await enElHub(nombre, async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const s of SIEMBRA) sql.exec(s);
			await cuerpo(hub, sql);
		});
	}

	/** Como aplica la Main un cambio que le llega (`apply_one`): una transacción, FK diferidas. */
	function aplicarComoLaMain(hub: any, sql: any, sentencias: { sql: string; args: any[] }[]) {
		hub.state.storage.transactionSync(() => {
			sql.exec("PRAGMA defer_foreign_keys = ON;");
			for (const st of sentencias) sql.exec(st.sql, ...(st.args ?? []));
		});
	}

	const lote = (idLote: string, codigo: string, stock: number) =>
		createLote(
			{ id_lote: idLote, id_producto: "cerveza", codigo_lote: codigo, fecha_entrada: "2026-01-01 00:00:00", stock_disponible: stock } as any,
			"autor",
		);

	/** Lo guardado frente a lo que suman sus movimientos: lo que cuadra la reconciliación de la Main. */
	const cuadre = (sql: any, idLote: string) =>
		filas(
			sql,
			`SELECT l.Codigo_Lote AS codigo, l.Stock_Disponible AS guardado,
			        (SELECT COUNT(*) FROM Movimientos_Stock m WHERE m.ID_Lote = l.ID_Lote) AS altas,
			        (SELECT COALESCE(SUM(m.Delta), 0) FROM Movimientos_Stock m WHERE m.ID_Lote = l.ID_Lote) AS calculado
			 FROM Lotes_Producto l WHERE l.ID_Lote = '${idLote}'`,
		);

	// Lo que difunde el TenantHub, sin espacios de más. El test de la Main
	// (`inventario.rs::tests_alta_de_lote`) aplica este mismo texto en su SQLite.
	const ALTA_DEL_LOTE =
		"INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)" +
		" SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now','localtime')" +
		" WHERE NOT EXISTS (SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?2);";
	const ALTA_PURA_DEL_LOTE =
		"INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)" +
		" VALUES (?1, ?2, ?3, COALESCE(NULLIF(?4, ''), datetime('now','localtime')), NULLIF(?5, ''), ?6, ?7, ?8, ?9)" +
		" ON CONFLICT(ID_Lote) DO NOTHING;";
	const sinEspacios = (s: string) => s.replace(/\s+/g, " ").trim();

	it("lo que se replica lleva el movimiento delante del lote, con la condición", () => {
		const replicado = buildApplyBatch(lote("lote-1", "L1", 10).command as any).replicated;
		expect(replicado.map((s) => sinEspacios(s.sql))).toEqual([ALTA_DEL_LOTE, ALTA_PURA_DEL_LOTE]);
		expect(replicado[0].args).toEqual([expect.any(String), "lote-1", "ALTA", 10, 10, null, "autor"]);
		expect(replicado[1].args.slice(0, 3)).toEqual(["lote-1", "cerveza", "L1"]);
	});

	it("un lote nuevo entra con su ALTA", async () => {
		await conTenant("aud20-nuevo", (hub, sql) => {
			aplicar(hub, sql, lote("lote-1", "L1", 10));
			expect(cuadre(sql, "lote-1")).toEqual([{ codigo: "L1", guardado: 10, altas: 1, calculado: 10 }]);
		});
	});

	it("con el id de un lote que ya existe no toca el lote ni anota nada, con cualquier código o cantidad", async () => {
		await conTenant("aud20-repetido", (hub, sql) => {
			aplicar(hub, sql, lote("lote-1", "L1", 10));
			aplicar(hub, sql, lote("lote-1", "L2", 50));
			aplicar(hub, sql, lote("lote-1", "L1", 7));
			aplicar(hub, sql, lote("lote-1", "L3", 0));
			expect(cuadre(sql, "lote-1")).toEqual([{ codigo: "L1", guardado: 10, altas: 1, calculado: 10 }]);
		});
	});

	it("la Main, al aplicar la réplica, no anota el alta repetida y sí la de un lote nuevo", async () => {
		const repetida = buildApplyBatch(lote("lote-1", "L2", 50).command as any).replicated;
		const nueva = buildApplyBatch(lote("lote-9", "L9", 4).command as any).replicated;
		await conTenant("aud20-main", (hub, sql) => {
			aplicar(hub, sql, lote("lote-1", "L1", 10));
			aplicarComoLaMain(hub, sql, repetida);
			aplicarComoLaMain(hub, sql, nueva);
			expect(cuadre(sql, "lote-1")).toEqual([{ codigo: "L1", guardado: 10, altas: 1, calculado: 10 }]);
			expect(cuadre(sql, "lote-9")).toEqual([{ codigo: "L9", guardado: 4, altas: 1, calculado: 4 }]);
		});
	});

	it("el ALTA del stock suelto: dos altas del mismo producto nuevo dejan una", async () => {
		// Las dos leen antes de que ninguna escriba, así que las dos llegan con `esNuevo`.
		const producto = (nombre: string, stock: number) =>
			upsertProducto(
				{ id_producto: "hielo", id_categoria: "cat", nombre, precio_venta: 100, stock_suelto: stock, ids_alergenos: [] } as any,
				true,
				"autor",
			);
		await conTenant("aud20-suelto", (hub, sql) => {
			aplicar(hub, sql, producto("Hielo", 5));
			aplicar(hub, sql, producto("Hielo picado", 7));
			expect(
				filas(
					sql,
					`SELECT p.Nombre AS nombre, p.Stock_Suelto AS guardado,
					        (SELECT COUNT(*) FROM Movimientos_Stock m WHERE m.ID_Producto = p.ID_Producto) AS altas,
					        (SELECT SUM(m.Delta) FROM Movimientos_Stock m WHERE m.ID_Producto = p.ID_Producto) AS calculado
					 FROM Productos p WHERE p.ID_Producto = 'hielo'`,
				),
			).toEqual([{ nombre: "Hielo picado", guardado: 5, altas: 1, calculado: 5 }]);
		});
		// Y la condición va en lo que se replica, delante del alta del producto.
		const replicado = buildApplyBatch(producto("Hielo", 5).command as any).replicated.map((s) => sinEspacios(s.sql));
		expect(replicado[0]).toContain("INSERT INTO Movimientos_Stock");
		expect(replicado[0]).toContain("WHERE NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?2);");
		expect(replicado[1]).toContain("INSERT INTO Productos");
	});
});
