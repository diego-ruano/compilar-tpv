// test/confirmacionIncierta.test.ts
//
// AUD-18 · Una escritura cuyo resultado no se conoce se resuelve antes de dejar pasar nada posterior.
//
// Si Turso confirma el batch pero la respuesta no vuelve (el transporte se corta después de enviarlo,
// vence el plazo de `fetchConPlazo`, la respuesta no se deja leer), el cambio tiene su `Seq` y nadie
// lo ha difundido. Lo siguiente que se difundiera llevaría a la Main por encima de él para siempre.
// Por eso el DO anota cada escritura antes de mandarla y, si no sabe cómo acabó, la repite por su
// `Op_Id`: si ya estaba, choca y se difunde la suya; si no, se confirma ahora; si la base la rechaza,
// se veta su `Op_Id` para que ninguna copia entre después. Mientras no lo sabe —pase el tiempo que
// pase— no confirma ni difunde nada posterior, y desconecta las Main para que se pongan al día.
//
// Los fallos se provocan DESPUÉS de ejecutar el batch contra el SQLite del DO cuando lo que se prueba
// es un cambio confirmado de verdad, y ANTES cuando se prueba uno que no llegó (y que puede seguir en
// vuelo: `enviados` guarda cada batch para confirmarlo tarde).

import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client/web";

import { createDbClient, fetchConPlazo } from "../src/server/db/clients";
import {
	anotarEscritura,
	esperaDeReenvio,
	loteDe,
	ultimoEnvioSinRespuesta,
	VIDA_MAXIMA_DE_UN_ENVIO_MS,
} from "../src/durableObjects/tenantHub.turno";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

const TENANT = "tenant-1";
const INSERTAR_ZONA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escritura(opId: string, idZona: string) {
	return {
		tenantId: TENANT,
		cmd: { type: "tenantDb.exec", payload: { sql: INSERTAR_ZONA, args: [idZona, idZona] } },
		opId,
		commandName: "crear_zona",
		deviceId: "device-handy",
		requestPayloadJson: JSON.stringify({ opId }),
		cloudPayloadJson: JSON.stringify({ opId }),
		clientNow: "2026-11-09 12:00:00",
	};
}

function opDeLaCola(opId: string, idZona: string, conLecturaIlegible = false) {
	const steps: any[] = [{ kind: "execute", sql: INSERTAR_ZONA, args: [idZona, idZona] }];
	if (conLecturaIlegible) steps.push({ kind: "row", sql: "SELECT 'ilegible' AS x;", saveAs: "fila" });
	return {
		opId,
		commandName: "crear_zona",
		cmd: {
			type: "tenantDb.transaction",
			payload: { steps, ...(conLecturaIlegible ? { resultKey: "fila" } : {}) },
		},
		deviceId: "device-main",
		requestPayloadJson: JSON.stringify({ opId }),
		cloudPayloadJson: JSON.stringify({ opId }),
		clientNow: "2026-11-09 12:00:00",
	};
}

/** Un dispositivo conectado de verdad al DO (hibernación incluida), visto desde su lado. */
function conectar(hub: any, deviceId: string, role: "tpv" | "handy") {
	const par = new WebSocketPair();
	const [cliente, servidor] = [par[0], par[1]];
	hub.state.acceptWebSocket(servidor, [deviceId]);
	servidor.serializeAttachment({
		tenantId: TENANT,
		deviceId,
		role,
		authed: true,
		pubkeyB64: null,
		challenge: null,
	});
	cliente.accept();
	const recibidos: any[] = [];
	const estado = { cierre: null as number | null };
	cliente.addEventListener("message", (ev: MessageEvent) => {
		recibidos.push(JSON.parse(String(ev.data)));
	});
	cliente.addEventListener("close", (ev: CloseEvent) => {
		estado.cierre = ev.code;
	});
	return {
		cambios: () => recibidos.filter((m) => m.type === "change").map((m) => [m.opId, m.seq]),
		cierre: () => estado.cierre,
	};
}

type Fallo = "antes" | "despues" | null;

/**
 * La base del tenant: el SQLite del DO. `fallo()` decide, para cada batch de escritura, si se lanza
 * un error ANTES de ejecutarlo (no llegó: no se confirma) o DESPUÉS (confirmado, sin respuesta).
 * Apunta las sentencias de cada batch, por si un test quiere confirmar tarde el que no llegó.
 */
function prepararHub(hub: any, fallo: () => { cuando: Fallo; error?: Error }) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	const base = clienteSobre(sql, hub.state.storage);
	const enviados: any[][] = [];
	const db = {
		...base,
		async batch(sentencias: any[], modo?: string) {
			if (modo !== "write") return base.batch(sentencias, modo);
			enviados.push(sentencias);
			const f = fallo();
			if (f.cuando === "antes") throw f.error;
			const r = await base.batch(sentencias, modo);
			if (f.cuando === "despues") throw f.error;
			return r;
		},
	};
	hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
	hub.getTenantDb = async () => db;
	hub.resolveTenantDbClient = async () => db;
	hub.touchLastSeen = async () => {};
	hub.maybePurgeSyncLog = async () => {};
	return { sql, db, base, enviados };
}

/** Los fallos que se van a dar, en orden; agotados, todo va bien. */
function guion(...pasos: { cuando: Fallo; error?: Error }[]) {
	return () => pasos.shift() ?? { cuando: null };
}

const corte = () => new Error("fetch failed");
const plazo = () => new Error("Turso no ha respondido en 15000 ms (timeout)");
const ilegible = () => Object.assign(new Error("Unexpected end of JSON input"), { code: "HRANA_PROTO_ERROR" });

const seqDelLog = (sql: any, opId: string) =>
	sql.exec("SELECT Seq FROM Sync_Changes WHERE Op_Id = ?;", opId).toArray().map((f: any) => Number(f.Seq));
