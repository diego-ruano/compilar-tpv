// test/emparejamiento.test.ts
//
// Vincular una Handy de principio a fin, contra el SQL de verdad (el SQLite de un Durable Object
// con la estructura de producción, `helpers/planoDeControl.ts`) y con firmas ed25519 reales.
//
// Lo que se fija, y el fallo de antes que evita cada cosa:
//   · La espera por fallos crece por tramos (3 → 30 s, 6 → 5 min, 9 → 30 min). Antes había 30
//     intentos por minuto sin más, y ni un error de dedo ni un barrido se distinguían.
//   · El reto vive lo que el código. Caducaba a los 2 minutos mientras la Handy esperaba 3: si la
//     Main aprobaba entre medias, el código quedaba gastado y nadie recogía el token.
//   · Un dispositivo aprobado puede volver a reclamar su código y recoger el token.
//   · La Main puede rechazar, y la Handy se entera en la siguiente consulta.
//   · La Handy puede cancelar, y la solicitud deja de estar en la lista de la Main.

import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { handlePairClaim } from "../src/server/endpoints/rest/pairing/pairClaim";
import { handlePairFetchToken } from "../src/server/endpoints/rest/pairing/pairFetchToken";
import { handlePairCancel } from "../src/server/endpoints/rest/pairing/pairCancel";
import { rechazarSolicitud } from "../src/server/endpoints/rest/pairing/pairReject";
import {
	OLVIDO_MS,
	esperaTrasFallos,
	textoDeEspera,
} from "../src/server/endpoints/rest/pairing/pairing.intentos";
import { mensajeFirmado, type AccionFirmada } from "../src/server/endpoints/rest/pairing/pairing.firma";
import { ensureEd25519Sha512 } from "../src/server/utils/nobleEd25519";
import { bytesToB64 } from "../src/server/utils/base64";

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

/** Un control-plane vacío con dos códigos del mismo negocio, que caducan a los 10 minutos. */
async function conPlanoDeControl<R>(nombre: string, prueba: (m: Mundo) => Promise<R>): Promise<R> {
	return enElHub(`emparejamiento-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql);
		prepararPlanoDeControl(sql);
		for (const tabla of ["pair_requests", "device_challenges", "pair_claim_fallos", "devices", "licenses", "tenants"]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}
		// `fetch-token` necesita el negocio, su licencia activa y, al aprobar, el dispositivo.
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, status, term_months, origin,
			                       issued_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES ('lic-1', 'hash-licencia', ?, 'active', 12, 'manual', ?, 'bar@ejemplo.test', ?, ?);`,
			TENANT,
			T0,
			T0,
			T0,
		);
		for (const codigo of [CODIGO, OTRO_CODIGO]) {
			sql.exec(
				`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
				 VALUES (?, 'sin-secreto', ?, 'main-1', 'pending', ?, ?);`,
				codigo,
				TENANT,
				T0,
				T0 + 10 * MIN,
			);
		}
		return prueba(new Mundo(sql, db));
	});
}

class Mundo {
	constructor(
		readonly sql: any,
		readonly db: any,
	) {}

	async reclamar(d: Dispositivo, codigo: string, ahora: number, ip = "10.0.0.1") {
		const res = await handlePairClaim(
			peticion("claim", { pairCode: codigo, pairSecret: "", deviceId: d.id, devicePubKey: d.pub, deviceName: "" }, ip),
			ENV,
			this.db,
			ahora,
		);
		return { status: res.status, body: (await res.json()) as any };
	}

	async recoger(d: Dispositivo, codigo: string, nonceB64: string, ahora: number, accion: AccionFirmada = "PAIR_FETCH") {
		const res = await handlePairFetchToken(
			peticion("fetch-token", {
				pairCode: codigo,
				deviceId: d.id,
				nonceB64,
				ts: ahora,
				sigB64: await firmar(d, accion, ahora, codigo, nonceB64),
			}),
			ENV,
			this.db,
			ahora,
		);
		return { status: res.status, body: (await res.json()) as any };
	}

