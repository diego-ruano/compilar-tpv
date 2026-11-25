// test/setupInicialPendiente.test.ts
//
// AUD-24: el PIN inicial lo elige la Main y sube por su outbox; la nube no ofrece otro camino hacia
// esa fila, y mientras no ha llegado no deja usar el de la siembra.
//
//   · Ya no hay una ruta para cambiar un PIN directamente. `POST /v1/login/sync-initial-setup`,
//     firmada como la Main, escribía en la base, sin hub, el PIN que le dijeran para el usuario que le
//     dijeran, también el del administrador con el setup hecho, y la Main no se enteraba.
//     `pinSiempreConFreno.test.ts` lo fija en la tabla de rutas; aquí se comprueba por el router
//     real que una petición que pasa `tenantAuth` firmada como la Main no encuentra quien la atienda.
//   · Mientras en la nube el usuario tenga `Requiere_Setup = 1`, una Handy no entra ni ficha con él:
//     su PIN aquí es el público de la siembra, y el elegido puede tardar en subir (la Main sin red, o
//     con la réplica apagada, con una Handy ya vinculada). Cuando llega el `UPDATE` del outbox, con
//     `Requiere_Setup = 0`, entra con el PIN elegido y no con el de la siembra.
//
// Router real: `tenantAuth` con JWT y device-proof Ed25519 de verdad, contra una base central de
// verdad con el negocio dado de alta (`helpers/central.ts`). La base del negocio es el SQLite de su
// Durable Object, con su esquema y su cliente de producción. Datos ficticios; sin red.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";

import { centralDePrueba, negocioEnLaCentral } from "./helpers/central";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import type { Env } from "../src/env";
import type { Base } from "../src/lib/sql";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";
import { hashPin } from "../src/domains/login/login.crypto";
import { getLoginRecord } from "../src/domains/login/login.queries";
import { MENSAJES } from "../src/lib/errorCodes";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

/** La base del negocio del caso en curso; la lee el `tenantQuery` sustituido. */
let baseDelNegocio: Base | null = null;

vi.mock("../src/lib/tenantClient", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/lib/tenantClient")>();
	return { ...original, tenantQuery: (_c: unknown, fn: (db: unknown) => unknown) => fn(baseDelNegocio) };
});

const { loginRoutes } = await import("../src/domains/login/login.routes");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas-aud24",
};

const TENANT = "tenant-aud24";
const LIC_HASH = "hash-licencia-aud24";
const MAIN = "aud24-main";
const HANDY = "aud24-handy";
/** El UUID fijo del administrador inicial, el mismo en todos los negocios (util.rs, tenantHub.alta.ts). */
const ADMIN = "00000000-0000-7000-8000-000000000501";
/** El PIN del administrador que siembra la nube (`sembrarAdminInicial`): es público. */
const PIN_DE_LA_SIEMBRA = "1234";
const PIN_ELEGIDO = "2468";

ensureEd25519Sha512();
const SEMILLA_MAIN = new Uint8Array(32).fill(41);
const SEMILLA_HANDY = new Uint8Array(32).fill(42);

beforeEach(() => {
	olvidarLicenciasCacheadas();
});

type Negocio = {
	/** El SQLite de la base del negocio. */
	sql: any;
	/** La base del negocio, con su cliente de producción. */
	db: Base;
	/** Pide `ruta` a `loginRoutes`, con la base central del negocio. */
	pedir: (ruta: string, init: RequestInit) => Promise<Response>;
	comoLaMain: (ruta: string, datos: unknown) => Promise<Response>;
	comoLaHandy: (ruta: string, datos: unknown) => Promise<Response>;
};

/** Un negocio recién creado: licencia activa, su Main, una Handy ya vinculada y el administrador
 * como lo deja la nube (PIN de la siembra, `Requiere_Setup = 1`). */
async function negocioRecienCreado<R>(nombre: string, prueba: (n: Negocio) => Promise<R>): Promise<R> {
	const central = await centralDePrueba();
	await negocioEnLaCentral(central, {
		tenantId: TENANT,
		main: MAIN,
		licenseId: "lic-aud24",
		licenseKeyHash: LIC_HASH,
		dispositivos: [
			{ deviceId: MAIN, rol: "tpv", pubkeyB64: bytesToB64(await ed.getPublicKeyAsync(SEMILLA_MAIN)) },
			{ deviceId: HANDY, rol: "handy", pubkeyB64: bytesToB64(await ed.getPublicKeyAsync(SEMILLA_HANDY)) },
		],
	});
	const env = { ...ENV, ...central.entorno } as Env;
	const pedir = async (ruta: string, init: RequestInit) => loginRoutes.request(ruta, init, env);
	const post = (dispositivo: string, semilla: Uint8Array) => (ruta: string, datos: unknown) =>
		postFirmado(pedir, dispositivo, semilla, ruta, datos);

	return enElHub(`aud24-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		const db = clienteLocal(hub.state.storage);
		baseDelNegocio = db;
		sql.exec(
			`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Apellido, Estado, Requiere_Setup)
			 VALUES (?, (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador'), 'admin@local', ?, 'Admin', 'TPV', 'Activo', 1);`,
			ADMIN,
			await hashPin(PIN_DE_LA_SIEMBRA),
		);
		try {
			return await prueba({
				sql,
				db,
				pedir,
				comoLaMain: post(MAIN, SEMILLA_MAIN),
				comoLaHandy: post(HANDY, SEMILLA_HANDY),
			});
		} finally {
			baseDelNegocio = null;
		}
	});
}

