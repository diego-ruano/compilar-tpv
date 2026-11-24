// src/domains/email/email.routes.ts
//
// Endpoint ÚNICO de envío de correo. Desde DB-04 TODO el correo pasa por aquí (ya no existe el
// "SMTP propio del negocio"): tanto la Main como la Handy llaman POST /v1/email/enviar-pedido con
// JWT de tenant y el worker es quien envía. En offline no se puede enviar (hace falta el worker).
//
// Backend de envío: Cloudflare Email Service, vía el binding `EMAIL` (send_email en wrangler.json).
// El remitente (`from`) sale de las vars EMAIL_FROM_ADDRESS/EMAIL_FROM_NAME y su dominio debe estar
// dado de alta en Email Sending (SPF+DKIM). No se usan claves de API: el binding autentica solo.
//
// Anti-abuso, en dos ejes, y hacen falta los dos:
//
//   · A QUIÉN (FABLE-C, 2026-08-15): el destinatario debe ser el `Email` de un proveedor dado de
//     alta en el tenant — el dispositivo no puede escribir a una dirección arbitraria con nuestro
//     dominio.
//   · CUÁNTO (REV-14): un tope diario por negocio. La decisión de 2026-08-15 fue «acotar a quién,
//     no cuánto», y eso sólo se sostiene si «a quién» está de verdad acotado — y no lo estaba: dar
//     de alta un proveedor es una escritura de negocio corriente, así que con un token robado se
//     creaba un proveedor con cualquier correo y se enviaba, sin límite y con el SPF/DKIM de
//     nuestro dominio detrás. El filtro no acotaba el destinatario: acotaba el número de pasos.
//
// Cada envío deja traza en `email_sends` (control-plane), que es de donde sale el recuento: la fila
// se pone al reservar el sitio en el cupo, antes de enviar, y después se apunta cómo acabó.

import { Hono } from "hono";
import type { Dinero } from "@tpv/contracts";
import { enEuros, zDineroOpcional } from "../../lib/dinero";
import * as z from "zod";

import type { Env } from "../../env";
import { alHub } from "../../lib/enElHub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import type { Sql } from "../../lib/sql";
import { cuerpo } from "../../lib/validacion";
import { capturarError } from "../../observability/errors";
import { leerIdentidadPedido, type IdentidadPedido } from "./pedidoIdentidad";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const emailRoutes = new Hono<Ctx>();

// DO-04: el pedido lee el proveedor y el contacto del negocio de la base del negocio, así que la
// ruta se ejecuta dentro de su TenantHub (`lib/enElHub.ts`). El cupo (base central) y el envío (el
// binding `EMAIL`) se hacen desde allí, con el mismo entorno que tiene el Worker.
emailRoutes.use("*", tenantAuth, alHub);

const lineaSchema = z.object({
	nombre_producto: z.string().max(200),
	cantidad: z.number(),
	precio_unitario: zDineroOpcional,
	unidad: z.string().max(50).nullable().optional(),
});

/** La clave de un envío (`id_envio`): un UUID, o algo de su estilo. */
const CLAVE_DE_ENVIO = /^[A-Za-z0-9_-]{16,64}$/;

// Un pedido se puede enviar con líneas, con notas, o con ambas — pero NO vacío: un correo sin nada
// que pedir no le dice nada al proveedor. Antes se exigía `min(1)` línea, lo que impedía el caso
// legítimo de "pedido solo con notas" (p. ej. "mándame lo de siempre").
const enviarPedidoSchema = z
	.object({
		email_destino: z.string().email("El correo de destino no es válido."),
		nombre_proveedor: z.string().min(1).max(200),
		notas: z.string().max(2000).nullable().optional(),
		lineas: z.array(lineaSchema).max(500).default([]),
		// La clave del envío: la misma mientras la Main reintenta el mismo pedido (`claveDeEnvio.ts`).
		// Siempre viene; sin ella, o sin su forma, no hay pedido que mandar.
		id_envio: z.string().regex(CLAVE_DE_ENVIO),
	})
	.refine((v) => v.lineas.length > 0 || (v.notas ?? "").trim().length > 0, {
		message: "El pedido debe llevar al menos una línea o unas notas",
		path: ["lineas"],
	});

