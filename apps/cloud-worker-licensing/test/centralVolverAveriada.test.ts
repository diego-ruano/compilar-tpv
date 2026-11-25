// test/centralVolverAveriada.test.ts
//
// La salida de una vuelta a un instante que deja la central sin atender (`baseCentral.instante.ts`):
// a un instante de en medio de una restauración, de antes de una migración que con aquellos datos no
// entra, o de antes de aprovisionarla. La vuelta la deja así, y lo dice; deshacerla con el marcador
// que devolvió, o volver a otro instante, la saca. De punta a punta: por la ruta
// (`/v1/admin/central/volver`), con el reinicio y la espera, y con una plataforma de mentira que
// vuelve de verdad (`conPlataformaQueVuelve`): cada marcador es una foto del objeto, y reiniciar lo
// deja como la foto y lo vuelve a arrancar.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Migracion } from "../src/durableObjects/sqliteDelObjeto";
import {
	centralDePrueba,
	centralSinAprovisionar,
	codigoDe,
	conPlataformaQueVuelve,
	filasDe,
	type CentralDePrueba,
} from "./helpers/central";

const { deMas } = vi.hoisted(() => ({
	/** Las migraciones de la central que «trae el despliegue», detrás de las de verdad. */
	deMas: [] as Migracion[],
}));

vi.mock("../src/server/central/migraciones", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/central/migraciones")>();
	return {
		...original,
		get MIGRACIONES_DE_LA_CENTRAL() {
			return [...original.MIGRACIONES_DE_LA_CENTRAL, ...deMas];
		},
	};
});

const { adminRoutes } = await import("../src/domains/admin/admin.routes");
const { CLAVE_RESTAURACION_EN_CURSO } = await import("../src/durableObjects/baseCentral.guardas");

afterEach(() => {
	deMas.length = 0;
});

const TOKEN = "token-de-pruebas";
const HORA = 3_600_000;

async function volver(central: Pick<CentralDePrueba, "entorno">, cuerpo: { instanteMs: number } | { marcador: string }) {
	const res = await adminRoutes.fetch(
		new Request("https://api/central/volver", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify(cuerpo),
		}),
		{ ...(env as any), ADMIN_API_TOKEN: TOKEN, ...central.entorno },
	);
	return { status: res.status, body: (await res.json()) as any };
}

const LA_DEL_NEGOCIO = [{ tenant_id: "t-1" }];

async function conUnNegocio(central: CentralDePrueba): Promise<CentralDePrueba> {
	await filasDe(central, `INSERT INTO tenants (tenant_id, legal_name, created_at_ms, updated_at_ms) VALUES ('t-1', 'Bar Uno', 1, 2);`);
	return central;
}

