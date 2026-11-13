// src/domains/admin/admin.schemas.ts
//
// Lo que la administración valida de una query. Vive aquí, con nombre, para que el barrido de
// AUD-27 (`test/sinDatosPersonalesEnLaQuery.node.test.ts`) pueda leer qué claves admite.

import * as z from "zod";

/** `GET /v1/admin/diagnostico/latencias`: cuántas vueltas dar y, si se quiere, contra qué negocio. */
export const diagnosticoSchema = z.object({
	vueltas: z.coerce.number().int().min(1).max(30).default(10),
	tenant: z.string().min(1).max(100).optional(),
});
