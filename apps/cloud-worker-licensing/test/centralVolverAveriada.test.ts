// test/centralVolverAveriada.test.ts
//
// La salida de una vuelta a un instante que deja la central sin atender (`baseCentral.instante.ts`):
// a un instante de en medio de una restauración, de antes de una migración que con aquellos datos no
// entra, o de antes de aprovisionarla. La vuelta la deja así, y lo dice; y de cada uno de esos estados
// se sale de las dos maneras, deshaciéndola con el marcador que devolvió (`--marcador`) y volviendo a
// otro instante (`--instante`). El `deshacer` de esa salida devuelve la central a como estaba, sin
// atender: es la prueba de lo que pasó. De punta a punta: por la ruta (`/v1/admin/central/volver`), con
// el reinicio y la espera, y con una plataforma de mentira que vuelve de verdad
// (`conPlataformaQueVuelve`): cada marcador es una foto del objeto, y reiniciar lo deja como la foto y
// lo vuelve a arrancar.

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

type Respuesta = { status: number; body: any };

async function volver(central: Pick<CentralDePrueba, "entorno">, cuerpo: { instanteMs: number } | { marcador: string }): Promise<Respuesta> {
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

const LOS_NEGOCIOS = "SELECT tenant_id, legal_name FROM tenants ORDER BY tenant_id;";

async function conUnNegocio(central: CentralDePrueba): Promise<CentralDePrueba> {
	await filasDe(central, `INSERT INTO tenants (tenant_id, legal_name, created_at_ms, updated_at_ms) VALUES ('t-1', 'Bar Uno', 1, 2);`);
	return central;
}

/** Una central que una vuelta ha dejado sin atender, y con qué se sale. */
type Averiada = {
	central: CentralDePrueba;
	plataforma: Awaited<ReturnType<typeof conPlataformaQueVuelve>>;
	/** Lo que contestó la vuelta que la dejó así: con su `deshacer`. */
	vuelta: Respuesta;
	/** El marcador de un instante en el que estaba sana: adonde se sale con `--instante`. */
	sana: string;
	/** Sus negocios cuando estaba sana, que son los que tiene que volver a tener al salir. */
	negocios: Record<string, unknown>[];
};

/** Que la vuelta dice que la central ha vuelto sin atender, por `error`, y no atiende. */
async function noAtiende(central: CentralDePrueba, r: Respuesta, error: string, estado: Record<string, unknown>) {
	expect(r).toMatchObject({
		status: 503,
		body: {
			ok: false,
			error,
			message: expect.stringMatching(/^La central ha vuelto, pero no atiende\./),
			deshacer: expect.any(String),
			estado,
		},
	});
	expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe(error);
}

const AVERIADAS: [string, () => Promise<Averiada>][] = [
	[
		"a en medio de una restauración, que la deja a medias",
		async () => {
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

			const vuelta = await volver(central, { instanteMs: Date.now() - HORA });
			await noAtiende(central, vuelta, "central_restauracion_a_medias", {
				aprovisionada: false,
				averia: { error: "central_restauracion_a_medias" },
			});
			// Estaba sana al volver: la copia de antes se hizo.
			expect(vuelta.body.copiaDeAntes).toMatch(/^base-central\/antes-de-volver-/);
			return { central, plataforma, vuelta, sana, negocios: [{ tenant_id: "t-1", legal_name: "Bar Uno" }] };
		},
	],
	[
		"a antes de una migración que con aquellos datos no entra, que la deja averiada",
		async () => {
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
			const sana = await plataforma.fotografiar();
			plataforma.alPedirUnInstante(antesDeLaMigracion);

			const vuelta = await volver(central, { instanteMs: Date.now() - HORA });
			await noAtiende(central, vuelta, "central_migracion_fallida", {
				aprovisionada: true,
				averia: { error: "central_migracion_fallida" },
			});
			expect(vuelta.body.copiaDeAntes).toMatch(/^base-central\/antes-de-volver-/);
			const negocios = [
				{ tenant_id: "t-1", legal_name: "Bar" },
				{ tenant_id: "t-2", legal_name: "Bar Dos" },
			];
			return { central, plataforma, vuelta, sana, negocios };
		},
	],
	[
		"a antes de aprovisionarla, que la deja sin esquema (y no lo da por bueno)",
		async () => {
			const central = centralSinAprovisionar();
			const plataforma = await conPlataformaQueVuelve(central);
			const vacia = await plataforma.fotografiar();
			expect((await central.stub.aprovisionar()).ok).toBe(true);
			await conUnNegocio(central);
			const sana = await plataforma.fotografiar();
			plataforma.alPedirUnInstante(vacia);

			const vuelta = await volver(central, { instanteMs: Date.now() - HORA });
			await noAtiende(central, vuelta, "central_sin_aprovisionar", { aprovisionada: false, averia: null });
			expect(vuelta.body.copiaDeAntes).toMatch(/^base-central\/antes-de-volver-/);
			return { central, plataforma, vuelta, sana, negocios: [{ tenant_id: "t-1", legal_name: "Bar Uno" }] };
		},
	],
];

/** Que la central ha salido: atiende, sin nada a medias, con sus negocios. Sin atender no se copia. */
async function haSalido(central: CentralDePrueba, r: Respuesta, destino: string, negocios: Record<string, unknown>[]) {
	expect(r).toMatchObject({
		status: 200,
		body: {
			ok: true,
			destino,
			deshacer: expect.any(String),
			copiaDeAntes: null,
			estado: { aprovisionada: true, averia: null, enCurso: { restauracion: null, vuelta: null } },
		},
	});
	expect(await filasDe(central, LOS_NEGOCIOS)).toEqual(negocios);
	expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(negocios.length);
}

describe.each(AVERIADAS)("una vuelta %s", (_como, dejarla) => {
	it("deshacerla con su marcador (--marcador) la saca", async () => {
		const { central, vuelta, negocios } = await dejarla();
		const salida = await volver(central, { marcador: vuelta.body.deshacer });
		await haSalido(central, salida, vuelta.body.deshacer, negocios);
	});

	it("volver a otro instante (--instante) la saca; y el deshacer de esa salida la devuelve a como estaba, que es la prueba", async () => {
		const { central, plataforma, vuelta, sana, negocios } = await dejarla();
		plataforma.alPedirUnInstante(sana);
		const salida = await volver(central, { instanteMs: Date.now() - HORA / 2 });
		await haSalido(central, salida, sana, negocios);

		const otraVez = await volver(central, { marcador: salida.body.deshacer });
		await noAtiende(central, otraVez, vuelta.body.error, { aprovisionada: vuelta.body.estado.aprovisionada });
	});
});
