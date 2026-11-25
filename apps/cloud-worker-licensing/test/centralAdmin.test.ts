// test/centralAdmin.test.ts
//
// La base central desde la administración (`domains/admin/central.ts`, `/v1/admin/central/*`), con
// objetos `BaseCentral` de verdad; el único doble es el de la vuelta a un instante (`Instantes`), que
// en local no existe.
//
//   · sin el token de administración no entra nada, y se dice antes de leer el cuerpo;
//   · el token no lee la central: todo contesta también con ella sin aprovisionar;
//   · la clave de una copia se valida antes de llegar al objeto;
//   · el recorrido entero: copiar ahora, aprovisionar otra central desde esa copia y ver su estado;
//   · volver a un instante: prepara, deja en el rastro con qué se deshace, reinicia, espera y lo
//     devuelve, y la lista de las copias lo enseña; una central que vuelve pero no atiende no se da
//     por buena;
//   · restaurar y volver dejan en el rastro que empiezan antes de llamar al objeto, y que la llamada
//     no ha vuelto si no vuelve;
//   · lo que no se hace dice qué pasa (`message`) y, aparte, el motivo técnico (`detalle`);
//   · lo que cambia algo deja rastro en el log, sin datos personales ni texto que no sea nuestro: la
//     clave y el marcador pasan una gramática cerrada antes de llegar al objeto, y el `detalle` no va
//     al rastro.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { adminRoutes } from "../src/domains/admin/admin.routes";
import {
	claveConHora,
	claveDelDia,
	copiarLaCentral,
	esClaveDeCopiaDeLaCentral,
	NOMBRES_DE_UNA_COPIA,
} from "../src/durableObjects/baseCentral.copia";
import { CLAVE_RESTAURACION_EN_CURSO, CLAVE_VUELTA_EN_CURSO } from "../src/durableObjects/baseCentral.guardas";
import { FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ } from "../src/durableObjects/baseCentral.restaurar";
import { CARACTERES_POR_LINEA } from "../src/durableObjects/cargaDeCopias";
import {
	centralDePrueba,
	centralInterceptada,
	centralSinAprovisionar,
	claveDeCopiaNueva,
	conDobleDeInstantes,
	conPlataformaQueVuelve,
	filasDe,
	MARCADORES,
	type CentralDePrueba,
} from "./helpers/central";

const TOKEN = "token-de-pruebas";

afterEach(() => {
	vi.restoreAllMocks();
});

/** El entorno de las rutas, con la central `central` (y el token, salvo que se diga otra cosa). */
const entornoCon = (central: Pick<CentralDePrueba, "entorno">) => ({ ...(env as any), ADMIN_API_TOKEN: TOKEN, ...central.entorno });

async function pedir(
	entorno: Record<string, unknown>,
	metodo: "GET" | "POST",
	ruta: string,
	opciones: { cuerpo?: string; token?: string | null } = {},
) {
	const { cuerpo, token = TOKEN } = opciones;
	const res = await adminRoutes.fetch(
		new Request(`https://api/central${ruta}`, {
			method: metodo,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(cuerpo !== undefined ? { "content-type": "application/json" } : {}),
			},
			...(cuerpo !== undefined ? { body: cuerpo } : {}),
		}),
		entorno,
	);
	return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const json = (valor: unknown) => JSON.stringify(valor);

/** Los rastros `[central]` que han salido por el log (`log` es el espía de `console.log`). */
const rastrosDe = (log: { mock: { calls: unknown[][] } }) =>
	log.mock.calls
		.map((c) => String(c[0]))
		.filter((l) => l.startsWith("[central] "))
		.map((l) => JSON.parse(l.slice("[central] ".length)));

const RUTAS: [string, "GET" | "POST", string?][] = [
	["/estado", "GET"],
	["/copias", "GET"],
	["/copiar-ahora", "POST"],
	["/aprovisionar", "POST", "{esto no es json"],
	["/volver", "POST", "{esto no es json"],
];

describe("el token de administración", () => {
	it.each(RUTAS)("sin él, %s da 401 antes de leer el cuerpo", async (ruta, metodo, cuerpo) => {
		const entorno = entornoCon(centralSinAprovisionar());
		for (const token of [null, "otro-token"]) {
			const r = await pedir(entorno, metodo, ruta, { cuerpo, token });
			expect(r, `${ruta} con ${token}`).toMatchObject({ status: 401, body: { ok: false, error: "unauthorized" } });
		}
	});

	it("no lee la central: sin ella, el 401 sale igual y la lista de copias, también", async () => {
		const intocable = {
			idFromName: () => {
				throw new Error("la central no se toca");
			},
			get: () => {
				throw new Error("la central no se toca");
			},
		};
		const entorno = { ...(env as any), ADMIN_API_TOKEN: TOKEN, BaseCentral: intocable };
		expect((await pedir(entorno, "GET", "/estado", { token: null })).status).toBe(401);
		expect(await pedir(entorno, "GET", "/copias")).toMatchObject({ status: 200, body: { ok: true, copias: expect.any(Array) } });
	});
});

describe("con la central sin aprovisionar, todo contesta", () => {
	it("estado, copias, copiar, volver y aprovisionar", async () => {
		const central = centralSinAprovisionar();
		const entorno = entornoCon(central);

		expect(await pedir(entorno, "GET", "/estado")).toMatchObject({
			status: 200,
			body: { ok: true, aprovisionada: false, migraciones: [], averia: null, enCurso: { restauracion: null, vuelta: null }, filas: {} },
		});
		expect((await pedir(entorno, "GET", "/copias")).status).toBe(200);
		expect(await pedir(entorno, "POST", "/copiar-ahora")).toMatchObject({
			status: 503,
			body: { ok: false, error: "central_sin_aprovisionar", message: expect.stringContaining("pnpm central:aprovisionar") },
		});
		// Volver se puede también sin aprovisionar; en local no hay vuelta a un instante.
		expect(await pedir(entorno, "POST", "/volver", { cuerpo: json({ marcador: MARCADORES.destino }) })).toMatchObject({
			status: 501,
			body: { ok: false, error: "central_vuelta_no_disponible" },
		});
		expect(await pedir(entorno, "POST", "/aprovisionar", { cuerpo: json({}) })).toMatchObject({
			status: 200,
			body: { ok: true, aprovisionada: true, copia: null, migraciones: [{ nombre: "0001_inicial.sql" }] },
		});
		expect(await pedir(entorno, "POST", "/aprovisionar", { cuerpo: json({}) })).toMatchObject({
			status: 409,
			body: { ok: false, error: "central_ya_aprovisionada" },
		});
	});
});

