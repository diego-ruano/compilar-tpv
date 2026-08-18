// src/domains/proveedores/proveedores.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type {
	CreateProductoInput,
	ProveedorSaveInput,
	SetVinculosInput,
} from "./proveedores.schemas";

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

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => (s ?? "").toString().trim()).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

// UUIDv7: el id lo genera el cliente y lo envía; si faltara, generamos uno.
function idStep(provided?: string | null) {
	const id = (provided ?? "").trim() || crypto.randomUUID();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

export function guardarProveedor(input: ProveedorSaveInput): BuiltCommand {
	const cloudPayload = {
		id_proveedor: input.id_proveedor ?? null,
		nombre_empresa: input.nombre_empresa.trim(),
		contacto: cleanOrNull(input.contacto),
		telefono: cleanOrNull(input.telefono),
		email: cleanOrNull(input.email),
		cif: cleanOrNull(input.cif),
		informacion_adicional: cleanOrNull(input.informacion_adicional),
		nombre_imagen: cleanOrNull(input.nombre_imagen),
		ruta_imagen: cleanOrNull(input.ruta_imagen),
	};

	const steps = [
		idStep(cloudPayload.id_proveedor),
		{
			kind: "execute",
			sql: `
				INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Contacto, Telefono, Email, CIF, Informacion_adicional, Nombre_Imagen, Ruta_Imagen)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
				ON CONFLICT(ID_Proveedor) DO UPDATE SET
					Nombre_Empresa = excluded.Nombre_Empresa,
					Contacto = excluded.Contacto,
					Telefono = excluded.Telefono,
					Email = excluded.Email,
					CIF = excluded.CIF,
					Informacion_adicional = excluded.Informacion_adicional,
					Nombre_Imagen = excluded.Nombre_Imagen,
					Ruta_Imagen = excluded.Ruta_Imagen;
			`,
			args: [
				REF_ID,
				cloudPayload.nombre_empresa,
				cloudPayload.contacto,
				cloudPayload.telefono,
				cloudPayload.email,
				cloudPayload.cif,
				cloudPayload.informacion_adicional,
				cloudPayload.nombre_imagen,
				cloudPayload.ruta_imagen,
			],
		},
	];

	return {
		commandName: "proveedores_save",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload,
	};
}

export function eliminarProveedor(idProveedor: string): BuiltCommand {
	const steps = [
		{
			kind: "execute",
			sql: "UPDATE Lotes_Producto SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
			args: [idProveedor],
		},
		{
			kind: "execute",
			sql: "UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
			args: [idProveedor],
		},
		// DB-03: replicar EXPLICITAMENTE el ON DELETE SET NULL (no dependemos de la FK del motor en
		// la nube, donde foreign_keys puede no estar activo en el batch). Mismo criterio que Rust.
		{
			kind: "execute",
			sql: "UPDATE Pedidos_Proveedor SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
			args: [idProveedor],
		},
		{
			kind: "execute",
			sql: "UPDATE Cuentas_Gastos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
			args: [idProveedor],
		},
		{
			kind: "execute",
			saveAs: "deleted",
			sql: "DELETE FROM Proveedores WHERE ID_Proveedor = ?1;",
			args: [idProveedor],
		},
	];
	return {
		commandName: "proveedores_delete",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "deleted" } },
		cloudPayload: { id_proveedor: idProveedor },
	};
}

export function setVinculos(idProveedor: string, input: SetVinculosInput): BuiltCommand {
	const productoIds = normalizeIds(input.producto_ids);
	const steps: any[] = [
		{
			kind: "execute",
			sql: "UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
			args: [idProveedor],
		},
		...productoIds.map((idProducto) => ({
			kind: "execute",
			sql: "UPDATE Productos SET ID_Proveedor = ?1 WHERE ID_Producto = ?2;",
			args: [idProveedor, idProducto],
		})),
	];
	return {
		commandName: "proveedores_set_vinculos",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_proveedor: idProveedor, producto_ids: productoIds },
	};
}

export function crearProducto(input: CreateProductoInput): BuiltCommand {
	const stock = numOrNull(input.stock_actual);
	const cloudPayload = {
		id_producto: input.id_producto ?? null,
		id_categoria: input.id_categoria,
		id_proveedor: input.id_proveedor,
		nombre: input.nombre.trim(),
		precio_venta: numOrNull(input.precio_venta),
		stock_actual: stock,
		stock_minimo: numOrNull(input.stock_minimo),
		unidad_medida: cleanOrNull(input.unidad_medida),
	};

	const steps: any[] = [
		idStep(cloudPayload.id_producto),
		{
			kind: "execute",
			sql: `
				INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL)
				ON CONFLICT(ID_Producto) DO UPDATE SET
					ID_Categoria = excluded.ID_Categoria,
					ID_Proveedor = excluded.ID_Proveedor,
					Nombre = excluded.Nombre,
					Precio_Venta = excluded.Precio_Venta,
					Stock_Minimo = excluded.Stock_Minimo,
					Unidad_Medida = excluded.Unidad_Medida;
			`,
			args: [
				REF_ID,
				cloudPayload.id_categoria,
				cloudPayload.id_proveedor,
				cloudPayload.nombre,
				cloudPayload.precio_venta,
				cloudPayload.stock_minimo,
				cloudPayload.unidad_medida,
			],
		},
	];

	if (stock != null && stock > 0) {
		const idLoteInicial = crypto.randomUUID();
		steps.push({
			kind: "execute",
			sql: `
				INSERT OR IGNORE INTO Lotes_Producto
					(ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
				VALUES
					(?1, ?2, ?3, datetime('now','localtime'), NULL, ?4, ?5, NULL, ?6, ?7);
			`,
			args: [
				idLoteInicial,
				REF_ID,
				{ $ref: "codigo_lote" },
				stock,
				stock,
				cloudPayload.id_proveedor,
				"Lote inicial creado desde Proveedores",
			],
		});

		// Auditoría (INV-01b): la entrada de stock deja su movimiento, igual que el alta desde
		// Inventario. Es el origen contra el que la reconciliación (INV-06) cuadra el lote.
		// El INSERT de arriba es OR IGNORE, así que el movimiento se condiciona a que el lote
		// exista con ESTE id (si ya había uno con el mismo producto+código, no se anota nada).
		steps.push({
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Stock
					(ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
				SELECT ?1, ?2, 'ALTA', ?3, ?3, ?4, NULL, datetime('now','localtime')
				WHERE EXISTS (SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?2);
			`,
			args: [
				crypto.randomUUID(),
				idLoteInicial,
				stock,
				"Lote inicial creado desde Proveedores",
			],
		});
	}

	if (stock != null && stock > 0) {
		steps.splice(2, 0, {
			kind: "value",
			saveAs: "codigo_lote",
			sql: "SELECT 'INI-' || ?1;",
			args: [REF_ID],
		});
	}

	return {
		commandName: "proveedores_create_producto",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload,
	};
}
