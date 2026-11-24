// test/centralCliente.test.ts
//
// El contrato de la base central vista desde el worker (`server/central/cliente.ts`), contra su
// objeto de verdad (`BaseCentral`). Lo que las consultas de la central dan por hecho tiene que seguir
// siendo verdad:
//
//   · `rowsAffected` son las filas que ha cambiado la sentencia (`changes()`), no las que ha escrito
//     con sus índices: es lo que decide una carrera (un UPDATE condicionado, un INSERT OR IGNORE, un
//     upsert cuyo WHERE no escribe);
//   · las filas se leen por nombre y por posición, y `columns` dice cuáles son;
//   · un lote es todo o nada;
//   · un error lanza siempre: nunca sale como filas vacías;
//   · el plazo suelta a quien espera, pero no cancela la llamada.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { aResultado } from "../src/durableObjects/sqliteDelObjeto";
import { CentralNoDisponible, clienteCentral, ErrorDeLaCentral } from "../src/server/central/cliente";
import { centralDePrueba, filasDe } from "./helpers/central";

const TENANT = (id: string, status = "active") => ({
	sql: "INSERT INTO tenants (tenant_id, status) VALUES (?1, ?2);",
	args: [id, status],
});

describe("rowsAffected son las filas cambiadas, no las escritas", () => {
	it("un UPDATE cuenta sus filas, aunque escriba también en un índice", async () => {
		const { db, stub } = await centralDePrueba();
		await db.batch([TENANT("t1"), TENANT("t2"), TENANT("t3", "suspended")]);

		const r = await db.execute({ sql: "UPDATE tenants SET status = 'deleted' WHERE status = ?1;", args: ["active"] });
		expect(r.rowsAffected).toBe(2);
		expect(r.rows).toEqual([]);
		expect(r.lastInsertRowid).toBeNull();

		// `status` tiene índice: lo escrito incluye sus filas, y por eso no sirve como `rowsAffected`.
		const enBruto = await stub.ejecutar({ sql: "UPDATE tenants SET status = 'active' WHERE status = 'deleted';", args: [] });
		expect(enBruto.ok && enBruto.valor.rowsAffected).toBe(2);
		expect(enBruto.ok && enBruto.valor.filasEscritas).toBeGreaterThan(2);

		const ninguna = await db.execute({ sql: "UPDATE tenants SET notes = 'x' WHERE tenant_id = ?1;", args: ["no-existe"] });
		expect(ninguna.rowsAffected).toBe(0);
	});

	it("un INSERT OR IGNORE cuenta 1 la primera vez y 0 la segunda", async () => {
		const { db } = await centralDePrueba();
		const aviso = {
			sql: "INSERT OR IGNORE INTO license_notices (license_id, kind, expires_at_ms, sent_at_ms) VALUES (?1, ?2, ?3, ?4);",
			args: ["lic-1", "expira_30", 1000, 2000],
		};
		const primero = await db.execute(aviso);
		expect(primero.rowsAffected).toBe(1);
		expect(typeof primero.lastInsertRowid).toBe("number");
		expect((await db.execute(aviso)).rowsAffected).toBe(0);
	});

	it("un upsert cuyo WHERE no escribe cuenta 0, y 1 cuando escribe", async () => {
		const { db } = await centralDePrueba();
		const fallo = (ip: string, ahora: number) => ({
			sql: `INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms) VALUES (?1, 1, ?2)
			      ON CONFLICT(ip) DO UPDATE SET fallos = fallos + 1, ultimo_fallo_ms = excluded.ultimo_fallo_ms
			      WHERE pair_claim_fallos.bloqueado_hasta_ms < excluded.ultimo_fallo_ms;`,
			args: [ip, ahora],
		});
		expect((await db.execute(fallo("1.2.3.4", 100))).rowsAffected).toBe(1);
		await db.execute({ sql: "UPDATE pair_claim_fallos SET bloqueado_hasta_ms = 500 WHERE ip = ?1;", args: ["1.2.3.4"] });
		expect((await db.execute(fallo("1.2.3.4", 200))).rowsAffected).toBe(0);
		expect((await db.execute(fallo("1.2.3.4", 600))).rowsAffected).toBe(1);
		const filas = await db.execute({ sql: "SELECT fallos FROM pair_claim_fallos WHERE ip = ?1;", args: ["1.2.3.4"] });
		expect(filas.rows[0].fallos).toBe(2);
	});

	it("un DELETE … RETURNING cuenta lo que borra y devuelve sus filas", async () => {
		const { db } = await centralDePrueba();
		await db.batch([
			{ sql: "INSERT INTO Ws_Tickets (ticket, tenant_id, device_id, expires_at_ms) VALUES ('a', 't', 'd1', 10);" },
			{ sql: "INSERT INTO Ws_Tickets (ticket, tenant_id, device_id, expires_at_ms) VALUES ('b', 't', 'd2', 20);" },
			{ sql: "INSERT INTO Ws_Tickets (ticket, tenant_id, device_id, expires_at_ms) VALUES ('c', 't', 'd3', 99);" },
		]);
		const r = await db.execute({
			sql: "DELETE FROM Ws_Tickets WHERE expires_at_ms < ?1 RETURNING ticket, device_id;",
			args: [50],
		});
		expect(r.rowsAffected).toBe(2);
		expect(r.columns).toEqual(["ticket", "device_id"]);
		expect(r.rows.map((f) => f.ticket).sort()).toEqual(["a", "b"]);
	});

	it("un WITH … INSERT cuenta lo que inserta; un WITH que sólo lee, nada", async () => {
		const { db } = await centralDePrueba();
		const insertar = await db.execute({
			sql: "WITH nuevos(id) AS (VALUES (?1), (?2)) INSERT INTO tenants (tenant_id) SELECT id FROM nuevos;",
			args: ["w1", "w2"],
		});
		expect(insertar.rowsAffected).toBe(2);
		expect(typeof insertar.lastInsertRowid).toBe("number");

		const leer = await db.execute("WITH t AS (SELECT tenant_id FROM tenants) SELECT COUNT(*) AS n FROM t;");
		expect(leer.rowsAffected).toBe(0);
		expect(leer.rows[0].n).toBe(2);
	});
});

