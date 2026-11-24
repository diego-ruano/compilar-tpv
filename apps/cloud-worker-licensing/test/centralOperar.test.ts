// test/centralOperar.test.ts
//
// Las operaciones de la base central (`durableObjects/baseCentral.operar.ts`) y lo que hace el cliente
// cuando la central no contesta como debe (`server/central/cliente.ts`).
//
// Una operación corre entera dentro de una transacción de su objeto: lo que escribe entra todo o no
// entra nada, y tiene que ser síncrona de verdad. Una que espera (`async`) dejaría lo de después de su
// `await` fuera de la transacción: se rechaza, y lo que intente escribir después ya no entra.
//
// Del cliente: un plazo vencido, un objeto saturado o con un fallo pasajero, y lo que el objeto
// contesta que no ha hecho salen cada uno con su error, nunca como filas vacías, y sin dejar ningún
// rechazo sin recoger.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ejecutarOperacion } from "../src/durableObjects/baseCentral.operar";
import { CentralNoDisponible, clienteCentral, ErrorDeLaCentral } from "../src/server/central/cliente";
import type { Operacion } from "../src/server/central/operaciones/registro";
import { centralDePrueba } from "./helpers/central";

const TENANT = (id: string) => ({ sql: "INSERT INTO tenants (tenant_id) VALUES (?1);", args: [id] });

/** Ejecuta `nombre` de `operaciones` en una central de verdad y devuelve su respuesta y sus tenants. */
async function operar(operaciones: Record<string, Operacion>, nombre: string, datos: unknown = null) {
	const { stub } = await centralDePrueba();
	return runInDurableObject(stub, async (_c, state) => {
		const respuesta = ejecutarOperacion(state.storage, operaciones, nombre, datos);
		// Lo que una operación asíncrona haría después de su `await`, ya ha tenido su ocasión.
		await new Promise((r) => setTimeout(r, 10));
		const tenants = state.storage.sql
			.exec("SELECT tenant_id FROM tenants ORDER BY tenant_id;")
			.toArray()
			.map((r: any) => r.tenant_id);
		return { respuesta, tenants };
	});
}

