// test/licenciaTraslado.test.ts
//
// `/v1/license/activate` le dice al equipo si la activación ha trasladado la licencia desde otro.
//
// Es lo que decide, en la Main, si su base local vale o hay que reconstruirla desde la nube: tras
// un traslado lo que tenga es de antes, y trabajar con ello —o subir su outbox— pisaría lo que el
// otro equipo hizo mientras tanto. Por eso lo tiene que decir el servidor, que sabe a qué equipo
// estaba ligada la licencia, y no el cliente por haber escrito un código.
//
// Y que el traslado mueve la licencia con su traza (`license_device_swaps`), o no la mueve. Si el
// viaje del traslado no llega a la central, la licencia sigue donde estaba; si entra y se pierde su
// respuesta, la ruta lo ve en la traza y sigue como si hubiera llegado: el equipo sabe que es un
// traslado, y se avisa al titular y al `TenantHub`.
//
// Cada caso tiene su base central de verdad (`helpers/central.ts`), a la que la ruta llega a través
// de su stub (`centralInterceptada`), por donde se le hace fallar un viaje. El aprovisionamiento de
// la base del negocio, los correos y el `TenantHub` se sustituyen: no son lo que se prueba.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import {
	centralDePrueba,
	centralInterceptada,
	desvio,
	filasDe,
	fotoDeLaCentral,
	type Atender,
	type CentralDePrueba,
} from "./helpers/central";
import { app } from "../src/app";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { otpHash } from "../src/domains/licensing/licensing.helpers";
import { getLicenseById, issueLicense, putDeviceOtp, reassignMainDevice } from "../src/server/licenseStore";

/** A quién ha ido el aviso al titular de que su licencia ha cambiado de equipo. */
const { avisosAlTitular } = vi.hoisted(() => ({ avisosAlTitular: [] as string[] }));

vi.mock("../src/domains/licensing/licensing.helpers", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licensing.helpers")>();
	return { ...original, provisionTenantDatabase: async () => ({ reused: true }) };
});

vi.mock("../src/domains/licensing/licenseEmails", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licenseEmails")>();
	return {
		...original,
		sendDeviceChangeCodeEmail: async () => {},
		sendDeviceChangedNoticeEmail: async (_env: unknown, aviso: { to: string }) => {
			avisosAlTitular.push(aviso.to);
		},
	};
});

/** A qué negocio se le ha pedido que relea quién es su Main: el aviso al `TenantHub` (AUD-02). */
const avisosAlHub: string[] = [];

/**
 * Un `TenantHub` de mentira, que sólo anota los avisos. Lo que hace el de verdad con ellos está en
 * `mainDesplazadaSocket.test.ts`.
 */
const TENANT_HUB = {
	idFromName: (nombre: string) => ({ nombre }),
	get: () => ({ releerMain: async (tenantId: string) => void avisosAlHub.push(tenantId) }),
};

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_STORE_KEY: STORE_KEY,
	TenantHub: TENANT_HUB,
};
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const PUB_A = await clavePublica(1);
const PUB_B = await clavePublica(2);
const CONTEXTO = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

type Licencia = {
	licenseId: string;
	central: CentralDePrueba;
	/** Cambia lo que la central le contesta a la ruta (`desvio`); con `null`, vuelve a dejarlo pasar. */
	desviar: (atender: Atender | null) => void;
	/**
	 * Pide la activación de la licencia en `deviceId`, con el código de traslado `codigo`, por la
	 * `app` entera: un fallo de la central sale por su `onError`, como en producción.
	 */
	activar: (deviceId: string, devicePubKey: string, codigo?: string) => Promise<{ status: number; body: any }>;
};

/** Una licencia recién emitida, sin activar, en una base central propia. */
async function conLicencia<T>(prueba: (l: Licencia) => Promise<T>) {
	const central = await centralDePrueba();
	const { atender, desviar } = desvio();
	const deLaRuta = centralInterceptada(central, atender);
	const { license, keyPlain } = await issueLicense(central.db, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "manual",
		customerEmail: "bar@ejemplo.test",
	});
	avisosAlTitular.length = 0;
	avisosAlHub.length = 0;
	const activar = async (deviceId: string, devicePubKey: string, deviceChangeCode?: string) => {
		const res = await app.request(
			"/v1/license/activate",
			await activacionFirmada({
				activationKey: keyPlain,
				deviceId,
				devicePubKey,
				deviceChangeCode,
				tenantInfo: { displayName: "Bar de Pruebas" },
			}),
			{ ...ENV, ...deLaRuta.entorno },
			CONTEXTO as any,
		);
		return { status: res.status, body: (await res.json()) as any };
	};
	return prueba({ licenseId: license.license_id, central, desviar, activar });
}

