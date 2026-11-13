// test/baseEnElDo.test.ts
//
// La base del negocio en el SQLite del TenantHub.
//
// Lo que el resto del worker da por hecho de un `Client` de libsql tiene que seguir siendo verdad
// con la base dentro del DO: `rowsAffected` cuenta filas y no índices, el `Seq` sale de
// `lastInsertRowid`, un lote es todo o nada, y una clave foránea rota se rechaza sin tumbar el DO.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { enElHub } from "./helpers/hub";
import { leerParaLaWeb } from "../src/domains/reservas_web/lecturasDeLaWeb";
import { provisionTenantDatabase } from "../src/domains/licensing/licensing.helpers";
import {
	baseAprovisionada,
	clienteLocal,
	ejecutarEnBruto,
	loteEnBruto,
	migrarBaseLocal,
} from "../src/durableObjects/tenantHub.sqlite";

const COMANDA = (id: string) => ({
	sql: "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES (?1, 'BARRA', '2026-11-11 10:00:00');",
	args: [id],
});
const LINEA = (id: string, comanda: string) => ({
	sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES (?1, ?2, 1, 150);",
	args: [id, comanda],
});
const DEFER = "PRAGMA defer_foreign_keys = ON;";

describe("esquema", () => {
	it("se crea una vez, queda registrado y migrar otra vez no hace nada", async () => {
		await enElHub("base-esquema", async (hub) => {
			const st = hub.state.storage as DurableObjectStorage;
			expect(baseAprovisionada(st.sql)).toBe(false);
			await migrarBaseLocal(st);
			expect(baseAprovisionada(st.sql)).toBe(true);
			const migraciones = st.sql.exec("SELECT name FROM _migrations ORDER BY name;").toArray();
			expect(migraciones.map((r: any) => r.name)).toEqual(["0001_inicial.sql", "0002_negocio.sql"]);
			await migrarBaseLocal(st);
			expect(st.sql.exec("SELECT COUNT(*) AS n FROM _migrations;").one().n).toBe(2);
		});
	});
});

describe("el cliente local tiene la semántica de libsql", () => {
	it("rowsAffected cuenta filas (no índices) y lastInsertRowid sale del INSERT", async () => {
		await enElHub("base-semantica", async (hub) => {
			const st = hub.state.storage as DurableObjectStorage;
			await migrarBaseLocal(st);
			const insert = ejecutarEnBruto(st.sql, COMANDA("c1"));
			expect(insert.rowsAffected).toBe(1);
			expect(insert.lastInsertRowid).toBeGreaterThan(0);

			const ninguna = ejecutarEnBruto(st.sql, {
				sql: "UPDATE Comandas SET Estado = 'Pagada' WHERE ID_Comanda = 'no-existe';",
			});
			expect(ninguna.rowsAffected).toBe(0);

			const lectura = ejecutarEnBruto(st.sql, { sql: "SELECT ID_Comanda, Canal FROM Comandas;" });
			expect(lectura.rowsAffected).toBe(0);
			expect(lectura.columns).toEqual(["ID_Comanda", "Canal"]);
			expect(lectura.rows).toEqual([["c1", "BARRA"]]);

			const db = clienteLocal(st);
			const rs = await db.execute({ sql: "SELECT ID_Comanda, Canal FROM Comandas;", args: [] });
			const fila: any = rs.rows[0];
			expect(fila.ID_Comanda).toBe("c1");
			expect(fila[1]).toBe("BARRA");
			expect(Object.keys(fila)).toEqual(["ID_Comanda", "Canal"]);
		});
	});

	it("un lote es todo o nada", async () => {
		await enElHub("base-lote", async (hub) => {
			const st = hub.state.storage as DurableObjectStorage;
			await migrarBaseLocal(st);
			expect(() =>
				loteEnBruto(st, [COMANDA("c1"), { sql: "INSERT INTO Tabla_Que_No_Existe (a) VALUES (1);" }]),
			).toThrow(/no such table/);
			expect(st.sql.exec("SELECT COUNT(*) AS n FROM Comandas;").one().n).toBe(0);
		});
	});
});

