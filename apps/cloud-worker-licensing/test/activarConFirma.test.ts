// test/activarConFirma.test.ts
//
// AUD-01 · `/v1/license/activate` exige demostrar que se tiene la clave privada del equipo.
//
// La ruta es anónima, y las guardas REV-07 (`exigirClaveSiEsDeOtroNegocio`) y REV-13
// (`exigirLaClaveDeEsteEquipo`) comparan la clave pública del cuerpo con la registrada. Pero una
// clave pública no es un secreto: la Main de un negocio ve el `device_id` y la clave de cada equipo
// que pasó por él (`/v1/device/list`, `/v1/pair/pending`), y ninguno de los dos cambia al mudarse.
// Con una licencia propia y esos dos datos, el dueño de otro negocio movía a su tenant la fila de
// una Handy ajena, canjeaba sobre una Main ajena llevándose su DEK, o movía esa Main con el código
// que le llega a él y se quedaba con su siguiente renovación.
//
// Cada caso reproduce lo que haría ese dueño —sin firma, o firmando con una clave suya— y fija que
// sale con un 401 antes de que la ruta lea una sola fila. Y que el equipo de verdad, que firma con
// la suya, sigue entrando. Los emparejamientos de la víctima van por el camino real, con sus firmas.
// El aprovisionamiento de la base del negocio y el correo se sustituyen.
//
// La firma sólo prueba la clave que se presenta, así que aquí se fija también lo que la rodea: una
// fila sin clave registrada no se da por buena con la que llegue, un rechazo por la clave no deja
// nada hecho, el canje va atado al negocio que el equipo dice tener, y qué pasa al repetir una
// activación ya aceptada mientras su firma sigue en hora (FABLE-E).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as ed from "@noble/ed25519";

import vectorJson from "../../../crates/tpv-infra-licensing/src/firma_activacion_casos.json?raw";
import { activacionFirmada, firmarActivacion, mensajeDeActivacion, parDeClaves, parDeSemilla } from "./helpers/activar";
import { clienteSobre } from "./helpers/clienteSql";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

/** La conexión del test en curso; la lee el `getDb` simulado. */
let clienteActual: any = null;
/** Bases de tenant que se han llegado a aprovisionar (en producción, la de su TenantHub). */
let basesCreadas: string[] = [];
/** Correos que habría mandado el worker. */
let correos: Array<{ to: string; subject: string; text: string }> = [];
/** Lo que la ruta deja en `waitUntil` (los correos). */
let pendientes: Promise<unknown>[] = [];

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () => clienteActual,
}));

vi.mock("../src/domains/licensing/licensing.helpers", async (original) => ({
	...(await (original as any)()),
	provisionTenantDatabase: async (_db: any, _env: any, tenantId: string) => {
		basesCreadas.push(tenantId);
	},
}));

const { licenseRoutes } = await import("../src/domains/licensing/licensing.routes");
const { verificarFirmaDeActivacion } = await import("../src/domains/licensing/licensing.helpers");
const { generateLicenseKey, licenseKeyHash } = await import("../src/domains/licensing/licenseKey");
const { getLicenseById } = await import("../src/server/licenseStore");
const { cifrar } = await import("../src/server/crypto");
const { cargarDevice } = await import("../src/lib/deviceAuth");
const { MENSAJES } = await import("../src/lib/errorCodes");
const { completarErrores } = await import("../src/middleware/completarErrores");
const { verifyDeviceProofOrThrow } = await import("../src/server/middleware/auth");
const { firmarSesion, leerClaimsSinVerificar } = await import("../src/lib/sesion");
const { listarDispositivos } = await import("../src/domains/pairing/dispositivos");
const { crearCodigo, aprobarSolicitud, solicitudesPendientes } = await import(
	"../src/domains/pairing/pairing.main"
);
const { reclamarCodigo, entregarToken } = await import("../src/domains/pairing/pairing.handy");
const { mensajeFirmado } = await import("../src/domains/pairing/pairing.firma");
const { b64ToBytes, bytesToB64 } = await import("../src/server/utils/base64");
const { sha256HexBytes, sha256HexStr } = await import("../src/server/utils/crypto");

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_STORE_KEY: STORE_KEY,
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
	TURSO_DATABASE_URL: "libsql://pruebas",
	TURSO_AUTH_TOKEN: "t",
	EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
	PAIR_PEPPER: "pimienta-de-pruebas",
	EMAIL: {
		send: async (m: any) => {
			correos.push({ to: String(m.to), subject: String(m.subject), text: String(m.text) });
		},
	},
} as any;
const CTX = {
	waitUntil: (p: Promise<unknown>) => {
		pendientes.push(p);
	},
	passThroughOnException: () => {},
	props: {},
} as any;

const DIA = 24 * 60 * 60 * 1000;
const MINUTO = 60 * 1000;
const IP = "203.0.113.7";

const TABLAS = [
	"licenses",
	"license_payments",
	"license_device_otp",
	"license_device_swaps",
	"license_otp_eventos",
	"pair_requests",
	"device_challenges",
	"pair_claim_fallos",
	"devices",
	"tenants",
];

type Par = { seed: Uint8Array; pub: string };

async function firmar(mensaje: string, seed: Uint8Array): Promise<string> {
	ensureEd25519Sha512();
	return bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));
}

type Negocio = {
	tenantId: string;
	licenseId: string;
	clave: string;
	licHash: string;
	mainId: string;
	main: Par;
	email: string;
	dek: string;
};

type Ctx = { sql: any; db: any };

/** Un negocio con su licencia viva, su Main dada de alta y su DEK guardada (cifrada). */
async function negocio(
	{ sql }: Ctx,
	args: { nombre: string; relleno: number; email: string; diasRestantes: number },
): Promise<Negocio> {
	const tenantId = `tenant-${args.nombre}`;
	const licenseId = `lic-${args.nombre}`;
	const mainId = `main-${args.nombre}`;
	const main = await parDeClaves(args.relleno);
	const dek = btoa(String.fromCharCode(...new Uint8Array(32).fill(args.relleno + 100)));
	const clave = generateLicenseKey();
	const licHash = await licenseKeyHash(clave);
	const ahora = Date.now();

	sql.exec(
		`INSERT INTO tenants (tenant_id, status, field_dek) VALUES (?, 'active', ?);`,
		tenantId,
		await cifrar(STORE_KEY, dek),
	);
	sql.exec(
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, disabled,
		   plan, term_months, origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email,
		   created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, 'active', 0, 'standard', 12, 'stripe', ?, ?, ?, ?, ?, ?);`,
		licenseId,
		licHash,
		tenantId,
		mainId,
		ahora - 300 * DIA,
		ahora - 300 * DIA,
		ahora + args.diasRestantes * DIA,
		args.email,
		ahora,
		ahora,
	);
	sql.exec(
		`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
		 VALUES (?, ?, 'tpv', ?, 'ed25519');`,
		mainId,
		tenantId,
		main.pub,
	);
	return { tenantId, licenseId, clave, licHash, mainId, main, email: args.email, dek };
}

/** La víctima, a la que le quedan pocos días, y el atacante, cuya licencia vence mucho después. */
async function dosNegocios(c: Ctx) {
	const victima = await negocio(c, {
		nombre: "victima",
		relleno: 0x11,
		email: "dueno@bar-victima.test",
		diasRestantes: 20,
	});
	const atacante = await negocio(c, {
		nombre: "atacante",
		relleno: 0x12,
		email: "malo@bar-atacante.test",
		diasRestantes: 300,
	});
	return { victima, atacante };
}

/** Una clave sin estrenar comprada con el correo indicado. */
async function emitir({ sql }: Ctx, email: string, id: string, meses = 12) {
	const clave = generateLicenseKey();
	sql.exec(
		`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months, origin,
		   issued_at_ms, customer_email, created_at_ms, updated_at_ms)
		 VALUES (?, ?, 'issued', 0, 'standard', ?, 'stripe', ?, ?, ?, ?);`,
		id,
		await licenseKeyHash(clave),
		meses,
		Date.now(),
		email,
		Date.now(),
		Date.now(),
	);
	return { clave, id };
}

function fila({ sql }: Ctx, deviceId: string) {
	return sql
		.exec(
			`SELECT tenant_id, role, revoked_at_ms, device_pubkey_b64 FROM devices WHERE device_id = ?;`,
			deviceId,
		)
		.toArray()[0];
}

function contar({ sql }: Ctx, tabla: string, donde = "1=1"): number {
	return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${donde};`).toArray()[0].n);
}

