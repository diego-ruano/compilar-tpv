// src/domains/admin/diagnostico.ts
//
// `/v1/admin/diagnostico/latencias`: cuánto cuesta cada viaje desde el Worker que atiende la
// petición —a la base central de Turso y a un TenantHub— según dónde nazca el TenantHub. Crea un
// objeto de usar y tirar por cada ubicación, lo mide y lo borra. Con `tenant`, mide además el
// TenantHub de ese negocio, sin escribir en él.

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import { hubDe } from "../../lib/hub";
import { objetoEn, type Colocacion } from "../../lib/objetosDelNegocio";

type Ubicacion = { nombre: string } & Colocacion;

/**
 * Las colocaciones que se comparan. La del despliegue es `weur` (sin jurisdicción y con la pista
 * de Europa occidental); las demás están para ver lo que costaría cada una.
 */
const UBICACIONES: Ubicacion[] = [
	{ nombre: "eu", jurisdiccion: "eu" },
	{ nombre: "eu+weur", jurisdiccion: "eu", pista: "weur" },
	{ nombre: "sin", },
	{ nombre: "weur", pista: "weur" },
];

const mediana = (xs: number[]) => {
	if (!xs.length) return null;
	const o = [...xs].sort((a, b) => a - b);
	const m = Math.floor(o.length / 2);
	return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};

async function veces(n: number, fn: () => Promise<unknown>): Promise<number[]> {
	const ms: number[] = [];
	for (let i = 0; i < n; i++) {
		const t0 = Date.now();
		await fn();
		ms.push(Date.now() - t0);
	}
	return ms;
}

const resumen = (ms: number[]) => ({ mediana: mediana(ms), min: Math.min(...ms), max: Math.max(...ms), ms });

export async function medirLatencias(env: Env, coloDelWorker: string | undefined, vueltas: number, tenantId?: string) {
	const central = await veces(vueltas, () => getDb(env).execute("SELECT 1"));
	const salida: Record<string, unknown> = { worker: coloDelWorker, central: resumen(central), ubicaciones: {} };

	for (const u of UBICACIONES) {
		const stub = objetoEn(env.TenantHub, `diagnostico-${u.nombre}-${crypto.randomUUID()}`, u);
		try {
			const t0 = Date.now();
			const donde = await stub.diagnostico({ accion: "donde" });
			const primera = Date.now() - t0;
			const ping = await veces(vueltas, () => stub.diagnostico({ accion: "ping" }));
			const lee = await veces(vueltas, () => stub.diagnostico({ accion: "lee" }));
			const escribe = await veces(vueltas, () => stub.diagnostico({ accion: "escribe" }));
			const desdeElDo = await stub.diagnostico({ accion: "central", vueltas });
			(salida.ubicaciones as Record<string, unknown>)[u.nombre] = {
				colo: donde.colo,
				primeraLlamadaMs: primera,
				ping: resumen(ping),
				lee: resumen(lee),
				escribe: resumen(escribe),
				centralDesdeElDo: resumen(desdeElDo.ms ?? []),
			};
		} catch (e) {
			(salida.ubicaciones as Record<string, unknown>)[u.nombre] = { error: String((e as Error)?.message ?? e) };
		} finally {
			await stub.borrarTodo().catch(() => undefined);
		}
	}

	if (tenantId) {
		const stub = hubDe(env, tenantId);
		const donde = await stub.diagnostico({ accion: "donde" });
		const ping = await veces(vueltas, () => stub.diagnostico({ accion: "ping" }));
		const lee = await veces(vueltas, () => stub.diagnostico({ accion: "lee" }));
		const desdeElDo = await stub.diagnostico({ accion: "central", vueltas });
		salida.negocio = { colo: donde.colo, tieneBase: donde.tieneBase, ping: resumen(ping), lee: resumen(lee), centralDesdeElDo: resumen(desdeElDo.ms ?? []) };
	}
	return salida;
}
