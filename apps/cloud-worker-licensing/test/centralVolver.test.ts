// test/centralVolver.test.ts
//
// Devolver la base central a un instante, o a un marcador (`durableObjects/baseCentral.instante.ts`):
// la primera mitad, `prepararVuelta`, y lo que pasa hasta que el objeto se reinicia.
//
// La vuelta a un instante no existe en local (workerd: «does not implement point-in-time recovery»):
// lo que se prueba con la plataforma de verdad es que lo dice y no deja nada a medias. El resto, con
// un doble de `Instantes` dentro del objeto (`instantes.ts`), que es lo único que se sustituye: que
// deja la copia de antes en R2, que devuelve el marcador para deshacer, que la central no atiende
// entre preparar y reiniciar (tampoco mientras sube la copia de antes), que una vuelta que no sale deja
// en pie la que ya estuviera preparada, y que rechaza un instante fuera de los 30 días. Y con dos
// preparaciones a la vez, cruzadas con barreras, que sólo sigue una y que la que pierde la marca no la
// toca ni pide su vuelta a la plataforma.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { BaseCentral } from "../src/durableObjects/baseCentral";
import { esClaveDeCopiaDeLaCentral, listarCopiasDeLaCentral } from "../src/durableObjects/baseCentral.copia";
import { CLAVE_RESTAURACION_EN_CURSO, CLAVE_VUELTA_EN_CURSO } from "../src/durableObjects/baseCentral.guardas";
import {
	centralDePrueba,
	centralSinAprovisionar,
	codigoDe,
	conCopiasDentro,
	conDobleDeInstantes,
	conR2Caido,
	filasDe,
	MARCADORES,
	RECHAZO_DE_LA_PLATAFORMA,
	type CentralDePrueba,
} from "./helpers/central";

const bucket = () => (env as any).COPIAS as R2Bucket;
const HORA = 3_600_000;
const DIA = 24 * HORA;

