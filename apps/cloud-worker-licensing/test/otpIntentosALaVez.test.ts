// test/otpIntentosALaVez.test.ts
//
// AUD-04 · Los topes del código de traslado aguantan los intentos simultáneos.
//
// El código de 6 cifras que mueve una licencia a otro equipo tiene dos topes: 5 intentos por código
// y 10 códigos incorrectos por licencia y día (RI-68, `otpCambioDeEquipo.test.ts`). Los dos se
// RESERVAN antes de comparar, cada uno en una sentencia que sólo concede si queda cupo. Si se leyera
// el contador, se comparase y se anotase después, las peticiones que llegan a la vez leerían todas
// antes de que escribiera ninguna y se compararían todas; la que acertase se llevaría la Main.
//
// Cada sentencia es una ida y vuelta a la base central, y entre la de una petición y la siguiente
// caben las de las demás. Contra la central de verdad (`helpers/central.ts`) el peor orden se fuerza
// con una barrera en su stub: cada petición se queda parada justo después de su primera sentencia
// sobre la tabla del tope hasta que todas han hecho la suya.
//
// El aprovisionamiento de la base del negocio y los correos se sustituyen: no son lo que se prueba.
// Datos ficticios.

import { describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import {
	OTP_FALLOS_AL_DIA,
	OTP_MAX_ATTEMPTS,
	OTP_VENTANA_MS,
	otpHash,
} from "../src/domains/licensing/licensing.helpers";
import {
	devolverIntentoDeOtp,
	issueLicense,
	putDeviceOtp,
	reservarIntentoDeOtp,
	trasladarLicencia,
} from "../src/server/licenseStore";

vi.mock("../src/domains/licensing/licensing.helpers", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licensing.helpers")>();
	return { ...original, provisionTenantDatabase: async () => ({ reused: true }) };
});

vi.mock("../src/domains/licensing/licenseEmails", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licenseEmails")>();
	return {
		...original,
		sendDeviceChangeCodeEmail: async () => true,
		sendDeviceChangedNoticeEmail: async () => true,
	};
});

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_STORE_KEY: STORE_KEY,
	EMAIL_FROM_ADDRESS: "no-responder@ejemplo.test",
};
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const PUB_A = await clavePublica(1);
const PUB_B = await clavePublica(2);
const PUB_C = await clavePublica(3);
const CONTEXTO = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

/** La primera sentencia de cada tope: la reserva. */
const TOPE_POR_CODIGO = /license_device_otp/;
const TOPE_POR_LICENCIA = /license_otp_eventos/;

type Respuesta = { status: number; body: any };

/**
 * La única llamada a `/v1/license/activate` de este fichero, con la central `central`. Va firmada con
 * la clave privada de `devicePubKey` (AUD-01): cada petición de una ráfaga lleva su propia firma,
 * válida, así que lo que frena las de más son los topes, no la firma.
 */
