// test/dispositivoAjeno.test.ts
//
// REV-07: el `device_id` de otro negocio no se toca sin su clave.
//
// Un equipo tiene UNA identidad para sus dos modos, así que su fila de `devices` puede mudarse de
// negocio (docs/arquitectura/emparejamiento.md). El fallo era que la mudanza no exigía demostrar nada: las dos puertas
// que dan de alta un dispositivo —activar una licencia y recoger el token de un emparejamiento—
// hacían `ON CONFLICT(device_id) DO UPDATE SET tenant_id=…` antes de mirar la clave registrada.
//
// Presentando una licencia propia y el `device_id` ajeno, la Main de otro bar se quedaba con su
// fila en un tenant que no es el suyo; y por la puerta del emparejamiento, además, con OTRA clave
// pública, o sea firmando con una que ya no sirve: `bad_device_signature` en todo y sin poder
// reactivar, porque activar la rechaza entonces con `device_key_mismatch`. El `device_id` no es un
// secreto: viaja en los mensajes de presencia del WebSocket, así que lo conocen las Handy del local.
//
// La puerta del emparejamiento se prueba de punta a punta en `emparejamiento.test.ts`. Aquí van la
// de la activación y la regla en sí, que es lo que comparten.
//
// Cada caso tiene su base central de verdad (`helpers/central.ts`): la ruta llega a ella por
// `getDb(env)`, y las funciones de `licenseStore` la reciben.

import { describe, expect, it } from "vitest";

import { activacionFirmada, clavePublica, parDeClaves } from "./helpers/activar";
import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import { generateLicenseKey, licenseKeyHash } from "../src/domains/licensing/licenseKey";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { activateLicenseFirstTime, ensureDevice, exigirClaveSiEsDeOtroNegocio } from "../src/server/licenseStore";

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_STORE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
	// La ruta los exige antes de nada (fail-closed); el rechazo llega mucho antes de usarlos.
};

const CLAVE = generateLicenseKey();
const VICTIMA = "equipo-de-la-victima";
const BAR_VICTIMA = "tenant-victima";
const BAR_ATACANTE = "tenant-atacante";
// AUD-01: claves ed25519 de verdad. El atacante tiene la privada de la suya y no la de la víctima.
const PUB_VICTIMA = await clavePublica(1);
const ATACANTE = await parDeClaves(2);
const PUB_ATACANTE = ATACANTE.pub;

