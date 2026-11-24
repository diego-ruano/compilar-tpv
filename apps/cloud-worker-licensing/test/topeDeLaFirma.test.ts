// test/topeDeLaFirma.test.ts
//
// AUD-33 · Una firma o una clave pública demasiado largas se rechazan antes de procesarlas.
//
// Quitar las comillas de los extremos corría sobre `X-Device-Sig` (`/v1/license/refresh`,
// `/v1/license/activate`, `tenantAuth`), sobre el `devicePubKey` de `/v1/pair/claim` y sobre el
// `sigB64` de `fetch-token` y `cancel`, de cualquier longitud y antes de saber quién llamaba. Ahora
// cada una tiene su tope delante (`TOPE_FIRMA_B64`, 128; `TOPE_CLAVE_B64`, 64): más larga sale con su
// error sin llegar a quitar comillas (`quitarComillas`, `sanitizeB64`) ni a consultar la base.
//
// Por la entrada real del worker (`src/index.ts`). La base central apunta cada consulta y no encuentra
// nada: así se ve si una petición llegó a ella. Cada familia, con tres entradas:
//   · una firma o una clave buenas con comillas alrededor hasta justo el tope: pasan y llegan a la base;
//   · las mismas con una comilla más: se rechazan. Sin el tope pasaban, porque las comillas se quitan;
//   · la forma del ataque, una racha de comillas en medio: se rechaza igual;
//   · en el cuerpo, una buena con 1.000 espacios delante: se rechaza igual, porque el tope mira la
//     cadena tal como llega, antes de recortarla.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

import { activacionFirmada, clavePublica } from "./helpers/activar";

const { consultas, llamadas } = vi.hoisted(() => ({
	consultas: [] as string[],
	llamadas: { quitarComillas: 0, sanitizeB64: 0 },
}));

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return {
		...original,
		getDb: () => ({
			execute: async (q: any) => {
				consultas.push(String(q?.sql ?? q));
				return { rows: [], rowsAffected: 0 };
			},
		}),
	};
});

vi.mock("../src/lib/texto", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/lib/texto")>();
	return {
		...real,
		quitarComillas: (texto: string) => {
			llamadas.quitarComillas++;
			return real.quitarComillas(texto);
		},
	};
});

vi.mock("../src/domains/pairing/pairing.firma", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/domains/pairing/pairing.firma")>();
	return {
		...real,
		sanitizeB64: (texto: string) => {
			llamadas.sanitizeB64++;
			return real.sanitizeB64(texto);
		},
	};
});

const { default: worker } = await import("../src/index");
const { firmarSesion } = await import("../src/lib/sesion");
const { TOPE_ANONIMO } = await import("../src/lib/validacion");
const { TOPE_CLAVE_B64, TOPE_FIRMA_B64 } = await import("../src/server/utils/ed25519");

const ENV = {
	PAIR_PEPPER: "pimienta-de-pruebas",
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	LICENSE_STORE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
} as any;

const C = '"';
/** `texto` con comillas alrededor hasta `largo` caracteres. */
const conComillas = (texto: string, largo: number) => {
	const sobra = largo - texto.length;
	return C.repeat(Math.floor(sobra / 2)) + texto + C.repeat(Math.ceil(sobra / 2));
};
/** La forma del ataque: ninguna comilla en los extremos y una racha de `n` en medio. */
const racha = (n: number) => `x${C.repeat(n)}x`;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Una firma Ed25519 con su forma (64 bytes, 88 caracteres); no hace falta que valga. */
const FIRMA = b64(new Uint8Array(64).fill(9));

async function pedir(ruta: string, init: RequestInit) {
	const ctx = createExecutionContext();
	const res = await worker.fetch!(new Request(`https://tpv-api.test${ruta}`, init) as any, ENV, ctx);
	await waitOnExecutionContext(ctx);
	const cuerpo = (await res.json()) as any;
	return { status: res.status, error: cuerpo.error as string };
}

beforeEach(() => {
	consultas.length = 0;
	llamadas.quitarComillas = 0;
	llamadas.sanitizeB64 = 0;
});

/** Rechazada sin quitar comillas ni consultar la base. */
function sinProcesar(r: { status: number; error: string }, esperado: { status: number; error: string }) {
	expect(r).toEqual(esperado);
	expect(consultas).toEqual([]);
	expect(llamadas.quitarComillas).toBe(0);
	expect(llamadas.sanitizeB64).toBe(0);
}