async function activar(
	central: Pick<CentralDePrueba, "entorno">,
	clave: string,
	deviceId: string,
	devicePubKey: string,
	deviceChangeCode?: string,
): Promise<Respuesta> {
	const res = await licenseRoutes.request(
		"/activate",
		await activacionFirmada({
			activationKey: clave,
			deviceId,
			devicePubKey,
			deviceChangeCode,
			tenantInfo: { displayName: "Bar de Pruebas" },
		}),
		{ ...ENV, ...central.entorno },
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

type Escenario = {
	clave: string;
	licenseId: string;
	central: CentralDePrueba;
	/** Pide la activación de la licencia en `deviceId`, con el código de traslado `codigo` (`activar`). */
	pedirActivacion: (deviceId: string, devicePubKey: string, codigo?: string) => Promise<Respuesta>;
};

/**
 * Una licencia ya activada en `equipo-a`, que es lo que hace que otro equipo necesite el código, en
 * una central propia.
 */
async function conLicenciaActivada<T>(prueba: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const { license, keyPlain } = await issueLicense(central.db, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "manual",
		customerEmail: "bar@ejemplo.test",
	});
	expect((await activar(central, keyPlain, "equipo-a", PUB_A)).status).toBe(200);
	return prueba({
		clave: keyPlain,
		licenseId: license.license_id,
		central,
		pedirActivacion: (deviceId, devicePubKey, codigo) => activar(central, keyPlain, deviceId, devicePubKey, codigo),
	});
}

/** Deja preparado un código conocido para la pareja (licencia, `deviceId`). */
async function codigoConocido(
	central: CentralDePrueba,
	licenseId: string,
	deviceId: string,
	codigo: string,
	caducaEnMs = 60_000,
) {
	await putDeviceOtp(central.db, {
		licenseId,
		newDeviceId: deviceId,
		codeHash: await otpHash(codigo),
		expiresAtMs: Date.now() + caducaEnMs,
	});
}

/**
 * La central `central`, con una barrera en su stub: retiene las `n` primeras sentencias que casen con
 * `patron` —la primera de cada petición sobre esa tabla— justo después de ejecutarlas, hasta que han
 * llegado las `n`. Las peticiones que tienen que cruzarse se piden con ésta.
 */
function conBarrera(central: CentralDePrueba, patron: RegExp, n: number): CentralDePrueba {
	let llegadas = 0;
	let soltar!: () => void;
	const barrera = new Promise<void>((r) => (soltar = r));
	return centralInterceptada(central, async (metodo, [sentencia], llamar) => {
		const r = await llamar();
		if (metodo === "ejecutar" && llegadas < n && patron.test((sentencia as SentenciaEnlazada).sql)) {
			if (++llegadas === n) soltar();
			await barrera;
		}
		return r;
	});
}

async function fallosDelDia(central: CentralDePrueba, licenseId: string): Promise<number> {
	const [fila] = await filasDe(
		central,
		`SELECT COUNT(*) AS n FROM license_otp_eventos WHERE license_id = ? AND tipo = 'fallo';`,
		licenseId,
	);
	return Number(fila.n);
}

/** Deja la licencia con el día agotado: OTP_FALLOS_AL_DIA códigos incorrectos dentro de la ventana. */
async function agotarElDia(central: CentralDePrueba, licenseId: string) {
	for (let i = 0; i < OTP_FALLOS_AL_DIA; i++) {
		await filasDe(
			central,
			`INSERT INTO license_otp_eventos (license_id, tipo, at_ms) VALUES (?, 'fallo', ?);`,
			licenseId,
			Date.now(),
		);
	}
}

/** Como si hubiera pasado un día: los fallos anotados salen de la ventana. */
async function pasaElDia(central: CentralDePrueba, licenseId: string) {
	await filasDe(
		central,
		`UPDATE license_otp_eventos SET at_ms = at_ms - ? WHERE license_id = ?;`,
		OTP_VENTANA_MS + 1000,
		licenseId,
	);
}

async function codigoDe(
	central: CentralDePrueba,
	licenseId: string,
	deviceId: string,
): Promise<{ attempts: number; consumido: boolean }> {
	const [fila] = await filasDe(
		central,
		`SELECT attempts, consumed_at_ms FROM license_device_otp WHERE license_id = ? AND new_device_id = ?;`,
		licenseId,
		deviceId,
	);
	return { attempts: Number(fila.attempts), consumido: fila.consumed_at_ms != null };
}

async function mainDe(central: CentralDePrueba, licenseId: string): Promise<string> {
	const [fila] = await filasDe(central, `SELECT main_device_id FROM licenses WHERE license_id = ?;`, licenseId);
	return String(fila.main_device_id);
}

function repartir(res: Respuesta[]) {
	return {
		incorrectos: res.filter((r) => r.status === 401 && r.body.error === "invalid_code"),
		trasladados: res.filter((r) => r.status === 200 && r.body.cambioDeEquipo === true),
		frenados: res.filter((r) => r.status === 429 && r.body.error === "too_many_attempts"),
	};
}

describe("AUD-04 · el tope por código con intentos simultáneos", () => {
	it("de 20 códigos incorrectos a la vez sólo se comparan OTP_MAX_ATTEMPTS; después ni el bueno entra", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central, pedirActivacion }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");

			const N = 20;
			const aLaVez = conBarrera(central, TOPE_POR_CODIGO, N);
			const res = await Promise.all(
				Array.from({ length: N }, (_, i) => activar(aLaVez, clave, "equipo-b", PUB_B, String(100000 + i))),
			);

			const { incorrectos, trasladados, frenados } = repartir(res);
			expect(incorrectos).toHaveLength(OTP_MAX_ATTEMPTS);
			expect(frenados).toHaveLength(N - OTP_MAX_ATTEMPTS);
			expect(trasladados).toHaveLength(0);
			expect(await codigoDe(central, licenseId, "equipo-b")).toEqual({ attempts: OTP_MAX_ATTEMPTS, consumido: false });
			expect(await fallosDelDia(central, licenseId)).toBe(OTP_MAX_ATTEMPTS);

			// El código se ha quedado sin intentos: el bueno ya no entra y la Main no se mueve.
			const tarde = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(tarde.status).toBe(429);
			expect(tarde.body.error).toBe("too_many_attempts");
			expect((await codigoDe(central, licenseId, "equipo-b")).consumido).toBe(false);
			expect(await mainDe(central, licenseId)).toBe("equipo-a");
		});
	});

	it("con el bueno entre 20 a la vez, la Main sólo se traslada si su intento fue de los concedidos", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");

			const N = 20;
			const aLaVez = conBarrera(central, TOPE_POR_CODIGO, N);
			const codigos = [...Array.from({ length: N - 1 }, (_, i) => String(100000 + i)), "222222"];
			const res = await Promise.all(codigos.map((cod) => activar(aLaVez, clave, "equipo-b", PUB_B, cod)));

			const { incorrectos, trasladados, frenados } = repartir(res);
			// Se comparan OTP_MAX_ATTEMPTS, esté o no el bueno entre ellos. El resto, 429.
			expect(incorrectos.length + trasladados.length).toBe(OTP_MAX_ATTEMPTS);
			expect(frenados).toHaveLength(N - OTP_MAX_ATTEMPTS);
			expect(trasladados.length).toBeLessThanOrEqual(1);
			expect((await codigoDe(central, licenseId, "equipo-b")).attempts).toBe(OTP_MAX_ATTEMPTS);
			// Sólo cuentan como fallo del día los que se compararon y no valían.
			expect(await fallosDelDia(central, licenseId)).toBe(incorrectos.length);
			expect(await mainDe(central, licenseId)).toBe(trasladados.length === 1 ? "equipo-b" : "equipo-a");
			expect((await codigoDe(central, licenseId, "equipo-b")).consumido).toBe(trasladados.length === 1);
		});
	});

	it("si todos caben en el tope, el bueno traslada y su intento no cuenta como fallo del día", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");

			const N = OTP_MAX_ATTEMPTS;
			const aLaVez = conBarrera(central, TOPE_POR_CODIGO, N);
			const codigos = [...Array.from({ length: N - 1 }, (_, i) => String(100000 + i)), "222222"];
			const res = await Promise.all(codigos.map((cod) => activar(aLaVez, clave, "equipo-b", PUB_B, cod)));

			const { incorrectos, trasladados, frenados } = repartir(res);
			expect(incorrectos).toHaveLength(N - 1);
			expect(trasladados).toHaveLength(1);
			expect(frenados).toHaveLength(0);
			expect(await fallosDelDia(central, licenseId)).toBe(N - 1);
			expect(await mainDe(central, licenseId)).toBe("equipo-b");
		});
	});
});