/** Manda a `/activate` una petición ya montada (`activacionFirmada`) y espera a sus correos. */
async function enviar(peticion: RequestInit, rutas: { request: typeof licenseRoutes.request } = licenseRoutes, ruta = "/activate") {
	const res = await rutas.request(ruta, peticion, ENV, CTX);
	const body = (await res.json().catch(() => null)) as any;
	await Promise.all(pendientes.splice(0));
	return { status: res.status, body };
}

/** El equipo de verdad: firma con la clave privada de la clave pública que presenta. */
async function activar(datos: Record<string, unknown>) {
	return enviar(await activacionFirmada(datos));
}

/** `POST /v1/license/device-change/request` y el código que llega al correo de la licencia. */
async function pedirCodigo(clave: string, deviceId: string) {
	const antes = correos.length;
	await licenseRoutes.request(
		"/device-change/request",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ activationKey: clave, deviceId }),
		},
		ENV,
		CTX,
	);
	await Promise.all(pendientes.splice(0));
	const correo = correos.slice(antes).find((m) => /otro equipo/.test(m.subject));
	return { para: correo?.to ?? null, codigo: correo?.text.match(/\b(\d{6})\b/)?.[1] ?? null };
}

/** `/status` o `/refresh` firmados como `sign_device_proof` del cliente Rust. */
async function conPrueba(metodo: "GET" | "POST", ruta: "/status" | "/refresh", token: string, seed: Uint8Array) {
	const ts = Date.now();
	const mensaje = [
		"DEVICE_PROOF",
		ts,
		metodo,
		ruta,
		await sha256HexStr(token),
		await sha256HexBytes(new Uint8Array()),
	].join("\n");
	const res = await licenseRoutes.request(
		ruta,
		{
			method: metodo,
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(ts),
				"X-Device-Sig": await firmar(mensaje, seed),
			},
		},
		ENV,
		CTX,
	);
	return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** Lo que comprueba `tenantAuth` en todas las rutas de negocio, con una petición bien firmada. */
async function pasaTenantAuth(tenantId: string, deviceId: string, licHash: string, seed: Uint8Array) {
	const token = await firmarSesion(ENV, { tenantId, deviceId, licHash });
	const ts = Date.now();
	const ruta = "/v1/sync/lo-que-sea";
	const mensaje = `DEVICE_PROOF\n${ts}\nGET\n${ruta}\n${await sha256HexStr(token)}\n${await sha256HexBytes(new Uint8Array())}`;
	const req = new Request(`https://tpv.test${ruta}`, {
		headers: { "X-Device-Ts": String(ts), "X-Device-Sig": await firmar(mensaje, seed) },
	});
	await verifyDeviceProofOrThrow(req, clienteActual, { tenantId, deviceId }, token, new Uint8Array());
}

/**
 * Vincula un equipo como Handy de un negocio por el camino real: la Main crea el código, la Handy lo
 * reclama, la Main aprueba y la Handy recoge el token firmando el reto con SU clave.
 */
async function vincularComoHandy({ db }: Ctx, n: Negocio, deviceId: string, clave: Par) {
	const ahora = Date.now();
	const creado = await crearCodigo(db, ENV, n.tenantId, n.mainId, ahora);
	const pairCode = String(creado.cuerpo.pairCode);
	const reclamo = await reclamarCodigo(
		db,
		ENV,
		{ pairCode, pairSecret: "", deviceId, devicePubKey: clave.pub, deviceName: "Tablet" },
		IP,
		ahora,
	);
	expect(reclamo.status).toBe(200);
	expect((await aprobarSolicitud(db, n.tenantId, pairCode, ahora)).status).toBe(200);
	const nonceB64 = String(reclamo.cuerpo.nonceB64);
	const ts = Date.now();
	const sigB64 = await firmar(mensajeFirmado("PAIR_FETCH", ts, pairCode, nonceB64, deviceId), clave.seed);
	return entregarToken(db, ENV, { pairCode, deviceId, nonceB64, sigB64, ts }, Date.now());
}

