// test/rolEnLaIdentidad.test.ts
//
// «Esto sólo lo hace la Main» lo decide un middleware (`soloLaMain…`) con el rol de la fila del
// dispositivo. Las rutas de negocio se ejecutan dentro del TenantHub (`lib/enElHub.ts`), y allí
// ese middleware volvía a la base central a por el rol: un viaje más por petición, desde el DO.
// Ahora el rol lo lee el Worker con la clave pública del dispositivo, en la consulta que ya hacía
// para autenticar, y viaja con la identidad (`IdentidadDelWorker`).
//
// Esto pasa por la `app` entera y por el RPC de verdad (`ejecutarRuta`), y comprueba:
//
// - la Main pasa el veto dentro del DO sin que nadie le pida el rol a la base central, y con la
//   entrada del dispositivo en caché la petición no toca la base central;
// - una Handy se queda fuera, decidido dentro del DO y antes de mirar el cuerpo;
// - el rol no sale de la petición: una cabecera `x-role` no abre nada;
// - con las rutas ejecutándose en el Worker, el veto sigue leyendo la fila viva, como antes;
// - una baja se nota como mucho al caducar la entrada del dispositivo (60 s), que es lo que ya
//   tardaba en notarla `tenantAuth`, y un dispositivo dado de baja nunca entra en la caché.

import { env as entorno } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";

let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const env = entorno as any;
const MAIN = "main-rol";
const HANDY = "handy-rol";
const LIC_HASH = "hash-rol";

type Negocio = {
	tenantId: string;
	/** Lo que se le ha pedido a la base central, en orden. */
	central: string[];
	/** Ejecuta SQL en la base central, sin que cuente como consulta del worker. */
	enCentral: (sql: string, ...args: unknown[]) => void;
};

/** La consulta de `rolDelDispositivo`: el rol de la fila viva, sin más columnas. */
const PIDE_EL_ROL = /SELECT role FROM devices WHERE tenant_id=\? AND device_id=\? AND revoked_at_ms IS NULL/;

const SEMILLAS: Record<string, Uint8Array> = {
	[MAIN]: new Uint8Array(32).fill(11),
	[HANDY]: new Uint8Array(32).fill(12),
};

/** Un negocio con su base en el DO, y en la base central su licencia, su Main y una Handy. */
async function conNegocio<R>(nombre: string, prueba: (n: Negocio) => Promise<R>): Promise<R> {
	olvidarLicenciasCacheadas();
	const tenantId = `rol-identidad-${nombre}`;
	await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);

	ensureEd25519Sha512();
	return enElHub(`rol-identidad-central-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, tenantId);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, 'active', 0, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
			`lic-${nombre}`,
			LIC_HASH,
			tenantId,
			MAIN,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
		for (const [deviceId, rol] of [[MAIN, "tpv"], [HANDY, "handy"]] as const) {
			sql.exec(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
				 VALUES (?, ?, ?, ?, 'ed25519');`,
				deviceId,
				tenantId,
				rol,
				bytesToB64(await ed.getPublicKeyAsync(SEMILLAS[deviceId])),
			);
		}

		const central: string[] = [];
		const real = clienteSobre(sql);
		dbCentral = {
			...real,
			execute: async (entrada: any) => {
				central.push(String(typeof entrada === "string" ? entrada : entrada.sql).replace(/\s+/g, " ").trim());
				return real.execute(entrada);
			},
		};
		try {
			return await prueba({ tenantId, central, enCentral: (texto, ...args) => void sql.exec(texto, ...args) });
		} finally {
			dbCentral = null;
		}
	});
}

