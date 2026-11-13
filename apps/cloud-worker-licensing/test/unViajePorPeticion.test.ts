// test/unViajePorPeticion.test.ts
//
// Las rutas de negocio se ejecutan dentro del TenantHub del negocio (`lib/enElHub.ts`): el Worker
// autentica y le pasa la petición entera, y el DO la ejecuta con su base al lado. Esto pasa por la
// `app` completa y el entorno real de la suite:
//
// - la respuesta es la de la base que vive en el DO, y la petición hace UN viaje (`hub-ruta`), sin
//   ninguna consulta suelta (`hub-lee`);
// - un rechazo de negocio que se decide dentro del DO llega al cliente con su código y su status;
// - lo que decide la base central (aquí, una licencia anulada) se queda en el Worker;
// - las lecturas que van por POST (AUD-27) hacen el mismo viaje, con su cuerpo, y el tope de ese
//   cuerpo se comprueba en el Worker: lo que pasa de él no llega al DO.

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

/** Un negocio con su base en el DO (el administrador con el que nace y un usuario más) y su licencia en la base central. */
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
	opciones: { cuerpo?: unknown; entorno?: Record<string, unknown>; sinClave?: boolean; firma?: string } = {},
): Promise<{ status: number; json: any; tiempos: string }> {
	const token = await firmarSesion(env, { tenantId: n.tenantId, deviceId: MAIN, licHash: LIC_HASH });
	const cuerpo = opciones.cuerpo === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opciones.cuerpo));
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, metodo, ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
	const firma = opciones.firma ?? bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), n.seed));
	const res = await app.request(
		ruta,
		{
			method: metodo,
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(ts),
				"X-Device-Sig": firma,
				"X-Client-Now": ahora(),
				...(opciones.sinClave ? {} : { "X-Idempotency-Key": "un-viaje-0123456789abcdef" }),
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
			const r = await pedir(n, "GET", "/v1/login/users");
			expect(r.status).toBe(200);
			expect(r.json.map((u: any) => u.nombre).sort()).toEqual(["Admin", "Lucía"]);
			expect(viajes(r.tiempos, "hub-ruta")).toBe(1);
			expect(viajes(r.tiempos, "hub-lee")).toBe(0);
			// El DO trae su propio desglose: el trabajo hecho dentro, sin viajes.
			expect(r.tiempos).toMatch(/en-hub-total;dur=/);
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

describe("las lecturas por POST (AUD-27) también van enteras al TenantHub", () => {
	const KB = 1024;

	/** Las lecturas por POST, con un cuerpo de los que manda la app y el tope del suyo. */
	const LECTURAS: { ruta: string; cuerpo: Record<string, unknown>; tope: number }[] = [
		{ ruta: "/v1/reservas/buscar-cliente", cuerpo: { telefono: "600000000" }, tope: 8 * KB },
		{ ruta: "/v1/cuentas/entradas", cuerpo: { del: "2026-05-01", al: "2026-05-31", q: "cliente ficticio" }, tope: 8 * KB },
		{ ruta: "/v1/cuentas/salidas", cuerpo: { del: "2026-05-01", al: "2026-05-31", q: "luz" }, tope: 8 * KB },
		{ ruta: "/v1/cuentas/resumen", cuerpo: { del: "2026-05-01", al: "2026-05-31", q: "cliente ficticio" }, tope: 8 * KB },
		{ ruta: "/v1/mesas/productos/search", cuerpo: { query: "cro" }, tope: 8 * KB },
		{ ruta: "/v1/venta-rapida/productos/search", cuerpo: { query: "cro", limit: 5 }, tope: 8 * KB },
		{ ruta: "/v1/venta-rapida/index-rows", cuerpo: { ids: ["com-1"] }, tope: 64 * KB },
	];

	/** Lo que encuentran: un cliente y un producto, en la base del DO. */
	async function conDatos(n: Negocio): Promise<void> {
		await enElHub(n.tenantId, (hub: any) => {
			const sql = hub.state.storage.sql;
			sql.exec(
				"INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) VALUES ('cli-1', 'Cliente Ficticio', '600000000', 'prueba@ejemplo.invalid', '2026-01-01 10:00:00');",
			);
			sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Pasa_Cocina) VALUES ('cat-cocina', 'Platos', 1);");
			sql.exec(
				"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-croquetas', 'cat-cocina', 'Croquetas', 750);",
			);
		});
	}

	it("cada una hace un solo viaje, sin clave de idempotencia y sin consultas sueltas, y lee la base del DO", async () => {
		await conNegocio("lecturas-post", {}, async (n) => {
			await conDatos(n);
			for (const { ruta, cuerpo } of LECTURAS) {
				const r = await pedir(n, "POST", ruta, { cuerpo, sinClave: true });
				expect(r.status, ruta).toBe(200);
				expect(viajes(r.tiempos, "hub-ruta"), ruta).toBe(1);
				expect(viajes(r.tiempos, "hub-lee"), ruta).toBe(0);
				expect(viajes(r.tiempos, "hub-escribe"), ruta).toBe(0);
			}

			const cliente = await pedir(n, "POST", "/v1/reservas/buscar-cliente", { cuerpo: { telefono: " 600000000 " }, sinClave: true });
			expect(cliente.json).toMatchObject({ id_cliente: "cli-1", coincide_por: "telefono" });
			const productos = await pedir(n, "POST", "/v1/venta-rapida/productos/search", { cuerpo: { query: "cro", limit: 5 }, sinClave: true });
			expect(JSON.stringify(productos.json)).toContain("Croquetas");
		});
	});

	it("un cuerpo que pasa de su tope se rechaza en el Worker, antes de autenticar: no llega al DO", async () => {
		await conNegocio("lecturas-post-tope", {}, async (n) => {
			for (const { ruta, cuerpo, tope } of LECTURAS) {
				// Con una firma que no vale: si se autenticara antes de mirar el tope, sería un 401.
				const r = await pedir(n, "POST", ruta, {
					cuerpo: { ...cuerpo, relleno: "x".repeat(tope + KB) },
					sinClave: true,
					firma: "firma-que-no-vale",
				});
				expect(r.status, ruta).toBe(413);
				expect(r.json, ruta).toMatchObject({ ok: false, error: "payload_too_large" });
				expect(viajes(r.tiempos, "hub-ruta"), ruta).toBe(0);
			}
		});
	});

	it("un cuerpo que no es una búsqueda se rechaza dentro, con el mismo sobre", async () => {
		await conNegocio("lecturas-post-validacion", {}, async (n) => {
			const r = await pedir(n, "POST", "/v1/venta-rapida/productos/search", { cuerpo: { query: 7 }, sinClave: true });
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ ok: false, error: "validation_error" });
			expect(viajes(r.tiempos, "hub-ruta")).toBe(1);
		});
	});
});
