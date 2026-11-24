// test/licenciaEnRutasDeNegocio.test.ts
//
// REV-12: con la licencia muerta, el token seguía abriendo todas las puertas.
//
// La comprobación de licencia estaba sólo delante del ticket del WebSocket. Para el resto bastaba
// el JWT, que dura 30 días y que `/v1/license/status` **renueva cada seis horas**, así que un
// negocio con la licencia anulada o caducada conservaba indefinidamente una credencial válida para
// mandar correo con nuestro dominio, subir imágenes a R2, bajarse el volcado completo de
// `/v1/sync/bootstrap` y leer todo lo que lee una Handy. El cliente se bloquea solo porque obedece
// la aserción firmada: lo único que lo impedía era su buena fe.
//
// Lo que se fija aquí son los dos lados, porque el arreglo sólo vale si la gracia sigue pasando:
// bloquear durante `expiry_grace` dejaría a un TPV vendiendo sin poder replicar, que es la peor
// combinación posible.

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as ed from "@noble/ed25519";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

// Las lecturas de negocio no son lo que se prueba: lo que importa es si se llega a ellas.
vi.mock("../src/lib/tenantClient", () => ({
	tenantQuery: async () => [],
	conLaHoraDeQuienPregunta: (db: unknown) => db,
}));

const { loginRoutes } = await import("../src/domains/login/login.routes");
const { licenseRoutes } = await import("../src/domains/licensing/licensing.routes");
const { wsRoutes } = await import("../src/domains/ws/ws.routes");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
};

const TENANT = "tenant-1";
const MAIN = "main-1";
const LIC_HASH = "hash-licencia";
const DIA = 24 * 60 * 60 * 1000;

/** Días que faltan para caducar; negativo = ya caducó. `null` = sin fecha (perpetua). */
type Caducidad = number | null;

async function clave(relleno: number) {
	ensureEd25519Sha512();
	const seed = new Uint8Array(32).fill(relleno);
	return { seed, pub: bytesToB64(await ed.getPublicKeyAsync(seed)) };
}

beforeEach(() => {
	// La caché vive en el módulo y el isolate se reutiliza entre casos.
	olvidarLicenciasCacheadas();
});

async function escenario<R>(
	nombre: string,
	opciones: { caducaEnDias: Caducidad; anulada?: boolean; mainDeLaLicencia?: string; rol?: string },
	prueba: (seed: Uint8Array, sql: any) => Promise<R>,
): Promise<R> {
	return enElHub(`lic-negocio-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of ["devices", "licenses", "tenants"]) sql.exec(`DELETE FROM ${tabla};`);
		sql.exec(`CREATE TABLE IF NOT EXISTS Ws_Tickets (ticket TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
		          device_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL);`);
		dbDePruebas = clienteSobre(sql);

		const { seed, pub } = await clave(1);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES ('lic-1', ?, ?, ?, ?, 0, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
			LIC_HASH,
			TENANT,
			opciones.mainDeLaLicencia ?? MAIN,
			opciones.anulada ? "revoked" : "active",
			opciones.caducaEnDias === null ? null : Date.now() + opciones.caducaEnDias * DIA,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
			 VALUES (?, ?, ?, ?, 'ed25519');`,
			MAIN,
			TENANT,
			opciones.rol ?? "tpv",
			pub,
		);
		return prueba(seed, sql);
	});
}

/** Una petición firmada como la del cliente Rust (`sign_device_proof`). */
async function pedir(
	app: { request: (...a: any[]) => Promise<Response> },
	metodo: "GET" | "POST",
	ruta: string,
	seed: Uint8Array,
	licHash = LIC_HASH,
): Promise<Response> {
	const token = await firmarSesion(ENV as any, {
		tenantId: TENANT,
		deviceId: MAIN,
		licHash,
	});
	const ts = Date.now();
	const mensaje = [
		"DEVICE_PROOF",
		ts,
		metodo,
		ruta,
		await sha256HexStr(token),
		await sha256HexBytes(new Uint8Array()),
	].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));

	return app.request(
		ruta,
		{
			method: metodo,
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(ts),
				"X-Device-Sig": firma,
			},
		},
		ENV,
	);
}

const negocio = (seed: Uint8Array) => pedir(loginRoutes as any, "GET", "/users", seed);