/** Deja pedido el código `codigo` para trasladar la licencia a `deviceId`. */
async function codigoDeTraslado(central: CentralDePrueba, licenseId: string, deviceId: string, codigo: string) {
	await putDeviceOtp(central.db, {
		licenseId,
		newDeviceId: deviceId,
		codeHash: await otpHash(codigo),
		expiresAtMs: Date.now() + 10 * 60 * 1000,
	});
}

/**
 * Cómo ha quedado el traslado: dónde está la licencia y desde cuándo (`updated_at_ms`), sus trazas con
 * todas sus columnas y a quién se ha avisado.
 */
async function comoHaQuedado(central: CentralDePrueba, licenseId: string) {
	const [licencia] = await filasDe(
		central,
		`SELECT main_device_id, updated_at_ms FROM licenses WHERE license_id = ?;`,
		licenseId,
	);
	return {
		licencia,
		trazas: await filasDe(central, `SELECT * FROM license_device_swaps ORDER BY at_ms, swap_id;`),
		avisosAlTitular: [...avisosAlTitular],
		avisosAlHub: [...avisosAlHub],
	};
}

// El reloj va fijo en los traslados: la hora que escribe cada paso se sabe, y se comprueba que la
// licencia y su traza llevan la misma (`updated_at_ms` y `at_ms`, el mismo `now`, como en 8e9eff7c).
/** Cuándo se activa la licencia en el primer equipo. */
const HORA_DE_LA_ACTIVACION = Math.floor(Date.now() / 1000) * 1000;
/** Cuándo se pide el traslado: un minuto después, con el código (diez minutos) aún vivo. */
const HORA_DEL_TRASLADO = HORA_DE_LA_ACTIVACION + 60 * 1000;
/** Cuándo se repite, con otro código, el que no llegó. */
const HORA_DEL_SEGUNDO_TRASLADO = HORA_DEL_TRASLADO + 60 * 1000;
/** El `swap_id` de una traza: un UUID nuevo de cada traslado. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** La traza de un traslado de `equipo-a` a `equipo-b` hecho a la hora `atMs`, con todas sus columnas. */
const trazaDelTraslado = (licenseId: string, atMs: number) => ({
	swap_id: expect.stringMatching(UUID),
	license_id: licenseId,
	from_device_id: "equipo-a",
	to_device_id: "equipo-b",
	at_ms: atMs,
});

/** Deja pasar el viaje a la central. */
const pasar: Atender = (_metodo, _argumentos, llamar) => llamar();

/** ¿Lleva el viaje alguna sentencia que case con `patron`? La suelta, o una de las de un lote. */
function lleva(patron: RegExp, metodo: string, argumentos: unknown[]): boolean {
	const sentencias = (
		metodo === "ejecutar" ? [argumentos[0]] : metodo === "lote" ? argumentos[0] : []
	) as SentenciaEnlazada[];
	return sentencias.some((s) => patron.test(s.sql));
}

/** Un fallo pasajero de la plataforma en un viaje a un Durable Object. */
const falloPasajero = (mensaje: string) => Object.assign(new Error(mensaje), { retryable: true });

/**
 * Un `Atender` que rechaza, como la plataforma ante un fallo pasajero, el viaje que lleve una
 * sentencia que case con `patron`, sin que llegue a la central. Los demás van a `siNo`.
 */
function fallaElViajeDe(patron: RegExp, siNo: Atender = pasar): Atender {
	return (metodo, argumentos, llamar) => {
		if (!lleva(patron, metodo, argumentos)) return siNo(metodo, argumentos, llamar);
		return Promise.reject(falloPasajero("Durable Object reset because its code was updated."));
	};
}

/**
 * Un `Atender` que deja llegar a la central el viaje que lleve una sentencia que case con `patron`, y
 * después lo da por fallido como la plataforma cuando se pierde la respuesta: lo que llevaba ha
 * entrado, y quien llama recibe el mismo fallo pasajero que si no hubiera llegado. Los demás van a
 * `siNo`.
 */