describe("AUD-04 · el tope por licencia con intentos simultáneos", () => {
	it("de 15 códigos incorrectos a la vez, cada uno de un equipo distinto, sólo se comparan OTP_FALLOS_AL_DIA", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central, pedirActivacion }) => {
			const N = OTP_FALLOS_AL_DIA + 5;
			for (let i = 0; i < N; i++) {
				await codigoConocido(central, licenseId, `inventado-${i}`, "111111");
			}

			const aLaVez = conBarrera(central, TOPE_POR_LICENCIA, N);
			const res = await Promise.all(
				Array.from({ length: N }, (_, i) => activar(aLaVez, clave, `inventado-${i}`, PUB_B, "999999")),
			);

			const { incorrectos, frenados } = repartir(res);
			expect(incorrectos).toHaveLength(OTP_FALLOS_AL_DIA);
			expect(frenados).toHaveLength(N - OTP_FALLOS_AL_DIA);
			for (const r of frenados) expect(r.body.message).toContain("mañana");
			expect(await fallosDelDia(central, licenseId)).toBe(OTP_FALLOS_AL_DIA);

			// Y con el día agotado ni el código bueno entra.
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			const tarde = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(tarde.status).toBe(429);
			expect(await mainDe(central, licenseId)).toBe("equipo-a");
		});
	});
});

