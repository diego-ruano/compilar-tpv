// src/domains/inventario/inventario.schemas.ts
//
// Validación de entrada (zod) de las escrituras de inventario. Replica las reglas
// del dominio Rust (tpv-domain/inventario.rs): nombre/código requeridos, ids > 0,
// cantidades finitas y no negativas. La normalización fina (trim→null, dedup de
// ids, default de stock) la hace el constructor de comandos.

import * as z from "zod";
import { zDineroNoNegativoCon } from "../../lib/dinero";
import { diaDeInstante, esFechaYmd } from "../../lib/fechas";
import { zIva } from "../../lib/iva";

import { recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	AjusteLoteInput as ContractAjusteLoteInput,
	AjusteStockSueltoInput as ContractAjusteStockSueltoInput,
	CreateLoteInput as ContractCreateLoteInput,
	UpdateLoteInput as ContractUpdateLoteInput,
	UpsertCategoriaInput as ContractUpsertCategoriaInput,
	UpsertProductoInput as ContractUpsertProductoInput,
} from "@tpv/contracts";

const optNum = z.number().finite().nullish();
const optStr = z.string().nullish();
const idStr = z.string().overwrite(recortar).min(1);
/** Un id que tiene que venir y, si no, lo que dice la Main (VALID-03). */
const idCon = (mensaje: string) => z.string().overwrite(recortar).min(1, mensaje);
const idList = z.array(z.string().overwrite(recortar).min(1)).default([]);

// UUIDv7: el id lo genera el cliente y lo envía. Si lo envía `null` (no lo conoce),
// lo normalizamos a `undefined` para no romper los tipos de @tpv/contracts (string | undefined).
const optId = idStr.nullish().transform((v) => (v == null ? undefined : v));

// AUD-17: un precio de venta negativo entraba por aquí desde una Handy y, cobrado en mesa, era una
// salida de caja con el arqueo cuadrado. Cero (una invitación) y sin precio valen; el coste de un
// lote, igual. Los mismos textos que en la Main (`tpv-domain/src/inventario.rs`).
const MSG_PRECIO_NEGATIVO = "El precio no puede ser negativo.";
const MSG_COSTE_NEGATIVO = "El coste unitario no puede ser negativo.";
const precioOpcional = zDineroNoNegativoCon(MSG_PRECIO_NEGATIVO).nullish();
const costeOpcional = zDineroNoNegativoCon(MSG_COSTE_NEGATIVO).nullish();

export const upsertCategoriaSchema = z.object({
	id_categoria: optId,
	nombre: z.string().overwrite(recortar).min(1, "Escribe el nombre de la categoría."),
	nombre_imagen: z.string().default(""),
	ruta_imagen: z.string().default(""),
	vendible: z.boolean(),
	pasa_cocina: z.boolean(),
});

export const upsertProductoSchema = z.object({
	id_producto: optId,
	id_categoria: idCon("Elige la categoría del producto."),
	id_proveedor: idStr.nullish(),
	nombre: z.string().overwrite(recortar).min(1, "Escribe el nombre del producto."),
	precio_venta: precioOpcional,
	stock_minimo: optNum,
	unidad_medida: optStr,
	nombre_imagen: optStr,
	ruta_imagen: optStr,
	cantidad_pedido_esperada: optNum,
	stock_suelto: optNum,
	// RI-78: ausente o `null` es «el del negocio»; fuera de 0–100 se rechaza, como en la Main.
	iva_percent: zIva.nullish(),
	ids_alergenos: idList,
});

// Los mismos textos que en la Main (`tpv-domain/src/inventario.rs`).
const MSG_CADUCIDAD_INVALIDA = "Caducidad con formato inválido (se espera YYYY-MM-DD)";
const MSG_ENTRADA_INVALIDA = "La fecha de entrada no tiene un formato válido.";
const MSG_CADUCIDAD_ANTERIOR = "La caducidad no puede ser anterior a la fecha de entrada";

/**
 * INV-03 / RI-78: las fechas de un lote, espejo de `LoteNuevo::validar`. La caducidad es una fecha
 * sola y la entrada una fecha o un instante completo; las dos reales, y la caducidad no anterior a
 * la entrada. Aquí entraba cualquier texto, y lo que SQLite no entiende como fecha es `NULL` en el
 * `ORDER BY date(Caducidad)` del FEFO: ese lote se ponía delante de todos.
 *
 * Se miran recortadas, que es como las guarda el comando (`cleanOrNull`).
 */
function fechasDeLote(
	v: { caducidad?: string | null; fecha_entrada?: string | null },
	ctx: z.RefinementCtx,
) {
	const caducidad = recortar(v.caducidad ?? "");
	const entrada = recortar(v.fecha_entrada ?? "");
	const caducidadOk = !caducidad || esFechaYmd(caducidad);
	const diaEntrada = entrada ? diaDeInstante(entrada) : null;

	if (!caducidadOk) {
		ctx.addIssue({ code: "custom", path: ["caducidad"], message: MSG_CADUCIDAD_INVALIDA });
	}
	if (entrada && diaEntrada === null) {
		ctx.addIssue({ code: "custom", path: ["fecha_entrada"], message: MSG_ENTRADA_INVALIDA });
	}
	// Dos fechas `YYYY-MM-DD` se ordenan como texto.
	if (caducidad && caducidadOk && diaEntrada !== null && caducidad < diaEntrada) {
		ctx.addIssue({ code: "custom", path: ["caducidad"], message: MSG_CADUCIDAD_ANTERIOR });
	}
}

// RI-28: contexto del adaptador Rust; la sesión personal del Worker está aplazada.
export const autorStockSchema = z.string().overwrite(recortar).min(1);

// Los campos del DTO, sin las reglas entre campos: es lo que compara el drift-guard de abajo.
const createLoteCampos = z.object({
	id_lote: optId,
	id_producto: idCon("Falta el producto."),
	codigo_lote: z.string().overwrite(recortar).min(1, "Escribe el código del lote."),
	caducidad: optStr,
	stock_disponible: z.number().finite().min(0, "Cantidad inválida"),
	fecha_entrada: optStr,
	coste_unitario: costeOpcional,
	id_proveedor: idStr.nullish(),
	notas: optStr,
});

// El cuerpo entero de la ruta, autor incluido: un schema con reglas entre campos ya no se puede
// ampliar con `.extend()` sin perderlas, así que se compone aquí y no en la ruta.
export const createLoteSchema = createLoteCampos
	.extend({ id_usuario: autorStockSchema })
	.superRefine(fechasDeLote);

const updateLoteCampos = z.object({
	id_lote: idCon("Falta el lote."),
	id_producto: idCon("Falta el producto."),
	codigo_lote: z.string().overwrite(recortar).min(1, "Escribe el código del lote."),
	caducidad: optStr,
	fecha_entrada: optStr,
	coste_unitario: costeOpcional,
	id_proveedor: idStr.nullish(),
	notas: optStr,
});

export const updateLoteSchema = updateLoteCampos.superRefine(fechasDeLote);

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
type _GCreateLote = Assert<SameKeys<z.infer<typeof createLoteCampos>, CreateLoteInput>>;
type _GUpdateLote = Assert<SameKeys<z.infer<typeof updateLoteCampos>, UpdateLoteInput>>;
type _GAjusteLote = Assert<SameKeys<z.infer<typeof ajusteLoteSchema>, AjusteLoteInput>>;
type _GAjusteSuelto = Assert<SameKeys<z.infer<typeof ajusteStockSueltoSchema>, AjusteStockSueltoInput>>;
