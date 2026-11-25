// src/domains/reservas_web/correos.ts
//
// Los correos al cliente de una reserva web (docs/estudios/reservas-web.md §4.8), por el binding
// `EMAIL` como los pedidos, desde `EMAIL_RESERVAS_FROM_ADDRESS` con el nombre del negocio y con
// `Reply-To` el correo de contacto del negocio: si el cliente contesta, le contesta al restaurante.
//
// Reglas que no se rompen aquí:
//   · **Sólo datos estructurados**: negocio, dirección, teléfono, día, hora, personas, mesa y el
//     código. Nada que haya escrito el visitante, tampoco su nombre: un formulario público que mete
//     texto libre en un correo de nuestro dominio es una vía de spam.
//   · **A quién**: el correo del alta, o el del cliente de una reserva web en la base. Nunca uno que
//     llegue en un cuerpo. Eso lo garantiza quien llama; aquí sólo se envía.
//   · **Cuánto**: un tope diario por negocio y otro por destinatario, sobre lo entregado y lo que está
//     saliendo, reservados a la vez que el id (`reservar`): muchos envíos a la vez no los pasan.
//   · **Un correo que falla no deshace nada**: se apunta en `email_sends` y quien llama decide.
//   · Cada correo lleva su id (`email_sends.id`): uno que ya salió no vuelve a salir. Sin la base
//     central no se sabe si salió, así que no se envía: es un fallo, y quien puede lo repite.

import * as z from "zod";
import { recortar } from "../../lib/texto";
import type { Base } from "../../lib/sql";

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import type { Sql } from "../../lib/sql";
import { capturarError } from "../../observability/errors";
import { isValidEmail } from "../clientes/clientes.schemas";

/** Por negocio y día: las 200 altas de la agenda, con su cancelación y algún cambio, caben de sobra. */
export const TOPE_DIARIO_NEGOCIO = 600;
/** Por destinatario y día, entre todos los negocios: lo que frena usar el widget contra un buzón. */
export const TOPE_DIARIO_DESTINATARIO = 10;
const VENTANA_MS = 24 * 60 * 60 * 1000;

export type TipoCorreo = "confirmacion" | "cancelacion" | "modificada" | "cancelada_restaurante" | "no_registrada";

/** Lo del negocio que sale en el correo. */
export type NegocioDelCorreo = { nombre: string; direccion: string; telefono: string; correo: string | null };

/** Lo de la reserva que sale en el correo. `mesa` es el nombre que tiene en la Main. */
export type ReservaDelCorreo = { dia: string; hora: string; personas: number; mesa: string | null; codigo: string };

export type Correo = {
	tenantId: string;
	/** `email_sends.id`: el mismo correo no sale dos veces. */
	id: string;
	tipo: TipoCorreo;
	para: string;
	negocio: NegocioDelCorreo;
	reserva: ReservaDelCorreo;
	/** En la confirmación y en un cambio del restaurante: el enlace de cancelar, con el token en el fragmento. */
	enlace?: string;
	/** Quién lo provoca, para la traza: `web` el visitante, `agenda` la agenda, o el dispositivo. */
	dispositivo: string;
	/**
	 * RW-ALTAS · El id del correo que tiene que haber salido (o estar saliendo) antes que éste. Si no,
	 * éste no sale ni gasta cupo (`sin_previo`): el «has cancelado» sólo va a quien recibió el «está
	 * confirmada». Se mira en la misma sentencia que reserva el cupo.
	 */
	trasElCorreo?: string;
};

/**
 * `en_curso`: otro lo está enviando ahora mismo; no se sabe aún si saldrá, y quien pueda lo repite.
 * `fallido`: no ha salido (el binding, la base central sin responder o el remitente sin configurar);
 *   también se puede repetir: lo que falla se arregla, y entonces sale.
 * `sin_previo`: no sale porque no salió el que tenía que ir antes (`Correo.trasElCorreo`).
 * `invalido`: el destinatario no es una dirección (AUD-39/40). Repetirlo no lo arregla, y nadie lo
 *   apunta para repetirlo (RESERVA-CORREOS).
 */
export type ResultadoCorreo = "enviado" | "ya_enviado" | "en_curso" | "tope" | "fallido" | "sin_previo" | "invalido";

const correoValido = z.string().max(254).email();

