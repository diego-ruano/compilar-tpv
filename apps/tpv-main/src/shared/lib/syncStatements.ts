// RI-31: presenta los metadatos nativos; el frontend no interpreta SQL.
import type { ComandaReplicada } from "@tpv/contracts";
export type ComandaSyncInfo = ComandaReplicada;

const TABLE_TO_FEATURES: Record<string, readonly string[]> = {
	comandas: ["mesas", "stats"],
	detalle_comanda: ["mesas", "stats"],
	pagos: ["cuentas", "stats"],
	pago_detalles: ["cuentas", "stats"],
	devolucion_lineas: ["cuentas"],
	cuentas_gastos: ["cuentas", "stats"],
	categorias_producto: ["inventario", "stats"],
	// INC-20261030-013: la ficha de un proveedor enseña sus productos vinculados, con el stock y la
	// última entrada. Vincular es un `UPDATE Productos SET ID_Proveedor`, así que sin `proveedores`
	// aquí los demás equipos no se enteraban hasta salir y volver a entrar.
	productos: ["inventario", "proveedores", "stats"],
	lotes_producto: ["inventario", "proveedores", "stats"],
	lote_consumos: ["inventario", "stats"],
	alergenos: ["inventario"],
	producto_alergenos: ["inventario"],
	proveedores: ["proveedores", "inventario", "cuentas", "pedidos_proveedor", "stats"],
	pedidos_proveedor: ["pedidos_proveedor", "inventario"],
	lineas_pedido_proveedor: ["pedidos_proveedor", "inventario"],
	zonas: ["mesas"],
	mesas: ["mesas"],
	clientes: ["clientes", "reservas", "stats"],
	// El plano enseña la reserva de cada mesa (`mesas_meta_all`), y el resumen de Clientes cuenta
	// sus reservas y las pendientes.
	reservas: ["reservas", "mesas", "clientes", "stats"],
	tareas: ["tareas"],
	tarea_asignaciones: ["tareas"],
	trabajadores: ["trabajadores", "tareas", "stats"],
	turnos: ["trabajadores"],
	asignacion_turnos: ["trabajadores"],
	horario_predeterminado: ["trabajadores"],
	fichajes: ["trabajadores"],
	fichaje_dia: ["trabajadores"],
	roles_permisos: ["permisos"],
	roles: ["permisos", "trabajadores"],
	usuarios: ["permisos", "trabajadores"],
	notificaciones: ["notificaciones"],
	notificacion_lecturas: ["notificaciones"],
	// Ajustes: viven en stores Zustand (no en React Query), así que no invalidan ninguna clave de
	// caché. Lo que sí hace falta es que sus stores se recarguen — ver `tocaAjustes` más abajo.
	business_settings: [],
	ticket_settings: [],
	contact_settings: [],
};


const TABLAS_DE_AJUSTES = new Set(["business_settings", "ticket_settings", "contact_settings"]);

export function shouldReloadTicket(
	info: ComandaSyncInfo,
	activeId: string | null | undefined,
): boolean {
	if (info.uncertain) return true;
	if (!activeId) return false;
	return info.ids.includes(activeId);
}

/** RI-31: la Main recibe sólo tablas; las sentencias se quedan en Rust. */
export function featureKeysPorTablas(tablas: string[] | null): string[] | null {
    if (tablas === null) return null;
    const keys = new Set<string>();
    for (const tabla of tablas) {
        const features = TABLE_TO_FEATURES[tabla.toLowerCase()];
        if (!features) return null;
        for (const feature of features) keys.add(feature);
    }
    return Array.from(keys);
}

export function ajustesPorTablas(tablas: string[] | null): boolean {
    return tablas === null || tablas.some((t) => TABLAS_DE_AJUSTES.has(t.toLowerCase()));
}