describe("una operación", () => {
	it("que no se conoce no hace nada: es un despliegue a medias", async () => {
		const { db } = await centralDePrueba();
		for (const nombre of ["no_existe", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
			const error: any = await db.operar(nombre, {}).catch((e) => e);
			expect(error, nombre).toBeInstanceOf(ErrorDeLaCentral);
			expect(error.code, nombre).toBe("central_operacion_desconocida");
			expect(error.status, nombre).toBe(503);
		}
	});

	it("síncrona: confirma lo que escribe y devuelve su resultado", async () => {
		const { respuesta, tenants } = await operar(
			{
				alta: (sql, datos) => {
					const { id } = datos as { id: string };
					sql.execute(TENANT(id));
					const r = sql.execute({ sql: "SELECT COUNT(*) AS n FROM tenants;" });
					return { hecho: true, n: r.rows[0].n };
				},
			},
			"alta",
			{ id: "t1" },
		);
		expect(respuesta).toEqual({ ok: true, valor: { hecho: true, n: 1 } });
		expect(tenants).toEqual(["t1"]);
	});

	it("si lanza a mitad, no queda nada de lo que escribió", async () => {
		const { respuesta, tenants } = await operar(
			{
				aMedias: (sql) => {
					sql.execute(TENANT("t1"));
					sql.execute(TENANT("t2"));
					throw new Error("fallo a mitad");
				},
			},
			"aMedias",
		);
		expect(respuesta).toEqual({ ok: false, error: "central_operacion_fallida", detalle: "fallo a mitad" });
		expect(tenants).toEqual([]);
	});

	it("si una sentencia falla, tampoco", async () => {
		const { respuesta, tenants } = await operar({ repetida: (sql) => [TENANT("t1"), TENANT("t1")].map((s) => sql.execute(s)) }, "repetida");
		expect(respuesta).toMatchObject({ ok: false, error: "central_operacion_fallida", detalle: expect.stringMatching(/UNIQUE/) });
		expect(tenants).toEqual([]);
	});

	it("asíncrona: se rechaza, y no queda ni lo de antes de su await ni lo de después", async () => {
		let despuesDelAwait = "";
		const { respuesta, tenants } = await operar(
			{
				asincrona: (async (sql: Parameters<Operacion>[0]) => {
					sql.execute(TENANT("antes"));
					await Promise.resolve();
					try {
						sql.execute(TENANT("despues"));
					} catch (e) {
						despuesDelAwait = (e as Error).message;
					}
				}) as Operacion,
			},
			"asincrona",
		);
		expect(respuesta).toMatchObject({ ok: false, error: "central_operacion_fallida", detalle: expect.stringMatching(/síncrona/) });
		expect(tenants).toEqual([]);
		expect(despuesDelAwait).toMatch(/ya ha terminado/);
	});

	it("asíncrona y que falla después: su rechazo no queda sin recoger", async () => {
		const { respuesta, tenants } = await operar(
			{
				asincrona: (async (sql: Parameters<Operacion>[0]) => {
					await Promise.resolve();
					sql.execute(TENANT("despues"));
				}) as Operacion,
			},
			"asincrona",
		);
		expect(respuesta).toMatchObject({ ok: false, error: "central_operacion_fallida" });
		expect(tenants).toEqual([]);
	});

	it("cualquier cosa con `then` cuenta como promesa", async () => {
		const { respuesta } = await operar({ conThen: () => ({ then() {} }) }, "conThen");
		expect(respuesta).toMatchObject({ ok: false, error: "central_operacion_fallida" });
	});

	it.each([
		["una instancia de una clase propia", () => ({ cosa: new (class Cosa {})() })],
		["una función", () => ({ despues: () => 1 })],
		["una fecha, dentro de un array", () => [1, [new Date(0)]]],
	])("que devuelve %s: se rechaza, y no queda nada de lo que escribió", async (_que, devolver) => {
		const { respuesta, tenants } = await operar(
			{
				noEsUnDato: (sql) => {
					sql.execute(TENANT("t1"));
					return devolver();
				},
			},
			"noEsUnDato",
		);
		expect(respuesta).toMatchObject({ ok: false, error: "central_operacion_fallida", detalle: expect.stringMatching(/no es un dato/) });
		expect(tenants).toEqual([]);
	});

	it("que devuelve datos, también filas y bytes, los devuelve por el RPC", async () => {
		const { stub } = await centralDePrueba();
		const devuelto = await runInDurableObject(stub, (_c, state) => {
			const respuesta = ejecutarOperacion(
				state.storage,
				{
					datos: (sql) => {
						sql.execute(TENANT("t1"));
						const fila = sql.execute({ sql: "SELECT tenant_id, piloto FROM tenants;" }).rows[0];
						return { fila, lista: [1, "a", null, undefined, true], bytes: new Uint8Array([1, 2]).buffer, nada: undefined };
					},
				},
				"datos",
				null,
			);
			// Lo que viaja por el RPC es su copia estructurada.
			return structuredClone(respuesta);
		});
		expect(devuelto).toMatchObject({ ok: true, valor: { fila: { tenant_id: "t1", piloto: 0 }, lista: [1, "a", null, undefined, true] } });
		expect([...new Uint8Array((devuelto as any).valor.bytes)]).toEqual([1, 2]);
	});

	it("su base enlaza como la central y no ejecuta lo que la central no ejecuta", async () => {
		const enlace = await operar({ enlace: (sql) => sql.execute({ sql: "SELECT ?1 AS v;", args: [true as any] }).rows[0].v }, "enlace");
		expect(enlace.respuesta).toEqual({ ok: true, valor: 1 });
		const pragma = await operar({ pragma: (sql) => sql.execute("PRAGMA foreign_keys = OFF;") }, "pragma");
		expect(pragma.respuesta).toMatchObject({ ok: false, error: "central_operacion_fallida", detalle: expect.stringMatching(/sólo ejecuta/) });
	});
});

describe("el cliente, cuando la central no contesta como debe", () => {
	/** Los rechazos que nadie recoge mientras dura cada test. */
	const sinRecoger: unknown[] = [];
	const apuntar = (evento: PromiseRejectionEvent) => {
		sinRecoger.push(evento.reason);
	};
	beforeEach(() => {
		sinRecoger.length = 0;
		globalThis.addEventListener("unhandledrejection", apuntar);
	});
	afterEach(() => globalThis.removeEventListener("unhandledrejection", apuntar));

	const VACIO = { ok: true, valor: { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: null } };
	const tras = <T>(ms: number, hacer: () => T) => new Promise<T>((r) => setTimeout(() => r(hacer()), ms));
	/** El cliente sobre un doble del stub, que da siempre el mismo. */
	const deUnStub = (stub: object, opciones?: { plazoMs?: number }) => clienteCentral(() => stub as any, opciones);

	it("con el plazo vencido sale CentralNoDisponible, y la llamada que pierde no deja rechazos sin recoger", async () => {
		const stub = { ejecutar: () => tras(30, () => Promise.reject(new Error("la central contesta tarde"))) };
		const db = deUnStub(stub, { plazoMs: 5 });
		const error: any = await db.execute("SELECT 1;").catch((e) => e);
		expect(error).toBeInstanceOf(CentralNoDisponible);
		expect(error).toMatchObject({ motivo: "plazo", code: "hub_unavailable", status: 503 });
		// La llamada perdedora falla después, sin nadie esperándola.
		await tras(60, () => null);
		expect(sinRecoger).toEqual([]);
	});

	it("una que no contesta nunca, también", async () => {
		const db = deUnStub({ lote: () => new Promise(() => {}) }, { plazoMs: 5 });
		await expect(db.batch(["SELECT 1;"])).rejects.toBeInstanceOf(CentralNoDisponible);
	});

	it("a tiempo, devuelve lo suyo", async () => {
		const db = deUnStub({ ejecutar: () => tras(5, () => VACIO) }, { plazoMs: 1_000 });
		expect(await db.execute("SELECT 1;")).toEqual({ columns: [], rows: [], rowsAffected: 0, lastInsertRowid: null });
		expect(sinRecoger).toEqual([]);
	});

	it.each([
		["saturada", { overloaded: true }, "hub_overloaded"],
		["pasajera", { retryable: true }, "hub_unavailable"],
	])("lo que la plataforma marca como %s es CentralNoDisponible, con el código del objeto de un negocio", async (motivo, marca, code) => {
		const causa = Object.assign(new Error("de la plataforma"), marca);
		const db = deUnStub({ operar: async () => Promise.reject(causa) });
		const error: any = await db.operar("x", {}).catch((e) => e);
		expect(error).toBeInstanceOf(CentralNoDisponible);
		expect(error).toMatchObject({ motivo, code, status: 503, cause: causa });
	});

	it("cualquier otro fallo del viaje sale tal cual", async () => {
		const causa = new Error("otra cosa");
		const db = deUnStub({ ejecutar: async () => Promise.reject(causa) });
		await expect(db.execute("SELECT 1;")).rejects.toBe(causa);
	});

	it("cada viaje pide su stub: el que ha fallado no se vuelve a usar", async () => {
		const roto = { ejecutar: async () => Promise.reject(new Error("stub roto")) };
		const bueno = { ejecutar: async () => VACIO, lote: async () => ({ ok: true, valor: [] }), operar: async () => ({ ok: true, valor: 7 }) };
		const stubs = [roto, bueno, bueno, bueno];
		let pedidos = 0;
		const db = clienteCentral(() => stubs[pedidos++] as any);
		await expect(db.execute("SELECT 1;")).rejects.toThrow("stub roto");
		expect(await db.execute("SELECT 1;")).toMatchObject({ rows: [] });
		expect(await db.batch([])).toEqual([]);
		expect(await db.operar("x", {})).toBe(7);
		expect(pedidos).toBe(4);
	});

	it("lo que el objeto contesta que no ha hecho sale con su código, su estado y su detalle", async () => {
		const db = deUnStub({
			ejecutar: async () => ({ ok: false, error: "central_error_sql", detalle: "UNIQUE constraint failed: tenants.tenant_id" }),
			lote: async () => ({ ok: false, error: "central_sin_aprovisionar" }),
		});
		const sql: any = await db.execute("SELECT 1;").catch((e) => e);
		expect(sql).toBeInstanceOf(ErrorDeLaCentral);
		expect(sql).toMatchObject({ code: "central_error_sql", status: 500 });
		expect(sql.message).toBe("central_error_sql: UNIQUE constraint failed: tenants.tenant_id");
		// El detalle no viaja en la respuesta HTTP: sólo el código.
		expect(sql.details).toBeUndefined();

		const sinAprovisionar: any = await db.batch(["SELECT 1;"]).catch((e) => e);
		expect(sinAprovisionar).toMatchObject({ code: "central_sin_aprovisionar", status: 503, message: "central_sin_aprovisionar" });
	});
});
