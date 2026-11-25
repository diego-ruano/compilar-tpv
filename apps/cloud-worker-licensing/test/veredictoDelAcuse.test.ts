// test/veredictoDelAcuse.test.ts
//
// SYNC-20, REV-11 · El veredicto que viaja en el acuse de lo que sube la Main (`apply_lote_ack`).
//
// La Main no mira el texto del error: aparta la operación si el acuse dice `permanente`, no le gasta
// ningún intento si dice `transitorio`, y se lo cuenta si no dice ninguna de las dos cosas. Quien
// clasifica es el DO (`tenantHub.errores.ts`), y aquí se comprueba con el motor de verdad, cada
// operación en un lote para ella: la sentencia la rechaza el SQLite del Durable Object, o el fallo lo
// lanza el propio hub con su código. Lo que afecta al lote entero (un negocio sin base) sale en el
// acuse del lote, con la misma clasificación.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { centralConLaMain } from "./helpers/mainVigente";
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
	/** Manda la operación sola en un `apply_lote` y devuelve su veredicto (o el del lote, si lo rechaza entero). */
	aplicar: (opId: string, sql: string, args?: unknown[]) => Promise<any>;
	/** Lo mismo, con los pasos de la transacción tal cual. */
	aplicarPasos: (opId: string, steps: unknown[]) => Promise<any>;
};

/** Un hub con su base, una Main conectada y lista, y una base central de verdad con su licencia. */
async function preparar(hub: any): Promise<Preparado> {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	hub.getTenantDb = async () => clienteLocal(hub.state.storage);
	const eventos: Preparado["eventos"] = [];
	hub.emitSyncEvent = (name: string, campos: Record<string, unknown>) => void eventos.push({ name, ...campos });
	await centralConLaMain(hub, TENANT, MAIN);

	// El lote atómico de cada operación (`loteEnBruto`, con las claves foráneas aplazadas si hace
	// falta), con un fallo delante si se pide.
	let fallo: unknown | null = null;
	const real = hub.loteLocal.bind(hub);
	hub.loteLocal = (sentencias: any[], alAplazar: () => boolean) => {
		if (fallo) throw fallo;
		return real(sentencias, alAplazar);
	};

	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [MAIN]);
	par[1].serializeAttachment({
		tenantId: TENANT,
		deviceId: MAIN,
		role: "tpv",
		authed: true,
		autenticadaMs: Date.now(),
		pubkeyB64: null,
		challenge: null,
		recovering: false,
	});
	const recibidos: any[] = [];
	par[0].accept();
	par[0].addEventListener("message", (ev: MessageEvent) => recibidos.push(JSON.parse(String(ev.data))));

	let lotes = 0;
	const aplicarPasos = async (opId: string, steps: unknown[]) => {
		const loteId = `lote-${++lotes}`;
		await hub.webSocketMessage(
			par[1],
			JSON.stringify({
				type: "apply_lote",
				loteId,
				ops: [{ opId, commandName: "x", command: { type: "tenantDb.transaction", payload: { steps } } }],
			}),
		);
		const limite = Date.now() + 3_000;
		while (Date.now() < limite) {
			const acuse = recibidos.find((m) => m.type === "apply_lote_ack" && m.loteId === loteId);
			if (acuse) {
				if (!acuse.ok) return acuse;
				expect(acuse.resultados).toHaveLength(1);
				return acuse.resultados[0];
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`no llegó el acuse de ${opId}`);
	};
	const aplicar = (opId: string, texto: string, args: unknown[] = []) =>
		aplicarPasos(opId, [{ kind: "execute", sql: texto, args }]);

	return { sql, eventos, romper: (error) => void (fallo = error), aplicar, aplicarPasos };
}

const ALTA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

