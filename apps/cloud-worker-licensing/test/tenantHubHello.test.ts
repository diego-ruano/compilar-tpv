// test/tenantHubHello.test.ts
//
// `verifyHelloSigned` — el control que decide si un WebSocket entrante es quien dice ser.
//
// Es la puerta de entrada al hub: pasado este punto el dispositivo puede escribir en la base
// de datos del tenant y recibir el flujo de cambios de todo el negocio. No tenía tests.
//
// Los casos se han pensado como los pensaría alguien intentando colarse, no leyendo la
// implementación: reutilizar una firma vieja, firmar con la propia clave y adjuntarla,
// declararse "tpv" para escribir, aprovechar una firma emitida para otro dispositivo del
// mismo negocio, o estirar la ventana de tiempo.
//
// `loadDeviceFromCentral` (que va a la BD central) se sustituye en la instancia para poder
// controlar qué dice el registro del dispositivo. Todo lo demás es el código real.

import { describe, it, expect, beforeAll } from "vitest";

import { enElHub } from "./helpers/hub";

import { bytesToB64 } from "../src/server/utils/base64";
import type { HelloSignedMsg, Role } from "../src/durableObjects/tenantHub.types";

const TENANT = "tenant-1";
const DEVICE = "device-1";

type Central = { revoked: boolean; pubkeyB64: string | null; role: Role };

let claves: CryptoKeyPair;
let otrasClaves: CryptoKeyPair;
let PUB: string;
let PUB_OTRA: string;

async function pubB64(kp: CryptoKeyPair): Promise<string> {
	// `exportKey` está tipado como `ArrayBuffer | JsonWebKey` (una sola firma, sin sobrecarga
	// por formato): con "raw" siempre es lo primero.
	const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
	return bytesToB64(new Uint8Array(raw));
}

beforeAll(async () => {
	claves = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	otrasClaves = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;

	PUB = await pubB64(claves);
	PUB_OTRA = await pubB64(otrasClaves);
});

/** Firma el payload EXACTO que el hub reconstruye para verificar. */
async function firmar(
	kp: CryptoKeyPair,
	ts: number,
	tenantId: string,
	deviceId: string,
	nonceB64: string,
): Promise<string> {
	const payload = new TextEncoder().encode(
		`${ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${nonceB64}`,
	);
	const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, payload);
	return bytesToB64(new Uint8Array(sig));
}

function challengeVivo(nonceB64 = "nonce-abc") {
	return { nonceB64, expiresAtMs: Date.now() + 60_000 };
}

async function verificar(params: {
	msg: HelloSignedMsg;
	challenge: { nonceB64: string; expiresAtMs: number } | null;
	pubkeyB64Hint?: string | null;
	central: Central;
	tenantId?: string;
	deviceId?: string;
}) {
	// El error se captura DENTRO del Durable Object: si se deja escapar, el runtime lo
	// contabiliza como fallo no gestionado aunque el test lo espere, y la suite acaba en rojo
	// con todos los casos en verde.
	const res: any = await enElHub("tenant-hello-test", async (hub) => {
		hub.loadDeviceFromCentral = async () => params.central;
		try {
			return {
				ok: true,
				out: await hub.verifyHelloSigned({
					tenantId: params.tenantId ?? TENANT,
					deviceId: params.deviceId ?? DEVICE,
					msg: params.msg,
					challenge: params.challenge,
					pubkeyB64Hint: params.pubkeyB64Hint ?? null,
				}),
			};
		} catch (e: any) {
			return { ok: false, error: String(e?.message ?? e) };
		}
	});

	if (!res.ok) throw new Error(res.error);
	return res.out;
}

async function verificarFalla(params: Parameters<typeof verificar>[0]): Promise<string> {
	try {
		await verificar(params);
		return "__acepto__";
	} catch (e: any) {
		return String(e?.message ?? e);
	}
}

/** Un hello legítimo, listo para que cada test lo estropee a su manera. */
async function helloValido(over: Partial<HelloSignedMsg> = {}, nonce = "nonce-abc") {
	const ts = Date.now();
	return {
		type: "helloSigned" as const,
		ts,
		nonceB64: nonce,
		sigB64: await firmar(claves, ts, TENANT, DEVICE, nonce),
		...over,
	};
}

const CENTRAL_OK: Central = { revoked: false, pubkeyB64: null, role: "tpv" };

describe("verifyHelloSigned · camino legítimo", () => {
	it("acepta un hello bien firmado", async () => {
		const out = await verificar({
			msg: await helloValido(),
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: CENTRAL_OK,
		});

		expect(out.roleFinal).toBe("tpv");
		expect(out.pubkeyB64).toBe(PUB);
	});

	it("usa la clave registrada en la central aunque el cliente no mande pista", async () => {
		const out = await verificar({
			msg: await helloValido(),
			challenge: challengeVivo(),
			pubkeyB64Hint: null,
			central: { revoked: false, pubkeyB64: PUB, role: "handy" },
		});

		expect(out.pubkeyB64).toBe(PUB);
		expect(out.roleFinal).toBe("handy");
	});
});

