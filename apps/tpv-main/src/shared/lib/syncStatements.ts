// src/shared/lib/syncStatements.ts
//
// Analiza las sentencias SQL resueltas que llegan en un `change` de sincronización para
// averiguar QUÉ comandas toca el lote. Lo usa el POS (venta-rápida / mesas) para recargar el
// ticket SOLO si la comanda afectada es la que el usuario tiene abierta en ese momento (si la
// Main edita otra comanda, no tiene sentido recargar el ticket activo del Handy, y viceversa).
//
// Es un heurístico con fallback SEGURO: si un lote toca tablas de comanda pero no podemos
// identificar el `ID_Comanda` (p. ej. un DELETE de línea por `ID_Detalle`), marcamos
// `uncertain` y el consumidor recarga por seguridad (comportamiento de antes). Si el lote NO
// toca ninguna tabla de comanda (p. ej. alta de producto/categoría), el ticket no se recarga.

export type ComandaSyncInfo = {
	/** Comandas afectadas que hemos podido identificar por su ID_Comanda. */
	ids: string[];
	/** El lote tocó alguna tabla relacionada con comandas. */
	touchedComanda: boolean;
	/** Tocó comanda pero no pudimos identificar el id → recargar por seguridad. */
	uncertain: boolean;
	/** El lote tocó alguna tabla de catálogo (productos/categorías/stock). */
	touchedCatalog: boolean;
};

export type RawStatement = { sql?: unknown; args?: unknown };

// Tablas cuyo cambio puede afectar al contenido de un ticket de comanda.
const COMANDA_TABLES =
	/\b(Comandas|Detalle_Comanda|Pagos|Pago_Detalles)\b/i;

// Tablas cuyo cambio puede afectar al catálogo del POS (grid de categorías/productos + stock).
const CATALOG_TABLES =
	/\b(Categorias_Producto|Productos|Lotes_Producto|Lote_Consumos|Alergenos|Producto_Alergenos)\b/i;

// `ID_Comanda = ?N` en cláusulas WHERE/SET (placeholders numerados que usan los repos).
const RE_WHERE_ID = /ID_Comanda\s*=\s*\?(\d+)/gi;

// `INSERT [OR ...] INTO <tabla> ( <columnas> )` — para localizar la posición de ID_Comanda.
const RE_INSERT_COLS = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]*)\)/i;
const RE_INSERT_COMANDAS = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+Comandas\b/i;

function toId(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s ? s : null;
}