async function escenario<T>(nombre: string, fn: (c: Ctx) => Promise<T>): Promise<T> {
	return enElHub(`aud01-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		for (const t of TABLAS) sql.exec(`DELETE FROM ${t};`);
		clienteActual = db;
		try {
			return await fn({ sql, db });
		} finally {
			for (const t of TABLAS) sql.exec(`DELETE FROM ${t};`);
		}
	});
}

beforeEach(() => {
	clienteActual = null;
	basesCreadas = [];
	correos = [];
	pendientes = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AUD-01 · la Handy de otro negocio", () => {
	it("con su device_id y su clave pública, pero sin su firma, no se la lleva nadie", async () => {
		await escenario("handy", async (c) => {
			const { victima, atacante } = await dosNegocios(c);
			const HANDY = "handy-de-un-camarero";
			const handy = await parDeClaves(0x13);

			// La Handy pasó por el negocio del atacante (vinculada de verdad) y su Main la lista con
			// su clave pública: es lo que el atacante se apunta. Después se muda al bar víctima.
			expect((await vincularComoHandy(c, atacante, HANDY, handy)).status).toBe(200);
			const lista = await listarDispositivos(c.db, atacante.tenantId);
			const apuntada = (lista.cuerpo.items as any[]).find((i) => i.deviceId === HANDY);
			expect(apuntada.devicePubKeyB64).toBe(handy.pub);
			expect((await vincularComoHandy(c, victima, HANDY, handy)).status).toBe(200);
			const enSuSitio = { tenant_id: victima.tenantId, role: "handy", revoked_at_ms: null, device_pubkey_b64: handy.pub };
			expect(fila(c, HANDY)).toEqual(enSuSitio);

			const tokenHandy = await firmarSesion(ENV, {
				tenantId: victima.tenantId,
				deviceId: HANDY,
				licHash: victima.licHash,
			});
			const negocios = contar(c, "tenants");

			// El atacante: una clave suya sin estrenar y lo apuntado. Sin firma, y firmando con la
			// única clave privada que tiene, la de su Main.
			const k = await emitir(c, atacante.email, "lic-clave-del-atacante");
			const datos = { activationKey: k.clave, deviceId: HANDY, devicePubKey: apuntada.devicePubKeyB64 };

			const sinFirma = await enviar(await activacionFirmada(datos, { sinFirma: true }));
			expect(sinFirma.status).toBe(401);
			expect(sinFirma.body.error).toBe("missing_device_proof");

			const conOtraClave = await enviar(await activacionFirmada(datos, { firmarCon: atacante.main.seed }));
			expect(conOtraClave.status).toBe(401);
			expect(conOtraClave.body.error).toBe("bad_device_signature");

			for (const r of [sinFirma, conOtraClave]) {
				expect(r.body.token).toBeUndefined();
				expect(r.body.fieldDek).toBeUndefined();
				expect(r.body.tenantId).toBeUndefined();
			}
			// La fila no se ha movido y la Handy sigue trabajando en su negocio…
			expect(fila(c, HANDY)).toEqual(enSuSitio);
			expect(await cargarDevice(c.db, victima.tenantId, HANDY)).not.toBeNull();
			await expect(pasaTenantAuth(victima.tenantId, HANDY, victima.licHash, handy.seed)).resolves.toBeUndefined();
			expect((await conPrueba("POST", "/refresh", tokenHandy, handy.seed)).status).toBe(200);
			// …y la clave del atacante sigue sin estrenar: ni negocio ni base nuevos.
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", main_device_id: null, tenant_id: null });
			expect(contar(c, "tenants")).toBe(negocios);
			expect(basesCreadas).toEqual([]);
			expect(correos).toEqual([]);
		});
	});

	it("mudarse sigue siendo cosa del propio equipo: firmando con su clave, activa", async () => {
		await escenario("handy-propia", async (c) => {
			const { victima } = await dosNegocios(c);
			const TABLET = "tablet-que-pasa-a-ser-main";
			const tablet = await parDeClaves(0x14);
			expect((await vincularComoHandy(c, victima, TABLET, tablet)).status).toBe(200);

			// Su dueño compra una licencia y la activa en ella: la misma petición, firmada por el equipo.
			const k = await emitir(c, "otro@bar-nuevo.test", "lic-de-la-tablet");
			const r = await activar({ activationKey: k.clave, deviceId: TABLET, devicePubKey: tablet.pub });

			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(false);
			expect(fila(c, TABLET)).toEqual({
				tenant_id: r.body.tenantId,
				role: "tpv",
				revoked_at_ms: null,
				device_pubkey_b64: tablet.pub,
			});
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "active", main_device_id: TABLET });
			expect(basesCreadas).toEqual([r.body.tenantId]);
		});
	});
});

describe("AUD-01 · canje sobre la Main de otro negocio", () => {
	it("una clave sin estrenar no devuelve la DEK ni suma nada sin la firma de esa Main", async () => {
		await escenario("canje", async (c) => {
			const { victima, atacante } = await dosNegocios(c);

			// La Main víctima reclamó un código del negocio atacante (sin llegar a aprobarse): su Main
			// ve el device_id y la clave pública en `/v1/pair/pending`.
			const codigo = await crearCodigo(c.db, ENV, atacante.tenantId, atacante.mainId, Date.now());
			const reclamo = await reclamarCodigo(
				c.db,
				ENV,
				{
					pairCode: String(codigo.cuerpo.pairCode),
					pairSecret: "",
					deviceId: victima.mainId,
					devicePubKey: victima.main.pub,
					deviceName: "PC de la barra",
				},
				IP,
				Date.now(),
			);
			expect(reclamo.status).toBe(200);
			const pendiente = (await solicitudesPendientes(c.db, atacante.tenantId, Date.now())).cuerpo.items as any[];
			expect(pendiente[0]).toMatchObject({
				claimedDeviceId: victima.mainId,
				claimedDevicePubKeyB64: victima.main.pub,
			});
			const antes = await getLicenseById(c.db, victima.licenseId);

			const k = await emitir(c, atacante.email, "lic-clave-del-atacante");
			const datos = {
				activationKey: k.clave,
				deviceId: pendiente[0].claimedDeviceId,
				devicePubKey: pendiente[0].claimedDevicePubKeyB64,
			};

			const sinFirma = await enviar(await activacionFirmada(datos, { sinFirma: true }));
			const conOtraClave = await enviar(await activacionFirmada(datos, { firmarCon: atacante.main.seed }));
			expect([sinFirma.status, sinFirma.body.error]).toEqual([401, "missing_device_proof"]);
			expect([conOtraClave.status, conOtraClave.body.error]).toEqual([401, "bad_device_signature"]);

			for (const r of [sinFirma, conOtraClave]) {
				expect(r.body.fieldDek).toBeUndefined();
				expect(r.body.token).toBeUndefined();
				expect(r.body.tenantId).toBeUndefined();
			}
			// Ni meses a la víctima, ni clave gastada, ni recibo.
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(antes!.expires_at_ms);
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", redeemed_into_license_id: null });
			expect(correos).toEqual([]);
		});
	});

	it("la Main de verdad, que firma con su clave, sigue canjeando y recibe su DEK", async () => {
		await escenario("canje-propio", async (c) => {
			const { victima } = await dosNegocios(c);
			const antes = await getLicenseById(c.db, victima.licenseId);

			const renovacion = await emitir(c, victima.email, "lic-renovacion");
			const r = await activar({
				activationKey: renovacion.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
				soloSumar: true,
			});

			expect(r.status).toBe(200);
			expect(r.body.tiempoSumado).toBe(true);
			expect(r.body.tenantId).toBe(victima.tenantId);
			expect(r.body.fieldDek).toBe(victima.dek);
			expect(leerClaimsSinVerificar(r.body.token)).toEqual({
				tenantId: victima.tenantId,
				deviceId: victima.mainId,
				licHash: victima.licHash,
			});
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms!).toBeGreaterThan(
				antes!.expires_at_ms! + 350 * DIA,
			);
			expect(correos.map((m) => [m.to, m.subject])).toEqual([[victima.email, "Licencia renovada"]]);
		});
	});
});

describe("AUD-01 · la Main de otro negocio", () => {
	it("con su licencia y el código que le llega a él, el atacante no la mueve ni gasta intentos", async () => {
		await escenario("main", async (c) => {
			const { victima, atacante } = await dosNegocios(c);
			const datos = { activationKey: atacante.clave, deviceId: victima.mainId, devicePubKey: victima.main.pub };
			const enSuSitio = { tenant_id: victima.tenantId, role: "tpv", revoked_at_ms: null, device_pubkey_b64: victima.main.pub };

			// Sin firma no llega ni a saber que hace falta un código: no hay pista del correo.
			const sinCodigo = await enviar(await activacionFirmada(datos, { sinFirma: true }));
			expect([sinCodigo.status, sinCodigo.body.error]).toEqual([401, "missing_device_proof"]);
			expect(sinCodigo.body.details).toBeUndefined();

			// El código se lo manda a sí mismo: pedirlo no mueve nada.
			const { para, codigo } = await pedirCodigo(atacante.clave, victima.mainId);
			expect(para).toBe(atacante.email);
			expect(codigo).toMatch(/^\d{6}$/);

			// Con el código bueno y con uno malo, firmando con su propia clave.
			const firmaSuya = { firmarCon: atacante.main.seed };
			const conCodigo = await enviar(await activacionFirmada({ ...datos, deviceChangeCode: codigo }, firmaSuya));
			const conOtroCodigo = await enviar(
				await activacionFirmada({ ...datos, deviceChangeCode: codigo === "000000" ? "000001" : "000000" }, firmaSuya),
			);
			expect([conCodigo.status, conCodigo.body.error]).toEqual([401, "bad_device_signature"]);
			expect([conOtroCodigo.status, conOtroCodigo.body.error]).toEqual([401, "bad_device_signature"]);

			// La fila sigue en su negocio, la licencia del atacante en su equipo…
			expect(fila(c, victima.mainId)).toEqual(enSuSitio);
			expect((await getLicenseById(c.db, atacante.licenseId))!.main_device_id).toBe(atacante.mainId);
			expect(contar(c, "license_device_swaps")).toBe(0);
			await expect(
				pasaTenantAuth(victima.tenantId, victima.mainId, victima.licHash, victima.main.seed),
			).resolves.toBeUndefined();
			// …y el código, sin gastar y sin un solo intento anotado: ni el suyo ni el de la licencia.
			const otp = c.sql
				.exec(`SELECT attempts, consumed_at_ms FROM license_device_otp WHERE license_id = ?;`, atacante.licenseId)
				.toArray();
			expect(otp).toEqual([{ attempts: 0, consumed_at_ms: null }]);
			expect(contar(c, "license_otp_eventos", "tipo = 'fallo'")).toBe(0);
			// A nadie se le avisa de un traslado que no ha ocurrido.
			expect(correos.filter((m) => !/otro equipo/.test(m.subject))).toEqual([]);
		});
	});

	it("y la renovación de la víctima va a su licencia y le devuelve su negocio", async () => {
		await escenario("renovacion", async (c) => {
			const { victima, atacante } = await dosNegocios(c);

			// El intento de traslado de antes, completo, y rechazado.
			const { codigo } = await pedirCodigo(atacante.clave, victima.mainId);
			const traslado = await enviar(
				await activacionFirmada(
					{
						activationKey: atacante.clave,
						deviceId: victima.mainId,
						devicePubKey: victima.main.pub,
						deviceChangeCode: codigo,
					},
					{ firmarCon: atacante.main.seed },
				),
			);
			expect(traslado.status).toBe(401);
			const licAtacanteAntes = await getLicenseById(c.db, atacante.licenseId);
			const licVictimaAntes = await getLicenseById(c.db, victima.licenseId);
			correos = [];

			// La víctima compra su renovación y la teclea en Configuración → Licencia.
			const renovacion = await emitir(c, victima.email, "lic-renovacion-de-la-victima");
			const r = await activar({
				activationKey: renovacion.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
				soloSumar: true,
			});

			expect(r.status).toBe(200);
			expect(r.body.tenantId).toBe(victima.tenantId);
			expect(r.body.fieldDek).toBe(victima.dek);
			expect(await getLicenseById(c.db, renovacion.id)).toMatchObject({
				status: "redeemed",
				redeemed_into_license_id: victima.licenseId,
			});
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms!).toBeGreaterThan(
				licVictimaAntes!.expires_at_ms! + 350 * DIA,
			);
			expect((await getLicenseById(c.db, atacante.licenseId))!.expires_at_ms).toBe(licAtacanteAntes!.expires_at_ms);
			expect(correos.map((m) => [m.to, m.subject])).toEqual([[victima.email, "Licencia renovada"]]);

			// Y su siguiente `/status` firmado la deja donde estaba: Main de su negocio.
			const st = await conPrueba("GET", "/status", r.body.token, victima.main.seed);
			expect(st.status).toBe(200);
			expect(st.body.assertion).toMatchObject({ tenantId: victima.tenantId, state: "active" });
		});
	});

	it("el traslado de verdad, firmado por el equipo que recibe la licencia, sigue entrando", async () => {
		await escenario("traslado", async (c) => {
			const { atacante: dueno } = await dosNegocios(c);
			const NUEVO = "pc-nuevo-de-la-barra";
			const nuevo = await parDeClaves(0x15);
			const datos = { activationKey: dueno.clave, deviceId: NUEVO, devicePubKey: nuevo.pub };

			const sinCodigo = await activar(datos);
			expect([sinCodigo.status, sinCodigo.body.error]).toEqual([409, "device_change_required"]);
			expect(sinCodigo.body.details.emailHint).toBe("m***@bar-atacante.test");

			const { codigo } = await pedirCodigo(dueno.clave, NUEVO);
			const r = await activar({ ...datos, deviceChangeCode: codigo });

			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
			expect(r.body.tenantId).toBe(dueno.tenantId);
			expect(r.body.fieldDek).toBe(dueno.dek);
			expect((await getLicenseById(c.db, dueno.licenseId))!.main_device_id).toBe(NUEVO);
			expect(fila(c, NUEVO)).toMatchObject({ tenant_id: dueno.tenantId, role: "tpv", device_pubkey_b64: nuevo.pub });
		});
	});
});

describe("AUD-01 · un equipo registrado sin clave no se da por bueno con la que llegue", () => {
	// La firma sólo prueba que se tiene la clave que se presenta. Si la fila del equipo no tiene
	// ninguna registrada con la que compararla, darla por buena sería dejar que el primero que firme
	// se quede con ese equipo. Las dos formas en que una columna puede estar «sin clave»:
	const SIN_CLAVE = [
		{ como: "NULL", valor: null, id: "null" },
		{ como: "cadena vacía", valor: "", id: "vacia" },
	] as const;

	it.each(SIN_CLAVE)("canje sobre una Main con la clave en $como: 409 sin DEK y sin gastar nada", async ({ valor, id }) => {
		await escenario(`sin-clave-canje-${id}`, async (c) => {
			const { victima, atacante } = await dosNegocios(c);
			c.sql.exec(`UPDATE devices SET device_pubkey_b64 = ? WHERE device_id = ?;`, valor, victima.mainId);
			const antes = await getLicenseById(c.db, victima.licenseId);
			const k = await emitir(c, atacante.email, "lic-clave-del-atacante");

			// El atacante presenta SU clave y firma con ella: la firma es buena.
			const r = await activar({ activationKey: k.clave, deviceId: victima.mainId, devicePubKey: atacante.main.pub });
			expect([r.status, r.body.error]).toEqual([409, "device_key_missing"]);
			expect(r.body.fieldDek).toBeUndefined();
			expect(r.body.token).toBeUndefined();
			expect(r.body.tenantId).toBeUndefined();

			// Y el propio equipo tampoco entra así: no hay con qué comprobar que es él.
			const propio = await activar({
				activationKey: k.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
				soloSumar: true,
			});
			expect([propio.status, propio.body.error]).toEqual([409, "device_key_missing"]);

			// Ni clave gastada, ni meses, ni recibo; y la fila sigue como estaba, sin clave.
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", redeemed_into_license_id: null });
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(antes!.expires_at_ms);
			expect(fila(c, victima.mainId)).toEqual({
				tenant_id: victima.tenantId,
				role: "tpv",
				revoked_at_ms: null,
				device_pubkey_b64: valor,
			});
			expect(correos).toEqual([]);
		});
	});

	it("canje sobre una Main que no tiene fila: tampoco", async () => {
		await escenario("sin-fila-canje", async (c) => {
			const { victima, atacante } = await dosNegocios(c);
			c.sql.exec(`DELETE FROM devices WHERE device_id = ?;`, victima.mainId);
			const antes = await getLicenseById(c.db, victima.licenseId);
			const k = await emitir(c, atacante.email, "lic-clave-del-atacante");

			for (const extra of [{}, { soloSumar: true }]) {
				const r = await activar({
					activationKey: k.clave,
					deviceId: victima.mainId,
					devicePubKey: atacante.main.pub,
					...extra,
				});
				expect([r.status, r.body.error], JSON.stringify(extra)).toEqual([409, "device_key_missing"]);
				expect(r.body.fieldDek).toBeUndefined();
				expect(r.body.token).toBeUndefined();
			}

			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", redeemed_into_license_id: null });
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(antes!.expires_at_ms);
			expect(fila(c, victima.mainId)).toBeUndefined();
			expect(basesCreadas).toEqual([]);
		});
	});

	it("y a quien le pasa se le dice qué hacer: contactar con soporte", async () => {
		await escenario("sin-clave-frase", async (c) => {
			const { victima } = await dosNegocios(c);
			c.sql.exec(`UPDATE devices SET device_pubkey_b64 = NULL WHERE device_id = ?;`, victima.mainId);
			const k = await emitir(c, victima.email, "lic-renovacion");
			const app = new Hono().use("*", completarErrores).route("/v1/license", licenseRoutes);

			const r = await enviar(
				await activacionFirmada({
					activationKey: k.clave,
					deviceId: victima.mainId,
					devicePubKey: victima.main.pub,
					soloSumar: true,
					tenantActual: victima.tenantId,
				}),
				app as any,
				"/v1/license/activate",
			);

			expect(r.status).toBe(409);
			expect(r.body).toMatchObject({
				error: "device_key_missing",
				code: "conflict",
				message: MENSAJES.device_key_missing,
			});
			expect(r.body.message).toMatch(/Contacta con soporte/);
		});
	});

	it.each(SIN_CLAVE)("la Handy de otro negocio con la clave en $como no se mueve, ni activando ni vinculándola", async ({ valor, id }) => {
		await escenario(`sin-clave-handy-${id}`, async (c) => {
			const { victima, atacante } = await dosNegocios(c);
			const HANDY = "handy-sin-clave";
			c.sql.exec(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64) VALUES (?, ?, 'handy', ?);`,
				HANDY,
				victima.tenantId,
				valor,
			);
			const enSuSitio = { tenant_id: victima.tenantId, role: "handy", revoked_at_ms: null, device_pubkey_b64: valor };
			const negocios = contar(c, "tenants");

			// Por la puerta de la activación, con una clave sin estrenar y firmando con la suya.
			const k = await emitir(c, atacante.email, "lic-clave-del-atacante");
			const r = await activar({ activationKey: k.clave, deviceId: HANDY, devicePubKey: atacante.main.pub });
			expect([r.status, r.body.error]).toEqual([409, "device_key_missing"]);
			expect(fila(c, HANDY)).toEqual(enSuSitio);
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", main_device_id: null, tenant_id: null });
			expect(contar(c, "tenants")).toBe(negocios);
			expect(basesCreadas).toEqual([]);

			// Por la del emparejamiento: la reclama en su negocio, la aprueba él mismo y firma el reto.
			const suya = await parDeClaves(0x41);
			const vinculada = await vincularComoHandy(c, atacante, HANDY, suya);
			expect([vinculada.status, vinculada.cuerpo.error]).toEqual([409, "device_key_missing"]);
			expect(fila(c, HANDY)).toEqual(enSuSitio);

			// La salida es la de siempre: volver a vincularla en SU negocio, que lo aprueba su dueño.
			const deVerdad = await parDeClaves(0x42);
			expect((await vincularComoHandy(c, victima, HANDY, deVerdad)).status).toBe(200);
			expect(fila(c, HANDY)).toEqual({ ...enSuSitio, device_pubkey_b64: deVerdad.pub });
		});
	});

	it("el alta escribe la fila con su clave en una sola sentencia: un corte después no la deja sin clave", async () => {
		await escenario("alta-de-una-vez", async (c) => {
			const equipo = await parDeClaves(0x43);
			const k = await emitir(c, "bar@ejemplo.test", "lic-nueva");
			const datos = { activationKey: k.clave, deviceId: "equipo-nuevo", devicePubKey: equipo.pub };

			// Lo que se le manda a la base central mientras dura la activación. La activación se corta
			// justo después de dar de alta el equipo: en la primera, eso es ya con la licencia suya
			// (AUD-09), al guardar los datos del negocio.
			const sentencias: string[] = [];
			let cortar = true;
			clienteActual = {
				...c.db,
				execute: async (q: any) => {
					const texto = String(typeof q === "string" ? q : q.sql);
					sentencias.push(texto);
					if (cortar && /UPDATE tenants\s+SET display_name/.test(texto)) throw new Error("corte_simulado");
					return c.db.execute(q);
				},
			};

			const cortada = await activar(datos);
			expect(cortada.status).toBe(500);
			cortar = false;

			const escrituras = sentencias.filter((s) => /\b(INSERT INTO|UPDATE)\s+devices\b/i.test(s));
			expect(escrituras).toHaveLength(1);
			expect(escrituras[0]).toContain("device_pubkey_b64");
			expect(fila(c, "equipo-nuevo")).toMatchObject({ role: "tpv", device_pubkey_b64: equipo.pub });

			// Con la fila a medias, otro no se la queda firmando con su clave…
			const otro = await parDeClaves(0x44);
			const ajeno = await activar({ ...datos, devicePubKey: otro.pub });
			expect([ajeno.status, ajeno.body.error]).toEqual([409, "device_key_mismatch"]);

			// …y el reintento del equipo entra.
			const bien = await activar(datos);
			expect(bien.status).toBe(200);
			expect(fila(c, "equipo-nuevo")).toEqual({
				tenant_id: bien.body.tenantId,
				role: "tpv",
				revoked_at_ms: null,
				device_pubkey_b64: equipo.pub,
			});
		});
	});
});

