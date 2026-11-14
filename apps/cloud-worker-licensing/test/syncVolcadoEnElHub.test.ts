// test/syncVolcadoEnElHub.test.ts
//
// Los volcados de sync por el camino desplegado: la `app` entera, la petición firmada por la Main,
// `alHub` y el TenantHub del negocio (`lib/enElHub.ts`).
//
// Dentro del DO el volcado lee del cursor de su SQLite y sale como bytes ya escritos
// (`domains/sync/volcado.ts`). Lo que se fija aquí es que eso llega entero a quien pregunta
// cruzando el RPC, en un solo viaje y sin ninguna consulta suelta. Que el lector del cursor y el
// del cliente escriben lo mismo, byte a byte, lo fijan los tests de cada ruta (`helpers/dosCaminos.ts`).
//
// El veto de rol (`soloLaMain`) es el de verdad. Dentro del TenantHub decide con el rol que llega
// con la identidad: la base central de pruebas es el SQLite de otro Durable Object, que desde el del
// negocio no se puede tocar, así que un volcado que volviera a ella a por el rol fallaría aquí.

import { describe, expect, it, vi } from "vitest";

import { conNegocioFirmado, enLaBaseDe, pedirFirmado, viajes, type Negocio } from "./helpers/negocioFirmado";

let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const deps = {
	ponerCentral: (db: unknown) => void (dbCentral = db),
	firmarSesion,
	olvidarLicenciasCacheadas,
};

/** La consulta con la que `soloLaMain` le pide el rol a la base central en un router que corre en el Worker. */
const PIDE_EL_ROL = /SELECT role FROM devices WHERE tenant_id=\? AND device_id=\? AND revoked_at_ms IS NULL/;

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

/** La hora de quien pregunta: de ella sale la ventana. */
const AHORA = { "X-Client-Now": new Date().toISOString().slice(0, 19).replace("T", " ") };

describe("los volcados de sync, dentro del TenantHub", () => {
	it("la fase 1 llega entera en un viaje", async () => {
		await conNegocioFirmado(deps, "volcado-hub-fase1", async (n) => {
			await sembrar(n);

			const res = await pedirFirmado(deps, app, n, "/v1/sync/bootstrap", { cabeceras: AHORA });
			expect(res.status).toBe(200);
			// El rol ha viajado con la identidad: nadie se lo ha pedido a la base central.
			expect(n.central.filter((q) => PIDE_EL_ROL.test(q))).toEqual([]);
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(viajes(res, "hub-lee")).toBe(0);
			const cuerpo = JSON.parse(await res.text());
			expect(cuerpo.ok).toBe(true);
			expect(cuerpo.seq).toBe(1);
			const tabla = (nombre: string) => cuerpo.tablas.find((t: any) => t.nombre === nombre);
			expect(tabla("Comandas").filas).toHaveLength(40);
			expect(tabla("Zonas").filas[0]).toContain("Terraza de la ría");
		});
	});

	it("el contraste (su resumen, sus filas y sus claves) y una página del histórico, igual", async () => {
		await conNegocioFirmado(deps, "volcado-hub-resto", async (n) => {
			await sembrar(n);

			for (const [ruta, cuerpo] of [
				["/v1/sync/verificar/resumen", { checkpoint: 1 }],
				["/v1/sync/verificar/filas", { tabla: "Comandas", desde: "2020-01-01 00:00:00", cubos: 2, pedir: [0, 1] }],
				["/v1/sync/verificar/claves", { tabla: "Comandas", limite: 25 }],
				["/v1/sync/historico", { tabla: "Comandas", cursor: 0, limite: 25 }],
			] as const) {
				const res = await pedirFirmado(deps, app, n, ruta, { cuerpo, cabeceras: AHORA });
				expect(res.status, ruta).toBe(200);
				expect(viajes(res, "hub-ruta"), ruta).toBe(1);
				expect(viajes(res, "hub-lee"), ruta).toBe(0);
				await res.text();
			}

			const pagina = await (
				await pedirFirmado(deps, app, n, "/v1/sync/historico", {
					cuerpo: { tabla: "Comandas", cursor: 0, limite: 25 },
				})
			).json<any>();
			expect(pagina.filas).toHaveLength(25);
			expect(pagina.siguiente_cursor).toBe(25);
		});
	});

	it("sin base, la fase 1 lo dice con su código", async () => {
		// Es lo que la pantalla de recuperación necesita para ofrecer «empezar de cero»
		// (`tenant_db_not_provisioned`): no un 500 del lector en bruto, que pide la base al motor. Lo
		// recibe un negocio que no ha nacido; el que ya nació, `test/basePerdida.test.ts`.
		await conNegocioFirmado(
			deps,
			"volcado-hub-sin-base",
			async (n) => {
				n.enCentral(`UPDATE licenses SET activated_at_ms = NULL WHERE tenant_id = ?;`, n.tenantId);
				const res = await pedirFirmado(deps, app, n, "/v1/sync/bootstrap", { cabeceras: AHORA });
				expect(res.status).toBe(404);
				expect(await res.json()).toMatchObject({ ok: false, code: "tenant_db_not_provisioned" });
			},
			// La ruta pregunta a la base central desde dentro del TenantHub: va en su mismo objeto.
			{ sinBase: true, centralEnElNegocio: true },
		);
	});
});
