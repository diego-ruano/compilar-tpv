// src/domains/login/login.schemas.ts

import { z } from "zod";

const posInt = z.number().int().positive();

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

export const loginUserSchema = z.object({
	id_usuario: posInt,
	pin: z.string().trim().min(1, "pin required"),
});

export const setTurnoPartidoSchema = z.object({
	id_usuario: posInt,
	turno_partido: z.boolean(),
	fecha: z.string().nullish().transform(cleanOptional),
});

export const completeInitialSetupSchema = z.object({
	id_usuario: posInt,
	pin_actual: z.string().trim().min(1, "pin_actual required"),
	pin_nuevo: z.string().trim().min(4, "PIN demasiado corto"),
	email_nuevo: z.string().trim().email("email invalid"),
});

export const punchSchema = z.object({
	id_usuario: posInt,
	pin: z.string().trim().min(1, "pin required"),
	tipo: z.enum(["entrada", "salida"]),
	fecha: z.string().nullish().transform(cleanOptional),
	hora_evento: z.string().nullish().transform(cleanOptional),
});

export type LoginUserInput = z.infer<typeof loginUserSchema>;
export type SetTurnoPartidoInput = z.infer<typeof setTurnoPartidoSchema>;
export type CompleteInitialSetupInput = z.infer<typeof completeInitialSetupSchema>;
export type PunchInput = z.infer<typeof punchSchema>;
