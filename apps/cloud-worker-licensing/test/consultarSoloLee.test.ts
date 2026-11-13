// test/consultarSoloLee.test.ts
//
// `consultar` es la puerta por la que el Worker lee la base de un negocio (`tenantQuery` fuera del
// DO, la agenda de reservas web, las rutas públicas). Ejecutaba lo que le llegara, también una
// escritura, que entraba sin pasar por el motor: sin `Applied_Operations`, sin `Sync_Changes` y sin
// difundirse, así que la Main no la habría visto nunca. Aquí se comprueba, por el RPC de verdad:
//
// - que `consultar` sólo lee: lo que no es una lectura se rechaza, y lo que parece una lectura y
//   escribe (`WITH … DELETE`, dos sentencias en un texto) se deshace entero;
// - que lo único que se escribe fuera del motor es el estado propio de la nube (el freno del PIN y
//   el checkpoint de la purga), por su propia puerta (`anotarEstado`), tabla por tabla;
// - que el alta del negocio siembra su administrador dentro del DO (`aprovisionar`), sin SQL que
//   viaje, y dice si la base ya estaba;
// - que `/v1/sync/initialize-empty`, que corre dentro del DO, no se llama a sí mismo por RPC.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";
import { HANDY, MAIN, conNegocioFirmado, peticionFirmada, viajes } from "./helpers/negocioFirmado";

let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");
const { clienteDelHub } = await import("../src/lib/tenantClient");
const { hashPin, verifyPin } = await import("../src/domains/login/login.crypto");
const { reservarIntento, throttleReset } = await import("../src/domains/login/login.queries");

const env = entorno as any;
const deps = {
	ponerCentral: (db: unknown) => void (dbCentral = db),
	firmarSesion,
	olvidarLicenciasCacheadas,
};

const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

/** Un negocio aprovisionado con una zona, para tener algo que leer y que no se debe poder tocar. */
async function conBase(tenantId: string): Promise<void> {
	await stub(tenantId).aprovisionar(tenantId);
	await enElHub(tenantId, (hub: any) => {
		hub.state.storage.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
	});
}

const enLaBase = <T>(tenantId: string, fn: (sql: any) => T): Promise<T> =>
	enElHub(tenantId, (hub: any) => fn(hub.state.storage.sql));

const zonas = (sql: any): string[] =>
	sql.exec("SELECT Nombre_Zona AS n FROM Zonas ORDER BY ID_Zona;").toArray().map((f: any) => String(f.n));

const NO_ES_LECTURA = { ok: false, code: "consulta_no_es_lectura", status: 500 };

/** El administrador con el que nace la base (`tenantHub.alta.ts`): el freno del PIN es de un usuario que existe. */
const ADMIN = "00000000-0000-7000-8000-000000000501";

