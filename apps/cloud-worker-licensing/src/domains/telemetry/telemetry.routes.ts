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
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { SpoolEvent } from "@tpv/contracts";
import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { ingestToAxiom } from "../../observability/axiom";
import { cuerpo } from "../../lib/validacion";

type Ctx = { Bindings: Env; Variables: TenantVars };

// `tenant_id`/`device_id` los fija el SERVIDOR desde el JWT (el cliente no los manda). El resto de
// campos de `SpoolEvent` son los que sube el dispositivo y deben coincidir 1:1 con el zod de abajo.
type ServerSetKeys = "tenant_id" | "device_id";
type ClientEventKeys = Exclude<keyof SpoolEvent, ServerSetKeys>;

// Tope de eventos por lote (== tamaño de lote del dispositivo, 500).
const MAX_EVENTS = 500;
// Tope del cuerpo (bytes): ~2 MB sobra para 500 eventos de log.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Límite de texto: el cliente recorta antes de firmar; zod rechaza el exceso.
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

// Drift-guard (OBS-05): las claves del zod deben coincidir 1:1 con las de `SpoolEvent` (generado
// desde `crates/tpv-telemetry`, fuente única de verdad). Si en Rust se añade/renombra/quita un
// campo, uno de los dos `extends` deja de ser `true` y este módulo NO compila hasta actualizarlo.
type SchemaKeys = keyof z.infer<typeof eventSchema>;
type AssertSchemaMatchesRust = [
	[SchemaKeys] extends [ClientEventKeys]
		? true
		: ["zod valida claves ausentes en SpoolEvent", Exclude<SchemaKeys, ClientEventKeys>],
	[ClientEventKeys] extends [SchemaKeys]
		? true
		: ["SpoolEvent tiene campos que el zod no valida", Exclude<ClientEventKeys, SchemaKeys>],
];
const _assertSchemaMatchesRust: AssertSchemaMatchesRust = [true, true];
void _assertSchemaMatchesRust;

export const telemetryRoutes = new Hono<Ctx>();

// RI-19: limitar también cuerpos sin Content-Length ANTES de que tenantAuth lea los bytes
// para verificar la firma. El chequeo de la cabecera después de autenticar llegaba tarde.
telemetryRoutes.use("*", bodyLimit({
	maxSize: MAX_BODY_BYTES,
	onError: (c) => c.json({ error: "payload_too_large" }, 413),
}), tenantAuth);

telemetryRoutes.post("/", cuerpo(batchSchema), async (c) => {
	const { events } = c.req.valid("json");

	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");
	const ingestedAtMs = Date.now();

	// Enriquecemos con la identidad AUTENTICADA (no la que diga el cliente) + metadatos de servidor.
	const enriched = events.map((e) => ({
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
