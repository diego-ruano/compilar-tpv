// test/negociosHuerfanos.test.ts
//
// AUD-09 · POST /v1/admin/negocios-huerfanos: los negocios que ninguna licencia apunta.
//
// Son los que dejaban las activaciones que perdían la carrera por una clave, cada uno con su base
// aprovisionada en su TenantHub. La ruta borra bases en producción, así que lo que más importa aquí
// es lo que NO toca —el negocio de cualquier licencia, también anulada o sin estrenar con su negocio
// reservado, uno recién creado y uno ya retirado— y que sin pedirlo expresamente sólo lista. La base
// central va sobre el SQLite de un Durable Object; los TenantHub son los de verdad.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { adminRoutes } = await import("../src/domains/admin/admin.routes");
const { MARGEN_MS } = await import("../src/domains/admin/huerfanos");

const TOKEN = "token-de-pruebas";
const ENV = {
	...(entorno as any),
	ADMIN_API_TOKEN: TOKEN,
	TURSO_DATABASE_URL: "libsql://pruebas",
	TURSO_AUTH_TOKEN: "t",
};
const DIA = 24 * 60 * 60 * 1000;

const stub = (tenantId: string) => (entorno as any).TenantHub.get((entorno as any).TenantHub.idFromName(tenantId));

async function pedir(cuerpo: unknown): Promise<{ status: number; body: any }> {
	const res = await adminRoutes.fetch(
		new Request("https://api/negocios-huerfanos", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify(cuerpo),
		}),
		ENV,
	);
	return { status: res.status, body: await res.json() };
}

/** Un negocio con su base aprovisionada, creado `hace` milisegundos. */
async function negocio(sql: any, tenantId: string, hace: number, status = "active") {
	sql.exec(
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
function licencia(sql: any, tenantId: string, estado: "issued" | "active" | "revoked") {
	const id = `lic-huerfanos-${++n}`;
	const activada = estado !== "issued";
	sql.exec(
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

		await enElHub(`${p}-central`, async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			for (const t of ["licenses", "tenants", "devices", "admin_audit"]) sql.exec(`DELETE FROM ${t};`);
			dbDePruebas = clienteSobre(sql, hub.state.storage);

			// Lo que dejaban las perdedoras: el negocio, su base y la fila de su equipo.
			await negocio(sql, huerfano, 3 * DIA);
			sql.exec(`INSERT INTO devices (device_id, tenant_id, role) VALUES ('equipo-perdedor', ?, 'tpv');`, huerfano);
			await negocio(sql, otroHuerfano, 2 * DIA);
			// Lo que no se toca.
			await negocio(sql, reciente, MARGEN_MS / 2);
			await negocio(sql, conLicencia, 3 * DIA);
			licencia(sql, conLicencia, "active");
			await negocio(sql, anulada, 3 * DIA);
			licencia(sql, anulada, "revoked");
			await negocio(sql, reservado, 3 * DIA);
			licencia(sql, reservado, "issued");
			await negocio(sql, retirado, 3 * DIA, "deleted");

			const estado = (t: string) =>
				sql.exec(`SELECT status FROM tenants WHERE tenant_id = ?;`, t).toArray()[0]?.status;
			const auditorias = () => Number(sql.exec(`SELECT COUNT(*) AS n FROM admin_audit;`).toArray()[0].n);

			// Por defecto, sólo la lista: ni bases vaciadas ni negocios borrados.
			const lista = await pedir({});
			expect(lista.status).toBe(200);
			expect(lista.body).toMatchObject({ ok: true, borrar: false, retirados: 0, fallos: [], quedan: false });
			expect(lista.body.huerfanos.map((h: any) => [h.tenantId, h.equipos])).toEqual([
				[huerfano, 1],
				[otroHuerfano, 0],
			]);
			expect(await stub(huerfano).estaAprovisionado()).toBe(true);
			expect(estado(huerfano)).toBe("active");
			expect(auditorias()).toBe(0);

			// `borrar: false` es lo mismo.
			expect((await pedir({ borrar: false })).body.retirados).toBe(0);
			expect(await stub(otroHuerfano).estaAprovisionado()).toBe(true);

			// Con `borrar: true`.
			const borrado = await pedir({ borrar: true });
			expect(borrado.status).toBe(200);
			expect(borrado.body).toMatchObject({ ok: true, borrar: true, retirados: 2, fallos: [] });
			for (const t of [huerfano, otroHuerfano]) {
				expect(await stub(t).estaAprovisionado()).toBe(false);
				expect(estado(t)).toBe("deleted");
			}
			expect(auditorias()).toBe(1);
			// La fila del equipo se queda: es su identidad, no la del negocio.
			expect(sql.exec(`SELECT COUNT(*) AS n FROM devices;`).toArray()[0].n).toBe(1);

			// Lo demás, como estaba.
			for (const t of [reciente, conLicencia, anulada, reservado, retirado]) {
				expect(await stub(t).estaAprovisionado()).toBe(true);
			}
			expect([reciente, conLicencia, anulada, reservado].map(estado)).toEqual(Array(4).fill("active"));

			// Repetirlo no hace nada.
			const otra = await pedir({ borrar: true });
			expect(otra.body).toMatchObject({ huerfanos: [], retirados: 0 });
		});
	});

	it("un negocio que una licencia empieza a apuntar entre la lista y el borrado no se toca", async () => {
		// No pasa en el uso normal —una reserva estrena siempre un negocio—, pero borrar el de otro no
		// tiene vuelta, así que se vuelve a mirar justo antes.
		const p = `huerfanos-carrera-${Date.now()}`;
		const tenantId = `${p}-negocio`;
		await enElHub(`${p}-central`, async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			for (const t of ["licenses", "tenants", "devices", "admin_audit"]) sql.exec(`DELETE FROM ${t};`);
			const db = clienteSobre(sql, hub.state.storage);
			let listado = false;
			dbDePruebas = {
				...db,
				async execute(q: any) {
					const r = await db.execute(q);
					if (!listado && /SELECT t\.tenant_id AS tenant_id/.test(String(q?.sql ?? q))) {
						listado = true;
						licencia(sql, tenantId, "active");
					}
					return r;
				},
			};
			await negocio(sql, tenantId, 3 * DIA);

			const r = await pedir({ borrar: true });
			expect(r.body.huerfanos.map((h: any) => h.tenantId)).toEqual([tenantId]);
			expect(r.body.retirados).toBe(0);
			expect(await stub(tenantId).estaAprovisionado()).toBe(true);
			expect(sql.exec(`SELECT status FROM tenants;`).toArray()[0].status).toBe("active");
		});
	});

	it("rechaza un `borrar` que no es un booleano, sin tocar nada", async () => {
		const p = `huerfanos-cuerpo-${Date.now()}`;
		await enElHub(`${p}-central`, async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			for (const t of ["licenses", "tenants", "devices", "admin_audit"]) sql.exec(`DELETE FROM ${t};`);
			dbDePruebas = clienteSobre(sql, hub.state.storage);
			await negocio(sql, `${p}-huerfano`, 3 * DIA);

			const r = await pedir({ borrar: "si" });
			expect(r.status).toBe(400);
			expect(await stub(`${p}-huerfano`).estaAprovisionado()).toBe(true);
		});
	});
});