async function sembrada(): Promise<CentralDePrueba> {
	const central = await centralDePrueba();
	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, legal_name, created_at_ms, updated_at_ms) VALUES ('t-1', 'Bar de antes', 1, 2);`,
	);
	return central;
}

describe("prepararVuelta, con el doble de la plataforma", () => {
	it("deja en R2 la copia de cómo estaba, y devuelve el marcador con el que se deshace", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);

		const antes = Date.now();
		const r = await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA });
		expect(r).toEqual({
			ok: true,
			valor: {
				marcador: MARCADORES.destino,
				deshacer: MARCADORES.actual,
				copiaDeAntes: expect.stringMatching(/^base-central\/antes-de-volver-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sql\.gz$/),
				desdeMs: expect.any(Number),
			},
		});
		expect(llamadas).toEqual(["de:number", "actual", `restaurar:${MARCADORES.destino}`]);
		if (!r.ok) return;
		// Desde cuándo está cerrada: la hora del worker, la misma que la de la clave de su copia de antes (V-OP-3).
		expect(r.valor.desdeMs).toBeGreaterThanOrEqual(antes);
		expect(r.valor.copiaDeAntes).toBe(`base-central/antes-de-volver-${new Date(r.valor.desdeMs).toISOString().replaceAll(":", "-")}.sql.gz`);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ desdeMs: r.valor.desdeMs });
		const copia = await bucket().get(r.valor.copiaDeAntes!);
		const texto = await new Response(copia!.body.pipeThrough(new DecompressionStream("gzip"))).text();
		expect(texto).toContain("'Bar de antes'");
		expect(copia!.customMetadata).toMatchObject({ filas: "1" });
	});

	it("el marcador de deshacer queda fuera de la base que se devuelve antes de pedir la vuelta: en los metadatos de la copia de antes", async () => {
		const central = await sembrada();
		/** Lo que hay en R2 con un marcador cuando se le pide la vuelta a la plataforma. */
		const alPedirla = new Map<string, string>();
		await conDobleDeInstantes(central, [], {
			alRestaurar: async () => {
				const { objects } = await bucket().list({ prefix: "base-central/antes-de-volver-", include: ["customMetadata"] });
				for (const o of objects) if (o.customMetadata?.marcador) alPedirla.set(o.key, o.customMetadata.marcador);
			},
		});

		const r = await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA });
		expect(r).toMatchObject({ ok: true, valor: { deshacer: MARCADORES.actual, copiaDeAntes: expect.stringMatching(/\.sql\.gz$/) } });
		if (!r.ok) return;
		expect(alPedirla.get(r.valor.copiaDeAntes!)).toBe(MARCADORES.actual);
	});

	it("en cuanto la plataforma tiene la vuelta, deja constancia en R2 al lado de su copia de antes (….pedida), y no antes; la lista la pone en la fila de la copia", async () => {
		const central = await sembrada();
		/** Lo que hay en R2 de antes de volver cuando se le pide la vuelta a la plataforma. */
		const alPedirla: string[] = [];
		await conDobleDeInstantes(central, [], {
			alRestaurar: async () => {
				const { objects } = await bucket().list({ prefix: "base-central/antes-de-volver-" });
				alPedirla.push(...objects.map((o) => o.key));
			},
		});

		const r = await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const copia = r.valor.copiaDeAntes!;
		const pedida = copia.replace(/\.sql\.gz$/, ".pedida");
		expect(alPedirla).toContain(copia);
		expect(alPedirla).not.toContain(pedida);
		const constancia = await bucket().head(pedida);
		expect(constancia?.customMetadata).toMatchObject({ marcador: MARCADORES.actual, pedida: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
		expect(esClaveDeCopiaDeLaCentral(pedida)).toBe(false);

		const { copias } = await listarCopiasDeLaCentral(bucket(), 1000);
		expect(copias.find((c) => c.clave === copia)).toMatchObject({
			marcador: MARCADORES.actual,
			pedida: constancia!.customMetadata!.pedida,
		});
		expect(copias.map((c) => c.clave)).not.toContain(pedida);
	});

	it("si R2 no recibe la constancia de que se ha pedido, la vuelta sigue preparada: la plataforma ya la tiene", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		await conCopiasDentro(central, (real) => ({
			put: async (clave: string, valor: Uint8Array | string, opciones: R2PutOptions) => {
				if (clave.endsWith(".pedida")) throw new Error("R2 no contesta");
				return real.put(clave, valor, opciones);
			},
		}));

		expect(await central.stub.prepararVuelta({ marcador: "m-sin-constancia" })).toMatchObject({
			ok: true,
			valor: { marcador: "m-sin-constancia", deshacer: MARCADORES.actual, copiaDeAntes: expect.stringMatching(/\.sql\.gz$/) },
		});
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: "m-sin-constancia", fase: "preparada" });
		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_vuelta_en_curso");
	});

	it("la lista pone la constancia de una vuelta pedida en la fila de su .marcador, y sola sólo si no está ni su copia ni su .marcador", async () => {
		const deUnaVuelta = (que: string) => `base-central/antes-de-volver-prueba-${que}-${crypto.randomUUID()}`;
		const conMarcador = deUnaVuelta("con-marcador");
		const sola = deUnaVuelta("sola");
		await bucket().put(`${conMarcador}.marcador`, "m\n", { customMetadata: { marcador: "0000000a-0000000a" } });
		await bucket().put(`${conMarcador}.pedida`, "m\n", { customMetadata: { marcador: "0000000a-0000000a", pedida: "2031-01-01T00:00:01.000Z" } });
		await bucket().put(`${sola}.pedida`, "m\n", { customMetadata: { marcador: "0000000b-0000000b", pedida: "2031-01-01T00:00:02.000Z" } });

		const { copias } = await listarCopiasDeLaCentral(bucket(), 1000);
		const filaDe = (base: string) =>
			copias.filter((c) => c.clave.startsWith(base)).map((c) => ({ clave: c.clave, marcador: c.marcador, pedida: c.pedida }));
		expect(filaDe(conMarcador)).toEqual([
			{ clave: `${conMarcador}.marcador`, marcador: "0000000a-0000000a", pedida: "2031-01-01T00:00:01.000Z" },
		]);
		expect(filaDe(sola)).toEqual([{ clave: `${sola}.pedida`, marcador: "0000000b-0000000b", pedida: "2031-01-01T00:00:02.000Z" }]);
	});

	it("con la central sin atender, el marcador va solo en R2 (….marcador, que no es una copia), también antes de pedir la vuelta", async () => {
		const central = centralSinAprovisionar();
		await runInDurableObject(central.stub, (_o, state) =>
			state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/la-de-antes.sql.gz", desdeMs: 1 }),
		);
		const alPedirla = new Map<string, string>();
		await conDobleDeInstantes(central, [], {
			alRestaurar: async () => {
				const { objects } = await bucket().list({ prefix: "base-central/antes-de-volver-", include: ["customMetadata"] });
				for (const o of objects) if (o.customMetadata?.marcador) alPedirla.set(o.key, o.customMetadata.marcador);
			},
		});
		const antes = new Set((await bucket().list({ prefix: "base-central/" })).objects.map((o) => o.key));

		const r = await central.stub.prepararVuelta({ marcador: "m-de-salida" });
		expect(r).toMatchObject({ ok: true, valor: { deshacer: MARCADORES.actual, copiaDeAntes: null } });
		const nuevas = [...alPedirla.keys()].filter((clave) => !antes.has(clave));
		expect(nuevas).toEqual([expect.stringMatching(/^base-central\/antes-de-volver-.*\.marcador$/)]);
		expect(alPedirla.get(nuevas[0])).toBe(MARCADORES.actual);
		expect(esClaveDeCopiaDeLaCentral(nuevas[0])).toBe(false);
		expect(await (await bucket().get(nuevas[0]))!.text()).toBe(`${MARCADORES.actual}\n`);
	});

	it("con la central sin atender y R2 caído, no pide la vuelta: sin el marcador fuera, no se hace", async () => {
		const central = centralSinAprovisionar();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		await conR2Caido(central);
		expect(await central.stub.prepararVuelta({ marcador: "m-de-salida" })).toEqual({
			ok: false,
			error: "central_copia_fallida",
			detalle: "R2 no contesta",
		});
		expect(llamadas).toEqual(["actual"]);
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
	});

	it("hasta reiniciar no atiende a nadie: lo que se escribiera se perdería al volver", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		const antes = Date.now() - HORA;
		expect((await central.stub.prepararVuelta({ instanteMs: antes })).ok).toBe(true);

		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_vuelta_en_curso");
		expect(await codigoDe(central.db.execute({ sql: "INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('t-2', 1, 1);" }))).toBe(
			"central_vuelta_en_curso",
		);
		expect(await codigoDe(central.db.operar("revocarAMano", { licenseId: "x", ahoraMs: 0 }))).toBe("central_vuelta_en_curso");
		expect(await central.stub.copiar("2031-03-01")).toMatchObject({ ok: false, error: "central_vuelta_en_curso" });
		expect(await central.stub.aprovisionar()).toMatchObject({ ok: false, error: "central_vuelta_en_curso" });
		expect(await central.stub.estado()).toMatchObject({
			aprovisionada: true,
			filas: {},
			averia: { error: "central_vuelta_en_curso" },
			enCurso: { restauracion: null, vuelta: { destino: new Date(antes).toISOString(), desdeMs: expect.any(Number) } },
		});

		await central.stub.reiniciar(MARCADORES.actual);
		expect(llamadas.at(-1)).toBe("reiniciar");
		expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(1);
		expect((await central.stub.estado()).enCurso).toEqual({ restauracion: null, vuelta: null });
	});

	it("cierra antes de la copia de antes: lo que llega mientras sube no entra (no estaría en ella)", async () => {
		const central = await sembrada();
		await conDobleDeInstantes(central, []);
		// Una subida que se queda esperando, dentro del objeto, hasta que el test la suelta.
		const senal = { subiendo: false, suelta: false };
		await conCopiasDentro(central, (real) => ({
			put: async (clave: string, valor: Uint8Array, opciones: R2PutOptions) => {
				senal.subiendo = true;
				while (!senal.suelta) await new Promise((r) => setTimeout(r, 5));
				return real.put(clave, valor, opciones);
			},
		}));

		const preparando = central.stub.prepararVuelta({ instanteMs: Date.now() - HORA });
		await vi.waitFor(() => expect(senal.subiendo).toBe(true));
		const escribir = central.db.execute({
			sql: "INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('t-mientras', 1, 1);",
		});
		expect(await codigoDe(escribir)).toBe("central_vuelta_en_curso");

		senal.suelta = true;
		expect((await preparando).ok).toBe(true);
		expect(await filasDe(central, "SELECT tenant_id FROM tenants ORDER BY tenant_id;")).toEqual([{ tenant_id: "t-1" }]);
	});

	it("a un marcador (el `deshacer` de otra vuelta) no le pregunta a la plataforma por ningún instante; se deshace con el de ahora", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		expect(await central.stub.prepararVuelta({ marcador: "m-de-otra" })).toMatchObject({
			ok: true,
			valor: { marcador: "m-de-otra", deshacer: MARCADORES.actual },
		});
		expect(llamadas).toEqual(["actual", "restaurar:m-de-otra"]);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: "m-de-otra" });
	});

	it("rechaza un instante del futuro o de hace más de 30 días, sin tocar nada", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		for (const instanteMs of [Date.now() + HORA, Date.now() - 31 * DIA]) {
			expect(await central.stub.prepararVuelta({ instanteMs })).toEqual({ ok: false, error: "central_instante_fuera_de_plazo" });
		}
		expect(llamadas).toEqual([]);
		expect((await central.stub.estado()).enCurso).toEqual({ restauracion: null, vuelta: null });
		expect((await central.db.execute("SELECT 1 AS uno;")).rows[0].uno).toBe(1);
	});

	it("si la copia de antes no llega a R2, no prepara nada y la central sigue atendiendo", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		await conR2Caido(central);
		expect(await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA })).toEqual({
			ok: false,
			error: "central_copia_fallida",
			detalle: "R2 no contesta",
		});
		expect(llamadas).not.toContain(`restaurar:${MARCADORES.destino}`);
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
		expect((await central.db.execute("SELECT 1 AS uno;")).rows[0].uno).toBe(1);
	});

	it("con la central a medio restaurar también prepara, sin copia de antes; y mientras tanto no se restaura (vaciaría la marca y atendería con la vuelta pedida)", async () => {
		const central = centralSinAprovisionar();
		const aMedias = { clave: "base-central/la-de-antes.sql.gz", desdeMs: 1 };
		await runInDurableObject(central.stub, (_o, state) => state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, aMedias));
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas, { alReiniciar: () => {} });

		expect(await central.stub.prepararVuelta({ marcador: "m-de-salida" })).toEqual({
			ok: true,
			valor: { marcador: "m-de-salida", deshacer: MARCADORES.actual, copiaDeAntes: null, desdeMs: expect.any(Number) },
		});
		expect(llamadas).toEqual(["actual", "restaurar:m-de-salida"]);
		expect(await central.stub.aprovisionar({ claveDeCopia: "base-central/cualquiera.sql.gz" })).toMatchObject({
			ok: false,
			error: "central_vuelta_en_curso",
		});
		expect(await central.stub.aprovisionar()).toMatchObject({ ok: false, error: "central_vuelta_en_curso" });
		expect((await central.stub.estado()).enCurso).toMatchObject({
			restauracion: aMedias,
			vuelta: { destino: "m-de-salida", fase: "preparada" },
		});
	});

	it("si ya había otra preparada y ésta falla, la de antes sigue en pie: la central sigue cerrada, y dice adónde vuelve", async () => {
		const central = await sembrada();
		await conDobleDeInstantes(central, []);
		expect((await central.stub.prepararVuelta({ marcador: "m-primera" })).ok).toBe(true);
		const primera = (await central.stub.estado()).enCurso.vuelta;
		await conR2Caido(central);
		expect(await central.stub.prepararVuelta({ marcador: "m-segunda" })).toMatchObject({ ok: false, error: "central_copia_fallida" });
		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_vuelta_en_curso");
		expect((await central.stub.estado()).enCurso.vuelta).toEqual(primera);
		expect(primera).toMatchObject({ destino: "m-primera" });
	});
});

describe("lo que la plataforma no acepta vuelve como valor: la vuelta no se ha pedido", () => {
	const deAntesDeVolver = async () => (await bucket().list({ prefix: "base-central/antes-de-volver-" })).objects.map((o) => o.key);

	it.each([
		["al sacar el marcador del instante", "marcadorDe"],
		["al sacar el de ahora", "marcadorActual"],
		["al pedirle la vuelta", "restaurarAlReiniciar"],
	] as const)("si no la acepta %s, contesta central_vuelta_rechazada con lo que ha dicho; la marca se va, la central atiende y nada consta como pedido", async (_cuando, fallaAl) => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas, { fallaAl });
		const antes = new Set(await deAntesDeVolver());

		expect(await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA })).toEqual({
			ok: false,
			error: "central_vuelta_rechazada",
			detalle: RECHAZO_DE_LA_PLATAFORMA,
		});
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
		expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(1);
		// Sólo al pedirle la vuelta hay ya copia de antes; constancia de que se pidió, ninguna.
		const nuevas = (await deAntesDeVolver()).filter((clave) => !antes.has(clave));
		expect(nuevas).toEqual(fallaAl === "restaurarAlReiniciar" ? [expect.stringMatching(/\.sql\.gz$/)] : []);
	});

	it.each([
		["en mayúsculas", MARCADORES.actual.toUpperCase()],
		["vacío", ""],
		["con algo que no es de un marcador", "Ana Gil"],
	])("si el marcador de ahora que da la plataforma no tiene la forma de uno (%s), no pide la vuelta: no se podría deshacer con él (V-OP-4)", async (_que, raro) => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas, { marcadorActual: () => raro });
		const antes = new Set(await deAntesDeVolver());

		const r = await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA });
		expect(r).toMatchObject({ ok: false, error: "central_vuelta_rechazada", detalle: expect.stringContaining("no tiene la forma") });
		expect(llamadas).toEqual(["de:number", "actual"]);
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
		expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(1);
		expect((await deAntesDeVolver()).filter((clave) => !antes.has(clave))).toEqual([]);
	});

	it("con otra vuelta ya preparada, la que no acepta deja en pie la de antes: la central sigue cerrada", async () => {
		const central = await sembrada();
		await conDobleDeInstantes(central, []);
		expect((await central.stub.prepararVuelta({ marcador: "m-primera" })).ok).toBe(true);
		const primera = (await central.stub.estado()).enCurso.vuelta;
		await conDobleDeInstantes(central, [], { fallaAl: "restaurarAlReiniciar" });

		expect(await central.stub.prepararVuelta({ marcador: "m-segunda" })).toMatchObject({ ok: false, error: "central_vuelta_rechazada" });
		expect((await central.stub.estado()).enCurso.vuelta).toEqual(primera);
		expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_vuelta_en_curso");
	});
});

describe("dos preparaciones a la vez: sólo sigue una, y la marca es de quien la pone", () => {
	const A = "000000a0-00000000-00000000-0000000000000000000000000000000a";
	const B = "000000b0-00000000-00000000-0000000000000000000000000000000b";
	const pausa = () => new Promise((r) => setTimeout(r, 5));
	const copiasDeAntes = async () =>
		(await bucket().list({ prefix: "base-central/antes-de-volver-" })).objects.filter((o) => o.key.endsWith(".sql.gz")).length;
	/** Lo que se le ha pedido a la plataforma que deje preparado. */
	const pedidas = (llamadas: string[]) => llamadas.filter((l) => l.startsWith("restaurar:"));

	/** La primera subida (la de A) espera a que el test la suelte; después, sube o falla según `falla`. */
	async function conLaSubidaDeARetenida(central: CentralDePrueba, falla: boolean) {
		const senal = { primera: true, subiendo: false, suelta: false };
		await conCopiasDentro(central, (real) => ({
			put: async (clave: string, valor: Uint8Array, opciones: R2PutOptions) => {
				if (!senal.primera) return real.put(clave, valor, opciones);
				senal.primera = false;
				senal.subiendo = true;
				while (!senal.suelta) await pausa();
				if (falla) throw new Error("R2 no contesta");
				return real.put(clave, valor, opciones);
			},
		}));
		return senal;
	}

	it("B se queda la marca mientras A sube su copia y prepara bien; después falla A: la marca de B sigue, y la central sigue cerrada", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		const subidaDeA = await conLaSubidaDeARetenida(central, true);

		const a = central.stub.prepararVuelta({ marcador: A });
		await vi.waitFor(() => expect(subidaDeA.subiendo).toBe(true));
		expect(await central.stub.prepararVuelta({ marcador: B })).toMatchObject({ ok: true, valor: { marcador: B } });

		subidaDeA.suelta = true;
		expect(await a).toMatchObject({ ok: false, error: "central_copia_fallida" });
		expect(pedidas(llamadas)).toEqual([`restaurar:${B}`]);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: B, fase: "preparada" });
		const escribir = central.db.execute({
			sql: "INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('t-tras', 1, 1);",
		});
		expect(await codigoDe(escribir)).toBe("central_vuelta_en_curso");
		expect(await filasDe(central, "SELECT tenant_id FROM tenants ORDER BY tenant_id;")).toEqual([{ tenant_id: "t-1" }]);
	});

	it("si la copia de A sube después de que B se haya quedado la marca, A no pide su vuelta a la plataforma: sigue la de B", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		const subidaDeA = await conLaSubidaDeARetenida(central, false);

		const a = central.stub.prepararVuelta({ marcador: A });
		await vi.waitFor(() => expect(subidaDeA.subiendo).toBe(true));
		expect((await central.stub.prepararVuelta({ marcador: B })).ok).toBe(true);

		subidaDeA.suelta = true;
		expect(await a).toMatchObject({ ok: false, error: "central_vuelta_a_la_vez" });
		expect(pedidas(llamadas)).toEqual([`restaurar:${B}`]);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: B, fase: "preparada" });
	});

	it("mientras a A se le pide la vuelta a la plataforma, B no entra ni toca la marca", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		const senal = { pidiendo: false, suelta: false };
		await conDobleDeInstantes(central, llamadas, {
			alRestaurar: async () => {
				senal.pidiendo = true;
				while (!senal.suelta) await pausa();
			},
		});

		const a = central.stub.prepararVuelta({ marcador: A });
		await vi.waitFor(() => expect(senal.pidiendo).toBe(true));
		expect(await central.stub.prepararVuelta({ marcador: B })).toMatchObject({ ok: false, error: "central_vuelta_a_la_vez" });
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: A, fase: "programando" });

		senal.suelta = true;
		expect(await a).toMatchObject({ ok: true, valor: { marcador: A } });
		expect(pedidas(llamadas)).toEqual([`restaurar:${A}`]);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: A, fase: "preparada" });
	});

	it("el reinicio es de quien la prepara: sólo reinicia la vuelta preparada que se deshace con ese marcador; sin ninguna, con otra o con una pidiéndose a la plataforma, no reinicia y dice por qué", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		const deshacerDeA = "000000d0-00000000-00000000-0000000000000000000000000000000a";
		const deshacerDeB = "000000d0-00000000-00000000-0000000000000000000000000000000b";
		const actuales = [deshacerDeA, deshacerDeB];
		const senal = { pidiendoB: false, sueltaB: false };
		await conDobleDeInstantes(central, llamadas, {
			marcadorActual: () => actuales.shift()!,
			alRestaurar: async (m) => {
				if (m !== B) return;
				senal.pidiendoB = true;
				while (!senal.sueltaB) await pausa();
			},
		});
		const reinicios = () => llamadas.filter((l) => l === "reiniciar").length;

		expect(await central.stub.reiniciar(deshacerDeA)).toEqual({ ok: false, error: "central_sin_vuelta_preparada" });

		expect((await central.stub.prepararVuelta({ marcador: A })).ok).toBe(true);
		expect(await central.stub.reiniciar(deshacerDeB)).toMatchObject({ ok: false, error: "central_vuelta_a_la_vez" });

		// B se queda la marca, y se le está pidiendo a la plataforma: nadie la reinicia, tampoco A.
		const b = central.stub.prepararVuelta({ marcador: B });
		await vi.waitFor(() => expect(senal.pidiendoB).toBe(true));
		for (const deshacer of [deshacerDeA, deshacerDeB]) {
			expect(await central.stub.reiniciar(deshacer)).toMatchObject({ ok: false, error: "central_vuelta_a_la_vez" });
		}
		expect(reinicios()).toBe(0);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: B, fase: "programando" });

		senal.sueltaB = true;
		expect(await b).toMatchObject({ ok: true, valor: { marcador: B, deshacer: deshacerDeB } });
		expect(await central.stub.reiniciar(deshacerDeA)).toMatchObject({ ok: false, error: "central_vuelta_a_la_vez" });
		expect(reinicios()).toBe(0);

		await central.stub.reiniciar(deshacerDeB);
		expect(reinicios()).toBe(1);
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
	});

	it("repetir la misma orden con la vuelta ya preparada devuelve la misma, sin otra copia ni otra petición; a otro destino, prepara otra", async () => {
		const central = await sembrada();
		const llamadas: string[] = [];
		await conDobleDeInstantes(central, llamadas);
		const copias = await copiasDeAntes();

		const primera = await central.stub.prepararVuelta({ marcador: A });
		expect(primera.ok).toBe(true);
		expect(await central.stub.prepararVuelta({ marcador: A })).toEqual(primera);
		expect(pedidas(llamadas)).toEqual([`restaurar:${A}`]);
		expect(await copiasDeAntes()).toBe(copias + 1);

		expect(await central.stub.prepararVuelta({ marcador: B })).toMatchObject({ ok: true, valor: { marcador: B } });
		expect(pedidas(llamadas)).toEqual([`restaurar:${A}`, `restaurar:${B}`]);
		expect((await central.stub.estado()).enCurso.vuelta).toMatchObject({ destino: B, fase: "preparada" });
	});
});

describe("prepararVuelta, con la plataforma de verdad", () => {
	it("en local no hay vuelta a un instante: lo dice, no deja la marca y la central sigue atendiendo", async () => {
		const central = await sembrada();
		expect(await central.stub.prepararVuelta({ instanteMs: Date.now() - HORA })).toEqual({
			ok: false,
			error: "central_vuelta_no_disponible",
		});
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
		expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(1);
	});

	it("sin aprovisionar se puede volver (es la salida de una vuelta que la deja así), pero en local tampoco hay vuelta: lo dice y no deja la marca", async () => {
		const central = centralSinAprovisionar();
		expect(await central.stub.prepararVuelta({ marcador: "m" })).toEqual({ ok: false, error: "central_vuelta_no_disponible" });
		expect((await central.stub.estado()).enCurso.vuelta).toBeNull();
	});

	it("al arrancar, la marca que quede ya no dice nada (la vuelta se aplica en el arranque): se quita", async () => {
		const central = await sembrada();
		const tras = await runInDurableObject(central.stub, async (_objeto, state) => {
			// Lo que trae deshacer una vuelta: el objeto de justo antes de reiniciarse, con la marca puesta.
			state.storage.kv.put(CLAVE_VUELTA_EN_CURSO, { destino: "m-destino", desdeMs: 1 });
			const otra = new BaseCentral(state, env as any);
			return {
				ejecutar: await otra.ejecutar({ sql: "SELECT COUNT(*) AS n FROM tenants;", args: [] }),
				marca: state.storage.kv.get(CLAVE_VUELTA_EN_CURSO) ?? null,
			};
		});
		expect(tras.ejecutar).toMatchObject({ ok: true, valor: { rows: [[1]] } });
		expect(tras.marca).toBeNull();
	});
});
