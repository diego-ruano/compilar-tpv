// src/domains/email/email.routes.ts
//
// Endpoint ÚNICO de envío de correo. Desde DB-04 TODO el correo pasa por aquí (ya no existe el
// "SMTP propio del negocio"): tanto la Main como la Handy llaman POST /v1/email/enviar-pedido con
// JWT de tenant y el worker es quien envía. En offline no se puede enviar (hace falta el worker).
//
// Backend de envío: Cloudflare Email Service, vía el binding `EMAIL` (send_email en wrangler.json).
// El remitente (`from`) sale de las vars EMAIL_FROM_ADDRESS/EMAIL_FROM_NAME y su dominio debe estar
// dado de alta en Email Sending (SPF+DKIM). No se usan claves de API: el binding autentica solo.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const emailRoutes = new Hono<Ctx>();

emailRoutes.use("*", tenantAuth);

const lineaSchema = z.object({
	nombre_producto: z.string().max(200),
	cantidad: z.number(),
	precio_unitario: z.number().nullable().optional(),
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
		return c.json({ error: "email_send_failed", code: e.code ?? null }, 500);
	}

	return c.json({ ok: true });
});

/* ── Plantillas de email ─────────────────────────────────────────────── */

type Linea = {
	nombre_producto: string;
	cantidad: number;
	precio_unitario?: number | null;
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
			const precio = l.precio_unitario != null ? `${l.precio_unitario.toFixed(2)} €` : "-";
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
			const precio = l.precio_unitario != null ? `${l.precio_unitario.toFixed(2)} €` : "—";
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