describe("claves foráneas aplazadas", () => {
	it("una hija antes que su padre entra, como en la Main", async () => {
		await enElHub("base-fk-orden", async (hub) => {
			const st = hub.state.storage as DurableObjectStorage;
			await migrarBaseLocal(st);
			const res = loteEnBruto(st, [{ sql: DEFER }, LINEA("d1", "c1"), COMANDA("c1")]);
			expect(res).toHaveLength(3);
			expect(res[1].rowsAffected).toBe(1);
			expect(st.sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").one().n).toBe(1);
		});
	});

	it("una FK rota se rechaza con el error de siempre y el DO sigue vivo", async () => {
		const nombre = "base-fk-rota";
		await enElHub(nombre, async (hub) => {
			const st = hub.state.storage as DurableObjectStorage;
			await migrarBaseLocal(st);
			hub.__marca = "viva";
			expect(() => loteEnBruto(st, [{ sql: DEFER }, COMANDA("c1"), LINEA("d1", "no-existe")])).toThrow(
				/FOREIGN KEY constraint failed/,
			);
			expect(st.sql.exec("SELECT COUNT(*) AS n FROM Comandas;").one().n).toBe(0);
			// El aplazamiento no se queda encendido: lo siguiente se comprueba al momento.
			expect(st.sql.exec("PRAGMA defer_foreign_keys;").one().defer_foreign_keys).toBe(0);
		});
		const despues = await enElHub(nombre, (hub) => hub.__marca ?? null);
		expect(despues).toBe("viva");
	});

	it("el PRAGMA suelto fuera de un lote no se aplica", async () => {
		await enElHub("base-fk-suelta", async (hub) => {
			const st = hub.state.storage as DurableObjectStorage;
			await migrarBaseLocal(st);
			ejecutarEnBruto(st.sql, DEFER);
			expect(st.sql.exec("PRAGMA defer_foreign_keys;").one().defer_foreign_keys).toBe(0);
		});
	});
});

describe("una lectura de la web va entera, en un viaje, al TenantHub", () => {
	it("sin aprovisionar contesta tenant_db_not_provisioned; aprovisionado, lee", async () => {
		const tenantId = "t-base-rpc";
		await expect(leerParaLaWeb(env as any, tenantId, { que: "negocioDelCorreo" })).rejects.toMatchObject({
			code: "tenant_db_not_provisioned",
			status: 404,
		});

		const primera = await provisionTenantDatabase(null as any, env as any, tenantId);
		expect(primera.reused).toBe(false);
		const segunda = await provisionTenantDatabase(null as any, env as any, tenantId);
		expect(segunda.reused).toBe(true);

		expect(await leerParaLaWeb(env as any, tenantId, { que: "negocioDelCorreo" })).toMatchObject({ nombre: expect.any(String) });
	});

	it("lo que devuelve cruza el RPC con sus `Set` y sus `Map`", async () => {
		const tenantId = "t-base-rpc-colecciones";
		await provisionTenantDatabase(null as any, env as any, tenantId);
		await enElHub(tenantId, (hub: any) => {
			const sql = hub.state.storage.sql;
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
			sql.exec(
				`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
				 VALUES ('m1', 'z1', 'Mesa 1', 4, 0, 0, 'rect', 80, 80);`,
			);
			sql.exec("INSERT INTO Reserva_Web_Mesas (ID_Mesa, Activa) VALUES ('m1', 1);");
			sql.exec("INSERT INTO Reserva_Web_Cierres (ID_Cierre, Dia_YMD) VALUES ('c1', '2026-12-24');");
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES ('r1', 'm1', '2026-12-24', '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
			);
		});

		const alta = await leerParaLaWeb(env as any, tenantId, {
			que: "alta",
			dia: "2026-12-24",
			email: "nadie@correo.es",
			idMesa: "auto",
			automatica: true,
		});
		expect(alta.dia.cierres).toBeInstanceOf(Set);
		expect([...alta.dia.cierres]).toEqual(["2026-12-24"]);
		expect(alta.dia.idsEnLaBase).toBeInstanceOf(Set);
		expect([...alta.dia.idsEnLaBase]).toEqual(["r1"]);
		expect(alta.delCorreo).toBeInstanceOf(Set);
		expect(alta.nombres).toBeInstanceOf(Map);
		expect([...alta.nombres]).toEqual([["m1", "Mesa 1"]]);
	});

	it("un error de SQL llega con su mensaje", async () => {
		const tenantId = "t-base-rpc-error";
		await provisionTenantDatabase(null as any, env as any, tenantId);
		await enElHub(tenantId, (hub: any) => hub.state.storage.sql.exec("DROP TABLE Reserva_Web_Cierres;"));
		await expect(leerParaLaWeb(env as any, tenantId, { que: "dia", dia: "2026-12-24" })).rejects.toThrow(/no such table/);
	});
});
