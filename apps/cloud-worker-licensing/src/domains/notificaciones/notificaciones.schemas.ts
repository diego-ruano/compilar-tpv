// src/domains/notificaciones/notificaciones.schemas.ts
//
// Validación de entrada de notificaciones. Replica las reglas del dominio Rust
// (tpv-domain/src/notificaciones.rs): tipo/titulo requeridos, destino coherente,
// textos opcionales trim -> null.

import * as z from "zod";

import type { CrearNotificacionInput as ContractCrearNotificacionInput } from "@tpv/contracts";
import { recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";

const optStr = z.string().nullish().transform((v) => {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
});

export const crearNotificacionSchema = z
	.object({
		tipo: z.string().overwrite(recortar).min(1, "Falta el tipo de aviso."),
		severidad: z.string().overwrite(recortar).optional(),
		titulo: z.string().overwrite(recortar).min(1, "Escribe el título del aviso."),
		cuerpo: optStr,
		destino_tipo: z.enum(["todos", "usuario", "rol"]),
		destino_valor: optStr,
		accion: optStr,
		payload: optStr,
		clave_dedupe: optStr,
		expira_en: optStr,
	})
	.refine((d) => d.destino_tipo === "todos" || !!d.destino_valor, {
		message: "Elige a quién va el aviso.",
		path: ["destino_valor"],
	});

export const marcarLeidaSchema = z.object({
	id_usuario: z.string().overwrite(recortar).min(1),
});

export const marcarTodasSchema = z.object({
	id_usuario: z.string().overwrite(recortar).min(1),
});

export const resolverSchema = z.object({
	clave_dedupe: z.string().overwrite(recortar).min(1),
});

export type CrearNotificacionBody = z.infer<typeof crearNotificacionSchema>;

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GCrearNotificacion = Assert<SameKeys<z.infer<typeof crearNotificacionSchema>, ContractCrearNotificacionInput>>;