emailRoutes.post("/enviar-pedido", cuerpo(enviarPedidoSchema), async (c) => {
	const { email_destino, notas, lineas, id_envio } = c.req.valid("json");
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");

	// FABLE-C — el destinatario NO lo elige libremente el dispositivo: tiene que ser el correo de un
	// proveedor dado de alta en ESTE tenant. Sin esto, un token robado podía usar nuestro dominio
	// (con su SPF/DKIM) para mandar correo a cualquier dirección del mundo. Es el control real de
	// abuso: acota a quién se puede escribir, en vez de cuánto.
	const identidad = await tenantQuery(c, (db) => leerIdentidadPedido(db, email_destino));
	const html = buildHtml(identidad, notas ?? null, lineas);
	const text = buildText(identidad, notas ?? null, lineas);

	const fromAddress = c.env.EMAIL_FROM_ADDRESS;
	if (!fromAddress) {
		capturarError(new Error("missing_env_EMAIL_FROM_ADDRESS"), "email.send");
		return c.json({ error: "missing_env_EMAIL_FROM_ADDRESS" }, 500);
	}
	const from: EmailAddress = { email: fromAddress, name: identidad.nombre };

	// REV-14 y AUD-41: el sitio en el cupo se reserva justo antes de enviar, con la fila del envío y
	// en una sola sentencia. Va después de lo que puede rechazar el pedido (el destinatario, el
	// contacto del negocio, el remitente): un 403 o un 400 no gastan cupo.
	const db = getDb(c.env);
	const envio: Envio = {
		// Con la clave del envío, el id es el mismo en cada reintento: lo que ya salió no vuelve a salir
		// (`reservarCupo`). Lleva el negocio delante: la clave la elige el dispositivo.
		id: `pedido:${tenantId}:${id_envio}`,
		tenantId,
		deviceId,
		toEmail: email_destino,
		proveedor: identidad.proveedor,
	};
	const reserva = await reservarCupo(db, envio);
	if (reserva === "tope") return c.json({ error: "email_limite_diario" }, 429);
	// Un reintento de un pedido que ya salió: la respuesta del primero se perdió por el camino (el
	// viaje de vuelta desde el TenantHub, la red de la Main). Se contesta lo que se habría contestado,
	// sin mandar otro correo.
	if (reserva === "ya_enviado") return c.json({ ok: true });
	// El mismo pedido, saliendo ahora mismo por otra petición: ésta no lo manda otra vez.
	if (reserva === "en_curso") return c.json({ ok: false, error: "email_en_curso" }, 409);

	try {
		await c.env.EMAIL.send({
			from,
			to: email_destino,
			replyTo: identidad.correo,
			subject: `Pedido de ${identidad.nombre}`,
			html,
			text,
		});
	} catch (err) {
		capturarError(err, "email.send");
		// El binding lanza Error con `.code` (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED, …).
		const e = err as { code?: string; message?: string };
		console.error("[email] Cloudflare Email Service error:", e.code ?? "", e.message ?? err);
		await terminarEnvio(db, envio, false, e.code ?? null);
		// El código del binding va en `detalle`: `code` es el del catálogo compartido.
		return c.json({ error: "email_send_failed", detalle: e.code ?? null }, 500);
	}

	await terminarEnvio(db, envio, true, null);
	return c.json({ ok: true });
});

/**
 * REV-14 · El tope diario por negocio.
 *
 * Cien correos al día es un número que ningún bar alcanza pidiendo a sus proveedores y que sí
 * estorba a quien quiera usar nuestro dominio de relé. Está aquí arriba y no escondido en la
 * consulta porque es el tipo de número que se ajusta mirando `email_sends`, no razonando.
 */
