// test/emparejamiento.test.ts
//
// Vincular una Handy de principio a fin, contra una base central de verdad para cada caso
// (`helpers/central.ts`) y con firmas ed25519 reales.
//
// Lo que se fija, y el fallo de antes que evita cada cosa:
//   · La espera por fallos crece por tramos (3 → 30 s, 6 → 5 min, 9 → 30 min). Antes había 30
//     intentos por minuto sin más, y ni un error de dedo ni un barrido se distinguían.
//   · El reto vive lo que el código. Caducaba a los 2 minutos mientras la Handy esperaba 3: si la
//     Main aprobaba entre medias, el código quedaba gastado y nadie recogía el token.
//   · Un dispositivo aprobado puede volver a reclamar su código y recoger el token.
//   · La Main puede rechazar, y la Handy se entera en la siguiente consulta.
//   · La Handy puede cancelar, y la solicitud deja de estar en la lista de la Main.
//   · El filtro exterior (Cloudflare) sigue declarado, deja pasar lo normal y no sustituye a nada.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as ed from "@noble/ed25519";

import { centralDePrueba, centralInterceptada, filasDe, operarConFallo, type CentralDePrueba } from "./helpers/central";
import type { RespuestaDeLaCentral, SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import type { FilasEnBruto } from "../src/durableObjects/sqliteDelObjeto";
import { ErrorDeLaCentral, type ClienteCentral } from "../src/server/central/cliente";
import type { Operaciones } from "../src/server/central/operaciones/registro";
import { entregarToken, reclamarCodigo, soltarCodigo } from "../src/domains/pairing/pairing.handy";
import { aprobarSolicitud, crearCodigo, rechazarSolicitud, solicitudesPendientes } from "../src/domains/pairing/pairing.main";
import { cancelSchema, claimSchema, fetchTokenSchema } from "../src/domains/pairing/pairing.schemas";
import { pairingRoutes } from "../src/domains/pairing/pairing.routes";
import {
	OLVIDO_MS,
	PETICIONES_POR_MINUTO,
	esperaTrasFallos,
	pasaElFiltroExterior,
	textoDeEspera,
} from "../src/domains/pairing/pairing.intentos";
import { claveDeFreno } from "../src/lib/limitador";
import { wireToCode } from "../src/lib/errorCodes";
import configuracionDelWorker from "../wrangler.json";
import { mensajeFirmado, type AccionFirmada } from "../src/domains/pairing/pairing.firma";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { bytesToB64 } from "../src/server/utils/base64";

/**
 * El worker con el subrouter montado donde de verdad vive, para probar las rutas enteras. Llega a la
 * central del caso por su `entorno`; el resto de los casos llama a las funciones de decisión, que
 * reciben el cliente y no lo buscan.
 */
const elWorker = new Hono().route("/v1/pair", pairingRoutes);

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const CODIGO = "482913";
const OTRO_CODIGO = "771100";
const TENANT = "tenant-1";
const ENV = { PAIR_PEPPER: "pepper-de-pruebas", LICENSE_JWT_SECRET: "secreto-de-pruebas" };

type Dispositivo = { id: string; seed: Uint8Array; pub: string };

async function dispositivo(id: string, relleno: number): Promise<Dispositivo> {
	ensureEd25519Sha512();
	const seed = new Uint8Array(32).fill(relleno);
	return { id, seed, pub: bytesToB64(await ed.getPublicKeyAsync(seed)) };
}

async function firmar(d: Dispositivo, accion: AccionFirmada, ts: number, pairCode: string, nonceB64: string) {
	const mensaje = new TextEncoder().encode(mensajeFirmado(accion, ts, pairCode, nonceB64, d.id));
	return bytesToB64(await ed.signAsync(mensaje, d.seed));
}

function peticion(ruta: string, cuerpo: Record<string, unknown>, ip = "10.0.0.1"): Request {
	return new Request(`https://api.test/v1/pair/${ruta}`, {
		method: "POST",
		headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
		body: JSON.stringify(cuerpo),
	});
}

/** Una base central nueva con dos códigos del mismo negocio, que caducan a los 10 minutos. */
async function conLaCentral<R>(prueba: (m: Mundo) => Promise<R>): Promise<R> {
	const central = await centralDePrueba();
	// `fetch-token` necesita el negocio, su licencia activa y, al aprobar, el dispositivo.
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, status, term_months, origin,
		                       issued_at_ms, customer_email, created_at_ms, updated_at_ms)
		 VALUES ('lic-1', 'hash-licencia', ?, 'active', 12, 'manual', ?, 'bar@ejemplo.test', ?, ?);`,
		TENANT,
		T0,
		T0,
		T0,
	);
	for (const codigo of [CODIGO, OTRO_CODIGO]) {
		await filasDe(
			central,
			`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
			 VALUES (?, 'sin-secreto', ?, 'main-1', 'pending', ?, ?);`,
			codigo,
			TENANT,
			T0,
			T0 + 10 * MIN,
		);
	}
	return prueba(new Mundo(central));
}

class Mundo {
	/**
	 * `db` es por donde las funciones de decisión le hablan a la central: su cliente, o la misma
	 * central vista a través de su stub (`centralInterceptada`).
	 */
	constructor(
		readonly central: CentralDePrueba,
		readonly db: ClienteCentral = central.db,
	) {}

	/** Las filas de una sentencia ejecutada directamente en la central: para sembrar y comprobar. */
	filas(texto: string, ...args: unknown[]) {
		return filasDe(this.central, texto, ...args);
	}

	async reclamar(d: Dispositivo, codigo: string, ahora: number, ip = "10.0.0.1") {
		const res = await reclamarCodigo(
			this.db,
			ENV,
			claimSchema.parse({ pairCode: codigo, pairSecret: "", deviceId: d.id, devicePubKey: d.pub, deviceName: "" }),
			ip,
			ahora,
		);
		return { status: res.status, body: res.cuerpo as any };
	}

	async recoger(d: Dispositivo, codigo: string, nonceB64: string, ahora: number, accion: AccionFirmada = "PAIR_FETCH") {
		const res = await entregarToken(
			this.db,
			ENV,
			fetchTokenSchema.parse({
				pairCode: codigo,
				deviceId: d.id,
				nonceB64,
				ts: ahora,
				sigB64: await firmar(d, accion, ahora, codigo, nonceB64),
			}),
			ahora,
		);
		return { status: res.status, body: res.cuerpo as any };
	}

	async cancelar(d: Dispositivo, codigo: string, nonceB64: string, ahora: number, accion: AccionFirmada = "PAIR_CANCEL") {
		const cuerpo = {
			pairCode: codigo,
			deviceId: d.id,
			nonceB64,
			ts: ahora,
			sigB64: await firmar(d, accion, ahora, codigo, nonceB64),
		};
		const res = await soltarCodigo(this.db, ENV, cancelSchema.parse(cuerpo), ahora);
		return { status: res.status, body: res.cuerpo as any, cuerpo };
	}

	/** Lo que hace `pairApprove` después de autenticar a la Main: marcar el código, nada más. */
	async aprobar(codigo: string, _d: Dispositivo, ahora: number) {
		await this.filas(`UPDATE pair_requests SET status='approved', approved_at_ms=? WHERE pair_code=?;`, ahora, codigo);
	}

	async dispositivoRegistrado(d: Dispositivo): Promise<any> {
		return (await this.filas(`SELECT * FROM devices WHERE device_id=?;`, d.id))[0];
	}

	async solicitud(codigo: string): Promise<any> {
		return (await this.filas(`SELECT * FROM pair_requests WHERE pair_code=?;`, codigo))[0];
	}
}

describe("la espera por fallos", () => {
	it("crece por tramos de tres y se queda en media hora", () => {
		const esperas = Array.from({ length: 15 }, (_, i) => esperaTrasFallos(i + 1));
		expect(esperas).toEqual([
			0, 0, 30_000,
			0, 0, 5 * MIN,
			0, 0, 30 * MIN,
			0, 0, 30 * MIN,
			0, 0, 30 * MIN,
		]);
	});

	it("se dice en palabras", () => {
		expect(textoDeEspera(1)).toBe("1 segundo");
		expect(textoDeEspera(30)).toBe("30 segundos");
		expect(textoDeEspera(60)).toBe("1 minuto");
		expect(textoDeEspera(299)).toBe("5 minutos");
		expect(textoDeEspera(1800)).toBe("30 minutos");
	});

	it("el tercer fallo ya contesta con la espera, y mientras dura ni un código bueno entra", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			expect((await m.reclamar(a, "000001", T0)).status).toBe(404);
			expect((await m.reclamar(a, "000002", T0)).status).toBe(404);

			const tercero = await m.reclamar(a, "000003", T0);
			expect(tercero.status).toBe(429);
			expect(tercero.body.reintentarEnSegundos).toBe(30);
			expect(tercero.body.message).toBe("Demasiados intentos fallidos. Vuelve a intentarlo dentro de 30 segundos.");

			// Durante la espera, el código bueno tampoco: si entrara, bloquear no serviría de nada.
			const bueno = await m.reclamar(a, CODIGO, T0 + 29_000);
			expect(bueno.status).toBe(429);
			expect(bueno.body.reintentarEnSegundos).toBe(1);
			expect((await m.solicitud(CODIGO)).claimed_by_device_id).toBeNull();

			expect((await m.reclamar(a, CODIGO, T0 + 30_000)).status).toBe(200);
		});
	});

	it("los tramos siguientes: 5 minutos al sexto fallo y media hora al noveno", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			let ahora = T0;
			const fallar = async () => {
				const r = await m.reclamar(a, "000009", ahora);
				if (r.status === 429) ahora += r.body.reintentarEnSegundos * 1000;
				return r;
			};
			const esperas: number[] = [];
			for (let i = 0; i < 9; i++) {
				const r = await fallar();
				esperas.push(r.status === 429 ? r.body.reintentarEnSegundos : 0);
			}
			expect(esperas).toEqual([0, 0, 30, 0, 0, 300, 0, 0, 1800]);
		});
	});

	it("emparejar bien no borra la cuenta (AUD-11)", async () => {
		// Antes la borraba, y reclamar un código propio (que cualquier negocio con licencia emite sin
		// tope) bastaba para poner a cero la espera entre cada dos fallos: un barrido sin freno.
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await m.reclamar(a, "000001", T0);
			await m.reclamar(a, "000002", T0);
			expect((await m.reclamar(a, CODIGO, T0)).status).toBe(200);
			const tercero = await m.reclamar(a, "000003", T0);
			expect(tercero.status).toBe(429);
			expect(tercero.body.reintentarEnSegundos).toBe(30);
		});
	});

	it("reclamar una y otra vez el propio código pendiente no reinicia la espera (AUD-11)", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const estados: number[] = [];
			for (const codigo of ["000001", CODIGO, "000002", CODIGO, "000003"]) {
				estados.push((await m.reclamar(a, codigo, T0)).status);
			}
			expect(estados).toEqual([404, 200, 404, 200, 429]);
			expect(await m.filas(`SELECT fallos FROM pair_claim_fallos;`)).toEqual([{ fallos: 3 }]);
		});
	});

	it("ni el propio código ya aprobado (AUD-11)", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			expect((await m.reclamar(a, CODIGO, T0)).status).toBe(200);
			await m.aprobar(CODIGO, a, T0);
			const estados: Array<string | number> = [];
			for (const codigo of ["000001", CODIGO, "000002", CODIGO, "000003"]) {
				const r = await m.reclamar(a, codigo, T0);
				estados.push(r.status === 200 ? r.body.state : r.status);
			}
			expect(estados).toEqual([404, "approved", 404, "approved", 429]);
		});
	});

	it("un día sin fallar también la borra", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await m.reclamar(a, "000001", T0);
			await m.reclamar(a, "000002", T0);
			const dia = T0 + OLVIDO_MS + 1;
			expect((await m.reclamar(a, "000003", dia)).status).toBe(404);
			expect((await m.reclamar(a, "000004", dia)).status).toBe(404);
			expect((await m.reclamar(a, "000005", dia)).status).toBe(429);
		});
	});

	it("cada IPv4 lleva su cuenta", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			for (const codigo of ["000001", "000002", "000003"]) await m.reclamar(a, codigo, T0, "10.0.0.1");
			expect((await m.reclamar(a, CODIGO, T0, "10.0.0.1")).status).toBe(429);
			expect((await m.reclamar(a, CODIGO, T0, "10.0.0.2")).status).toBe(200);
		});
	});

	it("en IPv6 la cuenta es del /64 entero, no de cada dirección (AUD-11)", async () => {
		// Una conexión IPv6 recibe un /64 y elige a su gusto los 64 bits de abajo: contar por
		// dirección daba a cada uno 2^64 cuentas nuevas. Se escriben de formas distintas a propósito.
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const estados: number[] = [];
			for (const [codigo, ip] of [
				["000001", "2001:db8:0:1::1"],
				["000002", "2001:DB8:0:1:ffff:ffff:ffff:2"],
				["000003", "2001:0db8:0000:0001:0:0:0:3"],
			]) {
				estados.push((await m.reclamar(a, codigo, T0, ip)).status);
			}
			expect(estados).toEqual([404, 404, 429]);
			expect((await m.reclamar(a, CODIGO, T0, "2001:db8:0:1::abcd")).status).toBe(429);
			// Otro /64 lleva la suya.
			expect((await m.reclamar(a, CODIGO, T0, "2001:db8:0:2::1")).status).toBe(200);
			expect((await m.filas(`SELECT COUNT(*) AS n FROM pair_claim_fallos;`))[0].n).toBe(1);
		});
	});

	it("por la ruta, el filtro exterior también cuenta el /64 (AUD-11)", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const claves: string[] = [];
			const env = {
				...ENV,
				...m.central.entorno,
				LIMITADOR_CLAIM: {
					limit: ({ key }: { key: string }) => {
						claves.push(key);
						return Promise.resolve({ success: true });
					},
				},
			};
			for (const ip of ["2001:db8:0:7::1", "2001:db8:0:7:1:2:3:4"]) {
				const cuerpo = { pairCode: "000001", pairSecret: "", deviceId: a.id, devicePubKey: a.pub, deviceName: "" };
				expect((await elWorker.fetch(peticion("claim", cuerpo, ip), env)).status).toBe(404);
			}
			expect(claves).toEqual(["2001:db8:0:7::/64", "2001:db8:0:7::/64"]);
			expect(await m.filas(`SELECT ip, fallos FROM pair_claim_fallos;`)).toEqual([
				{ ip: "2001:db8:0:7::/64", fallos: 2 },
			]);
		});
	});

	it("la clave del freno: la IPv4 tal cual, la IPv6 por su /64 escrita como se escriba (AUD-11)", () => {
		expect(claveDeFreno("198.51.100.7")).toBe("198.51.100.7");
		expect(claveDeFreno(" 198.51.100.7 ")).toBe("198.51.100.7");
		for (const ip of [
			"2001:db8:0:1::1",
			"2001:0DB8:0000:0001:0000:0000:0000:0001",
			"2001:db8:0:1:ffff:ffff:ffff:ffff",
			"[2001:db8:0:1::abcd]",
			"2001:db8:0:1::abcd%eth0",
			"2001:db8:0:1:0:0:198.51.100.7",
		]) {
			expect(claveDeFreno(ip), ip).toBe("2001:db8:0:1::/64");
		}
		expect(claveDeFreno("2001:db8::1")).toBe("2001:db8:0:0::/64");
		expect(claveDeFreno("::1")).toBe("0:0:0:0::/64");
		// Una IPv4 escrita como IPv6 es esa IPv4: comparte cuenta con ella.
		expect(claveDeFreno("::ffff:198.51.100.7")).toBe("198.51.100.7");
		expect(claveDeFreno("::FFFF:c633:6407")).toBe("198.51.100.7");
		// Lo que no es una dirección se queda como está: frena a esa cadena, como antes.
		for (const raro of ["unknown", "1:2:3", "1::2::3", "2001:db8:0:1::1:2:3:4:5", "fe80::zz"]) {
			expect(claveDeFreno(raro), raro).toBe(raro);
		}
	});

	it("una petición mal formada no cuenta como fallo: es un cliente roto, no alguien probando", async () => {
		// Por la RUTA: desde ARQ-03 quien rechaza el formato es el validador del cuerpo, delante
		// del handler, y lo que se fija aquí es que ese 400 no gasta ningún intento.
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			for (let i = 0; i < 5; i++) {
				const r = await elWorker.fetch(
					peticion("claim", { pairCode: "12", pairSecret: "", deviceId: a.id, devicePubKey: a.pub, deviceName: "" }),
					{ ...ENV, ...m.central.entorno },
				);
				expect(r.status).toBe(400);
				expect(((await r.json()) as any).error).toBe("invalid_pair_code");
			}
			expect((await m.reclamar(a, CODIGO, T0)).status).toBe(200);
		});
	});
});

describe("el reto y la recogida del token", () => {
	it("el reto vive lo que el código, y la Handy recibe cuánto le queda en relativo", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const r = await m.reclamar(a, CODIGO, T0 + 2 * MIN);
			expect(r.body.nonceExpiresAtMs).toBe(T0 + 10 * MIN);
			expect(r.body.caducaEnMs).toBe(8 * MIN);
		});
	});

	it("una aprobación a los cinco minutos todavía entrega el token", async () => {
		// Con el reto de dos minutos de antes, esto era `challenge_expired` y el código se perdía.
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).body.error).toBe("not_approved");

			await m.aprobar(CODIGO, a, T0 + 5 * MIN);
			const token = await m.recoger(a, CODIGO, body.nonceB64, T0 + 5 * MIN);
			expect(token.status).toBe(200);
			expect(token.body).toMatchObject({ ok: true, tenantId: TENANT, deviceId: a.id });
			expect((await m.solicitud(CODIGO)).status).toBe("used");
		});
	});

	it("el dispositivo se da de alta al recoger el token, no al aprobar", async () => {
		// Dado de alta al aprobar, una aprobación que nadie recogía dejaba un Handy fantasma en la
		// lista de vinculados de la Main.
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			expect(await m.dispositivoRegistrado(a)).toBeUndefined();

			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).status).toBe(200);
			expect(await m.dispositivoRegistrado(a)).toMatchObject({
				tenant_id: TENANT,
				role: "handy",
				revoked_at_ms: null,
				device_pubkey_b64: a.pub,
			});
		});
	});

	it("un Handy revocado que se vuelve a vincular queda activo y con la clave nueva", async () => {
		const antes = await dispositivo("handy-a", 1);
		const ahora = await dispositivo("handy-a", 4);
		await conLaCentral(async (m) => {
			await m.filas(`INSERT INTO devices (device_id, tenant_id, role, revoked_at_ms, device_pubkey_b64)
				VALUES (?, ?, 'handy', ?, ?);`, antes.id, TENANT, T0 - MIN, antes.pub);

			const { body } = await m.reclamar(ahora, CODIGO, T0);
			await m.aprobar(CODIGO, ahora, T0);
			expect((await m.recoger(ahora, CODIGO, body.nonceB64, T0)).status).toBe(200);
			expect(await m.dispositivoRegistrado(ahora)).toMatchObject({ revoked_at_ms: null, device_pubkey_b64: ahora.pub });
		});
	});

	it("la consulta que llega con el reto caducado oye que el código ha caducado (EMPAREJAR-ESPERA)", async () => {
		// El reto vive lo que el código, y la última consulta de la Handy llega siempre un poco después
		// de que caduque en la nube. Contestaba `challenge_expired`, que para la Handy era `external`, un
		// fallo pasajero: el aviso decía «Se sigue esperando» y la espera acababa culpando a la nube.
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			const tarde = T0 + 10 * MIN + 1;

			const recogida = await m.recoger(a, CODIGO, body.nonceB64, tarde);
			expect([recogida.status, recogida.body.error]).toEqual([410, "pair_code_expired"]);
			expect(wireToCode(recogida.body.error, recogida.status)).toBe("pair_code_expired");

			const cancelacion = await m.cancelar(a, CODIGO, body.nonceB64, tarde);
			expect([cancelacion.status, cancelacion.body.error]).toEqual([410, "pair_code_expired"]);
		});
	});

	it("una aprobación que nadie recoge no deja ningún dispositivo", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			// El código caduca sin que la Handy vuelva.
			expect((await m.reclamar(a, CODIGO, T0 + 11 * MIN)).body.error).toBe("pair_code_expired");
			expect((await m.filas(`SELECT COUNT(*) AS n FROM devices;`))[0].n).toBe(0);
		});
	});

	it("el dispositivo aprobado puede volver a reclamar su código y recoger el token", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);

			// La aplicación se cerró esperando: al volver no tiene el reto.
			const otraVez = await m.reclamar(a, CODIGO, T0 + 2 * MIN);
			expect(otraVez.status).toBe(200);
			expect(otraVez.body.state).toBe("approved");
			expect((await m.recoger(a, CODIGO, otraVez.body.nonceB64, T0 + 2 * MIN)).status).toBe(200);
		});
	});

	it("no se le puede quitar a otro negocio su dispositivo (REV-07)", async () => {
		// El ataque: montar el emparejamiento en un negocio propio pero reclamando el `device_id` de
		// la Main de otro. El alta hace `ON CONFLICT(device_id) DO UPDATE` de `tenant_id` **y de
		// `device_pubkey_b64`**, así que aquella Main se quedaba firmando con una clave que ya no
		// era la suya: `bad_device_signature` en todo, y sin poder reactivar, porque activar la
		// rechaza entonces con `device_key_mismatch`. El `device_id` ajeno no es un secreto: viaja
		// en los mensajes de presencia del WebSocket, así que lo conocen las Handy del local.
		const victima = await dispositivo("main-de-otro-bar", 7);
		const atacante = await dispositivo("main-de-otro-bar", 9); // mismo id, SU clave
		await conLaCentral(async (m) => {
			await m.filas(`INSERT INTO tenants (tenant_id) VALUES ('tenant-de-la-victima');`);
			await m.filas(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
				 VALUES (?, 'tenant-de-la-victima', 'tpv', ?, 'ed25519');`,
				victima.id,
				victima.pub,
			);

			const { body } = await m.reclamar(atacante, CODIGO, T0);
			await m.aprobar(CODIGO, atacante, T0);
			const r = await m.recoger(atacante, CODIGO, body.nonceB64, T0);

			expect(r.status).toBe(409);
			expect(r.body.error).toBe("device_key_mismatch");

			// Y la fila de la víctima, intacta: ni de negocio, ni de rol, ni de clave.
			expect(await m.dispositivoRegistrado(victima)).toMatchObject({
				tenant_id: "tenant-de-la-victima",
				role: "tpv",
				device_pubkey_b64: victima.pub,
			});
		});
	});

	it("pero el equipo de verdad sí puede mudarse de negocio, firmando con su clave (REV-07)", async () => {
		// La otra mitad, y la que impide que el arreglo rompa lo que §9 decide a propósito: un
		// equipo tiene UNA identidad para sus dos modos, así que vincularlo como Handy de otro
		// negocio mueve su fila. Lo que se exige es que lo haga él, no cualquiera.
		const equipo = await dispositivo("equipo-viajero", 7);
		await conLaCentral(async (m) => {
			await m.filas(`INSERT INTO tenants (tenant_id) VALUES ('su-negocio-de-antes');`);
			await m.filas(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
				 VALUES (?, 'su-negocio-de-antes', 'tpv', ?, 'ed25519');`,
				equipo.id,
				equipo.pub,
			);

			const { body } = await m.reclamar(equipo, CODIGO, T0);
			await m.aprobar(CODIGO, equipo, T0);
			expect((await m.recoger(equipo, CODIGO, body.nonceB64, T0)).status).toBe(200);

			expect(await m.dispositivoRegistrado(equipo)).toMatchObject({
				tenant_id: TENANT,
				role: "handy",
				device_pubkey_b64: equipo.pub,
			});
		});
	});

	it("dos recogidas a la vez del mismo device_id, en negocios y con claves distintos: sólo entra una (AUD-01)", async () => {
		// La comprobación de REV-07 y el alta no son un lote. Las dos recogidas, cada una aprobada en
		// su negocio, veían que ese `device_id` no tenía fila; la primera la creaba y el upsert de la
		// segunda, sin condición, le cambiaba el negocio y la clave: la primera se iba con un token de
		// un negocio en el que ya no estaba su fila. Ahora la regla va dentro de la sentencia.
		const uno = await dispositivo("equipo-disputado", 7);
		const otro = await dispositivo("equipo-disputado", 9); // mismo id, otra clave
		const CODIGO_2 = "555555";
		await conLaCentral(async (m) => {
			// Un segundo negocio, con su licencia y su código.
			await m.filas(`INSERT INTO tenants (tenant_id) VALUES ('tenant-2');`);
			await m.filas(
				`INSERT INTO licenses (license_id, license_key_hash, tenant_id, status, term_months, origin,
				                       issued_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES ('lic-2', 'hash-licencia-2', 'tenant-2', 'active', 12, 'manual', ?, 'otro@ejemplo.test', ?, ?);`,
				T0,
				T0,
				T0,
			);
			await m.filas(
				`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
				 VALUES (?, 'sin-secreto', 'tenant-2', 'main-2', 'pending', ?, ?);`,
				CODIGO_2,
				T0,
				T0 + 10 * MIN,
			);

			const reclamoUno = await m.reclamar(uno, CODIGO, T0);
			const reclamoOtro = await m.reclamar(otro, CODIGO_2, T0, "10.0.0.2");
			await m.aprobar(CODIGO, uno, T0);
			await m.aprobar(CODIGO_2, otro, T0);

			// Ninguna sigue hasta que las dos han leído que ese `device_id` no tiene fila.
			let llegadas = 0;
			let soltar!: () => void;
			const lasDos = new Promise<void>((resolve) => (soltar = resolve));
			const aLaVez = new Mundo(
				m.central,
				centralInterceptada(m.central, async (metodo, [sentencia], llamar) => {
					const leido = await llamar();
					if (
						metodo === "ejecutar" &&
						/SELECT tenant_id, device_pubkey_b64 FROM devices/.test((sentencia as SentenciaEnlazada).sql)
					) {
						if (++llegadas >= 2) soltar();
						await lasDos;
					}
					return leido;
				}).db,
			);

			const [a, b] = await Promise.all([
				aLaVez.recoger(uno, CODIGO, reclamoUno.body.nonceB64, T0),
				aLaVez.recoger(otro, CODIGO_2, reclamoOtro.body.nonceB64, T0),
			]);

			expect(llegadas).toBe(2);
			expect([a.status, b.status].sort()).toEqual([200, 409]);
			const [ganadora, perdedora, suClave] = a.status === 200 ? [a, b, uno.pub] : [b, a, otro.pub];

			// La que llega tarde se va sin token…
			expect(perdedora.body.error).toBe("device_key_mismatch");
			expect(perdedora.body.token).toBeUndefined();
			// …y la fila es la de la que entró: su negocio y su clave, las del token que se lleva.
			expect(ganadora.body.token).toBeTruthy();
			expect(await m.dispositivoRegistrado(uno)).toMatchObject({
				tenant_id: ganadora.body.tenantId,
				role: "handy",
				device_pubkey_b64: suClave,
			});
		});
	});

	it("un código aprobado para otro dispositivo no sirve, ni con el mismo id y otra clave", async () => {
		const a = await dispositivo("handy-a", 1);
		const b = await dispositivo("handy-b", 2);
		const suplantador = { ...(await dispositivo("handy-a", 3)), id: "handy-a" };
		await conLaCentral(async (m) => {
			await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);

			expect((await m.reclamar(b, CODIGO, T0 + 2 * MIN, "10.0.0.2")).body.error).toBe("pair_code_already_approved");
			expect((await m.reclamar(suplantador, CODIGO, T0 + 2 * MIN, "10.0.0.3")).body.error).toBe(
				"device_pubkey_mismatch",
			);
		});
	});

	it("la firma de una cancelación no sirve para recoger el token", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			const r = await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN, "PAIR_CANCEL");
			expect(r.body.error).toBe("pair_signature_invalid");
			expect((await m.solicitud(CODIGO)).status).toBe("approved");
		});
	});

	it("una firma que no vale termina la espera de la Handy; una hora fuera de margen, no (EMPAREJAR-ESPERA)", async () => {
		// Con la misma clave, repetir no cambia la firma. Salía con 401 `bad_device_signature`, que para
		// la Handy es `external`, pasajero: seguía preguntando hasta que caducaba el código, y al final
		// decía que la nube no contestaba.
		const a = await dispositivo("handy-a", 1);
		const otraClave = { ...(await dispositivo("handy-a", 3)), id: "handy-a" };
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			const ahora = T0 + MIN;
			// La misma consulta a `fetch-token` y a `cancel`: lo que no vale para una no vale para la otra.
			const consulta = async (cambios: Record<string, unknown>) => {
				const datos = {
					pairCode: CODIGO,
					deviceId: a.id,
					nonceB64: body.nonceB64,
					ts: ahora,
					sigB64: await firmar(a, "PAIR_FETCH", ahora, CODIGO, body.nonceB64),
					...cambios,
				};
				const r = await entregarToken(m.db, ENV, fetchTokenSchema.parse(datos), ahora);
				const s = await soltarCodigo(m.db, ENV, cancelSchema.parse(datos), ahora);
				return [r, s].map((x) => wireToCode(String(x.cuerpo.error), x.status));
			};

			const deOtraClave = await firmar(otraClave, "PAIR_FETCH", ahora, CODIGO, body.nonceB64);
			expect(await consulta({ sigB64: deOtraClave })).toEqual(["validation", "validation"]);
			expect(await consulta({ sigB64: bytesToB64(new Uint8Array(63).fill(7)) })).toEqual(["validation", "validation"]);
			// La hora sí cambia repitiendo: la respuesta trae la de la nube en su `Date`, Rust la anota, y
			// la siguiente consulta se firma con ella (PROD-04). Sigue siendo pasajera.
			const horaMala = ahora - 3 * MIN;
			expect(await consulta({ ts: horaMala, sigB64: await firmar(a, "PAIR_FETCH", horaMala, CODIGO, body.nonceB64) })).toEqual([
				"external",
				"external",
			]);
			expect((await m.solicitud(CODIGO)).claimed_by_device_id).toBe(a.id);
		});
	});
});

// EMPAREJAR-TOKEN: gastar el reto, gastar el código y dar de alta la Handy eran tres sentencias
// sueltas. Un fallo del alta dejaba el reto y el código gastados sin dispositivo, y había que
// emparejar otra vez; y la Handy cuya respuesta se perdía no podía volver a pedir su token, porque su
// reto ya estaba gastado. Ahora van en una operación de la central, todo o nada, y la recogida que se
// repite con el reto que gastó el código recibe otro token del mismo alta.
describe("recoger el token, todo o nada (EMPAREJAR-TOKEN)", () => {
	/**
	 * Lo que escribe la recogida, y el texto con el que se reconoce cada escritura: por sentencia suelta
	 * (antes) o dentro de la operación (ahora).
	 */
	const ESCRITURAS = [
		["al gastar el reto", /UPDATE device_challenges/],
		["al gastar el código", /UPDATE pair_requests\s+SET status='used'/],
		["al dar de alta el dispositivo", /INSERT INTO devices/],
	] as const;

	/**
	 * El mundo `m`, pero con la central fallando en la escritura que case con `patron` mientras
	 * `fallar.si` lo diga: una sentencia suelta falla sin ejecutarse, como un error de SQL; una
	 * operación revienta justo después de ejecutarla.
	 */
	function conFalloAlEscribir(m: Mundo, patron: RegExp) {
		const fallar = { si: true };
		const mundo = new Mundo(
			m.central,
			centralInterceptada(m.central, (metodo, argumentos, llamar) => {
				if (!fallar.si) return llamar();
				if (metodo === "ejecutar" && patron.test((argumentos[0] as SentenciaEnlazada).sql)) {
					return { ok: false, error: "central_error_sql", detalle: "fallo_simulado" };
				}
				if (metodo === "operar") {
					const [nombre, datos] = argumentos as [keyof Operaciones, never];
					return operarConFallo(m.central, nombre, datos, (texto) => patron.test(texto));
				}
				return llamar();
			}).db,
		);
		return { mundo, fallar };
	}

	for (const [cuando, patron] of ESCRITURAS) {
		it(`un fallo ${cuando} no deja nada gastado, y la Handy repite la recogida con el mismo reto`, async () => {
			const a = await dispositivo("handy-a", 1);
			await conLaCentral(async (m) => {
				const { body } = await m.reclamar(a, CODIGO, T0);
				await m.aprobar(CODIGO, a, T0 + MIN);
				const { mundo, fallar } = conFalloAlEscribir(m, patron);

				await expect(mundo.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).rejects.toBeInstanceOf(ErrorDeLaCentral);

				expect(
					await m.filas(`SELECT used_at_ms FROM device_challenges WHERE device_id = ? AND nonce_b64 = ?;`, a.id, body.nonceB64),
				).toEqual([{ used_at_ms: null }]);
				expect(await m.solicitud(CODIGO)).toMatchObject({ status: "approved", used_at_ms: null });
				expect(await m.dispositivoRegistrado(a)).toBeUndefined();

				// La central vuelve a contestar: la siguiente consulta, con el mismo reto, se lleva el token.
				fallar.si = false;
				const otraVez = await mundo.recoger(a, CODIGO, body.nonceB64, T0 + 2 * MIN);
				expect(otraVez.status).toBe(200);
				expect(otraVez.body).toMatchObject({ ok: true, tenantId: TENANT, deviceId: a.id, token: expect.any(String) });
				expect(await m.solicitud(CODIGO)).toMatchObject({ status: "used" });
				expect(await m.dispositivoRegistrado(a)).toMatchObject({ tenant_id: TENANT, role: "handy", revoked_at_ms: null });
			});
		});
	}

	it("si la respuesta se pierde, repetir la recogida con el mismo reto da otro token del mismo alta", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			const primera = await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN);
			expect(primera.status).toBe(200);
			const alta = await m.dispositivoRegistrado(a);

			// La respuesta no llegó: la Handy vuelve a preguntar con su reto, firmando otra vez.
			const repetida = await m.recoger(a, CODIGO, body.nonceB64, T0 + 2 * MIN);
			expect(repetida.status).toBe(200);
			expect(repetida.body).toMatchObject({ ok: true, tenantId: TENANT, deviceId: a.id, token: expect.any(String) });

			// Sin escribir nada: ni otro dispositivo, ni el alta tocada, ni el código.
			expect(await m.filas(`SELECT COUNT(*) AS n FROM devices;`)).toEqual([{ n: 1 }]);
			expect(await m.dispositivoRegistrado(a)).toEqual(alta);
			expect(await m.solicitud(CODIGO)).toMatchObject({ status: "used", used_at_ms: T0 + MIN });
		});
	});

	it("la recogida repetida sólo vale con el reto que gastó el código, firmado por quien lo reclamó, y mientras viva", async () => {
		const a = await dispositivo("handy-a", 1);
		const suplantador = { ...(await dispositivo("handy-a", 3)), id: "handy-a" };
		await conLaCentral(async (m) => {
			// Dos retos del mismo reclamo: la aplicación se reinició esperando y volvió a reclamar.
			const otroReto = (await m.reclamar(a, CODIGO, T0)).body.nonceB64;
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).status).toBe(200);

			expect((await m.recoger(a, CODIGO, otroReto, T0 + 2 * MIN)).body.error).toBe("already_used");
			expect((await m.recoger(suplantador, CODIGO, body.nonceB64, T0 + 2 * MIN)).body.error).toBe("pair_signature_invalid");
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + 2 * MIN, "PAIR_CANCEL")).body.error).toBe(
				"pair_signature_invalid",
			);
			// El reto caduca con el código: después, la Handy renueva su token como cualquier otra (`/v1/license/refresh`).
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + 11 * MIN)).body.error).toBe("pair_code_expired");
		});
	});

	it("la recogida repetida no da token a un dispositivo revocado, ni al que ya no es de ese negocio con esa clave", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).status).toBe(200);

			await m.filas(`UPDATE devices SET revoked_at_ms = ? WHERE device_id = ?;`, T0 + MIN, a.id);
			const revocado = await m.recoger(a, CODIGO, body.nonceB64, T0 + 2 * MIN);
			expect([revocado.status, revocado.body.error, revocado.body.token]).toEqual([401, "device_revoked", undefined]);

			await m.filas(`INSERT INTO tenants (tenant_id) VALUES ('otro-negocio');`);
			await m.filas(`UPDATE devices SET revoked_at_ms = NULL, tenant_id = 'otro-negocio' WHERE device_id = ?;`, a.id);
			const mudado = await m.recoger(a, CODIGO, body.nonceB64, T0 + 2 * MIN);
			expect([mudado.status, mudado.body.error, mudado.body.token]).toEqual([409, "already_used", undefined]);
		});
	});
});

// Reclamar el código y canjearlo por el token leen la solicitud, deciden y escriben en viajes
// distintos a la central. Lo que impide que dos se lo lleven es la sentencia que escribe, que sólo
// lo hace si la solicitud sigue como estaba (FABLE-D, y el `used_at_ms IS NULL` del canje). Aquí, N
// peticiones a la vez contra la central de verdad, y en el peor cruce: una barrera en su stub retiene
// la lectura de la solicitud de cada una hasta que la han hecho todas. Lo que leyeron es el caso de
// control: todas vieron el código como si fuera suyo, así que leer y decidir no basta.
describe("el mismo código, pedido a la vez", () => {
	const N = 6;

	/**
	 * El mundo `m`, pero con la barrera: las `n` primeras lecturas de la solicitud se quedan esperando,
	 * ya contestadas, hasta que han llegado las `n`. En `vistos`, lo que leyó cada una.
	 */
	function conBarrera(m: Mundo, n: number) {
		const vistos: { status: unknown; reclamado: unknown }[] = [];
		let soltar!: () => void;
		const todas = new Promise<void>((resolve) => (soltar = resolve));
		const aLaVez = new Mundo(
			m.central,
			centralInterceptada(m.central, async (metodo, [sentencia], llamar) => {
				const leido = (await llamar()) as RespuestaDeLaCentral<FilasEnBruto>;
				const sql = metodo === "ejecutar" ? (sentencia as SentenciaEnlazada).sql : "";
				if (vistos.length < n && /SELECT \* FROM pair_requests WHERE pair_code=\?/.test(sql) && leido.ok) {
					const { columns, rows } = leido.valor;
					vistos.push({
						status: rows[0]?.[columns.indexOf("status")],
						reclamado: rows[0]?.[columns.indexOf("claimed_by_device_id")],
					});
					if (vistos.length === n) soltar();
					await todas;
				}
				return leido;
			}).db,
		);
		return { aLaVez, vistos };
	}

	it("N equipos reclaman el mismo código: se lo queda uno, y los demás cuentan como intento", async () => {
		const equipos = await Promise.all(Array.from({ length: N }, (_, i) => dispositivo(`handy-${i}`, 30 + i)));
		await conLaCentral(async (m) => {
			const { aLaVez, vistos } = conBarrera(m, N);
			// Cada uno desde su IP: la espera por fallos de una IP es otro freno, y no es el que se prueba.
			const rs = await Promise.all(equipos.map((d, i) => aLaVez.reclamar(d, CODIGO, T0, `10.0.1.${i + 1}`)));

			expect(vistos).toEqual(Array(N).fill({ status: "pending", reclamado: null }));
			const i = rs.findIndex((r) => r.status === 200);
			expect(rs[i].body.state).toBe("pending_approval");
			expect(rs.filter((r) => r !== rs[i]).map((r) => [r.status, r.body.error])).toEqual(
				Array(N - 1).fill([409, "pair_claim_race_or_invalid_state"]),
			);
			// Lo que verá el dueño en la Main es el que lo reclamó, con su clave.
			expect(await m.solicitud(CODIGO)).toMatchObject({
				status: "pending",
				claimed_by_device_id: equipos[i].id,
				claimed_device_pubkey_b64: equipos[i].pub,
				attempts: N - 1,
			});
			// Y sólo él tiene un reto con el que recoger el token.
			expect(await m.filas(`SELECT device_id FROM device_challenges;`)).toEqual([{ device_id: equipos[i].id }]);
		});
	});

	it("la Handy aprobada canjea el código N veces a la vez: sale un token, y el código queda gastado", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);
			// Un reto para cada canje: la Handy vuelve a reclamar su código aprobado y recibe otro.
			const retos = [body.nonceB64];
			while (retos.length < N) retos.push((await m.reclamar(a, CODIGO, T0 + MIN)).body.nonceB64);

			const { aLaVez, vistos } = conBarrera(m, N);
			const rs = await Promise.all(retos.map((reto) => aLaVez.recoger(a, CODIGO, reto, T0 + MIN)));

			expect(vistos).toEqual(Array(N).fill({ status: "approved", reclamado: a.id }));
			const i = rs.findIndex((r) => r.status === 200);
			expect(rs[i].body).toMatchObject({ ok: true, tenantId: TENANT, deviceId: a.id, token: expect.any(String) });
			expect(rs.filter((r) => r !== rs[i]).map((r) => [r.status, r.body.error, r.body.token])).toEqual(
				Array(N - 1).fill([409, "pair_code_used_or_invalid_state", undefined]),
			);
			expect(await m.solicitud(CODIGO)).toMatchObject({ status: "used" });
			expect(await m.filas(`SELECT COUNT(*) AS n FROM devices WHERE device_id = ?;`, a.id)).toEqual([{ n: 1 }]);
		});
	});
});

describe("rechazar en la Main", () => {
	it("la Handy se entera en su siguiente consulta, y el código ya no se puede reclamar", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);

			expect(await rechazarSolicitud(m.db, TENANT, CODIGO, T0 + MIN)).toEqual({
				status: 200,
				cuerpo: { ok: true, state: "rejected" },
			});

			const consulta = await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN);
			expect(consulta.status).toBe(409);
			expect(consulta.body.error).toBe("pair_rejected");
			expect((await m.reclamar(a, CODIGO, T0 + MIN)).body.error).toBe("pair_rejected");
		});
	});

	it("repetir el rechazo no falla; un código de otro negocio se contesta como inexistente", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await m.reclamar(a, CODIGO, T0);
			await rechazarSolicitud(m.db, TENANT, CODIGO, T0);
			expect((await rechazarSolicitud(m.db, TENANT, CODIGO, T0)).status).toBe(200);
			expect((await rechazarSolicitud(m.db, "otro-tenant", OTRO_CODIGO, T0)).cuerpo.error).toBe(
				"pair_code_not_found",
			);
			expect((await rechazarSolicitud(m.db, TENANT, "000000", T0)).status).toBe(404);
		});
	});

	it("no se rechaza lo aprobado ni lo caducado", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0);
			expect((await rechazarSolicitud(m.db, TENANT, CODIGO, T0)).cuerpo.error).toBe("invalid_pair_status");
			expect((await m.solicitud(CODIGO)).status).toBe("approved");

			expect((await rechazarSolicitud(m.db, TENANT, OTRO_CODIGO, T0 + 11 * MIN)).cuerpo.error).toBe(
				"pair_code_expired",
			);
		});
	});
});

describe("cancelar en la Handy", () => {
	it("suelta el código: sale de la lista de la Main y se puede volver a usar", async () => {
		const a = await dispositivo("handy-a", 1);
		const b = await dispositivo("handy-b", 2);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);

			const r = await m.cancelar(a, CODIGO, body.nonceB64, T0 + MIN);
			expect(r.body).toEqual({ ok: true, liberado: true });

			const fila = await m.solicitud(CODIGO);
			expect(fila.status).toBe("pending");
			expect(fila.claimed_by_device_id).toBeNull();
			expect(fila.claimed_device_pubkey_b64).toBeNull();

			expect((await m.reclamar(b, CODIGO, T0 + 2 * MIN, "10.0.0.2")).status).toBe(200);
		});
	});

	it("la misma firma no sirve dos veces", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			const primera = await m.cancelar(a, CODIGO, body.nonceB64, T0 + MIN);
			expect(primera.body.liberado).toBe(true);

			// Soltado el código ya no hay reclamante: la repetición ni llega a mirar la firma, y se
			// contesta como a un código que no existe (AUD-10).
			const repetida = await soltarCodigo(m.db, ENV, cancelSchema.parse(primera.cuerpo), T0 + MIN);
			expect(repetida.status).toBe(404);
			expect(repetida.cuerpo.error).toBe("pair_code_not_found");

			// Y con el claim todavía en pie (aprobado), es el reto gastado lo que la para.
			const otra = await m.reclamar(a, CODIGO, T0 + MIN);
			await m.aprobar(CODIGO, a, T0 + MIN);
			const cancelacion = await m.cancelar(a, CODIGO, otra.body.nonceB64, T0 + MIN);
			const otraVez = await soltarCodigo(m.db, ENV, cancelSchema.parse(cancelacion.cuerpo), T0 + MIN);
			expect(otraVez.status).toBe(409);
			expect(otraVez.cuerpo.error).toBe("challenge_used");
		});
	});

	it("no la puede cancelar otro dispositivo, ni con una firma hecha para otra cosa", async () => {
		const a = await dispositivo("handy-a", 1);
		const b = await dispositivo("handy-b", 2);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);

			expect((await m.cancelar(b, CODIGO, body.nonceB64, T0)).body.error).toBe("pair_code_not_found");
			expect((await m.cancelar(a, CODIGO, body.nonceB64, T0, "PAIR_FETCH")).body.error).toBe(
				"pair_signature_invalid",
			);
			expect((await m.solicitud(CODIGO)).claimed_by_device_id).toBe(a.id);
		});
	});

	it("lo ya aprobado no se deshace cancelando: la Handy lo recoge volviendo a reclamar", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			await m.aprobar(CODIGO, a, T0 + MIN);

			expect((await m.cancelar(a, CODIGO, body.nonceB64, T0 + MIN)).body).toEqual({ ok: true, liberado: false });
			expect((await m.solicitud(CODIGO)).status).toBe("approved");

			const otraVez = await m.reclamar(a, CODIGO, T0 + 2 * MIN);
			expect((await m.recoger(a, CODIGO, otraVez.body.nonceB64, T0 + 2 * MIN)).status).toBe(200);
		});
	});
});

describe("sin ser quien lo reclamó, ningún código existe (AUD-10)", () => {
	// `fetch-token` y `cancel` son anónimas y no tienen freno (la Handy pregunta cada 1,5 s). Antes
	// contestaban según el estado del código ANTES de mirar quién preguntaba: con una prueba
	// inventada, 404 si no existía y `not_approved` si estaba vivo y pendiente, que es justo lo que
	// necesita quien quiere adelantarse a la Handy en el `claim`. Y `approve` le decía a la Main de
	// cualquier negocio si un código se había emitido alguna vez.
	const C = {
		libre: "300001",
		reclamado: "300002",
		caducado: "300003",
		usado: "300004",
		rechazado: "300005",
		aprobado: "300006",
	} as const;

	async function sembrar(m: Mundo, quien: Dispositivo) {
		const codigo = (pairCode: string, status: string, expira: number, reclamado: boolean, usado: number | null = null) =>
			m.filas(
				`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms,
				                            expires_at_ms, claimed_at_ms, claimed_by_device_id, claimed_device_pubkey_b64, used_at_ms)
				 VALUES (?, 'sin-secreto', ?, 'main-1', ?, ?, ?, ?, ?, ?, ?);`,
				pairCode,
				TENANT,
				status,
				expira - 10 * MIN,
				expira,
				reclamado ? T0 - MIN : null,
				reclamado ? quien.id : null,
				reclamado ? quien.pub : null,
				usado,
			);
		await codigo(C.libre, "pending", T0 + 9 * MIN, false);
		await codigo(C.reclamado, "pending", T0 + 9 * MIN, true);
		await codigo(C.caducado, "pending", T0 - MIN, true);
		await codigo(C.usado, "used", T0 + 5 * MIN, true, T0 - 2 * MIN);
		await codigo(C.rechazado, "rejected", T0 + 9 * MIN, true);
		await codigo(C.aprobado, "approved", T0 + 9 * MIN, true);
	}

	/** Lo que manda quien no ha reclamado nada: ni reto ni firma de verdad. */
	const sinPrueba = (pairCode: string, deviceId: string) => ({
		pairCode,
		deviceId,
		nonceB64: "bm9uY2U=",
		sigB64: "x",
		ts: T0,
	});

	it("fetch-token y cancel contestan lo mismo a un código vivo, muerto o inexistente", async () => {
		const handy = await dispositivo("handy-del-bar", 1);
		await conLaCentral(async (m) => {
			await sembrar(m, handy);
			const antes = await m.filas(`SELECT * FROM pair_requests ORDER BY pair_code;`);

			const visto = new Set<string>();
			for (const codigo of ["000100", ...Object.values(C)]) {
				const datos = sinPrueba(codigo, "atacante");
				const ft = await entregarToken(m.db, ENV, fetchTokenSchema.parse(datos), T0);
				const cc = await soltarCodigo(m.db, ENV, cancelSchema.parse(datos), T0);
				visto.add(`${ft.status} ${ft.cuerpo.error}`);
				visto.add(`${cc.status} ${cc.cuerpo.error}`);
			}
			expect([...visto]).toEqual(["404 pair_code_not_found"]);
			expect(await m.filas(`SELECT * FROM pair_requests ORDER BY pair_code;`)).toEqual(antes);
		});
	});

	it("con el deviceId de la Handy pero sin su firma, lo que falla es la prueba, nunca el estado", async () => {
		// Quien conoce el `deviceId` de la Handy (no es un secreto dentro del local) tampoco sabe en
		// qué estado está su código: la firma se mira antes que el estado.
		const handy = await dispositivo("handy-del-bar", 1);
		await conLaCentral(async (m) => {
			await sembrar(m, handy);
			const visto = new Set<string>();
			// Todos los que ha reclamado ella; el libre no es suyo y sale como inexistente (arriba).
			for (const codigo of Object.values(C).filter((c) => c !== C.libre)) {
				const datos = sinPrueba(codigo, handy.id);
				const ft = await entregarToken(m.db, ENV, fetchTokenSchema.parse(datos), T0);
				const cc = await soltarCodigo(m.db, ENV, cancelSchema.parse(datos), T0);
				visto.add(`${ft.status} ${ft.cuerpo.error}`);
				visto.add(`${cc.status} ${cc.cuerpo.error}`);
			}
			expect([...visto]).toEqual(["404 challenge_not_found"]);
		});
	});

	it("approve contesta a la Main de otro negocio como si el código no existiera, igual que reject", async () => {
		const handy = await dispositivo("handy-del-bar", 1);
		await conLaCentral(async (m) => {
			await sembrar(m, handy);
			const antes = await m.filas(`SELECT * FROM pair_requests ORDER BY pair_code;`);
			for (const codigo of ["000100", ...Object.values(C)]) {
				expect(await aprobarSolicitud(m.db, "otro-negocio", codigo, T0)).toEqual({
					status: 404,
					cuerpo: { ok: false, error: "pair_code_not_found" },
				});
			}
			expect(await m.filas(`SELECT * FROM pair_requests ORDER BY pair_code;`)).toEqual(antes);
			// La de su negocio sí la aprueba.
			expect((await aprobarSolicitud(m.db, TENANT, C.reclamado, T0)).status).toBe(200);
		});
	});

	it("la Handy que lo reclamó, con su firma, sigue enterándose de todo", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).body.error).toBe("not_approved");
			await rechazarSolicitud(m.db, TENANT, CODIGO, T0 + MIN);
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).body.error).toBe("pair_rejected");

			const otro = await m.reclamar(a, OTRO_CODIGO, T0);
			expect((await aprobarSolicitud(m.db, TENANT, OTRO_CODIGO, T0 + MIN)).status).toBe(200);
			expect((await m.recoger(a, OTRO_CODIGO, otro.body.nonceB64, T0 + MIN)).status).toBe(200);
			// Recogido el token, el reto está gastado: con él sólo se repite la recogida cuya respuesta se
			// perdió (EMPAREJAR-TOKEN), y lo que se lleva es otro token del mismo alta.
			expect((await m.recoger(a, OTRO_CODIGO, otro.body.nonceB64, T0 + MIN)).body).toMatchObject({ ok: true, deviceId: a.id });
		});
	});
});

describe("una solicitud de quien ya está vinculado", () => {
	// Una Handy vinculada que pulsa «← Vinculación» y vuelve a pedir el mismo negocio con la misma
	// clave conserva su vínculo de antes, y su WebSocket sigue conectando mientras espera. La lista
	// de la Main no puede soltar su solicitud por eso: la Handy la sigue esperando. La que ya no
	// espera nadie (la Handy se cerró esperando) la suelta la Handy al volver a abrirse.
	async function vinculado(m: Mundo, d: Dispositivo, ultimaVez: number) {
		await m.filas(
			`INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms, revoked_at_ms, device_pubkey_b64)
			 VALUES (?, ?, 'handy', ?, ?, NULL, ?);`,
			d.id,
			TENANT,
			T0 - 60 * MIN,
			ultimaVez,
			d.pub,
		);
	}
	async function pendientes(m: Mundo, ahora: number): Promise<string[]> {
		const r = await solicitudesPendientes(m.db, TENANT, ahora);
		return ((r.cuerpo as any).items as any[]).map((i) => i.claimedDeviceId);
	}

	it("sigue en la lista aunque su WebSocket vuelva a conectar mientras espera", async () => {
		const a = await dispositivo("handy-a", 1);
		await conLaCentral(async (m) => {
			await vinculado(m, a, T0 - 30 * MIN);
			await m.reclamar(a, CODIGO, T0 + MIN);
			expect(await pendientes(m, T0 + MIN)).toEqual([a.id]);

			// Mientras espera, su socket reconecta con el token de antes (`ws/canje.ts`).
			await m.filas(`UPDATE devices SET last_seen_at_ms=? WHERE device_id=?;`, T0 + 2 * MIN, a.id);
			expect(await pendientes(m, T0 + 3 * MIN)).toEqual([a.id]);
			expect((await m.solicitud(CODIGO)).claimed_by_device_id).toBe(a.id);
		});
	});
});

describe("el filtro exterior del claim", () => {
	// No es un control de seguridad (cuenta por centro de datos): es lo que evita que un barrido
	// pague una lectura de la base central por intento. Su valor vive en `wrangler.json`, así que lo único
	// que se puede comprobar aquí es que sigue ahí y que dice lo mismo que el código.
	it("sigue declarado en wrangler.json, con el número que dice el código", () => {
		const limitadores = (configuracionDelWorker as any).ratelimits ?? [];
		const claim = limitadores.find((l: any) => l.name === "LIMITADOR_CLAIM");

		expect(claim, "sin este binding el filtro se abre y nada lo dice").toBeTruthy();
		expect(claim.simple.limit).toBe(PETICIONES_POR_MINUTO);
		// El binding sólo admite 10 o 60. Si alguien pone otra cosa, el despliegue falla.
		expect(claim.simple.period).toBe(60);
	});

	it("sin binding se deja pasar, porque detrás hay un control exacto", async () => {
		expect(await pasaElFiltroExterior({}, "10.0.0.1")).toBe(true);
	});

	it("un binding que revienta tampoco cierra la puerta", async () => {
		const roto = {
			LIMITADOR_CLAIM: {
				limit: () => Promise.reject(new Error("edge caído")),
			} as any,
		};
		expect(await pasaElFiltroExterior(roto, "10.0.0.1")).toBe(true);
	});

	it("corta cuando el limitador lo dice, y con la IP como clave", async () => {
		const vistas: string[] = [];
		const lleno = {
			LIMITADOR_CLAIM: {
				limit: ({ key }: { key: string }) => {
					vistas.push(key);
					return Promise.resolve({ success: false });
				},
			} as any,
		};
		expect(await pasaElFiltroExterior(lleno, "9.9.9.9")).toBe(false);
		expect(vistas).toEqual(["9.9.9.9"]);
	});

	it("un claim normal no lo nota: el freno exacto sigue siendo el que contesta", async () => {
		// Con el limitador lleno la respuesta es 429 SIN mirar la tabla; con él abierto, el 404 de
		// siempre. Es la prueba de que es una capa delante y no un reemplazo.
		const a = await dispositivo("handy-a", 1);
		const { cortado, pasado } = await conLaCentral(async (m) => {
			// Por la RUTA y no por la función: desde ARQ-03 el filtro es un middleware que va
			// delante del validador del cuerpo, y lo que se prueba es justo ese orden.
			const peticionDe = (env: any) =>
				elWorker.fetch(
					peticion("claim", { pairCode: "000001", pairSecret: "", deviceId: a.id, devicePubKey: a.pub, deviceName: "" }, "7.7.7.7"),
					env,
				);

			const lleno = { ...ENV, ...m.central.entorno, LIMITADOR_CLAIM: { limit: () => Promise.resolve({ success: false }) } };
			const abierto = { ...ENV, ...m.central.entorno, LIMITADOR_CLAIM: { limit: () => Promise.resolve({ success: true }) } };

			const r1 = await peticionDe(lleno);
			const r2 = await peticionDe(abierto);
			return { cortado: r1.status, pasado: r2.status };
		});

		expect(cortado).toBe(429);
		expect(pasado).toBe(404);
	});
});

describe("crear códigos (AUD-12)", () => {
	/**
	 * Fija lo que devuelve `crypto.getRandomValues`: el secreto (32 bytes) se rellena con 7 y cada
	 * sorteo de 4 bytes da el siguiente número de `numeros` (n < 2^24, así que n % 10^6 = n).
	 */
	function fijarSorteo(numeros: number[]) {
		let i = 0;
		return vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: any) => {
			if (a.length === 4) {
				const n = numeros[Math.min(i++, numeros.length - 1)];
				a[0] = 0;
				a[1] = (n >> 16) & 0xff;
				a[2] = (n >> 8) & 0xff;
				a[3] = n & 0xff;
				return a;
			}
			return a.fill(7);
		}) as any);
	}

	it("un número que la purga ha liberado vuelve a salir", async () => {
		const { purgarBaseCentral, RETENCION_CODIGOS_MS } = await import("../src/server/purga");
		await conLaCentral(async (m) => {
			await m.filas(
				`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
				 VALUES ('000123', 'x', 'otro-negocio', 'main-otro', 'used', ?, ?);`,
				T0 - RETENCION_CODIGOS_MS - 20 * MIN,
				T0 - RETENCION_CODIGOS_MS - 10 * MIN,
			);
			const sorteo = fijarSorteo([123]);
			try {
				expect((await crearCodigo(m.db, ENV, TENANT, "main-1", T0)).status).toBe(500);
				await purgarBaseCentral(m.db, T0);
				const r = await crearCodigo(m.db, ENV, TENANT, "main-1", T0);
				expect(r.status).toBe(200);
				expect(r.cuerpo.pairCode).toBe("000123");
			} finally {
				sorteo.mockRestore();
			}
		});
	});

	it("un negocio no tiene más de 20 vivos a la vez; caducados, vuelve a crear, y a otro no le afecta", async () => {
		await conLaCentral(async (m) => {
			// La central del caso trae ya dos códigos vivos del negocio.
			for (let i = 0; i < 18; i++) {
				expect((await crearCodigo(m.db, ENV, TENANT, "main-1", T0 + i)).status).toBe(200);
			}
			const vigesimoprimero = await crearCodigo(m.db, ENV, TENANT, "main-1", T0 + 30);
			expect(vigesimoprimero.status).toBe(429);
			expect(vigesimoprimero.cuerpo).toMatchObject({ ok: false, error: "too_many_attempts" });
			expect(vigesimoprimero.cuerpo.message).toMatch(/espera unos minutos/);
			expect((await m.filas(`SELECT COUNT(*) AS n FROM pair_requests WHERE tenant_id = ?;`, TENANT))[0].n).toBe(20);

			expect((await crearCodigo(m.db, ENV, "otro-negocio", "main-otro", T0 + 30)).status).toBe(200);

			// Pasados sus diez minutos, los veinte ya no cuentan.
			expect((await crearCodigo(m.db, ENV, TENANT, "main-1", T0 + 10 * MIN + 30)).status).toBe(200);
		});
	});
});