/** Lo del negocio para el correo, de su base. El teléfono, el público; si no, el de contacto. */
export async function negocioDelCorreo(db: Base): Promise<NegocioDelCorreo> {
	const rs = await db.execute(`
		SELECT b.Business_Name AS nombre, b.Direccion AS direccion, b.Telefono AS telefono,
		       c.Contact_Email AS correo, c.Contact_Phone AS telefono_contacto
		FROM Business_Settings b LEFT JOIN Contact_Settings c ON c.ID = 1 WHERE b.ID = 1;
	`);
	const r: any = rs.rows?.[0] ?? {};
	const s = (v: unknown) => (typeof v === "string" ? recortar(v) : "");
	const correo = s(r.correo);
	return {
		nombre: s(r.nombre),
		direccion: s(r.direccion),
		telefono: s(r.telefono) || s(r.telefono_contacto),
		correo: correoValido.safeParse(correo).success ? correo : null,
	};
}

/** El enlace de cancelar del correo de confirmación. El token va en el fragmento: no llega a ningún servidor. */
export function enlaceDeCancelar(origen: string, clave: string, token: string): string {
	return `${origen}/reservas-web/v1/w/${encodeURIComponent(clave)}/cancelar#t=${token}`;
}

/**
 * Envía un correo de la reserva web, si no ha salido ya y no pasa de los topes. No lanza nunca: quien
 * llama ya ha hecho lo importante (reservar, cancelar) y un correo no puede convertirlo en un error.
 */
export async function enviarCorreoReservaWeb(env: Env, correo: Correo): Promise<ResultadoCorreo> {
	try {
		return await enviar(env, correo);
	} catch (e: any) {
		capturarError(e, "reservas_web.correo");
		console.error("[reservas-web] el correo no ha salido:", correo.tipo, String(e?.message || e));
		return "fallido";
	}
}

async function enviar(env: Env, correo: Correo): Promise<ResultadoCorreo> {
	const para = recortar(correo.para).toLowerCase();
	// AUD-40: la dirección la escribe un visitante (la del alta) o el personal (la del cliente), y la
	// regla de un correo, la misma que en la Main, no mira los caracteres de control. Con uno dentro no
	// es una dirección, y en `to` sería una cabecera más: no se envía, ni se le reserva sitio en los
	// topes.
	if (SALTO_O_CONTROL.test(para)) {
		console.warn("[reservas-web] correo sin enviar: la dirección lleva caracteres de control:", correo.tipo);
		return "invalido";
	}
	// AUD-39: y una sola dirección. Las rutas ya lo exigen, pero la del cliente puede venir de la Main
	// por la réplica, que no pasa por ninguna validación. Una lista sería un solo envío para los topes
	// y otro destinatario para el de cada dirección, que va por la cadena literal.
	if (!isValidEmail(para)) {
		console.warn("[reservas-web] correo sin enviar: la dirección no es una sola dirección de correo:", correo.tipo);
		return "invalido";
	}
	const db = getDb(env);
	const remitente = recortar(String(env.EMAIL_RESERVAS_FROM_ADDRESS || ""));
	if (!remitente) {
		capturarError(new Error("missing_env_EMAIL_RESERVAS_FROM_ADDRESS"), "reservas_web.correo");
		return "fallido";
	}
	const reserva = await reservar(db, correo, para);
	if (reserva === "tope") console.warn("[reservas-web] correo sin enviar por el tope diario:", correo.tipo);
	if (reserva === "sin_previo") console.warn("[reservas-web] correo sin enviar: no salió el anterior:", correo.tipo);
	if (reserva !== "mio") return reserva;

	const { asunto, html, texto } = plantilla(correo);
	try {
		await env.EMAIL.send({
			from: { email: remitente, name: nombreDelRemitente(correo.negocio.nombre) },
			to: para,
			...(correo.negocio.correo ? { replyTo: correo.negocio.correo } : {}),
			// AUD-40: la plantilla ya lo compone en una línea; esto cubre lo que se le añada.
			subject: enUnaLinea(asunto),
			html,
			text: texto,
		});
	} catch (err) {
		capturarError(err, "reservas_web.correo");
		// El binding lanza con `.code` (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED…). Sin la
		// dirección en el log: es un dato personal.
		const e = err as { code?: string };
		console.error("[reservas-web] el correo no ha salido:", correo.tipo, e.code ?? "");
		await terminar(db, correo.id, false, e.code ?? "envio_fallido");
		return "fallido";
	}
	await terminar(db, correo.id, true, null);
	return "enviado";
}

