// test/unViajePorPeticion.test.ts
//
// Las rutas de negocio se ejecutan dentro del TenantHub del negocio (`lib/enElHub.ts`): el Worker
// autentica y le pasa la petición entera, y el DO la ejecuta con su base al lado. Esto pasa por la
// `app` completa y el entorno real de la suite (`EJECUTAR_EN_EL_HUB = "1"`, de `wrangler.json`):
//
// - la respuesta es la de la base que vive en el DO, y la petición hace UN viaje (`hub-ruta`), sin
//   ninguna consulta suelta (`hub-lee`);
// - con el interruptor apagado, la misma ruta da lo mismo, consulta a consulta;
// - un rechazo de negocio que se decide dentro del DO llega al cliente con su código y su status;
// - lo que decide la base central (aquí, una licencia anulada) se queda en el Worker.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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
const MAIN = "main-un-viaje";
const LIC_HASH = "hash-un-viaje";
const ROL_CAMARERO = "00000000-0000-7000-8000-000000000002";

type Negocio = { tenantId: string; seed: Uint8Array };

/** Un negocio con su base en el DO (un usuario dentro) y su licencia en la base central. */
async function conNegocio<R>(
	nombre: string,
	opciones: { anulada?: boolean },
	prueba: (n: Negocio) => Promise<R>,
): Promise<R> {
	olvidarLicenciasCacheadas();
	const tenantId = `un-viaje-${nombre}`;
	await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);
	await enElHub(tenantId, (hub: any) => {
		hub.state.storage.sql.exec(
			`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES (?, ?, ?, 'x', 'Lucía');`,
			`usuario-${nombre}`,
			ROL_CAMARERO,
			`lucia-${nombre}@bar.test`,
		);
	});

	ensureEd25519Sha512();
	const seed = new Uint8Array(32).fill(7);
	const pub = bytesToB64(await ed.getPublicKeyAsync(seed));
	return enElHub(`un-viaje-central-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, tenantId);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, 0, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
			`lic-${nombre}`,
			LIC_HASH,
			tenantId,
			MAIN,
			opciones.anulada ? "revoked" : "active",
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
			 VALUES (?, ?, 'tpv', ?, 'ed25519');`,
			MAIN,
			tenantId,
			pub,
		);
		dbCentral = clienteSobre(sql);
		return prueba({ tenantId, seed });
	});
}

/** La «ahora» del cliente, como la manda la app: hora local sin zona (en los tests, UTC). */
function ahora(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Una petición firmada como la del cliente Rust (`sign_device_proof`), contra la app entera. */
async function pedir(
	n: Negocio,
	metodo: "GET" | "POST",
	ruta: string,
	opciones: { cuerpo?: unknown; entorno?: Record<string, unknown> } = {},
): Promise<{ status: number; json: any; tiempos: string }> {
	const token = await firmarSesion(env, { tenantId: n.tenantId, deviceId: MAIN, licHash: LIC_HASH });
	const cuerpo = opciones.cuerpo === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opciones.cuerpo));
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, metodo, ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), n.seed));
	const res = await app.request(
		ruta,
		{
			method: metodo,
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(ts),
				"X-Device-Sig": firma,
				"X-Client-Now": ahora(),
				"X-Idempotency-Key": "un-viaje-0123456789abcdef",
				...(opciones.cuerpo === undefined ? {} : { "content-type": "application/json" }),
			},
			...(opciones.cuerpo === undefined ? {} : { body: cuerpo }),
		},
		{ ...env, ...opciones.entorno },
	);
	return { status: res.status, json: await res.json(), tiempos: res.headers.get("Server-Timing") ?? "" };
}

/** Cuántos viajes de un tramo cuenta el `Server-Timing` (`hub-ruta;dur=12;desc="1"`). */
function viajes(tiempos: string, tramo: string): number {
	const m = new RegExp(`(?:^|, )${tramo};dur=[\\d.]+;desc="(\\d+)"`).exec(tiempos);
	return m ? Number(m[1]) : 0;
}

describe("un viaje al TenantHub por petición", () => {
	it("la lectura sale de la base del DO en un solo viaje, sin consultas sueltas", async () => {
		await conNegocio("lectura", {}, async (n) => {
			expect(env.EJECUTAR_EN_EL_HUB).toBe("1");
			const r = await pedir(n, "GET", "/v1/login/users");
			expect(r.status).toBe(200);
			expect(r.json.map((u: any) => u.nombre)).toEqual(["Lucía"]);
			expect(viajes(r.tiempos, "hub-ruta")).toBe(1);
			expect(viajes(r.tiempos, "hub-lee")).toBe(0);
			// El DO trae su propio desglose: el trabajo hecho dentro, sin viajes.
			expect(r.tiempos).toMatch(/en-hub-total;dur=/);
		});
	});

	it("con el interruptor apagado da lo mismo, consulta a consulta", async () => {
		await conNegocio("apagado", {}, async (n) => {
			const r = await pedir(n, "GET", "/v1/login/users", { entorno: { EJECUTAR_EN_EL_HUB: "0" } });
			expect(r.status).toBe(200);
			expect(r.json.map((u: any) => u.nombre)).toEqual(["Lucía"]);
			expect(viajes(r.tiempos, "hub-ruta")).toBe(0);
			expect(viajes(r.tiempos, "hub-lee")).toBe(1);
		});
	});

	it("un rechazo que decide el DO llega con su código y su status", async () => {
		await conNegocio("rechazo", {}, async (n) => {
			// Sin Main conectada, la escritura de la Handy no entra: lo decide el motor del DO.
			const r = await pedir(n, "POST", "/v1/clientes", { cuerpo: { id_cliente: null, nombre: "Ana" } });
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ ok: false, error: "main_offline" });
			expect(viajes(r.tiempos, "hub-ruta")).toBe(1);
			expect(viajes(r.tiempos, "hub-escribe")).toBe(0);
		});
	});

	it("la validación del cuerpo también se hace dentro, y contesta igual", async () => {
		await conNegocio("validacion", {}, async (n) => {
			const r = await pedir(n, "POST", "/v1/clientes", { cuerpo: { id_cliente: null, nombre: "  " } });
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ ok: false, message: "Escribe el nombre del cliente." });
		});
	});

	it("lo que decide la base central se queda en el Worker: una licencia anulada no llega al DO", async () => {
		await conNegocio("anulada", { anulada: true }, async (n) => {
			const r = await pedir(n, "GET", "/v1/login/users");
			expect(r.status).toBe(403);
			expect(r.json.error).toBe("license_revoked");
			expect(viajes(r.tiempos, "hub-ruta")).toBe(0);
		});
	});
});
