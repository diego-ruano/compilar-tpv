// src/domains/inventario/consumo.ts
//
// El consumo de stock de un cobro, en un solo sitio (RI-10). Espejo de
// `crates/tpv-infra-sqlite/src/consumo_stock.rs`: lotes por FEFO, lo que no cubren al stock suelto
// (VR-04) y la traza de las dos partes por cobro (STOCK-01). Antes el cobro de mesa sólo miraba
// lotes, y además releía el stock de cada línea sin descontar lo ya asignado, así que dos líneas
// del mismo producto podían tomar dos veces del mismo lote.
//
// Se planifica aquí, leyendo, y el builder del comando emite cada paso con sus literales: la
// sentencia que se replica hace lo mismo en las dos bases. Todo va redondeado a milésimas (RI-26),
// con `redondearCantidad` aquí y `ROUND(…, 3)` en el SQL, igual que en la Main.

import type { Base } from "../../lib/sql";
import { redondearCantidad } from "../../lib/cantidad";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

/** Lo que se toma de un lote para una línea. */
export type TomaDeLote = { id_lote: string; take: number; id_detalle: string };

/** Lo que, tras agotar los lotes, se descuenta del stock suelto del producto para una línea. */
export type TomaSuelta = { id_producto: string; take: number; id_detalle: string };

export type PlanConsumo = { lotes: TomaDeLote[]; suelto: TomaSuelta[] };

/** Una línea cobrada. */
export type LineaConsumo = { id_detalle: string; id_producto: string; cantidad: number };

/**
 * Reparto FEFO con el estado de los lotes EN MEMORIA: se descuenta al asignar, para que varias
 * líneas del mismo producto consuman en cascada y no vuelvan a tomar lo ya asignado. Nunca toma de
 * un lote más de lo que tiene; lo que no cubren va al suelto (que sí puede quedar negativo). No
 * bloquea por falta de stock (VR-04).
 */
export async function planConsumo(db: Base, lineas: LineaConsumo[]): Promise<PlanConsumo> {
	const lotesPorProducto = new Map<string, { id_lote: string; stock: number }[]>();
	const lotesDe = async (idProducto: string) => {
		let l = lotesPorProducto.get(idProducto);
		if (!l) {
			l = await lotesConStock(db, idProducto);
			lotesPorProducto.set(idProducto, l);
		}
		return l;
	};

	const plan: PlanConsumo = { lotes: [], suelto: [] };
	for (const linea of lineas) {
		let restante = redondearCantidad(linea.cantidad);
		for (const lote of await lotesDe(linea.id_producto)) {
			if (restante <= 0) break;
			const take = redondearCantidad(Math.min(restante, lote.stock));
			if (take <= 0) continue;
			plan.lotes.push({ id_lote: lote.id_lote, take, id_detalle: linea.id_detalle });
			lote.stock = redondearCantidad(lote.stock - take);
			restante = redondearCantidad(restante - take);
		}
		if (restante > 0) {
			plan.suelto.push({ id_producto: linea.id_producto, take: restante, id_detalle: linea.id_detalle });
		}
	}
	return plan;
}

async function lotesConStock(db: Base, idProducto: string) {
	const rs = await db.execute({
		sql: `
			SELECT
				ID_Lote AS id_lote,
				COALESCE(Stock_Disponible,0) AS stock
			FROM Lotes_Producto
			WHERE ID_Producto = ?1
				AND ROUND(COALESCE(Stock_Disponible,0), 3) > 0
			ORDER BY
				CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
				date(Caducidad) ASC,
				datetime(Fecha_Entrada) ASC,
				ID_Lote ASC;
		`,
		args: [idProducto],
	});
	return rows(rs)
		.map((r) => ({ id_lote: String(r.id_lote ?? ""), stock: redondearCantidad(Number(r.stock ?? 0)) }))
		.filter((l) => l.id_lote.length > 0 && l.stock > 0);
}

/**
 * Los pasos del comando que aplican un plan. Van DESPUÉS del `INSERT` del pago: las trazas llevan su
 * FK a `Pagos`. `idPago` es el literal o la referencia al paso que lo generó.
 */
export function pasosConsumo(plan: PlanConsumo, idPago: unknown): any[] {
	const pasos: any[] = [];
	for (const t of plan.lotes) {
		pasos.push({
			kind: "execute",
			// VR-06: descuento RELATIVO sin clamp. Un clamp a 0 se dispararía en una copia y no en
			// la otra según su stock local; aplicando el mismo delta a secas, las dos convergen. Dos
			// cobros a la vez sobre el mismo lote sí pueden dejarlo negativo al replicarse: es la
			// señal de sobreventa, se admite a propósito y el job `stock_negativo` avisa.
			sql: `
				UPDATE Lotes_Producto
				SET Stock_Disponible = ROUND(COALESCE(Stock_Disponible,0) - ?2, 3)
				WHERE ID_Lote = ?1;
			`,
			args: [t.id_lote, t.take],
		});
		pasos.push({
			kind: "execute",
			sql: `
				INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad)
				VALUES (?1, ?2, ?3, ?4)
				ON CONFLICT(ID_Detalle, ID_Lote, ID_Pago) DO NOTHING;
			`,
			args: [t.id_detalle, t.id_lote, idPago, t.take],
		});
	}
	for (const s of plan.suelto) {
		pasos.push({
			kind: "execute",
			sql: `
				UPDATE Productos
				SET Stock_Suelto = ROUND(Stock_Suelto - ?2, 3)
				WHERE ID_Producto = ?1 AND Stock_Suelto IS NOT NULL;
			`,
			args: [s.id_producto, s.take],
		});
		// El EXISTS repite la condición del UPDATE de arriba para no apuntar un consumo que no llegó
		// a producirse: devolverlo al anular sería inventar stock.
		pasos.push({
			kind: "execute",
			sql: `
				INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, ID_Pago, Cantidad)
				SELECT ?1, ?2, ?3, ?4
				WHERE EXISTS (
					SELECT 1 FROM Productos
					WHERE ID_Producto = ?2 AND Stock_Suelto IS NOT NULL
				)
				ON CONFLICT(ID_Detalle, ID_Producto, ID_Pago) DO NOTHING;
			`,
			args: [s.id_detalle, s.id_producto, idPago, s.take],
		});
	}
	return pasos;
}