export const TOPE_DIARIO = 100;
export const VENTANA_MS = 24 * 60 * 60 * 1000;

/**
 * Un pedido que va a salir, tal como queda en su fila de `email_sends`. El id es el de su clave de
 * envío (`pedido:<negocio>:<id_envio>`), el mismo en cada reintento.
 */
export type Envio = { id: string; tenantId: string; deviceId: string; toEmail: string; proveedor: string };

/**
 * `reservado`: hay sitio y la fila ya está puesta, en `enviando`; se envía y se cierra con
 * `terminarEnvio`. `tope`: no hay sitio y no se envía. `sin_base`: la base central no ha contestado.
 * `ya_enviado`: ese mismo envío ya salió (`ok = 1`); no se vuelve a mandar. `en_curso`: ese mismo
 * envío lo está mandando otra petición ahora.
 */
type ReservaDeCupo = "reservado" | "tope" | "sin_base" | "ya_enviado" | "en_curso";

/** Lo que tarda como mucho un envío: una reserva más vieja sin terminar es de uno que murió a medias. */
const ENVIANDO_MAX_MS = 5 * 60_000;

/**
 * AUD-41 · Reserva el sitio de este pedido en el cupo diario del negocio, justo antes de enviarlo.
 *
 * Es **una sola sentencia**, como `reservas_web/correos.ts::reservar`: inserta la fila en
 * `enviando` sólo si lo que ya cuenta no llega al tope. Contar en una sentencia y apuntar en otra,
 * después de enviar, dejaba pasar a todas las peticiones que contaban a la vez: leían el mismo
 * recuento, y lo que estaba saliendo no ocupaba sitio. Así, de muchas a la vez sólo pasan las que
 * caben.
 *
 * Qué cuenta, de `tipo = 'pedido'` y en las últimas 24 h (la ventana es móvil, no el día natural):
 *   · **Lo entregado** (`ok = 1`) **y lo que está saliendo** (`error_code = 'enviando'`). Lo que
 *     falló (`ok = 0` con el código del binding, o sin código) no cuenta: un proveedor con el buzón
 *     lleno, o una caída de nuestro proveedor de correo, no pueden gastarle el cupo a un bar que no
 *     ha mandado nada. Lo que se protege es la reputación del dominio, que sólo sufre con lo que
 *     sale. Los correos de las reservas web tienen sus propios topes.
 *   · **Cada fila cuenta desde su `sent_at_ms`**: la hora de la reserva mientras está saliendo, y la
 *     de después del envío cuando `terminarEnvio` la cierra. Un envío que tarda no adelanta el
 *     momento en que deja de contar.
 *   · **Una reserva que se quedó en `enviando`** (el worker murió entre la reserva y
 *     `terminarEnvio`, o no se pudo apuntar cómo acabó) cuenta como si hubiera salido, que es lo
 *     prudente: no se sabe si salió. Deja de contar cuando sale de la ventana de 24 h, contadas desde
 *     que se reservó, y nunca pasa a entregada (`ok` sigue en 0).
 *
 * **El mismo envío** (el mismo `id_envio`, el mismo id) se reserva una vez: uno que ya salió no se
 * vuelve a reservar (`ya_enviado`) y uno que está saliendo tampoco (`en_curso`). Uno que falló se
 * puede repetir. Uno que se quedó en `enviando` más de `ENVIANDO_MAX_MS` se puede retomar, como los
 * correos de las reservas web: no se sabe si salió, y no retomarlo dejaría ese pedido sin poder
 * mandarse nunca. Para que eso sea lo raro, `terminarEnvio` insiste antes de rendirse.
 *
 * **Si la base central no contesta, se envía igual** (`sin_base`), y `terminarEnvio` apunta el envío
 * si para entonces puede. Turso caído no puede impedir que un bar mande su pedido: un tope que
 * convierte una caída nuestra en «no puedes trabajar» cuesta más de lo que evita. Ese hueco no lo
 * abre quien llama: no puede tirar la base central a voluntad. Sin la base no se sabe tampoco si ese
 * envío ya salió, y entre no mandar un pedido y mandarlo dos veces en una caída de Turso se queda lo
 * segundo (los correos de las reservas web, al revés, no salen).
 */
