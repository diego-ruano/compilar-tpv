// test/deviceRevocado.test.ts
//
// `devices.revoked_at_ms` decide si un dispositivo puede hablar con la nube, y hasta ahora se
// leía de tres formas distintas repartidas por diez ficheros. El fallo real que motivó estos
// tests: un equipo que había sido desvinculado siendo Handy activó después una licencia nueva
// como Main; la activación movió su fila de tenant y de rol pero dejó intacta la revocación de
// meses atrás, así que el TPV pasaba `/v1/license/status` y recibía 401 en todo lo demás —
// diciendo además `device_pubkey_not_registered`, que apunta al sitio equivocado.
//
// Aquí se fijan las tres cosas que lo cierran: el criterio único, el error honesto, y que
// activar una licencia readmita el dispositivo. Contra una base central de verdad, nueva en cada
// caso (`helpers/central.ts`).

import { describe, it, expect, vi } from "vitest";

import {
	centralConUnDispositivo,
	centralDePrueba,
	centralInterceptada,
	filasDe,
	type CentralDePrueba,
} from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { cargarDevice, estaRevocado, normalizarRol } from "../src/lib/deviceAuth";
import { verifyDeviceProofOrThrow } from "../src/server/middleware/auth";
import { ensureDevice } from "../src/server/licenseStore";

/** Una base central nueva con los negocios `t-nuevo` y `t-viejo`, y las filas de `dispositivos`. */
async function centralCon(
	...dispositivos: { deviceId: string; tenantId?: string; rol?: "tpv" | "handy"; revocadoMs?: number | null; clave?: string | null }[]
) {
	const central = await centralDePrueba();
	await filasDe(central, "INSERT INTO tenants (tenant_id) VALUES ('t-nuevo'), ('t-viejo');");
	for (const d of dispositivos) {
		await filasDe(
			central,
			`INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms, revoked_at_ms, device_pubkey_b64)
			 VALUES (?, ?, ?, 1, 1, ?, ?);`,
			d.deviceId,
			d.tenantId ?? "t-nuevo",
			d.rol ?? "tpv",
			d.revocadoMs ?? null,
			d.clave ?? null,
		);
	}
	return central;
}

/** La fila del dispositivo `deviceId`, leída por debajo de las guardas de la central. */
const filaDe = async (central: CentralDePrueba, deviceId: string) =>
	(
		await filasDe(
			central,
			`SELECT tenant_id, role, first_seen_at_ms, last_seen_at_ms, revoked_at_ms, device_pubkey_b64, pubkey_alg
			 FROM devices WHERE device_id = ?;`,
			deviceId,
		)
	)[0];

/** El cuerpo entra en la firma como bytes; estas peticiones no llevan ninguno. */
const SIN_CUERPO = new Uint8Array();

/** Petición con un device-proof bien formado (ts fresco); la firma da igual: no se llega a ella. */
function peticionFirmada(): Request {
	return new Request("https://tpv-api.test/v1/pair/pending", {
		method: "POST",
		headers: {
			"X-Device-Ts": String(Date.now()),
			"X-Device-Sig": "firma-que-no-se-llega-a-comprobar",
		},
	});
}

describe("criterio único de revocación", () => {
	it("NULL es el único valor que significa 'vivo'", () => {
		expect(estaRevocado({ revoked_at_ms: null })).toBe(false);
		expect(estaRevocado({ revoked_at_ms: undefined })).toBe(false);
		expect(estaRevocado({})).toBe(false);
	});

	it("un 0 cuenta como revocado, no como vivo", () => {
		// El esquema no puede producir un 0 (la columna es nullable y sin DEFAULT), pero si
		// alguna vez aparece uno, una comprobación de seguridad tiene que fallar CERRANDO.
		// Las dos lecturas que había antes —`OR revoked_at_ms=0` y la truthiness de JS— lo
		// daban por bueno y dejaban pasar al dispositivo.
		expect(estaRevocado({ revoked_at_ms: 0 })).toBe(true);
	});

	it("una fecha de revocación cuenta como revocado", () => {
		expect(estaRevocado({ revoked_at_ms: 1782219539854 })).toBe(true);
	});

	// Lo que pregunta el middleware que firma las peticiones (`verifyDeviceProofOrThrow`): cargar la
	// fila sin filtrar, mirar la revocación y luego el rol.
	it("un dispositivo revocado no tiene rol para nadie: se carga, pero cuenta como revocado", async () => {
		const { db } = await centralConUnDispositivo("tpv", { revocado: true });

		const fila = await cargarDevice(db, "t1", "d1");
		expect(fila).not.toBeNull();
		expect(estaRevocado(fila!)).toBe(true);
	});

	it("y uno vivo sí, sin que una mayúscula lo estropee", async () => {
		// La base sólo admite `tpv` y `handy`: la mayúscula la pone el stub en lo que contesta.
		const { db } = await centralConUnDispositivo("tpv", { contestar: "TPV" });

		const fila = await cargarDevice(db, "t1", "d1");
		expect(fila).not.toBeNull();
		expect(estaRevocado(fila!)).toBe(false);
		expect(fila!.role).toBe("TPV");
		expect(normalizarRol(fila!.role)).toBe("tpv");
	});
});

