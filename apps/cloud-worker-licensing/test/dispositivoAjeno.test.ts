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

import { describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { exigirClaveSiEsDeOtroNegocio } from "../src/server/licenseStore";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { licenseRoutes } = await import("../src/domains/licensing/licensing.routes");
const { generateLicenseKey, licenseKeyHash } = await import("../src/domains/licensing/licenseKey");
const { activateLicenseFirstTime } = await import("../src/server/licenseStore");

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_STORE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
	TURSO_DATABASE_URL: "libsql://no-se-usa",
	TURSO_AUTH_TOKEN: "no-se-usa",
	// La ruta los exige antes de nada (fail-closed); el rechazo llega mucho antes de usarlos.
	TURSO_PLATFORM_TOKEN: "no-se-usa",
	TURSO_ORG_SLUG: "no-se-usa",
};

const CLAVE = generateLicenseKey();
const VICTIMA = "equipo-de-la-victima";
const BAR_VICTIMA = "tenant-victima";
const BAR_ATACANTE = "tenant-atacante";
const PUB_VICTIMA = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const PUB_ATACANTE = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

/** El bar de la víctima con su equipo dado de alta, y una licencia libre en manos del atacante. */
async function escenario<T>(nombre: string, prueba: (sql: any) => Promise<T>): Promise<T> {
	return enElHub(`ajeno-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of ["devices", "licenses", "tenants"]) sql.exec(`DELETE FROM ${tabla};`);
		dbDePruebas = clienteSobre(sql);

		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?), (?);`, BAR_VICTIMA, BAR_ATACANTE);
		// Una licencia sin activar: el atacante la compró, es suya y es válida.
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       term_months, origin, issued_at_ms, customer_email,
			                       created_at_ms, updated_at_ms)
			 VALUES ('lic-atacante', ?, NULL, NULL, 'issued', 12, 'manual', 1, 'malo@ejemplo.test', 1, 1);`,
			await licenseKeyHash(CLAVE),
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
			 VALUES (?, ?, 'tpv', ?, 'ed25519');`,
			VICTIMA,
			BAR_VICTIMA,
			PUB_VICTIMA,
		);
		return prueba(sql);
	});
}

const fila = (sql: any) =>
	sql.exec(`SELECT tenant_id, role, device_pubkey_b64 FROM devices WHERE device_id = ?;`, VICTIMA)
		.toArray()[0];

async function activar(devicePubKey: string): Promise<Response> {
	return licenseRoutes.request(
		"/activate",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ activationKey: CLAVE, deviceId: VICTIMA, devicePubKey }),
		},
		ENV,
	);
}

describe("activar con el device_id de otro negocio", () => {
	it("se rechaza ANTES de mover la fila, que es lo que fallaba", async () => {
		// El orden es el arreglo entero: la comprobación existía, pero corría después del alta —y
		// encima consultando por el tenant NUEVO, o sea sobre la fila ya movida—. El 409 llegaba
		// con el daño hecho.
		await escenario("rechaza", async (sql) => {
			const res = await activar(PUB_ATACANTE);

			expect(res.status).toBe(409);
			expect(((await res.json()) as any).error).toBe("device_key_mismatch");
			expect(fila(sql)).toEqual({
				tenant_id: BAR_VICTIMA,
				role: "tpv",
				device_pubkey_b64: PUB_VICTIMA,
			});
		});
	});

	it("y la licencia del atacante se queda sin activar", async () => {
		// Si se hubiera activado a medias, el atacante tendría además un tenant aprovisionado a
		// nombre de una activación que la nube rechazó.
		await escenario("licencia-intacta", async (sql) => {
			await activar(PUB_ATACANTE);

			const lic = sql
				.exec(`SELECT status, tenant_id, main_device_id FROM licenses WHERE license_id='lic-atacante';`)
				.toArray()[0];
			expect(lic).toEqual({ status: "issued", tenant_id: null, main_device_id: null });
		});
	});
});

