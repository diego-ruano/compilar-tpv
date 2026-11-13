// src/lib/hubLocal.ts
//
// ¿La petición en curso se está ejecutando dentro del TenantHub de su negocio? (`lib/enElHub.ts`)
//
// Lo sabe un `AsyncLocalStorage` que abre el DO al ejecutar la ruta (`MotorTenantHub.ejecutarRuta`).
// No es estado del módulo: cada petición ve sólo el suyo, y el de un negocio nunca lo ve otro aunque
// compartan isolate. Con él, las tres piezas que hablan con el DO —`tenantAuth`, las lecturas
// (`tenantClient.ts`) y las escrituras (`hub.ts`)— usan lo que tienen al lado en vez de un RPC.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@libsql/client/web";

import type { ApplyParams, IdentidadDelWorker, ResultadoAplicacion } from "../durableObjects/tenantHub.rpc";

export type HubLocal = {
	/** Quién pregunta, ya comprobado por el Worker. */
	identidad: IdentidadDelWorker;
	/** La base del negocio: el SQLite de este mismo DO. */
	base: () => Promise<Client>;
	/** El motor de escrituras del DO, sin pasar por RPC. */
	aplicar: (params: ApplyParams) => Promise<ResultadoAplicacion>;
	/** ¿Tiene ya su base este negocio? */
	estaAprovisionado: () => boolean;
	/** El alta: el esquema y el administrador inicial (`MotorTenantHub.aprovisionar`). */
	aprovisionar: () => Promise<{ reused: boolean }>;
};

const enCurso = new AsyncLocalStorage<HubLocal>();

/** Ejecuta `fn` como una petición que corre dentro del TenantHub de `hub.identidad.tenantId`. */
export function dentroDelHub<T>(hub: HubLocal, fn: () => Promise<T>): Promise<T> {
	return enCurso.run(hub, fn);
}

/**
 * El TenantHub en el que se ejecuta la petición en curso, o `null` si corre en el Worker. Con
 * `tenantId`, sólo si es el de ese negocio: lo de otro negocio sigue yendo por RPC.
 */
export function hubLocal(tenantId?: string): HubLocal | null {
	const hub = enCurso.getStore();
	if (!hub) return null;
	return tenantId === undefined || hub.identidad.tenantId === tenantId ? hub : null;
}