	async cancelar(d: Dispositivo, codigo: string, nonceB64: string, ahora: number, accion: AccionFirmada = "PAIR_CANCEL") {
		const cuerpo = {
			pairCode: codigo,
			deviceId: d.id,
			nonceB64,
			ts: ahora,
			sigB64: await firmar(d, accion, ahora, codigo, nonceB64),
		};
		const res = await handlePairCancel(peticion("cancel", cuerpo), ENV, this.db, ahora);
		return { status: res.status, body: (await res.json()) as any, cuerpo };
	}

	/** Lo que hace `pairApprove` después de autenticar a la Main: marcar el código, nada más. */
	aprobar(codigo: string, _d: Dispositivo, ahora: number) {
		this.sql.exec(`UPDATE pair_requests SET status='approved', approved_at_ms=? WHERE pair_code=?;`, ahora, codigo);
	}

	dispositivoRegistrado(d: Dispositivo): any {
		return this.sql.exec(`SELECT * FROM devices WHERE device_id=?;`, d.id).toArray()[0];
	}

	solicitud(codigo: string): any {
		return this.sql.exec(`SELECT * FROM pair_requests WHERE pair_code=?;`, codigo).toArray()[0];
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
		await conPlanoDeControl("tramo-1", async (m) => {
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
			expect(m.solicitud(CODIGO).claimed_by_device_id).toBeNull();

			expect((await m.reclamar(a, CODIGO, T0 + 30_000)).status).toBe(200);
		});
	});

	it("los tramos siguientes: 5 minutos al sexto fallo y media hora al noveno", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("tramos", async (m) => {
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

	it("emparejar bien borra la cuenta", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("olvido-exito", async (m) => {
			await m.reclamar(a, "000001", T0);
			await m.reclamar(a, "000002", T0);
			expect((await m.reclamar(a, CODIGO, T0)).status).toBe(200);
			// Si la cuenta siguiera en 2, este sería el tercer fallo.
			expect((await m.reclamar(a, "000003", T0)).status).toBe(404);
			expect((await m.reclamar(a, "000004", T0)).status).toBe(404);
		});
	});

	it("un día sin fallar también la borra", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("olvido-dia", async (m) => {
			await m.reclamar(a, "000001", T0);
			await m.reclamar(a, "000002", T0);
			const dia = T0 + OLVIDO_MS + 1;
			expect((await m.reclamar(a, "000003", dia)).status).toBe(404);
			expect((await m.reclamar(a, "000004", dia)).status).toBe(404);
			expect((await m.reclamar(a, "000005", dia)).status).toBe(429);
		});
	});

	it("cada IP lleva su cuenta", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("por-ip", async (m) => {
			for (const codigo of ["000001", "000002", "000003"]) await m.reclamar(a, codigo, T0, "10.0.0.1");
			expect((await m.reclamar(a, CODIGO, T0, "10.0.0.1")).status).toBe(429);
			expect((await m.reclamar(a, CODIGO, T0, "10.0.0.2")).status).toBe(200);
		});
	});

	it("una petición mal formada no cuenta como fallo: es un cliente roto, no alguien probando", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("mal-formada", async (m) => {
			for (let i = 0; i < 5; i++) expect((await m.reclamar(a, "12", T0)).status).toBe(400);
			expect((await m.reclamar(a, CODIGO, T0)).status).toBe(200);
		});
	});
});

