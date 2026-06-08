// src/domains/configuracion/configuracion.schemas.ts

import { z } from "zod";
import type { ConfigPatchInput } from "@tpv/contracts";

export const configPatchSchema = z.object({
	patch: z.record(z.unknown()).default({}),
});

export type { ConfigPatchInput };
