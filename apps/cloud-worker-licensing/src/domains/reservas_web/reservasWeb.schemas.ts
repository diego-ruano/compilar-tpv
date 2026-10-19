// src/domains/reservas_web/reservasWeb.schemas.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): lo que entra por las rutas públicas.
//
// El alta acepta y rechaza lo mismo que `tpv_domain::reservas_web::AltaWebValidada`, que es con lo
// que la Main la vuelve a validar al registrarla, y normaliza igual: lo fija la tabla compartida
// `validacion_casos.json` (dominio `reserva_web`). Un criterio nuevo es un caso nuevo ahí.

import * as z from "zod";
import type {
	AvisoReservaWebInput,
	RecogidaReservaWebDto,
	RecogidasReservaWebInput,
	ReservaWebAltaInput,
} from "@tpv/contracts";

import { normalizarDia, zDia } from "../../lib/fechas";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import { isValidEmail } from "../clientes/clientes.schemas";
import { normalizeHora } from "../reservas/reservas.schemas";

/** Los mismos topes que `tpv_domain::reservas_web`. */
const NOMBRE_MAX = 80;
const NOTA_MAX = 200;
const EMAIL_MAX = 254;
const PERSONAS_MAX = 50;

/** Cuántos caracteres (no unidades UTF-16): la «ñ» cuenta uno, como en Rust. */
const largo = (s: string) => [...s].length;

/**
 * Lo que no es texto cuenta como vacío, igual que en Rust (`as_str()` → vacío). Nunca `String(x)`:
 * esta entrada viene de internet, y un `{"toString": null}` hace que `String()` lance — un 500 en
 * vez de un rechazo.
 */
const texto = (x: unknown): string => (typeof x === "string" ? x : "");

/**
 * El teléfono sólo con sus cifras (y el `+` del prefijo internacional), o `null` si no lo parece.
 * Espejo de `tpv_domain::reservas_web::normalizar_telefono`.
 */
function normalizarTelefono(raw: unknown): string | null {
	const t = texto(raw).trim();
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

		const dia_ymd = normalizarDia(texto(v.dia_ymd));
		if (!dia_ymd) fallo("dia_ymd", "Formato de día inválido. Esperado YYYY-MM-DD.");

		const hora = horaHHMM(texto(v.hora));
		if (!hora) fallo("hora", "Hora inválida. Esperado HH:MM.");

		const personas = typeof v.personas === "number" && Number.isInteger(v.personas) ? v.personas : 0;
		if (personas < 1 || personas > PERSONAS_MAX) {
			fallo("personas", `El número de personas tiene que estar entre 1 y ${PERSONAS_MAX}`);
		}

		const id_mesa = texto(v.id_mesa).trim();
		if (!id_mesa) fallo("id_mesa", "Elige una mesa");

		const nombre = texto(v.nombre).trim();
		if (!nombre) fallo("nombre", "Escribe tu nombre");
		else if (largo(nombre) > NOMBRE_MAX) fallo("nombre", `El nombre no puede pasar de ${NOMBRE_MAX} caracteres`);

		const email = texto(v.email).trim().toLowerCase();
		if (largo(email) > EMAIL_MAX || !isValidEmail(email)) fallo("email", "El correo no es válido");

		const telefono = normalizarTelefono(v.telefono);
		if (!telefono) fallo("telefono", "El teléfono no es válido");

		const notaLimpia = texto(v.nota).trim();
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

/** `?dia=&hora=&personas=` de `/disponibles`. Llega como texto: es una consulta. */
export const disponiblesQuerySchema = z.object({
	dia: zDia("Formato de día inválido. Esperado YYYY-MM-DD."),
	hora: z.unknown().transform((v, ctx) => {
		const hora = horaHHMM(texto(v));
		if (!hora) {
			ctx.addIssue({ code: "custom", message: "Hora inválida. Esperado HH:MM." });
			return z.NEVER;
		}
		return hora;
	}),
	personas: z.unknown().transform((v, ctx) => {
		const t = texto(v).trim();
		const n = /^\d{1,3}$/.test(t) ? Number(t) : 0;
		if (n < 1 || n > PERSONAS_MAX) {
			ctx.addIssue({ code: "custom", message: `El número de personas tiene que estar entre 1 y ${PERSONAS_MAX}` });
			return z.NEVER;
		}
		return n;
	}),
});

/** El cuerpo de `/reserva` y `/cancelar`: el token del enlace del correo. */
export const tokenEnlaceSchema = z.object({ token: z.unknown().transform((v) => texto(v).trim().slice(0, 64)) });

/** Una línea de lo que contesta la Main (`POST /v1/reservas-web/recogidas`). */
const recogidaSchema = z.object({
	id_peticion: z.string().trim().min(1).max(64),
	resultado: z.enum(["registrada", "solapada", "fallida"]),
	// Un código de error, nunca su texto (podría llevar datos de alguien).
	codigo: z
		.string()
		.trim()
		.max(64)
		.regex(/^[a-z0-9_]*$/, "El código de error es un identificador")
		.nullish()
		.transform((v) => (v ? v : null)),
});

/** Lo que la Main ha hecho con lo entregado. Un techo por petición, como toda lista que llega. */
export const recogidasSchema = z.object({ resultados: z.array(recogidaSchema).max(100) });

type _GRecogida = Assert<SameKeys<z.infer<typeof recogidaSchema>, RecogidaReservaWebDto>>;
type _GRecogidas = Assert<SameKeys<z.infer<typeof recogidasSchema>, RecogidasReservaWebInput>>;

/**
 * El correo al cliente por un cambio del restaurante (`POST /v1/reservas-web/avisos`), con los datos
 * de después del cambio. Lo manda la Main (o la Handy): no es una entrada pública, pero sale en un
 * correo de nuestro dominio, así que todo tiene su forma y su tope. El destinatario no viene aquí.
 */
export const avisoReservaWebSchema = z.object({
	id_aviso: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/, "id_aviso inválido"),
	id_reserva: z.string().trim().min(1).max(64),
	tipo: z.enum(["modificada", "cancelada"]),
	dia_ymd: zDia("Formato de día inválido. Esperado YYYY-MM-DD."),
	hora: z.unknown().transform((v, ctx) => {
		const hora = horaHHMM(v);
		if (!hora) {
			ctx.addIssue({ code: "custom", message: "Hora inválida. Esperado HH:MM." });
			return z.NEVER;
		}
		return hora;
	}),
	// Una reserva del TPV puede ser de un grupo grande: el tope es el de un dato sensato, no el de la web.
	personas: z.number().int().min(1).max(1000),
	// El nombre de la mesa en la Main, en una sola línea.
	mesa: z
		.string()
		.trim()
		.max(60)
		.refine((s) => !/[\r\n]/.test(s), "mesa inválida")
		.nullish()
		.transform((v) => (v ? v : null)),
	// El cliente de la reserva en la Main tras el cambio: la nube sólo le escribe al suyo si es éste.
	id_cliente: z
		.string()
		.trim()
		.max(64)
		.nullish()
		.transform((v) => (v ? v : null)),
	// La huella (SHA-256) del correo de ese cliente en la Main: la nube espera a tener el mismo.
	huella_correo: z
		.string()
		.regex(/^[0-9a-f]{64}$/, "huella_correo inválida")
		.nullish()
		.transform((v) => v ?? null),
});

type _GAviso = Assert<SameKeys<z.infer<typeof avisoReservaWebSchema>, AvisoReservaWebInput>>;
