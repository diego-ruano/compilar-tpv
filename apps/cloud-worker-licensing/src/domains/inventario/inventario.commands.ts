// src/domains/inventario/inventario.commands.ts
//
// ESCRITURAS de inventario expresadas como comandos para el motor del DO
// (`tenantDb.transaction` / `tenantDb.exec`). El SQL es el mismo que el de la app
// local (tpv-infra-sqlite/inventario.rs). El DO los ejecuta en transacción, con
// idempotencia por Op_Id, y hace broadcast del cambio al confirmar.
//
// Patrón de ID: como la app usa `MAX(id)+1` explícito (no AUTOINCREMENT), aquí se
// calcula igual con un paso `value` + `$ref`, para que el ID quede en el resultado
// y viaje en el broadcast (la Main lo aplica con ese mismo ID).

import type { ApplyCommand } from "../../lib/hub";
import type {
	UpsertCategoriaInput,
	UpsertProductoInput,
	SetAlergenosInput,
	CreateLoteInput,
	UpdateLoteInput,
	AjusteLoteInput,
} from "./inventario.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID = { $ref: "id" } as const;

function cleanOrNull(s: unknown): string | null {
	const t = (s ?? "").toString().trim();
	return t.length ? t : null;
}

function numOrNull(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function idOrNull(v: unknown): string | null {
	const s = (v ?? "").toString().trim();
	return s.length ? s : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => (s ?? "").toString().trim()).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

const SQL_UPSERT_PRODUCTO = `
	INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent)
	VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
	ON CONFLICT(ID_Producto) DO UPDATE SET
		ID_Categoria = excluded.ID_Categoria,
		ID_Proveedor = excluded.ID_Proveedor,
		Nombre = excluded.Nombre,
		Precio_Venta = excluded.Precio_Venta,
		Stock_Minimo = excluded.Stock_Minimo,
		Unidad_Medida = excluded.Unidad_Medida,
		Nombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen),
		Ruta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen),
		Cantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada,
		Stock_Suelto = excluded.Stock_Suelto,
		IVA_Percent = excluded.IVA_Percent;
`;

const SQL_UPSERT_CATEGORIA = `
	INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina)
	VALUES (?1, ?2, ?3, ?4, ?5, ?6)
	ON CONFLICT(ID_Categoria) DO UPDATE SET
		Nombre = excluded.Nombre,
		Nombre_Imagen = excluded.Nombre_Imagen,
		Ruta_Imagen = excluded.Ruta_Imagen,
		Vendible = excluded.Vendible,
		Pasa_Cocina = excluded.Pasa_Cocina;
`;

// Alta PURA (INV-02): un create con un ID_Lote existente es un no-op idempotente, nunca pisa
// Stock_Disponible (que descuadraría con Lote_Consumos). La edición usa updateLote / ajustarLote.
const SQL_INSERT_LOTE = `
	INSERT INTO Lotes_Producto
		(ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
	VALUES
		(?1, ?2, ?3, COALESCE(NULLIF(?4, ''), datetime('now','localtime')), NULLIF(?5, ''), ?6, ?7, ?8, ?9)
	ON CONFLICT(ID_Lote) DO NOTHING;
`;

// Auditoría de stock (INV-01b): cada alta/ajuste deja un movimiento trazable. Fecha canónica
// (la congela resolveNowLiterals del worker antes de replicar).
const SQL_INSERT_MOVIMIENTO = `
	INSERT INTO Movimientos_Stock
		(ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
	VALUES
		(?1, ?2, ?3, ?4, ?5, ?6, NULL, datetime('now','localtime'));
`;

// UUIDv7: el id lo genera el cliente y lo envía. Si faltara, generamos uno aquí.
// Queda en `id` para que viaje en el broadcast y la Main lo aplique con el mismo id.
function idStep(provided?: string) {
	const id = (provided ?? "").trim() || crypto.randomUUID();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

export function createCategoria(input: UpsertCategoriaInput): BuiltCommand {
	const steps: any[] = [
		idStep(input.id_categoria),
		{
			kind: "execute",
			sql: SQL_UPSERT_CATEGORIA,
			args: [
				REF_ID,
				input.nombre.trim(),
				(input.nombre_imagen ?? "").trim(),
				(input.ruta_imagen ?? "").trim(),
				input.vendible ? 1 : 0,
				input.pasa_cocina ? 1 : 0,
			],
		},
	];
	return {
		commandName: "inventario_create_categoria",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: input,
	};
}

export function upsertProducto(input: UpsertProductoInput): BuiltCommand {
	const steps: any[] = [
		idStep(input.id_producto),
		{
			kind: "execute",
			sql: SQL_UPSERT_PRODUCTO,
			args: [
				REF_ID,
				input.id_categoria,
				idOrNull(input.id_proveedor),
				input.nombre.trim(),
				numOrNull(input.precio_venta),
				numOrNull(input.stock_minimo),
				cleanOrNull(input.unidad_medida),
				cleanOrNull(input.nombre_imagen),
				cleanOrNull(input.ruta_imagen),
				numOrNull(input.cantidad_pedido_esperada),
				numOrNull(input.stock_suelto),
				numOrNull(input.iva_percent),
			],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
			args: [REF_ID],
		},
		...normalizeIds(input.ids_alergenos).map((idA) => ({
			kind: "execute",
			sql: "INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES (?1, ?2);",
			args: [REF_ID, idA],
		})),
	];
	return {
		commandName: "inventario_upsert_producto",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: input,
	};
}

export function deleteProducto(idProducto: string): BuiltCommand {
	const steps = [
		// DB-03: todo lo que la FK haría sola se hace A MANO. Soltar el enlace de las ventas va
		// primero (la línea conserva su snapshot y no pierde nada, INV-05); los movimientos, antes
		// que los lotes por su FK.
		"UPDATE Detalle_Comanda SET ID_Producto = NULL WHERE ID_Producto=?1;",
		"DELETE FROM Movimientos_Stock WHERE ID_Lote IN (SELECT ID_Lote FROM Lotes_Producto WHERE ID_Producto=?1);",
		"DELETE FROM Lotes_Producto WHERE ID_Producto=?1;",
		"DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
		"DELETE FROM Productos WHERE ID_Producto=?1;",
	].map((sql) => ({ kind: "execute", sql, args: [idProducto] }));

	return {
		commandName: "inventario_delete_producto",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_producto: idProducto },
	};
}

export function setAlergenosProducto(
	idProducto: string,
	input: SetAlergenosInput,
): BuiltCommand {
	const ids = normalizeIds(input.ids_alergenos);
	const steps: any[] = [
		{
			kind: "execute",
			sql: "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
			args: [idProducto],
		},
		...ids.map((idA) => ({
			kind: "execute",
			sql: "INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES (?1, ?2);",
			args: [idProducto, idA],
		})),
	];
	return {
		commandName: "inventario_set_alergenos_producto",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_producto: idProducto, ids_alergenos: ids },
	};
}

