// test/ficharDosVeces.test.ts
//
// AUD-47 · Fichar una entrada que no toca es un 409 con la frase de la Main, no un 500.
//
// `nextPunchPart` rechazaba con un `Error` a secas, que `onError` contesta como `internal_error`:
// quien fichaba la entrada dos veces en la Handy leía que el servidor había fallado, y con la frase
// sin acentos. Ahora los cuatro rechazos son un `HubError` 409 con el texto que da la Main
// (`exec_punch`, en `crates/tpv-infra-sqlite/src/login.rs`), que aquí se lee de su fuente.
//
// Dos alturas: la consulta contra el SQLite de un Durable Object con el esquema del negocio, y la
// ruta de punta a punta por `src/index.ts` con la autenticación real de una Handy (token de sesión,
// prueba ed25519, licencia y PIN), ejecutada dentro del TenantHub del negocio como en producción.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { createExecutionContext, env as entorno, waitOnExecutionContext } from "cloudflare:test";

import fuenteDeLaMain from "../../../crates/tpv-infra-sqlite/src/login.rs?raw";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";
import { GuardaIncumplida, loteEnBruto } from "../src/durableObjects/tenantHub.sqlite";
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
const { getOpenPunch, parteSiguiente } = await import("../src/domains/login/login.queries");
const { punchEntrada, punchSalida } = await import("../src/domains/login/login.commands");
const { serverNowFixed } = await import("../src/durableObjects/tenantHub.tiempo");

beforeEach(() => {
	olvidarLicenciasCacheadas();
});

const ABIERTO = "Tienes un fichaje abierto. Ficha salida antes de fichar entrada.";
const PARTE_1_SIN_CERRAR = "La Parte 1 no está cerrada. Ficha salida primero.";
const PARTIDO_COMPLETO = "Ya has completado el turno partido hoy.";
const SIN_TURNO_PARTIDO = "Hoy no tienes turno partido. Ya has fichado el día.";
// TRA-INC-04: la salida que ya fichó otro equipo no se confunde con no haber entrado.
const SALIDA_YA_FICHADA = "La salida ya está fichada.";
const SIN_ABIERTO = "No hay fichaje abierto para cerrar (primero ficha entrada).";

