// src/domains/clientes/clientes.schemas.ts

import * as z from "zod";

import { MSG_TEXTO_DEMASIADO_LARGO, cabeEnTextoLibre, recortar } from "../../lib/texto";
import {
	MAX_DIRECCION_FISCAL,
	MAX_RAZON_SOCIAL,
	MSG_NIF_NO_VALIDO,
	nifValido,
	normalizarNif,
	sanearTexto,
} from "../../lib/fiscal";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	CreateClienteInput as ContractCreateClienteInput,
	UpdateClienteInput as ContractUpdateClienteInput,
} from "@tpv/contracts";

const idStr = z.string().overwrite(recortar).min(1);

function cleanOptional(v: unknown): string | null {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
}

const optStr = z.string().nullish().transform(cleanOptional);

/**
 * Lo que no cabe en UNA dirección: espacios (Unicode, como `char::is_whitespace`), caracteres de
 * control (`char::is_control`), y lo que separa una lista (`,` `;`), abre un nombre (`<` `>`), un
 * comentario (`(` `)`), una IP (`[` `]`), una cita (`"` `\`) o un grupo (`:`).
 */
const NO_CABE_EN_UNA_DIRECCION = /[\p{White_Space}\p{Cc},;<>()[\]":\\]/u;

/**
 * Un correo, y uno solo (AUD-39): entre 6 y 254 caracteres, una única `@` con algo delante y un
 * dominio con un punto que no lo empieza ni lo acaba, y nada de `NO_CABE_EN_UNA_DIRECCION`. La
 * dirección va al `to` de los correos: una lista o un salto de línea serían varios destinatarios o
 * una cabecera más. Admite lo legítimo: `+`, subdominios, mayúsculas, letras no ASCII y dominios
 * internacionales. La misma regla que `validate_email_basic` en Rust (que la Main usa al revalidar);
 * los casos, en `crates/tpv-domain/src/validacion_casos.json`. No es `z.email()`: ése sólo admite ASCII.
 */
export function isValidEmail(email: string): boolean {
	const e = recortar(email);
	const largo = [...e].length;
	if (largo < 6 || largo > 254 || NO_CABE_EN_UNA_DIRECCION.test(e)) return false;
	const arroba = e.indexOf("@");
	if (arroba <= 0 || e.indexOf("@", arroba + 1) !== -1) return false;
	const dominio = e.slice(arroba + 1);
	return dominio.includes(".") && !dominio.startsWith(".") && !dominio.endsWith(".");
}

// Email opcional (CLI-04): vacío/ausente => null; si hay valor se normaliza a minúsculas
// (unicidad case-insensitive) y debe tener formato de email válido.
const optEmail = z
	.string()
	.nullish()
	.transform((v) => {
		const t = recortar((v ?? "").toString()).toLowerCase();
		return t.length ? t : null;
	})
	.refine((v) => v === null || isValidEmail(v), { message: "El correo no es válido." });

// AUD-36: con un máximo, como en la Main.
const notas = optStr.refine(cabeEnTextoLibre, MSG_TEXTO_DEMASIADO_LARGO);

// FISCAL-02: los datos para facturarle, normalizados como el destinatario de la factura
// (`DatosFiscales::validar` en la Main). Vacío => null; un NIF con algo tiene que pasar el control.
//
// Una clave que NO VIENE se queda `undefined`, que no es lo mismo que `null` (vacío): la Handy de la
// versión anterior no conoce estos campos y no los manda, y al editar una ficha no puede borrarle
// los datos fiscales que le puso la Main. El comando no toca la columna de una clave que no viene
// (`clientes.commands.ts`). La Handy de ahora manda siempre las tres, `null` si están vacías.
const nif = z
	.string()
	.nullish()
	.transform((v) => {
		if (v === undefined) return undefined;
		const n = normalizarNif((v ?? "").toString());
		return n.length ? n : null;
	})
	.refine((v) => v == null || nifValido(v), { message: MSG_NIF_NO_VALIDO });

function saneado(max: number) {
	return z
		.string()
		.nullish()
		.transform((v) => {
			if (v === undefined) return undefined;
			const t = sanearTexto((v ?? "").toString(), max);
			return t.length ? t : null;
		});
}

export const createClienteSchema = z.object({
	// ID autogenerado por el backend: el cliente HTTP lo envía como `null` cuando no lo
	// conoce. Lo aceptamos y lo normalizamos a `undefined` (compat con @tpv/contracts).
	id_cliente: idStr.nullish().transform((v) => (v == null ? undefined : v)),
	nombre: z.string().overwrite(recortar).min(1, "Escribe el nombre del cliente."),
	email: optEmail,
	telefono: optStr,
	notas: notas,
	nif: nif,
	razon_social: saneado(MAX_RAZON_SOCIAL),
	direccion_fiscal: saneado(MAX_DIRECCION_FISCAL),
});

export const updateClienteSchema = z.object({
	nombre: z.string().overwrite(recortar).min(1, "Escribe el nombre del cliente."),
	email: optEmail,
	telefono: optStr,
	notas: notas,
	nif: nif,
	razon_social: saneado(MAX_RAZON_SOCIAL),
	direccion_fiscal: saneado(MAX_DIRECCION_FISCAL),
});

type NullableClienteFields = "email" | "telefono" | "notas" | "nif" | "razon_social" | "direccion_fiscal";

export type CreateClienteInput = Omit<
	ContractCreateClienteInput,
	NullableClienteFields
> & {
	[K in NullableClienteFields]?: ContractCreateClienteInput[K] | null;
};

export type UpdateClienteInput = Omit<
	ContractUpdateClienteInput,
	"id_cliente" | NullableClienteFields
> & {
	[K in NullableClienteFields]?: ContractUpdateClienteInput[K] | null;
};

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GCreateCliente = Assert<SameKeys<z.infer<typeof createClienteSchema>, CreateClienteInput>>;
type _GUpdateCliente = Assert<SameKeys<z.infer<typeof updateClienteSchema>, UpdateClienteInput>>;