describe("aprovisionar desde una copia", () => {
	it.each([
		["de otra carpeta", "negocios/t-1/2026-01-01.sql.gz"],
		["con ..", "base-central/../negocios/x.sql.gz"],
		["que no es un .sql.gz", "base-central/2026-01-01.txt"],
		["demasiado larga", `base-central/${"x".repeat(101)}.sql.gz`],
		["con un nombre y un correo", "base-central/Ana Gil ana@correo.es.sql.gz"],
		["con acentos", "base-central/copia-de-María.sql.gz"],
		["en una carpeta de dentro", "base-central/otra/2026-01-01.sql.gz"],
		["sin nombre", "base-central/.sql.gz"],
		// Con las letras que valen, pero texto libre (C4): un nombre llegaría al rastro.
		["un nombre con guiones", "base-central/Ana-Gil.sql.gz"],
		["un nombre detrás de una forma buena", "base-central/subida-2026-11-25-Ana-Gil.sql.gz"],
		["un nombre delante de una forma buena", "base-central/Ana-Gil-2026-11-25.sql.gz"],
		["un traspaso sin día", "base-central/traspaso-turso-ana.sql.gz"],
		["un día que no existe", "base-central/2026-02-30.sql.gz"],
		["una hora que no existe", "base-central/a-mano-2026-11-25T25-00-00.000Z.sql.gz"],
		["una hora sin milésimas", "base-central/antes-de-volver-2026-11-25T10-30-00Z.sql.gz"],
		["una subida con el número 0", "base-central/subida-2026-11-25-0.sql.gz"],
		["una subida con un número de cuatro cifras", "base-central/subida-2026-11-25-1000.sql.gz"],
	])("valida la clave antes de llegar a la central: %s", async (_que, claveDeCopia) => {
		const central = centralSinAprovisionar();
		const log = vi.spyOn(console, "log");
		const r = await pedir(entornoCon(central), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia }) });
		expect(r).toMatchObject({ status: 400, body: { ok: false, error: "validation_error", message: expect.any(String) } });
		// Dice qué formas valen (k), sin repetir la clave.
		expect(r.body.message).toContain(NOMBRES_DE_UNA_COPIA);
		expect((await central.stub.estado()).aprovisionada).toBe(false);
		expect(rastrosDe(log)).toEqual([]);
	});

	it("la gramática admite todas las claves que escribe el worker, la del traspaso desde Turso y la de una base subida a mano, y nada más", () => {
		const ahora = new Date("2026-11-25T10:30:00.000Z");
		for (const clave of [
			claveDelDia("2026-11-25"),
			claveConHora("a-mano", ahora),
			claveConHora("antes-de-volver", ahora),
			claveConHora("antes-de-volver", new Date("2024-02-29T23:59:59.999Z")),
			"base-central/traspaso-turso-2026-11-25.sql.gz",
			"base-central/subida-2026-11-25.sql.gz",
			"base-central/subida-2026-11-25-1.sql.gz",
			"base-central/subida-2026-11-25-999.sql.gz",
		]) {
			expect(esClaveDeCopiaDeLaCentral(clave), clave).toBe(true);
		}
		for (const clave of [`base-central/${"x".repeat(100)}.sql.gz`, "base-central/prueba-0123.sql.gz", "base-central/a-mano.sql.gz"]) {
			expect(esClaveDeCopiaDeLaCentral(clave), clave).toBe(false);
		}
	});

	it("una copia que no vale lo dice, con su motivo aparte, y la central sigue sin aprovisionar; al rastro sólo va el código del motivo", async () => {
		const central = centralSinAprovisionar();
		const clave = claveDeCopiaNueva();
		const log = vi.spyOn(console, "log");
		const r = await pedir(entornoCon(central), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia: clave }) });
		expect(r).toEqual({
			status: 422,
			body: {
				ok: false,
				error: "central_copia_inservible",
				message: "Esa copia no se puede restaurar: la central se queda sin aprovisionar, como estaba.",
				detalle: `copia_no_encontrada: no hay ninguna copia ${clave}`,
			},
		});
		expect((await central.stub.estado()).aprovisionada).toBe(false);
		expect(rastrosDe(log)).toEqual([
			{ accion: "restaurar", resultado: "empieza", clave },
			{ accion: "restaurar", resultado: "central_copia_inservible", clave, motivo: "copia_no_encontrada" },
		]);
	});

	it("lo que trae la copia no llega al rastro: ni una migración inventada en su cabecera", async () => {
		const origen = await centralDePrueba();
		const clave = claveDeCopiaNueva();
		const bucket = (env as any).COPIAS as R2Bucket;
		await runInDurableObject(origen.stub, (_c, state) => copiarLaCentral(state.storage.sql, bucket, clave));
		const texto = await new Response((await bucket.get(clave))!.body.pipeThrough(new DecompressionStream("gzip"))).text();
		const conDatos = texto.replace(/^(-- Migraciones: .*)$/m, "$1,Ana Gil ana@correo.es");
		expect(conDatos).not.toBe(texto);
		const flujo = new Blob([conDatos]).stream().pipeThrough(new CompressionStream("gzip"));
		await bucket.put(clave, await new Response(flujo).arrayBuffer());
		const log = vi.spyOn(console, "log");

		const central = centralSinAprovisionar();
		const r = await pedir(entornoCon(central), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia: clave }) });
		expect(r).toMatchObject({ status: 422, body: { error: "central_copia_inservible" } });
		expect(rastrosDe(log)).toEqual([
			{ accion: "restaurar", resultado: "empieza", clave },
			{ accion: "restaurar", resultado: "central_copia_inservible", clave, motivo: "copia_de_otra_version" },
		]);
		expect(JSON.stringify(rastrosDe(log))).not.toMatch(/Ana|correo/);
	});

	it("una línea más larga que el tope dice cuál es, y al rastro va el código con el que empieza el motivo", async () => {
		const origen = await centralDePrueba();
		const clave = claveDeCopiaNueva();
		const bucket = (env as any).COPIAS as R2Bucket;
		await runInDurableObject(origen.stub, (_c, state) => copiarLaCentral(state.storage.sql, bucket, clave));
		const texto = await new Response((await bucket.get(clave))!.body.pipeThrough(new DecompressionStream("gzip"))).text();
		// Una fila de más, con un correo delante de lo que la hace pasar del tope (`CARACTERES_POR_LINEA`).
		const larga = texto.replace(
			/^-- Fin de la copia: (\d+)/m,
			(_m, n) =>
				`INSERT INTO "admin_audit" ("audit_id", "action", "detail", "at_ms") VALUES ('a', 'x', 'ana.gil@correo.es ${"x".repeat(CARACTERES_POR_LINEA)}', 1);\n-- Fin de la copia: ${Number(n) + 1}`,
		);
		const flujo = new Blob([larga]).stream().pipeThrough(new CompressionStream("gzip"));
		await bucket.put(clave, await new Response(flujo).arrayBuffer());
		const log = vi.spyOn(console, "log");

		const central = centralSinAprovisionar();
		const r = await pedir(entornoCon(central), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia: clave }) });
		expect(r).toMatchObject({
			status: 422,
			body: {
				error: "central_copia_inservible",
				detalle: expect.stringMatching(new RegExp(`^copia_no_valida: la línea \\d+ es demasiado larga: pasa de ${CARACTERES_POR_LINEA} caracteres$`)),
			},
		});
		expect(JSON.stringify(r.body)).not.toMatch(/ana\.gil/);
		expect(rastrosDe(log)).toEqual([
			{ accion: "restaurar", resultado: "empieza", clave },
			{ accion: "restaurar", resultado: "central_copia_inservible", clave, motivo: "copia_no_valida" },
		]);
		expect((await central.stub.estado()).aprovisionada).toBe(false);
	});

	it("una línea que SQLite no acepta dice dónde está, y nada de lo que lleva sale en la respuesta ni en el rastro", async () => {
		const origen = await centralDePrueba();
		await filasDe(origen, `INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('t-1', 1, 2);`);
		const clave = claveDeCopiaNueva();
		const bucket = (env as any).COPIAS as R2Bucket;
		await runInDurableObject(origen.stub, (_c, state) => copiarLaCentral(state.storage.sql, bucket, clave));
		const texto = await new Response((await bucket.get(clave))!.body.pipeThrough(new DecompressionStream("gzip"))).text();
		// Una fila de más, bien escrita, con un negocio que ya está: SQLite no la acepta.
		const estropeado = texto.replace(
			/^-- Fin de la copia: (\d+)/m,
			(_m, n) =>
				`INSERT INTO "tenants" ("tenant_id", "legal_name", "created_at_ms", "updated_at_ms") VALUES ('t-1', 'Ana Gil, ana.gil@correo.es', 1, 1);\n-- Fin de la copia: ${Number(n) + 1}`,
		);
		const flujo = new Blob([estropeado]).stream().pipeThrough(new CompressionStream("gzip"));
		await bucket.put(clave, await new Response(flujo).arrayBuffer());
		const log = vi.spyOn(console, "log");

		const central = centralSinAprovisionar();
		const r = await pedir(entornoCon(central), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia: clave }) });
		expect(r).toMatchObject({
			status: 422,
			body: {
				error: "central_copia_inservible",
				detalle: expect.stringMatching(/^no se ha podido cargar: SQLite no acepta una de las líneas \d+–\d+ de la copia \(tenants\): SQLITE_CONSTRAINT$/),
			},
		});
		expect(JSON.stringify(r.body)).not.toMatch(/Ana|ana\.gil/);
		// El texto de SQLite no es nuestro: al rastro va sólo el código.
		expect(rastrosDe(log)).toEqual([
			{ accion: "restaurar", resultado: "empieza", clave },
			{ accion: "restaurar", resultado: "central_copia_inservible", clave },
		]);
		expect((await central.stub.estado()).aprovisionada).toBe(false);
	});

	it("el recorrido entero: copiar ahora, aprovisionar otra central con esa copia, y su estado", async () => {
		const origen = await centralDePrueba();
		await filasDe(
			origen,
			`INSERT INTO tenants (tenant_id, legal_name, created_at_ms, updated_at_ms) VALUES ('t-1', 'Bar Uno', 1, 2), ('t-2', 'Bar Dos', 3, 4);`,
		);
		await filasDe(origen, `INSERT INTO devices (device_id, tenant_id, role) VALUES ('d-1', 't-1', 'tpv');`);
		const log = vi.spyOn(console, "log");

		const copia = await pedir(entornoCon(origen), "POST", "/copiar-ahora");
		expect(copia).toMatchObject({
			status: 200,
			body: { ok: true, clave: expect.stringMatching(/^base-central\/a-mano-/), filas: 3, tablas: expect.any(Number) },
		});
		const clave = copia.body.clave as string;

		const lista = await pedir(entornoCon(origen), "GET", "/copias");
		expect(lista.status).toBe(200);
		expect(lista.body.copias.find((c: any) => c.clave === clave)).toMatchObject({
			clave,
			bytes: expect.any(Number),
			subida: expect.any(String),
			generada: expect.any(String),
			filas: 3,
			ultimaMigracion: "0001_inicial.sql",
		});
		// Las más recientes primero.
		const subidas = lista.body.copias.map((c: any) => Date.parse(c.subida));
		expect(subidas).toEqual([...subidas].sort((a, b) => b - a));

		const destino = centralSinAprovisionar();
		const restaurada = await pedir(entornoCon(destino), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia: clave }) });
		expect(restaurada).toMatchObject({ status: 200, body: { ok: true, aprovisionada: true, copia: { clave, filas: 3 } } });

		const [deOrigen, deDestino] = await Promise.all([
			pedir(entornoCon(origen), "GET", "/estado"),
			pedir(entornoCon(destino), "GET", "/estado"),
		]);
		expect(deDestino.body.filas).toEqual(deOrigen.body.filas);
		expect(deDestino.body.filas).toMatchObject({ tenants: 2, devices: 1 });
		expect(deDestino.body.bytes).toBeGreaterThan(0);

		// El rastro: la acción, la clave, las filas y el resultado. Sin nada de los negocios.
		expect(rastrosDe(log)).toEqual([
			{ accion: "copiar", resultado: "ok", clave, filas: 3, tablas: expect.any(Number) },
			{ accion: "restaurar", resultado: "empieza", clave },
			{ accion: "restaurar", resultado: "ok", clave, filas: 3, tablas: 2 },
		]);
		expect(JSON.stringify(rastrosDe(log))).not.toMatch(/Bar Uno|Bar Dos/);
	});
});

