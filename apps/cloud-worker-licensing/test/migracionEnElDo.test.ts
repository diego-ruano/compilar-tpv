// test/migracionEnElDo.test.ts
//
// El TenantHub pone al día el esquema de su negocio la primera vez que toca la base tras un
// despliegue (`getTenantDb` → `migrarBaseLocal`). Aquí se le da una migración de más, como la
// traería un despliegue, y se mira:
//
// - que una migración que reconstruye una tabla padre (crear la nueva, copiar, borrar la vieja,
//   renombrar) conserva a sus hijas: con las claves foráneas activas, ese borrado se las lleva en
//   cascada sin decir nada (`test/sondaSqliteDo.test.ts`), así que el runner las apaga alrededor de
//   la tanda, como el de la Main (`migrations.rs::run`), y las vuelve a encender;
// - que una migración que deja huérfanas no se confirma (`foreign_key_check`);
// - que si la migración falla, el negocio contesta 503 `tenant_db_migration_failed` (no un 500 sin
//   nombre), no se aparta ninguna operación de la Main por ello, y se avisa una vez por instancia.

import { env as entorno } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";
import { MAIN, conNegocioFirmado, peticionFirmada, viajes } from "./helpers/negocioFirmado";

const { deMas, capturados } = vi.hoisted(() => ({
	/** Las migraciones que «trae el despliegue», detrás de las de verdad. */
	deMas: [] as { name: string; sql: string }[],
	/** Lo que se ha mandado a Sentry (`capturarError`), con su operación. */
	capturados: [] as { operacion: string; mensaje: string }[],
}));
let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

vi.mock("../src/server/tenantMigrations", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/tenantMigrations")>();
	return {
		...original,
		get MIGRATIONS() {
			return [...original.MIGRATIONS, ...deMas];
		},
	};
});

vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			// Lo mismo que hace la de verdad: lo que es un rechazo esperado no se manda.
			if (!original.esRechazoEsperado(error)) {
				capturados.push({ operacion, mensaje: String((error as any)?.message ?? error) });
			}
			original.capturarError(error, operacion);
		},
	};
});

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");
const { migrarBaseLocal } = await import("../src/durableObjects/tenantHub.sqlite");
const { esFalloPasajero, esRechazoPermanente } = await import("../src/durableObjects/tenantHub.errores");
const { HubError } = await import("../src/lib/errorHttp");

const env = entorno as any;
const deps = {
	ponerCentral: (db: unknown) => void (dbCentral = db),
	firmarSesion,
	olvidarLicenciasCacheadas,
};

/** Reconstruye `Zonas` como lo haría una migración que le quita una restricción. */
const RECONSTRUIR_ZONAS = {
	name: "9001_reconstruir_zonas.sql",
	sql: `
		CREATE TABLE Zonas_nueva (
			ID_Zona TEXT NOT NULL PRIMARY KEY,
			Nombre_Zona TEXT NOT NULL,
			Room_Points TEXT NOT NULL DEFAULT '[]',
			Updated_At DATETIME,
			Archivada_En DATETIME
		);
		INSERT INTO Zonas_nueva SELECT * FROM Zonas;
		DROP TABLE Zonas;
		ALTER TABLE Zonas_nueva RENAME TO Zonas;
		CREATE UNIQUE INDEX idx_zonas_nombre_activa ON Zonas(Nombre_Zona) WHERE Archivada_En IS NULL;
	`,
};

/** Borra las zonas sin tocar sus mesas: con las FK apagadas entra, y deja las mesas huérfanas. */
const DEJAR_HUERFANAS = {
	name: "9002_dejar_huerfanas.sql",
	sql: `DELETE FROM Zonas;`,
};

/** Falla a medias: lo que hizo antes de fallar tiene que deshacerse. */
const ROTA = {
	name: "9003_rota.sql",
	sql: `
		CREATE TABLE Tabla_De_La_Migracion_Rota (x TEXT);
		INSERT INTO Tabla_Que_No_Existe (x) VALUES ('a');
	`,
};