describe("verifyHelloSigned · suplantación", () => {
	/* El ataque evidente: firmo con MI clave y adjunto MI clave pública como "pista".
	   Si el hub se fiara de la pista, cualquiera entraría como cualquier dispositivo. La
	   clave de la central tiene que ganar SIEMPRE. */
	it("la clave de la central pisa la que propone el cliente", async () => {
		const ts = Date.now();
		const msg: HelloSignedMsg = {
			type: "helloSigned",
			ts,
			nonceB64: "nonce-abc",
			sigB64: await firmar(otrasClaves, ts, TENANT, DEVICE, "nonce-abc"),
		};

		const msgErr = await verificarFalla({
			msg,
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB_OTRA, // el atacante propone su propia clave
			central: { revoked: false, pubkeyB64: PUB, role: "tpv" }, // la real es otra
			});

		expect(msgErr).toBe("bad_ws_signature");
	});

	it("una firma hecha con otra clave se rechaza", async () => {
		const ts = Date.now();
		const msgErr = await verificarFalla({
			msg: {
				type: "helloSigned",
				ts,
				nonceB64: "nonce-abc",
				sigB64: await firmar(otrasClaves, ts, TENANT, DEVICE, "nonce-abc"),
			},
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: CENTRAL_OK,
		});

		expect(msgErr).toBe("bad_ws_signature");
	});

	/* Una firma es válida para UNA combinación de tenant, dispositivo, nonce y momento.
	   Si cualquiera de esas piezas pudiera cambiarse conservando la firma, un dispositivo
	   podría hacerse pasar por otro del mismo negocio. */
	it("una firma emitida para OTRO dispositivo no vale", async () => {
		const ts = Date.now();
		const msgErr = await verificarFalla({
			msg: {
				type: "helloSigned",
				ts,
				nonceB64: "nonce-abc",
				sigB64: await firmar(claves, ts, TENANT, "otro-device", "nonce-abc"),
			},
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: CENTRAL_OK,
		});

		expect(msgErr).toBe("bad_ws_signature");
	});

	it("una firma emitida para OTRO tenant no vale", async () => {
		const ts = Date.now();
		const msgErr = await verificarFalla({
			msg: {
				type: "helloSigned",
				ts,
				nonceB64: "nonce-abc",
				sigB64: await firmar(claves, ts, "otro-tenant", DEVICE, "nonce-abc"),
			},
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: CENTRAL_OK,
		});

		expect(msgErr).toBe("bad_ws_signature");
	});

	it("cambiar el ts invalida la firma", async () => {
		const ts = Date.now();
		const msgErr = await verificarFalla({
			msg: {
				type: "helloSigned",
				ts: ts + 1, // dentro de la ventana, pero ya no es lo firmado
				nonceB64: "nonce-abc",
				sigB64: await firmar(claves, ts, TENANT, DEVICE, "nonce-abc"),
			},
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: CENTRAL_OK,
		});

		expect(msgErr).toBe("bad_ws_signature");
	});

	it("una firma que no es ni base64 válido se rechaza sin reventar", async () => {
		for (const sigB64 of ["", "no-es-base64!!", "AAAA"]) {
			const msgErr = await verificarFalla({
				msg: { type: "helloSigned", ts: Date.now(), nonceB64: "nonce-abc", sigB64 },
				challenge: challengeVivo(),
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			});

			expect(msgErr, `sig=${sigB64}`).not.toBe("__acepto__");
		}
	});
});

describe("verifyHelloSigned · escalada de privilegios", () => {
	/* El rol decide si el dispositivo puede escribir. Si lo dictara el mensaje, una Handy
	   se declararía "tpv" y tendría permiso de escritura sobre todo el negocio. */
	it("el rol que pide el mensaje se ignora: manda la central", async () => {
		const out = await verificar({
			msg: await helloValido({ role: "tpv" }),
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: { revoked: false, pubkeyB64: PUB, role: "handy" },
		});

		expect(out.roleFinal).toBe("handy");
	});

	it("si la central no le da rol, se queda sin permisos", async () => {
		const out = await verificar({
			msg: await helloValido({ role: "tpv" }),
			challenge: challengeVivo(),
			pubkeyB64Hint: PUB,
			central: { revoked: false, pubkeyB64: PUB, role: "unknown" },
		});

		expect(out.roleFinal).toBe("unknown");
	});
});