describe("las filas", () => {
	it("se leen por nombre y por posición, y sólo los nombres se enumeran", async () => {
		const { db } = await centralDePrueba();
		await db.execute(TENANT("t1"));
		const r = await db.execute({ sql: "SELECT tenant_id, status, piloto FROM tenants WHERE tenant_id = ?1;", args: ["t1"] });
		expect(r.columns).toEqual(["tenant_id", "status", "piloto"]);
		const fila = r.rows[0];
		expect(fila.tenant_id).toBe("t1");
		expect(fila[0]).toBe("t1");
		expect(fila[1]).toBe("active");
		expect(fila.piloto).toBe(0);
		expect(fila.length).toBe(3);
		expect(Object.keys(fila)).toEqual(["tenant_id", "status", "piloto"]);
		expect(JSON.parse(JSON.stringify(fila))).toEqual({ tenant_id: "t1", status: "active", piloto: 0 });
	});

	it("si dos columnas se llaman igual, el nombre se queda con la primera y las dos tienen su posición", () => {
		const r = aResultado({ columns: ["x", "x"], rows: [[1, 2]], rowsAffected: 0, lastInsertRowid: null });
		expect(r.rows[0].x).toBe(1);
		expect([r.rows[0][0], r.rows[0][1]]).toEqual([1, 2]);
	});

	it("un entero de más de 2^53 vuelve redondeado, sin aviso", async () => {
		const { db } = await centralDePrueba();
		const r = await db.execute("SELECT 9007199254740993 AS v, typeof(9007199254740993) AS t;");
		expect(r.rows[0]).toMatchObject({ v: 9007199254740992, t: "integer" });
	});

	it("un blob vuelve como ArrayBuffer", async () => {
		const { db } = await centralDePrueba();
		const r = await db.execute({ sql: "SELECT ?1 AS b;", args: [new Uint8Array([7, 8, 9]).buffer] });
		expect(r.rows[0].b).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(r.rows[0].b as ArrayBuffer)]).toEqual([7, 8, 9]);
	});
});

