// test/helpers/agenda.ts
//
// Correr código dentro de la agenda de reservas web (`AgendaWeb`) de verdad, como `hub.ts` con el
// TenantHub. La «base del negocio» de los tests vive en el mismo SQLite de la agenda (los nombres de
// sus tablas no chocan) y se lee con el cliente de producción de la base del negocio (`clienteLocal`).

import { env, runInDurableObject } from "cloudflare:test";

import { clienteLocal } from "../../src/durableObjects/tenantHub.sqlite";
import { conLaHoraDeQuienPregunta } from "../../src/lib/tenantClient";
import { ejecutarLecturaWeb } from "../../src/domains/reservas_web/lecturasDeLaWeb";

const ejecutar = runInDurableObject as unknown as (
	stub: unknown,
	callback: (instancia: any, state: DurableObjectState) => unknown,
) => Promise<unknown>;

export function stubDeLaAgenda(nombre: string): any {
	const ns = (env as any).AgendaWeb as DurableObjectNamespace;
	return ns.get(ns.idFromName(nombre));
}

/** Corre `callback` dentro de la agenda `nombre`, con su motor y su estado. */
export async function enLaAgenda<R>(
	nombre: string,
	callback: (motor: any, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
	return (await ejecutar(stubDeLaAgenda(nombre), (instancia, state) => callback(instancia.motor, state))) as R;
}

/**
 * Corre `callback` dentro de la agenda `nombre`, con el objeto entero: sus llamadas tal como llegan
 * por RPC, que es donde se ponen en fila con la retirada del negocio.
 */
export async function enElObjetoDeLaAgenda<R>(
	nombre: string,
	callback: (agenda: any, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
	return (await ejecutar(stubDeLaAgenda(nombre), (instancia, state) => callback(instancia, state))) as R;
}

/**
 * Un lector de la base del negocio sobre el SQLite de la agenda, con «ahora» fijo (o el que diga
 * `ahora()` en cada lectura): las mismas lecturas que hace el TenantHub (`lecturasDeLaWeb.ts`), sin el
 * viaje. `espera` hace que cada lectura ceda el turno, como el viaje: es lo que deja que dos altas a
 * la vez se crucen.
 */
export function lectorSobre(state: DurableObjectState, ahora: () => string, espera = 0) {
	const db = clienteLocal(state.storage);
	return async (_tenantId: string, lectura: any): Promise<any> => {
		if (espera) await new Promise((r) => setTimeout(r, espera));
		const a = ahora();
		// La hora del negocio la fija el test: `horaDelNegocio` leería el reloj de verdad.
		return ejecutarLecturaWeb(conLaHoraDeQuienPregunta(db, a), a, lectura);
	};
}

/**
 * Un lector que no deja seguir a nadie hasta que `n` peticiones han terminado de leer: así todas
 * deciden con una lectura en la que la mesa estaba libre, que es el cruce que la agenda tiene que
 * aguantar. Sin barrera, la primera podría leer, decidir y apuntar antes de que la segunda leyera.
 */
export function lectorConBarrera(state: DurableObjectState, ahora: () => string, n: number) {
	const leer = lectorSobre(state, ahora);
	let leidas = 0;
	let soltar!: () => void;
	const todas = new Promise<void>((r) => (soltar = r));
	return async (tenantId: string, lectura: any): Promise<any> => {
		const resultado = await leer(tenantId, lectura);
		if (++leidas >= n) soltar();
		await todas;
		return resultado;
	};
}
