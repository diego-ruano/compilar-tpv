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

import { redondearCantidad } from "../../lib/cantidad";
import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import type {
	UpsertCategoriaInput,
	UpsertProductoInput,
	SetAlergenosInput,
	CreateLoteInput,
	UpdateLoteInput,
	AjusteLoteInput,
	AjusteStockSueltoInput,
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

/** Una cantidad de stock opcional, redondeada a milésimas (RI-26). */
function cantidadONull(v: unknown): number | null {
	const n = numOrNull(v);
	return n === null ? null : redondearCantidad(n);
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
		IVA_Percent = excluded.IVA_Percent;
`;

// RI-70: la edición sin precios sólo opera sobre un producto existente en la transacción.
// Si se borró desde la lectura de la ruta, no se transforma en un alta con precio arbitrario.
const SQL_UPSERT_SIN_PRECIOS = SQL_UPSERT_PRODUCTO
    .replace("VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 WHERE EXISTS (SELECT 1 FROM Productos WHERE ID_Producto=?1)")
    .replace("Precio_Venta = excluded.Precio_Venta", "Precio_Venta = Productos.Precio_Venta")
    .replace("IVA_Percent = excluded.IVA_Percent", "IVA_Percent = Productos.IVA_Percent");

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
		(?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now','localtime'));
`;

// RI-55: el movimiento del stock suelto de un producto (sin lote).
const SQL_INSERT_MOVIMIENTO_PRODUCTO = `
	INSERT INTO Movimientos_Stock
		(ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
	VALUES
		(?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now','localtime'));
`;

// UUIDv7: el id lo genera el cliente y lo envía. Si faltara, generamos uno aquí.
// Queda en `id` para que viaje en el broadcast y la Main lo aplique con el mismo id.
function idStep(provided?: string | null) {
	const id = (provided ?? "").trim() || nuevoId();
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

// RI-55: el stock suelto sólo se escribe al CREAR el producto, con su movimiento de alta; editando
// la ficha se ignora (el formulario lo reescribía sin rastro). `esNuevo` lo decide la ruta leyendo.
// Se cambia con `ajustarStockSuelto`.
export function upsertProducto(input: UpsertProductoInput, esNuevo: boolean, idUsuario: string, conservarPrecio = false): BuiltCommand {
	const stockSuelto = esNuevo ? cantidadONull(input.stock_suelto) : null;
	const steps: any[] = [
		idStep(input.id_producto),
		{
			kind: "execute",
			// RI-70: al editar sin permiso de precios se conserva el valor dentro de la escritura.
            sql: conservarPrecio ? SQL_UPSERT_SIN_PRECIOS : SQL_UPSERT_PRODUCTO,
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
				stockSuelto,
				numOrNull(input.iva_percent),
			],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
			args: [REF_ID],
		},
		...(stockSuelto == null
			? []
			: [
					{
						kind: "execute",
						sql: SQL_INSERT_MOVIMIENTO_PRODUCTO,
						args: [nuevoId(), REF_ID, "ALTA", stockSuelto, stockSuelto, "Alta del producto", idUsuario],
					},
				]),
		...normalizeIds(input.ids_alergenos ?? []).map((idA) => ({
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

// INV-05 / RI-54: quitar un producto del catálogo. Se ARCHIVA si tiene historia (líneas de comanda,
// consumos de lote o de stock suelto) y se BORRA si no. Son exactamente las sentencias de
// `SQL_QUITAR_PRODUCTO` (tpv-infra-sqlite/src/inventario.rs): cada una lleva su condición —la primera
// archiva si hay historia, las demás sólo borran si no ha quedado archivado— y por eso no hace falta
// leer antes ni hay carrera con una venta que se cuele. DB-03: lo que haría la FK, a mano y en orden.
const SQL_QUITAR_PRODUCTO = [
	`UPDATE Productos SET Archivado_En = datetime('now','localtime')
		WHERE ID_Producto = ?1 AND Archivado_En IS NULL AND (
			EXISTS (SELECT 1 FROM Detalle_Comanda WHERE ID_Producto = ?1)
			OR EXISTS (SELECT 1 FROM Suelto_Consumos WHERE ID_Producto = ?1)
			OR EXISTS (SELECT 1 FROM Lote_Consumos lc JOIN Lotes_Producto l ON l.ID_Lote = lc.ID_Lote
				WHERE l.ID_Producto = ?1));`,
	`DELETE FROM Movimientos_Stock
		WHERE ID_Lote IN (SELECT ID_Lote FROM Lotes_Producto WHERE ID_Producto = ?1)
			AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL);`,
	`DELETE FROM Movimientos_Stock WHERE ID_Producto = ?1
		AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL);`,
	`DELETE FROM Lotes_Producto WHERE ID_Producto = ?1
		AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL);`,
	`DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1
		AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL);`,
	"DELETE FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NULL;",
];

export function deleteProducto(idProducto: string): BuiltCommand {
	const steps = SQL_QUITAR_PRODUCTO.map((sql) => ({ kind: "execute", sql, args: [idProducto] }));
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
	const ids = normalizeIds(input.ids_alergenos ?? []);
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

export function createLote(input: CreateLoteInput, idUsuario: string): BuiltCommand {
	// RI-26: toda cantidad de stock se guarda redondeada a milésimas, como en la Main.
	const stock = redondearCantidad(input.stock_disponible ?? 0);
	const movId = nuevoId();

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
			args: [movId, REF_ID, "ALTA", stock, stock, cleanOrNull(input.notas), idUsuario],
		},
	];
	return {
		commandName: "inventario_create_lote",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: input,
	};
}

// RI-55: los DATOS de un lote, sin tocar sus existencias. Antes se escribía el disponible que había
// cargado el formulario, y si mientras estaba abierto se vendía algo, guardar la caducidad devolvía
// el lote al valor viejo con un ajuste «Edición del lote» que lo justificaba. Las existencias se
// cambian con `ajustarLote`.
export function updateLote(idLote: string, input: UpdateLoteInput): BuiltCommand {
	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				UPDATE Lotes_Producto SET
					ID_Producto = ?2,
					Codigo_Lote = ?3,
					Fecha_Entrada = COALESCE(NULLIF(?4, ''), Fecha_Entrada),
					Caducidad = NULLIF(?5, ''),
					Coste_Unitario = ?6,
					ID_Proveedor = ?7,
					Notas = ?8
				WHERE ID_Lote = ?1;
			`,
			args: [
				idLote,
				input.id_producto,
				input.codigo_lote.trim(),
				cleanOrNull(input.fecha_entrada),
				cleanOrNull(input.caducidad),
				numOrNull(input.coste_unitario),
				idOrNull(input.id_proveedor),
				cleanOrNull(input.notas),
			],
		},
	];
	return {
		commandName: "inventario_update_lote",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { ...input, id_lote: idLote },
	};
}

/** `|stock - visto| < medio gramo` en SQL: la misma tolerancia que `stock_sin_cambios` de Rust. */
const SIGUE_COMO_SE_VIO = "ABS(COALESCE(Stock_Disponible,0) - ?2) < 0.0005";

// RI-55: ajuste de las existencias de un lote con lo que se vio. La ruta ya ha comprobado que lo
// visto es lo que hay, pero entre esa lectura y el DO puede colarse una venta: por eso el movimiento
// y el UPDATE llevan la misma condición, evaluada antes de cambiar nada, y si no se cumple no se
// aplica ninguno (`ajustado` = 0 filas, y la ruta contesta 409).
export function ajustarLote(idLote: string, input: AjusteLoteInput, idUsuario: string): BuiltCommand {
	const visto = redondearCantidad(input.stock_visto);
	const nuevo = redondearCantidad(input.stock_nuevo);
	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Stock
					(ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
				SELECT ?3, ?1, 'AJUSTE', ?4, ?5, ?6, ?7, datetime('now','localtime')
				WHERE EXISTS (
					SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?1 AND ${SIGUE_COMO_SE_VIO}
				);
			`,
			args: [
				idLote,
				visto,
				nuevoId(),
				redondearCantidad(nuevo - visto),
				nuevo,
				cleanOrNull(input.motivo) ?? "Ajuste manual",
				idUsuario,
			],
		},
		{
			kind: "execute",
			saveAs: "ajustado",
			sql: `UPDATE Lotes_Producto SET Stock_Disponible = ?3 WHERE ID_Lote = ?1 AND ${SIGUE_COMO_SE_VIO};`,
			args: [idLote, visto, nuevo],
		},
	];
	return {
		commandName: "inventario_ajustar_lote",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "ajustado" } },
		cloudPayload: { id_lote: idLote, ...input },
	};
}

// RI-55: lo mismo para el stock suelto de un producto. `null` es «no lleva stock suelto», así que la
// condición compara también eso; dejar de llevarlo es un movimiento que lo devuelve a cero.
export function ajustarStockSuelto(idProducto: string, input: AjusteStockSueltoInput, idUsuario: string): BuiltCommand {
	const visto = input.stock_visto == null ? null : redondearCantidad(input.stock_visto);
	const nuevo = input.stock_nuevo == null ? null : redondearCantidad(input.stock_nuevo);
	const comoSeVio =
		"((?2 IS NULL AND Stock_Suelto IS NULL) OR ABS(Stock_Suelto - ?2) < 0.0005)";
	const motivo =
		cleanOrNull(input.motivo) ?? (nuevo == null ? "Deja de llevar stock suelto" : "Ajuste manual");
	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Stock
					(ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
				SELECT ?3, ?1, 'AJUSTE', ?4, ?5, ?6, ?7, datetime('now','localtime')
				WHERE EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND ${comoSeVio});
			`,
			args: [
				idProducto,
				visto,
				nuevoId(),
				redondearCantidad((nuevo ?? 0) - (visto ?? 0)),
				nuevo ?? 0,
				motivo,
				idUsuario,
			],
		},
		{
			kind: "execute",
			saveAs: "ajustado",
			sql: `UPDATE Productos SET Stock_Suelto = ?3 WHERE ID_Producto = ?1 AND ${comoSeVio};`,
			args: [idProducto, visto, nuevo],
		},
	];
	return {
		commandName: "inventario_ajustar_stock_suelto",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "ajustado" } },
		cloudPayload: { id_producto: idProducto, ...input },
	};
}
