// test/huecoDelLog.test.ts
//
// AUD-19 · El DO purga de `Sync_Changes` lo antiguo. Una Main cuyo cursor quedó por debajo (una
// copia restaurada) recibiría lo conservado como si fuera seguido y perdería en silencio el tramo
// purgado. La purga anota en la misma transacción el mayor `Seq` que borra, y `/v1/sync/changes` lo
// devuelve (`purgadoHasta`): si pasa del `since` de la Main, a ésta le falta algo que la nube ya no
// tiene. El principio del log no sirve para saberlo: la purga mira también la antigüedad, que se
// fija antes de que el turno numere, y puede llevarse el 12 y dejar el 11.
//
// Se ejecutan la purga real del motor (`maybePurgeSyncLog`) sobre el esquema de verdad y la ruta
// real; sólo se sustituyen la autenticación y la base del tenant (el SQLite del propio DO).

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

/** Cliente SQL del test en curso; lo lee el `tenantQuery` sustituido. */
let clienteActual: any = null;

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: async (_c: any, fn: any) => fn(clienteActual),
}));

// El router monta `tenantAuth` él mismo; aquí se sustituye por lo mínimo que necesita el handler.
vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-hueco");
		c.set("deviceId", "main-1");
		await next();
	},
	soloLaMain: () => async (_c: any, next: any) => {
		await next();
	},
}));

const { syncRoutes } = await import("../src/domains/sync/sync.routes");

const DIA = 24 * 60 * 60 * 1000;

async function pedirCambios(since: number, limit = 1000): Promise<any> {
	const app = new Hono();
	app.route("/", syncRoutes);
	const res = await app.request(
		"/changes",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ since, limit }) },
		{} as any,
	);
	expect(res.status).toBe(200);
	return res.json();
}

function anotar(sql: any, seq: number, creadoMs: number) {
	sql.exec(
		"INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?1, ?2, 'venta', '[]', 'main-1', ?3);",
		seq,
		`op-${seq}`,
		creadoMs,
	);
}

function checkpointDeLaMain(sql: any, seq: number) {
	sql.exec(
		"INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('main-1', ?1, ?2) ON CONFLICT(Device_Id) DO UPDATE SET Last_Seq = ?1, Updated_At_Ms = ?2;",
		seq,
		Date.now(),
	);
}

/** Prepara la purga real sobre el SQLite del DO y la deja lista para correr. */
function conLaBaseDelDo(hub: any) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	const db = clienteSobre(sql, hub.state.storage);
	hub.getTenantDb = async () => db;
	hub.resolveTenantDbClient = async () => db;
	clienteActual = db;
	const purgar = async () => {
		hub.lastPurgeAtMs = 0;
		await hub.maybePurgeSyncLog("t-hueco");
	};
	const minimo = () => sql.exec("SELECT MIN(Seq) AS m FROM Sync_Changes;").toArray()[0].m;
	return { sql, purgar, minimo };
}

