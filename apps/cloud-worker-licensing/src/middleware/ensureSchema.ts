// src/middleware/ensureSchema.ts
//
// Provisiona el esquema de licencias antes de servir cualquier ruta de licencia/admin/stripe.
// Es un no-op tras la primera petición del isolate (guardado por un flag en licenseStore), así
// que el coste es una comprobación por arranque, no por request.

import type { MiddlewareHandler } from "hono";

import type { Env } from "../env";
import { getDb } from "../server/db";
import { ensureLicensingSchema } from "../server/licenseStore";

export const ensureLicensingSchemaMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	await ensureLicensingSchema(getDb(c.env));
	await next();
};