describe("verifyHelloSigned · challenge", () => {
	it("sin challenge no se entra", async () => {
		expect(
			await verificarFalla({
				msg: await helloValido(),
				challenge: null,
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			}),
		).toBe("missing_challenge");
	});

	/* SYNC-07: el nonce ata la firma a ESTA conexión. Si valiera un nonce distinto del
	   emitido, una firma capturada serviría para abrir una sesión nueva. */
	it("un nonce distinto del emitido se rechaza", async () => {
		expect(
			await verificarFalla({
				msg: await helloValido({}, "nonce-del-atacante"),
				challenge: challengeVivo("nonce-abc"),
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			}),
		).toBe("challenge_mismatch");
	});

	it("un challenge caducado se rechaza", async () => {
		expect(
			await verificarFalla({
				msg: await helloValido(),
				challenge: { nonceB64: "nonce-abc", expiresAtMs: Date.now() - 1 },
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			}),
		).toBe("challenge_expired");
	});

	it("el nonce se comprueba antes que la firma", async () => {
		// Si el orden fuera el contrario, se gastaría CPU verificando firmas de cualquiera
		// que mande basura: un buen vector de agotamiento.
		expect(
			await verificarFalla({
				msg: { type: "helloSigned", ts: Date.now(), nonceB64: "otro", sigB64: "basura" },
				challenge: challengeVivo("nonce-abc"),
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			}),
		).toBe("challenge_mismatch");
	});
});

describe("verifyHelloSigned · ventana de tiempo", () => {
	it("acepta la deriva razonable de reloj a ambos lados", async () => {
		for (const desfase of [-90_000, -1_000, 0, 1_000, 90_000]) {
			const ts = Date.now() + desfase;
			const out = await verificar({
				msg: {
					type: "helloSigned",
					ts,
					nonceB64: "nonce-abc",
					sigB64: await firmar(claves, ts, TENANT, DEVICE, "nonce-abc"),
				},
				challenge: challengeVivo(),
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			});

			expect(out.roleFinal, `desfase ${desfase}`).toBe("tpv");
		}
	});

	it("rechaza un ts demasiado viejo o demasiado futuro", async () => {
		for (const desfase of [-10 * 60_000, 10 * 60_000]) {
			const ts = Date.now() + desfase;
			const msgErr = await verificarFalla({
				msg: {
					type: "helloSigned",
					ts,
					nonceB64: "nonce-abc",
					sigB64: await firmar(claves, ts, TENANT, DEVICE, "nonce-abc"),
				},
				challenge: challengeVivo(),
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			});

			expect(msgErr, `desfase ${desfase}`).toBe("ts_out_of_range");
		}
	});

	it("un ts que no es un número finito se rechaza", async () => {
		for (const ts of [NaN, Infinity, -Infinity]) {
			const msgErr = await verificarFalla({
				msg: { type: "helloSigned", ts, nonceB64: "nonce-abc", sigB64: "x" },
				challenge: challengeVivo(),
				pubkeyB64Hint: PUB,
				central: CENTRAL_OK,
			});

			expect(msgErr, `ts=${ts}`).toBe("bad_ts");
		}
	});
});

describe("verifyHelloSigned · estado del dispositivo", () => {
	it("un dispositivo revocado no entra ni con la firma correcta", async () => {
		expect(
			await verificarFalla({
				msg: await helloValido(),
				challenge: challengeVivo(),
				pubkeyB64Hint: PUB,
				central: { revoked: true, pubkeyB64: PUB, role: "tpv" },
			}),
		).toBe("device_revoked");
	});

	it("sin clave registrada en ningún sitio, no entra", async () => {
		expect(
			await verificarFalla({
				msg: await helloValido(),
				challenge: challengeVivo(),
				pubkeyB64Hint: null,
				central: { revoked: false, pubkeyB64: null, role: "tpv" },
			}),
		).toBe("device_pubkey_not_registered");
	});

	it("una pista en blanco no cuenta como clave", async () => {
		expect(
			await verificarFalla({
				msg: await helloValido(),
				challenge: challengeVivo(),
				pubkeyB64Hint: "   ",
				central: { revoked: false, pubkeyB64: null, role: "tpv" },
			}),
		).toBe("device_pubkey_not_registered");
	});
});

describe("issueChallenge", () => {
	async function emitir() {
		return enElHub("tenant-hello-test", (hub) => hub.issueChallenge());
	}

	it("emite un nonce de 32 bytes", async () => {
		const { nonceB64 } = await emitir();
		expect(atob(nonceB64).length).toBe(32);
	});

	it("nunca repite un nonce", async () => {
		// Un nonce repetido convertiría una firma capturada en reutilizable.
		const vistos = new Set<string>();
		for (let i = 0; i < 50; i++) {
			vistos.add((await emitir()).nonceB64);
		}
		expect(vistos.size).toBe(50);
	});

	it("caduca en el futuro y no demasiado lejos", async () => {
		const { expiresAtMs } = await emitir();
		const margen = expiresAtMs - Date.now();

		expect(margen).toBeGreaterThan(0);
		expect(margen).toBeLessThanOrEqual(5 * 60_000);
	});
});
