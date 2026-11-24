// src/domains/interruptores/interruptores.routes.ts
//
// PROD-06 · Lo que el TPV pregunta cada pocos minutos: qué tiene apagado ahora mismo.
//
//   POST /v1/interruptores  { version? } → { ok, apagados: InterruptorApagado[] }
//
// Va por POST y no por GET porque el cliente de Rust firma POST (`tpv_server_post_json`), y es por
// `tenantAuth` como todas las rutas de negocio: el tenant sale del token, nunca del cuerpo. La
// versión sí viene del cuerpo, y no importa que la invente quien llama: sólo decide qué filas de
// SU tenant le aplican.

import { Hono } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { apagadosPara } from "../../lib/interruptores";
import { cuerpoTolerante } from "../../lib/validacion";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const interruptoresRoutes = new Hono<Ctx>();

interruptoresRoutes.use("*", tenantAuth);

// Tolerante a propósito: un cuerpo roto o sin versión no puede convertirse en un 400, porque la
// respuesta a «no sé qué me preguntas» tiene que seguir siendo la lista de lo apagado para todos.
// Total, como los cuerpos permisivos de `sync`: cualquier entrada da un resultado.
const consultaSchema = z.unknown().transform((entrada) => {
	const v = (entrada as { version?: unknown } | null)?.version;
	const version = typeof v === "string" && v.trim() && v.length <= 40 ? v.trim() : null;
	return { version };
});

interruptoresRoutes.post("/", cuerpoTolerante(consultaSchema), async (c) => {
	const { version } = c.req.valid("json");
	const apagados = await apagadosPara(getDb(c.env), c.get("tenantId"), version);
	return c.json({ ok: true, apagados });
});
