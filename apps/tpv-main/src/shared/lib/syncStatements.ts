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
	ids: number[];
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

function toPosInt(v: unknown): number | null {
	const n = typeof v === "bigint" ? Number(v) : Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** Comandas afectadas por un conjunto de sentencias resueltas (sql + args en orden). */
export function affectedComandas(statements: RawStatement[]): ComandaSyncInfo {
	const ids = new Set<number>();
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
			const v = toPosInt(args[Number(m[1]) - 1]);
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
				const v = toPosInt(args[ci]);
				if (v) {
					ids.add(v);
					found = true;
				}
			}
		}

		// Tocó comanda pero no pudimos sacar el id. No marcamos incertidumbre cuando es un
		// alta de comanda nueva (INSERT INTO Comandas con id autoincremental): esa comanda no
		// puede ser la que ya está abierta en el POS.
		if (!found && !RE_INSERT_COMANDAS.test(sql)) {
			uncertain = true;
		}
	}

	return { ids: Array.from(ids), touchedComanda, uncertain, touchedCatalog };
}

/**
 * ¿Hay que recargar el ticket de la comanda `activeId` ante este lote?
 *  - Sí, si el lote afecta explícitamente a esa comanda.
 *  - Sí, si es incierto (tocó comanda pero no identificamos el id) → seguro.
 *  - No, si no tocó comandas o solo tocó OTRAS comandas identificadas.
 */
export function shouldReloadTicket(
	info: ComandaSyncInfo,
	activeId: number | null | undefined,
): boolean {
	if (info.uncertain) return true;
	if (activeId == null || activeId <= 0) return false;
	return info.ids.includes(activeId);
}
