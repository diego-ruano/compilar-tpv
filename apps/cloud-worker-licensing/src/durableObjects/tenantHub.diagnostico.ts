// src/durableObjects/tenantHub.diagnostico.ts
//
// Lo que contesta un TenantHub a la ruta de diagnóstico de latencias (`/v1/admin/diagnostico/latencias`):
// dónde está, y cuánto le cuesta leer, escribir y llegar a la base central. Las escrituras sólo se
// hacen en un objeto de usar y tirar, nunca en el de un negocio.

import type { Env } from "../env";
import { createDbClient } from "../server/db/clients";

export type AccionDeDiagnostico =
	| { accion: "donde" }
	| { accion: "ping" }
	| { accion: "lee" }
	| { accion: "escribe" }
	| { accion: "central"; vueltas: number };

export type RespuestaDeDiagnostico = {
	colo?: string;
	loc?: string;
	ms?: number[];
	filas?: number;
	tieneBase?: boolean;
};

const MAX_VUELTAS = 30;

/** El centro de datos donde se ejecuta este código, según el propio Cloudflare. */
async function dondeEstoy(): Promise<{ colo?: string; loc?: string; ms: number }> {
	const t0 = Date.now();
	const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
	const texto = await r.text();
	const ms = Date.now() - t0;
	const campo = (k: string) => texto.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
	return { colo: campo("colo"), loc: campo("loc"), ms };
}

export async function diagnosticar(
	ctx: DurableObjectState,
	env: Env,
	a: AccionDeDiagnostico,
): Promise<RespuestaDeDiagnostico> {
	const sql = ctx.storage.sql;
	switch (a.accion) {
		case "donde": {
			const d = await dondeEstoy();
			const tieneBase = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Comandas'").toArray().length > 0;
			return { colo: d.colo, loc: d.loc, ms: [d.ms], tieneBase };
		}
		case "ping":
			return {};
		case "lee":
			return { filas: Number(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master").one().n) };
		case "escribe": {
			const tieneBase = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Comandas'").toArray().length > 0;
			if (tieneBase) throw new Error("diagnostico: no se escribe en el TenantHub de un negocio");
			sql.exec("CREATE TABLE IF NOT EXISTS _Diagnostico (n INTEGER)");
			sql.exec("INSERT INTO _Diagnostico (n) VALUES (1)");
			return {};
		}
		case "central": {
			const db = createDbClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
			const ms: number[] = [];
			for (let i = 0; i < Math.min(a.vueltas, MAX_VUELTAS); i++) {
				const t0 = Date.now();
				await db.execute("SELECT 1");
				ms.push(Date.now() - t0);
			}
			return { ms };
		}
	}
}
