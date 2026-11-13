// test/horaImposible.test.ts
//
// AUD-21 · Una `X-Client-Now` con la forma buena y un componente imposible (las 24:30, el mes 13,
// el minuto 60) se trata como una que no vale: lo mismo que una con la forma mala o fuera de la
// deriva. Antes daba `NaN` al convertirla, la guardia de la deriva la dejaba pasar y valía como
// «ahora»: quien controlara una Handy emparejada fichaba con la fecha que quisiera.
//
// Dos alturas: el motor del TenantHub (lo que comparten la Handy y la cola) y la ruta del fichaje
// de punta a punta por `src/index.ts`, con la autenticación real de una Handy (token de sesión,
// prueba ed25519, licencia y PIN) y el entorno de la suite: el Worker autentica y le pasa la
// petición al TenantHub del negocio (`lib/enElHub.ts`), que la ejecuta con su base al lado. De la
// ruta sólo se sustituye la base central, que es el SQLite de otro Durable Object, y la presencia de
// la Main en el hub del negocio.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { createExecutionContext, env as entorno, waitOnExecutionContext } from "cloudflare:test";

import { clienteSobre } from "./helpers/clienteSql";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";

const env = entorno as any;

/** La base central de cada caso de la ruta (el SQLite de un DO aparte). */
let central: any = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => central };
});

const { default: worker } = await import("../src/index");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");
const { hashPin } = await import("../src/domains/login/login.crypto");
const { punchEntrada } = await import("../src/domains/login/login.commands");
const { serverNowFixed } = await import("../src/durableObjects/tenantHub.tiempo");

beforeEach(() => {
	olvidarLicenciasCacheadas();
});

/** Forma buena, componente imposible. */
const IMPOSIBLES = ["2020-01-01 24:30:00", "2026-13-45 10:00:00", "2026-08-18 12:60:00", "2099-12-31 24:00:01"];

/** El motor del TenantHub de este DO, con una Main conectada. Devuelve lo que difunda. */
function prepararMotor(hub: any) {
	hub.isMainConnected = () => true;
	hub.isMainReady = () => true;
	const difundidos: any[] = [];
	hub.broadcastChange = (p: any) => difundidos.push(p);
	return difundidos;
}