export async function reservarCupo(db: Sql, envio: Envio): Promise<ReservaDeCupo> {
	const ahora = Date.now();
	try {
		const rs = await db.execute({
			sql: `INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
			      SELECT ?1, ?2, ?3, ?4, ?5, 0, 'enviando', ?6, 'pedido'
			      WHERE (SELECT COUNT(*) FROM email_sends
			             WHERE tenant_id = ?2 AND tipo = 'pedido' AND id <> ?1 AND sent_at_ms > ?7
			               AND (ok = 1 OR error_code = 'enviando')) < ?8
			      ON CONFLICT(id) DO UPDATE SET error_code = 'enviando', sent_at_ms = excluded.sent_at_ms,
			                                    to_email = excluded.to_email, device_id = excluded.device_id,
			                                    proveedor = excluded.proveedor
			      WHERE email_sends.ok = 0 AND email_sends.tipo = 'pedido'
			        AND (email_sends.error_code IS NULL OR email_sends.error_code <> 'enviando'
			             OR email_sends.sent_at_ms <= ?9);`,
			args: [
				envio.id,
				envio.tenantId,
				envio.deviceId,
				envio.toEmail,
				envio.proveedor,
				ahora,
				ahora - VENTANA_MS,
				TOPE_DIARIO,
				ahora - ENVIANDO_MAX_MS,
			],
		});
		if (Number(rs.rowsAffected) > 0) return "reservado";
		// No se ha reservado: por qué. Un id nuevo no puede chocar, así que con él sólo es el tope.
		const fila: any = (
			await db.execute({ sql: `SELECT ok, error_code, sent_at_ms FROM email_sends WHERE id = ?1;`, args: [envio.id] })
		).rows?.[0];
		if (Number(fila?.ok) === 1) return "ya_enviado";
		if (fila?.error_code === "enviando" && Number(fila.sent_at_ms) > ahora - ENVIANDO_MAX_MS) return "en_curso";
		return "tope";
	} catch (e: any) {
		capturarError(e, "email.quota");
		console.error("[email] no se pudo reservar el cupo diario:", String(e?.message || e));
		return "sin_base";
	}
}

/**
 * Apunta cómo acabó el envío (`ok`, y el código del binding si falló) en la fila que puso
 * `reservarCupo`. Si la reserva no llegó a la base (`sin_base`), la fila se crea aquí: por eso va
 * por el id con `ON CONFLICT(id) DO UPDATE`, que cierra la reserva cuando la hay.
 *
 * AUD-41: al cerrar, `sent_at_ms` pasa a la hora de después del envío: un envío cuenta desde que
 * salió. Si se quedara la de la reserva, un envío que tarda 30 s dejaría de contar 30 s antes de
 * cumplir sus 24 h, y una ráfaga lenta dejaría sitio a otra entera antes de tiempo.
 *
 * Es **best-effort a propósito**: si Turso falla, se registra en el log del worker y ya está. Un
 * fallo del registro no puede impedir que un bar mande su pedido, y la reserva que se queda en
 * `enviando` sigue contando para el cupo de hoy. Pero se insiste unas veces: un pedido que salió y se
 * queda en `enviando` se puede volver a reservar pasados unos minutos (`reservarCupo`), y un
 * reintento con la misma clave lo mandaría otra vez. Un `ok = 1` no se toca nunca.
 */
async function terminarEnvio(db: Sql, envio: Envio, ok: boolean, errorCode: string | null): Promise<void> {
	for (let intento = 1; ; intento++) {
		try {
			await apuntarComoAcabo(db, envio, ok, errorCode);
			return;
		} catch (e: any) {
			if (intento >= INTENTOS_DE_TERMINAR) {
				capturarError(e, "email.audit");
				console.error("[email] no se pudo registrar el envío:", String(e?.message || e));
				return;
			}
			await new Promise((r) => setTimeout(r, ESPERA_TERMINAR_MS * intento));
		}
	}
}