const anotadas = (sql: any) =>
	Number(sql.exec("SELECT COUNT(*) AS n FROM _Escritura_En_Curso;").toArray()[0].n);

describe("AUD-18 · una confirmación incierta se resuelve antes de dejar pasar nada", () => {
	for (const [caso, error] of [
		["se corta el transporte con el batch ya ejecutado", corte],
		["vence el plazo con el batch ya ejecutado", plazo],
		["la respuesta no se deja leer con el batch ya ejecutado", ilegible],
	] as const) {
		it(`${caso}: se repite por su Op_Id, choca y se difunde la suya, sin un segundo Seq`, async () => {
			await enElHub(`aud18-despues-${caso.length}`, async (hub: any) => {
				const { sql } = prepararHub(hub, guion({ cuando: "despues", error: error() }));
				const main = conectar(hub, "device-main", "tpv");

				const r = await hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"));
				await esperar(20);

				expect(seqDelLog(sql, "op-1")).toEqual([r.seq]);
				expect(main.cambios()).toEqual([["op-1", r.seq]]);
				expect(main.cierre()).toBeNull();
				expect(anotadas(sql)).toBe(0);

				const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
				await esperar(20);
				expect(main.cambios()).toEqual([
					["op-1", r.seq],
					["op-2", r2.seq],
				]);
			});
		});
	}

	it("lo devuelto se confirma pero no se deja leer: se resuelve igual, releyendo por su Op_Id", async () => {
		await enElHub("aud18-resultado-ilegible", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const base = clienteSobre(sql, hub.state.storage);
			// El `Seq` del log no se deja leer en la primera respuesta.
			let primera = true;
			const db = {
				...base,
				async batch(sentencias: any[], modo?: string) {
					const r = await base.batch(sentencias, modo);
					if (modo === "write" && primera) {
						primera = false;
						r[r.length - 1] = { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: undefined };
					}
					return r;
				},
			};
			hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
			hub.touchLastSeen = async () => {};
			hub.maybePurgeSyncLog = async () => {};
			const main = conectar(hub, "device-main", "tpv");

			const r = await hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"));
			await esperar(20);

			expect(seqDelLog(sql, "op-1")).toEqual([r.seq]);
			expect(main.cambios()).toEqual([["op-1", r.seq]]);
			expect(anotadas(sql)).toBe(0);
		});
	});

	it("si Turso no responde, queda anotada y se desconecta la Main; al volver, la siguiente la confirma primero", async () => {
		await enElHub("aud18-sin-respuesta", async (hub: any) => {
			const { sql } = prepararHub(
				hub,
				guion(
					{ cuando: "antes", error: corte() }, // op-1
					{ cuando: "antes", error: corte() }, // op-1, repetida en el acto
				),
			);
			const main = conectar(hub, "device-main", "tpv");
			const handy = conectar(hub, "device-otra-handy", "handy");

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"escritura_en_duda",
			);
			await esperar(20);
			expect(main.cierre()).toBe(4004);
			expect(handy.cierre()).toBeNull();
			expect(anotadas(sql)).toBe(1);
			expect(seqDelLog(sql, "op-1")).toEqual([]);

			// Turso vuelve y pasa la espera del reenvío: la escritura siguiente resuelve op-1 primero (no
			// había entrado: se confirma ahora) y después entra ella. Todo en orden de Seq.
			sql.exec("UPDATE _Escritura_En_Curso SET Ultimo_Envio_Ms = Ultimo_Envio_Ms - 1000;");
			const nueva = conectar(hub, "device-main", "tpv");
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await esperar(20);
			const [s1] = seqDelLog(sql, "op-1");
			expect(s1).toBeLessThan(r2.seq);
			expect(nueva.cambios()).toEqual([
				["op-1", s1],
				["op-2", r2.seq],
			]);
			expect(handy.cambios()).toEqual([
				["op-1", s1],
				["op-2", r2.seq],
			]);
			expect(main.cambios()).toEqual([]);
			expect(anotadas(sql)).toBe(0);
		});
	});

	it("la confirmación tardía tras la reconexión no deja que lo siguiente le pase por delante", async () => {
		// Codex (segunda revisión, 2): vence el plazo, la Main reconecta y hace su catch-up antes de
		// que el batch original se confirme; después Turso lo confirma. Lo siguiente que se escriba
		// tiene que difundir antes ese cambio tardío.
		await enElHub("aud18-tardia", async (hub: any) => {
			const { sql, base, enviados } = prepararHub(
				hub,
				guion({ cuando: "antes", error: plazo() }, { cuando: "antes", error: plazo() }),
			);
			const main = conectar(hub, "device-main", "tpv");

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"escritura_en_duda",
			);
			await esperar(20);
			expect(main.cierre()).toBe(4004);

			// La Main reconecta y se pone al día: op-1 todavía no está en el log.
			const nueva = conectar(hub, "device-main", "tpv");
			expect(seqDelLog(sql, "op-1")).toEqual([]);

			// Turso confirma ahora el batch original, que seguía en vuelo.
			await base.batch(enviados[0], "write");
			const [tardio] = seqDelLog(sql, "op-1");

			// Pasada la espera del reenvío, lo siguiente que se escribe la resuelve primero.
			sql.exec("UPDATE _Escritura_En_Curso SET Ultimo_Envio_Ms = Ultimo_Envio_Ms - 1000;");
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await esperar(20);
			expect(tardio).toBeLessThan(r2.seq);
			expect(nueva.cambios()).toEqual([
				["op-1", tardio],
				["op-2", r2.seq],
			]);
			expect(seqDelLog(sql, "op-1")).toEqual([tardio]);
		});
	});

	it("si el DO se apaga con la escritura en vuelo, el turno siguiente la resuelve primero", async () => {
		await enElHub("aud18-apagado", async (hub: any) => {
			const { sql, base } = prepararHub(hub, guion());
			const main = conectar(hub, "device-main", "tpv");

			// Lo que deja un DO que se apagó después de anotar y mandar op-1, y antes de difundirlo.
			const e = {
				opId: "op-1",
				commandName: "crear_zona",
				cmd: { type: "tenantDb.exec", payload: { sql: INSERTAR_ZONA, args: ["z-1", "z-1"] } },
				deviceId: "device-handy",
				requestHash: "x",
				cloudPayloadJson: "{}",
			};
			anotarEscritura(hub.ctxTurno(), TENANT, e as any);
			await base.batch(loteDe(e as any, 1).stmts, "write");

			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await esperar(20);
			const [s1] = seqDelLog(sql, "op-1");
			expect(main.cambios()).toEqual([
				["op-1", s1],
				["op-2", r2.seq],
			]);
			expect(seqDelLog(sql, "op-1")).toEqual([s1]);
			expect(anotadas(sql)).toBe(0);
		});
	});

	it("un rechazo de la propia base no deja nada anotado ni desconecta a la Main", async () => {
		await enElHub("aud18-rechazo", async (hub: any) => {
			const { sql } = prepararHub(
				hub,
				guion({ cuando: "antes", error: new Error("UNIQUE constraint failed: Zonas.Nombre_Zona: SQLITE_CONSTRAINT") }),
			);
			const main = conectar(hub, "device-main", "tpv");

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow("UNIQUE");
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await esperar(20);
			expect(main.cierre()).toBeNull();
			expect(main.cambios()).toEqual([["op-2", r2.seq]]);
			expect(anotadas(sql)).toBe(0);
		});
	});

	it("sin respuesta, ni el tiempo ni los reenvíos la resuelven; la original que entra tarde se difunde antes que lo siguiente", async () => {
		// Codex (tercera revisión, 1): dar por no confirmada una escritura porque, pasado un minuto, no
		// está en la base, no vale. Abortar la petición no impide que Turso la confirme después: la
		// nota se borraba, op-2 entraba y se difundía, y la original confirmada tarde quedaba con un
		// Seq que nadie difundía (log [1, 2], difusión [2]). Sólo una respuesta a su Op_Id la resuelve.
		await enElHub("aud18-sin-salida-por-tiempo", async (hub: any) => {
			// Hay una Main conectada: si no, ni se llega al turno (`main_offline`).
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			const turso = { responde: false };
			const { sql, base, enviados } = prepararHub(hub, () =>
				turso.responde ? { cuando: null } : { cuando: "antes", error: plazo() },
			);

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"escritura_en_duda",
			);
			// Pasan horas y se reenvía una y otra vez: nada la da por no confirmada.
			for (let i = 0; i < 6; i++) {
				sql.exec("UPDATE _Escritura_En_Curso SET Ultimo_Envio_Ms = Ultimo_Envio_Ms - 3600000;");
				await expect(hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"))).rejects.toThrow(
					"escritura_en_duda",
				);
			}
			expect(anotadas(sql)).toBe(1);
			expect(Number(sql.exec("SELECT Envios FROM _Escritura_En_Curso;").toArray()[0].Envios)).toBe(8);
			// Y nada posterior ha salido hacia Turso.
			expect(enviados.some((s) => JSON.stringify(s).includes("op-2"))).toBe(false);

			// Turso confirma ahora la original, que seguía en vuelo, y vuelve a contestar.
			await base.batch(enviados[0], "write");
			const [tardio] = seqDelLog(sql, "op-1");
			turso.responde = true;
			const main = conectar(hub, "device-main", "tpv");

			// El reenvío choca con su Op_Id y la difunde antes que op-2: sin hueco y con un solo Seq.
			sql.exec("UPDATE _Escritura_En_Curso SET Ultimo_Envio_Ms = Ultimo_Envio_Ms - 3600000;");
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await esperar(20);
			expect(seqDelLog(sql, "op-1")).toEqual([tardio]);
			expect(tardio).toBeLessThan(r2.seq);
			expect(main.cambios()).toEqual([
				["op-1", tardio],
				["op-2", r2.seq],
			]);
			expect(anotadas(sql)).toBe(0);
		});
	});

	it("se reenvía con esperas que crecen; mientras se espera no se manda nada ni se desconecta a nadie", async () => {
		expect([1, 2, 3, 4, 5, 8, 50].map(esperaDeReenvio)).toEqual([0, 1000, 2000, 4000, 8000, 60000, 60000]);
		await enElHub("aud18-esperas", async (hub: any) => {
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			const { sql, enviados } = prepararHub(hub, () => ({ cuando: "antes", error: corte() }));
			const atrasar = (ms: number) =>
				sql.exec("UPDATE _Escritura_En_Curso SET Ultimo_Envio_Ms = ?;", Date.now() - ms);
			const intentar = () =>
				expect(hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"))).rejects.toThrow(
					"escritura_en_duda",
				);

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"escritura_en_duda",
			);
			expect(enviados).toHaveLength(2); // la original y su reenvío en el acto
			const main = conectar(hub, "device-main", "tpv");

			// Con dos envíos, el siguiente espera un segundo.
			atrasar(500);
			await intentar();
			expect(enviados).toHaveLength(2);
			await esperar(20);
			expect(main.cierre()).toBeNull();
			atrasar(1500);
			await intentar();
			expect(enviados).toHaveLength(3);
			await esperar(20);
			expect(main.cierre()).toBe(4004); // se mandó y no se sabe: la Main, a ponerse al día

			// Con tres, dos segundos.
			atrasar(1500);
			await intentar();
			expect(enviados).toHaveLength(3);
			atrasar(2500);
			await intentar();
			expect(enviados).toHaveLength(4);
		});
	});

	it("un reenvío que la base rechaza veta la operación: la original, si llega tarde, ya no entra", async () => {
		// Que la base rechace el reenvío no dice que la original no vaya a entrar: podría seguir en
		// vuelo y llegar cuando otra escritura haya cambiado lo que la hacía fallar. El veto deja su
		// Op_Id ocupado, y esa copia choca con él.
		await enElHub("aud18-veto", async (hub: any) => {
			const fk = () =>
				Object.assign(new Error("SQLITE_CONSTRAINT: FOREIGN KEY constraint failed"), {
					code: "SQLITE_CONSTRAINT_FOREIGNKEY",
				});
			const { sql, base, enviados } = prepararHub(
				hub,
				guion({ cuando: "antes", error: plazo() }, { cuando: "antes", error: fk() }),
			);
			const main = conectar(hub, "device-main", "tpv");

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"FOREIGN KEY",
			);
			expect(anotadas(sql)).toBe(0);
			expect(
				sql.exec("SELECT Status FROM Applied_Operations WHERE Op_Id = 'op-1';").toArray().map((f: any) => f.Status),
			).toEqual(["FAILED"]);

			// La original llega tarde a Turso: choca con el veto y no se confirma.
			await expect(base.batch(enviados[0], "write")).rejects.toThrow(/UNIQUE/i);
			expect(seqDelLog(sql, "op-1")).toEqual([]);

			// Lo siguiente entra, y el reintento de op-1 acaba con el mismo rechazo que la vetó.
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"FOREIGN KEY",
			);
			await esperar(20);
			expect(main.cierre()).toBeNull();
			expect(main.cambios()).toEqual([["op-2", r2.seq]]);
			expect(seqDelLog(sql, "op-1")).toEqual([]);
		});
	});

	it("el reintento de una operación ya aplicada no contesta Seq 0 si su log no se deja leer", async () => {
		// AUD-18 (tercera revisión ter, 1): con un `apply_ack` sin `Seq` la Main no asciende el
		// anti-eco y lo saca del outbox; la purga TTL podía retirarlo antes de que volviera su eco, y
		// entonces se aplicaba otra vez. Un error de lectura no es un «no está».
		await enElHub("aud18-reintento-sin-seq", async (hub: any) => {
			const { db } = prepararHub(hub, guion());
			conectar(hub, "device-main", "tpv");
			const r1 = await hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"));

			const log = { legible: false };
			const conElLogIlegible = {
				...db,
				async execute(entrada: any) {
					if (!log.legible && /FROM Sync_Changes WHERE Op_Id/.test(String(entrada?.sql ?? ""))) {
						throw corte();
					}
					return db.execute(entrada);
				},
			};
			hub.withTenantDbRetry = async (_t: string, run: any) => run(conElLogIlegible);

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"fetch failed",
			);
			log.legible = true;
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"));
			expect(r2.seq).toBe(r1.seq);
		});
	});

	it("un reenvío rechazado por credenciales no cuenta como envío", async () => {
		await enElHub("aud18-credenciales", async (hub: any) => {
			const { sql, enviados } = prepararHub(
				hub,
				guion(
					{ cuando: "antes", error: plazo() },
					{ cuando: "antes", error: new Error("Server returned HTTP status 401") },
				),
			);
			conectar(hub, "device-main", "tpv");

			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow("401");
			expect(Number(sql.exec("SELECT Envios FROM _Escritura_En_Curso;").toArray()[0].Envios)).toBe(1);

			// Con credenciales que valen se reenvía en el acto, entra, y lo siguiente detrás.
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			expect(enviados).toHaveLength(4);
			expect(seqDelLog(sql, "op-1")[0]).toBeLessThan(r2.seq);
			expect(anotadas(sql)).toBe(0);
		});
	});
});