describe("AUD-47 · las frases son las de la Main", () => {
	it("cada una está, tal cual, en exec_punch", () => {
		// Rust parte la llamada en varias líneas cuando no cabe: se quita el relleno de alrededor
		// del literal para comparar la llamada entera.
		const main = fuenteDeLaMain.replace(/\(\s+"/g, '("').replace(/",?\s+\)/g, '")');
		for (const frase of [ABIERTO, PARTE_1_SIN_CERRAR, PARTIDO_COMPLETO, SIN_TURNO_PARTIDO, SALIDA_YA_FICHADA, SIN_ABIERTO]) {
			expect(main, frase).toContain(`AppError::conflict("${frase}")`);
		}
	});
});

describe("AUD-47 · TRA-INC-04 · las guardas del fichaje rechazan con un 409 y su frase", () => {
	const HOY = "2099-05-10";

	/** El lote de un comando contra el SQLite del DO, como lo aplica el motor (guardas incluidas). */
	function aplicarLote(hub: any, built: any) {
		loteEnBruto(hub.state.storage, [
			{ sql: "PRAGMA defer_foreign_keys = ON;", args: [] },
			...buildApplyBatch(built.command).middle,
		]);
	}

	/**
	 * La entrada de hoy en la parte que elige la ruta (`parteSiguiente`), con el esquema del negocio
	 * en el SQLite de un DO y un usuario.
	 */
	async function conFichajes(nombre: string, sembrar: (sql: any) => void) {
		return enElHub(`aud47-consulta-${nombre}`, async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT 'u-1', ID_Rol, 'u1@ejemplo.test', 'x', 'Prueba' FROM Roles WHERE Nombre_Rol = 'Camarero';`,
			);
			sembrar(sql);
			const parte = await parteSiguiente(clienteSobre(sql) as any, "u-1", HOY);
			try {
				aplicarLote(hub, punchEntrada({ id_usuario: "u-1", fecha: HOY, parte }));
				return { parte };
			} catch (e) {
				return { error: e };
			}
		});
	}

	const esUn409 = (r: any, frase: string) => {
		expect(r.error).toBeInstanceOf(GuardaIncumplida);
		expect(r.error).toMatchObject({ status: 409, code: frase, message: frase });
	};

	it("sin fichajes abre la Parte 1; con turno partido y la primera cerrada, la 2", async () => {
		expect(await conFichajes("primera", () => {})).toEqual({ parte: 1 });
		const segunda = await conFichajes("segunda", (sql) => {
			sql.exec(`INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido) VALUES ('u-1', ?, 1);`, HOY);
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado)
				 VALUES ('f-1', 'u-1', ?, 1, ? || ' 09:00:00', ? || ' 13:00:00', 'CERRADO');`,
				HOY, HOY, HOY,
			);
		});
		expect(segunda).toEqual({ parte: 2 });
	});

	it("con un fichaje abierto", async () => {
		const r = await conFichajes("abierto", (sql) => {
			// «Abierto» es el de las últimas horas (RI-05): la entrada se pone con el reloj de la base.
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Estado)
				 VALUES ('f-1', 'u-1', date('now','localtime'), 1, datetime('now','localtime'), 'ABIERTO');`,
			);
		});
		esUn409(r, ABIERTO);
	});

	it("con la Parte 1 de hoy sin salida (una jornada que se cerró sola)", async () => {
		const r = await conFichajes("sin-salida", (sql) => {
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Estado, Cerrado_Automatico)
				 VALUES ('f-1', 'u-1', ?, 1, ? || ' 09:00:00', 'CERRADO', 1);`,
				HOY, HOY,
			);
		});
		esUn409(r, PARTE_1_SIN_CERRAR);
	});

	it("con el turno partido ya completo", async () => {
		const r = await conFichajes("completo", (sql) => {
			sql.exec(`INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido) VALUES ('u-1', ?, 1);`, HOY);
			for (const [id, parte, entrada, salida] of [
				["f-1", 1, "09:00:00", "13:00:00"],
				["f-2", 2, "17:00:00", "21:00:00"],
			] as const) {
				sql.exec(
					`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado)
					 VALUES (?, 'u-1', ?, ?, ? || ' ' || ?, ? || ' ' || ?, 'CERRADO');`,
					id, HOY, parte, HOY, entrada, HOY, salida,
				);
			}
		});
		esUn409(r, PARTIDO_COMPLETO);
	});

	it("sin turno partido y con la jornada ya fichada", async () => {
		const r = await conFichajes("sin-partido", (sql) => {
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado)
				 VALUES ('f-1', 'u-1', ?, 1, ? || ' 09:00:00', ? || ' 17:00:00', 'CERRADO');`,
				HOY, HOY, HOY,
			);
		});
		esUn409(r, SIN_TURNO_PARTIDO);
	});

	it("la salida que otro equipo ficha entre la lectura de la ruta y el lote no se pisa", async () => {
		await enElHub("tra-inc-04-salida-cruzada", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT 'u-1', ID_Rol, 'u1@ejemplo.test', 'x', 'Prueba' FROM Roles WHERE Nombre_Rol = 'Camarero';`,
			);
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Estado)
				 VALUES ('f-1', 'u-1', date('now','localtime'), 1, datetime('now','localtime','-2 hours'), 'ABIERTO');`,
			);
			// Lo que lee la ruta.
			const abierto = await getOpenPunch(clienteSobre(sql) as any, "u-1");
			expect(abierto?.id_fichaje).toBe("f-1");
			const built = punchSalida({ id_usuario: "u-1", id_fichaje: abierto!.id_fichaje, fecha: abierto!.fecha });

			// Entre medias, la salida llega de otra Handy.
			sql.exec(
				`UPDATE Fichajes SET Hora_Salida = datetime('now','localtime','-1 hours'), Estado = 'CERRADO' WHERE ID_Fichaje = 'f-1';`,
			);
			const antes = sql.exec(`SELECT Hora_Salida FROM Fichajes WHERE ID_Fichaje = 'f-1';`).one().Hora_Salida;

			let error: unknown = null;
			try {
				aplicarLote(hub, built);
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(GuardaIncumplida);
			expect(error).toMatchObject({ status: 409, message: SALIDA_YA_FICHADA });
			expect(sql.exec(`SELECT Hora_Salida FROM Fichajes WHERE ID_Fichaje = 'f-1';`).one().Hora_Salida).toBe(antes);

			// Y lo que se replica a la Main tampoco pisa una salida que ya tenga.
			const [update] = buildApplyBatch(built.command).replicated;
			expect(update.sql).toMatch(/WHERE ID_Fichaje = \?1 AND Hora_Salida IS NULL/);
		});
	});

	it("sin jornada en curso ni salida reciente, la frase de siempre", async () => {
		await enElHub("tra-inc-04-sin-entrada", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT 'u-1', ID_Rol, 'u1@ejemplo.test', 'x', 'Prueba' FROM Roles WHERE Nombre_Rol = 'Camarero';`,
			);
			let error: unknown = null;
			try {
				aplicarLote(hub, punchSalida({ id_usuario: "u-1", id_fichaje: null, fecha: HOY }));
			} catch (e) {
				error = e;
			}
			expect(error).toMatchObject({ status: 409, message: SIN_ABIERTO });
		});
	});
});

