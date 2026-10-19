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
//   · **A quién**: el correo del alta, o el del cliente de una reserva web en Turso. Nunca uno que
//     llegue en un cuerpo. Eso lo garantiza quien llama; aquí sólo se envía.
//   · **Cuánto**: un tope diario por negocio y otro por destinatario, contando sólo lo entregado,
//     como el de los pedidos (REV-14). Si no se puede contar, se deja pasar.
//   · **Un correo que falla no deshace nada**: se apunta en `email_sends` y quien llama decide.
//   · Cada correo lleva su id (`email_sends.id`): uno que ya salió no vuelve a salir.

import * as z from "zod";
import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { getDb, type Sql } from "../../server/db";
import { capturarError } from "../../observability/errors";

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
	/** Sólo en la confirmación: el enlace de cancelar, con el token en el fragmento. */
	enlace?: string;
	/** Quién lo provoca, para la traza: `web` el visitante, `agenda` la agenda, o el dispositivo. */
	dispositivo: string;
};

export type ResultadoCorreo = "enviado" | "ya_enviado" | "tope" | "fallido";

const correoValido = z.string().max(254).email();

/** Lo del negocio para el correo, de su base. El teléfono, el público; si no, el de contacto. */
export async function negocioDelCorreo(db: Client): Promise<NegocioDelCorreo> {
	const rs = await db.execute(`
		SELECT b.Business_Name AS nombre, b.Direccion AS direccion, b.Telefono AS telefono,
		       c.Contact_Email AS correo, c.Contact_Phone AS telefono_contacto
		FROM Business_Settings b LEFT JOIN Contact_Settings c ON c.ID = 1 WHERE b.ID = 1;
	`);
	const r: any = rs.rows?.[0] ?? {};
	const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
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
	const para = correo.para.trim().toLowerCase();
	const db = getDb(env);
	if (await yaSalio(db, correo.id)) return "ya_enviado";
	if (await pasaDeLosTopes(db, correo.tenantId, para, Date.now())) {
		console.warn("[reservas-web] correo sin enviar por el tope diario:", correo.tipo);
		return "tope";
	}

	const remitente = String(env.EMAIL_RESERVAS_FROM_ADDRESS || "").trim();
	if (!remitente) {
		capturarError(new Error("missing_env_EMAIL_RESERVAS_FROM_ADDRESS"), "reservas_web.correo");
		return "fallido";
	}
	const { asunto, html, texto } = plantilla(correo);
	try {
		await env.EMAIL.send({
			from: { email: remitente, name: nombreDelRemitente(correo.negocio.nombre) },
			to: para,
			...(correo.negocio.correo ? { replyTo: correo.negocio.correo } : {}),
			subject: asunto,
			html,
			text: texto,
		});
	} catch (err) {
		capturarError(err, "reservas_web.correo");
		// El binding lanza con `.code` (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED…). Sin la
		// dirección en el log: es un dato personal.
		const e = err as { code?: string };
		console.error("[reservas-web] el correo no ha salido:", correo.tipo, e.code ?? "");
		await apuntar(db, correo, para, false, e.code ?? "envio_fallido");
		return "fallido";
	}
	await apuntar(db, correo, para, true, null);
	return "enviado";
}

/** El nombre del negocio como remitente: una línea, sin lo que rompería la cabecera. */
function nombreDelRemitente(nombre: string): string {
	const limpio = nombre.replace(/[\r\n"<>]/g, " ").trim().slice(0, 100);
	return limpio || "Reservas";
}

/** ¿Ese correo ya salió? Si no se puede mirar, no: mejor dos que ninguno. */
async function yaSalio(db: Sql, id: string): Promise<boolean> {
	try {
		const rs = await db.execute({ sql: `SELECT 1 FROM email_sends WHERE id = ?1 AND ok = 1;`, args: [id] });
		return (rs.rows?.length ?? 0) > 0;
	} catch (e: any) {
		capturarError(e, "reservas_web.correo.traza");
		return false;
	}
}

/**
 * Los dos topes, sobre lo entregado de las últimas 24 h. Si no se pueden contar se deja pasar, como
 * en los pedidos: una caída nuestra no puede dejar a un cliente sin el correo de su reserva.
 */
export async function pasaDeLosTopes(db: Sql, tenantId: string, para: string, ahoraMs: number): Promise<boolean> {
	try {
		const desde = ahoraMs - VENTANA_MS;
		const [delNegocio, delDestinatario] = await Promise.all([
			db.execute({
				sql: `SELECT COUNT(*) AS n FROM email_sends
				      WHERE tenant_id = ?1 AND tipo = 'reserva_web' AND ok = 1 AND sent_at_ms > ?2;`,
				args: [tenantId, desde],
			}),
			db.execute({
				sql: `SELECT COUNT(*) AS n FROM email_sends
				      WHERE to_email = ?1 AND tipo = 'reserva_web' AND ok = 1 AND sent_at_ms > ?2;`,
				args: [para, desde],
			}),
		]);
		const n = (rs: any) => Number(rs?.rows?.[0]?.n ?? 0);
		return n(delNegocio) >= TOPE_DIARIO_NEGOCIO || n(delDestinatario) >= TOPE_DIARIO_DESTINATARIO;
	} catch (e: any) {
		capturarError(e, "reservas_web.correo.tope");
		return false;
	}
}

/**
 * La traza en `email_sends`, de donde salen los topes y lo de «ya salió». Best-effort, como en los
 * pedidos: que no se pueda apuntar no deshace un correo que ya se ha enviado. Un reintento del
 * mismo correo pisa su fila (`ON CONFLICT … DO UPDATE`, nunca `INSERT OR REPLACE`).
 */
async function apuntar(db: Sql, correo: Correo, para: string, ok: boolean, codigo: string | null): Promise<void> {
	try {
		await db.execute({
			sql: `INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
			      VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, 'reserva_web')
			      ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, error_code = excluded.error_code,
			                                    sent_at_ms = excluded.sent_at_ms;`,
			args: [correo.id, correo.tenantId, correo.dispositivo, para, ok ? 1 : 0, codigo, Date.now()],
		});
	} catch (e: any) {
		capturarError(e, "reservas_web.correo.traza");
		console.error("[reservas-web] no se ha podido apuntar el correo:", String(e?.message || e));
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
	const n = c.negocio.nombre || "el restaurante";
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
				despues: `Si no te viene bien, cancélala con el enlace del correo de confirmación o ${contestar}.${c.negocio.correo ? llamar : ""}`,
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