describe("el reto y la recogida del token", () => {
	it("el reto vive lo que el código, y la Handy recibe cuánto le queda en relativo", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("reto", async (m) => {
			const r = await m.reclamar(a, CODIGO, T0 + 2 * MIN);
			expect(r.body.nonceExpiresAtMs).toBe(T0 + 10 * MIN);
			expect(r.body.caducaEnMs).toBe(8 * MIN);
		});
	});

	it("una aprobación a los cinco minutos todavía entrega el token", async () => {
		// Con el reto de dos minutos de antes, esto era `challenge_expired` y el código se perdía.
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("aprobacion-tardia", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).body.error).toBe("not_approved");

			m.aprobar(CODIGO, a, T0 + 5 * MIN);
			const token = await m.recoger(a, CODIGO, body.nonceB64, T0 + 5 * MIN);
			expect(token.status).toBe(200);
			expect(token.body).toMatchObject({ ok: true, tenantId: TENANT, deviceId: a.id });
			expect(m.solicitud(CODIGO).status).toBe("used");
		});
	});

	it("el dispositivo se da de alta al recoger el token, no al aprobar", async () => {
		// Dado de alta al aprobar, una aprobación que nadie recogía dejaba un Handy fantasma en la
		// lista de vinculados de la Main.
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("alta-al-recoger", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0 + MIN);
			expect(m.dispositivoRegistrado(a)).toBeUndefined();

			expect((await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN)).status).toBe(200);
			expect(m.dispositivoRegistrado(a)).toMatchObject({
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
		await conPlanoDeControl("revocado-vuelve", async (m) => {
			m.sql.exec(`INSERT INTO devices (device_id, tenant_id, role, revoked_at_ms, device_pubkey_b64)
				VALUES (?, ?, 'handy', ?, ?);`, antes.id, TENANT, T0 - MIN, antes.pub);

			const { body } = await m.reclamar(ahora, CODIGO, T0);
			m.aprobar(CODIGO, ahora, T0);
			expect((await m.recoger(ahora, CODIGO, body.nonceB64, T0)).status).toBe(200);
			expect(m.dispositivoRegistrado(ahora)).toMatchObject({ revoked_at_ms: null, device_pubkey_b64: ahora.pub });
		});
	});

	it("una aprobación que nadie recoge no deja ningún dispositivo", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("sin-recoger", async (m) => {
			await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0 + MIN);
			// El código caduca sin que la Handy vuelva.
			expect((await m.reclamar(a, CODIGO, T0 + 11 * MIN)).body.error).toBe("pair_code_expired");
			expect(m.sql.exec(`SELECT COUNT(*) AS n FROM devices;`).toArray()[0].n).toBe(0);
		});
	});

	it("el dispositivo aprobado puede volver a reclamar su código y recoger el token", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("reclamar-aprobado", async (m) => {
			await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0 + MIN);

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
		await conPlanoDeControl("robo-de-dispositivo", async (m) => {
			m.sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('tenant-de-la-victima');`);
			m.sql.exec(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
				 VALUES (?, 'tenant-de-la-victima', 'tpv', ?, 'ed25519');`,
				victima.id,
				victima.pub,
			);

			const { body } = await m.reclamar(atacante, CODIGO, T0);
			m.aprobar(CODIGO, atacante, T0);
			const r = await m.recoger(atacante, CODIGO, body.nonceB64, T0);

			expect(r.status).toBe(409);
			expect(r.body.error).toBe("device_key_mismatch");

			// Y la fila de la víctima, intacta: ni de negocio, ni de rol, ni de clave.
			expect(m.dispositivoRegistrado(victima)).toMatchObject({
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
		await conPlanoDeControl("mudanza-legitima", async (m) => {
			m.sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('su-negocio-de-antes');`);
			m.sql.exec(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
				 VALUES (?, 'su-negocio-de-antes', 'tpv', ?, 'ed25519');`,
				equipo.id,
				equipo.pub,
			);

			const { body } = await m.reclamar(equipo, CODIGO, T0);
			m.aprobar(CODIGO, equipo, T0);
			expect((await m.recoger(equipo, CODIGO, body.nonceB64, T0)).status).toBe(200);

			expect(m.dispositivoRegistrado(equipo)).toMatchObject({
				tenant_id: TENANT,
				role: "handy",
				device_pubkey_b64: equipo.pub,
			});
		});
	});

	it("un código aprobado para otro dispositivo no sirve, ni con el mismo id y otra clave", async () => {
		const a = await dispositivo("handy-a", 1);
		const b = await dispositivo("handy-b", 2);
		const suplantador = { ...(await dispositivo("handy-a", 3)), id: "handy-a" };
		await conPlanoDeControl("aprobado-otro", async (m) => {
			await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0 + MIN);

			expect((await m.reclamar(b, CODIGO, T0 + 2 * MIN, "10.0.0.2")).body.error).toBe("pair_code_already_approved");
			expect((await m.reclamar(suplantador, CODIGO, T0 + 2 * MIN, "10.0.0.3")).body.error).toBe(
				"device_pubkey_mismatch",
			);
		});
	});

	it("la firma de una cancelación no sirve para recoger el token", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("firma-accion", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0 + MIN);
			const r = await m.recoger(a, CODIGO, body.nonceB64, T0 + MIN, "PAIR_CANCEL");
			expect(r.body.error).toBe("bad_device_signature");
			expect(m.solicitud(CODIGO).status).toBe("approved");
		});
	});
});

