// test/loteDeLaMain.test.ts
//
// El lote de la Main (`apply_lote`): lo que sube de su outbox, hasta 200 operaciones de una vez.
//
// Se prueba por fuera, por el socket, contra el motor y la base de verdad: cada operación entra
// como una escritura suelta de la Main (su `Seq`, su línea en el log, su difusión), el acuse lleva
// el veredicto de cada una y un lote se puede volver a mandar entero sin duplicar nada. Y los sitios
// donde aplicar varias en un turno cambia las reglas: las claves foráneas aplazadas, que no pueden
// llegar rotas al confirmar (el runtime resetea el objeto), y el trabajo que cabe en un turno.

import { describe, expect, it } from "vitest";

import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";
import { montarMainEnElHub, opDelOutbox, type MainEnElHub } from "./helpers/mainEnElHub";

const TENANT = "tenant-lote";
const ALTA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

const zona = (n: number | string) => opDelOutbox(`op-${n}`, [{ sql: ALTA, args: [`z-${n}`, `Zona ${n}`] }]);
const rota = (n: number | string) =>
	opDelOutbox(`op-${n}`, [{ sql: "INSERT INTO Tabla_Que_No_Existe (a) VALUES (?1);", args: [n] }]);
/** La línea delante de su comanda: sólo entra aplazando las claves foráneas, como en la Main. */
const hijaAntesQueSuMadre = (n: number | string) =>
	opDelOutbox(`op-${n}`, [
		{
			sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES (?1, ?2, 1, 100);",
			args: [`d-${n}`, `c-${n}`],
		},
		{
			sql: "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES (?1, 'BARRA', '2026-11-11 10:00:00');",
			args: [`c-${n}`],
		},
	]);
/** Una línea de una comanda que no existe: una clave foránea rota de verdad. */
const huerfana = (n: number | string) =>
	opDelOutbox(`op-${n}`, [
		{
			sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES (?1, 'NO-EXISTE', 1, 100);",
			args: [`d-${n}`],
		},
	]);

const zonas = (sql: any): string[] =>
	sql.exec("SELECT ID_Zona FROM Zonas ORDER BY ID_Zona;").toArray().map((f: any) => String(f.ID_Zona));
const contar = (sql: any, tabla: string): number => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).one().n);
const ids = (xs: { opId: string }[]) => xs.map((x) => x.opId);