describe("AUD-33 · los topes dejan pasar lo legítimo", () => {
	it("una clave pública son 44 caracteres y una firma 88; en base64url sin relleno, 43 y 86", async () => {
		const clave = await clavePublica(33);
		expect(clave).toHaveLength(44);
		expect(FIRMA).toHaveLength(88);
		expect(b64url(atob(clave))).toHaveLength(43);
		expect(b64url(atob(FIRMA))).toHaveLength(86);
		// Con comillas alrededor, aún les sobra sitio.
		expect(clave.length + 2).toBeLessThan(TOPE_CLAVE_B64);
		expect(FIRMA.length + 2).toBeLessThan(TOPE_FIRMA_B64);
	});
});

// ── El emparejamiento: el cuerpo ─────────────────────────────────────────────────────────────────

const JSON_CT = { "Content-Type": "application/json", "CF-Connecting-IP": "2001:db8::33" };

describe("AUD-33 · POST /v1/pair/claim: la clave pública lleva su tope delante del transform", () => {
	const reclamar = (devicePubKey: string) => {
		const body = JSON.stringify({ pairCode: "123456", pairSecret: "", deviceId: "d-aud33", devicePubKey, deviceName: "" });
		expect(body.length).toBeLessThan(TOPE_ANONIMO);
		return pedir("/v1/pair/claim", { method: "POST", headers: JSON_CT, body });
	};

	it("una clave buena con comillas hasta el tope se normaliza y llega a la base", async () => {
		const r = await reclamar(conComillas(await clavePublica(33), TOPE_CLAVE_B64));
		expect(r).toEqual({ status: 404, error: "pair_code_not_found" });
		expect(llamadas.sanitizeB64).toBe(1);
		expect(consultas.length).toBeGreaterThan(0);
	});

	it("con una comilla más: 400 invalid_devicePubKey sin llegar a sanitizeB64 ni a la base", async () => {
		sinProcesar(await reclamar(conComillas(await clavePublica(33), TOPE_CLAVE_B64 + 1)), {
			status: 400,
			error: "invalid_devicePubKey",
		});
	});

	it("una racha de 4.000 comillas (lo que cabe en el tope del cuerpo): igual", async () => {
		sinProcesar(await reclamar(racha(4_000)), { status: 400, error: "invalid_devicePubKey" });
	});

	it("1.000 espacios delante de una clave buena: igual, el tope mira la cadena antes de recortarla", async () => {
		sinProcesar(await reclamar(" ".repeat(1_000) + (await clavePublica(33))), {
			status: 400,
			error: "invalid_devicePubKey",
		});
	});
});

describe("AUD-33 · POST /v1/pair/fetch-token y /cancel: la firma lleva su tope", () => {
	for (const ruta of ["/v1/pair/fetch-token", "/v1/pair/cancel"]) {
		const pedirCon = (sigB64: string) => {
			const body = JSON.stringify({ pairCode: "123456", deviceId: "d-aud33", nonceB64: "bm9uY2U=", ts: Date.now(), sigB64 });
			expect(body.length).toBeLessThan(TOPE_ANONIMO);
			return pedir(ruta, { method: "POST", headers: JSON_CT, body });
		};

		it(`${ruta}: una firma con comillas hasta el tope llega a la base`, async () => {
			const r = await pedirCon(conComillas(FIRMA, TOPE_FIRMA_B64));
			expect(r).toEqual({ status: 404, error: "pair_code_not_found" });
			expect(consultas.length).toBeGreaterThan(0);
		});

		it(`${ruta}: con una comilla más, o con una racha de 4.000, 400 missing_proof sin tocar la base`, async () => {
			sinProcesar(await pedirCon(conComillas(FIRMA, TOPE_FIRMA_B64 + 1)), { status: 400, error: "missing_proof" });
			sinProcesar(await pedirCon(racha(4_000)), { status: 400, error: "missing_proof" });
		});

		it(`${ruta}: 1.000 espacios delante de una firma buena, igual: el tope mira la cadena antes de recortarla`, async () => {
			sinProcesar(await pedirCon(" ".repeat(1_000) + FIRMA), { status: 400, error: "missing_proof" });
		});
	}
});

// ── X-Device-Sig: la cabecera ────────────────────────────────────────────────────────────────────