describe("rechazar en la Main", () => {
	it("la Handy se entera en su siguiente consulta, y el código ya no se puede reclamar", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("rechazo", async (m) => {
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
		await conPlanoDeControl("rechazo-bordes", async (m) => {
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
		await conPlanoDeControl("rechazo-estados", async (m) => {
			await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0);
			expect((await rechazarSolicitud(m.db, TENANT, CODIGO, T0)).cuerpo.error).toBe("invalid_pair_status");
			expect(m.solicitud(CODIGO).status).toBe("approved");

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
		await conPlanoDeControl("cancelar", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);

			const r = await m.cancelar(a, CODIGO, body.nonceB64, T0 + MIN);
			expect(r.body).toEqual({ ok: true, liberado: true });

			const fila = m.solicitud(CODIGO);
			expect(fila.status).toBe("pending");
			expect(fila.claimed_by_device_id).toBeNull();
			expect(fila.claimed_device_pubkey_b64).toBeNull();

			expect((await m.reclamar(b, CODIGO, T0 + 2 * MIN, "10.0.0.2")).status).toBe(200);
		});
	});

	it("la misma firma no sirve dos veces", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("cancelar-replay", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			const primera = await m.cancelar(a, CODIGO, body.nonceB64, T0 + MIN);
			expect(primera.body.liberado).toBe(true);

			// Soltado el código ya no hay reclamante: la repetición ni llega a mirar la firma.
			const repetida = await handlePairCancel(peticion("cancel", primera.cuerpo), ENV, m.db, T0 + MIN);
			expect(repetida.status).toBe(403);

			// Y con el claim todavía en pie (aprobado), es el reto gastado lo que la para.
			const otra = await m.reclamar(a, CODIGO, T0 + MIN);
			m.aprobar(CODIGO, a, T0 + MIN);
			const cancelacion = await m.cancelar(a, CODIGO, otra.body.nonceB64, T0 + MIN);
			const otraVez = await handlePairCancel(peticion("cancel", cancelacion.cuerpo), ENV, m.db, T0 + MIN);
			expect(otraVez.status).toBe(409);
			expect(((await otraVez.json()) as any).error).toBe("challenge_used");
		});
	});

	it("no la puede cancelar otro dispositivo, ni con una firma hecha para otra cosa", async () => {
		const a = await dispositivo("handy-a", 1);
		const b = await dispositivo("handy-b", 2);
		await conPlanoDeControl("cancelar-ajeno", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);

			expect((await m.cancelar(b, CODIGO, body.nonceB64, T0)).body.error).toBe("device_mismatch");
			expect((await m.cancelar(a, CODIGO, body.nonceB64, T0, "PAIR_FETCH")).body.error).toBe(
				"bad_device_signature",
			);
			expect(m.solicitud(CODIGO).claimed_by_device_id).toBe(a.id);
		});
	});

	it("lo ya aprobado no se deshace cancelando: la Handy lo recoge volviendo a reclamar", async () => {
		const a = await dispositivo("handy-a", 1);
		await conPlanoDeControl("cancelar-aprobado", async (m) => {
			const { body } = await m.reclamar(a, CODIGO, T0);
			m.aprobar(CODIGO, a, T0 + MIN);

			expect((await m.cancelar(a, CODIGO, body.nonceB64, T0 + MIN)).body).toEqual({ ok: true, liberado: false });
			expect(m.solicitud(CODIGO).status).toBe("approved");

			const otraVez = await m.reclamar(a, CODIGO, T0 + 2 * MIN);
			expect((await m.recoger(a, CODIGO, otraVez.body.nonceB64, T0 + 2 * MIN)).status).toBe(200);
		});
	});
});