describe("AUD-01 · un rechazo por la clave no deja nada hecho", () => {
	it("traslado hacia una Handy del propio negocio con otra clave: ni rol, ni revocación, ni código", async () => {
		await escenario("handy-propia-otra-clave", async (c) => {
			const { atacante: dueno } = await dosNegocios(c);
			const HANDY = "handy-del-negocio";
			const handy = await parDeClaves(0x51);
			expect((await vincularComoHandy(c, dueno, HANDY, handy)).status).toBe(200);
			// Dada de baja después, como una tablet que se retiró.
			c.sql.exec(`UPDATE devices SET revoked_at_ms = 1700000000000 WHERE device_id = ?;`, HANDY);
			const antes = fila(c, HANDY);
			expect(antes).toEqual({
				tenant_id: dueno.tenantId,
				role: "handy",
				revoked_at_ms: 1700000000000,
				device_pubkey_b64: handy.pub,
			});

			// Con la licencia y el código buenos, pero presentando (y firmando con) otra clave.
			const { codigo } = await pedirCodigo(dueno.clave, HANDY);
			expect(codigo).toMatch(/^\d{6}$/);
			const otra = await parDeClaves(0x52);
			const datos = { activationKey: dueno.clave, deviceId: HANDY, deviceChangeCode: codigo };
			const r = await activar({ ...datos, devicePubKey: otra.pub });

			expect([r.status, r.body.error]).toEqual([409, "device_key_mismatch"]);
			// La Handy sigue siendo una Handy dada de baja…
			expect(fila(c, HANDY)).toEqual(antes);
			// …el código, sin gastar y sin intentos…
			expect(
				c.sql
					.exec(`SELECT attempts, consumed_at_ms FROM license_device_otp WHERE license_id = ?;`, dueno.licenseId)
					.toArray(),
			).toEqual([{ attempts: 0, consumed_at_ms: null }]);
			expect(contar(c, "license_otp_eventos", "tipo = 'fallo'")).toBe(0);
			// …y la licencia, en su equipo.
			expect((await getLicenseById(c.db, dueno.licenseId))!.main_device_id).toBe(dueno.mainId);
			expect(contar(c, "license_device_swaps")).toBe(0);

			// Con su clave de verdad y ese mismo código, que sigue vivo, el traslado entra.
			const bien = await activar({ ...datos, devicePubKey: handy.pub });
			expect(bien.status).toBe(200);
			expect(bien.body.cambioDeEquipo).toBe(true);
			expect(fila(c, HANDY)).toEqual({ ...antes, role: "tpv", revoked_at_ms: null });
			expect((await getLicenseById(c.db, dueno.licenseId))!.main_device_id).toBe(HANDY);
		});
	});
});