describe("AUD-19 · /v1/sync/changes dice hasta dónde ha purgado el log", () => {
	it("tras la purga real, una copia con el cursor debajo recibe purgadoHasta por encima de su since", async () => {
		await enElHub("aud19-hueco-del-log", async (hub: any) => {
			const { sql, purgar, minimo } = conLaBaseDelDo(hub);
			const ahora = Date.now();
			// 1700 operaciones: hasta la 1200 son de hace 9 días; el resto, de hoy.
			for (let seq = 1; seq <= 1700; seq++) anotar(sql, seq, seq <= 1200 ? ahora - 9 * DIA : ahora - 60_000);
			// La Main estaba al día: su checkpoint es el suelo de la purga.
			checkpointDeLaMain(sql, 1700);

			await purgar();
			// La purga de verdad: Seq <= 1700 - 1000 y de más de 7 días.
			expect(minimo()).toBe(701);

			// La copia restaurada pide desde su cursor: le falta 11..700.
			const copia = await pedirCambios(10);
			expect(copia.items[0].seq).toBe(701);
			expect(copia).toMatchObject({ nextSince: 1700, highWater: 1700, purgadoHasta: 700 });

			// Una Main al día no echa nada en falta, pida desde donde pida dentro de lo conservado.
			for (const since of [700, 1000, 1700]) {
				expect((await pedirCambios(since)).purgadoHasta).toBe(700);
			}
		});
	});

	it("con la antigüedad desordenada respecto al Seq, se lleva el 12 y deja el 11: el principio del log no lo ve", async () => {
		await enElHub("aud19-desordenado", async (hub: any) => {
			const { sql, purgar, minimo } = conLaBaseDelDo(hub);
			const ahora = Date.now();
			// El 11 se numeró después de que el 12 fijara su hora (esperaba el turno del log), y es
			// lo bastante más joven como para quedar del lado bueno del corte de 7 días.
			for (let seq = 1; seq <= 1012; seq++) anotar(sql, seq, seq === 11 ? ahora - 60_000 : ahora - 9 * DIA);
			checkpointDeLaMain(sql, 1012);

			await purgar();
			expect(sql.exec("SELECT Seq FROM Sync_Changes WHERE Seq <= 13 ORDER BY Seq;").toArray().map((f: any) => f.Seq)).toEqual([11, 13]);
			// Con el principio del log, a una copia en el 10 no le faltaría nada (11 = 10 + 1)...
			expect(minimo()).toBe(11);
			// ...pero le falta el 12, y la marca lo dice.
			const copia = await pedirCambios(10);
			expect(copia.items.map((i: any) => i.seq).slice(0, 2)).toEqual([11, 13]);
			expect(copia.purgadoHasta).toBe(12);
		});
	});

	it("la marca no cuenta como una Main: la purga siguiente sigue avanzando", async () => {
		await enElHub("aud19-marca-no-es-main", async (hub: any) => {
			const { sql, purgar, minimo } = conLaBaseDelDo(hub);
			const ahora = Date.now();
			for (let seq = 1; seq <= 1700; seq++) anotar(sql, seq, seq <= 1200 ? ahora - 9 * DIA : ahora - 60_000);
			checkpointDeLaMain(sql, 1700);
			await purgar();
			expect((await pedirCambios(1700)).purgadoHasta).toBe(700);

			// La Main sigue y su checkpoint sube. Si la marca (700) entrara en el suelo, no se
			// purgaría nada más.
			checkpointDeLaMain(sql, 2200);
			await purgar();
			expect(minimo()).toBe(1201);
			expect((await pedirCambios(2200)).purgadoHasta).toBe(1200);
		});
	});

	it("un log que purgó el código anterior, sin marca, dice lo que falta por debajo de su primer Seq", async () => {
		await enElHub("aud19-purga-antigua", async (hub: any) => {
			const { sql, purgar } = conLaBaseDelDo(hub);
			const ahora = Date.now();
			for (let seq = 1; seq <= 1700; seq++) anotar(sql, seq, seq <= 1200 ? ahora - 9 * DIA : ahora - 60_000);
			checkpointDeLaMain(sql, 1700);
			// La purga de antes de AUD-19: la misma condición, sin anotar nada.
			sql.exec("DELETE FROM Sync_Changes WHERE Seq <= 700 AND Created_At_Ms < ?1;", ahora - 7 * DIA);
			const marca = () => sql.exec("SELECT Last_Seq AS m FROM Sync_Main_Checkpoints WHERE Device_Id = '_purgado_hasta';").toArray();
			expect(marca()).toEqual([]);

			// Sin marca, lo que hay por debajo del primero conservado (701) ya no está.
			expect((await pedirCambios(10)).purgadoHasta).toBe(700);

			// Una purga de este código que no borra nada (ya lo borró la anterior) no anota una
			// marca a cero ni deja de decir lo que falta.
			await purgar();
			expect(marca()).toEqual([]);
			expect((await pedirCambios(10)).purgadoHasta).toBe(700);
		});
	});

	it("una purga que no borra nada no estropea la marca que ya hay", async () => {
		await enElHub("aud19-marca-intacta", async (hub: any) => {
			const { sql, purgar } = conLaBaseDelDo(hub);
			const ahora = Date.now();
			for (let seq = 1; seq <= 1700; seq++) anotar(sql, seq, seq <= 1200 ? ahora - 9 * DIA : ahora - 60_000);
			checkpointDeLaMain(sql, 1700);
			await purgar();
			const marca = () => sql.exec("SELECT Last_Seq AS m FROM Sync_Main_Checkpoints WHERE Device_Id = '_purgado_hasta';").toArray()[0].m;
			expect(marca()).toBe(700);

			// Otra vuelta sin nada que borrar: la marca sigue donde estaba.
			await purgar();
			expect(marca()).toBe(700);
			expect((await pedirCambios(1700)).purgadoHasta).toBe(700);
		});
	});

	it("si nunca se ha purgado nada, purgadoHasta es 0", async () => {
		await enElHub("aud19-sin-purga", async (hub: any) => {
			const { sql } = conLaBaseDelDo(hub);
			expect(await pedirCambios(0)).toEqual({ ok: true, items: [], nextSince: 0, highWater: 0, purgadoHasta: 0 });
			anotar(sql, 1, Date.now());
			expect(await pedirCambios(0)).toMatchObject({ highWater: 1, purgadoHasta: 0 });
		});
	});
});