/** Un JWT sin firma: `/refresh` lee sus claims sin verificarlo. */
const JWT_SIN_FIRMA =
	`${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.` +
	`${b64url(JSON.stringify({ tenantId: "t-aud33", deviceId: "d-aud33", licHash: "h" }))}.`;

/** 100.000 comillas: cabe de sobra en los 128 KB de cabeceras del borde; antes, unos 13 s de CPU. */
const CABECERA_DE_ATAQUE = racha(100_000);

describe("AUD-33 · POST /v1/license/refresh (anónima): X-Device-Sig lleva su tope", () => {
	const refrescar = (firma: string) =>
		pedir("/v1/license/refresh", {
			method: "POST",
			headers: { authorization: `Bearer ${JWT_SIN_FIRMA}`, "X-Device-Ts": String(Date.now()), "X-Device-Sig": firma },
		});

	it("una firma con comillas hasta el tope llega a buscar la clave del equipo", async () => {
		const r = await refrescar(conComillas(FIRMA, TOPE_FIRMA_B64));
		expect(r).toEqual({ status: 401, error: "device_pubkey_not_registered" });
		expect(llamadas.quitarComillas).toBeGreaterThan(0);
		expect(consultas.length).toBeGreaterThan(0);
	});

	it("con una comilla más, o con la cabecera del ataque: 401 bad_device_signature sin tocarla ni la base", async () => {
		sinProcesar(await refrescar(conComillas(FIRMA, TOPE_FIRMA_B64 + 1)), { status: 401, error: "bad_device_signature" });
		sinProcesar(await refrescar(CABECERA_DE_ATAQUE), { status: 401, error: "bad_device_signature" });
	});
});

describe("AUD-33 · POST /v1/license/activate (anónima): X-Device-Sig lleva su tope", () => {
	/** Una activación firmada de verdad, con su `X-Device-Sig` cambiada por lo que dé `firma`. */
	const activar = async (firma: (real: string) => string) => {
		const peticion = await activacionFirmada({
			activationKey: "TPV-ABCDE-FGHJK-MNPQR-STVWX",
			deviceId: "equipo-aud33",
			devicePubKey: await clavePublica(34),
		});
		const headers = { ...peticion.headers, "X-Device-Sig": firma(peticion.headers["X-Device-Sig"]) };
		return pedir("/v1/license/activate", { ...peticion, headers });
	};

	it("la firma de verdad con comillas hasta el tope se comprueba y la activación llega a la base", async () => {
		const r = await activar((real) => conComillas(real, TOPE_FIRMA_B64));
		expect(r).toEqual({ status: 404, error: "license_not_found" });
		expect(consultas.length).toBeGreaterThan(0);
	});

	it("con una comilla más, o con la cabecera del ataque: 401 bad_device_signature sin tocarla ni la base", async () => {
		sinProcesar(await activar((real) => conComillas(real, TOPE_FIRMA_B64 + 1)), {
			status: 401,
			error: "bad_device_signature",
		});
		sinProcesar(await activar(() => CABECERA_DE_ATAQUE), { status: 401, error: "bad_device_signature" });
	});
});

describe("AUD-33 · tenantAuth: X-Device-Sig lleva su tope antes de buscar el dispositivo", () => {
	const leer = async (firma: string) => {
		const token = await firmarSesion(ENV, { tenantId: "t-aud33", deviceId: "d-aud33", licHash: "h" });
		return pedir("/v1/mesas/layout", {
			headers: { authorization: `Bearer ${token}`, "X-Device-Ts": String(Date.now()), "X-Device-Sig": firma },
		});
	};

	it("una firma con comillas hasta el tope llega a buscar el dispositivo", async () => {
		const r = await leer(conComillas(FIRMA, TOPE_FIRMA_B64));
		expect(r).toEqual({ status: 401, error: "device_not_registered" });
		expect(consultas.length).toBeGreaterThan(0);
	});

	it("con una comilla más, o con la cabecera del ataque: 401 bad_device_signature sin tocarla ni la base", async () => {
		sinProcesar(await leer(conComillas(FIRMA, TOPE_FIRMA_B64 + 1)), { status: 401, error: "bad_device_signature" });
		sinProcesar(await leer(CABECERA_DE_ATAQUE), { status: 401, error: "bad_device_signature" });
	});
});