describe("la regla, que comparten las dos puertas", () => {
	it("deja pasar al equipo de verdad, esté donde esté su fila", async () => {
		// Es la mudanza legítima de §9, y no puede romperse: un equipo que fue Handy de otro negocio
		// vuelve a ser la Main del suyo firmando con la clave que tiene registrada.
		await escenario("mismo-equipo", async () => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(dbDePruebas as any, VICTIMA, PUB_VICTIMA, BAR_ATACANTE),
			).resolves.toBeUndefined();
		});
	});

	it("no dice nada de un device_id que no conoce", async () => {
		await escenario("desconocido", async () => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(dbDePruebas as any, "equipo-nuevo", "cualquiera", BAR_ATACANTE),
			).resolves.toBeUndefined();
		});
	});

	it("dentro del MISMO negocio la clave sí puede cambiar, y tiene que poder", async () => {
		// Es la vía de recuperación que existe hoy: un Handy revocado que se vuelve a vincular queda
		// activo con la clave nueva, y eso lo aprueba el dueño desde su propia Main. Prohibirlo
		// dejaría sin salida a un equipo que perdiera su par de claves —la identidad y la clave
		// viven en dos entradas distintas del almacén de secretos— y no hay ninguna pantalla para
		// limpiar una `device_pubkey_b64`. Queda fuera del alcance de esto, a sabiendas.
		await escenario("mismo-negocio", async () => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(dbDePruebas as any, VICTIMA, "clave-nueva", BAR_VICTIMA),
			).resolves.toBeUndefined();
		});
	});

	it("y con otra clave desde otro negocio, no", async () => {
		await escenario("otro-negocio", async () => {
			await expect(
				exigirClaveSiEsDeOtroNegocio(dbDePruebas as any, VICTIMA, PUB_ATACANTE, BAR_ATACANTE),
			).rejects.toThrow("device_key_mismatch");
		});
	});
});

describe("REV-15 · dos equipos activando la misma clave a la vez", () => {
	// La carrera de verdad no se puede montar desde la ruta: para cuando la segunda petición lee la
	// licencia, la primera ya la ha marcado, y entonces entra por el camino de «cambio de equipo».
	// Lo que hay que fijar es el adjudicador, que es donde estaba el fallo: el `UPDATE` iba
	// condicionado a que la licencia siguiera sin activar —correcto— pero **nadie miraba si había
	// afectado a alguna fila**, así que la perdedora seguía hasta el final y se llevaba un token y
	// la DEK de un tenant que la licencia no apunta. Dos equipos creyéndose la Main del mismo
	// negocio, cada uno con su base, y ninguno de los dos enterándose.

	it("sólo uno gana, y el otro se entera", async () => {
		await escenario("carrera", async (sql) => {
			const comun = { licenseId: "lic-atacante", termMonths: 12 };

			const primero = await activateLicenseFirstTime(dbDePruebas as any, {
				...comun,
				tenantId: "tenant-del-primero",
				deviceId: "equipo-primero",
			});
			const segundo = await activateLicenseFirstTime(dbDePruebas as any, {
				...comun,
				tenantId: "tenant-del-segundo",
				deviceId: "equipo-segundo",
			});

			expect(typeof primero).toBe("number");
			expect(segundo).toBeNull();

			// Y la licencia es del primero, no del último que pasó por aquí.
			expect(
				sql
					.exec(`SELECT tenant_id, main_device_id FROM licenses WHERE license_id='lic-atacante';`)
					.toArray()[0],
			).toEqual({ tenant_id: "tenant-del-primero", main_device_id: "equipo-primero" });
		});
	});

	it("y la ruta traduce esa derrota en un rechazo, sin entregar credenciales", async () => {
		// Lo que no puede pasar, gane quien gane: que el perdedor se vaya con un token y una DEK.
		await escenario("carrera-ruta", async (sql) => {
			sql.exec(
				`UPDATE licenses SET status='active', tenant_id='tenant-del-primero',
				        main_device_id='equipo-primero', activated_at_ms=1, expires_at_ms=?
				  WHERE license_id='lic-atacante';`,
				Date.now() + 365 * 24 * 60 * 60 * 1000,
			);

			const res = await licenseRoutes.request(
				"/activate",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						activationKey: CLAVE,
						deviceId: "equipo-segundo",
						devicePubKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
					}),
				},
				ENV,
			);

			expect(res.status).toBe(409);
			const cuerpo = (await res.json()) as any;
			expect(cuerpo.token).toBeUndefined();
			expect(cuerpo.fieldDek).toBeUndefined();
		});
	});
});