/** El bar de la víctima con su equipo dado de alta, y una licencia libre en manos del atacante. */
async function escenario<T>(prueba: (central: CentralDePrueba) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES (?), (?);`, BAR_VICTIMA, BAR_ATACANTE);
	// Una licencia sin activar: el atacante la compró, es suya y es válida.
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
		                       term_months, origin, issued_at_ms, customer_email,
		                       created_at_ms, updated_at_ms)
		 VALUES ('lic-atacante', ?, NULL, NULL, 'issued', 12, 'manual', 1, 'malo@ejemplo.test', 1, 1);`,
		await licenseKeyHash(CLAVE),
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
		 VALUES (?, ?, 'tpv', ?, 'ed25519');`,
		VICTIMA,
		BAR_VICTIMA,
		PUB_VICTIMA,
	);
	return prueba(central);
}

const fila = async (central: CentralDePrueba) =>
	(await filasDe(central, `SELECT tenant_id, role, device_pubkey_b64 FROM devices WHERE device_id = ?;`, VICTIMA))[0];

const licenciaDelAtacante = async (central: CentralDePrueba) =>
	(await filasDe(central, `SELECT status, tenant_id, main_device_id FROM licenses WHERE license_id='lic-atacante';`))[0];

/** El atacante activa con el `device_id` de la víctima, firmando con la única clave que tiene. */
async function activar(central: CentralDePrueba, devicePubKey: string): Promise<Response> {
	return licenseRoutes.request(
		"/activate",
		await activacionFirmada(
			{ activationKey: CLAVE, deviceId: VICTIMA, devicePubKey },
			{ firmarCon: ATACANTE.seed },
		),
		{ ...ENV, ...central.entorno },
	);
}

describe("activar con el device_id de otro negocio", () => {
	it("se rechaza ANTES de mover la fila, que es lo que fallaba", async () => {
		// El orden es el arreglo entero: la comprobación existía, pero corría después del alta —y
		// encima consultando por el tenant NUEVO, o sea sobre la fila ya movida—. El 409 llegaba
		// con el daño hecho.
		await escenario(async (central) => {
			const res = await activar(central, PUB_ATACANTE);

			expect(res.status).toBe(409);
			expect(((await res.json()) as any).error).toBe("device_key_mismatch");
			expect(await fila(central)).toEqual({
				tenant_id: BAR_VICTIMA,
				role: "tpv",
				device_pubkey_b64: PUB_VICTIMA,
			});
		});
	});

	it("y presentando la clave pública de la víctima tampoco, porque no puede firmar con ella", async () => {
		// AUD-01: la clave pública no es un secreto (la ve la Main de cada negocio por el que pasó el
		// equipo), así que compararla no basta. Sin la firma de su privada, 401 y nada se mueve.
		await escenario(async (central) => {
			const res = await activar(central, PUB_VICTIMA);

			expect(res.status).toBe(401);
			expect(((await res.json()) as any).error).toBe("bad_device_signature");
			expect(await fila(central)).toEqual({
				tenant_id: BAR_VICTIMA,
				role: "tpv",
				device_pubkey_b64: PUB_VICTIMA,
			});
			expect(await licenciaDelAtacante(central)).toEqual({ status: "issued", tenant_id: null, main_device_id: null });
		});
	});

	it("y la licencia del atacante se queda sin activar", async () => {
		// Si se hubiera activado a medias, el atacante tendría además un tenant aprovisionado a
		// nombre de una activación que la nube rechazó.
		await escenario(async (central) => {
			await activar(central, PUB_ATACANTE);

			expect(await licenciaDelAtacante(central)).toEqual({ status: "issued", tenant_id: null, main_device_id: null });
		});
	});
});

describe("la regla, que comparten las dos puertas", () => {
	it("deja pasar al equipo de verdad, esté donde esté su fila", async () => {
		// Es la mudanza legítima de §9, y no puede romperse: un equipo que fue Handy de otro negocio
		// vuelve a ser la Main del suyo firmando con la clave que tiene registrada. La regla sólo
		// compara claves públicas: que quien la presenta tiene su privada lo comprueba antes cada
		// puerta, con la firma (AUD-01 al activar, el reto del emparejamiento al recoger el token).
		// AUD-06: y dice en qué negocio estaba, que es lo que la activación necesita saber antes de
		// mudar la fila.
		await escenario(async ({ db }) => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(db, VICTIMA, PUB_VICTIMA, BAR_ATACANTE),
			).resolves.toBe(BAR_VICTIMA);
		});
	});

	it("no dice nada de un device_id que no conoce", async () => {
		await escenario(async ({ db }) => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(db, "equipo-nuevo", "cualquiera", BAR_ATACANTE),
			).resolves.toBeNull();
		});
	});

	it("dentro del MISMO negocio la clave sí puede cambiar, y tiene que poder", async () => {
		// Es la vía de recuperación que existe hoy: un Handy revocado que se vuelve a vincular queda
		// activo con la clave nueva, y eso lo aprueba el dueño desde su propia Main. Prohibirlo
		// dejaría sin salida a un equipo que perdiera su par de claves —la identidad y la clave
		// viven en dos entradas distintas del almacén de secretos— y no hay ninguna pantalla para
		// limpiar una `device_pubkey_b64`. Queda fuera del alcance de esto, a sabiendas.
		await escenario(async ({ db }) => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(db, VICTIMA, "clave-nueva", BAR_VICTIMA),
			).resolves.toBe(BAR_VICTIMA);
		});
	});

	it("y con otra clave desde otro negocio, no", async () => {
		await escenario(async ({ db }) => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(db, VICTIMA, PUB_ATACANTE, BAR_ATACANTE),
			).rejects.toThrow("device_key_mismatch");
		});
	});

	it.each([
		{ como: "NULL", valor: null },
		{ como: "cadena vacía", valor: "" },
	])("una fila de otro negocio sin clave registrada ($como) tampoco se mueve con la que llegue", async ({ valor }) => {
		// AUD-01: la firma de cada puerta sólo prueba la clave que se presenta. Sin una registrada con
		// la que compararla, se la llevaría el primero que firmase. Dentro de su negocio sí pasa:
		// volver a vincularla es como se le pone clave, y eso lo aprueba su dueño.
		await escenario(async (central) => {
			await filasDe(central, `UPDATE devices SET device_pubkey_b64 = ? WHERE device_id = ?;`, valor, VICTIMA);

			await expect(
				exigirClaveSiEsDeOtroNegocio(central.db, VICTIMA, PUB_ATACANTE, BAR_ATACANTE),
			).rejects.toThrow("device_key_missing");
			await expect(
				exigirClaveSiEsDeOtroNegocio(central.db, VICTIMA, PUB_ATACANTE, BAR_VICTIMA),
			).resolves.toBe(BAR_VICTIMA);
		});
	});
});

describe("AUD-01 · el alta del dispositivo va con su clave, en una sola sentencia", () => {
	// `ensureDevice` contra SQL de verdad: lo que decide es el `WHERE` de su `DO UPDATE`.
	const completa = async (central: CentralDePrueba) =>
		(
			await filasDe(
				central,
				`SELECT tenant_id, role, revoked_at_ms, device_pubkey_b64 FROM devices WHERE device_id = ?;`,
				VICTIMA,
			)
		)[0];

	it.each([
		{ como: "otra clave", valor: PUB_VICTIMA },
		{ como: "ninguna (NULL)", valor: null },
		{ como: "ninguna (cadena vacía)", valor: "" },
	])("no toca una fila registrada con $como", async ({ valor }) => {
		await escenario(async (central) => {
			await filasDe(
				central,
				`UPDATE devices SET role = 'handy', revoked_at_ms = 5, device_pubkey_b64 = ? WHERE device_id = ?;`,
				valor,
				VICTIMA,
			);
			const antes = await completa(central);

			await expect(
				ensureDevice(central.db, BAR_ATACANTE, VICTIMA, "tpv", PUB_ATACANTE),
			).rejects.toMatchObject({ code: "device_key_mismatch" });
			expect(await completa(central)).toEqual(antes);
		});
	});

	it("con la clave registrada muda la fila, la deja de `tpv` y le quita la revocación", async () => {
		await escenario(async (central) => {
			await filasDe(central, `UPDATE devices SET role = 'handy', revoked_at_ms = 5 WHERE device_id = ?;`, VICTIMA);

			await ensureDevice(central.db, BAR_ATACANTE, VICTIMA, "tpv", PUB_VICTIMA);

			expect(await completa(central)).toEqual({
				tenant_id: BAR_ATACANTE,
				role: "tpv",
				revoked_at_ms: null,
				device_pubkey_b64: PUB_VICTIMA,
			});
		});
	});

	it("y una fila nueva nace ya con su clave", async () => {
		await escenario(async (central) => {
			await ensureDevice(central.db, BAR_ATACANTE, "equipo-nuevo", "tpv", PUB_ATACANTE);

			expect(
				(
					await filasDe(
						central,
						`SELECT tenant_id, role, device_pubkey_b64, pubkey_alg FROM devices WHERE device_id = 'equipo-nuevo';`,
					)
				)[0],
			).toEqual({ tenant_id: BAR_ATACANTE, role: "tpv", device_pubkey_b64: PUB_ATACANTE, pubkey_alg: "ed25519" });
		});
	});
});

describe("REV-15 · dos equipos activando la misma clave a la vez", () => {
	// La carrera de verdad, por la ruta y con varias peticiones que leen la licencia sin estrenar
	// antes de que ninguna escriba, está en `activacionesALaVez.test.ts` (AUD-09). Aquí se fija el
	// adjudicador, que es donde estaba el fallo de REV-15: el `UPDATE` iba
	// condicionado a que la licencia siguiera sin activar —correcto— pero **nadie miraba si había
	// afectado a alguna fila**, así que la perdedora seguía hasta el final y se llevaba un token y
	// la DEK de un tenant que la licencia no apunta. Dos equipos creyéndose la Main del mismo
	// negocio, cada uno con su base, y ninguno de los dos enterándose.

	it("sólo uno gana, y el otro se entera", async () => {
		await escenario(async (central) => {
			const comun = { licenseId: "lic-atacante", termMonths: 12 };

			const primero = await activateLicenseFirstTime(central.db, {
				...comun,
				tenantId: "tenant-del-primero",
				deviceId: "equipo-primero",
			});
			const segundo = await activateLicenseFirstTime(central.db, {
				...comun,
				tenantId: "tenant-del-segundo",
				deviceId: "equipo-segundo",
			});

			expect(typeof primero).toBe("number");
			expect(segundo).toBeNull();

			// Y la licencia es del primero, no del último que pasó por aquí.
			expect(await licenciaDelAtacante(central)).toEqual({
				status: "active",
				tenant_id: "tenant-del-primero",
				main_device_id: "equipo-primero",
			});
		});
	});

	it("y la ruta traduce esa derrota en un rechazo, sin entregar credenciales", async () => {
		// Lo que no puede pasar, gane quien gane: que el perdedor se vaya con un token y una DEK.
		await escenario(async (central) => {
			await filasDe(
				central,
				`UPDATE licenses SET status='active', tenant_id='tenant-del-primero',
				        main_device_id='equipo-primero', activated_at_ms=1, expires_at_ms=?
				  WHERE license_id='lic-atacante';`,
				Date.now() + 365 * 24 * 60 * 60 * 1000,
			);

			const res = await licenseRoutes.request(
				"/activate",
				await activacionFirmada({
					activationKey: CLAVE,
					deviceId: "equipo-segundo",
					devicePubKey: await clavePublica(3),
				}),
				{ ...ENV, ...central.entorno },
			);

			expect(res.status).toBe(409);
			const cuerpo = (await res.json()) as any;
			expect(cuerpo.token).toBeUndefined();
			expect(cuerpo.fieldDek).toBeUndefined();
		});
	});
});
