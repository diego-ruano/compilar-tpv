import type { InternalApplyCommand } from "./tenantHub.types";

export type ValorJson = null | string | number | boolean | object;

export type ApplyParams = {
	tenantId: string;
	deviceId: string;
	opId: string;
	commandName: string;
	command: Extract<InternalApplyCommand, { type: "tenantDb.exec" | "tenantDb.transaction" }>;
	cloudPayload?: unknown;
	clientNow?: string;
};

/** Los errores de negocio son datos: RPC no conserva las propiedades de una subclase de Error. */
export type ResultadoAplicacion =
	| { ok: true; data: ValorJson }
	| { ok: false; error: string; status: number; details?: { message: string } };