describe("una vuelta que deja la central sin atender se deshace, o se vuelve a otro instante", () => {
	it("a en medio de una restauración: la deja a medias, y deshacerla con su marcador la saca", async () => {
		const central = await conUnNegocio(await centralDePrueba());
		const plataforma = await conPlataformaQueVuelve(central);
		const sana = await plataforma.fotografiar();
		// El instante: una restauración a medias, con su marca y las filas a medio cargar.
		await runInDurableObject(env.BaseCentral.get(central.stub.id), (_o, state) => {
			state.storage.sql.exec("DELETE FROM tenants;");
			state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/la-de-entonces.sql.gz", desdeMs: 1 });
		});
		const aMedias = await plataforma.fotografiar();
		await plataforma.ponerLaFoto(sana);
		plataforma.alPedirUnInstante(aMedias);

		const r = await volver(central, { instanteMs: Date.now() - HORA });
		expect(r).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: "central_restauracion_a_medias",
				message: expect.stringMatching(/^La central ha vuelto, pero no atiende\./),
				deshacer: expect.any(String),
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
				estado: { aprovisionada: false, averia: { error: "central_restauracion_a_medias" } },
			},
		});
		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_restauracion_a_medias");

		const deshecha = await volver(central, { marcador: r.body.deshacer });
		expect(deshecha).toMatchObject({
			status: 200,
			body: {
				ok: true,
				destino: r.body.deshacer,
				// A medias no se copia como una central sana.
				copiaDeAntes: null,
				estado: { aprovisionada: true, averia: null, enCurso: { restauracion: null, vuelta: null } },
			},
		});
		expect(await filasDe(central, "SELECT tenant_id FROM tenants;")).toEqual(LA_DEL_NEGOCIO);
		expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(1);
	});

	it("a antes de una migración que con aquellos datos no entra: la deja averiada, y volver a otro instante (con --instante) la saca", async () => {
		const central = await centralDePrueba();
		await filasDe(
			central,
			`INSERT INTO tenants (tenant_id, legal_name, created_at_ms, updated_at_ms) VALUES ('t-1', 'Bar', 1, 2), ('t-2', 'Bar', 3, 4);`,
		);
		const plataforma = await conPlataformaQueVuelve(central);
		// El instante: dos negocios con el mismo nombre y sin la migración que lo prohíbe.
		const antesDeLaMigracion = await plataforma.fotografiar();
		await filasDe(central, "UPDATE tenants SET legal_name = 'Bar Dos' WHERE tenant_id = 't-2';");
		deMas.push({ name: "9001_nombre_unico.sql", sql: "CREATE UNIQUE INDEX ux_prueba_nombre_unico ON tenants (legal_name);" });
		await central.stub.reiniciar();
		expect((await central.stub.estado()).migraciones.map((m) => m.nombre)).toEqual(["0001_inicial.sql", "9001_nombre_unico.sql"]);
		const conLaMigracion = await plataforma.fotografiar();
		plataforma.alPedirUnInstante(antesDeLaMigracion);

		const r = await volver(central, { instanteMs: Date.now() - HORA });
		expect(r).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: "central_migracion_fallida",
				message: expect.stringMatching(/^La central ha vuelto, pero no atiende\./),
				deshacer: expect.any(String),
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
				estado: { aprovisionada: true, averia: { error: "central_migracion_fallida" } },
			},
		});
		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_migracion_fallida");

		plataforma.alPedirUnInstante(conLaMigracion);
		const otra = await volver(central, { instanteMs: Date.now() - HORA / 2 });
		expect(otra).toMatchObject({
			status: 200,
			body: {
				ok: true,
				destino: conLaMigracion,
				copiaDeAntes: null,
				estado: { aprovisionada: true, averia: null, migraciones: [{ nombre: "0001_inicial.sql" }, { nombre: "9001_nombre_unico.sql" }] },
			},
		});
		expect(await filasDe(central, "SELECT tenant_id, legal_name FROM tenants ORDER BY tenant_id;")).toEqual([
			{ tenant_id: "t-1", legal_name: "Bar" },
			{ tenant_id: "t-2", legal_name: "Bar Dos" },
		]);
	});

	it("a antes de aprovisionarla: la deja sin esquema, no lo da por bueno, y deshacerla con su marcador la saca", async () => {
		const central = centralSinAprovisionar();
		const plataforma = await conPlataformaQueVuelve(central);
		const vacia = await plataforma.fotografiar();
		expect((await central.stub.aprovisionar()).ok).toBe(true);
		await conUnNegocio(central);
		plataforma.alPedirUnInstante(vacia);

		const r = await volver(central, { instanteMs: Date.now() - HORA });
		expect(r).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: "central_sin_aprovisionar",
				message: expect.stringMatching(/^La central ha vuelto, pero no atiende\./),
				deshacer: expect.any(String),
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
				estado: { aprovisionada: false, averia: null },
			},
		});
		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_sin_aprovisionar");

		const deshecha = await volver(central, { marcador: r.body.deshacer });
		expect(deshecha).toMatchObject({
			status: 200,
			body: { ok: true, destino: r.body.deshacer, copiaDeAntes: null, estado: { aprovisionada: true, averia: null } },
		});
		expect(await filasDe(central, "SELECT tenant_id FROM tenants;")).toEqual(LA_DEL_NEGOCIO);
	});
});
