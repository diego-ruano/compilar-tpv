// test/syncGzipTransmision.test.ts
//
// Lo que le llega a quien pide una respuesta de sync comprimida (`lib/gzip.ts`), ya transmitida.
//
// `syncGzip.test.ts` mira la respuesta que construye la ruta. Aquí la petición entra por el worker
// entero (`SELF`) y la respuesta sale por su transmisión, que es donde el runtime comprime por su
// cuenta lo que lleva `Content-Encoding` si no se le dice que ya viene comprimido
// (`encodeBody: "manual"`). El cliente descomprime una vez, como hará la Main: si la respuesta
// saliera comprimida dos veces, lo que leería no sería JSON.
//
// De paso recorre el camino desplegado: el Worker le pasa la petición al TenantHub, que contesta sin
// comprimir, y comprime el Worker lo que vuelve.

import { SELF, env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";

const NEGOCIO = "gzip-transmision";

/** El rol con el que el Worker da por autenticado a quien pregunta. */
let rol = "tpv";

// Quién pregunta no es lo que se prueba: la autenticación lee la base central, y aquí se da por
// hecha. El veto de rol sí es el de verdad: se decide dentro del TenantHub con el rol que el Worker
// manda en la identidad (`alHub`), sin volver a la base central.
vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", NEGOCIO);
		c.set("deviceId", "main-1");
		c.set("token", "token");
		c.set("licHash", "hash");
		c.set("rol", rol);
		await next();
	},
}));

const env = entorno as any;

/** La misma hora en todas las peticiones: de ella sale la ventana del volcado. */
const AHORA = new Date().toISOString().slice(0, 19).replace("T", " ");

async function pedir(ruta: string, cuerpo: unknown, acepta?: string): Promise<Response> {
	return SELF.fetch(`https://tpv.test${ruta}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Client-Now": AHORA,
			...(acepta ? { "Accept-Encoding": acepta } : {}),
		},
		body: JSON.stringify(cuerpo),
	});
}

function viajes(res: Response, tramo: string): number {
	const m = new RegExp(`(?:^|, )${tramo};dur=[\\d.]+;desc="(\\d+)"`).exec(res.headers.get("Server-Timing") ?? "");
	return m ? Number(m[1]) : 0;
}

describe("una respuesta de sync comprimida, ya transmitida", () => {
	it("llega comprimida una sola vez, y dice lo mismo que sin comprimir", async () => {
		await env.TenantHub.get(env.TenantHub.idFromName(NEGOCIO)).aprovisionar(NEGOCIO);
		await enElHub(NEGOCIO, (hub: any) => {
			const sql = hub.state.storage.sql;
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza de la ría');");
			for (let i = 0; i < 50; i++) {
				sql.exec(
					`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
					 VALUES (?, 'BARRA', '2020-01-01 12:00:00', 'Abierta');`,
					`c-${i}`,
				);
			}
			sql.exec(
				`INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms)
				 VALUES ('op-1', 'mesas.abrir', '[{"sql":"SELECT 1;","args":[]}]', 'handy-1', 1);`,
			);
		});

		for (const [ruta, cuerpo] of [
			["/v1/sync/bootstrap", {}],
			["/v1/sync/changes", { since: 0 }],
		] as const) {
			const llana = await pedir(ruta, cuerpo);
			expect(llana.status, ruta).toBe(200);
			expect(llana.headers.get("Content-Encoding"), ruta).toBeNull();
			const esperado = await llana.json<any>();
			expect(esperado.ok, ruta).toBe(true);

			const comprimida = await pedir(ruta, cuerpo, "gzip");
			expect(comprimida.status, ruta).toBe(200);
			expect(comprimida.headers.get("Content-Encoding"), ruta).toBe("gzip");
			// La ruta se ejecutó en el TenantHub, en un viaje, y lo que volvió lo comprimió el Worker.
			expect(viajes(comprimida, "hub-ruta"), ruta).toBe(1);
			// El cliente descomprime una vez y lee JSON: el mismo.
			expect(await comprimida.json(), ruta).toEqual(esperado);
		}
	});

	it("una Handy se queda fuera dentro del TenantHub, y el rechazo no sale comprimido", async () => {
		await env.TenantHub.get(env.TenantHub.idFromName(NEGOCIO)).aprovisionar(NEGOCIO);
		rol = "handy";
		try {
			const vetada = await pedir("/v1/sync/bootstrap", {}, "gzip");
			expect(vetada.status).toBe(403);
			expect(vetada.headers.get("Content-Encoding")).toBeNull();
			expect((await vetada.json<any>()).error).toBe("forbidden_not_tpv");
			// Lo decidió el veto de rol de la ruta, ya dentro del DO, con el rol de la identidad.
			expect(viajes(vetada, "hub-ruta")).toBe(1);
		} finally {
			rol = "tpv";
		}
	});
});