/** Un carácter de control (CR, LF, NUL, el NEL de U+0085…) o un separador de línea o de párrafo. */
const SALTO_O_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * AUD-40 · Un texto que va a una cabecera del correo, en una línea: los caracteres de control y los
 * separadores de línea pasan a un espacio, y se recorta con `recortar`. El nombre del negocio llega
 * de su base tal como lo dejó una Handy o la Main, que sube su propio SQL por la réplica: con un CR/LF
 * dentro, el asunto salía partido y el negocio escribía cabeceras en correos de nuestro dominio.
 * Rechazarlo al guardar no bastaría; se limpia donde se compone el correo.
 */
export function enUnaLinea(texto: string): string {
	return recortar(texto.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " "));
}

/** Lo más largo que entra del nombre del negocio en una cabecera: el asunto no puede pasar de 998. */
const NOMBRE_EN_CABECERA_MAX = 100;

/** El nombre del negocio para una cabecera: en una línea y con su tope, sin partir un carácter. */
function nombreEnCabecera(nombre: string): string {
	return recortar([...enUnaLinea(nombre)].slice(0, NOMBRE_EN_CABECERA_MAX).join(""));
}

/** El nombre del negocio como remitente: en una línea, y sin lo que rompería la dirección. */
function nombreDelRemitente(nombre: string): string {
	return nombreEnCabecera(nombre.replace(/["<>]/g, " ")) || "Reservas";
}

/** Lo que tarda como mucho un envío: una reserva más vieja sin terminar es de uno que murió a medias. */
const ENVIANDO_MAX_MS = 5 * 60_000;

/**
 * Reserva el correo en `email_sends` antes de enviarlo, en una sola sentencia: su id y su sitio en
 * los dos topes. Así, de dos envíos a la vez del mismo correo sólo uno se queda con él, y muchos
 * envíos a la vez no pasan de los topes, que cuentan lo entregado y lo que está saliendo.
 *
 *   · `mio`: se ha reservado; hay que enviarlo y apuntar cómo acabó (`terminar`).
 *   · `ya_enviado`: salió (`ok = 1`); no se vuelve a reservar nunca.
 *   · `en_curso`: otro lo está enviando ahora; quien llama lo puede repetir más tarde. Uno que se
 *     quedó a medias se puede retomar pasados unos minutos.
 *   · `tope`: no cabe en alguno de los dos topes.
 *   · `sin_previo`: lleva `trasElCorreo` y ese correo ni salió ni está saliendo (RW-ALTAS).
 *   · `fallido`: la base central no responde. Sin ella no se sabe si ya salió, así que no se envía:
 *     quien llama lo repite si puede. Lo de negocio (la reserva, la cancelación) ya está hecho.
 *
 * Uno que falló (`ok = 0`) se puede volver a reservar, y entonces cuenta para el destinatario al que
 * sale ahora (el cliente pudo corregir su correo entre un intento y otro). Nunca `INSERT OR REPLACE`.
 */
async function reservar(db: Sql, correo: Correo, para: string): Promise<"mio" | Exclude<ResultadoCorreo, "enviado">> {
	const ahora = Date.now();
	try {
		const rs = await db.execute({
			sql: `INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
			      SELECT ?1, ?2, ?3, ?4, NULL, 0, 'enviando', ?5, 'reserva_web'
			      WHERE (SELECT COUNT(*) FROM email_sends
			             WHERE tenant_id = ?2 AND tipo = 'reserva_web' AND id <> ?1 AND sent_at_ms > ?7
			               AND (ok = 1 OR (error_code = 'enviando' AND sent_at_ms > ?6))) < ?8
			        AND (SELECT COUNT(*) FROM email_sends
			             WHERE to_email = ?4 AND tipo = 'reserva_web' AND id <> ?1 AND sent_at_ms > ?7
			               AND (ok = 1 OR (error_code = 'enviando' AND sent_at_ms > ?6))) < ?9
			        AND (?10 IS NULL OR EXISTS (SELECT 1 FROM email_sends
			                                    WHERE id = ?10 AND tenant_id = ?2 AND tipo = 'reserva_web'
			                                      AND (ok = 1 OR error_code = 'enviando')))
			      ON CONFLICT(id) DO UPDATE SET error_code = 'enviando', sent_at_ms = excluded.sent_at_ms,
			                                    to_email = excluded.to_email, device_id = excluded.device_id
			      WHERE email_sends.ok = 0
			        AND (email_sends.error_code IS NULL OR email_sends.error_code <> 'enviando' OR email_sends.sent_at_ms <= ?6);`,
			args: [
				correo.id,
				correo.tenantId,
				correo.dispositivo,
				para,
				ahora,
				ahora - ENVIANDO_MAX_MS,
				ahora - VENTANA_MS,
				TOPE_DIARIO_NEGOCIO,
				TOPE_DIARIO_DESTINATARIO,
				correo.trasElCorreo ?? null,
			],
		});
		if (rs.rowsAffected > 0) return "mio";
		// No se ha reservado: por qué.
		const fila: any = (
			await db.execute({ sql: `SELECT ok, error_code, sent_at_ms FROM email_sends WHERE id = ?1;`, args: [correo.id] })
		).rows?.[0];
		if (Number(fila?.ok) === 1) return "ya_enviado";
		if (fila?.error_code === "enviando" && Number(fila.sent_at_ms) > ahora - ENVIANDO_MAX_MS) return "en_curso";
		if (correo.trasElCorreo) {
			const previo: any = (
				await db.execute({
					sql: `SELECT 1 AS hay FROM email_sends
					      WHERE id = ?1 AND tenant_id = ?2 AND tipo = 'reserva_web' AND (ok = 1 OR error_code = 'enviando');`,
					args: [correo.trasElCorreo, correo.tenantId],
				})
			).rows?.[0];
			if (!previo) return "sin_previo";
		}
		return "tope";
	} catch (e: any) {
		capturarError(e, "reservas_web.correo.traza");
		console.error("[reservas-web] no se ha podido reservar el correo:", String(e?.message || e));
		return "fallido";
	}
}

/** Cuántas veces se intenta apuntar cómo acabó un envío, y cuánto se espera entre una y otra. */
const INTENTOS_DE_TERMINAR = 3;
const ESPERA_TERMINAR_MS = 200;

/**
 * Cómo acabó el envío. Un `ok = 1` no se toca: un fallo posterior no lo convierte en reenviable.
 *
 * Se insiste unas veces, porque lo que se juega es que un correo que ya salió se quede en
 * «enviando»: pasados unos minutos se podría volver a reservar, y un reintento del mismo correo (si
 * además se perdió la respuesta) lo mandaría otra vez. Si aun así no se puede apuntar, queda en el
 * log: que no se pueda apuntar no deshace un correo que ya ha salido.
 */
async function terminar(db: Sql, id: string, ok: boolean, codigo: string | null): Promise<void> {
	for (let intento = 1; ; intento++) {
		try {
			await db.execute({
				sql: `UPDATE email_sends SET ok = ?2, error_code = ?3, sent_at_ms = ?4 WHERE id = ?1 AND ok = 0;`,
				args: [id, ok ? 1 : 0, codigo, Date.now()],
			});
			return;
		} catch (e: any) {
			if (intento >= INTENTOS_DE_TERMINAR) {
				capturarError(e, "reservas_web.correo.traza");
				console.error("[reservas-web] no se ha podido apuntar el correo:", String(e?.message || e));
				return;
			}
			await new Promise((r) => setTimeout(r, ESPERA_TERMINAR_MS * intento));
		}
	}
}

/* ── Las plantillas ─────────────────────────────────────────────────────────────────────────── */

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = [
	"enero", "febrero", "marzo", "abril", "mayo", "junio",
	"julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** «viernes, 24 de octubre de 2026». */
export function fechaLarga(dia: string): string {
	const [a, m, d] = dia.split("-").map(Number);
	const semana = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
	return `${DIAS[semana]}, ${d} de ${MESES[m - 1]} de ${a}`;
}

/**
 * El nombre de la mesa en un texto: «Mesa» delante sólo si es un número a secas, como en el widget.
 * Copia de `@tpv/plano/nombre` (el worker no depende de los paquetes de React).
 */
export function nombreDeMesa(nombre: string): string {
	return /^[0-9]+$/.test(nombre) ? `Mesa ${nombre}` : nombre;
}

function personas(n: number): string {
	return n === 1 ? "1 persona" : `${n} personas`;
}

type Texto = { asunto: string; titulo: string; antes: string; despues: string };

/** Lo que dice cada correo, alrededor del resumen de la reserva. */
function textos(c: Correo): Texto {
	// AUD-40: el nombre va en el asunto, que es una cabecera.
	const n = nombreEnCabecera(c.negocio.nombre) || "el restaurante";
	const llamar = c.negocio.telefono ? ` Si lo prefieres, llama al ${c.negocio.telefono}.` : "";
	// Sin correo de contacto del negocio, una respuesta llegaría a nuestro remitente: no se ofrece.
	const contestar = c.negocio.correo ? "contesta a este correo" : "llama al restaurante";
	switch (c.tipo) {
		case "confirmacion":
			return {
				asunto: `Reserva confirmada en ${n}`,
				titulo: "Tu reserva está confirmada",
				antes: `Te esperamos en ${n}.`,
				despues: "Si no vas a poder ir, o no la has hecho tú, cancélala con el botón, hasta la hora de la reserva.",
			};
		case "cancelacion":
			return {
				asunto: `Reserva cancelada en ${n}`,
				titulo: "Has cancelado tu reserva",
				antes: `Tu reserva en ${n} ya no está.`,
				despues: "Si quieres volver a reservar, hazlo desde su web.",
			};
		case "modificada":
			return {
				asunto: `Tu reserva en ${n} ha cambiado`,
				titulo: "El restaurante ha cambiado tu reserva",
				antes: "Así queda ahora:",
				despues: c.enlace
					? `Si no te viene bien, cancélala con el botón, hasta la hora de la reserva, o ${contestar}.${c.negocio.correo ? llamar : ""}`
					: `Si no te viene bien, ${contestar}.${c.negocio.correo ? llamar : ""}`,
			};
		case "cancelada_restaurante":
			return {
				asunto: `Tu reserva en ${n} se ha cancelado`,
				titulo: "El restaurante ha cancelado tu reserva",
				antes: "Esta reserva ya no está:",
				despues: `Si tienes alguna duda, ${contestar}.${c.negocio.correo ? llamar : ""}`,
			};
		case "no_registrada":
			return {
				asunto: `No hemos podido registrar tu reserva en ${n}`,
				titulo: "No hemos podido registrar tu reserva",
				antes: "Ha habido un problema con esta reserva y no ha quedado apuntada:",
				despues: `El restaurante se pondrá en contacto contigo.${llamar}`,
			};
	}
}

/** Las filas del resumen: día, hora, personas, mesa y código. */
function filas(r: ReservaDelCorreo): [string, string][] {
	const f: [string, string][] = [
		["Día", fechaLarga(r.dia)],
		["Hora", r.hora],
		["Personas", personas(r.personas)],
	];
	if (r.mesa) f.push(["Mesa", nombreDeMesa(r.mesa)]);
	f.push(["Código", r.codigo]);
	return f;
}

export function plantilla(c: Correo): { asunto: string; html: string; texto: string } {
	const t = textos(c);
	const resumen = filas(c.reserva);
	const negocio = [c.negocio.nombre, c.negocio.direccion, c.negocio.telefono].filter(Boolean);
	const pie = `Recibes este correo porque se ha hecho una reserva con esta dirección en la web de ${c.negocio.nombre || "un restaurante"}.`;

	const texto = [
		t.titulo,
		"",
		t.antes,
		"",
		...resumen.map(([k, v]) => `${k}: ${v}`),
		"",
		...(c.enlace ? [`Cancelar la reserva: ${c.enlace}`, ""] : []),
		t.despues,
		"",
		...negocio,
		"",
		pie,
	].join("\n");

	const celdas = resumen
		.map(
			([k, v]) =>
				`<tr><td style="padding:6px 12px 6px 0;color:#6b7280">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`,
		)
		.join("");
	const boton = c.enlace
		? `<p style="margin:24px 0"><a href="${esc(c.enlace)}" style="display:inline-block;padding:12px 20px;background:#016ffc;color:#ffffff;border-radius:12px;text-decoration:none;font-weight:700">Cancelar la reserva</a></p>`
		: "";
	const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>${esc(t.asunto)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="margin:0 0 12px">${esc(t.titulo)}</h2>
  <p>${esc(t.antes)}</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:15px">${celdas}</table>
  ${boton}
  <p>${esc(t.despues)}</p>
  <p style="margin-top:24px;color:#374151">${negocio.map(esc).join("<br>")}</p>
  <p style="margin-top:24px;font-size:12px;color:#9ca3af">${esc(pie)}</p>
</body>
</html>`;
	return { asunto: t.asunto, html, texto };
}

function esc(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
