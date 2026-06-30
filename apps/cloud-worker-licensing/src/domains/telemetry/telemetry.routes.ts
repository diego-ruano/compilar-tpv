// src/domains/telemetry/telemetry.routes.ts
//
// Endpoint de ingesta de telemetría del dispositivo: POST /v1/telemetry
//
// Los dispositivos (Main/Handy) suben aquí sus lotes de logs y este worker los retransmite a Axiom
// con el TOKEN privado (que nunca sale de la nube). Reglas:
//   - Autenticación device-proof (mismo `tenantAuth` que el resto de negocio).
//   - El `tenant_id`/`device_id` los fija el SERVIDOR desde el JWT, no el cliente (seguridad).
//   - Guardarraíles de servidor: tope de eventos por lote, tope de tamaño del cuerpo y recorte de
//     campos largos. El throttling del cliente protege al cliente honesto; estos topes frenan a un
//     cliente con token robado.
//   - Se ESPERA la ingesta de Axiom: si falla, 5xx para que el dispositivo conserve el lote y
//     reintente ("no perder ninguno"). La latencia no importa: el envío va en un hilo de fondo.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { ingestToAxiom } from "../../observability/axiom";

type Ctx = { Bindings: Env; Variables: TenantVars };

// Tope de eventos por lote (== tamaño de lote del dispositivo, 500).
const MAX_EVENTS = 500;
// Tope del cuerpo (bytes): ~2 MB sobra para 500 eventos de log.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Recorte defensivo de campos de texto largos.
const MAX_MESSAGE_LEN = 4000;

// Por defecto zod DESCARTA las claves desconocidas (allowlist de nivel superior). En particular
// ignora cualquier `tenant_id`/`device_id` que mande el cliente: los fija el servidor.
const eventSchema = z.object({
	ts: z.string().max(64).optional(),
	level: z.string().max(16).optional(),
	target: z.string().max(256).optional(),
	message: z.string().max(MAX_MESSAGE_LEN).optional(),
	fields: z.record(z.unknown()).optional(),
	device_mode: z.string().max(16).optional(),
	app_version: z.string().max(64).optional(),
	environment: z.string().max(32).optional(),
});

const batchSchema = z.object({
	events: z.array(eventSchema).max(MAX_EVENTS),
});

export const telemetryRoutes = new Hono<Ctx>();

telemetryRoutes.use("*", tenantAuth);

telemetryRoutes.post("/", async (c) => {
	// Guardarraíl de tamaño antes de leer el cuerpo entero.
	const contentLength = Number(c.req.header("content-length") || "0");
	if (contentLength > MAX_BODY_BYTES) {
		return c.json({ error: "payload_too_large" }, 413);
	}

	const body = await c.req.json().catch(() => null);
	const parsed = batchSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
	}

	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");
	const ingestedAtMs = Date.now();

	// Enriquecemos con la identidad AUTENTICADA (no la que diga el cliente) + metadatos de servidor.
	const enriched = parsed.data.events.map((e) => ({
		...e,
		_time: e.ts, // Axiom usa `_time` como timestamp del evento.
		tenant_id: tenantId, // fijado por el servidor (seguridad)
		device_id: deviceId, // fijado por el servidor (seguridad)
		service: "tpv-device",
		ingested_at_ms: ingestedAtMs,
	}));

	const dataset = c.env.AXIOM_DATASET || "tpv-device-logs";
	const ok = await ingestToAxiom(c.env, dataset, enriched);
	if (!ok) {
		// Axiom configurado pero la ingesta falló: el dispositivo conserva el lote y reintenta.
		return c.json({ error: "ingest_failed" }, 502);
	}

	return c.json({ ok: true, accepted: enriched.length });
});
