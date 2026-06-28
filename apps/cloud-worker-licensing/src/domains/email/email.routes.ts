// src/domains/email/email.routes.ts
//
// Endpoint de envío de correo gestionado (modo "nuestro servicio").
// El cliente Rust llama POST /v1/email/enviar-pedido con JWT de tenant.
// El worker llama a Resend para enviar el email.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const emailRoutes = new Hono<Ctx>();

emailRoutes.use("*", tenantAuth);

const lineaSchema = z.object({
	nombre_producto: z.string(),
	cantidad: z.number(),
	precio_unitario: z.number().nullable().optional(),
	unidad: z.string().nullable().optional(),
});

const enviarPedidoSchema = z.object({
	email_destino: z.string().email("email_destino inválido"),
	nombre_proveedor: z.string().min(1),
	notas: z.string().nullable().optional(),
	lineas: z.array(lineaSchema).min(1, "El pedido debe tener al menos una línea"),
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

	const from = c.env.RESEND_FROM_ADDRESS || "TPV <noreply@altarialights.com>";

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
		},
		body: JSON.stringify({
			from,
			to: [email_destino],
			subject: `Pedido a ${nombre_proveedor}`,
			html,
			text,
		}),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		console.error("[email] Resend error:", detail);
		return c.json({ error: "email_send_failed" }, 500);
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
	s += "Producto                   Cantidad   Precio     Unidad\n";
	s += "------------------------------------------------------\n";
	for (const l of lineas) {
		const precio = l.precio_unitario != null ? `${l.precio_unitario.toFixed(2)} €` : "-";
		const unidad = l.unidad ?? "-";
		s += `${l.nombre_producto.padEnd(26).slice(0, 26)} ${String(l.cantidad).padEnd(10)} ${precio.padEnd(10)} ${unidad}\n`;
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

	return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Pedido</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="color:#111827;margin-bottom:4px">Pedido a ${esc(proveedor)}</h2>
  <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
    <thead>
      <tr style="background:#f9fafb">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Producto</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Cantidad</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Precio</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Unidad</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
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
