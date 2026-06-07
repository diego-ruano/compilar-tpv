// src/domains/inventario/inventario.schemas.ts
//
// Validación de entrada (zod) de las escrituras de inventario. Replica las reglas
// del dominio Rust (tpv-domain/inventario.rs): nombre/código requeridos, ids > 0,
// cantidades finitas y no negativas. La normalización fina (trim→null, dedup de
// ids, default de stock) la hace el constructor de comandos.

import { z } from "zod";

const optNum = z.number().finite().nullish();
const optStr = z.string().nullish();
const posInt = z.number().int().positive();
const idList = z.array(z.number()).default([]);

export const upsertCategoriaSchema = z.object({
	id_categoria: posInt.optional(),
	nombre: z.string().trim().min(1, "nombre required"),
	nombre_imagen: z.string().default(""),
	ruta_imagen: z.string().default(""),
	vendible: z.boolean(),
	pasa_cocina: z.boolean(),
});

export const upsertProductoSchema = z.object({
	id_producto: posInt.optional(),
	id_categoria: posInt,
	id_proveedor: posInt.nullish(),
	nombre: z.string().trim().min(1, "nombre required"),
	precio_venta: optNum,
	stock_minimo: optNum,
	unidad_medida: optStr,
	nombre_imagen: optStr,
	ruta_imagen: optStr,
	cantidad_pedido_esperada: optNum,
	ids_alergenos: idList,
});

export const setAlergenosSchema = z.object({
	ids_alergenos: idList,
});

export const createLoteSchema = z.object({
	id_lote: posInt.optional(),
	id_producto: posInt,
	codigo_lote: z.string().trim().min(1, "codigo_lote required"),
	caducidad: optStr,
	cantidad_inicial: z.number().finite().min(0, "Cantidad_Inicial inválida"),
	stock_disponible: z.number().finite().min(0).nullish(),
	fecha_entrada: optStr,
	coste_unitario: optNum,
	id_proveedor: posInt.nullish(),
	notas: optStr,
});

export const ajusteLoteSchema = z.object({
	stock_disponible: z.number().finite().min(0, "Stock_Disponible inválido"),
	notas: optStr,
});

export type UpsertCategoriaInput = z.infer<typeof upsertCategoriaSchema>;
export type UpsertProductoInput = z.infer<typeof upsertProductoSchema>;
export type SetAlergenosInput = z.infer<typeof setAlergenosSchema>;
export type CreateLoteInput = z.infer<typeof createLoteSchema>;
export type AjusteLoteInput = z.infer<typeof ajusteLoteSchema>;
