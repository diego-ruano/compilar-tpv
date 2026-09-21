// test/pairClaim.test.ts
//
// FABLE-D — quién se queda con un código de emparejamiento.
//
// Emparejar una Handy tiene dos rutas: el QR (que lleva un secreto de 32 bytes y se verifica
// criptográficamente) y el código manual de 6 dígitos, que NO lleva secreto y se apoya en la
// aprobación manual del dueño en la Main. Por esa segunda ruta cualquiera que acierte el código
// puede reclamarlo, así que lo que decide la seguridad es a quién se le adjudica y qué ve el
// dueño antes de aprobar.
//
// Lo que aquí se fija: el claim es del PRIMERO, un segundo dispositivo no puede pisarlo, y el
// reclamante legítimo puede reintentar sin perder el suyo.
//
// El SQL es el de verdad: se ejecuta contra el SQLite del Durable Object en vez de contra un
// doble que emule el WHERE, que es justo la parte que interesa comprobar.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { reclamarCodigo } from "../src/domains/pairing/pairing.handy";
import { claimSchema } from "../src/domains/pairing/pairing.schemas";
import { bytesToB64 } from "../src/server/utils/base64";

const CODIGO = "123456";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
const PUB_A = bytesToB64(new Uint8Array(32).fill(1));
const PUB_B = bytesToB64(new Uint8Array(32).fill(2));

/**
 * El cuerpo tal como lo deja el validador de la ruta (`pairing.schemas.ts`). Se pasa por el
 * schema de verdad y no a mano: así lo que prueba el test es lo que recibe la función.
 */
function entrada(cuerpo: Record<string, unknown>) {
	return claimSchema.parse(cuerpo);
}

type Resultado = {
	status: number;
	body: any;
	fila: { claimed_by_device_id: string | null; attempts: number } | null;
};

/**
 * Ejecuta una tanda de claims contra un código recién creado y devuelve, por cada uno, la
 * respuesta y cómo quedó la fila. Cada tanda usa su propio DO (storage limpio).
 */
async function reclamar(
	nombreHub: string,
	claims: { deviceId: string; devicePubKey: string; pairSecret?: string }[],
): Promise<Resultado[]> {
	return enElHub(nombreHub, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql);
		// El esquema de producción, no una copia que pueda divergir.
		prepararPlanoDeControl(sql);
		sql.exec("DELETE FROM pair_requests;");

		const ahora = Date.now();
		sql.exec(
			`INSERT INTO pair_requests
				(pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?);`,
			CODIGO,
			"hash-que-no-se-usa-en-la-ruta-de-solo-codigo",
			"tenant-1",
			"main-1",
			ahora,
			ahora + 10 * 60 * 1000,
		);

		const salida: Resultado[] = [];

		for (const [i, c] of claims.entries()) {
			const res = await reclamarCodigo(
				db,
				{ PAIR_PEPPER: "pepper-de-pruebas" },
				entrada({
					pairCode: CODIGO,
					pairSecret: c.pairSecret ?? "",
					deviceId: c.deviceId,
					devicePubKey: c.devicePubKey,
					deviceName: "",
				}),
				// Una IP por claim: el throttle por IP es otra barrera y no es la que se prueba aquí.
				`10.0.0.${i + 1}`,
				Date.now(),
			);

			const fila =
				(sql
					.exec("SELECT claimed_by_device_id, attempts FROM pair_requests WHERE pair_code = ?;", CODIGO)
					.toArray()[0] as any) ?? null;

			salida.push({
				status: res.status,
				body: res.cuerpo,
				fila: fila
					? {
							claimed_by_device_id: fila.claimed_by_device_id ?? null,
							attempts: Number(fila.attempts ?? 0),
						}
					: null,
			});
		}

		return salida;
	});
}

describe("pair/claim · adjudicación del código (FABLE-D)", () => {
	it("el primer dispositivo se queda el código", async () => {
		const [a] = await reclamar("pair-claim-primero", [
			{ deviceId: DEVICE_A, devicePubKey: PUB_A },
		]);

		expect(a.status).toBe(200);
		expect(a.body.state).toBe("pending_approval");
		expect(a.fila?.claimed_by_device_id).toBe(DEVICE_A);
	});

	it("un segundo dispositivo NO puede pisar el claim del primero", async () => {
		const [, b] = await reclamar("pair-claim-carrera", [
			{ deviceId: DEVICE_A, devicePubKey: PUB_A },
			{ deviceId: DEVICE_B, devicePubKey: PUB_B },
		]);

		expect(b.status).toBe(409);
		expect(b.body.error).toBe("pair_claim_race_or_invalid_state");
		// Lo importante no es el 409, es que el dueño siga viendo al dispositivo legítimo.
		expect(b.fila?.claimed_by_device_id).toBe(DEVICE_A);
	});

	it("el claim rechazado cuenta como intento (quema el código si se martillea)", async () => {
		const [a, b] = await reclamar("pair-claim-intentos", [
			{ deviceId: DEVICE_A, devicePubKey: PUB_A },
			{ deviceId: DEVICE_B, devicePubKey: PUB_B },
		]);

		expect(a.fila?.attempts).toBe(0);
		expect(b.fila?.attempts).toBe(1);
	});

	it("el reclamante legítimo puede reintentar sin perder su claim", async () => {
		const [, segundo] = await reclamar("pair-claim-reintento", [
			{ deviceId: DEVICE_A, devicePubKey: PUB_A },
			{ deviceId: DEVICE_A, devicePubKey: PUB_A },
		]);

		expect(segundo.status).toBe(200);
		expect(segundo.fila?.claimed_by_device_id).toBe(DEVICE_A);
		expect(segundo.fila?.attempts).toBe(0);
	});
});
