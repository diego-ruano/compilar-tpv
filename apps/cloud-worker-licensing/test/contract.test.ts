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

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { createCliente, updateCliente } from "../src/domains/clientes/clientes.commands";
import { setTurnoPartido } from "../src/domains/login/login.commands";
import {
	createGasto,
	deleteGasto,
	deletePago,
	updateGasto,
	updatePago,
} from "../src/domains/cuentas/cuentas.commands";
import {
	crear as crearNotificacion,
	marcarLeida,
	marcarLeidasBatch,
	resolverPorClave,
} from "../src/domains/notificaciones/notificaciones.commands";
import {
	idActivaPorClave,
	idsNoLeidas,
} from "../src/domains/notificaciones/notificaciones.queries";
import {
	createAsignacion,
	deleteAsignacion,
	updateAsignacion,
} from "../src/domains/trabajadores/trabajadores.commands";
import {
	patchBusiness,
	patchContact,
	patchTicket,
} from "../src/domains/configuracion/configuracion.commands";
import {
	ajustarLote,
	createCategoria,
	createLote,
	deleteProducto,
	setAlergenosProducto,
	updateLote,
	upsertProducto,
} from "../src/domains/inventario/inventario.commands";
import {
	abrirComanda,
	addLinea as addLineaMesa,
	cerrarComanda,
	cobrarDetalles,
	deleteDetalle,
	kitchenSetLineState,
	removeOnePendingDetalle,
	saveLayout,
	setReservaEstado,
	setTrabajadorIfNull,
	updateDetalleNota,
} from "../src/domains/mesas/mesas.commands";
import { cobrarDetallesPlan } from "../src/domains/mesas/mesas.queries";
import {
	crearProducto,
	eliminarProveedor,
	guardarProveedor,
	setVinculos,
} from "../src/domains/proveedores/proveedores.commands";
import { deleteReserva, saveReserva } from "../src/domains/reservas/reservas.commands";
import { findClienteReserva } from "../src/domains/reservas/reservas.queries";
import {
	createTarea,
	deleteTarea,
	marcarFinalizada,
	setAsignacionesTarea,
	updateTarea,
} from "../src/domains/tareas/tareas.commands";
import {
	addLinea,
	cobrarFraccionado,
	createComandaBarra,
	deleteComandaIfSafe,
	deleteLineaIfUnpaid,
	removeLastUnpaidLinea,
	restarStock,
	updateNotaDetalle,
} from "../src/domains/venta_rapida/venta_rapida.commands";
import { cobrarPlan, restarStockPlan } from "../src/domains/venta_rapida/venta_rapida.queries";

