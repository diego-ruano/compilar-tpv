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
// Cada envío deja traza en `email_sends` (control-plane), que es de donde sale el recuento.

import { Hono } from "hono";
import type { Dinero } from "@tpv/contracts";
import { enEuros, zDineroOpcional } from "../../lib/dinero";
import { z } from "zod";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb, type Sql } from "../../server/db";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const emailRoutes = new Hono<Ctx>();

emailRoutes.use("*", tenantAuth);

const lineaSchema = z.object({
	nombre_producto: z.string().max(200),
	cantidad: z.number(),
	precio_unitario: zDineroOpcional,
	unidad: z.string().max(50).nullable().optional(),
});

// Un pedido se puede enviar con líneas, con notas, o con ambas — pero NO vacío: un correo sin nada
// que pedir no le dice nada al proveedor. Antes se exigía `min(1)` línea, lo que impedía el caso
// legítimo de "pedido solo con notas" (p. ej. "mándame lo de siempre").
const enviarPedidoSchema = z
	.object({
		email_destino: z.string().email("email_destino inválido"),
		nombre_proveedor: z.string().min(1).max(200),
		notas: z.string().max(2000).nullable().optional(),
		lineas: z.array(lineaSchema).max(500).default([]),
	})
	.refine((v) => v.lineas.length > 0 || (v.notas ?? "").trim().length > 0, {
		message: "El pedido debe llevar al menos una línea o unas notas",
		path: ["lineas"],
	});

emailRoutes.post("/enviar-pedido", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = enviarPedidoSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
	}

	const { email_destino, nombre_proveedor, notas, lineas } = parsed.data;
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");

	if (await pasaDelTope(getDb(c.env), tenantId)) {
		return c.json({ error: "email_limite_diario" }, 429);
	}

	// FABLE-C — el destinatario NO lo elige libremente el dispositivo: tiene que ser el correo de un
	// proveedor dado de alta en ESTE tenant. Sin esto, un token robado podía usar nuestro dominio
	// (con su SPF/DKIM) para mandar correo a cualquier dirección del mundo. Es el control real de
	// abuso: acota a quién se puede escribir, en vez de cuánto.
	const autorizado = await tenantQuery(c, async (db) => {
		const r = await db.execute({
			sql: `SELECT 1 FROM Proveedores
			      WHERE Email IS NOT NULL AND lower(trim(Email)) = lower(trim(?1))
			      LIMIT 1`,
			args: [email_destino],
		});
		return (r.rows?.length ?? 0) > 0;
	});

	if (!autorizado) {
		return c.json({ error: "email_destino_no_autorizado" }, 403);
	}

	const html = buildHtml(nombre_proveedor, notas ?? null, lineas);
	const text = buildText(nombre_proveedor, notas ?? null, lineas);

	const fromAddress = c.env.EMAIL_FROM_ADDRESS;
	if (!fromAddress) return c.json({ error: "missing_env_EMAIL_FROM_ADDRESS" }, 500);
	const from: EmailAddress = { email: fromAddress, name: c.env.EMAIL_FROM_NAME || "TPV" };

	try {
		await c.env.EMAIL.send({
			from,
			to: email_destino,
			subject: `Pedido a ${nombre_proveedor}`,
			html,
			text,
		});
	} catch (err) {
		// El binding lanza Error con `.code` (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED, …).
		const e = err as { code?: string; message?: string };
		console.error("[email] Cloudflare Email Service error:", e.code ?? "", e.message ?? err);
		await registrarEnvio(c.env, tenantId, deviceId, email_destino, nombre_proveedor, false, e.code ?? null);
		// El código del binding va en `detalle`: `code` es el del catálogo compartido.
		return c.json({ error: "email_send_failed", detalle: e.code ?? null }, 500);
	}

	await registrarEnvio(c.env, tenantId, deviceId, email_destino, nombre_proveedor, true, null);
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
 * ¿Este negocio ya ha gastado su cupo de hoy?
 *
 * Dos decisiones que importan:
 *   · **Sólo cuentan los ENTREGADOS** (`ok = 1`). Un proveedor con el buzón lleno, o una caída de
 *     nuestro proveedor de correo, no pueden gastarle el cupo a un bar que no ha mandado nada.
 *     Y lo que se protege es la reputación del dominio, que sólo sufre con lo que sale.
 *   · **Si no se puede contar, se deja pasar.** Es la misma regla que el registro de abajo: Turso
 *     caído no puede impedir que un bar mande su pedido. Un tope que convierte una caída nuestra
 *     en «no puedes trabajar» cuesta más de lo que evita.
 */
export async function pasaDelTope(db: Sql, tenantId: string): Promise<boolean> {
	try {
		const r = await db.execute({
			sql: `SELECT COUNT(*) AS n FROM email_sends
			      WHERE tenant_id = ?1 AND ok = 1 AND sent_at_ms > ?2`,
			args: [tenantId, Date.now() - VENTANA_MS],
		});
		return Number((r.rows?.[0] as any)?.n ?? 0) >= TOPE_DIARIO;
	} catch (e: any) {
		console.error("[email] no se pudo contar el cupo diario:", String(e?.message || e));
		return false;
	}
}

/**
 * Deja traza del envío en el control-plane (tabla `email_sends`, ver
 * `docs/sql/control-plane/esquema-actual.sql`), y es además de donde sale el recuento del tope.
 *
 * Es **best-effort a propósito**: si la tabla no existe todavía o Turso falla, se registra en el
 * log del worker y ya está. Un fallo del registro no puede impedir que un bar mande su pedido.
 */
async function registrarEnvio(
	env: Env,
	tenantId: string,
	deviceId: string,
	toEmail: string,
	proveedor: string,
	ok: boolean,
	errorCode: string | null,
): Promise<void> {
	try {
		await getDb(env).execute({
			sql: `INSERT INTO email_sends
			        (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms)
			      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			args: [
				crypto.randomUUID(),
				tenantId,
				deviceId,
				toEmail,
				proveedor,
				ok ? 1 : 0,
				errorCode,
				Date.now(),
			],
		});
	} catch (e: any) {
		console.error("[email] no se pudo registrar el envío:", String(e?.message || e));
	}
}

/* ── Plantillas de email ─────────────────────────────────────────────── */

type Linea = {
	nombre_producto: string;
	cantidad: number;
	precio_unitario?: Dinero | null;
	unidad?: string | null;
};

function buildText(proveedor: string, notas: string | null, lineas: Linea[]): string {
	let s = `Pedido a ${proveedor}\n\n`;
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

function buildHtml(proveedor: string, notas: string | null, lineas: Linea[]): string {
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
  <h2 style="color:#111827;margin-bottom:4px">Pedido a ${esc(proveedor)}</h2>
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