describe("AUD-01 · el canje va atado al negocio que el equipo ya tiene", () => {
	/**
	 * La Main de la víctima es también el `main_device_id` de una licencia viva de otro negocio, que
	 * vence más tarde: lo que dejaba el traslado sin firma de antes, o un equipo con dos licencias.
	 */
	async function conDosLicenciasSobreElEquipo(c: Ctx) {
		const { victima, atacante: otro } = await dosNegocios(c);
		c.sql.exec(`UPDATE licenses SET main_device_id = ? WHERE license_id = ?;`, victima.mainId, otro.licenseId);
		return { victima, otro };
	}

	it("diciendo cuál es su negocio, la renovación va a su licencia y no a la que más tarde caduca", async () => {
		await escenario("dos-licencias", async (c) => {
			const { victima, otro } = await conDosLicenciasSobreElEquipo(c);
			const antes = await getLicenseById(c.db, victima.licenseId);
			const otraAntes = await getLicenseById(c.db, otro.licenseId);

			const renovacion = await emitir(c, victima.email, "lic-renovacion");
			const r = await activar({
				activationKey: renovacion.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
				soloSumar: true,
				tenantActual: victima.tenantId,
			});

			expect(r.status).toBe(200);
			expect(r.body.tiempoSumado).toBe(true);
			expect(r.body.tenantId).toBe(victima.tenantId);
			expect(r.body.fieldDek).toBe(victima.dek);
			expect(leerClaimsSinVerificar(r.body.token)).toEqual({
				tenantId: victima.tenantId,
				deviceId: victima.mainId,
				licHash: victima.licHash,
			});
			expect(await getLicenseById(c.db, renovacion.id)).toMatchObject({
				status: "redeemed",
				redeemed_into_license_id: victima.licenseId,
			});
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms!).toBeGreaterThan(
				antes!.expires_at_ms! + 350 * DIA,
			);
			expect((await getLicenseById(c.db, otro.licenseId))!.expires_at_ms).toBe(otraAntes!.expires_at_ms);
			expect(correos.map((m) => [m.to, m.subject])).toEqual([[victima.email, "Licencia renovada"]]);
		});
	});

	it("si en su negocio no tiene licencia viva, no se suma a la de otro", async () => {
		await escenario("dos-licencias-sin-la-suya", async (c) => {
			const { victima, otro } = await conDosLicenciasSobreElEquipo(c);
			// La suya está anulada: la única viva que apunta al equipo es la del otro negocio.
			c.sql.exec(`UPDATE licenses SET status = 'revoked' WHERE license_id = ?;`, victima.licenseId);
			const otraAntes = await getLicenseById(c.db, otro.licenseId);
			const k = await emitir(c, victima.email, "lic-nueva");
			const datos = {
				activationKey: k.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
				tenantActual: victima.tenantId,
			};

			// Desde Configuración, que sólo suma: se rechaza sin gastar la clave.
			const sumar = await activar({ ...datos, soloSumar: true });
			expect([sumar.status, sumar.body.error]).toEqual([409, "clave_no_canjeable"]);
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", redeemed_into_license_id: null });
			expect((await getLicenseById(c.db, otro.licenseId))!.expires_at_ms).toBe(otraAntes!.expires_at_ms);

			// Desde la activación, esa clave estrena su propio negocio: tampoco suma a la del otro.
			const estreno = await activar(datos);
			expect(estreno.status).toBe(200);
			expect(estreno.body.tiempoSumado).toBeUndefined();
			expect([victima.tenantId, otro.tenantId]).not.toContain(estreno.body.tenantId);
			expect(estreno.body.fieldDek).not.toBe(otro.dek);
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "active", main_device_id: victima.mainId });
			expect((await getLicenseById(c.db, otro.licenseId))!.expires_at_ms).toBe(otraAntes!.expires_at_ms);
		});
	});

	it("sin decir su negocio, suma a la del negocio en el que la nube tiene registrado al equipo", async () => {
		// Es lo que manda quien no tiene licencia guardada (la pantalla de activación). El negocio sale
		// de su fila de `devices`, no de cuál de las licencias que le apuntan caduca más tarde.
		await escenario("dos-licencias-sin-decirlo", async (c) => {
			const { victima, otro } = await conDosLicenciasSobreElEquipo(c);
			const otraAntes = await getLicenseById(c.db, otro.licenseId);
			const k = await emitir(c, victima.email, "lic-nueva");

			const r = await activar({ activationKey: k.clave, deviceId: victima.mainId, devicePubKey: victima.main.pub });

			expect(r.status).toBe(200);
			expect(r.body.tiempoSumado).toBe(true);
			expect(r.body.tenantId).toBe(victima.tenantId);
			expect(r.body.fieldDek).toBe(victima.dek);
			expect(await getLicenseById(c.db, k.id)).toMatchObject({ redeemed_into_license_id: victima.licenseId });
			expect((await getLicenseById(c.db, otro.licenseId))!.expires_at_ms).toBe(otraAntes!.expires_at_ms);
		});
	});

	it("si dice otro negocio que el registrado para el equipo, no canjea sobre él ni recibe su DEK", async () => {
		// Las dos licencias apuntan al equipo, y la petición va bien firmada por él. Lo que decide de
		// qué negocio es el equipo es su fila de `devices`, no lo que la petición diga.
		await escenario("dos-licencias-otro-negocio", async (c) => {
			const { victima, otro } = await conDosLicenciasSobreElEquipo(c);
			const antes = await getLicenseById(c.db, victima.licenseId);
			const otraAntes = await getLicenseById(c.db, otro.licenseId);
			const k = await emitir(c, victima.email, "lic-nueva");

			for (const extra of [{ soloSumar: true }, {}]) {
				const r = await activar({
					activationKey: k.clave,
					deviceId: victima.mainId,
					devicePubKey: victima.main.pub,
					tenantActual: otro.tenantId,
					...extra,
				});
				expect([r.status, r.body.error], JSON.stringify(extra)).toEqual([409, "device_tenant_mismatch"]);
				expect(r.body.fieldDek).toBeUndefined();
				expect(r.body.token).toBeUndefined();
				expect(r.body.tenantId).toBeUndefined();
			}

			expect(await getLicenseById(c.db, k.id)).toMatchObject({ status: "issued", redeemed_into_license_id: null });
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(antes!.expires_at_ms);
			expect((await getLicenseById(c.db, otro.licenseId))!.expires_at_ms).toBe(otraAntes!.expires_at_ms);
			expect(correos).toEqual([]);
		});
	});

	it.each([
		{ como: "anula", id: "anulada", sentencia: `UPDATE licenses SET status = 'revoked' WHERE license_id = ?;` },
		{ como: "traslada a otro equipo", id: "trasladada", sentencia: `UPDATE licenses SET main_device_id = 'otro-equipo' WHERE license_id = ?;` },
	])("si la licencia se $como justo después de elegirla, la clave no estrena otro negocio ni se gasta", async ({ id, sentencia }) => {
		// La ruta leía la licencia viva dos veces, una para el veto de `soloSumar` y otra para el
		// canje. Si cambiaba entre las dos, la segunda no la encontraba y la clave seguía hasta el
		// alta de un negocio nuevo, también con `soloSumar`.
		for (const soloSumar of [true, false]) {
			await escenario(`canje-${id}-${soloSumar ? "sumar" : "activar"}`, async (c) => {
				const { victima } = await dosNegocios(c);
				const antes = await getLicenseById(c.db, victima.licenseId);
				const k = await emitir(c, victima.email, "lic-renovacion");
				const negocios = contar(c, "tenants");

				// La licencia cambia en cuanto la ruta termina de leerla por primera vez.
				let cambiada = false;
				clienteActual = {
					...c.db,
					execute: async (q: any) => {
						const leido = await c.db.execute(q);
						const texto = String(typeof q === "string" ? q : q.sql);
						if (!cambiada && /FROM licenses\s+WHERE main_device_id = \?/.test(texto)) {
							cambiada = true;
							c.sql.exec(sentencia, victima.licenseId);
						}
						return leido;
					},
				};

				const r = await activar({
					activationKey: k.clave,
					deviceId: victima.mainId,
					devicePubKey: victima.main.pub,
					tenantActual: victima.tenantId,
					...(soloSumar ? { soloSumar: true } : {}),
				});

				expect(cambiada).toBe(true);
				expect([r.status, r.body.error]).toEqual([409, "clave_no_canjeable"]);
				expect(r.body.message).toMatch(/La clave no se ha gastado/);
				expect(r.body.token).toBeUndefined();
				expect(r.body.fieldDek).toBeUndefined();
				expect(r.body.tenantId).toBeUndefined();
				// Ni negocio nuevo, ni base, ni clave gastada, ni meses sumados, ni recibo.
				expect(contar(c, "tenants")).toBe(negocios);
				expect(basesCreadas).toEqual([]);
				expect(await getLicenseById(c.db, k.id)).toMatchObject({
					status: "issued",
					main_device_id: null,
					redeemed_into_license_id: null,
				});
				expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(antes!.expires_at_ms);
				expect(correos).toEqual([]);
			});
		}
	});
});