const fk = (sql: any): number => Number(sql.exec("PRAGMA foreign_keys;").toArray()[0]?.foreign_keys);
const contar = (sql: any, tabla: string): number => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).one().n);
const existe = (sql: any, tabla: string): boolean =>
	sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;", tabla).toArray().length > 0;
const aplicadas = (sql: any): string[] =>
	sql.exec("SELECT name FROM _migrations ORDER BY name;").toArray().map((f: any) => String(f.name));

/** Una base al día con una zona y dos mesas (`Mesas.ID_Zona` es `ON DELETE CASCADE`). */
async function baseConMesas(hub: any): Promise<any> {
	const sql = hub.state.storage.sql;
	await migrarBaseLocal(hub.state.storage);
	sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
	for (const id of ["m1", "m2"]) {
		sql.exec(
			"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES (?1, 'z1', ?1, 4, 0, 0, 'rect', 10, 10);",
			id,
		);
	}
	return sql;
}

afterEach(() => {
	deMas.length = 0;
	capturados.length = 0;
});

describe("una migración con las claves foráneas apagadas alrededor, como en la Main", () => {
	it("reconstruir una tabla padre conserva a sus hijas, y las FK quedan encendidas", async () => {
		await enElHub("migracion-reconstruir", async (hub: any) => {
			const sql = await baseConMesas(hub);
			deMas.push(RECONSTRUIR_ZONAS);

			await migrarBaseLocal(hub.state.storage);

			expect(aplicadas(sql)).toContain(RECONSTRUIR_ZONAS.name);
			expect(contar(sql, "Zonas")).toBe(1);
			expect(contar(sql, "Mesas")).toBe(2);
			expect(fk(sql)).toBe(1);
			// Y siguen valiendo contra la tabla reconstruida: una huérfana no entra y la cascada funciona.
			expect(() =>
				sql.exec(
					"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m3', 'NO-EXISTE', '3', 4, 0, 0, 'rect', 10, 10);",
				),
			).toThrow(/FOREIGN KEY/i);
			sql.exec("DELETE FROM Zonas WHERE ID_Zona = 'z1';");
			expect(contar(sql, "Mesas")).toBe(0);
		});
	});

	it("la segunda vez no hace nada: ni apaga las FK ni repite la migración", async () => {
		await enElHub("migracion-repetida", async (hub: any) => {
			const sql = await baseConMesas(hub);
			deMas.push(RECONSTRUIR_ZONAS);
			await migrarBaseLocal(hub.state.storage);
			const antes = aplicadas(sql);

			await migrarBaseLocal(hub.state.storage);

			expect(aplicadas(sql)).toEqual(antes);
			expect(contar(sql, "Mesas")).toBe(2);
			expect(fk(sql)).toBe(1);
		});
	});

	it("una migración que deja huérfanas no se confirma", async () => {
		await enElHub("migracion-huerfanas", async (hub: any) => {
			const sql = await baseConMesas(hub);
			deMas.push(DEJAR_HUERFANAS);

			await expect(migrarBaseLocal(hub.state.storage)).rejects.toThrow(/integridad referencial.*Mesas/);

			expect(aplicadas(sql)).not.toContain(DEJAR_HUERFANAS.name);
			expect(contar(sql, "Zonas")).toBe(1);
			expect(contar(sql, "Mesas")).toBe(2);
			expect(fk(sql)).toBe(1);
		});
	});

	it("una migración que falla a medias se deshace entera, y las FK quedan encendidas", async () => {
		await enElHub("migracion-a-medias", async (hub: any) => {
			const sql = await baseConMesas(hub);
			deMas.push(RECONSTRUIR_ZONAS, ROTA);

			await expect(migrarBaseLocal(hub.state.storage)).rejects.toThrow(/no such table: Tabla_Que_No_Existe/);

			// La anterior a la rota sí queda: cada migración va en su transacción.
			expect(aplicadas(sql)).toContain(RECONSTRUIR_ZONAS.name);
			expect(aplicadas(sql)).not.toContain(ROTA.name);
			expect(existe(sql, "Tabla_De_La_Migracion_Rota")).toBe(false);
			expect(contar(sql, "Mesas")).toBe(2);
			expect(fk(sql)).toBe(1);
		});
	});

	it("si se quedaron apagadas, la siguiente pasada las enciende aunque no haya nada que migrar", async () => {
		await enElHub("migracion-fk-apagadas", async (hub: any) => {
			const sql = await baseConMesas(hub);
			await hub.state.storage.sync();
			sql.exec("PRAGMA foreign_keys = OFF;");
			expect(fk(sql)).toBe(0);

			await migrarBaseLocal(hub.state.storage);

			expect(fk(sql)).toBe(1);
		});
	});
});

