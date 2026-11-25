// test/negociosHuerfanos.test.ts
//
// AUD-09 · POST /v1/admin/negocios-huerfanos: los negocios que ninguna licencia apunta.
//
// Son los que dejaban las activaciones que perdían la carrera por una clave, cada uno con su base
// aprovisionada en su TenantHub. La ruta borra bases en producción, así que lo que más importa aquí
// es lo que NO toca —el negocio de cualquier licencia, también anulada o sin estrenar con su negocio
// reservado, uno recién creado y uno ya retirado— y que sin pedirlo expresamente sólo lista. Cada caso
// tiene su base central de verdad (`helpers/central.ts`); los TenantHub son los de verdad.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { MARGEN_MS } from "../src/domains/admin/huerfanos";

const TOKEN = "token-de-pruebas";
const ENV = {
	...(entorno as any),
	ADMIN_API_TOKEN: TOKEN,
};
const DIA = 24 * 60 * 60 * 1000;

const stub = (tenantId: string) => (entorno as any).TenantHub.get((entorno as any).TenantHub.idFromName(tenantId));

async function pedir(central: Pick<CentralDePrueba, "entorno">, cuerpo: unknown): Promise<{ status: number; body: any }> {
	const res = await adminRoutes.fetch(
		new Request("https://api/negocios-huerfanos", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify(cuerpo),
		}),
		{ ...ENV, ...central.entorno },
	);
	return { status: res.status, body: await res.json() };
}

/** Un negocio con su base aprovisionada, creado `hace` milisegundos. */
async function negocio(central: CentralDePrueba, tenantId: string, hace: number, status = "active") {
	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?);`,
		tenantId,
		status,
		Date.now() - hace,
		Date.now() - hace,
	);
	await stub(tenantId).aprovisionar(tenantId);
}

let n = 0;
/** Una licencia del negocio, en el estado indicado. */
async function licencia(central: CentralDePrueba, tenantId: string, estado: "issued" | "active" | "revoked") {
	const id = `lic-huerfanos-${++n}`;
	const activada = estado !== "issued";
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, disabled, term_months,
		   origin, issued_at_ms, activated_at_ms, customer_email, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, 12, 'stripe', 1, ?, 'bar@ejemplo.test', 1, 1);`,
		id,
		`hash-${id}`,
		tenantId,
		activada ? `main-${id}` : null,
		estado,
		estado === "revoked" ? 1 : 0,
		activada ? 1 : null,
	);
}

/** El `status` del negocio en la central. */
async function estadoDe(central: CentralDePrueba, tenantId: string) {
	const [fila] = await filasDe(central, `SELECT status FROM tenants WHERE tenant_id = ?;`, tenantId);
	return fila?.status;
}

