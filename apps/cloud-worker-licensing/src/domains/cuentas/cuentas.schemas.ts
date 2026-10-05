// src/domains/cuentas/cuentas.schemas.ts

import { z } from "zod";

import { zDineroNoNegativo } from "../../lib/dinero";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	AnularPagoInput as ContractAnularPagoInput,
	CreateGastoInput as ContractCreateGastoInput,
	UpdateGastoInput as ContractUpdateGastoInput,
	UpdatePagoInput as ContractUpdatePagoInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);
/** Un importe de la API: centimos enteros y no negativo (ARQ-01). */
const money = zDineroNoNegativo;

function clean(v: unknown): string {
	return String(v ?? "").trim();
}

function cleanOptional(v: unknown): string | null {
	const t = clean(v);
	return t.length ? t : null;
}

export const createGastoSchema = z.object({
	id_gasto: idStr.optional().nullish(),
	fecha: z.string().transform(clean).refine(Boolean, "fecha required"),
	tipo_gasto: z.string().transform(clean).refine(Boolean, "tipo_gasto required"),
	concepto: z.string().transform(clean).refine(Boolean, "concepto required"),
	importe: money,
	proveedor_id: idStr.optional().nullish(),
	// CAJA-01: el gasto se pagó con dinero del cajón. Ausente = no.
	pagado_con_caja: z.boolean().nullish().transform((v) => v ?? false),
});

export const updateGastoSchema = createGastoSchema.omit({ id_gasto: true });

export const updatePagoSchema = z.object({
	fecha_hora: z.string().transform(clean).refine(Boolean, "fecha_hora required"),
	metodo: z.string().transform((v) => (v.trim() === "Tarjeta" ? "Tarjeta" : "Efectivo")),
	importe: money,
});

// Anular un cobro (CUENTA-07). El motivo es OBLIGATORIO: quién y cuándo los pone el sistema, el
// porqué sólo puede ponerlo quien anula.
//
// `id_usuario` viaja en el cuerpo aquí y NO en el input de Tauri, y no es una incoherencia: en la
// Main la sesión la conoce el backend (SEC-01) y aceptarla de la pantalla sería dejar firmar con el
// nombre de otro; el worker, en cambio, no tiene sesión de usuario —sólo tenant y dispositivo—, así
// que su cliente tiene que decírselo. Lo que impide el abuso aquí es otra cosa: esta ruta está
// vetada a todo lo que no sea la Main (`soloLaMainEscribeCaja`).
export const anularPagoSchema = z.object({
	id_usuario: idStr,
	motivo: z.string().transform(clean).refine(Boolean, "motivo required"),
	// FISCAL-01: cuál de los dos instrumentos legales se usa. Ausente = "ERROR", que es lo que
	// hacía el botón único antes de partirlo, así que un cliente antiguo sigue haciendo lo mismo.
	//
	// Un valor que no sea ninguno de los dos también cae en "ERROR" y no en un 400: la alternativa
	// sería que un cliente con una errata no pudiera anular un cobro, y lo conservador aquí es la
	// anulación (devuelve las líneas a la comanda, que es reversible).
	clase: z
		.enum(["ERROR", "DEVOLUCION"])
		.nullish()
		.transform((v) => v ?? "ERROR"),
});

export const rangoSchema = z.object({
	del: z.string().nullish().transform(cleanOptional),
	al: z.string().nullish().transform(cleanOptional),
});

const optInt = z
	.union([z.string(), z.number()])
	.nullish()
	.transform((v) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
	});

// Listado de caja con búsqueda de texto + paginación por clave (CUENTA-05, RI-18). El cursor viaja
// en dos parámetros planos; con uno solo no dice dónde empezar y es la primera página.
export const listadoSchema = z
	.object({
		del: z.string().nullish().transform(cleanOptional),
		al: z.string().nullish().transform(cleanOptional),
		q: z.string().nullish().transform(cleanOptional),
		page_size: optInt,
		cursor_fecha: z.string().nullish().transform(cleanOptional),
		cursor_id: z.string().nullish().transform(cleanOptional),
	})
	.transform(({ cursor_fecha, cursor_id, ...resto }) => ({
		...resto,
		cursor: cursor_fecha && cursor_id ? { fecha: cursor_fecha, id: cursor_id } : null,
	}));

export type CreateGastoInput = Omit<
	ContractCreateGastoInput,
	"id_gasto" | "proveedor_id"
> & {
	id_gasto?: string | null;
	proveedor_id?: string | null;
};

export type UpdateGastoInput = Omit<
	ContractUpdateGastoInput,
	"id_gasto" | "proveedor_id"
> & {
	proveedor_id?: string | null;
};

export type UpdatePagoInput = Omit<ContractUpdatePagoInput, "id_pago">;

export type AnularPagoInput = Omit<ContractAnularPagoInput, "id_pago" | "motivo"> & {
	id_usuario: string;
	motivo: string;
};

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GCreateGasto = Assert<SameKeys<z.infer<typeof createGastoSchema>, CreateGastoInput>>;
type _GUpdateGasto = Assert<SameKeys<z.infer<typeof updateGastoSchema>, UpdateGastoInput>>;
type _GUpdatePago = Assert<SameKeys<z.infer<typeof updatePagoSchema>, UpdatePagoInput>>;
type _GAnularPago = Assert<SameKeys<z.infer<typeof anularPagoSchema>, AnularPagoInput>>;