describe("AUD-04 · el rechazo del día no gasta intentos del código", () => {
	it("con el día agotado el código conserva sus intentos, y sigue valiendo cuando el día se libera", async () => {
		await conLicenciaActivada(async ({ licenseId, central, pedirActivacion }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			await agotarElDia(central, licenseId);

			// Más veces de las que el código tiene intentos, y con el bueno: no se compara ninguna.
			for (let i = 0; i < OTP_MAX_ATTEMPTS + 1; i++) {
				const r = await pedirActivacion("equipo-b", PUB_B, "222222");
				expect(r.status).toBe(429);
				expect(r.body.message).toContain("mañana");
			}
			expect(await codigoDe(central, licenseId, "equipo-b")).toEqual({ attempts: 0, consumido: false });
			expect(await fallosDelDia(central, licenseId)).toBe(OTP_FALLOS_AL_DIA);
			expect(await mainDe(central, licenseId)).toBe("equipo-a");

			await pasaElDia(central, licenseId);
			const r = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
			expect(await mainDe(central, licenseId)).toBe("equipo-b");
		});
	});

	it("y lo mismo si los rechazos llegan a la vez", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central, pedirActivacion }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			await agotarElDia(central, licenseId);

			// Tantas como intentos tiene el código: todas reservan el suyo antes de que el día diga que no.
			const N = OTP_MAX_ATTEMPTS;
			const aLaVez = conBarrera(central, TOPE_POR_LICENCIA, N);
			const res = await Promise.all(
				Array.from({ length: N }, () => activar(aLaVez, clave, "equipo-b", PUB_B, "999999")),
			);

			for (const r of res) {
				expect(r.status).toBe(429);
				expect(r.body.message).toContain("mañana");
			}
			expect(await codigoDe(central, licenseId, "equipo-b")).toEqual({ attempts: 0, consumido: false });
			expect(await fallosDelDia(central, licenseId)).toBe(OTP_FALLOS_AL_DIA);

			await pasaElDia(central, licenseId);
			const r = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(r.status).toBe(200);
			expect(await mainDe(central, licenseId)).toBe("equipo-b");
		});
	});
});

