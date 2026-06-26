// src/domains/inventario/inventario.schemas.ts
//
// Validación de entrada (zod) de las escrituras de inventario. Replica las reglas
// del dominio Rust (tpv-domain/inventario.rs): nombre/código requeridos, ids > 0,
// cantidades finitas y no negativas. La normalización fina (trim→null, dedup de
// ids, default de stock) la hace el constructor de comandos.

import { z } from "zod";
import type {
	AjusteLoteInput as ContractAjusteLoteInput,
	CreateLoteInput as ContractCreateLoteInput,
	SetProductoAlergenosInput,
	UpdateLoteInput as ContractUpdateLoteInput,
	UpsertCategoriaInput as ContractUpsertCategoriaInput,
	UpsertProductoInput as ContractUpsertProductoInput,
} from "@tpv/contracts";

const optNum = z.number().finite().nullish();
const optStr = z.string().nullish();
const idStr = z.string().trim().min(1);
const idList = z.array(z.string().trim().min(1)).default([]);

// UUIDv7: el id lo genera el cliente y lo envía. Si lo envía `null` (no lo conoce),
// lo normalizamos a `undefined` para no romper los tipos de @tpv/contracts (string | undefined).
const optId = idStr.nullish().transform((v) => (v == null ? undefined : v));

export const upsertCategoriaSchema = z.object({
	id_categoria: optId,
	nombre: z.string().trim().min(1, "nombre required"),
	nombre_imagen: z.string().default(""),
	ruta_imagen: z.string().default(""),
	vendible: z.boolean(),
	pasa_cocina: z.boolean(),
});

export const upsertProductoSchema = z.object({
	id_producto: optId,
	id_categoria: idStr,
	id_proveedor: idStr.nullish(),
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
	id_lote: optId,
	id_producto: idStr,
	codigo_lote: z.string().trim().min(1, "codigo_lote required"),
	caducidad: optStr,
	cantidad_inicial: z.number().finite().min(0, "Cantidad_Inicial inválida"),
	stock_disponible: z.number().finite().min(0).nullish(),
	fecha_entrada: optStr,
	coste_unitario: optNum,
	id_proveedor: idStr.nullish(),
	notas: optStr,
});

export const updateLoteSchema = z.object({
	id_lote: idStr,
	id_producto: idStr,
	codigo_lote: z.string().trim().min(1, "codigo_lote required"),
	caducidad: optStr,
	cantidad_inicial: z.number().finite().min(0, "Cantidad_Inicial inválida"),
	stock_disponible: z.number().finite().min(0, "Stock_Disponible inválido"),
	fecha_entrada: optStr,
	coste_unitario: optNum,
	id_proveedor: idStr.nullish(),
	notas: optStr,
});

export const ajusteLoteSchema = z.object({
	stock_disponible: z.number().finite().min(0, "Stock_Disponible inválido"),
	notas: optStr,
});

export type UpsertCategoriaInput = ContractUpsertCategoriaInput;

export type UpsertProductoInput = Omit<
	ContractUpsertProductoInput,
	| "id_proveedor"
	| "precio_venta"
	| "stock_minimo"
	| "unidad_medida"
	| "nombre_imagen"
	| "ruta_imagen"
	| "cantidad_pedido_esperada"
> & {
	id_proveedor?: string | null;
	precio_venta?: number | null;
	stock_minimo?: number | null;
	unidad_medida?: string | null;
	nombre_imagen?: string | null;
	ruta_imagen?: string | null;
	cantidad_pedido_esperada?: number | null;
};

export type SetAlergenosInput = Omit<SetProductoAlergenosInput, "id_producto">;

export type CreateLoteInput = Omit<
	ContractCreateLoteInput,
	| "caducidad"
	| "stock_disponible"
	| "fecha_entrada"
	| "coste_unitario"
	| "id_proveedor"
	| "notas"
> & {
	caducidad?: string | null;
	stock_disponible?: number | null;
	fecha_entrada?: string | null;
	coste_unitario?: number | null;
	id_proveedor?: string | null;
	notas?: string | null;
};

export type UpdateLoteInput = Omit<
	ContractUpdateLoteInput,
	"caducidad" | "fecha_entrada" | "coste_unitario" | "id_proveedor" | "notas"
> & {
	caducidad?: string | null;
	fecha_entrada?: string | null;
	coste_unitario?: number | null;
	id_proveedor?: string | null;
	notas?: string | null;
};

export type AjusteLoteInput = Omit<ContractAjusteLoteInput, "id_lote" | "notas"> & {
	notas?: string | null;
};
