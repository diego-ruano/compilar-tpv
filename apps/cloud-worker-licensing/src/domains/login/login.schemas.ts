// src/domains/login/login.schemas.ts

import { z } from "zod";
import type {
	CompleteInitialSetupInput,
	LoginUserArgs,
	PunchInput as ContractPunchInput,
	SetTurnoPartidoInput as ContractSetTurnoPartidoInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

export const loginUserSchema = z.object({
	id_usuario: idStr,
	pin: z.string().trim().min(1, "pin required"),
});

export const setTurnoPartidoSchema = z.object({
	id_usuario: idStr,
	turno_partido: z.boolean(),
	fecha: z.string().nullish().transform(cleanOptional),
});

export const completeInitialSetupSchema = z.object({
	id_usuario: idStr,
	pin_actual: z.string().trim().min(1, "pin_actual required"),
	pin_nuevo: z.string().trim().min(4, "PIN demasiado corto"),
	email_nuevo: z.string().trim().email("email invalid"),
});

// Subida del setup inicial desde la Main (modo TPV) a la nube. No verifica pin_actual: la
// Main ya lo hizo en local y la petición va firmada como dispositivo TPV (la autoriza el
// device-proof + el chequeo de rol). El `pin` viaja para hashearlo aquí (como complete-setup).
export const syncInitialSetupSchema = z.object({
	id_usuario: idStr,
	email: z.string().trim().email("email invalid"),
	pin: z.string().trim().min(4, "PIN demasiado corto"),
});

export const punchSchema = z.object({
	id_usuario: idStr,
	pin: z.string().trim().min(1, "pin required"),
	tipo: z.enum(["entrada", "salida"]),
	fecha: z.string().nullish().transform(cleanOptional),
	hora_evento: z.string().nullish().transform(cleanOptional),
});

export type LoginUserInput = LoginUserArgs;

export type SetTurnoPartidoInput = Omit<
	ContractSetTurnoPartidoInput,
	"fecha"
> & {
	fecha?: string | null;
};

export type { CompleteInitialSetupInput };

export type PunchInput = Omit<
	ContractPunchInput,
	"fecha" | "hora_evento"
> & {
	fecha?: string | null;
	hora_evento?: string | null;
};
