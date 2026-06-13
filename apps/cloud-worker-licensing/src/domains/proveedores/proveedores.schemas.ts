// src/domains/proveedores/proveedores.schemas.ts

import { z } from "zod";
import type {
	ProveedorSaveInput as ContractProveedorSaveInput,
	ProveedoresCreateProductoInput,
	ProveedoresSetVinculosInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);
const optNum = z.number().finite().min(0).nullish();

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => (s ?? "").toString().trim()).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

const optStr = z.string().nullish().transform(cleanOptional);

export const proveedorSaveSchema = z.object({
	id_proveedor: idStr.optional().nullish(),
	nombre_empresa: z.string().trim().min(1, "nombre_empresa required"),
	contacto: optStr,
	telefono: optStr,
	email: optStr,
	cif: optStr,
	informacion_adicional: optStr,
	nombre_imagen: optStr,
	ruta_imagen: optStr,
});

export const setVinculosSchema = z.object({
	producto_ids: z.array(z.string()).default([]).transform(normalizeIds),
});

export const createProductoSchema = z.object({
	id_producto: idStr.optional().nullish(),
	id_categoria: idStr,
	id_proveedor: idStr,
	nombre: z.string().trim().min(1, "nombre required"),
	precio_venta: optNum,
	stock_actual: optNum,
	stock_minimo: optNum,
	unidad_medida: optStr,
});

type NullableProveedorFields =
	| "contacto"
	| "telefono"
	| "email"
	| "cif"
	| "informacion_adicional"
	| "nombre_imagen"
	| "ruta_imagen";

export type ProveedorSaveInput = Omit<
	ContractProveedorSaveInput,
	"id_proveedor" | NullableProveedorFields
> & {
	id_proveedor?: string | null;
} & {
	[K in NullableProveedorFields]?: ContractProveedorSaveInput[K] | null;
};

export type SetVinculosInput = Omit<ProveedoresSetVinculosInput, "id_proveedor">;

export type CreateProductoInput = Omit<
	ProveedoresCreateProductoInput,
	"id_producto" | "precio_venta" | "stock_actual" | "stock_minimo" | "unidad_medida"
> & {
	id_producto?: string | null;
	precio_venta?: number | null;
	stock_actual?: number | null;
	stock_minimo?: number | null;
	unidad_medida?: string | null;
};
