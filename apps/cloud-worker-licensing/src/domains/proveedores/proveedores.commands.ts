// src/domains/proveedores/proveedores.commands.ts

import { nuevoId } from "../../lib/ids";
import { recortar } from "../../lib/texto";
import type { ApplyCommand } from "../../lib/hub";
import type {
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
	const t = recortar((s ?? "").toString());
	return t.length ? t : null;
}

function numOrNull(v: unknown): number | null {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => recortar((s ?? "").toString())).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

// UUIDv7: el id lo genera el cliente y lo envía; si faltara, generamos uno.
function idStep(provided?: string | null) {
	const id = recortar(provided ?? "") || nuevoId();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

export function guardarProveedor(input: ProveedorSaveInput): BuiltCommand {
	const cloudPayload = {
		id_proveedor: input.id_proveedor ?? null,
		nombre_empresa: recortar(input.nombre_empresa),
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
		// DB-03: el ON DELETE SET NULL se escribe EXPLICITAMENTE, mismo criterio que Rust. En la
		// nube la FK también lo haría (Turso trae las FK activadas, RI-06), pero así el lote dice
		// lo que hace sin depender de leer el esquema.
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

