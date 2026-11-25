// test/centralRestaurar.test.ts
//
// Restaurar la base central desde una copia de R2 (`durableObjects/baseCentral.restaurar.ts`):
// `aprovisionar({ claveDeCopia })` en un objeto sin aprovisionar. Que la copia vuelve entera lo
// comprueba la ida y vuelta de `copiaBaseCentral.test.ts`; aquí, que una central restaurada a medias
// no atiende nunca:
//
//   · una copia que no vale (no existe, gzip roto, cortada, de otra versión, con una tabla que no es
//     de la base, con una clave foránea rota) deja el objeto como estaba: sin aprovisionar, sin marca,
//     y el error dice por qué;
//   · en una central aprovisionada no toca nada;
//   · con la marca de una restauración a medias no atiende nadie, tampoco al arrancar, y la siguiente
//     restauración la vacía entera (también lo que la de antes dio por migrado) y termina;
//   · mientras restaura la marca está puesta, y no se intercala nada: lo que llega a la vez espera y
//     ve la central entera;
//   · las migraciones que le faltan a la copia se aplican después de cargar, sobre sus datos;
//   · con 50.000 filas vuelven todas, en varios lotes. Cuánto tarda (el límite es el de
//     `blockConcurrencyWhile`, 30 s) está medido en la cabecera de `baseCentral.restaurar.ts`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Migracion } from "../src/durableObjects/sqliteDelObjeto";
import {
	centralDePrueba,
	centralSinAprovisionar,
	codigoDe,
	conCopiasDentro,
	filasDe,
	fotoDeLaCentral,
	tablasPropias,
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

const { BaseCentral } = await import("../src/durableObjects/baseCentral");
const { copiarLaCentral } = await import("../src/durableObjects/baseCentral.copia");
const { CLAVE_RESTAURACION_EN_CURSO } = await import("../src/durableObjects/baseCentral.guardas");
const { migrarBase } = await import("../src/durableObjects/sqliteDelObjeto");
// Sin desestructurar: la lista se lee cada vez, con lo que el test haya añadido (`deMas`).
const migraciones = await import("../src/server/central/migraciones");

afterEach(() => {
	deMas.length = 0;
});

const bucket = () => (env as any).COPIAS as R2Bucket;

/** Una clave nueva en la carpeta de las copias de la central. */
const claveNueva = () => `base-central/prueba-${crypto.randomUUID()}.sql.gz`;

/** Lo que hay en las tablas de la central, en orden, sin `_migrations`: para comparar dos centrales. */
const contenido = (central: Pick<CentralDePrueba, "stub">) => fotoDeLaCentral(central, { sinMigraciones: true });

/** Una central con algo de todo: negocios, dispositivos y licencias. */
async function sembrada(): Promise<CentralDePrueba> {
	const central = await centralDePrueba();
	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, legal_name, notes, created_at_ms, updated_at_ms)
		 VALUES ('t-1', 'Bar Uno', 'abc', 1, 2), ('t-2', 'Bar Dos', NULL, 3, 4);`,
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms)
		 VALUES ('d-1', 't-1', 'tpv', 5, 6), ('d-2', 't-2', 'handy', 7, 8);`,
	);
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, status, term_months, origin, issued_at_ms, customer_email,
		   created_at_ms, updated_at_ms, tenant_id, main_device_id)
		 VALUES ('l-1', 'h-1', 'active', 12, 'manual', 1, 'bar@ejemplo.test', 1, 1, 't-1', 'd-1');`,
	);
	return central;
}

/** La copia de `central` (la de verdad, la que hace el objeto), sin comprimir. */
async function textoDeLaCopia(central: CentralDePrueba): Promise<string> {
	const clave = claveNueva();
	await runInDurableObject(central.stub, (_c, state) => copiarLaCentral(state.storage.sql, bucket(), clave));
	const objeto = await bucket().get(clave);
	return await new Response(objeto!.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Sube `texto` como copia, comprimido. Devuelve su clave. */
async function subir(texto: string | Uint8Array): Promise<string> {
	const clave = claveNueva();
	const bytes = typeof texto === "string" ? await comprimir(texto) : texto;
	await bucket().put(clave, bytes);
	return clave;
}

async function comprimir(texto: string): Promise<Uint8Array> {
	const flujo = new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(flujo).arrayBuffer());
}

/** Que el objeto se ha quedado como estaba: sin aprovisionar, sin marca y sin tablas. */
async function comoAntes(central: CentralDePrueba) {
	const estado = await central.stub.estado();
	expect(estado).toMatchObject({ aprovisionada: false, averia: null, enCurso: { restauracion: null, vuelta: null } });
	expect(await runInDurableObject(central.stub, (_c, state) => tablasPropias(state.storage.sql))).toEqual([]);
	expect(await codigoDe(central.db.execute("SELECT 1;"))).toBe("central_sin_aprovisionar");
}

describe("una copia que no vale deja el objeto como estaba, y dice por qué", () => {
	const lineasDe = (texto: string) => texto.split("\n");
	const casos: [string, (texto: string) => string, RegExp][] = [
		[
			"cortada: sin la línea del final",
			(t) => lineasDe(t).filter((l) => !l.startsWith("-- Fin de la copia")).join("\n"),
			/^copia_cortada: le falta la línea del final/,
		],
		[
			"cortada: con menos filas de las que dice",
			(t) => {
				const l = lineasDe(t);
				l.splice(l.findLastIndex((x) => x.startsWith('INSERT INTO "')), 1);
				return l.join("\n");
			},
			/^copia_cortada: dice \d+ filas y trae \d+/,
		],
		[
			"de otra versión",
			(t) => t.replace(/^-- Migraciones: (.*)$/m, "-- Migraciones: $1,9999_del_futuro.sql"),
			/^copia_de_otra_version: /,
		],
		[
			"sin la línea de las migraciones",
			(t) => lineasDe(t).filter((l) => !l.startsWith("-- Migraciones: ")).join("\n"),
			/^copia_no_valida: sin la línea de las migraciones/,
		],
		[
			"con una tabla que no es de la base",
			(t) => t.replace(/^-- Fin de la copia: (\d+)/m, (_m, n) => `INSERT INTO "inventada" ("a") VALUES (1);\n-- Fin de la copia: ${Number(n) + 1}`),
			/^copia_no_valida: una tabla que no es de la base: inventada/,
		],
		[
			"con filas de _migrations",
			(t) =>
				t.replace(
					/^-- Fin de la copia: (\d+)/m,
					(_m, n) => `INSERT INTO "_migrations" ("name", "hash", "applied_at") VALUES ('x', 'y', 1);\n-- Fin de la copia: ${Number(n) + 1}`,
				),
			/^copia_no_valida: una tabla que no es de la base: _migrations/,
		],
		[
			"con una clave foránea rota",
			(t) =>
				t.replace(
					/^-- Fin de la copia: (\d+)/m,
					(_m, n) =>
						`INSERT INTO "devices" ("device_id", "tenant_id", "role", "first_seen_at_ms", "last_seen_at_ms") VALUES ('huerfano', 't-no-existe', 'tpv', 1, 1);\n-- Fin de la copia: ${Number(n) + 1}`,
				),
			/^copia_no_valida: deja una clave foránea rota en devices/,
		],
	];

	it.each(casos)("%s", async (_que, estropear, motivo) => {
		const texto = estropear(await textoDeLaCopia(await sembrada()));
		const central = centralSinAprovisionar();
		const r = await central.stub.aprovisionar({ claveDeCopia: await subir(texto) });
		expect(r).toEqual({ ok: false, error: "central_copia_inservible", detalle: expect.stringMatching(motivo) });
		await comoAntes(central);
	});

	it("con el gzip roto", async () => {
		const gz = await comprimir(await textoDeLaCopia(await sembrada()));
		const central = centralSinAprovisionar();
		const r = await central.stub.aprovisionar({ claveDeCopia: await subir(gz.slice(0, Math.floor(gz.length / 2))) });
		expect(r).toEqual({
			ok: false,
			error: "central_copia_inservible",
			detalle: expect.stringMatching(/^copia_no_valida: no se puede descomprimir/),
		});
		await comoAntes(central);
	});

	it("si no existe, o la clave no es de una copia de la central", async () => {
		const central = centralSinAprovisionar();
		expect(await central.stub.aprovisionar({ claveDeCopia: claveNueva() })).toEqual({
			ok: false,
			error: "central_copia_inservible",
			detalle: expect.stringMatching(/^copia_no_encontrada: /),
		});
		for (const clave of ["negocios/t/2026-01-01.sql.gz", "base-central/../x.sql.gz", "base-central/x.sql", "base-central/.sql.gz"]) {
			expect(await central.stub.aprovisionar({ claveDeCopia: clave }), clave).toEqual({
				ok: false,
				error: "central_copia_inservible",
				detalle: expect.stringMatching(/^copia_no_valida: .* no es la clave de una copia de la central/),
			});
		}
		await comoAntes(central);
	});

	it("tras un fallo, el mismo objeto (la misma instancia) sigue sirviendo: vaciarlo se lleva también el SQL", async () => {
		const origen = await sembrada();
		const texto = await textoDeLaCopia(origen);
		const central = centralSinAprovisionar();
		// Una seña en la instancia: si sigue ahí al final, todo ha pasado en la misma.
		const instancia = crypto.randomUUID();
		const deLaInstancia = () =>
			runInDurableObject(central.stub, (objeto) => (objeto as unknown as { seña?: string }).seña);
		await runInDurableObject(central.stub, (objeto) => {
			(objeto as unknown as { seña: string }).seña = instancia;
		});
		const mala = await subir(lineasDe(texto).filter((l) => !l.startsWith("-- Fin de la copia")).join("\n"));
		expect((await central.stub.aprovisionar({ claveDeCopia: mala })).ok).toBe(false);
		await comoAntes(central);

		const buena = await central.stub.aprovisionar({ claveDeCopia: await subir(texto) });
		expect(buena.ok).toBe(true);
		expect(await contenido(central)).toEqual(await contenido(origen));
		expect(await deLaInstancia()).toBe(instancia);
	});
});

describe("en una central aprovisionada", () => {
	it("restaurar no toca nada", async () => {
		const origen = await sembrada();
		const clave = await subir(await textoDeLaCopia(origen));
		const central = await centralDePrueba();
		await filasDe(central, `INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('la-de-aqui', 1, 1);`);
		const antes = await contenido(central);

		expect(await central.stub.aprovisionar({ claveDeCopia: clave })).toEqual({ ok: false, error: "central_ya_aprovisionada" });
		expect(await contenido(central)).toEqual(antes);
		expect((await central.stub.estado()).enCurso).toEqual({ restauracion: null, vuelta: null });
	});
});

describe("una restauración a medias", () => {
	/** Lo que deja un objeto que se reinicia a mitad de restaurar: el esquema, parte de las filas y la marca. */
	async function aMedias(): Promise<CentralDePrueba> {
		const central = centralSinAprovisionar();
		await runInDurableObject(central.stub, async (_c, state) => {
			await migrarBase(state.storage, migraciones.MIGRACIONES_DE_LA_CENTRAL);
			state.storage.sql.exec(
				`INSERT INTO tenants (tenant_id, created_at_ms, updated_at_ms) VALUES ('a-medias', 1, 1);`,
			);
			state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/la-de-antes.sql.gz", desdeMs: 1 });
		});
		return central;
	}

	it("no atiende a nadie, ni deja aprovisionarla vacía, y no se toca", async () => {
		const central = await aMedias();
		expect(await codigoDe(central.db.execute("SELECT COUNT(*) AS n FROM tenants;"))).toBe("central_restauracion_a_medias");
		expect(await codigoDe(central.db.batch(["SELECT 1;"]))).toBe("central_restauracion_a_medias");
		expect(await codigoDe(central.db.operar("revocarAMano", { licenseId: "x", ahoraMs: 0 }))).toBe(
			"central_restauracion_a_medias",
		);
		expect(await central.stub.copiar("2031-02-01")).toMatchObject({ ok: false, error: "central_restauracion_a_medias" });
		expect(await central.stub.prepararVuelta({ marcador: "m" })).toMatchObject({ ok: false, error: "central_restauracion_a_medias" });
		expect(await central.stub.aprovisionar()).toMatchObject({ ok: false, error: "central_restauracion_a_medias" });

		const estado = await central.stub.estado();
		expect(estado).toMatchObject({
			aprovisionada: false,
			migraciones: [],
			filas: {},
			averia: { error: "central_restauracion_a_medias", detalle: expect.stringContaining("base-central/la-de-antes.sql.gz") },
			enCurso: { restauracion: { clave: "base-central/la-de-antes.sql.gz", desdeMs: 1 }, vuelta: null },
		});
		expect(await filasDe(central, "SELECT tenant_id FROM tenants;")).toEqual([{ tenant_id: "a-medias" }]);
	});

	it("al arrancar tampoco: ni se pone al día ni atiende", async () => {
		const central = await aMedias();
		deMas.push({ name: "9001_de_despues.sql", sql: "CREATE TABLE de_despues (a TEXT);" });
		const tras = await runInDurableObject(central.stub, async (_c, state) => {
			const otra = new BaseCentral(state, env as any);
			return {
				ejecutar: await otra.ejecutar({ sql: "SELECT 1;", args: [] }),
				migraciones: state.storage.sql.exec("SELECT name FROM _migrations;").toArray().map((f) => f.name),
			};
		});
		expect(tras.ejecutar).toMatchObject({ ok: false, error: "central_restauracion_a_medias" });
		expect(tras.migraciones).toEqual(["0001_inicial.sql"]);
	});

	it("la siguiente restauración la vacía y termina bien", async () => {
		const origen = await sembrada();
		const clave = await subir(await textoDeLaCopia(origen));
		const central = await aMedias();

		const r = await central.stub.aprovisionar({ claveDeCopia: clave });
		expect(r).toMatchObject({ ok: true, valor: { aprovisionada: true, copia: { clave, filas: 5 } } });
		expect(await contenido(central)).toEqual(await contenido(origen));
		expect((await central.stub.estado()).enCurso).toEqual({ restauracion: null, vuelta: null });
		expect((await central.db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(2);
	});

	it("la siguiente restauración empieza de vacío: las migraciones que ya apuntó la de antes se vuelven a aplicar, sobre la copia", async () => {
		// Una copia de una central de antes de una migración que transforma datos…
		const origen = await sembrada();
		const clave = await subir(await textoDeLaCopia(origen));
		// …y una restauración que se cortó después de apuntar esa migración, que ya está en el despliegue.
		deMas.push({ name: "9001_transforma.sql", sql: "UPDATE tenants SET notes = upper(notes) || '!';" });
		const central = await aMedias();
		expect(await filasDe(central, "SELECT name FROM _migrations ORDER BY rowid;")).toEqual([
			{ name: "0001_inicial.sql" },
			{ name: "9001_transforma.sql" },
		]);

		expect((await central.stub.aprovisionar({ claveDeCopia: clave })).ok).toBe(true);
		expect(await filasDe(central, "SELECT tenant_id, notes FROM tenants ORDER BY tenant_id;")).toEqual([
			{ tenant_id: "t-1", notes: "ABC!" },
			{ tenant_id: "t-2", notes: null },
		]);
	});
});

describe("mientras restaura", () => {
	it("no se intercala nada: lo que llega a la vez espera, y ve la central entera; y la marca está puesta", async () => {
		const origen = await sembrada();
		const clave = await subir(await textoDeLaCopia(origen));
		const central = centralSinAprovisionar();

		// Una copia que tarda en llegar: el objeto espera a la red a mitad de restaurar, y mientras tanto
		// se mira dentro qué marca tiene puesta (si el objeto se reiniciara ahí, es lo que lo dejaría sin
		// atender). Se avisan con banderas y temporizadores, cada uno en su lado: una promesa que resuelve
		// el objeto haría seguir al test dentro del objeto, y al revés.
		const senal = { empezada: false, suelta: false, marca: undefined as unknown };
		await conCopiasDentro(central, (real, state) => ({
			get: async (k: string) => {
				const o = await real.get(k);
				const lector = o!.body.getReader();
				let primero = true;
				return {
					body: new ReadableStream({
						async pull(c) {
							if (!primero && !senal.empezada) {
								senal.marca = state.storage.kv.get(CLAVE_RESTAURACION_EN_CURSO);
								senal.empezada = true;
								while (!senal.suelta) await new Promise((r) => setTimeout(r, 5));
							}
							primero = false;
							const { value, done } = await lector.read();
							if (done) c.close();
							else c.enqueue(value);
						},
					}),
				};
			},
		}));

		const restaurando = central.stub.aprovisionar({ claveDeCopia: clave });
		await vi.waitFor(() => expect(senal.empezada).toBe(true));
		let terminadas = 0;
		const contar = central.db.execute("SELECT COUNT(*) AS n FROM tenants;").finally(() => terminadas++);
		const estado = central.stub.estado().finally(() => terminadas++);
		await new Promise((r) => setTimeout(r, 100));
		expect(terminadas).toBe(0);
		expect(senal.marca).toEqual({ clave, desdeMs: expect.any(Number) });

		senal.suelta = true;
		expect((await restaurando).ok).toBe(true);
		expect((await contar).rows[0].n).toBe(2);
		expect(await estado).toMatchObject({
			aprovisionada: true,
			enCurso: { restauracion: null, vuelta: null },
			filas: { tenants: 2, devices: 2, licenses: 1 },
		});
	});

	it("las migraciones que le faltan a la copia se aplican después de cargar, sobre sus datos", async () => {
		const origen = await sembrada();
		const clave = await subir(await textoDeLaCopia(origen));
		deMas.push({ name: "9001_transforma.sql", sql: "UPDATE tenants SET notes = upper(notes) || '!';" });

		const central = centralSinAprovisionar();
		const r = await central.stub.aprovisionar({ claveDeCopia: clave });
		expect(r).toMatchObject({ ok: true, valor: { aprovisionada: true } });
		if (!r.ok) return;
		expect(r.valor.migraciones.map((m) => m.nombre)).toEqual(["0001_inicial.sql", "9001_transforma.sql"]);
		expect(await filasDe(central, "SELECT tenant_id, notes FROM tenants ORDER BY tenant_id;")).toEqual([
			{ tenant_id: "t-1", notes: "ABC!" },
			{ tenant_id: "t-2", notes: null },
		]);
	});
});

describe("con muchas filas", () => {
	/**
	 * `n` filas como las de la central: licencias con su correo, su clave cifrada y sus ids de Stripe,
	 * la auditoría con su JSON y los correos enviados, a partes iguales.
	 */
	async function conFilas(n: number): Promise<CentralDePrueba> {
		const central = await centralDePrueba();
		const tercio = Math.ceil(n / 3);
		await runInDurableObject(central.stub, (_c, state) => {
			const sql = state.storage.sql;
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				 INSERT INTO licenses (license_id, license_key_hash, license_key_enc, key_short, tenant_id, main_device_id, status,
				   term_months, origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email, customer_name,
				   stripe_customer_id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_price_id,
				   created_at_ms, updated_at_ms, customer_address_json)
				 SELECT lower(hex(randomblob(16))), hex(randomblob(32)), 'v1:' || hex(randomblob(48)), 'TPV-' || substr(hex(randomblob(3)), 1, 5),
				   lower(hex(randomblob(16))), lower(hex(randomblob(16))), 'active', 12, 'stripe', 1790000000000 + i, 1790000000000 + i,
				   1820000000000 + i, 'cliente' || i || '@bar-de-ejemplo.es', 'Bar Número ' || i,
				   'cus_' || hex(randomblob(7)), 'cs_live_' || hex(randomblob(28)), 'pi_' || hex(randomblob(12)), 'price_anual',
				   1790000000000 + i, 1790000000000 + i,
				   json_object('line1', 'Calle Mayor ' || i, 'city', 'Madrid', 'postal_code', '28013', 'country', 'ES')
				 FROM n;`,
				tercio,
			);
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				 INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms)
				 SELECT lower(hex(randomblob(16))), 'extend', lower(hex(randomblob(16))),
				   json_object('months', 12, 'expiresAtMs', 1820000000000 + i, 'keyShort', 'TPV-' || hex(randomblob(3)),
				     'email', 'cliente' || i || '@bar-de-ejemplo.es', 'nota', 'Renovación pedida por teléfono'),
				   1790000000000 + i
				 FROM n;`,
				tercio,
			);
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				 INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
				 SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))), lower(hex(randomblob(16))),
				   'proveedor' || i || '@distribuciones-ejemplo.es', 'resend', 1, NULL, 1790000000000 + i, 'pedido'
				 FROM n;`,
				n - 2 * tercio,
			);
		});
		return central;
	}

	it("50.000 vuelven todas, en varios lotes", async () => {
		const n = 50_000;
		const origen = await conFilas(n);
		const clave = claveNueva();
		const copia = await runInDurableObject(origen.stub, (_c, state) => copiarLaCentral(state.storage.sql, bucket(), clave));
		expect(copia.filas).toBe(n);

		const central = centralSinAprovisionar();
		const r = await central.stub.aprovisionar({ claveDeCopia: clave });
		expect(r).toMatchObject({ ok: true, valor: { copia: { filas: n } } });
		if (!r.ok) return;
		expect(r.valor.filas).toEqual((await origen.stub.estado()).filas);
		// Sin comprimir pasa de varias veces lo que entra en un lote (unos 4 millones de caracteres).
		const texto = await new Response((await bucket().get(clave))!.body.pipeThrough(new DecompressionStream("gzip"))).text();
		expect(texto.length).toBeGreaterThan(3 * 4 * 1024 * 1024);
	}, 120_000);
});
