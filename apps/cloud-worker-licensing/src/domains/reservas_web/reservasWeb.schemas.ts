// src/domains/reservas_web/reservasWeb.schemas.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): lo que entra por las rutas públicas.
//
// El alta acepta y rechaza lo mismo que `tpv_domain::reservas_web::AltaWebValidada`, que es con lo
// que la Main la vuelve a validar al registrarla, y normaliza igual: lo fija la tabla compartida
// `validacion_casos.json` (dominio `reserva_web`). Un criterio nuevo es un caso nuevo ahí.

import * as z from "zod";
import type { ReservaWebAltaInput } from "@tpv/contracts";

import { normalizarDia, zDia } from "../../lib/fechas";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import { isValidEmail } from "../clientes/clientes.schemas";
import { normalizeHora } from "../reservas/reservas.schemas";

/** Los mismos topes que `tpv_domain::reservas_web`. */
export const NOMBRE_MAX = 80;
export const NOTA_MAX = 200;
export const EMAIL_MAX = 254;
export const PERSONAS_MAX = 50;

/** Cuántos caracteres (no unidades UTF-16): la «ñ» cuenta uno, como en Rust. */
const largo = (s: string) => [...s].length;

/**
 * El teléfono sólo con sus cifras (y el `+` del prefijo internacional), o `null` si no lo parece.
 * Espejo de `tpv_domain::reservas_web::normalizar_telefono`.
 */
export function normalizarTelefono(raw: unknown): string | null {
	const t = String(raw ?? "").trim();
	const mas = t.startsWith("+") ? "+" : "";
	const resto = mas ? t.slice(1) : t;
	if (!/^[0-9 \-.()]*$/.test(resto)) return null;
	const cifras = resto.replace(/[^0-9]/g, "");
	return cifras.length >= 6 && cifras.length <= 15 ? `${mas}${cifras}` : null;
}

function horaHHMM(raw: unknown): string | null {
	try {
		return normalizeHora(raw);
	} catch {
		return null;
	}
}

export const altaReservaWebSchema = z
	.object({
		dia_ymd: z.any(),
		hora: z.any(),
		personas: z.any(),
		id_mesa: z.any(),
		nombre: z.any(),
		email: z.any(),
		telefono: z.any(),
		nota: z.any().optional().nullable(),
	})
	.transform((v, ctx) => {
		const fallo = (campo: string, message: string) =>
			ctx.addIssue({ code: "custom", path: [campo], message });

		const dia_ymd = normalizarDia(v.dia_ymd);
		if (!dia_ymd) fallo("dia_ymd", "Formato de día inválido. Esperado YYYY-MM-DD.");

		const hora = horaHHMM(v.hora);
		if (!hora) fallo("hora", "Hora inválida. Esperado HH:MM.");

		const personas = typeof v.personas === "number" && Number.isInteger(v.personas) ? v.personas : 0;
		if (personas < 1 || personas > PERSONAS_MAX) {
			fallo("personas", `El número de personas tiene que estar entre 1 y ${PERSONAS_MAX}`);
		}

		const id_mesa = String(v.id_mesa ?? "").trim();
		if (!id_mesa) fallo("id_mesa", "Elige una mesa");

		const nombre = String(v.nombre ?? "").trim();
		if (!nombre) fallo("nombre", "Escribe tu nombre");
		else if (largo(nombre) > NOMBRE_MAX) fallo("nombre", `El nombre no puede pasar de ${NOMBRE_MAX} caracteres`);

		const email = String(v.email ?? "").trim().toLowerCase();
		if (largo(email) > EMAIL_MAX || !isValidEmail(email)) fallo("email", "El correo no es válido");

		const telefono = normalizarTelefono(v.telefono);
		if (!telefono) fallo("telefono", "El teléfono no es válido");

		const notaLimpia = String(v.nota ?? "").trim();
		const nota = notaLimpia.length ? notaLimpia : null;
		if (nota && largo(nota) > NOTA_MAX) fallo("nota", `La nota no puede pasar de ${NOTA_MAX} caracteres`);

		return {
			dia_ymd: dia_ymd ?? "",
			hora: hora ?? "",
			personas,
			id_mesa,
			nombre,
			email,
			telefono: telefono ?? "",
			nota,
		};
	});

export type AltaReservaWeb = z.infer<typeof altaReservaWebSchema>;

/** `?dia=` de las rutas que preguntan por un día. */
export const diaQuerySchema = z.object({ dia: zDia("Formato de día inválido. Esperado YYYY-MM-DD.") });

// ── Drift-guard con el DTO de Rust (ARCH-03) ─────────────────────────────────
type _GAlta = Assert<SameKeys<AltaReservaWeb, ReservaWebAltaInput>>;
