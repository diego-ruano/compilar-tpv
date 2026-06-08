// src/domains/configuracion/configuracion.schemas.ts

import { z } from "zod";

export const configPatchSchema = z.object({
	patch: z.record(z.unknown()).default({}),
});

export type ConfigPatchInput = z.infer<typeof configPatchSchema>;