describe("AUD-01 · repetir una activación ya aceptada dentro del margen de la firma (FABLE-E)", () => {
	// La firma no lleva nonce: quien haya capturado una activación entera puede volver a mandarla,
	// tal cual, durante los ±2 minutos de su hora. Esto fija lo que hace esa repetición.

	it("la primera activación se vuelve a ejecutar: readmite el equipo, repone el nombre y entrega la DEK", async () => {
		await escenario("repetir-estreno", async (c) => {
			const equipo = await parDeClaves(0x61);
			const k = await emitir(c, "bar@ejemplo.test", "lic-nueva");
			const peticion = await activacionFirmada({
				activationKey: k.clave,
				deviceId: "equipo-nuevo",
				devicePubKey: equipo.pub,
				tenantInfo: { displayName: "Bar de Pruebas" },
			});

			const primera = await enviar(peticion);
			expect(primera.status).toBe(200);
			const tenantId = primera.body.tenantId as string;
			const licencia = await getLicenseById(c.db, k.id);

			// Después de activar, el equipo se da de baja y el negocio cambia de nombre.
			c.sql.exec(`UPDATE devices SET revoked_at_ms = 1700000000000 WHERE device_id = 'equipo-nuevo';`);
			c.sql.exec(`UPDATE tenants SET display_name = 'Otro nombre' WHERE tenant_id = ?;`, tenantId);

			// La misma petición, con la misma hora y la misma firma.
			const repetida = await enviar(peticion);

			expect(repetida.status).toBe(200);
			expect(repetida.body.cambioDeEquipo).toBe(false);
			// Vuelve a entregar la DEK y un token del negocio…
			expect(repetida.body.tenantId).toBe(tenantId);
			expect(repetida.body.fieldDek).toBe(primera.body.fieldDek);
			expect(leerClaimsSinVerificar(repetida.body.token)).toMatchObject({ tenantId, deviceId: "equipo-nuevo" });
			// …quita la baja del equipo y repone el nombre del negocio…
			expect(fila(c, "equipo-nuevo")).toMatchObject({ tenant_id: tenantId, role: "tpv", revoked_at_ms: null });
			expect(
				c.sql.exec(`SELECT display_name FROM tenants WHERE tenant_id = ?;`, tenantId).toArray()[0].display_name,
			).toBe("Bar de Pruebas");
			// …y vuelve a pasar por el aprovisionamiento de su base. No abre otro negocio ni mueve la
			// caducidad.
			expect(basesCreadas).toEqual([tenantId, tenantId]);
			expect(contar(c, "tenants")).toBe(1);
			expect((await getLicenseById(c.db, k.id))!.expires_at_ms).toBe(licencia!.expires_at_ms);
		});
	});

	it("el canje no suma dos veces: la repetición se queda en que la clave ya está usada", async () => {
		await escenario("repetir-canje", async (c) => {
			const { victima } = await dosNegocios(c);
			const renovacion = await emitir(c, victima.email, "lic-renovacion");
			const peticion = await activacionFirmada({
				activationKey: renovacion.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
				soloSumar: true,
				tenantActual: victima.tenantId,
			});

			expect((await enviar(peticion)).status).toBe(200);
			const sumado = (await getLicenseById(c.db, victima.licenseId))!.expires_at_ms;
			correos = [];

			const repetida = await enviar(peticion);

			expect([repetida.status, repetida.body.error]).toEqual([409, "license_already_used"]);
			expect(repetida.body.fieldDek).toBeUndefined();
			expect(repetida.body.token).toBeUndefined();
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(sumado);
			expect(correos).toEqual([]);
		});
	});

	it.each([
		{ como: "anulado", id: "anulada", sentencia: `UPDATE licenses SET status = 'revoked' WHERE license_id = ?;` },
		{ como: "trasladado a otro equipo", id: "trasladada", sentencia: `UPDATE licenses SET main_device_id = 'otro-equipo' WHERE license_id = ?;` },
	])("repetir un canje cuando la licencia que recibió el tiempo se ha $como no estrena otro negocio (AUD-07)", async ({ id, sentencia }) => {
		// Sin `soloSumar`, como lo manda la pantalla de activación. El equipo ya no tiene licencia viva
		// a la que sumar y la clave canjeada sigue con `main_device_id` a NULL: la repetición seguía
		// hasta el alta y abría un negocio nuevo con el plazo entero de una clave ya gastada.
		await escenario(`repetir-canje-${id}`, async (c) => {
			const { victima } = await dosNegocios(c);
			const renovacion = await emitir(c, victima.email, "lic-renovacion");
			const peticion = await activacionFirmada({
				activationKey: renovacion.clave,
				deviceId: victima.mainId,
				devicePubKey: victima.main.pub,
			});

			const primera = await enviar(peticion);
			expect(primera.status).toBe(200);
			expect(primera.body.tiempoSumado).toBe(true);
			const sumado = (await getLicenseById(c.db, victima.licenseId))!.expires_at_ms;

			c.sql.exec(sentencia, victima.licenseId);
			const negocios = contar(c, "tenants");
			basesCreadas = [];
			correos = [];

			// La misma petición, con la misma hora y la misma firma.
			const repetida = await enviar(peticion);

			expect([repetida.status, repetida.body.error]).toEqual([409, "license_already_used"]);
			expect(repetida.body.token).toBeUndefined();
			expect(repetida.body.fieldDek).toBeUndefined();
			expect(repetida.body.tenantId).toBeUndefined();
			// Ni negocio ni base nuevos, y la clave sigue gastada donde se gastó.
			expect(contar(c, "tenants")).toBe(negocios);
			expect(basesCreadas).toEqual([]);
			expect(await getLicenseById(c.db, renovacion.id)).toMatchObject({
				status: "redeemed",
				main_device_id: null,
				redeemed_into_license_id: victima.licenseId,
			});
			expect((await getLicenseById(c.db, victima.licenseId))!.expires_at_ms).toBe(sumado);
			expect(correos).toEqual([]);
		});
	});

	it("el traslado no se repite con su código: ya consumido, la repetición entra como el mismo equipo", async () => {
		await escenario("repetir-traslado", async (c) => {
			const { atacante: dueno } = await dosNegocios(c);
			const NUEVO = "pc-nuevo";
			const nuevo = await parDeClaves(0x62);
			const { codigo } = await pedirCodigo(dueno.clave, NUEVO);
			const peticion = await activacionFirmada({
				activationKey: dueno.clave,
				deviceId: NUEVO,
				devicePubKey: nuevo.pub,
				deviceChangeCode: codigo,
			});

			const primera = await enviar(peticion);
			expect(primera.status).toBe(200);
			expect(primera.body.cambioDeEquipo).toBe(true);

			const repetida = await enviar(peticion);

			// La licencia ya es de ese equipo, así que no es un traslado ni mira el código: contesta
			// como una reactivación, con la DEK y un token, y no anota otro cambio de equipo.
			expect(repetida.status).toBe(200);
			expect(repetida.body.cambioDeEquipo).toBe(false);
			expect(repetida.body.fieldDek).toBe(dueno.dek);
			expect(contar(c, "license_device_swaps")).toBe(1);
			expect((await getLicenseById(c.db, dueno.licenseId))!.main_device_id).toBe(NUEVO);
		});
	});
});