/** Un POST firmado como lo firma el cliente Rust (`sign_device_proof`), con el cuerpo en la firma. */
async function postFirmado(
	pedir: Negocio["pedir"],
	dispositivo: string,
	semilla: Uint8Array,
	ruta: string,
	datos: unknown,
) {
	const token = await firmarSesion(ENV as any, { tenantId: TENANT, deviceId: dispositivo, licHash: LIC_HASH });
	const cuerpo = JSON.stringify(datos);
	const ts = Date.now();
	const mensaje = [
		"DEVICE_PROOF",
		ts,
		"POST",
		ruta,
		await sha256HexStr(token),
		await sha256HexBytes(new TextEncoder().encode(cuerpo)),
	].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), semilla));
	return pedir(ruta, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"X-Device-Ts": String(ts),
			"X-Device-Sig": firma,
		},
		body: cuerpo,
	});
}

describe("AUD-24 · la nube ya no cambia un PIN por una subida directa", () => {
	it("firmada como la Main, /sync-initial-setup no existe y el PIN sembrado no cambia", async () => {
		await negocioRecienCreado("sin-ruta", async ({ db, pedir, comoLaMain }) => {
			const antes = await getLoginRecord(db, ADMIN);

			// Sin firma, `tenantAuth` la para antes de buscar ruta: el 404 de abajo no es un rechazo
			// de la firma, es que nadie la atiende.
			const sinFirma = await pedir("/sync-initial-setup", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(sinFirma.status).toBe(401);

			const r = await comoLaMain("/sync-initial-setup", { id_usuario: ADMIN, pin: "9999" });

			expect(r.status).toBe(404);
			const despues = await getLoginRecord(db, ADMIN);
			expect(despues.password_hash).toBe(antes.password_hash);
			expect(Number(despues.requiere_setup)).toBe(1);
		});
	});
});

describe("AUD-24 · con el setup pendiente en la nube, la Handy no entra ni ficha", () => {
	it("con el PIN de la siembra no entra ni ficha, y se le dice qué hacer", async () => {
		await negocioRecienCreado("pendiente", async ({ sql, comoLaHandy }) => {
			for (const [ruta, datos] of [
				["/login", { id_usuario: ADMIN, pin: PIN_DE_LA_SIEMBRA }],
				["/punch", { id_usuario: ADMIN, pin: PIN_DE_LA_SIEMBRA, tipo: "entrada" }],
			] as const) {
				const r = await comoLaHandy(ruta, datos);
				expect(r.status, ruta).toBe(409);
				expect(((await r.json()) as any).error, ruta).toBe("setup_inicial_pendiente");
			}
			expect(MENSAJES.setup_inicial_pendiente).toBe(
				"Termina la configuración inicial en el TPV y vuelve a intentarlo.",
			);

			// Se rechaza antes del PIN y del freno: no gasta intentos ni ficha nada.
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Intentos_Login;").one().n)).toBe(0);
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Fichajes;").one().n)).toBe(0);
		});
	});

	it("cuando llega el UPDATE del outbox de la Main, entra con el PIN elegido y no con el de la siembra", async () => {
		await negocioRecienCreado("aplicado", async ({ sql, comoLaHandy }) => {
			// Lo que deja `complete_initial_setup` en el outbox de la Main (`exec_apply_initial_setup`),
			// tal como lo aplica la nube.
			sql.exec(
				`UPDATE Usuarios
				 SET Password_Hash = ?, Requiere_Setup = 0
				 WHERE ID_Usuario = ?;`,
				await hashPin(PIN_ELEGIDO),
				ADMIN,
			);

			expect((await comoLaHandy("/login", { id_usuario: ADMIN, pin: PIN_DE_LA_SIEMBRA })).status).toBe(401);

			const r = await comoLaHandy("/login", { id_usuario: ADMIN, pin: PIN_ELEGIDO });
			expect(r.status).toBe(200);
			const ok = (await r.json()) as any;
			expect(ok.id_usuario).toBe(ADMIN);
			expect(ok.rol).toBe("Administrador");
		});
	});
});