const TENANT = "tenant-aud47";
const HANDY = "handy-aud47";
const LIC_HASH = "hash-licencia-aud47";
const DIA_MS = 24 * 60 * 60 * 1000;
const PIN = "4321";

type Caso = {
	/** Los fichajes del usuario, leídos de la base del negocio (el SQLite de su TenantHub). */
	filas: () => Promise<any[]>;
	/** Con `clave`, la `X-Idempotency-Key` de un reintento. */
	fichar: (tipo: "entrada" | "salida", clave?: string) => Promise<Response>;
};

/** Un negocio con un camarero, su licencia viva, una Handy emparejada y la Main conectada. */
async function escenario<R>(nombre: string, prueba: (c: Caso) => Promise<R>): Promise<R> {
	const tenantId = `${TENANT}-${nombre}`;

	await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);
	const hash = await hashPin(PIN);
	await enElHub(tenantId, (hub: any) => {
		hub.state.storage.sql.exec(
			`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
			 SELECT 'u-1', ID_Rol, 'u1@ejemplo.test', ?, 'Prueba' FROM Roles WHERE Nombre_Rol = 'Camarero';`,
			hash,
		);
		hub.isMainConnected = () => true;
		hub.isMainReady = () => true;
		hub.broadcastChange = () => {};
	});
	const filas = () =>
		enElHub(tenantId, (hub: any) =>
			hub.state.storage.sql
				.exec(`SELECT Parte, Hora_Salida IS NOT NULL AS cerrado, Estado FROM Fichajes WHERE ID_Usuario = 'u-1' ORDER BY Parte;`)
				.toArray(),
		);

	return enElHub(`aud47-central-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		central = clienteSobre(sql);

		ensureEd25519Sha512();
		const seed = new Uint8Array(32).fill(47);
		const pub = bytesToB64(await ed.getPublicKeyAsync(seed));
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, tenantId);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES ('lic-aud47', ?, ?, 'main-aud47', 'active', 0, 12, 'manual', 1, 1, ?, 'bar@ejemplo.test', 1, 1);`,
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

		/** Una petición firmada como la del cliente Rust, con la hora real del equipo. */
		const fichar = async (tipo: "entrada" | "salida", clave: string = crypto.randomUUID()) => {
			const token = await firmarSesion(env, { tenantId, deviceId: HANDY, licHash: LIC_HASH }, { rol: "handy" });
			const ruta = "/v1/login/punch";
			const cuerpo = new TextEncoder().encode(JSON.stringify({ id_usuario: "u-1", pin: PIN, tipo }));
			const ts = Date.now();
			const mensaje = ["DEVICE_PROOF", ts, "POST", ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
			const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));
			const req = new Request(`https://tpv-api.test${ruta}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"X-Device-Ts": String(ts),
					"X-Device-Sig": firma,
					"X-Idempotency-Key": clave,
					"X-Client-Now": serverNowFixed(),
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
			return await prueba({ filas, fichar });
		} finally {
			central = null;
		}
	});
}

describe("AUD-47 · POST /v1/login/punch con una entrada que no toca", () => {
	it("entrada, salida y otra entrada el mismo día sin turno partido: 409 con su frase", async () => {
		await escenario("dos-veces", async ({ filas, fichar }) => {
			expect((await fichar("entrada")).status).toBe(200);
			expect((await fichar("salida")).status).toBe(200);

			const r = await fichar("entrada");
			expect(r.status).toBe(409);
			// `code` es por lo que ramifica el cliente; la frase va en `error`, que es lo que enseña.
			expect(await r.json()).toEqual({ ok: false, code: "conflict", error: SIN_TURNO_PARTIDO });

			// La jornada sigue como estaba: una parte, cerrada.
			expect(await filas()).toEqual([{ Parte: 1, cerrado: 1, Estado: "CERRADO" }]);
		});
	});

	it("entrada con un fichaje abierto: 409 con su frase, y no abre otro", async () => {
		await escenario("abierto", async ({ filas, fichar }) => {
			expect((await fichar("entrada")).status).toBe(200);

			const r = await fichar("entrada");
			expect(r.status).toBe(409);
			expect(await r.json()).toEqual({ ok: false, code: "conflict", error: ABIERTO });

			expect(await filas()).toEqual([{ Parte: 1, cerrado: 0, Estado: "ABIERTO" }]);
		});
	});
});

describe("TRA-INC-04 · POST /v1/login/punch cuando fichan dos equipos", () => {
	it("la salida que ya fichó otro equipo: 409 «La salida ya está fichada.», sin tocar la jornada", async () => {
		await escenario("salida-dos-veces", async ({ filas, fichar }) => {
			expect((await fichar("entrada")).status).toBe(200);
			expect((await fichar("salida")).status).toBe(200);

			const r = await fichar("salida");
			expect(r.status).toBe(409);
			expect(await r.json()).toEqual({ ok: false, code: "conflict", error: SALIDA_YA_FICHADA });
			expect(await filas()).toEqual([{ Parte: 1, cerrado: 1, Estado: "CERRADO" }]);
		});
	});

	it("el reintento de una entrada que ya entró contesta lo mismo, no «Tienes un fichaje abierto»", async () => {
		await escenario("reintento-entrada", async ({ filas, fichar }) => {
			const clave = crypto.randomUUID();
			const primera = await fichar("entrada", clave);
			expect(primera.status).toBe(200);
			const reintento = await fichar("entrada", clave);
			expect(reintento.status).toBe(200);
			expect(await reintento.json()).toEqual(await primera.json());
			expect(await filas()).toEqual([{ Parte: 1, cerrado: 0, Estado: "ABIERTO" }]);
		});
	});

	it("el reintento de una salida que ya entró contesta lo mismo, no «No hay fichaje abierto»", async () => {
		await escenario("reintento-salida", async ({ filas, fichar }) => {
			expect((await fichar("entrada")).status).toBe(200);
			const clave = crypto.randomUUID();
			const primera = await fichar("salida", clave);
			expect(primera.status).toBe(200);
			const reintento = await fichar("salida", clave);
			expect(reintento.status).toBe(200);
			expect(await reintento.json()).toEqual(await primera.json());
			expect(await filas()).toEqual([{ Parte: 1, cerrado: 1, Estado: "CERRADO" }]);
		});
	});
});
