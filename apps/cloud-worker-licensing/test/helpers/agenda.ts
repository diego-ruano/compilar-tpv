// test/helpers/agenda.ts
//
// Correr código dentro de la agenda de reservas web (`AgendaWeb`) de verdad, como `hub.ts` con el
// TenantHub. La «base del negocio» de los tests vive en el mismo SQLite de la agenda (los nombres de
// sus tablas no chocan) y se lee con `clienteSobre`: así el motor lee SQL de verdad sin Turso.

import { env, runInDurableObject } from "cloudflare:test";

import { clienteSobre } from "./clienteSql";
import { conLaHoraDeQuienPregunta } from "../../src/lib/tenantClient";

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
 * Un lector de Turso sobre el SQLite de la agenda, con «ahora» fijo (o el que diga `ahora()` en
 * cada lectura). `espera` hace que cada lectura ceda el turno, como una consulta de red: es lo que
 * deja que dos altas a la vez se crucen.
 */
export function lectorSobre(state: DurableObjectState, ahora: () => string, espera = 0) {
	const db = clienteSobre(state.storage.sql, state.storage);
	return async <T>(_tenantId: string, fn: (db: any, ahora: string) => Promise<T>): Promise<T> => {
		if (espera) await new Promise((r) => setTimeout(r, espera));
		const a = ahora();
		return fn(conLaHoraDeQuienPregunta(db, a), a);
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
	return async <T>(tenantId: string, fn: (db: any, ahora: string) => Promise<T>): Promise<T> => {
		const resultado = await leer(tenantId, fn);
		if (++leidas >= n) soltar();
		await todas;
		return resultado;
	};
}
