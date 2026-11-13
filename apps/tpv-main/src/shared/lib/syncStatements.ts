// RI-31: presenta los metadatos nativos; el frontend no interpreta SQL.
import type { ComandaReplicada } from "@tpv/contracts";
export type ComandaSyncInfo = ComandaReplicada;

/** Las claves de caché de React Query: el prefijo de cada `features/<x>/<x>Queries.ts`. */
type Area =
	| "mesas"
	| "stats"
	| "cuentas"
	| "inventario"
	| "proveedores"
	| "pedidos_proveedor"
	| "clientes"
	| "reservas"
	| "tareas"
	| "trabajadores"
	| "permisos"
	| "notificaciones";

/**
 * Qué pantallas enseñan cada tabla de negocio: las claves que se invalidan cuando otro equipo la
 * cambia.
 *
 * **Toda tabla de negocio del esquema tiene su entrada, aunque sea `[]`.** Una tabla sin entrada
 * obliga a releerlo todo (`featureKeysPorTablas` devuelve `null`), y en una Handy cada lectura es
 * un viaje al Durable Object del negocio: sin las que escribe cada cobro (`movimientos_caja`,
 * `registros_facturacion`…), cada venta haría releer todo a todas las Handy.
 * `test/syncStatements.test.ts` lee `packages/database/schema.snapshot.sql` y falla si falta una.
 *
 * `[]` es «ninguna pantalla con caché la enseña», no «no se sabe»: lleva su motivo.
 */
const TABLE_TO_FEATURES: Record<string, readonly Area[]> = {
	comandas: ["mesas", "stats"],
	detalle_comanda: ["mesas", "stats"],
	// El plano enseña lo que queda por cobrar de cada mesa, y eso sale de las líneas cobradas
	// (`v_lineas_cobradas`: `Pago_Detalles` de un `Pagos` activo). Un cobro parcial, una baja o una
	// devolución no tocan `Comandas`: sin `mesas` aquí, el plano de los demás equipos seguiría con
	// el pendiente anterior hasta su relectura de cada minuto.
	pagos: ["cuentas", "stats", "mesas"],
	pago_detalles: ["cuentas", "stats", "mesas"],
	devolucion_lineas: ["cuentas"],
	cuentas_gastos: ["cuentas", "stats"],
	// La caja es de Cuentas. El apunte de `Movimientos_Caja` va siempre junto al `Pagos` o al
	// `Cuentas_Gastos` que lo origina, y son ésos los que refrescan también las estadísticas: el
	// historial de caja es para investigar, nunca para sumar.
	movimientos_caja: ["cuentas"],
	aperturas_cajon: ["cuentas"],
	cierres_caja: ["cuentas"],
	cierre_denominaciones: ["cuentas"],
	cierre_rectificaciones: ["cuentas"],
	// Lo fiscal sólo existe en la Main y no está en ninguna caché: el ticket se compone desde la
	// base cada vez que se imprime, y el aviso de los datos fiscales sale de `business_settings`.
	// Lo que un cobro cambia en pantalla llega por `pagos`, que va en el mismo lote.
	registros_facturacion: [],
	serie_facturacion: [],
	categorias_producto: ["inventario", "stats"],
	// INC-20261030-013: la ficha de un proveedor enseña sus productos vinculados, con el stock y la
	// última entrada. Vincular es un `UPDATE Productos SET ID_Proveedor`, así que sin `proveedores`
	// aquí los demás equipos no se enteraban hasta salir y volver a entrar.
	productos: ["inventario", "proveedores", "stats"],
	lotes_producto: ["inventario", "proveedores", "stats"],
	lote_consumos: ["inventario", "stats"],
	// El stock que enseñan las pantallas sale de `lotes_producto` y de `productos.Stock_Suelto`, que
	// van en el mismo lote que estas dos: el consumo sin lote de un cobro y el historial de altas y
	// ajustes.
	suelto_consumos: ["inventario"],
	movimientos_stock: ["inventario"],
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
	// Qué mesas se reservan desde la web, en qué franjas y qué días se cierra: se cambia en la Main.
	reserva_web_mesas: ["reservas"],
	reserva_web_franjas: ["reservas"],
	reserva_web_cierres: ["reservas"],
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
	// El freno del PIN (LOGIN-01) es estado de cada equipo y de la nube: no se replica, y si llegara
	// no hay pantalla que lo enseñe.
	intentos_login: [],
	// Ajustes: viven en stores Zustand (no en React Query), así que no invalidan ninguna clave de
	// caché. Lo que sí hace falta es que su store se recargue — ver `ajustesPorTablas` más abajo.
	business_settings: [],
	ticket_settings: [],
	contact_settings: [],
};

// Un `Map` y no el objeto: `TABLE_TO_FEATURES["constructor"]` existe y no es una entrada.
const AREAS_POR_TABLA = new Map(Object.entries(TABLE_TO_FEATURES));

/** Las tablas con entrada, para el test que las contrasta con el esquema. */
export function tablasConArea(): string[] {
	return Array.from(AREAS_POR_TABLA.keys());
}

/** Las tres tablas de ajustes. Cada una tiene su store (`recargarAjustes.ts`). */
export type TablaDeAjustes = "business_settings" | "ticket_settings" | "contact_settings";
const TABLAS_DE_AJUSTES: readonly TablaDeAjustes[] = ["business_settings", "ticket_settings", "contact_settings"];

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
        const features = AREAS_POR_TABLA.get(tabla.toLowerCase());
        if (!features) return null;
        for (const feature of features) keys.add(feature);
    }
    return Array.from(keys);
}

/**
 * Qué ajustes hay que releer: los de las tablas que han cambiado, y sólo ésos. Sin clasificación
 * (`null`: Rust no ha sabido leer alguna sentencia) no se sabe cuáles, así que los tres.
 */
export function ajustesPorTablas(tablas: string[] | null): readonly TablaDeAjustes[] {
    if (tablas === null) return TABLAS_DE_AJUSTES;
    const tocadas = new Set(tablas.map((t) => t.toLowerCase()));
    return TABLAS_DE_AJUSTES.filter((t) => tocadas.has(t));
}