export function createLote(input: CreateLoteInput): BuiltCommand {
	const stock = input.stock_disponible;
	const movId = crypto.randomUUID();

	const steps: any[] = [
		idStep(input.id_lote),
		{
			kind: "execute",
			sql: SQL_INSERT_LOTE,
			args: [
				REF_ID,
				input.id_producto,
				input.codigo_lote.trim(),
				cleanOrNull(input.fecha_entrada),
				cleanOrNull(input.caducidad),
				stock,
				numOrNull(input.coste_unitario),
				idOrNull(input.id_proveedor),
				cleanOrNull(input.notas),
			],
		},
		// Auditoría: el alta entra como movimiento 'ALTA' con delta = stock inicial.
		{
			kind: "execute",
			sql: SQL_INSERT_MOVIMIENTO,
			args: [movId, REF_ID, "ALTA", stock, stock, cleanOrNull(input.notas)],
		},
	];
	return {
		commandName: "inventario_create_lote",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: input,
	};
}

// `stockActual` = Stock_Disponible previo (lo lee la ruta antes de aplicar), para el delta de
// auditoría: editar un lote puede cambiar el disponible, y eso es un movimiento de stock como
// cualquier otro. Sin anotarlo, la reconciliación (INV-06) no distinguiría una edición legítima de
// un descuadre real.
export function updateLote(
	idLote: string,
	input: UpdateLoteInput,
	stockActual: number,
): BuiltCommand {
	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				UPDATE Lotes_Producto SET
					ID_Producto = ?2,
					Codigo_Lote = ?3,
					Fecha_Entrada = COALESCE(NULLIF(?4, ''), Fecha_Entrada),
					Caducidad = NULLIF(?5, ''),
					Stock_Disponible = ?6,
					Coste_Unitario = ?7,
					ID_Proveedor = ?8,
					Notas = ?9
				WHERE ID_Lote = ?1;
			`,
			args: [
				idLote,
				input.id_producto,
				input.codigo_lote.trim(),
				cleanOrNull(input.fecha_entrada),
				cleanOrNull(input.caducidad),
				input.stock_disponible,
				numOrNull(input.coste_unitario),
				idOrNull(input.id_proveedor),
				cleanOrNull(input.notas),
			],
		},
	];

	// Solo si cambió el disponible: renombrar el lote o cambiarle el proveedor no mueve stock.
	if (Math.abs(input.stock_disponible - stockActual) > 1e-9) {
		steps.push({
			kind: "execute",
			sql: SQL_INSERT_MOVIMIENTO,
			args: [
				crypto.randomUUID(),
				idLote,
				"AJUSTE",
				input.stock_disponible - stockActual,
				input.stock_disponible,
				"Edición del lote",
			],
		});
	}

	return {
		commandName: "inventario_update_lote",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { ...input, id_lote: idLote },
	};
}

// `stockActual` = Stock_Disponible previo (lo lee la ruta antes de aplicar), para el delta de auditoría.
export function ajustarLote(
	idLote: string,
	input: AjusteLoteInput,
	stockActual: number,
): BuiltCommand {
	const movId = crypto.randomUUID();
	const steps: any[] = [
		{
			kind: "execute",
			sql: "UPDATE Lotes_Producto SET Stock_Disponible = ?1, Notas = COALESCE(NULLIF(?2, ''), Notas) WHERE ID_Lote = ?3;",
			args: [input.stock_disponible, cleanOrNull(input.notas), idLote],
		},
		// Auditoría: el ajuste queda como movimiento 'AJUSTE' con su delta (nuevo - anterior).
		{
			kind: "execute",
			sql: SQL_INSERT_MOVIMIENTO,
			args: [
				movId,
				idLote,
				"AJUSTE",
				input.stock_disponible - stockActual,
				input.stock_disponible,
				cleanOrNull(input.notas),
			],
		},
	];
	return {
		commandName: "inventario_ajustar_lote",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_lote: idLote, ...input },
	};
}
