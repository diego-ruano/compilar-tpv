// src/domains/proveedores/proveedores.schemas.ts

import { z } from "zod";

const posInt = z.number().int().positive();
const optNum = z.number().finite().min(0).nullish();

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

function normalizeIds(ids: number[]): number[] {
	const set = new Set(
		(ids ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0).map(Math.trunc),
	);
	return Array.from(set).sort((a, b) => a - b);
}

const optStr = z.string().nullish().transform(cleanOptional);

export const proveedorSaveSchema = z.object({
	id_proveedor: posInt.optional().nullish(),
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
	producto_ids: z.array(z.number()).default([]).transform(normalizeIds),
});

export const createProductoSchema = z.object({
	id_producto: posInt.optional().nullish(),
	id_categoria: posInt,
	id_proveedor: posInt,
	nombre: z.string().trim().min(1, "nombre required"),
	precio_venta: optNum,
	stock_actual: optNum,
	stock_minimo: optNum,
	unidad_medida: optStr,
});

export type ProveedorSaveInput = z.infer<typeof proveedorSaveSchema>;
export type SetVinculosInput = z.infer<typeof setVinculosSchema>;
export type CreateProductoInput = z.infer<typeof createProductoSchema>;
