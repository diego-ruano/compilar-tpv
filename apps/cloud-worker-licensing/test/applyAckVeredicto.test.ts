// test/applyAckVeredicto.test.ts
//
// SYNC-20, REV-11 · El veredicto que viaja en el `apply_ack` de una escritura de la Main.
//
// La Main no mira el texto del error: aparta la operación si el ack dice `permanente`, no le gasta
// ningún intento si dice `transitorio`, y se lo cuenta si no dice ninguna de las dos cosas. Quien
// clasifica es el DO (`tenantHub.errores.ts`), y aquí se comprueba con el motor de verdad: la
// sentencia la rechaza el SQLite del Durable Object, o el fallo lo lanza el propio hub con su
// código.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { HubError } from "../src/lib/errorHttp";

const TENANT = "tenant-ack";
const MAIN = "main-ack";

type Preparado = {
	sql: any;
	/** Los eventos de salud que habrían ido a Axiom. */
	eventos: { name: string; [campo: string]: unknown }[];
	/** Hace que la base falle al escribir con este error; `null` la deja como está. */
	romper: (error: unknown | null) => void;
	/** Manda un `apply` por el socket de la Main y devuelve su ack. */
	aplicar: (opId: string, sql: string, args?: unknown[]) => Promise<any>;
};

/** Un hub con su base, una Main conectada y lista, y la base central sin red. */
function preparar(hub: any): Preparado {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	// El cliente de producción: el lote atómico y las claves foráneas aplazadas de `loteEnBruto`.
	const base = clienteLocal(hub.state.storage);
	let fallo: unknown | null = null;
	const db = {
		...base,
		async batch(sentencias: any[], modo?: string) {
			if (fallo && modo === "write") throw fallo;
			return base.batch(sentencias, modo as any);
		},
	};
	hub.getTenantDb = async () => db;
	hub.touchLastSeen = async () => {};
	hub.colaPausada = async () => null;
	const eventos: Preparado["eventos"] = [];
	hub.emitSyncEvent = (name: string, campos: Record<string, unknown>) => void eventos.push({ name, ...campos });
	laMainEs(hub, MAIN);

	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [MAIN]);
	par[1].serializeAttachment({
		tenantId: TENANT,
		deviceId: MAIN,
		role: "tpv",
		authed: true,
		pubkeyB64: null,
		challenge: null,
		recovering: false,
	});
	const recibidos: any[] = [];
	par[0].accept();
	par[0].addEventListener("message", (ev: MessageEvent) => recibidos.push(JSON.parse(String(ev.data))));

	const aplicar = async (opId: string, texto: string, args: unknown[] = []) => {
		const desde = recibidos.length;
		await hub.webSocketMessage(
			par[1],
			JSON.stringify({
				type: "apply",
				opId,
				commandName: "x",
				command: { type: "tenantDb.transaction", payload: { steps: [{ kind: "execute", sql: texto, args }] } },
			}),
		);
		const limite = Date.now() + 3_000;
		while (Date.now() < limite) {
			const ack = recibidos.slice(desde).find((m) => m.type === "apply_ack" && m.opId === opId);
			if (ack) return ack;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`no llegó el apply_ack de ${opId}`);
	};

	return { sql, eventos, romper: (error) => void (fallo = error), aplicar };
}

const ALTA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