// Casos del harness. Los goldens los bendice Rust (lado canónico). Añadir uno: crear el fixture,
// bendecir su golden y sumar aquí su par caso/golden (workerd no lee del disco: los imports son
// estáticos y esbuild los empaqueta). La misma lista, en Rust, vive en `contract_tests.rs::CASOS`.
import casoVrUnLote from "../../../tests/contract/casos/venta_rapida/cobro_fraccionado_un_lote.json";
import goldenVrUnLote from "../../../tests/contract/golden/venta_rapida/cobro_fraccionado_un_lote.json";
import casoVrMultilote from "../../../tests/contract/casos/venta_rapida/cobro_fraccionado_fefo_multilote.json";
import goldenVrMultilote from "../../../tests/contract/golden/venta_rapida/cobro_fraccionado_fefo_multilote.json";
import casoMesasCobro from "../../../tests/contract/casos/mesas/cobrar_detalles_un_lote.json";
import goldenMesasCobro from "../../../tests/contract/golden/mesas/cobrar_detalles_un_lote.json";
import casoCliCrear from "../../../tests/contract/casos/clientes/crear.json";
import goldenCliCrear from "../../../tests/contract/golden/clientes/crear.json";
import casoCliActualizar from "../../../tests/contract/casos/clientes/actualizar.json";
import goldenCliActualizar from "../../../tests/contract/golden/clientes/actualizar.json";
import casoTareaCrear from "../../../tests/contract/casos/tareas/crear.json";
import goldenTareaCrear from "../../../tests/contract/golden/tareas/crear.json";
import casoTareaActualizar from "../../../tests/contract/casos/tareas/actualizar.json";
import goldenTareaActualizar from "../../../tests/contract/golden/tareas/actualizar.json";
import casoTareaSetAsig from "../../../tests/contract/casos/tareas/set_asignaciones.json";
import goldenTareaSetAsig from "../../../tests/contract/golden/tareas/set_asignaciones.json";
import casoTareaEliminar from "../../../tests/contract/casos/tareas/eliminar.json";
import goldenTareaEliminar from "../../../tests/contract/golden/tareas/eliminar.json";
import casoTareaFinalizar from "../../../tests/contract/casos/tareas/marcar_finalizada.json";
import goldenTareaFinalizar from "../../../tests/contract/golden/tareas/marcar_finalizada.json";
import casoInvCreateLote from "../../../tests/contract/casos/inventario/create_lote.json";
import goldenInvCreateLote from "../../../tests/contract/golden/inventario/create_lote.json";
import casoInvCategoria from "../../../tests/contract/casos/inventario/create_categoria.json";
import goldenInvCategoria from "../../../tests/contract/golden/inventario/create_categoria.json";
import casoInvUpsertProd from "../../../tests/contract/casos/inventario/upsert_producto.json";
import goldenInvUpsertProd from "../../../tests/contract/golden/inventario/upsert_producto.json";
import casoInvSetAlerg from "../../../tests/contract/casos/inventario/set_alergenos.json";
import goldenInvSetAlerg from "../../../tests/contract/golden/inventario/set_alergenos.json";
import casoInvDeleteProd from "../../../tests/contract/casos/inventario/delete_producto.json";
import goldenInvDeleteProd from "../../../tests/contract/golden/inventario/delete_producto.json";
import casoInvUpdateLote from "../../../tests/contract/casos/inventario/update_lote.json";
import goldenInvUpdateLote from "../../../tests/contract/golden/inventario/update_lote.json";
import casoInvAjustarLote from "../../../tests/contract/casos/inventario/ajustar_lote.json";
import goldenInvAjustarLote from "../../../tests/contract/golden/inventario/ajustar_lote.json";
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
import casoProvCrearProd from "../../../tests/contract/casos/proveedores/crear_producto.json";
import goldenProvCrearProd from "../../../tests/contract/golden/proveedores/crear_producto.json";
import casoResNuevo from "../../../tests/contract/casos/reservas/guardar_cliente_nuevo.json";
import goldenResNuevo from "../../../tests/contract/golden/reservas/guardar_cliente_nuevo.json";
import casoResExistente from "../../../tests/contract/casos/reservas/guardar_cliente_existente.json";
import goldenResExistente from "../../../tests/contract/golden/reservas/guardar_cliente_existente.json";
import casoResEliminar from "../../../tests/contract/casos/reservas/eliminar.json";
import goldenResEliminar from "../../../tests/contract/golden/reservas/eliminar.json";
import casoVrCrearComanda from "../../../tests/contract/casos/venta_rapida/create_comanda_barra.json";
import goldenVrCrearComanda from "../../../tests/contract/golden/venta_rapida/create_comanda_barra.json";
import casoVrAddLinea from "../../../tests/contract/casos/venta_rapida/add_linea.json";
import goldenVrAddLinea from "../../../tests/contract/golden/venta_rapida/add_linea.json";
import casoVrRemoveLast from "../../../tests/contract/casos/venta_rapida/remove_last_unpaid_linea.json";
import goldenVrRemoveLast from "../../../tests/contract/golden/venta_rapida/remove_last_unpaid_linea.json";
import casoVrDeleteLinea from "../../../tests/contract/casos/venta_rapida/delete_linea_if_unpaid.json";
import goldenVrDeleteLinea from "../../../tests/contract/golden/venta_rapida/delete_linea_if_unpaid.json";
import casoVrUpdateNota from "../../../tests/contract/casos/venta_rapida/update_nota_detalle.json";
import goldenVrUpdateNota from "../../../tests/contract/golden/venta_rapida/update_nota_detalle.json";
import casoVrRestarStock from "../../../tests/contract/casos/venta_rapida/restar_stock.json";
import goldenVrRestarStock from "../../../tests/contract/golden/venta_rapida/restar_stock.json";
import casoVrDeleteComanda from "../../../tests/contract/casos/venta_rapida/delete_comanda_if_safe.json";
import goldenVrDeleteComanda from "../../../tests/contract/golden/venta_rapida/delete_comanda_if_safe.json";
import casoMesaSaveLayout from "../../../tests/contract/casos/mesas/save_layout.json";
import goldenMesaSaveLayout from "../../../tests/contract/golden/mesas/save_layout.json";
import casoMesaAbrir from "../../../tests/contract/casos/mesas/abrir_comanda.json";
import goldenMesaAbrir from "../../../tests/contract/golden/mesas/abrir_comanda.json";
import casoMesaSetTrab from "../../../tests/contract/casos/mesas/set_trabajador_if_null.json";
import goldenMesaSetTrab from "../../../tests/contract/golden/mesas/set_trabajador_if_null.json";
import casoMesaCerrar from "../../../tests/contract/casos/mesas/cerrar_comanda.json";
import goldenMesaCerrar from "../../../tests/contract/golden/mesas/cerrar_comanda.json";
import casoMesaAddLinea from "../../../tests/contract/casos/mesas/add_linea.json";
import goldenMesaAddLinea from "../../../tests/contract/golden/mesas/add_linea.json";
import casoMesaRemoveOne from "../../../tests/contract/casos/mesas/remove_one_pending_detalle.json";
import goldenMesaRemoveOne from "../../../tests/contract/golden/mesas/remove_one_pending_detalle.json";
import casoMesaDeleteDet from "../../../tests/contract/casos/mesas/delete_detalle.json";
import goldenMesaDeleteDet from "../../../tests/contract/golden/mesas/delete_detalle.json";
import casoMesaUpdateNota from "../../../tests/contract/casos/mesas/update_detalle_nota.json";
import goldenMesaUpdateNota from "../../../tests/contract/golden/mesas/update_detalle_nota.json";
import casoMesaKitchen from "../../../tests/contract/casos/mesas/kitchen_set_line_state.json";
import goldenMesaKitchen from "../../../tests/contract/golden/mesas/kitchen_set_line_state.json";
import casoCuentasCrearGasto from "../../../tests/contract/casos/cuentas/create_gasto.json";
import goldenCuentasCrearGasto from "../../../tests/contract/golden/cuentas/create_gasto.json";
import casoCuentasUpdateGasto from "../../../tests/contract/casos/cuentas/update_gasto.json";
import goldenCuentasUpdateGasto from "../../../tests/contract/golden/cuentas/update_gasto.json";
import casoCuentasDeleteGasto from "../../../tests/contract/casos/cuentas/delete_gasto.json";
import goldenCuentasDeleteGasto from "../../../tests/contract/golden/cuentas/delete_gasto.json";
import casoCuentasUpdatePago from "../../../tests/contract/casos/cuentas/update_pago.json";
import goldenCuentasUpdatePago from "../../../tests/contract/golden/cuentas/update_pago.json";
import casoCuentasDeletePago from "../../../tests/contract/casos/cuentas/delete_pago.json";
import goldenCuentasDeletePago from "../../../tests/contract/golden/cuentas/delete_pago.json";
import casoMesaSetReserva from "../../../tests/contract/casos/mesas/set_reserva_estado.json";
import goldenMesaSetReserva from "../../../tests/contract/golden/mesas/set_reserva_estado.json";
import casoNotifCrear from "../../../tests/contract/casos/notificaciones/crear.json";
import goldenNotifCrear from "../../../tests/contract/golden/notificaciones/crear.json";
import casoNotifCrearDedupe from "../../../tests/contract/casos/notificaciones/crear_dedupe.json";
import goldenNotifCrearDedupe from "../../../tests/contract/golden/notificaciones/crear_dedupe.json";
import casoNotifLeida from "../../../tests/contract/casos/notificaciones/marcar_leida.json";
import goldenNotifLeida from "../../../tests/contract/golden/notificaciones/marcar_leida.json";
import casoNotifBatch from "../../../tests/contract/casos/notificaciones/marcar_leidas_batch.json";
import goldenNotifBatch from "../../../tests/contract/golden/notificaciones/marcar_leidas_batch.json";
import casoNotifResolver from "../../../tests/contract/casos/notificaciones/resolver_por_clave.json";
import goldenNotifResolver from "../../../tests/contract/golden/notificaciones/resolver_por_clave.json";
import casoLoginTurno from "../../../tests/contract/casos/login/set_turno_partido.json";
import goldenLoginTurno from "../../../tests/contract/golden/login/set_turno_partido.json";
import casoHorCreate from "../../../tests/contract/casos/horarios/create_asignacion.json";
import goldenHorCreate from "../../../tests/contract/golden/horarios/create_asignacion.json";
import casoHorUpdate from "../../../tests/contract/casos/horarios/update_asignacion.json";
import goldenHorUpdate from "../../../tests/contract/golden/horarios/update_asignacion.json";
import casoHorDelete from "../../../tests/contract/casos/horarios/delete_asignacion.json";
import goldenHorDelete from "../../../tests/contract/golden/horarios/delete_asignacion.json";

