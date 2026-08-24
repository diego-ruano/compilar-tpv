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
// activar una licencia readmita el dispositivo.

import { describe, it, expect, vi } from "vitest";

import { estaRevocado, tieneRol } from "../src/lib/deviceAuth";
import { verifyDeviceProofOrThrow } from "../src/server/middleware/auth";
import { ensureDevice } from "../src/server/licenseStore";

/** Cliente libsql de mentira: devuelve las filas que le digas y guarda el SQL que recibe. */
function bdFalsa(filas: any[]) {
	const consultas: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		execute: async (q: { sql: string; args: unknown[] }) => {
			consultas.push(q);
			return { rows: filas, rowsAffected: 1 };
		},
	} as any;
	return { db, consultas };
}

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

	it("un dispositivo revocado no tiene rol para nadie", async () => {
		const { db } = bdFalsa([
			{ role: "tpv", revoked_at_ms: 1782219539854, device_pubkey_b64: "x" },
		]);

		expect(await tieneRol(db, "t1", "d1", "tpv")).toBe(false);
	});

	it("y uno vivo sí, sin que una mayúscula lo estropee", async () => {
		const { db } = bdFalsa([
			{ role: "TPV", revoked_at_ms: null, device_pubkey_b64: "x" },
		]);

		expect(await tieneRol(db, "t1", "d1", "tpv")).toBe(true);
	});
});

describe("qué error recibe el dispositivo", () => {
	const claims = { tenantId: "t-nuevo", deviceId: "d-revocado" };

	it("revocado → 'device_revoked', no 'no tienes pubkey'", async () => {
		// El código importa: `device_revoked` está en el catálogo compartido, así que el
		// cliente deja de reintentar y la UI enseña un texto que se entiende. Con el mensaje
		// viejo, la sync giraba en vacío contra una pared cada pocos segundos.
		const { db } = bdFalsa([
			{ role: "tpv", revoked_at_ms: 1782219539854, device_pubkey_b64: "cGs=" },
		]);

		await expect(
			verifyDeviceProofOrThrow(peticionFirmada(), db, claims, "token", SIN_CUERPO),
		).rejects.toThrow("device_revoked");
	});

	it("sin fila → 'device_not_registered'", async () => {
		const { db } = bdFalsa([]);

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
		const { db } = bdFalsa([
			{ role: "tpv", revoked_at_ms: null, device_pubkey_b64: "  " },
		]);

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
		// revocación es permanente e irreparable desde el cliente.
		const { db, consultas } = bdFalsa([]);
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

		await ensureDevice(db, "t-nuevo", "d1", "tpv", null);

		const sql = consultas[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("INSERT INTO devices");
		expect(sql).toContain("revoked_at_ms) VALUES (?, ?, ?, ?, ?, NULL)");
		expect(sql).toContain("ON CONFLICT(device_id) DO UPDATE SET");
		expect(sql).toContain("revoked_at_ms=NULL");

		vi.restoreAllMocks();
	});
});