describe("AUD-09 · negocios huérfanos", () => {
	it("sin `borrar` sólo lista; con él vacía su TenantHub y los da por borrados, y nada más", async () => {
		const p = `huerfanos-${Date.now()}`;
		const huerfano = `${p}-huerfano`;
		const otroHuerfano = `${p}-perdedora`;
		const reciente = `${p}-reciente`;
		const conLicencia = `${p}-con-licencia`;
		const anulada = `${p}-anulada`;
		const reservado = `${p}-reservado`;
		const retirado = `${p}-retirado`;

		const central = await centralDePrueba();

		// Lo que dejaban las perdedoras: el negocio, su base y la fila de su equipo.
		await negocio(central, huerfano, 3 * DIA);
		await filasDe(central, `INSERT INTO devices (device_id, tenant_id, role) VALUES ('equipo-perdedor', ?, 'tpv');`, huerfano);
		await negocio(central, otroHuerfano, 2 * DIA);
		// Lo que no se toca.
		await negocio(central, reciente, MARGEN_MS / 2);
		await negocio(central, conLicencia, 3 * DIA);
		await licencia(central, conLicencia, "active");
		await negocio(central, anulada, 3 * DIA);
		await licencia(central, anulada, "revoked");
		await negocio(central, reservado, 3 * DIA);
		await licencia(central, reservado, "issued");
		await negocio(central, retirado, 3 * DIA, "deleted");

		const auditorias = async () => Number((await filasDe(central, `SELECT COUNT(*) AS n FROM admin_audit;`))[0].n);

		// Por defecto, sólo la lista: ni bases vaciadas ni negocios borrados.
		const lista = await pedir(central, {});
		expect(lista.status).toBe(200);
		expect(lista.body).toMatchObject({ ok: true, borrar: false, retirados: 0, fallos: [], quedan: false });
		expect(lista.body.huerfanos.map((h: any) => [h.tenantId, h.equipos])).toEqual([
			[huerfano, 1],
			[otroHuerfano, 0],
		]);
		expect(await stub(huerfano).estaAprovisionado()).toBe(true);
		expect(await estadoDe(central, huerfano)).toBe("active");
		expect(await auditorias()).toBe(0);

		// `borrar: false` es lo mismo.
		expect((await pedir(central, { borrar: false })).body.retirados).toBe(0);
		expect(await stub(otroHuerfano).estaAprovisionado()).toBe(true);

		// Con `borrar: true`.
		const borrado = await pedir(central, { borrar: true });
		expect(borrado.status).toBe(200);
		expect(borrado.body).toMatchObject({ ok: true, borrar: true, retirados: 2, fallos: [] });
		for (const t of [huerfano, otroHuerfano]) {
			expect(await stub(t).estaAprovisionado()).toBe(false);
			expect(await estadoDe(central, t)).toBe("deleted");
		}
		expect(await auditorias()).toBe(1);
		// La fila del equipo se queda: es su identidad, no la del negocio.
		expect(await filasDe(central, `SELECT COUNT(*) AS n FROM devices;`)).toEqual([{ n: 1 }]);

		// Lo demás, como estaba.
		for (const t of [reciente, conLicencia, anulada, reservado, retirado]) {
			expect(await stub(t).estaAprovisionado()).toBe(true);
		}
		const estados = [];
		for (const t of [reciente, conLicencia, anulada, reservado]) estados.push(await estadoDe(central, t));
		expect(estados).toEqual(Array(4).fill("active"));

		// Repetirlo no hace nada.
		const otra = await pedir(central, { borrar: true });
		expect(otra.body).toMatchObject({ huerfanos: [], retirados: 0 });
	});

	it("un negocio que una licencia empieza a apuntar entre la lista y el borrado no se toca", async () => {
		// No pasa en el uso normal —una reserva estrena siempre un negocio—, pero borrar el de otro no
		// tiene vuelta, así que se vuelve a mirar justo antes.
		const p = `huerfanos-carrera-${Date.now()}`;
		const tenantId = `${p}-negocio`;
		const central = await centralDePrueba();
		await negocio(central, tenantId, 3 * DIA);
		// Justo después de que la ruta lea la lista, la licencia aparece en la central.
		let listado = false;
		const conLaLicenciaEntreMedias = centralInterceptada(central, async (metodo, [sentencia], llamar) => {
			const r = await llamar();
			if (!listado && metodo === "ejecutar" && /SELECT t\.tenant_id AS tenant_id/.test((sentencia as SentenciaEnlazada).sql)) {
				listado = true;
				await licencia(central, tenantId, "active");
			}
			return r;
		});

		const r = await pedir(conLaLicenciaEntreMedias, { borrar: true });
		expect(listado).toBe(true);
		expect(r.body.huerfanos.map((h: any) => h.tenantId)).toEqual([tenantId]);
		expect(r.body.retirados).toBe(0);
		expect(await stub(tenantId).estaAprovisionado()).toBe(true);
		expect(await filasDe(central, `SELECT status FROM tenants;`)).toEqual([{ status: "active" }]);
	});

	it("rechaza un `borrar` que no es un booleano, sin tocar nada", async () => {
		const p = `huerfanos-cuerpo-${Date.now()}`;
		const central = await centralDePrueba();
		await negocio(central, `${p}-huerfano`, 3 * DIA);

		const r = await pedir(central, { borrar: "si" });
		expect(r.status).toBe(400);
		expect(await stub(`${p}-huerfano`).estaAprovisionado()).toBe(true);
		expect(await estadoDe(central, `${p}-huerfano`)).toBe("active");
	});
});