describe("REV-12 · la licencia manda en TODAS las rutas de negocio", () => {
	it("anulada: el token ya no abre nada", async () => {
		await escenario("anulada", { caducaEnDias: 30, anulada: true }, async (seed) => {
			const res = await negocio(seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("license_revoked");
		});
	});

	it("caducada y pasada la gracia: tampoco", async () => {
		await escenario("caducada", { caducaEnDias: -60 }, async (seed) => {
			const res = await negocio(seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("license_expired");
		});
	});

	it("pero en la GRACIA por caducidad SÍ pasa, y tiene que pasar", async () => {
		// Durante la gracia el TPV sigue vendiendo. Bloquear aquí lo dejaría vendiendo sin poder
		// replicar, que es la peor combinación: acumula un outbox que quizá no suba nunca.
		await escenario("gracia", { caducaEnDias: -1 }, async (seed) => {
			expect((await negocio(seed)).status).toBe(200);
		});
	});

	it("y una licencia sana, también", async () => {
		await escenario("sana", { caducaEnDias: 30 }, async (seed) => {
			expect((await negocio(seed)).status).toBe(200);
		});
	});

	it("una Main desplazada deja de escribir en el tenant que ya no es suyo", async () => {
		// Dos Mains replicando a la vez sobre el mismo tenant es lo que esto impide.
		await escenario("desplazada", { caducaEnDias: 30, mainDeLaLicencia: "otro-equipo" }, async (seed) => {
			const res = await negocio(seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("device_replaced");
		});
	});

	it("a una Handy NO se le aplica el traslado de licencia", async () => {
		// Una Handy nunca es —ni puede ser— el `main_device_id`, así que medirla con esa vara la
		// daría por desplazada SIEMPRE y bloquearía todas las del local.
		await escenario("handy", { caducaEnDias: 30, mainDeLaLicencia: "otro-equipo", rol: "handy" }, async (seed) => {
			expect((await negocio(seed)).status).toBe(200);
		});
	});
});

describe("AUD-03 · la licencia del token tiene que ser la de su negocio", () => {
	// Un token con el `licHash` de otra fila (de otro negocio, o sin negocio) no puede hacer pasar la
	// licencia anulada de éste. `/refresh` ya no los firma; esto cubre cualquier otro camino.
	it("con la licencia de otro negocio, viva, no abre nada", async () => {
		await escenario("aud03-ajena", { caducaEnDias: 30, anulada: true }, async (seed, sql) => {
			sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('tenant-otro');`);
			sql.exec(
				`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
				                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
				                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES ('lic-ajena', 'hash-ajena', 'tenant-otro', ?, 'active', 0, 12, 'stripe', 1, 1, ?,
				         'otro@a.test', 1, 1);`,
				MAIN,
				Date.now() + 30 * DIA,
			);

			const res = await pedir(loginRoutes as any, "GET", "/users", seed, "hash-ajena");
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("license_not_found");

			// Y `/status` ni la firma, ni renueva el token, ni enseña su correo.
			const status = await pedir(licenseRoutes as any, "GET", "/status", seed, "hash-ajena");
			expect(status.status).toBe(404);
			const cuerpo = (await status.json()) as any;
			expect(cuerpo.error).toBe("license_not_found");
			expect(cuerpo.assertion).toBeUndefined();
			expect(cuerpo.token).toBeUndefined();
			expect(cuerpo.info).toBeUndefined();
		});
	});

	it("con una clave sin estrenar, tampoco", async () => {
		await escenario("aud03-sin-estrenar", { caducaEnDias: 30, anulada: true }, async (seed, sql) => {
			sql.exec(
				`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
				                       disabled, term_months, origin, issued_at_ms, customer_email,
				                       created_at_ms, updated_at_ms)
				 VALUES ('lic-nueva', 'hash-nueva', NULL, NULL, 'issued', 0, 12, 'stripe', 1, 'bar@a.test', 1, 1);`,
			);

			const res = await pedir(loginRoutes as any, "GET", "/users", seed, "hash-nueva");
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("license_not_found");
		});
	});
});

describe("REV-12 · el token que reparte /status", () => {
	it("con la licencia anulada contesta, pero sin token nuevo", async () => {
		// La respuesta no puede callarse: es por donde el cliente se ENTERA de que ha dejado de
		// valer. Lo que se le niega es la credencial, no la noticia.
		await escenario("status-anulada", { caducaEnDias: 30, anulada: true }, async (seed) => {
			const res = await pedir(licenseRoutes as any, "GET", "/status", seed);
			expect(res.status).toBe(200);
			const cuerpo = (await res.json()) as any;
			expect(cuerpo.assertion).toBeTruthy();
			expect(cuerpo.token).toBeUndefined();
		});
	});

	it("durante la gracia sí lo renueva", async () => {
		await escenario("status-gracia", { caducaEnDias: -1 }, async (seed) => {
			const cuerpo = (await (await pedir(licenseRoutes as any, "GET", "/status", seed)).json()) as any;
			expect(typeof cuerpo.token).toBe("string");
		});
	});
});

describe("REV-12 · la Main a la que se le anula la licencia no recupera el socket", () => {
	it("el ticket con el que reconecta mira la licencia sin la caché del minuto", async () => {
		await escenario("reconecta", { caducaEnDias: 30 }, async (seed, sql) => {
			// Conectada y replicando: el «sí» queda en la caché del isolate.
			expect((await pedir(wsRoutes as any, "POST", "/ticket", seed)).status).toBe(200);
			expect((await negocio(seed)).status).toBe(200);

			// `revoke` anula y le cierra el socket; la Main reconecta a los pocos segundos.
			sql.exec(`UPDATE licenses SET status = 'revoked';`);
			const res = await pedir(wsRoutes as any, "POST", "/ticket", seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("license_revoked");
		});
	});
});