function seLePierdeLaRespuestaDe(patron: RegExp, siNo: Atender = pasar): Atender {
	return async (metodo, argumentos, llamar) => {
		if (!lleva(patron, metodo, argumentos)) return siNo(metodo, argumentos, llamar);
		await llamar();
		throw falloPasajero("Network connection lost.");
	};
}

describe("activar dice si la licencia se ha trasladado a este equipo", () => {
	it("la primera activación no es un traslado", async () => {
		await conLicencia(async ({ activar }) => {
			const r = await activar("equipo-a", PUB_A);
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(false);
		});
	});

	it("volver a activar en el mismo equipo no es un traslado, aunque llegue un código", async () => {
		await conLicencia(async ({ activar }) => {
			await activar("equipo-a", PUB_A);
			const r = await activar("equipo-a", PUB_A, "123456");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(false);
		});
	});

	it("activar en otro equipo con su código sí lo es, y la licencia pasa a ese equipo", async () => {
		await conLicencia(async ({ licenseId, central, activar }) => {
			await activar("equipo-a", PUB_A);

			const sinCodigo = await activar("equipo-b", PUB_B);
			expect(sinCodigo.body.error).toBe("device_change_required");

			await putDeviceOtp(central.db, {
				licenseId,
				newDeviceId: "equipo-b",
				codeHash: await otpHash("654321"),
				expiresAtMs: Date.now() + 10 * 60 * 1000,
			});
			const r = await activar("equipo-b", PUB_B, "654321");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
			expect((await getLicenseById(central.db, licenseId))?.main_device_id).toBe("equipo-b");
		});
	});

	it("y también cuando la licencia vuelve al equipo en el que estuvo antes", async () => {
		// El caso que motiva todo esto: la base de ese equipo es de antes de que se fuera.
		await conLicencia(async ({ licenseId, central, activar }) => {
			await activar("equipo-a", PUB_A);
			for (const [equipo, pub, codigo] of [
				["equipo-b", PUB_B, "111111"],
				["equipo-a", PUB_A, "222222"],
			] as const) {
				await putDeviceOtp(central.db, {
					licenseId,
					newDeviceId: equipo,
					codeHash: await otpHash(codigo),
					expiresAtMs: Date.now() + 10 * 60 * 1000,
				});
				const r = await activar(equipo, pub, codigo);
				expect(r.body.cambioDeEquipo, equipo).toBe(true);
			}
		});
	});
});