describe("AUD-04 · uno detrás de otro, lo de siempre", () => {
	it("el tope por licencia frena al undécimo, y los fallos anotados son los comparados", async () => {
		await conLicenciaActivada(async ({ licenseId, central, pedirActivacion }) => {
			for (let i = 0; i < OTP_FALLOS_AL_DIA; i++) {
				await codigoConocido(central, licenseId, `inventado-${i}`, "111111");
				const r = await pedirActivacion(`inventado-${i}`, PUB_B, "999999");
				expect(r.body.error).toBe("invalid_code");
			}
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			const r = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(r.status).toBe(429);
			expect(r.body.message).toContain("mañana");
			expect(await fallosDelDia(central, licenseId)).toBe(OTP_FALLOS_AL_DIA);
		});
	});

	it("el tope por código frena al sexto intento y el código bueno ya no se consume", async () => {
		await conLicenciaActivada(async ({ licenseId, central, pedirActivacion }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
				expect((await pedirActivacion("equipo-b", PUB_B, "999999")).body.error).toBe("invalid_code");
			}
			const r = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(r.status).toBe(429);
			expect(r.body.error).toBe("too_many_attempts");
			expect(await codigoDe(central, licenseId, "equipo-b")).toEqual({ attempts: OTP_MAX_ATTEMPTS, consumido: false });
			expect(await mainDe(central, licenseId)).toBe("equipo-a");
		});
	});

	it("quien se equivoca una vez y acierta traslada, y sólo el error cuenta como fallo del día", async () => {
		await conLicenciaActivada(async ({ licenseId, central, pedirActivacion }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			expect((await pedirActivacion("equipo-b", PUB_B, "999999")).body.error).toBe("invalid_code");
			const r = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
			expect(await fallosDelDia(central, licenseId)).toBe(1);
			expect(await mainDe(central, licenseId)).toBe("equipo-b");
		});
	});

	it("un código caducado contesta que ha caducado, sin gastar intento ni fallo del día", async () => {
		await conLicenciaActivada(async ({ licenseId, central, pedirActivacion }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222", -1000);
			for (let i = 0; i < OTP_MAX_ATTEMPTS + 1; i++) {
				const r = await pedirActivacion("equipo-b", PUB_B, "222222");
				expect(r.status).toBe(401);
				expect(r.body.error).toBe("code_expired");
			}
			expect(await codigoDe(central, licenseId, "equipo-b")).toEqual({ attempts: 0, consumido: false });
			expect(await fallosDelDia(central, licenseId)).toBe(0);
		});
	});

	it("sin código pedido para ese equipo, el código no vale y no se anota nada", async () => {
		await conLicenciaActivada(async ({ licenseId, central, pedirActivacion }) => {
			const r = await pedirActivacion("equipo-b", PUB_B, "222222");
			expect(r.status).toBe(401);
			expect(r.body.error).toBe("invalid_code");
			expect(await fallosDelDia(central, licenseId)).toBe(0);
		});
	});
});