/** Cuántas veces se intenta apuntar cómo acabó un envío, y cuánto se espera entre una y otra. */
const INTENTOS_DE_TERMINAR = 3;
const ESPERA_TERMINAR_MS = 200;

async function apuntarComoAcabo(db: Sql, envio: Envio, ok: boolean, errorCode: string | null): Promise<void> {
	await db.execute({
		sql: `INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
		      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pedido')
		      ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, error_code = excluded.error_code,
		                                    sent_at_ms = excluded.sent_at_ms
		      WHERE email_sends.ok = 0`,
		args: [envio.id, envio.tenantId, envio.deviceId, envio.toEmail, envio.proveedor, ok ? 1 : 0, errorCode, Date.now()],
	});
}

/* ── Plantillas de email ─────────────────────────────────────────────── */

type Linea = {
	nombre_producto: string;
	cantidad: number;
	precio_unitario?: Dinero | null;
	unidad?: string | null;
};

export function buildText(negocio: IdentidadPedido, notas: string | null, lineas: Linea[]): string {
	let s = `Pedido de ${negocio.nombre} a ${negocio.proveedor}\nCorreo: ${negocio.correo}\n`;
	if (negocio.direccion) s += `Dirección: ${negocio.direccion}\n`;
	if (negocio.telefono) s += `Teléfono: ${negocio.telefono}\n`;
	s += "\n";
	// Sin líneas (pedido solo con notas) no pintamos la tabla: una cabecera con nada debajo parece
	// un correo roto.
	if (lineas.length > 0) {
		s += "Producto                   Cantidad   Precio     Unidad\n";
		s += "------------------------------------------------------\n";
		for (const l of lineas) {
			const precio = l.precio_unitario != null ? enEuros(l.precio_unitario) : "-";
			const unidad = l.unidad ?? "-";
			s += `${l.nombre_producto.padEnd(26).slice(0, 26)} ${String(l.cantidad).padEnd(10)} ${precio.padEnd(10)} ${unidad}\n`;
		}
	}
	if (notas?.trim()) {
		s += `\nNotas: ${notas.trim()}\n`;
	}
	return s;
}

export function buildHtml(negocio: IdentidadPedido, notas: string | null, lineas: Linea[]): string {
	const rows = lineas
		.map((l) => {
			const precio = l.precio_unitario != null ? enEuros(l.precio_unitario) : "—";
			const unidad = l.unidad ?? "—";
			return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb">${esc(l.nombre_producto)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${l.cantidad}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${precio}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb">${esc(unidad)}</td>
      </tr>`;
		})
		.join("\n");

	const notasHtml =
		notas?.trim()
			? `<p style="margin-top:16px;color:#6b7280;font-size:14px"><strong>Notas:</strong> ${esc(notas.trim())}</p>`
			: "";

	// Sin líneas (pedido solo con notas) omitimos la tabla entera: una cabecera sin filas parece un
	// correo roto.
	const tablaHtml =
		lineas.length > 0
			? `<table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
    <thead>
      <tr style="background:#f9fafb">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Producto</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Cantidad</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Precio</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Unidad</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
			: "";

	return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Pedido</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="color:#111827;margin-bottom:4px">Pedido de ${esc(negocio.nombre)}</h2>
  <p>Para ${esc(negocio.proveedor)} · Contacto: ${esc(negocio.correo)}</p>
  ${negocio.direccion ? `<p>Dirección: ${esc(negocio.direccion)}</p>` : ""}
  ${negocio.telefono ? `<p>Teléfono: ${esc(negocio.telefono)}</p>` : ""}
  ${tablaHtml}
  ${notasHtml}
  <p style="margin-top:24px;font-size:12px;color:#9ca3af">Enviado desde TPV · Altaria Lights</p>
</body>
</html>`;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