describe("una restauración que se corta por tiempo (copias-4)", () => {
	it("con una a medias, lo que se le pide dice que con una copia de más filas de las que se restauran de una vez se volverá a cortar", async () => {
		const central = await centralDePrueba();
		await runInDurableObject(central.stub, (_o, state) =>
			state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/2026-11-24.sql.gz", desdeMs: 1 }),
		);
		const r = await pedir(entornoCon(central), "POST", "/copiar-ahora");
		expect(r).toMatchObject({ status: 503, body: { error: "central_restauracion_a_medias" } });
		expect(r.body.message).toContain("vuelve a restaurar desde una copia");
		expect(r.body.message).toContain(
			`con una copia de más de ${FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ} filas (las dice pnpm central:copias) se volverá a cortar: hace falta una copia con menos filas o cargarla por partes.`,
		);
	});

	it("la lista de las copias dice hasta cuántas filas se restauran de una vez, para avisar antes de restaurar una más grande", async () => {
		const lista = await pedir(entornoCon(centralSinAprovisionar()), "GET", "/copias");
		expect(lista).toMatchObject({ status: 200, body: { ok: true, filasQueSeRestauranDeUnaVez: FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ } });
	});
});

describe("el rastro de restaurar y de volver no depende de que vuelva la llamada al objeto", () => {
	/** La central, pero la llamada `metodo` no vuelve: el objeto se ha reiniciado a mitad. */
	const sinVolver = (central: CentralDePrueba, metodo: string) =>
		centralInterceptada(central, (m, _a, llamar) => (m === metodo ? Promise.reject(new Error("el objeto se ha reiniciado")) : llamar()));

	it("restaurar deja que empieza antes de llamar al objeto, y que no ha vuelto", async () => {
		const central = sinVolver(centralSinAprovisionar(), "aprovisionar");
		const clave = "base-central/2026-11-24.sql.gz";
		const log = vi.spyOn(console, "log");
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await pedir(entornoCon(central), "POST", "/aprovisionar", { cuerpo: json({ claveDeCopia: clave }) })).status).toBe(500);
		expect(rastrosDe(log)).toEqual([
			{ accion: "restaurar", resultado: "empieza", clave },
			{ accion: "restaurar", resultado: "sin_respuesta", clave },
		]);
	});

	it("volver deja que empieza antes de llamar al objeto, y que no ha vuelto", async () => {
		const central = sinVolver(await centralDePrueba(), "prepararVuelta");
		const log = vi.spyOn(console, "log");
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: MARCADORES.destino }) })).status).toBe(500);
		expect(rastrosDe(log)).toEqual([
			{ accion: "volver", resultado: "empieza", destino: MARCADORES.destino },
			{ accion: "volver", resultado: "sin_respuesta", destino: MARCADORES.destino },
		]);
	});
});

