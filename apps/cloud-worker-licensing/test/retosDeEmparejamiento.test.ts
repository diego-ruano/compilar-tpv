// test/retosDeEmparejamiento.test.ts
//
// AUD-13 · Lo que deja en la base central cada reclamación de un código de emparejamiento.
//
// El mismo dispositivo puede reclamar su código pendiente sin cupo (es como se recupera una Handy
// que se cerró esperando), y cada vez entra en `device_challenges` un reto con su `deviceId`. Antes
// el `deviceId` y el `deviceName` no tenían tope y nada borraba los retos: con unas 1 340
// reclamaciones de 50 000 caracteres, la copia diaria de la base central (PROD-02) pasaba de su
// techo y dejaba de subirse, para todos los negocios y cada día, hasta borrar las filas a mano.
//
// Hacen falta las dos cosas que se fijan aquí: sin tope, el abuso cabe en los diez minutos que vive
// un código; sin purga, lo que cabe se acumula.
//
// Datos ficticios, sin red: la base central es el SQLite de un Durable Object de pruebas con la
// estructura de producción (`helpers/planoDeControl.ts`), R2 es el local de miniflare y los latidos
// se interceptan con un espía de `fetch`.

import {
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

/** La base que ven las rutas y el cron: `getDb` es lo único que se sustituye. */
let dbDePruebas: any = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { pairingRoutes } = await import("../src/domains/pairing/pairing.routes");
const { PREFIJO_COPIAS, TOPE_CARACTERES } = await import("../src/server/copiaBaseCentral");
const worker = (await import("../src/index")).default as ExportedHandler<any>;

const elWorker = new Hono().route("/v1/pair", pairingRoutes);

const CODIGO = "482913";
const PUB = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // 32 bytes: lo único que mira el schema
const MIN = 60_000;
const TABLAS = ["pair_requests", "device_challenges", "pair_claim_fallos"];

const bucket = () => (env as any).COPIAS as R2Bucket;

function pedir(ruta: string, cuerpo: Record<string, unknown>, ip = "198.51.100.13") {
	return elWorker.fetch(
		new Request(`https://api.test/v1/pair/${ruta}`, {
			method: "POST",
			headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
			body: JSON.stringify(cuerpo),
		}),
		{ PAIR_PEPPER: "pepper-de-pruebas" },
	);
}

const reclamacion = (deviceId: string, deviceName = "") => ({
	pairCode: CODIGO,
	pairSecret: "",
	deviceId,
	devicePubKey: PUB,
	deviceName,
});

/** Base central vacía con UN código pendiente, vivo diez minutos desde `ahora`. */
async function conCodigo<R>(nombre: string, ahora: number, prueba: (sql: any) => Promise<R>): Promise<R> {
	return enElHub(`retos-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const t of TABLAS) sql.exec(`DELETE FROM ${t};`);
		sql.exec(
			`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
			 VALUES (?, 'sin-secreto', 'tenant-1', 'main-1', 'pending', ?, ?);`,
			CODIGO,
			ahora,
			ahora + 10 * MIN,
		);
		dbDePruebas = clienteSobre(sql);
		try {
			return await prueba(sql);
		} finally {
			for (const t of TABLAS) sql.exec(`DELETE FROM ${t};`);
			dbDePruebas = null;
		}
	});
}

const cuantos = (sql: any, tabla: string) => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).toArray()[0].n);

describe("AUD-13 · el deviceId y el nombre que se guardan tienen tope", () => {
	it("un deviceId de 201 caracteres se rechaza sin dejar nada; uno de 200 entra", async () => {
		await conCodigo("tope-id", Date.now(), async (sql) => {
			const largo = await pedir("claim", reclamacion("h".repeat(201)));
			expect(largo.status).toBe(400);
			expect(((await largo.json()) as any).error).toBe("invalid_deviceId");
			expect(cuantos(sql, "device_challenges")).toBe(0);
			expect(cuantos(sql, "pair_claim_fallos")).toBe(0);
			expect(sql.exec(`SELECT claimed_by_device_id FROM pair_requests;`).toArray()).toEqual([
				{ claimed_by_device_id: null },
			]);

			const justo = await pedir("claim", reclamacion("h".repeat(200)));
			expect(justo.status).toBe(200);
			expect(cuantos(sql, "device_challenges")).toBe(1);
		});
	});

	it("un nombre de 201 caracteres, igual", async () => {
		await conCodigo("tope-nombre", Date.now(), async (sql) => {
			const largo = await pedir("claim", reclamacion("handy-1", "n".repeat(201)));
			expect(largo.status).toBe(400);
			expect(((await largo.json()) as any).error).toBe("invalid_deviceName");
			expect(cuantos(sql, "device_challenges")).toBe(0);

			expect((await pedir("claim", reclamacion("handy-1", "n".repeat(200)))).status).toBe(200);
		});
	});

	it("fetch-token y cancel tampoco aceptan un deviceId de más de 200", async () => {
		await conCodigo("tope-firmadas", Date.now(), async () => {
			for (const ruta of ["fetch-token", "cancel"]) {
				const r = await pedir(ruta, {
					pairCode: CODIGO,
					deviceId: "h".repeat(201),
					nonceB64: "bm9uY2U=",
					sigB64: "x",
					ts: Date.now(),
				});
				expect(r.status).toBe(400);
				expect(((await r.json()) as any).error).toBe("invalid_deviceId");
			}
		});
	});
});

describe("AUD-13 · los retos caducados no se acumulan", () => {
	it(
		"con el techo REAL de la copia y el cron de verdad: los retos caducados se purgan y la copia sale con sus dos latidos",
		async () => {
			// Lo que dejaba el abuso de antes, metido a mano: retos caducados cuyo `deviceId` suma más
			// que el techo de la copia. Cada fila cuesta L + 204 caracteres en el volcado.
			const L = 1_900_000; // cabe en una fila del SQLite del DO (2 MB)
			const N = Math.ceil(TOPE_CARACTERES / (L + 204)) + 1;
			const latidos: string[] = [];
			const errores: string[] = [];
			const entorno = {
				...(env as any),
				COPIAS: bucket(),
				BETTERSTACK_HEARTBEAT_URL: "https://latido-cron.invalid/aud13",
				BETTERSTACK_HEARTBEAT_COPIAS_URL: "https://latido-copias.invalid/aud13",
			};
			const espiaFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (entrada: any) => {
				latidos.push(String(entrada?.url ?? entrada));
				return new Response("ok");
			});
			const espiaError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
				errores.push(args.map(String).join(" "));
			});

			try {
				const r = await conCodigo("cron", Date.now(), async (sql) => {
					const antes = (await bucket().list({ prefix: PREFIJO_COPIAS })).objects.map((o) => o.key);
					const relleno = "z".repeat(L - 8);
					const caducado = Date.now() - 20 * MIN;
					for (let i = 0; i < N; i++) {
						sql.exec(
							`INSERT INTO device_challenges (device_id, nonce_b64, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?);`,
							`${String(i).padStart(8, "0")}${relleno}`,
							`reto-${i}`,
							caducado,
							caducado - 10 * MIN,
						);
					}
					// Y uno vivo, que se tiene que quedar.
					sql.exec(
						`INSERT INTO device_challenges (device_id, nonce_b64, expires_at_ms, created_at_ms) VALUES ('handy-viva', 'n', ?, ?);`,
						Date.now() + 5 * MIN,
						Date.now(),
					);
					const suma = Number(sql.exec(`SELECT SUM(length(device_id)) AS l FROM device_challenges;`).toArray()[0].l);

					const ctx = createExecutionContext();
					await worker.scheduled!(
						createScheduledController({ scheduledTime: Date.now(), cron: "0 7 * * *" }),
						entorno,
						ctx,
					);
					await waitOnExecutionContext(ctx);

					const nuevas = (await bucket().list({ prefix: PREFIJO_COPIAS })).objects
						.map((o) => o.key)
						.filter((k) => !antes.includes(k));
					for (const k of nuevas) await bucket().delete(k);
					const quedan = sql.exec(`SELECT substr(device_id, 1, 20) AS id FROM device_challenges;`).toArray();
					return { suma, nuevas, quedan };
				});

				// El abuso de antes pasaba del techo…
				expect(r.suma + N * 204).toBeGreaterThan(TOPE_CARACTERES);
				// …y ahora la purga se lo lleva antes de copiar: hay copia y suenan los dos latidos.
				expect(errores.filter((e) => e.includes("copia_demasiado_grande")).map((e) => e.slice(0, 200))).toEqual([]);
				expect(r.nuevas).toHaveLength(1);
				expect(latidos.some((u) => u.includes("latido-copias"))).toBe(true);
				expect(latidos.some((u) => u.includes("latido-cron"))).toBe(true);
				expect(r.quedan).toEqual([{ id: "handy-viva" }]);
			} finally {
				espiaFetch.mockRestore();
				espiaError.mockRestore();
			}
		},
		300_000,
	);
});