describe("AUD-18 · el lote de la cola", () => {
	it("con el resultado ilegible tras confirmar, todo lo confirmado se difunde", async () => {
		// Codex (primera revisión, 6): `resolveResult` lanzaba con todo ya confirmado; al reintentar,
		// el filtro las veía «ya aplicadas» y no las difundía nunca.
		await enElHub("aud18-cola-ilegible", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const base = clienteSobre(sql, hub.state.storage);
			const db = {
				...base,
				async batch(sentencias: any[], modo?: string) {
					const r = await base.batch(sentencias, modo);
					return r.map((res: any, i: number) =>
						/^SELECT 'ilegible'/.test(String(sentencias[i]?.sql ?? ""))
							? {
									get rows() {
										throw new Error("resultado_ilegible");
									},
								}
							: res,
					);
				},
			};
			const difundidos: any[] = [];
			hub.broadcastAuthed = (obj: any) => {
				if (obj?.type === "change") difundidos.push(obj);
			};

			const r = await hub.applyBatchIdempotent(db, [
				opDeLaCola("op-1", "z-1", true),
				opDeLaCola("op-2", "z-2"),
			]);

			expect(r.aplicadas).toEqual(["op-1", "op-2"]);
			expect(difundidos.map((m) => [m.opId, m.seq])).toEqual([
				["op-1", seqDelLog(sql, "op-1")[0]],
				["op-2", seqDelLog(sql, "op-2")[0]],
			]);
			expect(difundidos[0].result).toBeNull();
		});
	});

	it("confirmado y sin respuesta: se desconecta la Main y el drenado siguiente lo difunde, en orden", async () => {
		await enElHub("aud18-cola-sin-respuesta", async (hub: any) => {
			const { sql } = prepararHub(hub, guion({ cuando: "despues", error: corte() }));
			const difundidos: any[] = [];
			const original = hub.broadcastAuthed.bind(hub);
			hub.broadcastAuthed = (obj: any, except?: string) => {
				if (obj?.type === "change") difundidos.push(obj);
				return original(obj, except);
			};
			const main = conectar(hub, "device-main", "tpv");

			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1"), opDeLaCola("op-2", "z-2")]);
			// El drenado se lanza a mano: la alarma de la cola no se mete por medio.
			await hub.state.storage.deleteAlarm();
			await hub.drenarCola();
			await esperar(20);

			expect(main.cierre()).toBe(4004);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n).toBe(0);
			expect(difundidos.map((m) => [m.opId, m.seq])).toEqual([
				["op-1", seqDelLog(sql, "op-1")[0]],
				["op-2", seqDelLog(sql, "op-2")[0]],
			]);
			expect(seqDelLog(sql, "op-1")).toHaveLength(1);
		});
	});

	it("con una escritura en duda la cola espera sin culpar a sus operaciones", async () => {
		await enElHub("aud18-cola-espera", async (hub: any) => {
			const { sql } = prepararHub(
				hub,
				guion(
					{ cuando: "antes", error: corte() },
					{ cuando: "antes", error: corte() },
					{ cuando: "antes", error: corte() },
				),
			);
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"escritura_en_duda",
			);

			hub.encolar(TENANT, [opDeLaCola("op-cola", "z-cola")]);
			await hub.state.storage.deleteAlarm();
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();

			const fila = sql.exec("SELECT Intentos FROM _Cola_Entrada WHERE Op_Id = 'op-cola';").toArray()[0];
			expect(Number(fila.Intentos)).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Muerta;").toArray()[0].n).toBe(0);
			expect(seqDelLog(sql, "op-cola")).toEqual([]);
		});
	});

	it("confirmado con un Seq que no se deja leer: no se difunde ni sale nada, y el drenado siguiente lo difunde en orden", async () => {
		// Codex (tercera revisión, 2): `lookupChange` convertía el error en Seq 0; op-1 se daba por
		// aplicada sin difundirla, se difundía op-2 y salían las dos de la cola. Una Main que recibiera
		// op-2 dejaba atrás a op-1 para siempre.
		await enElHub("aud18-cola-seq-ilegible", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const base = clienteSobre(sql, hub.state.storage);
			const fallos = { activos: true };
			const db = {
				...base,
				async execute(entrada: any) {
					if (fallos.activos && /FROM Sync_Changes/.test(String(entrada?.sql ?? ""))) throw corte();
					return base.execute(entrada);
				},
				async batch(sentencias: any[], modo?: string) {
					const r = await base.batch(sentencias, modo);
					if (modo === "write" && fallos.activos) {
						// El `Seq` de op-1 no viene en la respuesta.
						const i = sentencias.findIndex(
							(s: any) => /INSERT INTO Sync_Changes/.test(s.sql) && s.args?.[0] === "op-1",
						);
						if (i >= 0) r[i] = { ...r[i], lastInsertRowid: undefined };
					}
					return r;
				},
			};
			hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
			hub.getTenantDb = async () => db;
			hub.resolveTenantDbClient = async () => db;
			hub.touchLastSeen = async () => {};
			hub.maybePurgeSyncLog = async () => {};
			const difundidos: any[] = [];
			const original = hub.broadcastAuthed.bind(hub);
			hub.broadcastAuthed = (obj: any, except?: string) => {
				if (obj?.type === "change") difundidos.push(obj);
				return original(obj, except);
			};
			const main = conectar(hub, "device-main", "tpv");

			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1"), opDeLaCola("op-2", "z-2")]);
			await hub.state.storage.deleteAlarm();
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();
			await esperar(20);

			// Las dos están confirmadas, pero no se difunde ninguna ni sale ninguna de la cola, y no se
			// le gasta un intento a nadie.
			expect(seqDelLog(sql, "op-1")).toHaveLength(1);
			expect(seqDelLog(sql, "op-2")).toHaveLength(1);
			expect(difundidos).toEqual([]);
			expect(main.cierre()).toBe(4004);
			expect(
				sql
					.exec("SELECT Op_Id, Intentos FROM _Cola_Entrada ORDER BY Seq;")
					.toArray()
					.map((f: any) => [f.Op_Id, Number(f.Intentos)]),
			).toEqual([
				["op-1", 0],
				["op-2", 0],
			]);

			// El log vuelve a dejarse leer: el drenado siguiente las difunde en orden y vacía la cola.
			fallos.activos = false;
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();
			expect(difundidos.map((m) => [m.opId, m.seq])).toEqual([
				["op-1", seqDelLog(sql, "op-1")[0]],
				["op-2", seqDelLog(sql, "op-2")[0]],
			]);
			expect(seqDelLog(sql, "op-1")).toHaveLength(1);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n).toBe(0);
		});
	});

	const raro = () => new Error("respuesta inesperada del servidor");

	it("antes de apartar una operación se veta: una copia suya que siguiera en vuelo ya no entra", async () => {
		await enElHub("aud18-cola-veto", async (hub: any) => {
			const { sql, base, enviados } = prepararHub(
				hub,
				guion({ cuando: "antes", error: raro() }, { cuando: "antes", error: raro() }),
			);
			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1")]);
			await hub.state.storage.deleteAlarm();
			sql.exec("UPDATE _Cola_Entrada SET Intentos = 4 WHERE Op_Id = 'op-1';");

			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();

			expect(sql.exec("SELECT Op_Id FROM _Cola_Muerta;").toArray().map((f: any) => f.Op_Id)).toEqual(["op-1"]);
			expect(
				sql.exec("SELECT Status FROM Applied_Operations WHERE Op_Id = 'op-1';").toArray().map((f: any) => f.Status),
			).toEqual(["FAILED"]);
			// Las copias de las que no se supo nada llegan tarde a Turso: chocan con el veto.
			expect(enviados).toHaveLength(2);
			for (const copia of enviados) await expect(base.batch(copia, "write")).rejects.toThrow(/UNIQUE/i);
			expect(seqDelLog(sql, "op-1")).toEqual([]);
		});
	});

	it("si al vetarla resulta que estaba aplicada, se difunde y sale de la cola como aplicada", async () => {
		await enElHub("aud18-cola-veto-aplicada", async (hub: any) => {
			// El lote entero no llega; op-1 sola sí se confirma, pero su respuesta se pierde.
			const { sql } = prepararHub(
				hub,
				guion({ cuando: "antes", error: raro() }, { cuando: "despues", error: raro() }),
			);
			const difundidos: any[] = [];
			const original = hub.broadcastAuthed.bind(hub);
			hub.broadcastAuthed = (obj: any, except?: string) => {
				if (obj?.type === "change") difundidos.push(obj);
				return original(obj, except);
			};
			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1"), opDeLaCola("op-2", "z-2")]);
			await hub.state.storage.deleteAlarm();
			sql.exec("UPDATE _Cola_Entrada SET Intentos = 4 WHERE Op_Id = 'op-1';");

			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();

			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Muerta;").toArray()[0].n).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n).toBe(0);
			expect(seqDelLog(sql, "op-1")).toHaveLength(1);
			expect(difundidos.map((m) => [m.opId, m.seq])).toEqual([
				["op-1", seqDelLog(sql, "op-1")[0]],
				["op-2", seqDelLog(sql, "op-2")[0]],
			]);
		});
	});

	it("si no se sabe cómo acabó el veto, se queda en la cola sin gastar el intento", async () => {
		await enElHub("aud18-cola-veto-en-duda", async (hub: any) => {
			const { sql, db } = prepararHub(
				hub,
				guion({ cuando: "antes", error: raro() }, { cuando: "antes", error: raro() }),
			);
			const conElVetoSinRespuesta = {
				...db,
				async execute(entrada: any) {
					if (/'FAILED'/.test(String(entrada?.sql ?? ""))) throw corte();
					return db.execute(entrada);
				},
			};
			hub.withTenantDbRetry = async (_t: string, run: any) => run(conElVetoSinRespuesta);
			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1")]);
			await hub.state.storage.deleteAlarm();
			sql.exec("UPDATE _Cola_Entrada SET Intentos = 4 WHERE Op_Id = 'op-1';");

			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();

			expect(
				sql
					.exec("SELECT Op_Id, Intentos FROM _Cola_Entrada;")
					.toArray()
					.map((f: any) => [f.Op_Id, Number(f.Intentos)]),
			).toEqual([["op-1", 4]]);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Muerta;").toArray()[0].n).toBe(0);
		});
	});

	it("lo ya confirmado cuyo Seq no se deja leer del log no sale de la cola sin difundirse", async () => {
		await enElHub("aud18-cola-ya-confirmadas-ilegibles", async (hub: any) => {
			// El lote se confirma y su respuesta se pierde.
			const { sql, db } = prepararHub(hub, guion({ cuando: "despues", error: corte() }));
			const log = { legible: false };
			const conElLogIlegible = {
				...db,
				async execute(entrada: any) {
					if (!log.legible && /FROM Sync_Changes/.test(String(entrada?.sql ?? ""))) throw corte();
					return db.execute(entrada);
				},
			};
			hub.withTenantDbRetry = async (_t: string, run: any) => run(conElLogIlegible);
			const difundidos: any[] = [];
			const original = hub.broadcastAuthed.bind(hub);
			hub.broadcastAuthed = (obj: any, except?: string) => {
				if (obj?.type === "change") difundidos.push(obj);
				return original(obj, except);
			};

			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1"), opDeLaCola("op-2", "z-2")]);
			await hub.state.storage.deleteAlarm();
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();

			// Aplicadas las dos, y ninguna difundida: siguen en la cola, sin gastar intentos.
			expect(seqDelLog(sql, "op-1")).toHaveLength(1);
			expect(difundidos).toEqual([]);
			expect(
				sql
					.exec("SELECT Op_Id, Intentos FROM _Cola_Entrada ORDER BY Seq;")
					.toArray()
					.map((f: any) => [f.Op_Id, Number(f.Intentos)]),
			).toEqual([
				["op-1", 0],
				["op-2", 0],
			]);

			log.legible = true;
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();
			expect(difundidos.map((m) => [m.opId, m.seq])).toEqual([
				["op-1", seqDelLog(sql, "op-1")[0]],
				["op-2", seqDelLog(sql, "op-2")[0]],
			]);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n).toBe(0);
		});
	});

	it("una operación vetada que llega por la cola se aparta con su rechazo; no se da por aplicada", async () => {
		await enElHub("aud18-cola-vetada", async (hub: any) => {
			const { sql } = prepararHub(hub, guion());
			// La vetó el camino de una en una: su reenvío lo rechazó la base.
			sql.exec(
				`INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status, Result_Json,
				   Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms)
				 VALUES ('op-1', 'crear_zona', 'x', 'device-main', 'FAILED', NULL,
				   'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed', 1, NULL, 1);`,
			);
			const difundidos: any[] = [];
			const original = hub.broadcastAuthed.bind(hub);
			hub.broadcastAuthed = (obj: any, except?: string) => {
				if (obj?.type === "change") difundidos.push(obj);
				return original(obj, except);
			};

			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1"), opDeLaCola("op-2", "z-2")]);
			await hub.state.storage.deleteAlarm();
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();

			const muerta = sql.exec("SELECT Op_Id, Error FROM _Cola_Muerta;").toArray();
			expect(muerta.map((f: any) => f.Op_Id)).toEqual(["op-1"]);
			expect(String(muerta[0].Error)).toContain("FOREIGN KEY");
			expect(seqDelLog(sql, "op-1")).toEqual([]);
			expect(difundidos.map((m) => m.opId)).toEqual(["op-2"]);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n).toBe(0);
		});
	});
});