/** Un marcador al que volver, con la forma de los de Cloudflare. */
const MARCADOR = "00000070-00000000-00001500-00112233445566778899aabbccddeeff";

describe("volver a un instante, con el doble de la plataforma", () => {
	it("prepara, reinicia, espera a que conteste y devuelve con qué se deshace y la copia de antes", async () => {
		const central = await centralDePrueba();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		const log = vi.spyOn(console, "log");

		const instanteMs = Date.now() - 3_600_000;
		const r = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ instanteMs }) });
		expect(r).toMatchObject({
			status: 200,
			body: {
				ok: true,
				destino: MARCADORES.destino,
				deshacer: MARCADORES.actual,
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
				estado: { aprovisionada: true, averia: null, enCurso: { restauracion: null, vuelta: null } },
			},
		});
		expect(llamadas).toEqual(["de:number", "actual", `restaurar:${MARCADORES.destino}`, "reiniciar"]);
		// Cuándo se cerró la central, con la hora del worker: la de la clave de la copia de antes. Es el
		// instante al que se vuelve si se pierde el marcador (V-OP-3).
		expect(r.body.copiaDeAntes).toBe(`base-central/antes-de-volver-${String(r.body.cerradaDesde).replaceAll(":", "-")}.sql.gz`);
		// Que empieza, antes de llamar al objeto; y con qué se deshace, antes de reiniciar: si la llamada no
		// terminara, estaría ahí.
		const destino = new Date(instanteMs).toISOString();
		const deLaVuelta = { accion: "volver", destino, deshacer: MARCADORES.actual, copiaDeAntes: r.body.copiaDeAntes };
		expect(rastrosDe(log)).toEqual([
			{ accion: "volver", resultado: "empieza", destino },
			{ ...deLaVuelta, resultado: "preparada" },
			{ ...deLaVuelta, resultado: "ok" },
		]);
		// Y la lista de las copias lo enseña, en la copia de antes: está en R2, con la hora a la que se
		// pidió la vuelta (`….pedida`, que no es una fila).
		const lista = await pedir(entornoCon(central), "GET", "/copias");
		expect(lista.body.copias.find((c: any) => c.clave === r.body.copiaDeAntes)).toMatchObject({
			marcador: MARCADORES.actual,
			pedida: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
		expect(lista.body.copias.map((c: any) => c.clave)).not.toContain(r.body.copiaDeAntes.replace(/\.sql\.gz$/, ".pedida"));

		// Deshacer es volver al marcador que devolvió.
		const deshecha = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: MARCADORES.actual }) });
		expect(deshecha).toMatchObject({ status: 200, body: { ok: true, destino: MARCADORES.actual } });
	});

	it("si la central no llega a reiniciarse, lo dice, con lo necesario para aplicarla y deshacerla; `reiniciar` con su deshacer la aplica, sin pedir otra, y repetirlo no hace nada", async () => {
		const central = await centralDePrueba();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas, { alReiniciar: () => {} });
		const log = vi.spyOn(console, "log");

		const r = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: MARCADOR }) });
		expect(r).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: "central_vuelta_sin_aplicar",
				message: expect.stringContaining("Se aplica con pnpm central:volver -- --reiniciar <deshacer> --si"),
				deshacer: MARCADORES.actual,
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
				cerradaDesde: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
			},
		});
		expect(r.body.message).not.toMatch(/Repite la misma orden/);
		expect(llamadas.filter((l) => l === "reiniciar")).toHaveLength(2);

		// Mientras tanto, lo que se le pide dice cómo salir de ahí.
		const copiar = await pedir(entornoCon(central), "POST", "/copiar-ahora");
		expect(copiar).toMatchObject({
			status: 503,
			body: { error: "central_vuelta_en_curso", message: expect.stringContaining("pnpm central:volver -- --reiniciar <deshacer> --si") },
		});
		expect(copiar.body.message).not.toMatch(/la misma orden/);

		await conDobleDeInstantes(central, llamadas);
		const aplicada = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ reiniciar: MARCADORES.actual }) });
		expect(aplicada).toMatchObject({
			status: 200,
			body: {
				ok: true,
				destino: MARCADOR,
				deshacer: MARCADORES.actual,
				copiaDeAntes: r.body.copiaDeAntes,
				// Aplicada después, dice la misma hora: la de cuando se cerró la central para prepararla.
				cerradaDesde: r.body.cerradaDesde,
				estado: { aprovisionada: true, averia: null, enCurso: { restauracion: null, vuelta: null } },
			},
		});
		// Sin otra preparación: sólo el reinicio.
		expect(llamadas.filter((l) => l.startsWith("restaurar:"))).toEqual([`restaurar:${MARCADOR}`]);
		expect(llamadas.filter((l) => l === "reiniciar")).toHaveLength(3);

		// Repetirlo, ya aplicada, no reinicia nada.
		expect(await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ reiniciar: MARCADORES.actual }) })).toMatchObject({
			status: 409,
			body: {
				ok: false,
				error: "central_sin_vuelta_preparada",
				message: expect.stringContaining("o se ha aplicado"),
				estado: { enCurso: { vuelta: null } },
			},
		});
		expect(llamadas.filter((l) => l === "reiniciar")).toHaveLength(3);

		const deLaVuelta = { accion: "volver", destino: MARCADOR, deshacer: MARCADORES.actual, copiaDeAntes: r.body.copiaDeAntes };
		expect(rastrosDe(log)).toEqual([
			{ accion: "volver", resultado: "empieza", destino: MARCADOR },
			{ ...deLaVuelta, resultado: "preparada" },
			{ ...deLaVuelta, resultado: "central_vuelta_sin_aplicar" },
			{ accion: "copiar", resultado: "central_vuelta_en_curso" },
			{ ...deLaVuelta, resultado: "reinicia" },
			{ ...deLaVuelta, resultado: "ok" },
			{ accion: "volver", resultado: "central_sin_vuelta_preparada", deshacer: MARCADORES.actual },
		]);
	});

	it("si la central se reinicia por su cuenta antes de aplicar la vuelta que quedó sin aplicar, la orden que da para aplicarla no vuelve otra vez: lo escrito después se queda", async () => {
		const alta = (id: string) => `INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('${id}', 1, 1);`;
		const LOS_NEGOCIOS = "SELECT tenant_id FROM tenants ORDER BY tenant_id;";
		const central = await centralDePrueba();
		await filasDe(central, alta("t-1"));
		const plataforma = await conPlataformaQueVuelve(central);
		const objetivo = await plataforma.fotografiar();
		await filasDe(central, alta("t-2"));
		// El reinicio de la ruta no llega al objeto.
		const sinReinicio = centralInterceptada(central, (metodo, _a, llamar) =>
			metodo === "reiniciar" ? Promise.reject(new Error("no llega")) : llamar(),
		);
		const r = await pedir(entornoCon(sinReinicio), "POST", "/volver", { cuerpo: json({ marcador: objetivo }) });
		expect(r).toMatchObject({ status: 503, body: { error: "central_vuelta_sin_aplicar", deshacer: expect.any(String) } });

		// El objeto se reinicia por su cuenta (un despliegue): vuelve. Después, un TPV escribe.
		await plataforma.reiniciar();
		await central.db.execute({ sql: alta("t-3") });
		expect(await filasDe(central, LOS_NEGOCIOS)).toEqual([{ tenant_id: "t-1" }, { tenant_id: "t-3" }]);

		// La orden que da la respuesta para aplicarla.
		const orden = /pnpm central:volver -- --reiniciar <deshacer> --si/.exec(r.body.message);
		expect(orden).not.toBeNull();
		const aplicar = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ reiniciar: r.body.deshacer }) });
		expect(aplicar).toMatchObject({ status: 409, body: { ok: false, error: "central_sin_vuelta_preparada" } });
		expect(await filasDe(central, LOS_NEGOCIOS)).toEqual([{ tenant_id: "t-1" }, { tenant_id: "t-3" }]);
		expect(plataforma.llamadas.filter((l) => l.startsWith("restaurar:"))).toEqual([`restaurar:${objetivo}`]);
	});

	describe("si el objeto no reinicia para la suya, no la da por aplicada: una central sana sin marca no dice qué vuelta se aplicó (C1)", () => {
		const alta = (id: string) => `INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('${id}', 1, 1);`;
		const LOS_NEGOCIOS = "SELECT tenant_id FROM tenants ORDER BY tenant_id;";
		const pausa = () => new Promise((r) => setTimeout(r, 5));

		/** Una central con t-1, t-2 y t-3, y la foto de cuando sólo tenía t-1 (`aA`) y t-1 y t-2 (`aB`). */
		async function conDosInstantes() {
			const central = await centralDePrueba();
			const plataforma = await conPlataformaQueVuelve(central);
			await filasDe(central, alta("t-1"));
			const aA = await plataforma.fotografiar();
			await filasDe(central, alta("t-2"));
			const aB = await plataforma.fotografiar();
			await filasDe(central, alta("t-3"));
			return { central, plataforma, aA, aB };
		}

		/** La central vista por la ruta de A: su reinicio (y, si se dice, su primer estado) espera a que el test lo suelte. */
		function laDeA(central: CentralDePrueba, retener: { estado: boolean }) {
			const senal = { reiniciando: false, sueltaReinicio: false, preguntando: false, sueltaEstado: false };
			let estados = 0;
			const deA = centralInterceptada(central, async (metodo, _a, llamar) => {
				if (metodo === "reiniciar") {
					senal.reiniciando = true;
					while (!senal.sueltaReinicio) await pausa();
				}
				if (metodo === "estado" && senal.reiniciando && retener.estado && ++estados === 1) {
					senal.preguntando = true;
					while (!senal.sueltaEstado) await pausa();
				}
				return llamar();
			});
			return { deA, senal };
		}

		it("la de A, preparada y con el reinicio retenido; B prepara otra encima y la aplica; el reinicio de A ya no tiene ninguna: lo dice, con lo de A", async () => {
			const { central, plataforma, aA, aB } = await conDosInstantes();
			const { deA, senal } = laDeA(central, { estado: false });
			const log = vi.spyOn(console, "log");

			const a = pedir(entornoCon(deA), "POST", "/volver", { cuerpo: json({ marcador: aA }) });
			await vi.waitFor(() => expect(senal.reiniciando).toBe(true));
			const b = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: aB }) });
			expect(b).toMatchObject({ status: 200, body: { ok: true, destino: aB } });
			expect(await filasDe(central, LOS_NEGOCIOS)).toEqual([{ tenant_id: "t-1" }, { tenant_id: "t-2" }]);

			senal.sueltaReinicio = true;
			const r = await a;
			// Con «pedida» en la otra, está donde la dejó la otra; sin ella, no se sabe (C2): no se concluye que ésta.
			expect(r.body.message).toContain("si la hay sin «pedida», no se sabe");
			expect(r.body.message).not.toContain("si no, ésta");
			expect(r).toMatchObject({
				status: 409,
				body: {
					ok: false,
					error: "central_sin_vuelta_preparada",
					message: expect.stringContaining("No se sabe cuál"),
					deshacer: expect.any(String),
					copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
					estado: { enCurso: { vuelta: null } },
				},
			});
			// La central está donde la dejó B, y nadie ha vuelto a la de A.
			expect(await filasDe(central, LOS_NEGOCIOS)).toEqual([{ tenant_id: "t-1" }, { tenant_id: "t-2" }]);
			expect(plataforma.llamadas.filter((l) => l === "reiniciar")).toHaveLength(1);
			expect(rastrosDe(log).filter((x) => x.destino === aA).map((x) => x.resultado)).toEqual([
				"empieza",
				"preparada",
				"central_sin_vuelta_preparada",
			]);
		});

		it("la de A con el reinicio retenido; B prepara otra encima y el objeto dice que la de A no es la que sigue; B se aplica antes de que A pregunte cómo ha quedado: dice que hay otra", async () => {
			const { central, aA, aB } = await conDosInstantes();
			const { deA, senal } = laDeA(central, { estado: true });

			const a = pedir(entornoCon(deA), "POST", "/volver", { cuerpo: json({ marcador: aA }) });
			await vi.waitFor(() => expect(senal.reiniciando).toBe(true));
			const b = await central.stub.prepararVuelta({ marcador: aB });
			if (!b.ok) throw new Error(b.error);

			senal.sueltaReinicio = true;
			await vi.waitFor(() => expect(senal.preguntando).toBe(true));
			await central.stub.reiniciar(b.valor.deshacer);
			senal.sueltaEstado = true;

			expect(await a).toMatchObject({
				status: 409,
				body: { ok: false, error: "central_vuelta_a_la_vez", deshacer: expect.any(String), estado: { enCurso: { vuelta: null } } },
			});
			expect(await filasDe(central, LOS_NEGOCIOS)).toEqual([{ tenant_id: "t-1" }, { tenant_id: "t-2" }]);
		});

		it("la de A con el reinicio retenido; B se está pidiendo a la plataforma cuando llega el reinicio de A, y después no sale: el 409 de A no la da por perdida, y vuelve a quedar preparada, con la orden que la aplica en central:estado", async () => {
			const central = await centralDePrueba();
			const senal = { reiniciando: false, sueltaReinicio: false, bPidiendose: false, sueltaB: false };
			let actuales = 0;
			let pedidas = 0;
			await conDobleDeInstantes(central, [], {
				marcadorActual: () => (actuales++ === 0 ? MARCADORES.actual : MARCADORES.deshacer),
				alRestaurar: async () => {
					if (++pedidas !== 2) return;
					senal.bPidiendose = true;
					while (!senal.sueltaB) await pausa();
					throw new Error("la plataforma no acepta la de B");
				},
			});
			const deA = centralInterceptada(central, async (metodo, _a, llamar) => {
				if (metodo === "reiniciar") {
					senal.reiniciando = true;
					while (!senal.sueltaReinicio) await pausa();
				}
				return llamar();
			});

			const a = pedir(entornoCon(deA), "POST", "/volver", { cuerpo: json({ marcador: MARCADORES.destino }) });
			await vi.waitFor(() => expect(senal.reiniciando).toBe(true));
			const b = central.stub.prepararVuelta({ instanteMs: Date.now() - 3_600_000 });
			await vi.waitFor(() => expect(senal.bPidiendose).toBe(true));
			senal.sueltaReinicio = true;
			const r = await a;
			expect(r).toMatchObject({ status: 409, body: { ok: false, error: "central_vuelta_a_la_vez", deshacer: MARCADORES.actual } });
			// No afirma que ésta ya no sigue: si la otra no sale, vuelve a quedar preparada.
			expect(r.body.message).not.toContain("ya no sigue");
			expect(r.body.message).toContain("si la otra no sale, puede que ésta vuelva a quedar preparada");
			expect(r.body.message).toContain("pnpm central:estado da la orden que la aplica");

			senal.sueltaB = true;
			expect(await b).toMatchObject({ ok: false, error: "central_vuelta_rechazada" });
			const estado = await pedir(entornoCon(central), "GET", "/estado");
			expect(estado.body.enCurso.vuelta).toMatchObject({ fase: "preparada", preparada: { deshacer: r.body.deshacer } });
			// La orden que la aplica, con el deshacer del 409 de A.
			const aplicada = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ reiniciar: r.body.deshacer }) });
			expect(aplicada).toMatchObject({ status: 200, body: { ok: true, deshacer: r.body.deshacer } });
		});
	});

	it("si la plataforma no acepta la vuelta, lo dice con su código, no como una llamada que no vuelve: no se ha pedido, la central atiende, y lo que subió a R2 no consta como pedido", async () => {
		const alta = (id: string) => `INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('${id}', 1, 1);`;
		const central = await centralDePrueba();
		await filasDe(central, alta("t-1"));
		// La plataforma de mentira no acepta un marcador que no es de este objeto, aunque tenga la forma.
		const plataforma = await conPlataformaQueVuelve(central);
		const ajeno = "0000007b-0000b26e";
		const deAntesDeVolver = async () => (await pedir(entornoCon(central), "GET", "/copias")).body.copias.filter((c: any) => /antes-de-volver-/.test(c.clave));
		const antes = new Set((await deAntesDeVolver()).map((c: any) => c.clave));
		const log = vi.spyOn(console, "log");
		const error = vi.spyOn(console, "error");

		const r = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: ajeno }) });
		expect(r).toEqual({
			status: 422,
			body: {
				ok: false,
				error: "central_vuelta_rechazada",
				message: expect.stringMatching(/^La plataforma no ha aceptado la vuelta: no se ha pedido/),
				detalle: "Ese marcador no es de este objeto",
			},
		});
		// Al rastro, el código: ni `sin_respuesta` ni lo que ha dicho la plataforma.
		expect(rastrosDe(log)).toEqual([
			{ accion: "volver", resultado: "empieza", destino: ajeno },
			{ accion: "volver", resultado: "central_vuelta_rechazada", destino: ajeno },
		]);
		expect(error).not.toHaveBeenCalled();
		expect(plataforma.llamadas).toEqual(["actual", `restaurar:${ajeno}`]);

		// La central atiende; la copia de antes que se subió no consta como pedida.
		await central.db.execute({ sql: alta("t-2") });
		expect(await filasDe(central, "SELECT tenant_id FROM tenants ORDER BY tenant_id;")).toEqual([{ tenant_id: "t-1" }, { tenant_id: "t-2" }]);
		const nuevas = (await deAntesDeVolver()).filter((c: any) => !antes.has(c.clave));
		expect(nuevas).toEqual([expect.objectContaining({ clave: expect.stringMatching(/\.sql\.gz$/), marcador: expect.any(String), pedida: null })]);
	});

	it.each(["marcadorDe", "marcadorActual", "restaurarAlReiniciar"] as const)(
		"si la plataforma falla en %s, la ruta contesta central_vuelta_rechazada y lo apunta con su código, sin `sin_respuesta`",
		async (fallaAl) => {
			const central = await centralDePrueba();
			const llamadas: string[] = [];
			await conDobleDeInstantes(central, llamadas, { fallaAl });
			const log = vi.spyOn(console, "log");
			const instanteMs = Date.now() - 3_600_000;
			const destino = new Date(instanteMs).toISOString();

			expect(await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ instanteMs }) })).toMatchObject({
				status: 422,
				body: { ok: false, error: "central_vuelta_rechazada", detalle: expect.any(String) },
			});
			expect(rastrosDe(log)).toEqual([
				{ accion: "volver", resultado: "empieza", destino },
				{ accion: "volver", resultado: "central_vuelta_rechazada", destino },
			]);
			expect(llamadas).not.toContain("reiniciar");
			expect((await central.db.execute("SELECT 1 AS uno;")).rows[0].uno).toBe(1);
		},
	);

	it("si la central vuelve pero no atiende, no lo da por bueno: dice por qué, con lo necesario para deshacerlo", async () => {
		const central = await centralDePrueba();
		// Vuelve a un instante de en medio de una restauración desde una copia: con su marca.
		await conDobleDeInstantes(central, [], {
			alReiniciar: (state) => {
				state.storage.kv.delete(CLAVE_VUELTA_EN_CURSO);
				state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/la-de-entonces.sql.gz", desdeMs: 1 });
			},
		});
		const log = vi.spyOn(console, "log");

		const r = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: MARCADOR }) });
		expect(r).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: "central_restauracion_a_medias",
				message: expect.stringMatching(/^La central ha vuelto, pero no atiende\. Hay una restauración a medias/),
				detalle: expect.stringContaining("base-central/la-de-entonces.sql.gz"),
				deshacer: MARCADORES.actual,
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-/),
				estado: { aprovisionada: false, averia: { error: "central_restauracion_a_medias" } },
			},
		});
		expect(rastrosDe(log).map((r) => r.resultado)).toEqual(["empieza", "preparada", "central_restauracion_a_medias"]);
	});

	it("un instante, un marcador o la vuelta preparada que se aplica, una sola cosa; y el instante, de los últimos 30 días", async () => {
		const central = await centralDePrueba();
		const entorno = entornoCon(central);
		for (const cuerpo of [
			{},
			{ instanteMs: Date.now() - 1000, marcador: MARCADOR },
			{ marcador: MARCADOR, reiniciar: MARCADOR },
			{ instanteMs: Date.now() - 1000, reiniciar: MARCADOR },
			{ marcador: "" },
			{ reiniciar: "" },
			{ instanteMs: "ayer" },
		]) {
			expect(await pedir(entorno, "POST", "/volver", { cuerpo: json(cuerpo) }), json(cuerpo)).toMatchObject({
				status: 400,
				body: { ok: false, error: "validation_error" },
			});
		}
		expect(await pedir(entorno, "POST", "/volver", { cuerpo: json({ instanteMs: Date.now() + 60_000 }) })).toEqual({
			status: 400,
			body: {
				ok: false,
				error: "central_instante_fuera_de_plazo",
				message: "Sólo se puede volver a un instante pasado de los últimos 30 días.",
			},
		});
	});

	it.each([
		["un nombre", "Ana Gil"],
		["un correo", "ana@correo.es"],
		["en mayúsculas", MARCADOR.toUpperCase()],
		["con espacios dentro", MARCADOR.replaceAll("-", " ")],
		["con letras que no son de un marcador", "m-deshacer"],
		["un guion suelto", "-"],
		["demasiado largo", `${MARCADOR}-${"0".repeat(100)}`],
	])("el marcador tiene la forma de los de Cloudflare: %s no llega a la central ni al rastro", async (_que, marcador) => {
		const central = await centralDePrueba();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		const log = vi.spyOn(console, "log");
		for (const cuerpo of [{ marcador }, { reiniciar: marcador }]) {
			expect(await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json(cuerpo) }), json(cuerpo)).toMatchObject({
				status: 400,
				body: { ok: false, error: "validation_error", message: expect.stringMatching(/^Ese no es un marcador/) },
			});
		}
		expect(llamadas).toEqual([]);
		expect(rastrosDe(log)).toEqual([]);
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
	});

	it("el reinicio es de quien prepara la vuelta: si tras reiniciar la suya otra se le está pidiendo a la plataforma, no reinicia otra vez, dice que sigue la otra, y la otra termina", async () => {
		const A = "000000a0-00000000-00000000-0000000000000000000000000000000a";
		const B = "000000b0-00000000-00000000-0000000000000000000000000000000b";
		const deshacerDeA = "000000d0-00000000-00000000-0000000000000000000000000000000a";
		const deshacerDeB = "000000d0-00000000-00000000-0000000000000000000000000000000b";
		const actuales = [deshacerDeA, deshacerDeB];
		const pausa = () => new Promise((r) => setTimeout(r, 5));
		const central = await centralDePrueba();
		const llamadas: string[] = [];
		const senal = { pidiendoB: false, sueltaB: false };
		await conDobleDeInstantes(central, llamadas, {
			marcadorActual: () => actuales.shift()!,
			alRestaurar: async (m) => {
				if (m !== B) return;
				senal.pidiendoB = true;
				while (!senal.sueltaB) await pausa();
			},
		});
		// Tras reiniciar la de A, la central no contesta a la primera (arrancando); a la segunda, contesta
		// cuando la vuelta de B ya se le está pidiendo a la plataforma.
		let estados = 0;
		const deA = centralInterceptada(central, async (metodo, _a, llamar) => {
			if (metodo !== "estado") return llamar();
			if (++estados === 1) throw new Error("arrancando");
			while (!senal.pidiendoB) await pausa();
			return llamar();
		});

		const a = pedir(entornoCon(deA), "POST", "/volver", { cuerpo: json({ marcador: A }) });
		await vi.waitFor(() => expect(estados).toBe(1));
		const b = pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ marcador: B }) });

		expect(await a).toMatchObject({
			status: 409,
			body: {
				ok: false,
				error: "central_vuelta_a_la_vez",
				message: expect.stringContaining("no se ha reiniciado, para no cortarla"),
				deshacer: deshacerDeA,
				estado: { enCurso: { vuelta: { destino: B, fase: "programando" } } },
			},
		});
		// A ha reiniciado una vez, para la suya; a la de B no la ha tocado.
		expect(llamadas).toEqual(["actual", `restaurar:${A}`, "reiniciar", "actual", `restaurar:${B}`]);

		senal.sueltaB = true;
		expect(await b).toMatchObject({ status: 200, body: { ok: true, destino: B, deshacer: deshacerDeB } });
		expect(llamadas).toEqual(["actual", `restaurar:${A}`, "reiniciar", "actual", `restaurar:${B}`, "reiniciar"]);
	});

	it("en local, sin el doble, dice que no hay vuelta a un instante y la central sigue atendiendo", async () => {
		const central = await centralDePrueba();
		const r = await pedir(entornoCon(central), "POST", "/volver", { cuerpo: json({ instanteMs: Date.now() - 60_000 }) });
		expect(r).toMatchObject({ status: 501, body: { ok: false, error: "central_vuelta_no_disponible" } });
		expect((await central.db.execute("SELECT 1 AS uno;")).rows[0].uno).toBe(1);
	});
});