describe("el traslado mueve la licencia con su traza, o no la mueve", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(HORA_DE_LA_ACTIVACION);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("la licencia cambia de equipo y de hora, y su traza lleva esa misma hora: nada más de la central", async () => {
		// Lo que escribe el traslado, que ahora va en un lote: lo mismo que los dos `exec` sueltos de
		// 8e9eff7c, con el mismo `now` en los dos, y ninguna otra fila de la central.
		await conLicencia(async ({ licenseId, central, activar }) => {
			expect((await activar("equipo-a", PUB_A)).status).toBe(200);
			const antes = await fotoDeLaCentral(central);

			vi.setSystemTime(HORA_DEL_TRASLADO);
			await reassignMainDevice(central.db, { licenseId, fromDeviceId: "equipo-a", toDeviceId: "equipo-b" });

			expect(antes.license_device_swaps).toEqual([]);
			expect(await fotoDeLaCentral(central)).toEqual({
				...antes,
				licenses: antes.licenses.map((l: any) =>
					l.license_id === licenseId
						? { ...l, main_device_id: "equipo-b", updated_at_ms: HORA_DEL_TRASLADO }
						: l,
				),
				license_device_swaps: [trazaDelTraslado(licenseId, HORA_DEL_TRASLADO)],
			});
		});
	});

	it("si el viaje del traslado no llega a la central, la licencia sigue en el equipo de antes", async () => {
		await conLicencia(async ({ licenseId, central, desviar, activar }) => {
			const a = await activar("equipo-a", PUB_A);
			expect(a.status).toBe(200);
			await codigoDeTraslado(central, licenseId, "equipo-b", "111111");

			vi.setSystemTime(HORA_DEL_TRASLADO);
			desviar(fallaElViajeDe(/INSERT INTO license_device_swaps/));
			const fallido = await activar("equipo-b", PUB_B, "111111");
			desviar(null);

			// Lo que ve el equipo es lo de siempre que la central no atiende: un 503 que se repite.
			expect([fallido.status, fallido.body.error]).toEqual([503, "hub_unavailable"]);
			// Y no ha pasado nada a medias: ni la licencia en el equipo nuevo, ni su traza, ni los avisos.
			expect(await comoHaQuedado(central, licenseId)).toEqual({
				licencia: { main_device_id: "equipo-a", updated_at_ms: HORA_DE_LA_ACTIVACION },
				trazas: [],
				avisosAlTitular: [],
				avisosAlHub: [],
			});

			// El código se gastó antes del fallo. Con otro, el traslado se hace entero: lo es para el
			// equipo, deja su traza y avisa al titular y al `TenantHub`.
			await codigoDeTraslado(central, licenseId, "equipo-b", "222222");
			vi.setSystemTime(HORA_DEL_SEGUNDO_TRASLADO);
			const r = await activar("equipo-b", PUB_B, "222222");
			expect([r.status, r.body.cambioDeEquipo]).toEqual([200, true]);
			expect(await comoHaQuedado(central, licenseId)).toEqual({
				licencia: { main_device_id: "equipo-b", updated_at_ms: HORA_DEL_SEGUNDO_TRASLADO },
				trazas: [trazaDelTraslado(licenseId, HORA_DEL_SEGUNDO_TRASLADO)],
				avisosAlTitular: ["bar@ejemplo.test"],
				avisosAlHub: [a.body.tenantId],
			});
		});
	});

	it("si entra y se pierde su respuesta, la traza lo dice: es un traslado y se avisa al titular y al TenantHub", async () => {
		await conLicencia(async ({ licenseId, central, desviar, activar }) => {
			const a = await activar("equipo-a", PUB_A);
			expect(a.status).toBe(200);
			await codigoDeTraslado(central, licenseId, "equipo-b", "111111");

			vi.setSystemTime(HORA_DEL_TRASLADO);
			desviar(seLePierdeLaRespuestaDe(/INSERT INTO license_device_swaps/));
			const r = await activar("equipo-b", PUB_B, "111111");
			desviar(null);

			// Lo mismo que si la respuesta hubiera llegado. Con el 503, el reintento entraba como el
			// mismo equipo (`cambioDeEquipo: false`) y los avisos no salían nunca.
			expect([r.status, r.body.cambioDeEquipo]).toEqual([200, true]);
			expect(await comoHaQuedado(central, licenseId)).toEqual({
				licencia: { main_device_id: "equipo-b", updated_at_ms: HORA_DEL_TRASLADO },
				trazas: [trazaDelTraslado(licenseId, HORA_DEL_TRASLADO)],
				avisosAlTitular: ["bar@ejemplo.test"],
				avisosAlHub: [a.body.tenantId],
			});
		});
	});

	it("si tampoco se puede mirar la traza, no se sabe si ha entrado: el 503 del viaje, sin avisos", async () => {
		await conLicencia(async ({ licenseId, central, desviar, activar }) => {
			expect((await activar("equipo-a", PUB_A)).status).toBe(200);
			await codigoDeTraslado(central, licenseId, "equipo-b", "111111");

			vi.setSystemTime(HORA_DEL_TRASLADO);
			desviar(
				seLePierdeLaRespuestaDe(/INSERT INTO license_device_swaps/, fallaElViajeDe(/FROM license_device_swaps/)),
			);
			const fallido = await activar("equipo-b", PUB_B, "111111");
			desviar(null);

			expect([fallido.status, fallido.body.error]).toEqual([503, "hub_unavailable"]);
			// Había entrado, pero la ruta no lo ha podido saber: la licencia está en el equipo nuevo con su
			// traza, y no se ha avisado a nadie.
			expect(await comoHaQuedado(central, licenseId)).toEqual({
				licencia: { main_device_id: "equipo-b", updated_at_ms: HORA_DEL_TRASLADO },
				trazas: [trazaDelTraslado(licenseId, HORA_DEL_TRASLADO)],
				avisosAlTitular: [],
				avisosAlHub: [],
			});
		});
	});
});
