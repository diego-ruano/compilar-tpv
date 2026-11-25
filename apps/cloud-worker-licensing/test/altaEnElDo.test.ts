// test/altaEnElDo.test.ts
//
// La base del negocio nace y se rellena dentro de su TenantHub, sin SQL que viaje. Se comprueba, por el
// RPC de verdad:
//
// - que el alta del negocio siembra su administrador dentro del DO (`aprovisionar`), sin SQL que
//   viaje, y dice si la base ya estaba;
// - que `/v1/sync/initialize-empty`, que corre dentro del DO, no se llama a sí mismo por RPC.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { enElHub } from "./helpers/hub";
import { HANDY, MAIN, conNegocioFirmado, peticionFirmada, viajes } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";
import { hashPin, verifyPin } from "../src/domains/login/login.crypto";

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

const enLaBase = <T>(tenantId: string, fn: (sql: any) => T): Promise<T> =>
	enElHub(tenantId, (hub: any) => fn(hub.state.storage.sql));

/** El administrador con el que nace la base (`tenantHub.alta.ts`). */
const ADMIN = "00000000-0000-7000-8000-000000000501";

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
				// Sólo nace vacía la base de un negocio que no ha nacido (`test/basePerdida.test.ts`).
				await n.enCentral(`UPDATE licenses SET activated_at_ms = NULL WHERE tenant_id = ?;`, n.tenantId);
				await sinLlamarseASiMismo(n.tenantId);

				const res = await app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/initialize-empty"), undefined, {
					...env,
					...n.entorno,
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true });
				expect(viajes(res, "hub-ruta")).toBe(1);
				expect(
					await enLaBase(n.tenantId, (sql) => sql.exec("SELECT Email AS e FROM Usuarios;").toArray().map((f: any) => f.e)),
				).toEqual(["admin@local"]);

				// Con la base ya creada no hace nada: no es una salida de emergencia para lo demás.
				const otra = await app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/initialize-empty"), undefined, {
					...env,
					...n.entorno,
				});
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
				const res = await app.request(await peticionFirmada(deps, n, HANDY, "POST", "/v1/sync/initialize-empty"), undefined, {
					...env,
					...n.entorno,
				});
				expect(res.status).toBe(403);
				expect(await enElHub(n.tenantId, (hub: any) => hub.estaAprovisionado())).toBe(false);
			},
			{ sinBase: true },
		);
	});
});