/** SHA-256 en hexadecimal, sin pasar por el código que se prueba. */
async function sha256Hex(texto: string): Promise<string> {
	const resumen = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
	return Array.from(new Uint8Array(resumen), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hace que el lote atómico de `opId` falle con `error` las primeras `veces`. */
function romper(hub: any, opId: string, error: unknown, veces = 1) {
	const real = hub.loteLocal.bind(hub);
	let quedan = veces;
	hub.loteLocal = (sentencias: any[], alAplazar: () => boolean) => {
		// La segunda sentencia de un lote es su gate, que lleva el `Op_Id`.
		if (sentencias[1]?.args?.[0] === opId && quedan-- > 0) throw error;
		return real(sentencias, alAplazar);
	};
}

async function enUnHub<T>(nombre: string, prueba: (m: MainEnElHub, hub: any) => Promise<T>): Promise<T> {
	return enElHub(nombre, async (hub: any) => prueba(await montarMainEnElHub(hub, TENANT), hub));
}

describe("apply_lote · un lote de la Main", () => {
	it("aplica cada operación en orden, con su Seq, su línea en el log y su difusión", async () => {
		await enUnHub("lote-orden", async (m) => {
			const acuse = await m.mandarLote([zona(1), zona(2), zona(3)]);

			expect(acuse.ok).toBe(true);
			expect(ids(acuse.resultados)).toEqual(["op-1", "op-2", "op-3"]);
			expect(acuse.resultados.every((r: any) => r.ok === true && !r.yaEstaba)).toBe(true);
			const seqs = acuse.resultados.map((r: any) => r.seq);
			expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
			expect(new Set(seqs).size).toBe(3);

			expect(zonas(m.sql)).toEqual(["z-1", "z-2", "z-3"]);
			expect(m.log()).toEqual(acuse.resultados.map((r: any) => ({ opId: r.opId, seq: r.seq })));
			expect(contar(m.sql, "Applied_Operations")).toBe(3);
			// AUD-18: lo difundido, en el orden del log. A quien lo mandó no le vuelve.
			expect(m.difundidos()).toEqual(m.log());
			expect(m.main.recibidos.some((x) => x.type === "change")).toBe(false);
		});
	});

	it("un lote reenviado no duplica nada: contesta con el Seq de entonces y lo difunde otra vez", async () => {
		await enUnHub("lote-reenvio", async (m) => {
			const primero = await m.mandarLote([zona(1), zona(2)]);
			// El acuse se perdió: la Main reenvía lo mismo, y algo más detrás.
			const segundo = await m.mandarLote([zona(1), zona(2), zona(3)]);

			expect(segundo.resultados.slice(0, 2)).toEqual(
				primero.resultados.map((r: any) => ({ opId: r.opId, ok: true, seq: r.seq, yaEstaba: true })),
			);
			expect(segundo.resultados[2]).toMatchObject({ opId: "op-3", ok: true });
			expect(segundo.resultados[2].yaEstaba).toBeUndefined();
			expect(zonas(m.sql)).toEqual(["z-1", "z-2", "z-3"]);
			expect(contar(m.sql, "Sync_Changes")).toBe(3);
			expect(contar(m.sql, "Applied_Operations")).toBe(3);
			// SYNC-03: lo ya confirmado se difunde otra vez, por si la primera difusión se perdió.
			expect(ids(m.difundidos())).toEqual(["op-1", "op-2", "op-1", "op-2", "op-3"]);
		});
	});

	it("el mismo Op_Id con otro contenido es un rechazo permanente, y el lote sigue", async () => {
		await enUnHub("lote-otro-contenido", async (m) => {
			await m.mandarLote([zona(1)]);
			const otra = opDelOutbox("op-1", [{ sql: ALTA, args: ["z-otra", "Otra"] }]);
			const acuse = await m.mandarLote([otra, zona(2)]);

			expect(acuse.resultados[0]).toMatchObject({ opId: "op-1", ok: false, permanente: true, transitorio: false });
			expect(acuse.resultados[0].error).toContain("idempotency_payload_mismatch");
			expect(acuse.resultados[1]).toMatchObject({ opId: "op-2", ok: true });
			expect(zonas(m.sql)).toEqual(["z-1", "z-2"]);
		});
	});

	it("un rechazo permanente se anota y lo de detrás entra", async () => {
		await enUnHub("lote-permanente", async (m) => {
			const acuse = await m.mandarLote([zona(1), rota(2), zona(3)]);

			expect(acuse.ok).toBe(true);
			expect(acuse.resultados[0]).toMatchObject({ opId: "op-1", ok: true });
			expect(acuse.resultados[1]).toMatchObject({ opId: "op-2", ok: false, permanente: true, transitorio: false });
			expect(acuse.resultados[2]).toMatchObject({ opId: "op-3", ok: true });
			expect(zonas(m.sql)).toEqual(["z-1", "z-3"]);
			expect(ids(m.log())).toEqual(["op-1", "op-3"]);
			// La rechazada no deja rastro: ni su gate ni su línea en el log.
			expect(contar(m.sql, "Applied_Operations")).toBe(2);
			expect(m.eventos.filter((e) => e.name === "apply_error").map((e) => e.op_id)).toEqual(["op-2"]);
		});
	});

	it("un fallo que no se sabe clasificar para el lote: lo de detrás no se toca", async () => {
		await enUnHub("lote-desconocido", async (m, hub) => {
			romper(hub, "op-2", new Error("algo que nadie ha visto nunca"));
			const acuse = await m.mandarLote([zona(1), zona(2), zona(3), zona(4)]);

			expect(acuse.resultados).toEqual([
				expect.objectContaining({ opId: "op-1", ok: true }),
				{ opId: "op-2", ok: false, error: "algo que nadie ha visto nunca", permanente: false, transitorio: false },
				{ opId: "op-3", ok: false, noIntentada: true },
				{ opId: "op-4", ok: false, noIntentada: true },
			]);
			expect(zonas(m.sql)).toEqual(["z-1"]);

			// La Main vuelve a mandar desde la que falló, y ahora entran.
			const otra = await m.mandarLote([zona(2), zona(3), zona(4)]);
			expect(otra.resultados.every((r: any) => r.ok)).toBe(true);
			expect(ids(m.log())).toEqual(["op-1", "op-2", "op-3", "op-4"]);
		});
	});

	it("un fallo pasajero de la base para el lote sin contarle nada a la operación", async () => {
		await enUnHub("lote-pasajero", async (m, hub) => {
			romper(hub, "op-1", new Error("database is locked: SQLITE_BUSY"));
			const acuse = await m.mandarLote([zona(1), zona(2)]);

			expect(acuse.resultados).toEqual([
				expect.objectContaining({ opId: "op-1", ok: false, permanente: false, transitorio: true }),
				{ opId: "op-2", ok: false, noIntentada: true },
			]);
			expect(zonas(m.sql)).toEqual([]);
		});
	});

	it("una base llena avisa una vez y no aparta nada", async () => {
		await enUnHub("lote-base-llena", async (m, hub) => {
			romper(hub, "op-1", new Error("database or disk is full: SQLITE_FULL"), 2);
			const uno = await m.mandarLote([zona(1)]);
			const dos = await m.mandarLote([zona(1)]);

			for (const acuse of [uno, dos]) {
				expect(acuse.resultados[0]).toMatchObject({ ok: false, permanente: false, transitorio: true });
			}
			expect(m.eventos.filter((e) => e.name === "base_llena")).toHaveLength(1);
		});
	});

	it("una operación sin la hora fijada es un rechazo permanente; con la del emisor, entra con ella", async () => {
		await enUnHub("lote-hora", async (m) => {
			const conAhora = (n: number) =>
				opDelOutbox(`op-${n}`, [
					{
						sql: "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES (?1, 'BARRA', datetime('now','localtime'));",
						args: [`c-${n}`],
					},
				]);
			const sinHora = await m.mandarLote([zona(1), conAhora(2), zona(3)]);
			expect(sinHora.resultados[1]).toMatchObject({ opId: "op-2", ok: false, permanente: true, transitorio: false });
			expect(sinHora.resultados[1].error).toContain("missing_client_now");
			expect(sinHora.resultados[2]).toMatchObject({ opId: "op-3", ok: true });

			const ahora = new Date().toISOString().slice(0, 19).replace("T", " ");
			const conHora = await m.mandarLote([conAhora(4)], { clientNow: ahora });
			expect(conHora.resultados[0]).toMatchObject({ opId: "op-4", ok: true });
			const fila = m.sql.exec("SELECT Fecha_Hora_Apertura AS f FROM Comandas WHERE ID_Comanda = 'c-4';").one();
			expect(fila.f).toBe(ahora);

			// CFG-04: lo que no se sabe fijar no lo elige la base.
			const utc = opDelOutbox("op-5", [
				{
					sql: "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES ('c-5', 'BARRA', CURRENT_TIMESTAMP);",
				},
			]);
			const rechazo = await m.mandarLote([utc], { clientNow: ahora });
			expect(rechazo.resultados[0]).toMatchObject({ ok: false, permanente: true });
			expect(rechazo.resultados[0].error).toContain("hora_no_determinista");
		});
	});
});

describe("apply_lote · claves foráneas", () => {
	it("la que sólo entra aplazando entra, y una rota de verdad es un rechazo permanente que no tumba el objeto", async () => {
		const nombre = "lote-fk";
		await enUnHub(nombre, async (m, hub) => {
			hub.__marca = "viva";
			const acuse = await m.mandarLote([zona(1), hijaAntesQueSuMadre(2), huerfana(3), zona(4)]);

			expect(acuse.resultados[0]).toMatchObject({ opId: "op-1", ok: true });
			expect(acuse.resultados[1]).toMatchObject({ opId: "op-2", ok: true });
			expect(acuse.resultados[2]).toMatchObject({ opId: "op-3", ok: false, permanente: true, transitorio: false });
			expect(acuse.resultados[2].error).toMatch(/FOREIGN KEY constraint failed/);
			expect(acuse.resultados[3]).toMatchObject({ opId: "op-4", ok: true });
		});
		// En otra invocación: el objeto es el mismo (no se ha reseteado) y lo confirmado sigue ahí.
		const despues = await enElHub(nombre, (hub: any) => {
			const sql = hub.state.storage.sql;
			return {
				marca: hub.__marca ?? null,
				zonas: zonas(sql),
				lineas: sql.exec("SELECT ID_Detalle FROM Detalle_Comanda;").toArray().map((f: any) => f.ID_Detalle),
				log: sql.exec("SELECT Op_Id FROM Sync_Changes ORDER BY Seq;").toArray().map((f: any) => f.Op_Id),
				aplazando: Number(sql.exec("PRAGMA defer_foreign_keys;").toArray()[0]?.defer_foreign_keys ?? 0),
			};
		});
		expect(despues).toEqual({
			marca: "viva",
			zonas: ["z-1", "z-4"],
			lineas: ["d-2"],
			log: ["op-1", "op-2", "op-4"],
			aplazando: 0,
		});
	});

	it("un lote aplaza tres como mucho: la cuarta y las de detrás quedan sin intentar y entran en el siguiente", async () => {
		await enUnHub("lote-fk-tope", async (m) => {
			const lote = [1, 2, 3, 4].map(hijaAntesQueSuMadre).concat(zona(5));
			const acuse = await m.mandarLote(lote);

			expect(acuse.resultados.slice(0, 3).every((r: any) => r.ok)).toBe(true);
			expect(acuse.resultados.slice(3)).toEqual([
				{ opId: "op-4", ok: false, noIntentada: true },
				{ opId: "op-5", ok: false, noIntentada: true },
			]);
			expect(contar(m.sql, "Detalle_Comanda")).toBe(3);

			const resto = await m.mandarLote(lote.slice(3));
			expect(resto.resultados.every((r: any) => r.ok)).toBe(true);
			expect(ids(m.log())).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5"]);
		});
	});

	it("la primera de un lote se aplaza siempre, aunque el anterior agotara su tope", async () => {
		await enUnHub("lote-fk-primera", async (m) => {
			await m.mandarLote([1, 2, 3].map(hijaAntesQueSuMadre));
			const acuse = await m.mandarLote([hijaAntesQueSuMadre(4)]);
			expect(acuse.resultados).toEqual([expect.objectContaining({ opId: "op-4", ok: true })]);
		});
	});
});

describe("apply_lote · el trabajo que cabe en un turno", () => {
	it("de más de 200 operaciones se aplican 200 y el resto queda sin intentar", async () => {
		await enUnHub("lote-200", async (m) => {
			const lote = Array.from({ length: 203 }, (_, i) => zona(String(i).padStart(3, "0")));
			const acuse = await m.mandarLote(lote);

			expect(acuse.resultados).toHaveLength(203);
			expect(acuse.resultados.slice(0, 200).every((r: any) => r.ok)).toBe(true);
			expect(acuse.resultados.slice(200).every((r: any) => r.noIntentada === true)).toBe(true);
			expect(contar(m.sql, "Zonas")).toBe(200);
		});
	});

	it("de más de 512 KB se aplica lo que cabe, y una sola que no cabe se intenta igual", async () => {
		await enUnHub("lote-bytes", async (m) => {
			// 60 KB de nombre (el SQLite del DO admite 100 KB por sentencia): ocho caben, la novena no.
			const gorda = (n: number) => opDelOutbox(`op-${n}`, [{ sql: ALTA, args: [`z-${n}`, `${n}`.padEnd(60_000, "x")] }]);
			const acuse = await m.mandarLote(Array.from({ length: 10 }, (_, i) => gorda(i)));
			const aplicadas = acuse.resultados.filter((r: any) => r.ok).length;
			expect(aplicadas).toBe(8);
			expect(acuse.resultados.slice(aplicadas).every((r: any) => r.noIntentada === true)).toBe(true);

			// Una operación con muchas sentencias pasa del tope ella sola: va la primera, y se intenta.
			const enorme = opDelOutbox(
				"op-enorme",
				Array.from({ length: 10 }, (_, i) => ({ sql: ALTA, args: [`z-enorme-${i}`, `${i}`.padEnd(60_000, "y")] })),
			);
			const sola = await m.mandarLote([enorme, zona("detras")]);
			expect(sola.resultados).toEqual([
				expect.objectContaining({ opId: "op-enorme", ok: true }),
				{ opId: "op-detras", ok: false, noIntentada: true },
			]);
		});
	});

	it("los 512 KB son de UTF-8: un carácter de fuera de ASCII cuenta lo que ocupa", async () => {
		await enUnHub("lote-bytes-utf8", async (m) => {
			// 20.000 caracteres, casi todos de tres bytes: 60 KB cada una, como las de arriba.
			// Contadas por caracteres cabrían todas.
			const gorda = (n: number) =>
				opDelOutbox(`op-${n}`, [{ sql: ALTA, args: [`z-${n}`, `${n}`.padEnd(20_000, "界")] }]);
			const acuse = await m.mandarLote(Array.from({ length: 10 }, (_, i) => gorda(i)));
			const aplicadas = acuse.resultados.filter((r: any) => r.ok).length;
			expect(aplicadas).toBe(8);
			expect(acuse.resultados.slice(aplicadas).every((r: any) => r.noIntentada === true)).toBe(true);
		});
	});

	it("un mensaje de hasta 9 MiB se lee, y uno de más no se llega a leer (MAX-MENSAJE)", async () => {
		await enUnHub("lote-mensaje-enorme", async (m, hub) => {
			const TOPE = 9 * 1024 * 1024;
			const mensaje = (loteId: string, relleno: string) => JSON.stringify({ type: "apply_lote", loteId, ops: [], relleno });
			const sobre = (loteId: string) => mensaje(loteId, "").length;

			// Justo en el tope, se lee: es el lote quien contesta.
			const leido = m.main.esperar((x) => x.loteId === "en-el-tope" || x.type === "error");
			await hub.webSocketMessage(m.main.servidor, mensaje("en-el-tope", "x".repeat(TOPE - sobre("en-el-tope"))));
			expect(await leido).toMatchObject({ type: "apply_lote_ack", loteId: "en-el-tope", ok: true, resultados: [] });

			// Un byte más, no.
			const respuesta = m.main.esperar((x) => x.type === "error");
			await hub.webSocketMessage(m.main.servidor, mensaje("enorme", "x".repeat(TOPE - sobre("enorme") + 1)));
			expect(await respuesta).toEqual({ type: "error", error: "payload_too_large" });

			// Lo mismo en bytes de UTF-8, aunque en caracteres sean bastantes menos.
			const otra = m.main.esperar((x) => x.type === "error");
			const relleno = "界".repeat(Math.ceil((TOPE - sobre("enorme-utf8") + 1) / 3));
			expect(mensaje("enorme-utf8", relleno).length).toBeLessThan(TOPE);
			await hub.webSocketMessage(m.main.servidor, mensaje("enorme-utf8", relleno));
			expect(await otra).toEqual({ type: "error", error: "payload_too_large" });
		});
	});
});

describe("apply_lote · lo que rechaza el lote entero", () => {
	it("una Handy no manda lotes", async () => {
		await enUnHub("lote-handy", async (m, hub) => {
			const acuse = m.handy.esperar((x) => x.type === "apply_lote_ack");
			await hub.webSocketMessage(
				m.handy.servidor,
				JSON.stringify({ type: "apply_lote", loteId: "de-una-handy", ops: [zona(1)] }),
			);
			expect(await acuse).toEqual({
				type: "apply_lote_ack",
				loteId: "de-una-handy",
				ok: false,
				error: "forbidden_not_tpv",
			});
			expect(zonas(m.sql)).toEqual([]);
		});
	});

	it("con una operación mal formada no se aplica ninguna", async () => {
		await enUnHub("lote-forma", async (m) => {
			const sinNombre = { ...zona(2), commandName: "" };
			const acuse = await m.mandarLote([zona(1), sinNombre, zona(3)]);
			expect(acuse).toMatchObject({ ok: false, error: "missing_apply_fields" });
			expect(acuse.resultados).toBeUndefined();
			expect(zonas(m.sql)).toEqual([]);
			expect(contar(m.sql, "Sync_Changes")).toBe(0);
		});
	});

	it("los nombres son los de la Main: una operación con `op_id` o `command_name` está mal formada", async () => {
		await enUnHub("lote-nombres", async (m) => {
			for (const [i, op] of [
				{ op_id: "op-1", commandName: "main_op", command: zona(1).command },
				{ opId: "op-1", command_name: "main_op", command: zona(1).command },
			].entries()) {
				const acuse = await m.mandarLote([op as any]);
				expect(acuse, `forma ${i}`).toMatchObject({ ok: false, error: "missing_apply_fields" });
			}
			expect(zonas(m.sql)).toEqual([]);
		});
	});

	it("`client_now` no fija la hora, ni en la operación ni en el lote: sólo `clientNow`", async () => {
		await enUnHub("lote-client-now", async (m) => {
			const ahora = "2026-11-14 12:00:00";
			const conAhora = (n: number) =>
				opDelOutbox(`op-${n}`, [
					{
						sql: "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES (?1, 'BARRA', datetime('now','localtime'));",
						args: [`c-${n}`],
					},
				]);
			const porOperacion = await m.mandarLote([{ ...conAhora(1), client_now: ahora } as any]);
			const porLote = await m.mandarLote([conAhora(2)], { client_now: ahora });
			for (const acuse of [porOperacion, porLote]) {
				expect(acuse.resultados[0]).toMatchObject({ ok: false, permanente: true });
				expect(acuse.resultados[0].error).toContain("missing_client_now");
			}
			expect(contar(m.sql, "Comandas")).toBe(0);
		});
	});

	it("el hash de una operación es su comando, con las claves ordenadas: lo de más alrededor no lo cambia", async () => {
		await enUnHub("lote-hash", async (m) => {
			// Las claves con las que antes se podía sustituir el cuerpo del hash ya no cuentan.
			const conAdornos = {
				...zona(1),
				cloud_payload: { otra: "cosa" },
				cloudPayload: { otra: "cosa" },
				request_payload_json: '{"otra":"cosa"}',
				requestPayload: { otra: "cosa" },
			};
			expect((await m.mandarLote([conAdornos as any])).resultados[0]).toMatchObject({ opId: "op-1", ok: true });
			// El reenvío sin ellas es la misma operación.
			expect((await m.mandarLote([zona(1)])).resultados[0]).toMatchObject({ opId: "op-1", ok: true, yaEstaba: true });

			const canonico =
				'{"payload":{"steps":[{"args":["z-1","Zona 1"],"kind":"execute","sql":"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);"}]},"type":"tenantDb.transaction"}';
			const fila = m.sql.exec("SELECT Request_Hash AS h FROM Applied_Operations WHERE Op_Id = 'op-1';").one();
			expect(fila.h).toBe(await sha256Hex(canonico));
		});
	});

	it("el de una escritura de la Handy es su `cloudPayload`, con las claves ordenadas", async () => {
		await enUnHub("rpc-hash", async (m, hub) => {
			m.main.servidor.serializeAttachment({ ...m.main.servidor.deserializeAttachment(), recovering: false });
			const r = await hub.aplicar({
				tenantId: TENANT,
				deviceId: "handy-lote",
				opId: "op-handy-hash",
				commandName: "crear_zona",
				command: { type: "tenantDb.exec", payload: { sql: ALTA, args: ["z-h", "De la Handy"] } },
				cloudPayload: { b: 1, a: { d: null, c: [2, { f: "á", e: 0 }] } },
				clientNow: "",
			});
			expect(r).toMatchObject({ ok: true });
			const fila = m.sql.exec("SELECT Request_Hash AS h FROM Applied_Operations WHERE Op_Id = 'op-handy-hash';").one();
			expect(fila.h).toBe(await sha256Hex('{"a":{"c":[2,{"e":0,"f":"á"}],"d":null},"b":1}'));
		});
	});

	it("sin identificador de lote, o sin lista de operaciones, tampoco", async () => {
		await enUnHub("lote-sin-id", async (m, hub) => {
			for (const cuerpo of [{ ops: [zona(1)] }, { loteId: "sin-ops" }, { loteId: "ops-raras", ops: "x" }]) {
				const acuse = m.main.esperar((x) => x.type === "apply_lote_ack");
				await hub.webSocketMessage(m.main.servidor, JSON.stringify({ type: "apply_lote", ...cuerpo }));
				expect(await acuse).toMatchObject({ ok: false, error: "missing_apply_fields" });
			}
			expect(zonas(m.sql)).toEqual([]);
		});
	});

	it("un lote vacío se contesta sin hacer nada", async () => {
		await enUnHub("lote-vacio", async (m) => {
			expect(await m.mandarLote([])).toMatchObject({ ok: true, resultados: [] });
		});
	});

	it("AUD-02: si la sesión ya no es la de la Main, no entra nada y se dice que es pasajero", async () => {
		await enUnHub("lote-no-es-la-main", async (m, hub) => {
			// La licencia se ha trasladado: la tabla nombra a otro equipo.
			await laMainEs(hub, m.central, TENANT, "otro-equipo");
			const acuse = await m.mandarLote([zona(1)]);
			expect(acuse).toMatchObject({ ok: false, error: "not_authenticated", transitorio: true });
			expect(zonas(m.sql)).toEqual([]);
		});
	});

	it("AUD-02: si deja de serlo esperando el turno del log, tampoco", async () => {
		await enUnHub("lote-turno", async (m, hub) => {
			// Algo ocupa el turno del log; mientras el lote espera, la Main deja de serlo.
			let soltar!: () => void;
			const ocupado = hub.enTurnoDelLog(() => new Promise<void>((r) => (soltar = r)));
			const acuse = m.mandarLote([zona(1)]);
			await new Promise((r) => setTimeout(r, 20));
			await laMainEs(hub, m.central, TENANT, "otro-equipo");
			soltar();
			await ocupado;

			expect(await acuse).toMatchObject({ ok: false, error: "not_authenticated", transitorio: true });
			expect(zonas(m.sql)).toEqual([]);
		});
	});
});

describe("apply_lote · el orden con lo demás", () => {
	it("AUD-02: lo que la Main manda detrás de un lote se confirma detrás", async () => {
		await enUnHub("lote-fila", async (m) => {
			// Sin esperar al acuse de cada lote: el segundo y el tercero llegan con el primero todavía en
			// la fila.
			const lote = m.mandarLote([zona(1), zona(2), zona(3)]);
			const deUna = m.mandarLote([zona(4)]);
			const otro = m.mandarLote([zona(5)]);
			await Promise.all([lote, deUna, otro]);

			expect(ids(m.log())).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5"]);
			expect(m.difundidos()).toEqual(m.log());
		});
	});

	it("AUD-18: una escritura de la Handy no se confirma en medio de un lote", async () => {
		await enUnHub("lote-handy-en-medio", async (m, hub) => {
			// La Main ya ha soltado a las Handy: pueden escribir.
			m.main.servidor.serializeAttachment({ ...m.main.servidor.deserializeAttachment(), recovering: false });
			const deLaHandy = (n: number) =>
				hub.aplicar({
					tenantId: TENANT,
					deviceId: "handy-lote",
					opId: `op-handy-${n}`,
					commandName: "crear_zona",
					command: { type: "tenantDb.exec", payload: { sql: ALTA, args: [`z-handy-${n}`, `De la Handy ${n}`] } },
					clientNow: "",
				});
			const antes = deLaHandy(1);
			const lote = m.mandarLote(Array.from({ length: 50 }, (_, i) => zona(100 + i)));
			const despues = deLaHandy(2);
			const [r1, , r2] = await Promise.all([antes, lote, despues]);
			expect(r1).toMatchObject({ ok: true });
			expect(r2).toMatchObject({ ok: true });

			const orden = ids(m.log());
			const delLote = orden.map((id, i) => (id.startsWith("op-1") ? i : -1)).filter((i) => i >= 0);
			expect(delLote).toHaveLength(50);
			// Las cincuenta del lote, seguidas.
			expect(delLote[49] - delLote[0]).toBe(49);
		});
	});
});