describe("consultar sólo lee", () => {
	it("una lectura suelta y un lote de lecturas salen como siempre", async () => {
		const t = "consultar-lee";
		await conBase(t);

		const una = await stub(t).consultar(t, [{ sql: "SELECT Nombre_Zona AS n FROM Zonas WHERE ID_Zona = ?1;", args: ["z1"] }], false);
		expect(una).toMatchObject({ ok: true, resultados: [{ columns: ["n"], rows: [["Sala"]] }] });

		const lote = await stub(t).consultar(
			t,
			[
				"SELECT COUNT(*) AS n FROM Zonas;",
				"WITH z AS (SELECT ID_Zona FROM Zonas) SELECT COUNT(*) AS n FROM z;",
				"  -- con su comentario delante\n  /* y otro */ SELECT 1 AS uno;",
			],
			true,
		);
		expect(lote).toMatchObject({ ok: true });
		expect((lote as any).resultados.map((r: any) => r.rows[0][0])).toEqual([1, 1, 1]);
	});

	it("lo que no empieza como una lectura se rechaza sin ejecutarse", async () => {
		const t = "consultar-no-escribe";
		await conBase(t);

		for (const texto of [
			"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z2', 'Terraza');",
			"UPDATE Zonas SET Nombre_Zona = 'Otra';",
			"DELETE FROM Zonas;",
			"REPLACE INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Otra');",
			"INSERT OR REPLACE INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Otra');",
			"CREATE TABLE Colada (x TEXT);",
			"DROP TABLE Zonas;",
			"ALTER TABLE Zonas ADD COLUMN Colada TEXT;",
			"PRAGMA foreign_keys = OFF;",
			"PRAGMA defer_foreign_keys = ON;",
			// Un `DELETE` que no borra nada tampoco: no es una lectura.
			"DELETE FROM Zonas WHERE 1 = 0;",
		]) {
			expect(await stub(t).consultar(t, [texto], false), texto).toEqual(NO_ES_LECTURA);
		}

		await enLaBase(t, (sql) => {
			expect(zonas(sql)).toEqual(["Sala"]);
			expect(sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'Colada';").toArray()).toEqual([]);
			expect(Number(sql.exec("PRAGMA foreign_keys;").toArray()[0].foreign_keys)).toBe(1);
		});
	});

	it("lo que empieza como una lectura y escribe se deshace entero", async () => {
		const t = "consultar-deshace";
		await conBase(t);

		for (const texto of [
			"WITH victimas AS (SELECT ID_Zona FROM Zonas) DELETE FROM Zonas WHERE ID_Zona IN (SELECT ID_Zona FROM victimas);",
			"WITH nueva(id, nombre) AS (VALUES ('z2', 'Terraza')) INSERT INTO Zonas (ID_Zona, Nombre_Zona) SELECT id, nombre FROM nueva;",
			// Dos sentencias en un texto: el SQLite del DO las ejecuta las dos.
			"SELECT 1; DELETE FROM Zonas;",
			"SELECT 1; UPDATE Zonas SET Nombre_Zona = 'Otra';",
		]) {
			expect(await stub(t).consultar(t, [texto], false), texto).toEqual(NO_ES_LECTURA);
			expect(await enLaBase(t, zonas), texto).toEqual(["Sala"]);
		}
	});

	it("un lote con una escritura dentro no deja nada a medias", async () => {
		const t = "consultar-lote";
		await conBase(t);

		const r = await stub(t).consultar(
			t,
			[
				"SELECT COUNT(*) AS n FROM Zonas;",
				"WITH x AS (SELECT 1) UPDATE Zonas SET Nombre_Zona = 'Otra';",
				"SELECT COUNT(*) AS n FROM Zonas;",
			],
			true,
		);
		expect(r).toEqual(NO_ES_LECTURA);
		expect(await enLaBase(t, zonas)).toEqual(["Sala"]);
	});

	it("no deja rastro en el log: nada que la Main fuera a recibir", async () => {
		const t = "consultar-sin-rastro";
		await conBase(t);
		await stub(t).consultar(t, ["WITH x AS (SELECT 1) DELETE FROM Zonas;"], false);
		await enLaBase(t, (sql) => {
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes;").one().n)).toBe(0);
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Applied_Operations;").one().n)).toBe(0);
		});
	});

	it("el cliente del Worker ve el rechazo como un error con su código", async () => {
		const t = "consultar-cliente";
		await conBase(t);
		const db = clienteDelHub(env, t);

		await expect(db.execute("DELETE FROM Zonas;")).rejects.toMatchObject({ code: "consulta_no_es_lectura", status: 500 });
		await expect(
			db.batch(["SELECT 1;", { sql: "UPDATE Zonas SET Nombre_Zona = ?1;", args: ["Otra"] }], "write"),
		).rejects.toMatchObject({ code: "consulta_no_es_lectura" });
		expect((await db.execute("SELECT Nombre_Zona AS n FROM Zonas;")).rows.map((f: any) => f.n)).toEqual(["Sala"]);
	});
});

describe("el estado propio de la nube tiene su puerta, y sólo ése", () => {
	const ESTADO_NO_ADMITIDO = { ok: false, code: "estado_local_no_admitido", status: 500 };

	it("el freno del PIN y el checkpoint de la purga se escriben; lo demás no", async () => {
		const t = "estado-local";
		await conBase(t);

		const intento = await stub(t).anotarEstado(t, {
			sql: "INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms, Ultimo_Intento_Ms) VALUES (?1, 1, 0, ?2) RETURNING Intentos_Fallidos AS n;",
			args: [ADMIN, 1000],
		});
		expect(intento).toMatchObject({ ok: true, resultados: [{ rows: [[1]], rowsAffected: 1 }] });
		const checkpoint = await stub(t).anotarEstado(t, {
			sql: "INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES (?1, ?2, ?3);",
			args: ["main", 7, 1000],
		});
		expect(checkpoint).toMatchObject({ ok: true });

		for (const texto of [
			// Tablas del negocio: eso va por el motor.
			"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z2', 'Terraza');",
			"UPDATE Zonas SET Nombre_Zona = 'Otra';",
			"DELETE FROM Zonas;",
			// Una tabla admitida delante y otra cosa detrás.
			"DELETE FROM Intentos_Login WHERE ID_Usuario = 'nadie'; DELETE FROM Zonas;",
			// Ni lecturas, ni lo que no dice a las claras en qué tabla escribe.
			"SELECT 1;",
			"WITH x AS (SELECT 1) DELETE FROM Intentos_Login;",
			"INSERT OR REPLACE INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms, Ultimo_Intento_Ms) VALUES ('nadie', 0, 0, 0);",
			"DROP TABLE Intentos_Login;",
		]) {
			expect(await stub(t).anotarEstado(t, texto), texto).toEqual(ESTADO_NO_ADMITIDO);
		}

		await enLaBase(t, (sql) => {
			expect(zonas(sql)).toEqual(["Sala"]);
			expect(Number(sql.exec("SELECT Intentos_Fallidos AS n FROM Intentos_Login WHERE ID_Usuario = ?1;", ADMIN).one().n)).toBe(1);
			expect(Number(sql.exec("SELECT Last_Seq AS n FROM Sync_Main_Checkpoints WHERE Device_Id = 'main';").one().n)).toBe(7);
		});
	});

	it("sin base contesta lo mismo que una lectura", async () => {
		expect(await stub("estado-local-sin-base").anotarEstado("estado-local-sin-base", "DELETE FROM Intentos_Login;")).toEqual({
			ok: false,
			code: "tenant_db_not_provisioned",
			status: 404,
		});
	});

	it("el freno del PIN funciona igual con el cliente del Worker", async () => {
		// Lo que hace una ruta que corre en el Worker (`EJECUTAR_EN_EL_HUB` apagado): sus sentencias
		// salen por el cliente del hub, que manda cada una por su puerta.
		const t = "estado-local-freno";
		await conBase(t);
		const db = clienteDelHub(env, t);

		expect(await reservarIntento(db, ADMIN, 1_000)).toEqual({ concedido: true, intento: 1, bloqueadoHastaMs: 0 });
		expect(await reservarIntento(db, ADMIN, 2_000)).toEqual({ concedido: true, intento: 2, bloqueadoHastaMs: 0 });
		expect(await enLaBase(t, (sql) => sql.exec("SELECT Intentos_Fallidos AS n FROM Intentos_Login;").one().n)).toBe(2);
		await throttleReset(db, ADMIN, 0, 3_000);
		expect(await enLaBase(t, (sql) => sql.exec("SELECT COUNT(*) AS n FROM Intentos_Login;").one().n)).toBe(0);
	});

	it("con las rutas en el Worker, el catch-up sigue apuntando el checkpoint de la Main", async () => {
		await conNegocioFirmado(deps, "estado-local-checkpoint", async (n) => {
			const res = await app.request(
				await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/changes", { cuerpo: { since: 3 } }),
				undefined,
				{ ...env, EJECUTAR_EN_EL_HUB: "0" },
			);
			expect(res.status).toBe(200);
			expect(viajes(res, "hub-ruta")).toBe(0);
			expect(
				await enLaBase(n.tenantId, (sql) =>
					sql.exec("SELECT Device_Id AS d, Last_Seq AS s FROM Sync_Main_Checkpoints;").toArray(),
				),
			).toEqual([{ d: MAIN, s: 3 }]);
		});
	});
});

describe("el alta siembra el administrador dentro del DO", () => {

	it("crea el esquema y el administrador de una vez, y dice si la base ya estaba", async () => {
		const t = "alta-con-admin";
		expect(await stub(t).aprovisionar(t)).toEqual({ reused: false });

		const usuarios = await enLaBase(t, (sql) =>
			sql
				.exec(
					`SELECT U.ID_Usuario AS id, U.Email AS email, U.Estado AS estado, U.Requiere_Setup AS setup,
					        U.Password_Hash AS hash, R.Nombre_Rol AS rol
					   FROM Usuarios U JOIN Roles R ON R.ID_Rol = U.ID_Rol;`,
				)
				.toArray(),
		);
		expect(usuarios).toHaveLength(1);
		expect(usuarios[0]).toMatchObject({ id: ADMIN, email: "admin@local", estado: "Activo", setup: 1, rol: "Administrador" });
		// El PIN de la siembra, con el mismo formato que verifica el login.
		await expect(verifyPin("1234", String(usuarios[0].hash))).resolves.toBeUndefined();

		// La Main siembra el mismo administrador con el mismo id: no es un cambio que replicar.
		await enLaBase(t, (sql) => {
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes;").one().n)).toBe(0);
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Applied_Operations;").one().n)).toBe(0);
		});
	});

	it("repetirlo no toca nada: ni otro administrador ni el PIN que ya se haya cambiado", async () => {
		const t = "alta-repetida";
		await stub(t).aprovisionar(t);
		const elegido = await hashPin("9876");
		await enLaBase(t, (sql) => {
			sql.exec("UPDATE Usuarios SET Password_Hash = ?1, Requiere_Setup = 0 WHERE ID_Usuario = ?2;", elegido, ADMIN);
		});

		expect(await stub(t).aprovisionar(t)).toEqual({ reused: true });

		const fila = await enLaBase(t, (sql) =>
			sql.exec("SELECT COUNT(*) AS n, MAX(Password_Hash) AS hash, MAX(Requiere_Setup) AS setup FROM Usuarios;").toArray()[0],
		);
		expect(fila).toEqual({ n: 1, hash: elegido, setup: 0 });
	});

	it("un negocio que ya tiene usuarios y ningún administrador sembrado no recibe uno", async () => {
		// Lo que deja una Main que ha subido los suyos: la siembra es sólo para la base vacía.
		const t = "alta-con-usuarios";
		await stub(t).aprovisionar(t);
		await enLaBase(t, (sql) => {
			sql.exec("UPDATE Usuarios SET ID_Usuario = 'otro-admin', Email = 'jefa@bar.test' WHERE ID_Usuario = ?1;", ADMIN);
		});

		expect(await stub(t).aprovisionar(t)).toEqual({ reused: true });
		expect(
			await enLaBase(t, (sql) => sql.exec("SELECT ID_Usuario AS id FROM Usuarios;").toArray().map((f: any) => f.id)),
		).toEqual(["otro-admin"]);
	});
});

describe("POST /v1/sync/initialize-empty corre dentro del DO sin llamarse a sí mismo", () => {
	/** Dentro del DO, pedirle un objeto a `env.TenantHub` sería llamarse a sí mismo por RPC. */
	async function sinLlamarseASiMismo(tenantId: string): Promise<void> {
		await enElHub(tenantId, (hub: any) => {
			const prohibido = () => {
				throw new Error("el TenantHub se ha pedido a sí mismo por RPC");
			};
			hub.env = { ...hub.env, TenantHub: { idFromName: prohibido, get: prohibido, jurisdiction: prohibido } };
		});
	}

	it("crea la base y el administrador de un negocio que no la tenía, en un viaje", async () => {
		await conNegocioFirmado(
			deps,
			"inicializar-vacia",
			async (n) => {
				await sinLlamarseASiMismo(n.tenantId);

				const res = await app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/initialize-empty"), undefined, env);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true });
				expect(viajes(res, "hub-ruta")).toBe(1);
				expect(
					await enLaBase(n.tenantId, (sql) => sql.exec("SELECT Email AS e FROM Usuarios;").toArray().map((f: any) => f.e)),
				).toEqual(["admin@local"]);

				// Con la base ya creada no hace nada: no es una salida de emergencia para lo demás.
				const otra = await app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/initialize-empty"), undefined, env);
				expect(otra.status).toBe(409);
				expect(await otra.json()).toMatchObject({ ok: false, error: "tenant_db_already_provisioned" });
			},
			{ sinBase: true },
		);
	});

	it("una Handy no puede", async () => {
		await conNegocioFirmado(
			deps,
			"inicializar-handy",
			async (n) => {
				const res = await app.request(await peticionFirmada(deps, n, HANDY, "POST", "/v1/sync/initialize-empty"), undefined, env);
				expect(res.status).toBe(403);
				expect(await enElHub(n.tenantId, (hub: any) => hub.estaAprovisionado())).toBe(false);
			},
			{ sinBase: true },
		);
	});
});