/** Una petición firmada como la del cliente Rust (`sign_device_proof`), contra la app entera. */
async function pedir(
	n: Negocio,
	deviceId: string,
	ruta: string,
	cuerpoJson: unknown,
	opciones: { entorno?: Record<string, unknown>; cabeceras?: Record<string, string> } = {},
): Promise<{ status: number; json: any; viajes: number }> {
	const token = await firmarSesion(env, { tenantId: n.tenantId, deviceId, licHash: LIC_HASH });
	const cuerpo = new TextEncoder().encode(JSON.stringify(cuerpoJson));
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, "POST", ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), SEMILLAS[deviceId]));
	const res = await app.request(
		ruta,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(ts),
				"X-Device-Sig": firma,
				"X-Client-Now": new Date().toISOString().slice(0, 19).replace("T", " "),
				"X-Idempotency-Key": "rol-identidad-0123456789abcdef",
				"content-type": "application/json",
				...opciones.cabeceras,
			},
			body: cuerpo,
		},
		{ ...env, ...opciones.entorno },
	);
	const tiempos = res.headers.get("Server-Timing") ?? "";
	const m = /(?:^|, )hub-ruta;dur=[\d.]+;desc="(\d+)"/.exec(tiempos);
	return { status: res.status, json: await res.json(), viajes: m ? Number(m[1]) : 0 };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("el rol del dispositivo viaja con la identidad al TenantHub", () => {
	it("la Main pasa el veto dentro del DO sin que nadie vuelva a la base central a por el rol", async () => {
		await conNegocio("main", async (n) => {
			expect(env.EJECUTAR_EN_EL_HUB).toBe("1");

			const primera = await pedir(n, MAIN, "/v1/sync/changes", { since: 0 });
			expect(primera.status).toBe(200);
			expect(primera.json).toMatchObject({ items: [] });
			expect(primera.viajes).toBe(1);
			// El rol salió de la fila del dispositivo, en la consulta que autentica.
			expect(n.central.some((s) => /SELECT role, revoked_at_ms, device_pubkey_b64 FROM devices/.test(s))).toBe(true);
			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toEqual([]);

			// Con el dispositivo y la licencia en caché, la petición entera no toca la base central.
			n.central.length = 0;
			const segunda = await pedir(n, MAIN, "/v1/sync/changes", { since: 0 });
			expect(segunda.status).toBe(200);
			expect(segunda.viajes).toBe(1);
			expect(n.central).toEqual([]);
		});
	});

	it("una Handy se queda fuera, decidido dentro del DO y antes de mirar el cuerpo", async () => {
		await conNegocio("handy", async (n) => {
			const sync = await pedir(n, HANDY, "/v1/sync/changes", { since: 0 });
			expect(sync.status).toBe(403);
			expect(sync.json).toMatchObject({ ok: false, error: "forbidden_not_tpv" });
			expect(sync.viajes).toBe(1);

			// Un cuerpo que no valdría: si el veto fuera detrás de la validación, saldría un 400.
			const cobro = await pedir(n, HANDY, "/v1/mesas/cobrar-detalles", { esto: "no es un cobro" });
			expect(cobro.status).toBe(403);
			expect(cobro.json).toMatchObject({ ok: false, error: "cobro_solo_en_main" });
			expect(cobro.viajes).toBe(1);

			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toEqual([]);
		});
	});

	it("el rol no sale de la petición: una cabecera no convierte a una Handy en la Main", async () => {
		await conNegocio("cabecera", async (n) => {
			const r = await pedir(n, HANDY, "/v1/sync/changes", { since: 0 }, {
				cabeceras: { "x-role": "tpv", "x-device-role": "tpv", "x-rol": "tpv" },
			});
			expect(r.status).toBe(403);
			expect(r.json.error).toBe("forbidden_not_tpv");
		});
	});

	it("con las rutas en el Worker, el veto sigue leyendo la fila viva de la base central", async () => {
		await conNegocio("worker", async (n) => {
			const apagado = { entorno: { EJECUTAR_EN_EL_HUB: "0" } };

			const main = await pedir(n, MAIN, "/v1/sync/changes", { since: 0 }, apagado);
			expect(main.status).toBe(200);
			expect(main.viajes).toBe(0);
			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toHaveLength(1);

			const handy = await pedir(n, HANDY, "/v1/sync/changes", { since: 0 }, apagado);
			expect(handy.status).toBe(403);
			expect(handy.json.error).toBe("forbidden_not_tpv");
			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toHaveLength(2);
		});
	});
});

describe("una baja no dura en la caché más que antes", () => {
	it("la Main dada de baja deja de pasar al caducar su entrada, a los 60 s", async () => {
		await conNegocio("baja", async (n) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const t0 = Date.now();

			expect((await pedir(n, MAIN, "/v1/sync/changes", { since: 0 })).status).toBe(200);
			n.enCentral(`UPDATE devices SET revoked_at_ms = ? WHERE device_id = ?;`, t0, MAIN);

			// Caducada la entrada, se vuelve a leer la fila: ni la clave ni el rol salen de la caché.
			vi.setSystemTime(t0 + 60_001);
			const despues = await pedir(n, MAIN, "/v1/sync/changes", { since: 0 });
			expect(despues.status).toBe(401);
			expect(despues.json.error).toBe("device_revoked");
			expect(despues.viajes).toBe(0);
		});
	});

	it("un dispositivo dado de baja no entra en la caché: se rechaza en cada petición", async () => {
		await conNegocio("baja-sin-cache", async (n) => {
			n.enCentral(`UPDATE devices SET revoked_at_ms = ? WHERE device_id = ?;`, Date.now(), MAIN);

			for (let i = 0; i < 2; i++) {
				n.central.length = 0;
				const r = await pedir(n, MAIN, "/v1/sync/changes", { since: 0 });
				expect(r.status).toBe(401);
				expect(r.json.error).toBe("device_revoked");
				expect(r.viajes).toBe(0);
				expect(n.central.some((s) => /FROM devices/.test(s))).toBe(true);
			}
		});
	});
});
