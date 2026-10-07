// src/domains/inventario/inventario.schemas.ts
//
// Validación de entrada (zod) de las escrituras de inventario. Replica las reglas
// del dominio Rust (tpv-domain/inventario.rs): nombre/código requeridos, ids > 0,
// cantidades finitas y no negativas. La normalización fina (trim→null, dedup de
// ids, default de stock) la hace el constructor de comandos.

import { z } from "zod";
import { zDineroOpcional } from "../../lib/dinero";

import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	AjusteLoteInput as ContractAjusteLoteInput,
	AjusteStockSueltoInput as ContractAjusteStockSueltoInput,
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
	precio_venta: zDineroOpcional,
	stock_minimo: optNum,
	unidad_medida: optStr,
	nombre_imagen: optStr,
	ruta_imagen: optStr,
	cantidad_pedido_esperada: optNum,
	stock_suelto: optNum,
	iva_percent: optNum,
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
	stock_disponible: z.number().finite().min(0, "Cantidad inválida"),
	fecha_entrada: optStr,
	coste_unitario: zDineroOpcional,
	id_proveedor: idStr.nullish(),
	notas: optStr,
});

export const updateLoteSchema = z.object({
	id_lote: idStr,
	id_producto: idStr,
	codigo_lote: z.string().trim().min(1, "codigo_lote required"),
	caducidad: optStr,
	fecha_entrada: optStr,
	coste_unitario: zDineroOpcional,
	id_proveedor: idStr.nullish(),
	notas: optStr,
});

// RI-55: lo que se vio y lo que hay. Lo visto puede ser negativo (una sobreventa); lo nuevo, no.
export const ajusteLoteSchema = z.object({
	stock_visto: z.number().finite(),
	stock_nuevo: z.number().finite().min(0, "La cantidad no puede ser negativa"),
	motivo: optStr,
});

// `null` es «no lleva stock suelto»: en lo nuevo lo desactiva, en lo visto dice que no lo llevaba.
export const ajusteStockSueltoSchema = z.object({
	stock_visto: optNum,
	stock_nuevo: z.number().finite().min(0, "La cantidad no puede ser negativa").nullish(),
	motivo: optStr,
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
	| "stock_suelto"
	| "iva_percent"
> & {
	id_proveedor?: string | null;
	precio_venta?: number | null;
	stock_minimo?: number | null;
	unidad_medida?: string | null;
	nombre_imagen?: string | null;
	ruta_imagen?: string | null;
	cantidad_pedido_esperada?: number | null;
	stock_suelto?: number | null;
	iva_percent?: number | null;
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

export type AjusteLoteInput = Omit<ContractAjusteLoteInput, "id_lote" | "motivo"> & {
	motivo?: string | null;
};

export type AjusteStockSueltoInput = Omit<
	ContractAjusteStockSueltoInput,
	"id_producto" | "stock_visto" | "stock_nuevo" | "motivo"
> & {
	stock_visto?: number | null;
	stock_nuevo?: number | null;
	motivo?: string | null;
};

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GUpsertCategoria = Assert<SameKeys<z.infer<typeof upsertCategoriaSchema>, UpsertCategoriaInput>>;
type _GUpsertProducto = Assert<SameKeys<z.infer<typeof upsertProductoSchema>, UpsertProductoInput>>;
type _GSetAlergenos = Assert<SameKeys<z.infer<typeof setAlergenosSchema>, SetAlergenosInput>>;
type _GCreateLote = Assert<SameKeys<z.infer<typeof createLoteSchema>, CreateLoteInput>>;
type _GUpdateLote = Assert<SameKeys<z.infer<typeof updateLoteSchema>, UpdateLoteInput>>;
type _GAjusteLote = Assert<SameKeys<z.infer<typeof ajusteLoteSchema>, AjusteLoteInput>>;
type _GAjusteSuelto = Assert<SameKeys<z.infer<typeof ajusteStockSueltoSchema>, AjusteStockSueltoInput>>;

// RI-28: contexto del adaptador Rust; la sesión personal del Worker está aplazada.
export const autorStockSchema = z.string().trim().min(1);