describe("AUD-01 · qué cubre la firma", () => {
	/** Una clave sin estrenar y un equipo nuevo que la quiere activar. */
	async function estreno(c: Ctx, relleno: number) {
		const equipo = await parDeClaves(relleno);
		const k = await emitir(c, "bar@ejemplo.test", "lic-nueva");
		return {
			equipo,
			k,
			datos: { activationKey: k.clave, deviceId: "equipo-nuevo", devicePubKey: equipo.pub } as Record<string, unknown>,
		};
	}

	async function sinEstrenar(c: Ctx, id: string) {
		expect(await getLicenseById(c.db, id)).toMatchObject({ status: "issued", main_device_id: null });
		expect(fila(c, "equipo-nuevo")).toBeUndefined();
		expect(basesCreadas).toEqual([]);
	}

	it("la hora: fuera de ±2 minutos no entra ni la firma del equipo de verdad", async () => {
		await escenario("hora", async (c) => {
			const { k, datos } = await estreno(c, 0x21);

			for (const desfase of [-3 * MINUTO, 3 * MINUTO]) {
				const r = await enviar(await activacionFirmada(datos, { ts: Date.now() + desfase }));
				expect([r.status, r.body.error], String(desfase)).toEqual([401, "device_ts_out_of_range"]);
			}
			await sinEstrenar(c, k.id);

			// Dentro del margen sí: es lo que deja activar a un reloj que va un minuto mal.
			const r = await enviar(await activacionFirmada(datos, { ts: Date.now() - MINUTO }));
			expect(r.status).toBe(200);
		});
	});

	it("el cuerpo entero: cambiar cualquier dato después de firmar la invalida", async () => {
		await escenario("cuerpo", async (c) => {
			const { k, datos } = await estreno(c, 0x22);
			const otra = await emitir(c, "bar@ejemplo.test", "lic-otra");

			for (const cambiado of [
				{ ...datos, activationKey: otra.clave },
				{ ...datos, deviceId: "otro-equipo" },
				{ ...datos, soloSumar: true },
				{ ...datos, deviceChangeCode: "123456" },
				{ ...datos, tenantInfo: { displayName: "Otro bar" } },
				{ ...datos, tenantActual: "otro-negocio" },
			]) {
				const peticion = await activacionFirmada(datos);
				const r = await enviar({ ...peticion, body: JSON.stringify(cambiado) });
				expect([r.status, r.body.error], JSON.stringify(cambiado)).toEqual([401, "bad_device_signature"]);
			}
			await sinEstrenar(c, k.id);
			await sinEstrenar(c, otra.id);
		});
	});

	it("los bytes tal como llegan: no hace falta que el cuerpo sea el JSON compacto", async () => {
		await escenario("bytes", async (c) => {
			const { datos } = await estreno(c, 0x23);
			const cuerpo = JSON.stringify({ ...datos, tenantInfo: { displayName: "Bar Ñandú — «El Rincón»" } }, null, "\t");

			const r = await enviar(await activacionFirmada(datos, { cuerpo }));
			expect(r.status).toBe(200);
		});
	});

	it("la ruta: la firma de otra petición del mismo equipo no vale para activar", async () => {
		await escenario("ruta", async (c) => {
			const { equipo, k, datos } = await estreno(c, 0x24);
			const body = JSON.stringify(datos);
			const bytes = new TextEncoder().encode(body);
			const ts = Date.now();
			const vacio = await sha256HexBytes(new Uint8Array());
			const token = await firmarSesion(ENV, { tenantId: "t", deviceId: "equipo-nuevo", licHash: "h" });

			const mensajes = {
				// La ruta como la ve el router, y no la que se firma.
				"/activate": ["DEVICE_PROOF", ts, "POST", "/activate", vacio, await sha256HexBytes(bytes)],
				// Otra ruta de licencias, con el mismo cuerpo.
				"/v1/license/refresh": ["DEVICE_PROOF", ts, "POST", "/v1/license/refresh", vacio, await sha256HexBytes(bytes)],
				// Un device-proof con token, como el de cualquier ruta autenticada.
				"con token": ["DEVICE_PROOF", ts, "POST", "/v1/license/activate", await sha256HexStr(token), await sha256HexBytes(bytes)],
				// Otro método.
				GET: ["DEVICE_PROOF", ts, "GET", "/v1/license/activate", vacio, await sha256HexBytes(bytes)],
			};
			for (const [nombre, partes] of Object.entries(mensajes)) {
				const r = await enviar({
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
						"X-Device-Ts": String(ts),
						"X-Device-Sig": await firmar(partes.join("\n"), equipo.seed),
					},
					body,
				});
				expect([r.status, r.body.error], nombre).toEqual([401, "bad_device_signature"]);
			}
			await sinEstrenar(c, k.id);
		});
	});

	it("sin firma no se lee ni el cuerpo; con firma, un cuerpo que no vale sigue siendo un 400", async () => {
		await escenario("orden", async (c) => {
			const { equipo, datos } = await estreno(c, 0x25);

			const basura = await enviar({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "esto no es json",
			});
			expect([basura.status, basura.body.error]).toEqual([401, "missing_device_proof"]);

			const malFormado = await enviar(
				await activacionFirmada({ ...datos, devicePubKey: "una cadena" }, { firmarCon: equipo.seed }),
			);
			expect(malFormado.status).toBe(400);
		});
	});

	it("le dice a quien activa qué hacer, también montada en su ruta de verdad", async () => {
		await escenario("mensajes", async (c) => {
			const { equipo, datos } = await estreno(c, 0x26);
			const app = new Hono().use("*", completarErrores).route("/v1/license", licenseRoutes);
			const pedir = (peticion: RequestInit) => enviar(peticion, app as any, "/v1/license/activate");

			const sinFirma = await pedir(await activacionFirmada(datos, { sinFirma: true }));
			expect(sinFirma.body).toMatchObject({ error: "missing_device_proof", code: "external" });
			expect(sinFirma.body.message).toMatch(/Actualízalo/);

			const otraClave = await pedir(await activacionFirmada(datos, { firmarCon: new Uint8Array(32).fill(0x99) }));
			expect(otraClave.body).toMatchObject({ error: "bad_device_signature", code: "external" });
			expect(otraClave.body.message).toMatch(/identidad de este equipo/);

			const horaMal = await pedir(await activacionFirmada(datos, { ts: Date.now() - 10 * MINUTO }));
			expect(horaMal.body).toMatchObject({
				error: "device_ts_out_of_range",
				code: "external",
				message: MENSAJES.device_ts_out_of_range,
			});

			const bien = await pedir(await activacionFirmada(datos));
			expect(bien.status).toBe(200);
			expect(equipo.pub).toBe(datos.devicePubKey);
		});
	});
});