const CASOS = [
	{ nombre: "vr_un_lote", caso: casoVrUnLote, golden: goldenVrUnLote },
	{ nombre: "vr_fefo_multilote", caso: casoVrMultilote, golden: goldenVrMultilote },
	{ nombre: "mesas_cobro_un_lote", caso: casoMesasCobro, golden: goldenMesasCobro },
	{ nombre: "clientes_crear", caso: casoCliCrear, golden: goldenCliCrear },
	{ nombre: "clientes_actualizar", caso: casoCliActualizar, golden: goldenCliActualizar },
	{ nombre: "tareas_crear", caso: casoTareaCrear, golden: goldenTareaCrear },
	{ nombre: "tareas_actualizar", caso: casoTareaActualizar, golden: goldenTareaActualizar },
	{ nombre: "tareas_set_asignaciones", caso: casoTareaSetAsig, golden: goldenTareaSetAsig },
	{ nombre: "tareas_eliminar", caso: casoTareaEliminar, golden: goldenTareaEliminar },
	{ nombre: "tareas_marcar_finalizada", caso: casoTareaFinalizar, golden: goldenTareaFinalizar },
	{ nombre: "inventario_create_lote", caso: casoInvCreateLote, golden: goldenInvCreateLote },
	{ nombre: "inventario_create_categoria", caso: casoInvCategoria, golden: goldenInvCategoria },
	{ nombre: "inventario_upsert_producto", caso: casoInvUpsertProd, golden: goldenInvUpsertProd },
	{ nombre: "inventario_set_alergenos", caso: casoInvSetAlerg, golden: goldenInvSetAlerg },
	{ nombre: "inventario_delete_producto", caso: casoInvDeleteProd, golden: goldenInvDeleteProd },
	{ nombre: "inventario_update_lote", caso: casoInvUpdateLote, golden: goldenInvUpdateLote },
	{ nombre: "inventario_ajustar_lote", caso: casoInvAjustarLote, golden: goldenInvAjustarLote },
	{ nombre: "config_patch_business", caso: casoCfgBusiness, golden: goldenCfgBusiness },
	{ nombre: "config_patch_contact", caso: casoCfgContact, golden: goldenCfgContact },
	{ nombre: "config_patch_ticket", caso: casoCfgTicket, golden: goldenCfgTicket },
	{ nombre: "proveedores_guardar", caso: casoProvGuardar, golden: goldenProvGuardar },
	{ nombre: "proveedores_eliminar", caso: casoProvEliminar, golden: goldenProvEliminar },
	{ nombre: "proveedores_set_vinculos", caso: casoProvVinculos, golden: goldenProvVinculos },
	{ nombre: "proveedores_crear_producto", caso: casoProvCrearProd, golden: goldenProvCrearProd },
	{ nombre: "reservas_guardar_cliente_nuevo", caso: casoResNuevo, golden: goldenResNuevo },
	{ nombre: "reservas_guardar_cliente_existente", caso: casoResExistente, golden: goldenResExistente },
	{ nombre: "reservas_eliminar", caso: casoResEliminar, golden: goldenResEliminar },
	{ nombre: "vr_create_comanda_barra", caso: casoVrCrearComanda, golden: goldenVrCrearComanda },
	{ nombre: "vr_add_linea", caso: casoVrAddLinea, golden: goldenVrAddLinea },
	{ nombre: "vr_remove_last_unpaid_linea", caso: casoVrRemoveLast, golden: goldenVrRemoveLast },
	{ nombre: "vr_delete_linea_if_unpaid", caso: casoVrDeleteLinea, golden: goldenVrDeleteLinea },
	{ nombre: "vr_update_nota_detalle", caso: casoVrUpdateNota, golden: goldenVrUpdateNota },
	{ nombre: "vr_restar_stock", caso: casoVrRestarStock, golden: goldenVrRestarStock },
	{ nombre: "vr_delete_comanda_if_safe", caso: casoVrDeleteComanda, golden: goldenVrDeleteComanda },
	{ nombre: "mesas_save_layout", caso: casoMesaSaveLayout, golden: goldenMesaSaveLayout },
	{ nombre: "mesas_abrir_comanda", caso: casoMesaAbrir, golden: goldenMesaAbrir },
	{ nombre: "mesas_set_trabajador_if_null", caso: casoMesaSetTrab, golden: goldenMesaSetTrab },
	{ nombre: "mesas_cerrar_comanda", caso: casoMesaCerrar, golden: goldenMesaCerrar },
	{ nombre: "mesas_add_linea", caso: casoMesaAddLinea, golden: goldenMesaAddLinea },
	{ nombre: "mesas_remove_one_pending", caso: casoMesaRemoveOne, golden: goldenMesaRemoveOne },
	{ nombre: "mesas_delete_detalle", caso: casoMesaDeleteDet, golden: goldenMesaDeleteDet },
	{ nombre: "mesas_update_detalle_nota", caso: casoMesaUpdateNota, golden: goldenMesaUpdateNota },
	{ nombre: "mesas_kitchen_set_line_state", caso: casoMesaKitchen, golden: goldenMesaKitchen },
	{ nombre: "cuentas_create_gasto", caso: casoCuentasCrearGasto, golden: goldenCuentasCrearGasto },
	{ nombre: "cuentas_update_gasto", caso: casoCuentasUpdateGasto, golden: goldenCuentasUpdateGasto },
	{ nombre: "cuentas_delete_gasto", caso: casoCuentasDeleteGasto, golden: goldenCuentasDeleteGasto },
	{ nombre: "cuentas_update_pago", caso: casoCuentasUpdatePago, golden: goldenCuentasUpdatePago },
	{ nombre: "cuentas_delete_pago", caso: casoCuentasDeletePago, golden: goldenCuentasDeletePago },
	{ nombre: "mesas_set_reserva_estado", caso: casoMesaSetReserva, golden: goldenMesaSetReserva },
	{ nombre: "notificaciones_crear", caso: casoNotifCrear, golden: goldenNotifCrear },
	{ nombre: "notificaciones_crear_dedupe", caso: casoNotifCrearDedupe, golden: goldenNotifCrearDedupe },
	{ nombre: "notificaciones_marcar_leida", caso: casoNotifLeida, golden: goldenNotifLeida },
	{ nombre: "notificaciones_marcar_leidas_batch", caso: casoNotifBatch, golden: goldenNotifBatch },
	{ nombre: "notificaciones_resolver_por_clave", caso: casoNotifResolver, golden: goldenNotifResolver },
	{ nombre: "login_set_turno_partido", caso: casoLoginTurno, golden: goldenLoginTurno },
	{ nombre: "horarios_create_asignacion", caso: casoHorCreate, golden: goldenHorCreate },
	{ nombre: "horarios_update_asignacion", caso: casoHorUpdate, golden: goldenHorUpdate },
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
 * Reproduce el **sobre** con el que el hub aplica de verdad un batch: una transacción con
 * `PRAGMA defer_foreign_keys = ON` (ver `applyInternalCommand`: "batch atómico = [PRAGMA defer FK]
 * + [gate idempotente] + [trabajo] + [log de sync]"). No es un detalle: un comando que borra en un
 * orden que deja referencias colgantes hasta el COMMIT —la anulación de un cobro borra las líneas
 * antes que sus `Pago_Detalles`— revienta por FK sin el pragma. Sin esto el harness diría que hay
 * divergencia donde solo había un envoltorio distinto.
 */
function aplicar(hub: any, sql: any, built: any): void {
	const batch = hub.buildApplyBatch(built.command);
	hub.state.storage.transactionSync(() => {
		sql.exec("PRAGMA defer_foreign_keys = ON;");
		for (const st of batch.middle) sql.exec(st.sql, ...(st.args ?? []));
	});
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
			} as any));
			return;
		}
		case "clientes.actualizar": {
			aplicar(hub, sql, updateCliente(caso.entrada.id_cliente, {
				nombre: caso.entrada.nombre,
				email: caso.entrada.email,
				telefono: caso.entrada.telefono,
				notas: caso.entrada.notas,
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
					cantidad_inicial: caso.entrada.cantidad_inicial,
					stock_disponible: caso.entrada.stock_disponible,
					coste_unitario: caso.entrada.coste_unitario,
					id_proveedor: caso.entrada.id_proveedor,
					notas: caso.entrada.notas,
				} as any),
			);
			return;
		}
		case "inventario.create_categoria": {
			aplicar(hub, sql, createCategoria(caso.entrada as any));
			return;
		}
		case "inventario.upsert_producto": {
			aplicar(hub, sql, upsertProducto(caso.entrada as any));
			return;
		}
		case "inventario.set_alergenos": {
			aplicar(
				hub,
				sql,
				setAlergenosProducto(caso.entrada.id_producto, {
					ids_alergenos: caso.entrada.ids_alergenos,
				} as any),
			);
			return;
		}
		case "inventario.delete_producto": {
			aplicar(hub, sql, deleteProducto(caso.entrada.id_producto));
			return;
		}
		case "inventario.update_lote": {
			// La ruta lee el stock previo (para el delta de auditoría) antes de construir el comando.
			const rs = await db.execute({
				sql: "SELECT Stock_Disponible AS s FROM Lotes_Producto WHERE ID_Lote=?1;",
				args: [caso.entrada.id_lote],
			});
			const stockActual = Number(rs.rows[0]?.s ?? 0);
			aplicar(hub, sql, updateLote(caso.entrada.id_lote, caso.entrada as any, stockActual));
			return;
		}
		case "inventario.ajustar_lote": {
			const rs = await db.execute({
				sql: "SELECT Stock_Disponible AS s FROM Lotes_Producto WHERE ID_Lote=?1;",
				args: [caso.entrada.id_lote],
			});
			const stockActual = Number(rs.rows[0]?.s ?? 0);
			aplicar(
				hub,
				sql,
				ajustarLote(
					caso.entrada.id_lote,
					{ stock_disponible: caso.entrada.stock_disponible, notas: caso.entrada.notas } as any,
					stockActual,
				),
			);
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
		case "proveedores.crear_producto": {
			aplicar(hub, sql, crearProducto(caso.entrada as any));
			return;
		}
		case "reservas.guardar": {
			// La ruta busca el cliente existente por email/teléfono antes de construir el comando.
			const cliente = await findClienteReserva(
				db,
				caso.entrada.email ?? null,
				caso.entrada.telefono ?? null,
			);
			aplicar(hub, sql, saveReserva(caso.entrada as any, cliente));
			return;
		}
		case "reservas.eliminar": {
			aplicar(hub, sql, deleteReserva(caso.entrada.id_reserva));
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
			aplicar(hub, sql, addLinea(caso.entrada as any));
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
		case "venta_rapida.restar_stock": {
			const plan = await restarStockPlan(db, caso.entrada as any);
			aplicar(hub, sql, restarStock(caso.entrada as any, plan as any));
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
			aplicar(hub, sql, setReservaEstado(caso.entrada.id_reserva, caso.entrada.estado));
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
		case "cuentas.delete_pago": {
			aplicar(hub, sql, deletePago(caso.entrada.id_pago));
			return;
		}
		case "notificaciones.crear": {
			// El dedupe vive en el route (una consulta previa), no en el builder: si ya hay una
			// activa con esa clave se reutiliza y NO se emite nada. En la Main eso pasa dentro del
			// repo, así que aquí hay que reproducir el camino del route para comparar lo mismo.
			const clave = caso.entrada.clave_dedupe;
			if (clave) {
				const yaActiva = await idActivaPorClave(db, clave);
				if (yaActiva) return;
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
		case "mesas.cerrar_comanda": {
			aplicar(hub, sql, cerrarComanda(caso.entrada.id_comanda, caso.entrada.total));
			return;
		}
		case "mesas.add_linea": {
			// Estado_Cocina lo resuelve el route (fuera del builder); se excluye del snapshot, así
			// que aquí se pasa un valor válido cualquiera ('PENDIENTE').
			aplicar(
				hub,
				sql,
				addLineaMesa(
					{
						id_comanda: caso.entrada.id_comanda,
						id_producto: caso.entrada.id_producto,
						cantidad: caso.entrada.cantidad,
						precio: caso.entrada.precio,
						id_trabajador_o_usuario: null,
					} as any,
					"PENDIENTE",
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
		case "login.set_turno_partido": {
			aplicar(hub, sql, setTurnoPartido(caso.entrada as any));
			return;
		}
		case "horarios.create_asignacion": {
			aplicar(hub, sql, createAsignacion(caso.entrada as any));
			return;
		}
		case "horarios.update_asignacion": {
			aplicar(hub, sql, updateAsignacion(caso.entrada.id_asignacion, caso.entrada as any));
			return;
		}
		case "horarios.delete_asignacion": {
			aplicar(hub, sql, deleteAsignacion(caso.entrada.id_asignacion));
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
				const db = clienteSobre(sql);

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