describe("AUD-18 · lo que cierra el paso a una copia tardía dura más que ella", () => {
	const DIA = 24 * 60 * 60 * 1000;
	const SUMAR = "UPDATE Zonas SET Nombre_Zona = Nombre_Zona || '+' WHERE ID_Zona = 'z-contador';";
	const sumar = (opId: string) => ({
		...escritura(opId, "z-contador"),
		commandName: "sumar",
		cmd: { type: "tenantDb.exec", payload: { sql: SUMAR, args: [] } },
	});
	const contador = (sql: any) =>
		String(sql.exec("SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z-contador';").toArray()[0].Nombre_Zona);
	const gates = (sql: any, opId: string) =>
		sql.exec("SELECT Status FROM Applied_Operations WHERE Op_Id = ?;", opId).toArray().map((f: any) => f.Status);
	const envejecer = (sql: any, opId: string) =>
		sql.exec("UPDATE Applied_Operations SET Created_At_Ms = Created_At_Ms - ? WHERE Op_Id = ?;", 8 * DIA, opId);
	/** El último envío sin respuesta salió hace `ms`. */
	const envioSinRespuestaHace = (hub: any, ms: number) => {
		ultimoEnvioSinRespuesta(hub.state.storage);
		hub.state.storage.sql.exec(
			`INSERT INTO _Envio_Sin_Respuesta (Id, Ultimo_Ms) VALUES (1, ?)
			 ON CONFLICT(Id) DO UPDATE SET Ultimo_Ms = excluded.Ultimo_Ms;`,
			Date.now() - ms,
		);
	};
	/** La purga de verdad (`prepararHub` la deja muda para el resto), sin esperar a su hora. */
	const purgar = (hub: any) => {
		hub.lastPurgeAtMs = 0;
		return Object.getPrototypeOf(hub).maybePurgeSyncLog.call(hub, TENANT);
	};

	it("el supuesto es de un día, y la purga nunca retira una fila más joven que eso", () => {
		expect(VIDA_MAXIMA_DE_UN_ENVIO_MS).toBe(DIA);
	});

	it("con una escritura en duda no se purga su gate, y al resolverse no se aplica dos veces", async () => {
		// Codex (tercera revisión bis, 2): la purga de siete días retiraba el gate de una operación
		// confirmada cuya nota seguía pendiente, y el reenvío la volvía a aplicar: contador 2, log
		// [1, 2] para el mismo Op_Id y difusión [2].
		await enElHub("aud18-purga-nota", async (hub: any) => {
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			const { sql } = prepararHub(
				hub,
				guion({ cuando: "despues", error: plazo() }, { cuando: "antes", error: plazo() }),
			);
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-contador', 'base');");

			// Se confirma, la respuesta se pierde y el reenvío tampoco contesta.
			await expect(hub.applyInternalCommandIdempotent(sumar("op-1"))).rejects.toThrow(
				"escritura_en_duda",
			);
			expect(contador(sql)).toBe("base+");

			// Su gate es viejo y no hay envíos sin respuesta recientes: sólo la nota lo protege.
			envejecer(sql, "op-1");
			envioSinRespuestaHace(hub, 2 * DIA);
			await purgar(hub);
			expect(gates(sql, "op-1")).toEqual(["APPLIED"]);

			// Pasada la espera, lo siguiente la resuelve: choca con su Op_Id y no se aplica otra vez.
			sql.exec("UPDATE _Escritura_En_Curso SET Ultimo_Envio_Ms = Ultimo_Envio_Ms - 1000;");
			const main = conectar(hub, "device-main", "tpv");
			const r2 = await hub.applyInternalCommandIdempotent(escritura("op-2", "z-2"));
			await esperar(20);
			const [s1] = seqDelLog(sql, "op-1");
			expect(contador(sql)).toBe("base+");
			expect(seqDelLog(sql, "op-1")).toEqual([s1]);
			expect(main.cambios()).toEqual([
				["op-1", s1],
				["op-2", r2.seq],
			]);
		});
	});

	it("un veto no se purga mientras pueda llegar una copia de su operación", async () => {
		// Codex (tercera revisión bis, 2): purgado el veto, la original que seguía en vuelo entraba sin
		// que nadie la difundiera.
		await enElHub("aud18-purga-veto", async (hub: any) => {
			const fk = () =>
				Object.assign(new Error("SQLITE_CONSTRAINT: FOREIGN KEY constraint failed"), {
					code: "SQLITE_CONSTRAINT_FOREIGNKEY",
				});
			const { sql, base, enviados } = prepararHub(
				hub,
				guion({ cuando: "antes", error: plazo() }, { cuando: "antes", error: fk() }),
			);
			conectar(hub, "device-main", "tpv");
			await expect(hub.applyInternalCommandIdempotent(escritura("op-1", "z-1"))).rejects.toThrow(
				"FOREIGN KEY",
			);

			envejecer(sql, "op-1");
			await purgar(hub);
			expect(gates(sql, "op-1")).toEqual(["FAILED"]);
			// La original llega tarde: choca con el veto.
			await expect(base.batch(enviados[0], "write")).rejects.toThrow(/UNIQUE/i);
			expect(seqDelLog(sql, "op-1")).toEqual([]);

			// Pasado un día desde el último envío sin respuesta, ninguna copia puede llegar: se purga.
			envioSinRespuestaHace(hub, DIA + 60_000);
			await purgar(hub);
			expect(gates(sql, "op-1")).toEqual([]);
		});
	});

	it("con la cola sin vaciar no se purga, y un lote cuenta como envío sin respuesta", async () => {
		await enElHub("aud18-purga-cola", async (hub: any) => {
			const { sql } = prepararHub(hub, guion());
			const viejo = Date.now() - 8 * DIA;
			sql.exec(
				`INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status,
				   Result_Json, Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms)
				 VALUES ('op-vieja', 'crear_zona', 'x', NULL, 'APPLIED', NULL, NULL, ?, ?, ?);`,
				viejo,
				viejo,
				viejo,
			);
			envioSinRespuestaHace(hub, 2 * DIA);

			// Con algo en la cola, no.
			hub.encolar(TENANT, [opDeLaCola("op-1", "z-1")]);
			await hub.state.storage.deleteAlarm();
			await purgar(hub);
			expect(gates(sql, "op-vieja")).toEqual(["APPLIED"]);

			// Drenada, tampoco hasta un día después del lote: el DO pudo apagarse con él en vuelo.
			await hub.drenarCola();
			await hub.state.storage.deleteAlarm();
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n).toBe(0);
			await purgar(hub);
			expect(gates(sql, "op-vieja")).toEqual(["APPLIED"]);

			envioSinRespuestaHace(hub, DIA + 60_000);
			await purgar(hub);
			expect(gates(sql, "op-vieja")).toEqual([]);
			expect(gates(sql, "op-1")).toEqual(["APPLIED"]);
		});
	});

	it("resolver una escritura que el DO dejó en vuelo al apagarse cuenta como envío sin respuesta", async () => {
		await enElHub("aud18-purga-apagado", async (hub: any) => {
			const { sql, base } = prepararHub(hub, guion());
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-contador', 'base');");
			conectar(hub, "device-main", "tpv");
			// El DO anotó op-1, la mandó y se apagó: Turso la confirmó (hace mucho) y nadie lo supo.
			const e = {
				opId: "op-1",
				commandName: "sumar",
				cmd: { type: "tenantDb.exec", payload: { sql: SUMAR, args: [] } },
				deviceId: "device-handy",
				requestHash: "x",
				cloudPayloadJson: "{}",
			};
			anotarEscritura(hub.ctxTurno(), TENANT, e as any);
			await base.batch(loteDe(e as any, 1).stmts, "write");
			expect(ultimoEnvioSinRespuesta(hub.state.storage)).toBe(0);

			// La purga corre en el turno: antes se resuelve la nota, y eso la detiene un día.
			await purgar(hub);
			expect(anotadas(sql)).toBe(0);
			expect(gates(sql, "op-1")).toEqual(["APPLIED"]);
			expect(contador(sql)).toBe("base+");
		});
	});
});