describe("AUD-21 · el motor no escribe con una hora imposible", () => {
	it("missing_client_now, sin escribir ni difundir nada; la hora real sigue entrando", async () => {
		await enElHub("aud21-motor", async (hub: any) => {
			// La base del negocio, como la crea el alta: el SQLite de este DO.
			await hub.aprovisionar("t-aud21");
			const sql = hub.state.storage.sql;
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT 'u-1', ID_Rol, 'u1@ejemplo.test', 'x', 'Prueba' FROM Roles WHERE Nombre_Rol = 'Camarero';`,
			);
			const difundidos = prepararMotor(hub);

			// Cada operación, con su clave de idempotencia: un UUID, como la de la Handy.
			const aplicar = (clientNow: string, opId = crypto.randomUUID()) => {
				const b = punchEntrada({ id_usuario: "u-1", fecha: clientNow.slice(0, 10), parte: 1 });
				return hub.applyInternalCommandIdempotent({
					tenantId: "t-aud21",
					cmd: b.command,
					opId,
					commandName: b.commandName,
					deviceId: "handy-1",
					requestPayloadJson: JSON.stringify({ opId }),
					clientNow,
				});
			};

			// Lo mismo que con una hora bien escrita fuera de la deriva.
			for (const v of ["2020-01-01 00:30:00", ...IMPOSIBLES]) {
				await expect(aplicar(v), v).rejects.toMatchObject({ code: "missing_client_now", status: 400 });
			}
			expect(sql.exec("SELECT COUNT(*) AS n FROM Fichajes;").one().n).toBe(0);
			expect(difundidos).toEqual([]);

			const ahora = serverNowFixed();
			await aplicar(ahora);
			expect(sql.exec("SELECT Hora_Entrada FROM Fichajes;").toArray()).toEqual([{ Hora_Entrada: ahora }]);
			expect(difundidos).toHaveLength(1);
		});
	});
});

const TENANT = "tenant-aud21";
const HANDY = "handy-aud21";
const LIC_HASH = "hash-licencia-aud21";
const DIA_MS = 24 * 60 * 60 * 1000;
const PIN = "4321";

type Caso = {
	/** Los fichajes de un usuario, leídos de la base del negocio (el SQLite de su TenantHub). */
	filas: (usuario: string) => Promise<any[]>;
	difundidos: any[];
	fichar: (usuario: string, tipo: "entrada" | "salida", clientNow: string) => Promise<Response>;
};

async function escenario<R>(nombre: string, prueba: (c: Caso) => Promise<R>): Promise<R> {
	const tenantId = `${TENANT}-${nombre}`;

	// La base del negocio: el SQLite de su TenantHub, con el esquema que crea el alta. Dentro,
	// camareros con su PIN de verdad, y una Main conectada.
	await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);
	const hash = await hashPin(PIN);
	const difundidos = await enElHub(tenantId, (hub: any) => {
		const sql = hub.state.storage.sql;
		for (const u of ["u-1", "u-2"]) {
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT ?, ID_Rol, ?, ?, 'Prueba' FROM Roles WHERE Nombre_Rol = 'Camarero';`,
				u,
				`${u}@ejemplo.test`,
				hash,
			);
		}
		return prepararMotor(hub);
	});
	const filas = (usuario: string) =>
		enElHub(tenantId, (hub: any) =>
			hub.state.storage.sql
				.exec(`SELECT Fecha, Hora_Entrada, Hora_Salida, Estado FROM Fichajes WHERE ID_Usuario = ? ORDER BY Hora_Entrada;`, usuario)
				.toArray(),
		);

	// La base central, en el SQLite de otro DO: el negocio, su licencia viva y una Handy emparejada
	// con su clave.
	return enElHub(`aud21-central-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		central = clienteSobre(sql);

		ensureEd25519Sha512();
		const seed = new Uint8Array(32).fill(7);
		const pub = bytesToB64(await ed.getPublicKeyAsync(seed));
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, tenantId);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES ('lic-aud21', ?, ?, 'main-aud21', 'active', 0, 12, 'manual', 1, 1, ?, 'bar@ejemplo.test', 1, 1);`,
			LIC_HASH,
			tenantId,
			Date.now() + 30 * DIA_MS,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
			 VALUES (?, ?, 'handy', ?, 'ed25519');`,
			HANDY,
			tenantId,
			pub,
		);

		/**
		 * Una petición firmada como la del cliente Rust. La firma cubre hora, método, ruta, token y
		 * cuerpo; `X-Client-Now` va fuera de ella. Cada una, con su clave de idempotencia: un UUID, como
		 * la de la Handy (AUD-32 le exige esa forma).
		 */
		const fichar = async (usuario: string, tipo: "entrada" | "salida", clientNow: string) => {
			const token = await firmarSesion(env, { tenantId, deviceId: HANDY, licHash: LIC_HASH }, { rol: "handy" });
			const ruta = "/v1/login/punch";
			const cuerpo = new TextEncoder().encode(JSON.stringify({ id_usuario: usuario, pin: PIN, tipo }));
			const ts = Date.now();
			const mensaje = ["DEVICE_PROOF", ts, "POST", ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
			const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));
			const req = new Request(`https://tpv-api.test${ruta}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"X-Device-Ts": String(ts),
					"X-Device-Sig": firma,
					"X-Idempotency-Key": crypto.randomUUID(),
					"X-Client-Now": clientNow,
					"content-type": "application/json",
				},
				body: cuerpo,
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch!(req as any, env, ctx);
			await waitOnExecutionContext(ctx);
			return res;
		};

		try {
			return await prueba({ filas, difundidos, fichar });
		} finally {
			central = null;
		}
	});
}

describe("AUD-21 · POST /v1/login/punch con una X-Client-Now imposible", () => {
	it("contesta lo mismo que a una hora fuera de la deriva y no ficha nada", async () => {
		await escenario("imposible", async ({ filas, difundidos, fichar }) => {
			// La referencia: el mismo día, bien escrito, está fuera de la deriva.
			const control = await fichar("u-2", "entrada", "2020-01-01 00:30:00");
			expect(control.status).toBe(400);
			const rechazo = (await control.json()) as any;
			expect(rechazo.error).toBe("missing_client_now");

			for (const hora of IMPOSIBLES) {
				const r = await fichar("u-1", "entrada", hora);
				expect(r.status, hora).toBe(400);
				expect(await r.json(), hora).toEqual(rechazo);
			}
			expect(await filas("u-1")).toEqual([]);
			expect(await filas("u-2")).toEqual([]);
			expect(difundidos).toEqual([]);
		});
	});

	it("con la hora real del equipo, la jornada entra con esa hora", async () => {
		await escenario("real", async ({ filas, difundidos, fichar }) => {
			const ahora = serverNowFixed();
			const r = await fichar("u-1", "entrada", ahora);
			expect(r.status).toBe(200);
			expect(await filas("u-1")).toEqual([
				{ Fecha: ahora.slice(0, 10), Hora_Entrada: ahora, Hora_Salida: null, Estado: "ABIERTO" },
			]);
			expect(difundidos).toHaveLength(1);
		});
	});
});
