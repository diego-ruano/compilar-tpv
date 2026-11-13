// test/syncVolcadoEnElHub.test.ts
//
// Los volcados de sync por el camino desplegado: la `app` entera, la petición firmada por la Main,
// `alHub` y el TenantHub del negocio (`lib/enElHub.ts`).
//
// Dentro del DO el volcado lee del cursor de su SQLite y sale como bytes ya escritos
// (`domains/sync/volcado.ts`). Lo que se fija aquí es que eso llega entero a quien pregunta
// cruzando el RPC, en un solo viaje y sin ninguna consulta suelta, y que con la ruta ejecutándose
// en el Worker la respuesta es la misma.

import { describe, expect, it, vi } from "vitest";

import { conNegocioFirmado, enLaBaseDe, pedirFirmado, viajes, type Negocio } from "./helpers/negocioFirmado";

let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

// El veto de rol (`soloLaMain`) lee la base central ya dentro del TenantHub, y el doble de la base
// central es el SQLite de otro Durable Object, que desde el del negocio no se puede tocar. No es lo
// que se prueba aquí: `tenantAuth`, que sí corre en el Worker, es el de verdad.
vi.mock("../src/middleware/tenant", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/middleware/tenant")>();
	return { ...original, soloLaMain: () => async (_c: unknown, next: () => Promise<void>) => next() };
});

const { app } = await import("../src/app");

function sembrar(n: Negocio): Promise<void> {
	return enLaBaseDe(n, (sql) => {
		sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza de la ría');");
		for (let i = 0; i < 40; i++) {
			sql.exec(
				`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
				 VALUES (?, 'BARRA', datetime('now'), 'Abierta');`,
				`c-${String(i).padStart(3, "0")}`,
			);
		}
		sql.exec(
			"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES ('op-1', '[]', 1);",
		);
	});
}

/**
 * La hora de quien pregunta, la misma en las dos peticiones que se comparan: de ella sale la ventana,
 * y pedidas a un lado y a otro de un cambio de segundo las respuestas se diferenciarían en eso.
 */
const AHORA = { "X-Client-Now": new Date().toISOString().slice(0, 19).replace("T", " ") };

/** Lo mismo con la ruta en el Worker: cada lectura es una consulta al DO. */
const EN_EL_WORKER = { entorno: { EJECUTAR_EN_EL_HUB: "0" }, cabeceras: AHORA };

describe("los volcados de sync, dentro del TenantHub", () => {
	it("la fase 1 llega entera en un viaje, y es la misma que con la ruta en el Worker", async () => {
		await conNegocioFirmado("volcado-hub-fase1", (db) => (dbCentral = db), async (n) => {
			await sembrar(n);

			const res = await pedirFirmado(app, n, "/v1/sync/bootstrap", { cabeceras: AHORA });
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(viajes(res, "hub-lee")).toBe(0);
			const texto = await res.text();
			const cuerpo = JSON.parse(texto);
			expect(cuerpo.ok).toBe(true);
			expect(cuerpo.seq).toBe(1);
			const tabla = (nombre: string) => cuerpo.tablas.find((t: any) => t.nombre === nombre);
			expect(tabla("Comandas").filas).toHaveLength(40);
			expect(tabla("Zonas").filas[0]).toContain("Terraza de la ría");

			const fuera = await pedirFirmado(app, n, "/v1/sync/bootstrap", EN_EL_WORKER);
			expect(viajes(fuera, "hub-ruta")).toBe(0);
			expect(viajes(fuera, "hub-lee")).toBeGreaterThan(0);
			expect(await fuera.text()).toBe(texto);
		});
	});

	it("el contraste y una página del histórico, igual", async () => {
		await conNegocioFirmado("volcado-hub-resto", (db) => (dbCentral = db), async (n) => {
			await sembrar(n);

			for (const [ruta, cuerpo] of [
				["/v1/sync/verificar", {}],
				["/v1/sync/historico", { tabla: "Comandas", cursor: 0, limite: 25 }],
			] as const) {
				const res = await pedirFirmado(app, n, ruta, { cuerpo, cabeceras: AHORA });
				expect(res.status, ruta).toBe(200);
				expect(viajes(res, "hub-ruta"), ruta).toBe(1);
				expect(viajes(res, "hub-lee"), ruta).toBe(0);
				const texto = await res.text();

				const fuera = await pedirFirmado(app, n, ruta, { cuerpo, ...EN_EL_WORKER });
				expect(viajes(fuera, "hub-ruta"), ruta).toBe(0);
				expect(await fuera.text(), ruta).toBe(texto);
			}

			const pagina = await (
				await pedirFirmado(app, n, "/v1/sync/historico", {
					cuerpo: { tabla: "Comandas", cursor: 0, limite: 25 },
				})
			).json<any>();
			expect(pagina.filas).toHaveLength(25);
			expect(pagina.siguiente_cursor).toBe(25);
		});
	});
});