describe("el acuse dice de qué clase es el fallo", () => {
	it("lo que rechaza el SQLite del DO por la sentencia es permanente", async () => {
		await enElHub("ack-permanente", async (hub: any) => {
			const { aplicar, eventos } = await preparar(hub);
			expect(await aplicar("op-ok", ALTA, ["z1", "Sala"])).toMatchObject({ ok: true });

			const CASOS: [string, string, unknown[]][] = [
				["una columna que no existe", "UPDATE Zonas SET Columna_Que_No_Existe = 1;", []],
				["una tabla que no existe", "INSERT INTO Tabla_Que_No_Existe (a) VALUES (1);", []],
				// El nombre lo pone la sentencia y sale en el mensaje: no lo convierte en un fallo de la base.
				["una columna que se llama como un código de SQLite", "UPDATE Zonas SET sqlite_full = 1;", []],
				["una tabla que se llama como un estado de la base", `INSERT INTO "database is locked" (a) VALUES (1);`, []],
				["la clave repetida", ALTA, ["z1", "Otra"]],
				["una clave foránea rota", "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1', 'NO-EXISTE', '1', 4, 0, 0, 'rect', 10, 10);", []],
				["un valor fuera de su dominio (RI-48)", "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Estado) VALUES ('r1', '2026-11-13', '21:00', 'CENA', 'DESCONOCIDO');", []],
				// Los límites del SQLite del DO.
				["un patrón de LIKE de más de 50 bytes", "UPDATE Zonas SET Nombre_Zona = 'x' WHERE Nombre_Zona LIKE ?1;", ["%" + "a".repeat(60) + "%"]],
				["más de 5 SELECT en un compuesto", `INSERT INTO Zonas (ID_Zona, Nombre_Zona) ${Array.from({ length: 6 }, (_, i) => `SELECT 'u${i}', 'U${i}'`).join(" UNION ALL ")};`, []],
				// Pasa del tope de un valor en el SQLite del DO (algo más de 2 MiB) y cabe en un mensaje.
				["un valor que no cabe en una fila", ALTA, ["z-grande", "a".repeat(3_000_000)]],
			];
			for (const [caso, texto, args] of CASOS) {
				const v = await aplicar(`op-${caso}`, texto, args);
				expect(v, `${caso}: ${v.error}`).toMatchObject({ ok: false, permanente: true, transitorio: false });
			}
			// Y ninguno se ha tomado por una base llena.
			expect(eventos.filter((e) => e.name === "base_llena")).toEqual([]);
		});
	});

	it("una operación que no se deja montar es permanente, aunque su SQL lleve una frase del runtime", async () => {
		// El rechazo lo lanza el propio hub con el SQL del paso detrás de su identificador. Leído
		// como texto, `readonly database` lo hacía pasajero y una base llena.
		await enElHub("ack-no-se-monta", async (hub: any) => {
			const { aplicarPasos, eventos } = await preparar(hub);
			const CASOS: [string, unknown[]][] = [
				["un paso value que no se sabe evaluar", [{ kind: "value", sql: "SELECT 'readonly database'", saveAs: "v" }]],
				["una referencia a un paso que no está", [{ kind: "execute", sql: ALTA, args: ["z1", { $ref: "database is locked" }] }]],
				["una clase de paso que no existe", [{ kind: "timed out", sql: ALTA, args: ["z1", "Sala"] }]],
				["sin pasos", []],
			];
			for (const [caso, pasos] of CASOS) {
				const v = await aplicarPasos(`op-${caso}`, pasos);
				expect(v, `${caso}: ${v.error}`).toMatchObject({ ok: false, permanente: true, transitorio: false });
			}
			expect(eventos.filter((e) => e.name === "base_llena")).toEqual([]);
		});
	});

	it("una hora que tendría que poner la nube es permanente por su código", async () => {
		await enElHub("ack-codigo-permanente", async (hub: any) => {
			const { aplicar } = await preparar(hub);
			const v = await aplicar("op-hora", "UPDATE Zonas SET Updated_At = CURRENT_TIMESTAMP;");
			expect(v).toMatchObject({ ok: false, permanente: true, transitorio: false });
			expect(v.error).toContain("hora_no_determinista");
		});
	});

	it("un negocio sin base no le gasta intentos a ninguna operación del lote", async () => {
		await enElHub("ack-sin-base", async (hub: any) => {
			const { aplicar } = await preparar(hub);
			hub.getTenantDb = async () => {
				throw new HubError("tenant_db_not_provisioned", 404);
			};
			// No se ha aplicado nada: el acuse es del lote entero.
			expect(await aplicar("op-sin-base", ALTA, ["z1", "Sala"])).toMatchObject({
				type: "apply_lote_ack",
				ok: false,
				error: "tenant_db_not_provisioned",
				permanente: false,
				transitorio: true,
			});
		});
	});

	it("una base llena no aparta ni gasta intentos, y avisa una sola vez", async () => {
		await enElHub("ack-base-llena", async (hub: any) => {
			const { sql, eventos, romper, aplicar } = await preparar(hub);
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
			const { romper, aplicar } = await preparar(hub);
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
			const { romper, aplicar } = await preparar(hub);
			romper(new Error("algo raro ha pasado"));
			expect(await aplicar("op-rara", ALTA, ["z1", "Sala"])).toMatchObject({
				ok: false,
				permanente: false,
				transitorio: false,
			});
		});
	});
});