describe("qué error recibe el dispositivo", () => {
	const claims = { tenantId: "t-nuevo", deviceId: "d-revocado" };

	it("revocado → 'device_revoked', no 'no tienes pubkey'", async () => {
		// El código importa: `device_revoked` está en el catálogo compartido, así que el
		// cliente deja de reintentar y la UI enseña un texto que se entiende. Con el mensaje
		// viejo, la sync giraba en vacío contra una pared cada pocos segundos.
		const { db } = await centralCon({ deviceId: "d-revocado", revocadoMs: 1782219539854, clave: "cGs=" });

		await expect(
			verifyDeviceProofOrThrow(peticionFirmada(), db, claims, "token", SIN_CUERPO),
		).rejects.toThrow("device_revoked");
	});

	it("sin fila → 'device_not_registered'", async () => {
		const { db } = await centralCon();

		await expect(
			verifyDeviceProofOrThrow(
				peticionFirmada(),
				db,
				{ tenantId: "t-nuevo", deviceId: "d-inexistente" },
				"token",
				SIN_CUERPO,
			),
		).rejects.toThrow("device_not_registered");
	});

	it("fila sin pubkey → 'device_pubkey_not_registered'", async () => {
		const { db } = await centralCon({ deviceId: "d-sin-clave", clave: "  " });

		await expect(
			verifyDeviceProofOrThrow(
				peticionFirmada(),
				db,
				{ tenantId: "t-nuevo", deviceId: "d-sin-clave" },
				"token",
				SIN_CUERPO,
			),
		).rejects.toThrow("device_pubkey_not_registered");
	});
});

describe("activar una licencia readmite el dispositivo", () => {
	it("la alta limpia cualquier revocación anterior", async () => {
		// El caso real: el `device_id` vive en el keyring del SO, así que sobrevive a borrar
		// AppData y a cambiar de licencia. Si la activación no limpia la columna, la
		// revocación es permanente e irreparable desde el cliente. Aquí el equipo fue la Handy de
		// otro negocio, lo desvincularon, y vuelve con su clave como Main.
		const central = await centralCon({
			deviceId: "d1",
			tenantId: "t-viejo",
			rol: "handy",
			revocadoMs: 1_600_000_000_000,
			clave: "clave-del-equipo",
		});
		const consultas: SentenciaEnlazada[] = [];
		const vista = centralInterceptada(central, (metodo, [sentencia], llamar) => {
			if (metodo === "ejecutar") consultas.push(sentencia as SentenciaEnlazada);
			return llamar();
		});
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			await ensureDevice(vista.db, "t-nuevo", "d1", "tpv", "clave-del-equipo");
		} finally {
			vi.restoreAllMocks();
		}

		expect(await filaDe(central, "d1")).toMatchObject({
			tenant_id: "t-nuevo",
			role: "tpv",
			first_seen_at_ms: 1,
			last_seen_at_ms: 1_700_000_000_000,
			revoked_at_ms: null,
			device_pubkey_b64: "clave-del-equipo",
		});

		// AUD-01: una sola sentencia, con la clave dentro. Antes eran dos, y un corte entre ellas
		// dejaba una fila sin clave.
		expect(consultas).toHaveLength(1);
		const sql = consultas[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("INSERT INTO devices");
		expect(sql).toContain("device_pubkey_b64, pubkey_alg ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'ed25519')");
		expect(sql).toContain("ON CONFLICT(device_id) DO UPDATE SET");
		expect(sql).toContain("revoked_at_ms=NULL");
		// Y la fila que ya existe sólo se toca si su clave registrada es la que se presenta.
		expect(sql).toContain("WHERE devices.device_pubkey_b64 = excluded.device_pubkey_b64");
		expect(consultas[0].args).toEqual([
			"d1",
			"t-nuevo",
			"tpv",
			1_700_000_000_000,
			1_700_000_000_000,
			"clave-del-equipo",
		]);
	});

	it("si la fila existe con otra clave, o sin ninguna, no la toca y lo dice", async () => {
		// La sentencia no escribe nada: el `WHERE` del `DO UPDATE` no casa.
		const central = await centralCon(
			{ deviceId: "d-con-clave", revocadoMs: 1_600_000_000_000, clave: "clave-del-equipo" },
			{ deviceId: "d-sin-clave", tenantId: "t-viejo", rol: "handy" },
		);
		const antes = [await filaDe(central, "d-con-clave"), await filaDe(central, "d-sin-clave")];

		for (const deviceId of ["d-con-clave", "d-sin-clave"]) {
			await expect(ensureDevice(central.db, "t-nuevo", deviceId, "tpv", "otra-clave"), deviceId).rejects.toMatchObject({
				code: "device_key_mismatch",
			});
		}
		expect([await filaDe(central, "d-con-clave"), await filaDe(central, "d-sin-clave")]).toEqual(antes);
	});
});