describe("el apply_ack dice de qué clase es el fallo", () => {
	it("lo que rechaza el SQLite del DO por la sentencia es permanente", async () => {
		await enElHub("ack-permanente", async (hub: any) => {
			const { aplicar } = preparar(hub);
			expect(await aplicar("op-ok", ALTA, ["z1", "Sala"])).toMatchObject({ ok: true });

			const CASOS: [string, string, unknown[]][] = [
				["una columna que no existe", "UPDATE Zonas SET Columna_Que_No_Existe = 1;", []],
				["una tabla que no existe", "INSERT INTO Tabla_Que_No_Existe (a) VALUES (1);", []],
				["la clave repetida", ALTA, ["z1", "Otra"]],
				["una clave foránea rota", "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1', 'NO-EXISTE', '1', 4, 0, 0, 'rect', 10, 10);", []],
				["un valor fuera de su dominio (RI-48)", "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Estado) VALUES ('r1', '2026-11-13', '21:00', 'CENA', 'DESCONOCIDO');", []],
				// Los límites del SQLite del DO.
				["un patrón de LIKE de más de 50 bytes", "UPDATE Zonas SET Nombre_Zona = 'x' WHERE Nombre_Zona LIKE ?1;", ["%" + "a".repeat(60) + "%"]],
				["más de 5 SELECT en un compuesto", `INSERT INTO Zonas (ID_Zona, Nombre_Zona) ${Array.from({ length: 6 }, (_, i) => `SELECT 'u${i}', 'U${i}'`).join(" UNION ALL ")};`, []],
				["un valor que no cabe en una fila", ALTA, ["z-grande", "a".repeat(3_000_000)]],
			];
			for (const [caso, texto, args] of CASOS) {
				const ack = await aplicar(`op-${caso}`, texto, args);
				expect(ack, `${caso}: ${ack.error}`).toMatchObject({ ok: false, permanente: true, transitorio: false });
			}
		});
	});

	it("una hora que tendría que poner la nube es permanente por su código", async () => {
		await enElHub("ack-codigo-permanente", async (hub: any) => {
			const { aplicar } = preparar(hub);
			const ack = await aplicar("op-hora", "UPDATE Zonas SET Updated_At = CURRENT_TIMESTAMP;");
			expect(ack).toMatchObject({ ok: false, permanente: true, transitorio: false });
			expect(ack.error).toContain("hora_no_determinista");
		});
	});

	it("un negocio sin base no le gasta intentos a la operación", async () => {
		await enElHub("ack-sin-base", async (hub: any) => {
			const { aplicar } = preparar(hub);
			hub.getTenantDb = async () => {
				throw new HubError("tenant_db_not_provisioned", 404);
			};
			expect(await aplicar("op-sin-base", ALTA, ["z1", "Sala"])).toMatchObject({
				ok: false,
				error: "tenant_db_not_provisioned",
				permanente: false,
				transitorio: true,
			});
		});
	});

	it("una base llena no aparta ni gasta intentos, y avisa una sola vez", async () => {
		await enElHub("ack-base-llena", async (hub: any) => {
			const { sql, eventos, romper, aplicar } = preparar(hub);
			romper(new Error("database or disk is full: SQLITE_FULL"));

			for (const opId of ["op-1", "op-2", "op-3"]) {
				expect(await aplicar(opId, ALTA, [opId, opId])).toMatchObject({
					ok: false,
					permanente: false,
					transitorio: true,
				});
			}
			expect(eventos.filter((e) => e.name === "base_llena")).toHaveLength(1);
			expect(eventos.filter((e) => e.name === "apply_error")).toHaveLength(3);

			// Con sitio otra vez, la misma operación entra: no se había apartado nada.
			romper(null);
			expect(await aplicar("op-1", ALTA, ["op-1", "op-1"])).toMatchObject({ ok: true });
			expect(sql.exec("SELECT COUNT(*) AS n FROM Zonas;").toArray()[0].n).toBe(1);
		});
	});

	it("un fallo del runtime del objeto es pasajero aunque arrastre texto de SQL", async () => {
		await enElHub("ack-runtime", async (hub: any) => {
			const { romper, aplicar } = preparar(hub);
			romper(new Error("Durable Object storage operation exceeded timeout which caused object to be reset."));
			expect(await aplicar("op-reset", ALTA, ["z1", "Sala"])).toMatchObject({
				ok: false,
				permanente: false,
				transitorio: true,
			});
		});
	});

	it("lo que no se sabe clasificar cuenta como intento: ni permanente ni pasajero", async () => {
		await enElHub("ack-desconocido", async (hub: any) => {
			const { romper, aplicar } = preparar(hub);
			romper(new Error("algo raro ha pasado"));
			expect(await aplicar("op-rara", ALTA, ["z1", "Sala"])).toMatchObject({
				ok: false,
				permanente: false,
				transitorio: false,
			});
		});
	});
});