describe("con plazo", () => {
	it("contra el objeto de verdad, contesta lo mismo", async () => {
		const { stub } = await centralDePrueba();
		const db = clienteCentral(() => stub, { plazoMs: 5_000 });
		await db.batch([TENANT("t1"), TENANT("t2")]);
		expect((await db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(2);
		await expect(db.execute(TENANT("t1"))).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("con la central ocupada, suelta a quien espera al vencer; la llamada no se cancela y escribe después", async () => {
		const central = await centralDePrueba();
		// La central no atiende a nadie durante medio segundo (un arranque, una copia).
		let ocupandose = false;
		const ocupada = runInDurableObject(central.stub, (_objeto, state) =>
			state.blockConcurrencyWhile(async () => {
				ocupandose = true;
				await new Promise((r) => setTimeout(r, 500));
			}),
		);
		await vi.waitFor(() => expect(ocupandose).toBe(true));

		const db = clienteCentral(() => central.stub, { plazoMs: 50 });
		const error: any = await db.execute(TENANT("tarde")).catch((e) => e);
		expect(error).toBeInstanceOf(CentralNoDisponible);
		expect(error).toMatchObject({ motivo: "plazo", code: "hub_unavailable" });

		await ocupada;
		// Un RPC no se puede cortar: la llamada vencida seguía en la cola y, al soltarse, ha entrado.
		await vi.waitFor(async () => expect(await filasDe(central, "SELECT tenant_id FROM tenants;")).toEqual([{ tenant_id: "tarde" }]));
	});
});

describe("un lote", () => {
	it("devuelve el resultado de cada sentencia, en orden", async () => {
		const { db } = await centralDePrueba();
		const [alta, cuenta] = await db.batch([TENANT("t1"), "SELECT COUNT(*) AS n FROM tenants;"]);
		expect(alta.rowsAffected).toBe(1);
		expect(cuenta.rows[0].n).toBe(1);
	});

	it("es todo o nada: si una sentencia falla, no queda nada de las anteriores", async () => {
		const { db } = await centralDePrueba();
		await expect(db.batch([TENANT("t1"), TENANT("t2"), TENANT("t1")])).rejects.toThrow(/UNIQUE constraint failed/);
		expect((await db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(0);
	});

	it("respeta las claves foráneas dentro del lote", async () => {
		const { db } = await centralDePrueba();
		const dispositivo = {
			sql: "INSERT INTO devices (device_id, tenant_id, role) VALUES (?1, ?2, 'tpv');",
			args: ["d1", "t1"],
		};
		await expect(db.batch([dispositivo])).rejects.toThrow(/FOREIGN KEY constraint failed/);
		await db.batch([TENANT("t1"), dispositivo]);
		expect((await db.execute("SELECT COUNT(*) AS n FROM devices;")).rows[0].n).toBe(1);
	});
});

describe("un error lanza: nunca son filas vacías", () => {
	it("una restricción violada", async () => {
		const { db } = await centralDePrueba();
		await expect(db.execute(TENANT("t1", "inventado"))).rejects.toThrow(/CHECK constraint failed/);
		await expect(
			db.execute({ sql: "INSERT INTO devices (device_id, tenant_id, role) VALUES ('d', 'no-existe', 'tpv');" }),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
	});

	it("una sentencia que no se puede ejecutar", async () => {
		const { db } = await centralDePrueba();
		await expect(db.execute("SELECT columna_que_no_existe FROM tenants;")).rejects.toThrow(/no such column/);
		await expect(db.execute("SELECT * FROM tabla_que_no_existe;")).rejects.toThrow(/no such table/);
	});

	it("con su código: un error de SQL es un 500, como siempre", async () => {
		const { db } = await centralDePrueba();
		const error: any = await db.execute("SELECT * FROM tabla_que_no_existe;").catch((e) => e);
		expect(error).toBeInstanceOf(ErrorDeLaCentral);
		expect(error).toMatchObject({ code: "central_error_sql", status: 500 });
	});
});