/** Comandas afectadas por un conjunto de sentencias resueltas (sql + args en orden). */
export function affectedComandas(statements: RawStatement[]): ComandaSyncInfo {
	const ids = new Set<string>();
	let touchedComanda = false;
	let touchedCatalog = false;
	let uncertain = false;

	for (const st of statements ?? []) {
		const sql = String(st?.sql ?? "");
		const args = Array.isArray(st?.args) ? (st.args as unknown[]) : [];

		if (CATALOG_TABLES.test(sql)) touchedCatalog = true;

		if (!COMANDA_TABLES.test(sql)) continue;
		touchedComanda = true;

		let found = false;

		// WHERE/SET: ID_Comanda = ?N  →  args[N-1]
		RE_WHERE_ID.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = RE_WHERE_ID.exec(sql)) !== null) {
			const v = toId(args[Number(m[1]) - 1]);
			if (v) {
				ids.add(v);
				found = true;
			}
		}

		// INSERT: la posición de ID_Comanda en la lista de columnas mapea a args[posición]
		// (los repos generan los VALUES con placeholders en el mismo orden que las columnas).
		const mi = RE_INSERT_COLS.exec(sql);
		if (mi) {
			const cols = mi[1]
				.split(",")
				.map((c) => c.trim().replace(/["'`\[\]]/g, ""));
			const ci = cols.findIndex((c) => /^ID_Comanda$/i.test(c));
			if (ci >= 0) {
				const v = toId(args[ci]);
				if (v) {
					ids.add(v);
					found = true;
				}
			}
		}

		// Tocó comanda pero no pudimos sacar el id. No marcamos incertidumbre cuando es un
		// alta de comanda nueva (INSERT INTO Comandas con UUID generado en cliente): esa comanda
		// no puede ser la que ya está abierta en el POS.
		if (!found && !RE_INSERT_COMANDAS.test(sql)) {
			uncertain = true;
		}
	}

	return { ids: Array.from(ids), touchedComanda, uncertain, touchedCatalog };
}

// ── SYNC-06: invalidación selectiva de React Query ─────────────────────────────────────────────
// En cada `change` los hooks invalidaban TODAS las queries montadas. Aquí derivamos, de la tabla
// que toca cada sentencia, las CLAVES de feature afectadas, para invalidar solo esas. Fallback
// SEGURO: si una sentencia toca una tabla no mapeada (o no la sabemos parsear), devolvemos `null`
// → el hook cae a invalidación global (nunca dejamos datos rancios por un mapeo incompleto).
//
// El mapeo es GENEROSO a propósito (sobre-incluir una feature solo cuesta un refetch de algo
// montado; INFRA-incluir dejaría esa feature obsoleta). `stats` aparece en varias porque su vista
// lee casi todo; solo está montada dentro de Estadísticas.
const TABLE_TO_FEATURES: Record<string, readonly string[]> = {
	comandas: ["mesas", "stats"],
	detalle_comanda: ["mesas", "stats"],
	pagos: ["cuentas", "stats"],
	pago_detalles: ["cuentas", "stats"],
	devolucion_lineas: ["cuentas"],
	cuentas_gastos: ["cuentas", "stats"],
	categorias_producto: ["inventario", "stats"],
	productos: ["inventario", "stats"],
	lotes_producto: ["inventario", "stats"],
	lote_consumos: ["inventario", "stats"],
	alergenos: ["inventario"],
	producto_alergenos: ["inventario"],
	proveedores: ["proveedores", "inventario", "cuentas", "pedidos_proveedor", "stats"],
	pedidos_proveedor: ["pedidos_proveedor", "inventario"],
	lineas_pedido_proveedor: ["pedidos_proveedor", "inventario"],
	zonas: ["mesas"],
	mesas: ["mesas"],
	clientes: ["clientes", "reservas", "stats"],
	reservas: ["reservas", "stats"],
	tareas: ["tareas"],
	tarea_asignaciones: ["tareas"],
	trabajadores: ["trabajadores", "tareas", "stats"],
	turnos: ["trabajadores"],
	asignacion_turnos: ["trabajadores"],
	horario_predeterminado: ["trabajadores"],
	fichajes: ["trabajadores"],
	fichaje_dia: ["trabajadores"],
	usuarios: ["trabajadores"],
	roles: ["trabajadores"],
	notificaciones: ["notificaciones"],
	notificacion_lecturas: ["notificaciones"],
	// Ajustes: viven en stores Zustand (no en React Query), así que no invalidan ninguna clave de
	// caché. Lo que sí hace falta es que sus stores se recarguen — ver `tocaAjustes` más abajo.
	business_settings: [],
	ticket_settings: [],
	contact_settings: [],
};

// Tabla destino de una escritura (INSERT/REPLACE/UPDATE/DELETE). `null` si no la reconocemos.
function targetTable(sql: string): string | null {
	const s = sql.trim();
	const m =
		/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`[]?(\w+)/i.exec(s) ??
		/^REPLACE\s+INTO\s+["'`[]?(\w+)/i.exec(s) ??
		/^UPDATE\s+["'`[]?(\w+)/i.exec(s) ??
		/^DELETE\s+FROM\s+["'`[]?(\w+)/i.exec(s);
	return m ? m[1].toLowerCase() : null;
}

/**
 * Claves de feature de React Query afectadas por un lote de sentencias resueltas.
 *  - Devuelve la lista de claves a invalidar (p. ej. `["cuentas", "stats"]`).
 *  - Devuelve `null` si alguna sentencia toca una tabla no mapeada o no parseable → el consumidor
 *    debe invalidar TODO (fallback seguro).
 */
export function affectedFeatureKeys(statements: RawStatement[]): string[] | null {
	const keys = new Set<string>();
	for (const st of statements ?? []) {
		const sql = String(st?.sql ?? "");
		if (!sql.trim()) continue;
		const table = targetTable(sql);
		if (table === null) return null; // forma no reconocida → global
		const feats = TABLE_TO_FEATURES[table];
		if (feats === undefined) return null; // tabla no mapeada → global
		for (const f of feats) keys.add(f);
	}
	return Array.from(keys);
}

/** Tablas de ajustes: no están en React Query, sus stores se leen una vez al arrancar. */
const TABLAS_DE_AJUSTES = new Set([
	"business_settings",
	"ticket_settings",
	"contact_settings",
]);

/**
 * ¿El lote toca los ajustes del negocio/ticket/contacto?
 *
 * Estos ajustes NO viven en React Query, sino en stores de Zustand que se cargan una vez al
 * arrancar. Sin esto, cambiar el ancho de papel o el pie del ticket desde otro dispositivo no se
 * notaba en esta Main hasta reiniciarla — y peor: seguía IMPRIMIENDO con los ajustes viejos.
 */
export function tocaAjustes(statements: RawStatement[]): boolean {
	for (const st of statements ?? []) {
		const sql = String(st?.sql ?? "");
		if (!sql.trim()) continue;
		const table = targetTable(sql);
		if (table && TABLAS_DE_AJUSTES.has(table)) return true;
	}
	return false;
}

/**
 * ¿Hay que recargar el ticket de la comanda `activeId` ante este lote?
 *  - Sí, si el lote afecta explícitamente a esa comanda.
 *  - Sí, si es incierto (tocó comanda pero no identificamos el id) → seguro.
 *  - No, si no tocó comandas o solo tocó OTRAS comandas identificadas.
 */
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