describe("si la migración falla, el negocio lo dice y nadie pierde nada", () => {
	/** El despliegue trae una migración rota y el DO «despierta»: su siguiente acceso migra. */
	async function despliegueRoto(tenantId: string): Promise<{ eventos: { name: string; [campo: string]: unknown }[] }> {
		deMas.push(ROTA);
		const eventos: { name: string; [campo: string]: unknown }[] = [];
		await enElHub(tenantId, (hub: any) => {
			hub.baseLocal = null;
			hub.emitSyncEvent = (name: string, campos: Record<string, unknown>) => void eventos.push({ name, ...campos });
		});
		return { eventos };
	}

	it("contesta 503 con su identificador, avisa una vez y no deja nada a medias", async () => {
		await conNegocioFirmado(deps, "migracion-fallida", async (n) => {
			const antes = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, env);
			expect(antes.status).toBe(200);

			const { eventos } = await despliegueRoto(n.tenantId);

			for (let i = 0; i < 3; i++) {
				const res = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, env);
				expect(res.status).toBe(503);
				expect(viajes(res, "hub-ruta")).toBe(1);
				expect(await res.json()).toEqual({
					ok: false,
					code: "external",
					error: "tenant_db_migration_failed",
					message: "La base de datos de la nube no está disponible ahora mismo. Vuelve a intentarlo en unos minutos.",
				});
			}

			// Una vez por instancia, con el motivo de verdad; las tres peticiones no lo repiten.
			expect(capturados).toEqual([
				{ operacion: "tenant_db.migration", mensaje: expect.stringContaining("no such table: Tabla_Que_No_Existe") },
			]);
			expect(eventos.filter((e) => e.name === "migracion_fallida")).toEqual([
				{ name: "migracion_fallida", error: expect.stringContaining("no such table: Tabla_Que_No_Existe") },
			]);

			await enElHub(n.tenantId, (hub: any) => {
				const sql = hub.state.storage.sql;
				expect(existe(sql, "Tabla_De_La_Migracion_Rota")).toBe(false);
				expect(aplicadas(sql)).not.toContain(ROTA.name);
				expect(fk(sql)).toBe(1);
			});

			// Con el despliegue arreglado, el negocio vuelve sin tocar nada más.
			deMas.length = 0;
			const despues = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, env);
			expect(despues.status).toBe(200);
		});
	});

	it("una migración ya aplicada que ha cambiado sigue saliendo con su código, y también avisa una vez", async () => {
		await conNegocioFirmado(deps, "migracion-alterada-en-el-do", async (n) => {
			const eventos: { name: string }[] = [];
			await enElHub(n.tenantId, (hub: any) => {
				hub.state.storage.sql.exec("UPDATE _migrations SET hash = 'otro' WHERE name = '0002_negocio.sql';");
				hub.baseLocal = null;
				hub.emitSyncEvent = (name: string) => void eventos.push({ name });
			});

			for (let i = 0; i < 2; i++) {
				const res = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, env);
				expect(res.status).toBe(500);
				expect(await res.json()).toMatchObject({ ok: false, code: "tenant_migration_altered", error: "migration_altered" });
			}
			expect(eventos.filter((e) => e.name === "migracion_fallida")).toHaveLength(1);
			expect(capturados.filter((c) => c.operacion === "tenant_db.migration")).toHaveLength(1);
		});
	});

	it("para una operación de la Main es pasajero: no se aparta ni gasta intentos", () => {
		for (const error of [new HubError("tenant_db_migration_failed", 503), new HubError("migration_altered", 500)]) {
			expect(esFalloPasajero(error)).toBe(true);
			expect(esRechazoPermanente(error)).toBe(false);
		}
	});
});