describe("AUD-04 · las reservas del almacén", () => {
	it("de 8 reservas a la vez sobre un código se conceden OTP_MAX_ATTEMPTS", async () => {
		await conLicenciaActivada(async ({ licenseId, central }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			const reservas = await Promise.all(
				Array.from({ length: OTP_MAX_ATTEMPTS + 3 }, () =>
					reservarIntentoDeOtp(central.db, {
						licenseId,
						newDeviceId: "equipo-b",
						ahoraMs: Date.now(),
						maximo: OTP_MAX_ATTEMPTS,
					}),
				),
			);
			expect(reservas.filter((r) => r !== null)).toHaveLength(OTP_MAX_ATTEMPTS);
		});
	});

	it("devolver un intento sólo toca el código de esa huella, y no baja de cero", async () => {
		await conLicenciaActivada(async ({ licenseId, central }) => {
			const reservar = () =>
				reservarIntentoDeOtp(central.db, {
					licenseId,
					newDeviceId: "equipo-b",
					ahoraMs: Date.now(),
					maximo: OTP_MAX_ATTEMPTS,
				});
			const devolver = (codeHash: string) =>
				devolverIntentoDeOtp(central.db, { licenseId, newDeviceId: "equipo-b", codeHash });

			await codigoConocido(central, licenseId, "equipo-b", "222222");
			const vieja = await reservar();
			await reservar();
			await devolver(vieja!.codeHash);
			expect((await codigoDe(central, licenseId, "equipo-b")).attempts).toBe(1);

			// Se pide otro código: una devolución con la huella del anterior no toca el nuevo.
			await codigoConocido(central, licenseId, "equipo-b", "333333");
			const nueva = await reservar();
			await devolver(vieja!.codeHash);
			expect((await codigoDe(central, licenseId, "equipo-b")).attempts).toBe(1);
			await devolver(nueva!.codeHash);
			await devolver(nueva!.codeHash);
			expect((await codigoDe(central, licenseId, "equipo-b")).attempts).toBe(0);
		});
	});

	it("el traslado sólo gasta el código de la huella que se le pasa, y sólo si no ha caducado", async () => {
		await conLicenciaActivada(async ({ licenseId, central }) => {
			const reservar = () =>
				reservarIntentoDeOtp(central.db, {
					licenseId,
					newDeviceId: "equipo-b",
					ahoraMs: Date.now(),
					maximo: OTP_MAX_ATTEMPTS,
				});
			const [{ tenant_id: tenantId }] = await filasDe(
				central,
				`SELECT tenant_id FROM licenses WHERE license_id = ?;`,
				licenseId,
			);
			const trasladar = async (deviceId: string, devicePubKey: string, codeHash: string) =>
				(
					await trasladarLicencia(central.db, {
						licenseId,
						fromDeviceId: "equipo-a",
						toDeviceId: deviceId,
						devicePubKey,
						tenantId,
						codeHash,
					})
				).resultado;
			/** Dónde está la licencia y qué equipos tiene la central: un traslado rechazado no toca nada. */
			const comoEsta = async () => ({
				main: (await filasDe(central, `SELECT main_device_id FROM licenses WHERE license_id = ?;`, licenseId))[0]
					.main_device_id,
				equipos: (await filasDe(central, `SELECT device_id FROM devices ORDER BY device_id;`)).map((f) => f.device_id),
			});

			await codigoConocido(central, licenseId, "equipo-b", "222222");
			const reserva = await reservar();
			expect(reserva?.codeHash).toBe(await otpHash("222222"));

			// Entre la comparación y el traslado se pide otro código para el mismo equipo: con la huella
			// del anterior no se gasta nada ni se traslada, y el nuevo sigue vivo.
			await codigoConocido(central, licenseId, "equipo-b", "333333");
			expect(await trasladar("equipo-b", PUB_B, reserva!.codeHash)).toBe("codigo_invalido");
			expect(await codigoDe(central, licenseId, "equipo-b")).toEqual({ attempts: 0, consumido: false });
			expect(await comoEsta()).toEqual({ main: "equipo-a", equipos: ["equipo-a"] });

			// Un código caducado tampoco se gasta, aunque la huella sea la suya.
			await codigoConocido(central, licenseId, "equipo-c", "444444", -1000);
			expect(await trasladar("equipo-c", PUB_C, await otpHash("444444"))).toBe("codigo_invalido");
			expect((await codigoDe(central, licenseId, "equipo-c")).consumido).toBe(false);
			expect(await comoEsta()).toEqual({ main: "equipo-a", equipos: ["equipo-a"] });

			// Con la huella del código vivo sí, y una sola vez: repetido, la licencia ya no está en el
			// equipo del que se trasladaba. `trasladarLicencia` no mira si quien llama reservó un intento:
			// que a ella sólo se llegue con reserva lo fijan los casos de la ruta («el tope por código
			// frena al sexto intento y el código bueno ya no se consume»).
			const nueva = await reservar();
			expect(await trasladar("equipo-b", PUB_B, nueva!.codeHash)).toBe("trasladada");
			expect(await trasladar("equipo-b", PUB_B, nueva!.codeHash)).toBe("movida");
			expect(await comoEsta()).toEqual({ main: "equipo-b", equipos: ["equipo-a", "equipo-b"] });
			// Y un código gastado no admite más reservas.
			expect(await reservar()).toBeNull();
		});
	});
});
