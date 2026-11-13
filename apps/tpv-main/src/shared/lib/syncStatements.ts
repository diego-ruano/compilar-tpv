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
 *
 * Una tabla lleva también las pantallas que la enseñan **a través de otra**: el nombre de una mesa
 * sale en Reservas, en Clientes, en Cuentas y en las estadísticas, así que renombrarla las refresca
 * todas. La única que se deja fuera a sabiendas es `comandas` → Cuentas (ver su entrada).
 */
const TABLE_TO_FEATURES: Record<string, readonly Area[]> = {
	// Cuentas enseña la mesa y el cliente de la comanda de cada cobro, pero se fijan al cobrar, en
	// el mismo lote que su `pagos`. Lo único que no la refresca es enlazar una reserva a una comanda
	// que ya tiene un cobro parcial, a cambio de no releer Cuentas con cada línea que se añade.
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
	// Proveedores tiene su selector de categorías. Y el plano cuenta lo que hay pendiente en cocina,
	// que depende de `Pasa_Cocina` de la categoría de cada producto.
	categorias_producto: ["inventario", "proveedores", "mesas", "stats"],
	// INC-20261030-013: la ficha de un proveedor enseña sus productos vinculados, con el stock y la
	// última entrada. Vincular es un `UPDATE Productos SET ID_Proveedor`, así que sin `proveedores`
	// aquí los demás equipos no se enteraban hasta salir y volver a entrar.
	productos: ["inventario", "proveedores", "mesas", "stats"],
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
	// El nombre de una zona y el de una mesa salen en Reservas y en las estadísticas; el de la mesa,
	// además, en la última reserva de cada cliente y en cada cobro de Cuentas.
	zonas: ["mesas", "reservas", "stats"],
	mesas: ["mesas", "reservas", "clientes", "cuentas", "stats"],
	// El nombre del cliente sale en la reserva de cada mesa del plano y en sus cobros de Cuentas.
	clientes: ["clientes", "reservas", "mesas", "cuentas", "stats"],
	// El plano enseña la reserva de cada mesa (`mesas_meta_all`), y el resumen de Clientes cuenta
	// sus reservas y las pendientes. Cuentas pone a cada cobro el cliente de la reserva de su comanda.
	reservas: ["reservas", "mesas", "clientes", "cuentas", "stats"],
	// Qué mesas se reservan desde la web, en qué franjas y qué días se cierra: se cambia en la Main.
	reserva_web_mesas: ["reservas"],
	reserva_web_franjas: ["reservas"],
	reserva_web_cierres: ["reservas"],
	tareas: ["tareas"],
	// Las estadísticas de trabajadores cuentan las tareas hechas, las horas del cuadrante y las
	// fichadas, y filtran por rol.
	tarea_asignaciones: ["tareas", "stats"],
	trabajadores: ["trabajadores", "tareas", "stats"],
	turnos: ["trabajadores"],
	asignacion_turnos: ["trabajadores", "stats"],
	horario_predeterminado: ["trabajadores"],
	fichajes: ["trabajadores", "stats"],
	fichaje_dia: ["trabajadores"],
	roles_permisos: ["permisos"],
	roles: ["permisos", "trabajadores", "stats"],
	// El nombre de un usuario sale en las tareas, en quién anuló un cobro y en las estadísticas; y
	// las notificaciones de cada uno dependen de su rol.
	usuarios: ["permisos", "trabajadores", "tareas", "cuentas", "notificaciones", "stats"],
	notificaciones: ["notificaciones"],
	notificacion_lecturas: ["notificaciones"],
	// El freno del PIN (LOGIN-01) es estado de cada equipo y de la nube: no se replica, y si llegara
	// no hay pantalla que lo enseñe.
	intentos_login: [],
	// Ajustes: viven en stores Zustand (no en React Query), así que no invalidan ninguna clave de
	// caché. Lo que sí hace falta es que su store se recargue — ver `ajustesPorTablas` más abajo.
	// La excepción es el plano: la reserva que enseña cada mesa depende de la duración por defecto
	// de las reservas y de la zona horaria del negocio.
	business_settings: ["mesas"],
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