describe("AUD-01 · el vector que comparten el cliente Rust y el worker", () => {
	const vector = JSON.parse(vectorJson) as {
		semillaB64: string;
		clavePublicaB64: string;
		casos: Array<{ nombre: string; tsMs: number; cuerpo: string; mensaje: string; firmaB64: string }>;
	};

	it("lee el vector de verdad", () => {
		expect(vector.casos.length).toBeGreaterThanOrEqual(3);
	});

	it("el helper de los tests firma exactamente lo que firma el cliente", async () => {
		const { seed, pub } = await parDeSemilla(b64ToBytes(vector.semillaB64));
		expect(pub).toBe(vector.clavePublicaB64);

		for (const caso of vector.casos) {
			const cuerpo = new TextEncoder().encode(caso.cuerpo);
			expect(await mensajeDeActivacion(caso.tsMs, cuerpo), caso.nombre).toBe(caso.mensaje);
			expect(await firmarActivacion(caso.tsMs, cuerpo, seed), caso.nombre).toBe(caso.firmaB64);
		}
	});

	it("el worker da por buena esa firma, y sólo con esa clave, ese cuerpo y esa hora", async () => {
		const otraClave = (await parDeClaves(0x31)).pub;

		for (const caso of vector.casos) {
			vi.useFakeTimers();
			vi.setSystemTime(caso.tsMs);

			const peticion = (ts: number) =>
				new Request("https://tpv.test/v1/license/activate", {
					method: "POST",
					headers: { "X-Device-Ts": String(ts), "X-Device-Sig": caso.firmaB64 },
				});
			const cuerpo = new TextEncoder().encode(caso.cuerpo);

			expect(await verificarFirmaDeActivacion(peticion(caso.tsMs), vector.clavePublicaB64, cuerpo), caso.nombre).toEqual({
				ok: true,
			});
			expect(await verificarFirmaDeActivacion(peticion(caso.tsMs), otraClave, cuerpo)).toEqual({
				ok: false,
				error: "bad_device_signature",
			});
			expect(
				await verificarFirmaDeActivacion(peticion(caso.tsMs), vector.clavePublicaB64, new TextEncoder().encode(`${caso.cuerpo} `)),
			).toEqual({ ok: false, error: "bad_device_signature" });
			expect(await verificarFirmaDeActivacion(peticion(caso.tsMs + 1), vector.clavePublicaB64, cuerpo)).toEqual({
				ok: false,
				error: "bad_device_signature",
			});

			vi.useRealTimers();
		}
	});
});