describe("AUD-18 · el plazo de cada petición a Turso", () => {
	/** Un `fetch` que no vuelve nunca, salvo que lo aborten. */
	const colgado = (_p: Request, init?: RequestInit) =>
		new Promise<Response>((_, rechazar) =>
			init?.signal?.addEventListener("abort", () => rechazar(init.signal!.reason)),
		);

	it("una petición que no vuelve se corta al vencer el plazo, y sale como un fallo pasajero", async () => {
		const f = fetchConPlazo(30, colgado);
		const inicio = Date.now();
		await expect(f(new Request("https://tenant.turso.invalid/v2/pipeline", { method: "POST" }))).rejects.toThrow(
			"timeout",
		);
		expect(Date.now() - inicio).toBeLessThan(2_000);
	});

	it("el plazo cubre también un cuerpo que se cuelga después de las cabeceras", async () => {
		const cabecerasYNada = (_p: Request, init?: RequestInit) => {
			const cuerpo = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode('{"a":'));
					init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
				},
			});
			return Promise.resolve(new Response(cuerpo));
		};
		const f = fetchConPlazo(30, cabecerasYNada);
		const r = await f(new Request("https://tenant.turso.invalid/"));
		await expect(r.text()).rejects.toThrow("timeout");
	});

	it("lo que vuelve a tiempo pasa tal cual, y la señal de quien llama sigue valiendo", async () => {
		const f = fetchConPlazo(1_000, async () => new Response("ok"));
		expect(await (await f(new Request("https://tenant.turso.invalid/"))).text()).toBe("ok");

		const propia = new AbortController();
		const g = fetchConPlazo(60_000, colgado);
		const pendiente = g(new Request("https://tenant.turso.invalid/"), { signal: propia.signal });
		propia.abort(new Error("cancelada"));
		await expect(pendiente).rejects.toThrow("cancelada");
	});

	it("el cliente de libsql lo usa: una petición colgada sale como error, no se queda esperando", async () => {
		const db = createClient({
			url: "https://tenant.turso.invalid",
			authToken: "x",
			fetch: fetchConPlazo(30, colgado),
		});
		const inicio = Date.now();
		await expect(db.batch([{ sql: "SELECT 1;", args: [] }], "write")).rejects.toThrow();
		expect(Date.now() - inicio).toBeLessThan(2_000);
		db.close();
	});

	it("createDbClient lo pone cuando se le pide plazo", async () => {
		const fetchDeVerdad = globalThis.fetch;
		(globalThis as any).fetch = colgado;
		try {
			const db = createDbClient({ url: "https://tenant.turso.invalid", authToken: "x", plazoMs: 30 });
			const inicio = Date.now();
			await expect(db.batch([{ sql: "SELECT 1;", args: [] }], "write")).rejects.toThrow();
			expect(Date.now() - inicio).toBeLessThan(2_000);
			db.close();
		} finally {
			(globalThis as any).fetch = fetchDeVerdad;
		}
	});

	// prueba/sqlite-do: la base del negocio es la del propio DO; no hay petición de red que acotar.
});
