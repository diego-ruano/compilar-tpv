// src/domains/notificaciones/notificaciones.schemas.ts
//
// Validación de entrada de notificaciones. Replica las reglas del dominio Rust
// (tpv-domain/src/notificaciones.rs): tipo/titulo requeridos, destino coherente,
// textos opcionales trim -> null.

import { z } from "zod";

const optStr = z.string().nullish().transform((v) => {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
});

export const crearNotificacionSchema = z
	.object({
		tipo: z.string().trim().min(1, "tipo required"),
		severidad: z.string().trim().optional(),
		titulo: z.string().trim().min(1, "titulo required"),
		cuerpo: optStr,
		destino_tipo: z.enum(["todos", "usuario", "rol"]),
		destino_valor: optStr,
		accion: optStr,
		payload: optStr,
		clave_dedupe: optStr,
		expira_en: optStr,
	})
	.refine((d) => d.destino_tipo === "todos" || !!d.destino_valor, {
		message: "destino_valor requerido para usuario/rol",
		path: ["destino_valor"],
	});

export const marcarLeidaSchema = z.object({
	id_usuario: z.string().trim().min(1),
});

export const marcarTodasSchema = z.object({
	id_usuario: z.string().trim().min(1),
});

export const resolverSchema = z.object({
	clave_dedupe: z.string().trim().min(1),
});

export type CrearNotificacionBody = z.infer<typeof crearNotificacionSchema>;
