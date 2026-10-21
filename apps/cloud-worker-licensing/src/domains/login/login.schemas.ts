// src/domains/login/login.schemas.ts

import * as z from "zod";

import { recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	LoginUserArgs,
	PunchInput as ContractPunchInput,
	SetTurnoPartidoInput as ContractSetTurnoPartidoInput,
	SolicitarCodigoPinInput,
	SolicitarCambioCorreoInput,
	ConfirmarCambioCorreoInput,
} from "@tpv/contracts";

const idStr = z.string().overwrite(recortar).min(1);

function cleanOptional(v: unknown): string | null {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
}

export const loginUserSchema = z.object({
	id_usuario: idStr,
	pin: z.string().overwrite(recortar).min(1, "pin required"),
});

export const setTurnoPartidoSchema = z.object({
	id_usuario: idStr,
	turno_partido: z.boolean(),
	fecha: z.string().nullish().transform(cleanOptional),
});

// Subida del setup inicial desde la Main (modo TPV) a la nube. No verifica pin_actual: la
// Main ya lo hizo en local y la petición va firmada como dispositivo TPV (la autoriza el
// device-proof + el chequeo de rol). El `pin` viaja para hashearlo aquí (como complete-setup).
export const syncInitialSetupSchema = z.object({
	id_usuario: idStr,
	email: z.string().overwrite(recortar).email("email invalid"),
	pin: z.string().overwrite(recortar).min(4, "PIN demasiado corto"),
});

// LOGIN-07: recuperar el PIN de un administrador. El PIN nuevo NO viaja: la nube sólo dice si el
// código vale y el PIN lo guarda la Main. Por eso `verificar` no tiene contrapartida exacta en Rust
// (el DTO de la Main lleva además `pin_nuevo`) y no lleva drift-guard; `solicitar` sí.
export const solicitarCodigoPinSchema = z.object({
	id_usuario: idStr,
});

export const verificarCodigoPinSchema = z.object({
	id_usuario: idStr,
	codigo: z.string().overwrite(recortar).min(1, "codigo required"),
});

// LOGIN-08: el correo de recuperación. Aquí sólo que llegue algo; la forma del correo la valida
// `correoRecuperacion.ts`, con un mensaje que se pueda enseñar.
export const solicitarCambioCorreoSchema = z.object({
	correo: z.string().overwrite(recortar).min(1, "correo required"),
});

export const confirmarCambioCorreoSchema = z.object({
	codigo: z.string().overwrite(recortar).min(1, "codigo required"),
});

// El fichaje no lleva fecha ni hora: las pone el equipo que ficha (TRAB-02, con CFG-04/REV-03).
// Las llevó, y ninguna de las dos implementaciones las leía. Un TPV viejo que aún las mande no se
// rompe contra esto: el schema no es `strict`, así que zod las descarta sin quejarse.
export const punchSchema = z.object({
	id_usuario: idStr,
	pin: z.string().overwrite(recortar).min(1, "pin required"),
	tipo: z.enum(["entrada", "salida"]),
});

export type LoginUserInput = LoginUserArgs;

export type SetTurnoPartidoInput = Omit<
	ContractSetTurnoPartidoInput,
	"fecha"
> & {
	fecha?: string | null;
};

export type PunchInput = ContractPunchInput;

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GLoginUser = Assert<SameKeys<z.infer<typeof loginUserSchema>, LoginUserInput>>;
type _GSetTurnoPartido = Assert<SameKeys<z.infer<typeof setTurnoPartidoSchema>, SetTurnoPartidoInput>>;
type _GPunch = Assert<SameKeys<z.infer<typeof punchSchema>, PunchInput>>;
type _GSolicitarCodigoPin = Assert<SameKeys<z.infer<typeof solicitarCodigoPinSchema>, SolicitarCodigoPinInput>>;
type _GSolicitarCambioCorreo = Assert<SameKeys<z.infer<typeof solicitarCambioCorreoSchema>, SolicitarCambioCorreoInput>>;
type _GConfirmarCambioCorreo = Assert<SameKeys<z.infer<typeof confirmarCambioCorreoSchema>, ConfirmarCambioCorreoInput>>;
