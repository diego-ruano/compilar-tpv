import type { FilasEnBruto } from "./tenantHub.sqlite";
import type { InternalApplyCommand } from "./tenantHub.types";

export type ValorJson = null | string | number | boolean | object;

/**
 * Quién pregunta, tal y como lo comprobó el Worker (`tenantAuth`), para una ruta que se ejecuta dentro
 * del TenantHub (`ejecutarRuta`, `lib/enElHub.ts`). Viaja como argumento del RPC, no en la petición.
 */
export type IdentidadDelWorker = {
	tenantId: string;
	deviceId: string;
	token: string;
	licHash: string;
};

export type ApplyParams = {
	tenantId: string;
	deviceId: string;
	opId: string;
	commandName: string;
	command: Extract<InternalApplyCommand, { type: "tenantDb.exec" | "tenantDb.transaction" }>;
	cloudPayload?: unknown;
	clientNow?: string;
};

/**
 * Lo que contesta `consultar` (las lecturas del Worker). Un error SQL viaja como
 * excepción, con su mensaje; uno con status decidido (`HubError`) viaja como dato, porque RPC no
 * conserva las propiedades de una subclase de Error.
 */
export type RespuestaDeConsulta =
	| { ok: true; resultados: FilasEnBruto[] }
	| { ok: false; code: string; status: number; details?: unknown };

/** Los errores de negocio son datos: RPC no conserva las propiedades de una subclase de Error. */
export type ResultadoAplicacion =
	| { ok: true; data: ValorJson }
	| { ok: false; error: string; status: number; details?: { message: string } };
