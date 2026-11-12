// src/observability/tiempos.ts
//
// Desglose del tiempo de una petición, en la cabecera `Server-Timing` de la respuesta: cuánto se fue
// en la base central y cuánto en llamadas al TenantHub, y cuántas hubo de cada. Lo lee el generador
// de carga (`scripts/carga`) para saber dónde está el tiempo sin adivinarlo desde fuera.
//
// Sólo mide esperas (red y Durable Object): en un Worker el reloj no avanza mientras se ejecuta
// código, sólo al volver de una E/S, así que la CPU propia no sale aquí.

import { AsyncLocalStorage } from "node:async_hooks";

type Tramo = { n: number; ms: number };
type Medida = { inicio: number; tramos: Map<string, Tramo> };

const actual = new AsyncLocalStorage<Medida>();

/** Ejecuta `fn` con un contador nuevo y lo devuelve con su resultado. */
export async function conMedida<T>(fn: () => Promise<T>): Promise<{ resultado: T; medida: Medida }> {
	const medida: Medida = { inicio: Date.now(), tramos: new Map() };
	const resultado = await actual.run(medida, fn);
	return { resultado, medida };
}

/** Suma lo que tarda `fn` al tramo `nombre` de la petición en curso (si la hay). */
export async function medirTramo<T>(nombre: string, fn: () => Promise<T>): Promise<T> {
	const medida = actual.getStore();
	if (!medida) return fn();
	const t0 = Date.now();
	try {
		return await fn();
	} finally {
		const tramo = medida.tramos.get(nombre) ?? { n: 0, ms: 0 };
		tramo.n += 1;
		tramo.ms += Date.now() - t0;
		medida.tramos.set(nombre, tramo);
	}
}

/**
 * Una ruta que se ejecuta dentro del TenantHub (`lib/enElHub.ts`) trae su propio desglose en la
 * respuesta. Se suma al de la petición con `en-hub-` delante (`en-hub-total`, `en-hub-central`…), para
 * ver qué parte del viaje es trabajo del DO y cuál es red.
 */
export function anotarDesgloseDelHub(cabecera: string | null): void {
	const medida = actual.getStore();
	if (!medida || !cabecera) return;
	for (const parte of cabecera.split(",")) {
		const nombre = parte.trim().split(";")[0];
		const ms = Number(/dur=([\d.]+)/.exec(parte)?.[1]);
		if (!nombre || nombre === "colo" || !Number.isFinite(ms)) continue;
		const n = Number(/desc="?(\d+)/.exec(parte)?.[1] ?? 1);
		medida.tramos.set(`en-hub-${nombre}`, { n, ms });
	}
}

/** `central;dur=12;desc="2", hub;dur=8;desc="1", total;dur=25, colo;desc="CDG"`. */
export function cabeceraServerTiming(medida: Medida, colo: string | undefined): string {
	const partes = [...medida.tramos].map(([nombre, t]) => `${nombre};dur=${t.ms};desc="${t.n}"`);
	partes.push(`total;dur=${Date.now() - medida.inicio}`);
	if (colo) partes.push(`colo;desc="${colo}"`);
	return partes.join(", ");
}
