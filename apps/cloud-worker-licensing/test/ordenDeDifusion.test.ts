// test/ordenDeDifusion.test.ts
//
// AUD-18 · el TenantHub difunde los cambios en orden de `Seq`.
//
// La Main aplica en orden de `Seq` y guarda como checkpoint el último que le llega; al reconectar
// pide desde ahí. Si el DO difundiera el 11 antes que el 10 —dos escrituras a la vez: la base
// numera al confirmar, pero la segunda termina antes— y a la Main se le cayera el socket entre
// medias, el 10 no volvería a pedirse nunca. Aquí se prueba lo que lo impide: el turno del log
// (`enTurnoDelLog`), que hace que cada escritura confirme y difunda antes de que empiece la
// siguiente, también la de un lote de la Main.
//
// La base del tenant es el SQLite del propio DO (`clienteSobre`) con una puerta delante: la primera
// escritura confirma en el acto, pero su respuesta no vuelve hasta que el test la abre. Es la forma
// determinista de que una segunda escritura llegue mientras la primera aún no ha terminado.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

const TENANT = "tenant-1";
const INSERTAR_ZONA = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Una escritura de una Handy: crear una zona. */
function escritura(opId: string, idZona: string) {
	return {
		tenantId: TENANT,
		cmd: { type: "tenantDb.exec", payload: { sql: INSERTAR_ZONA, args: [idZona, idZona] } },
		opId,
		commandName: "crear_zona",
		deviceId: `handy-${opId}`,
		requestPayloadJson: JSON.stringify({ opId }),
		clientNow: "2026-11-09 12:00:00",
	};
}

/** Una operación del outbox de la Main, como llega en su lote (`OpDeLote`). */
function opDelLote(opId: string, idZona: string) {
	return {
		opId,
		commandName: "crear_zona",
		cmd: {
			type: "tenantDb.transaction",
			payload: { steps: [{ kind: "execute", sql: INSERTAR_ZONA, args: [idZona, idZona] }] },
		},
		requestPayloadJson: JSON.stringify({ opId }),
	};
}

/** El lote de la Main, sin socket de por medio: la sesión siempre es la suya. */
function loteDeLaMain(hub: any, ops: ReturnType<typeof opDelLote>[]): Promise<any[]> {
	hub.esLaMain = () => true;
	return new Promise((resolver, rechazar) => {
		hub
			.aplicarLote({
				tenantId: TENANT,
				deviceId: "device-main",
				sesion: { readyState: 1, deserializeAttachment: () => null },
				ops,
				alTerminar: resolver,
			})
			.catch(rechazar);
	});
}

/**
 * La base con una puerta: la PRIMERA escritura confirma (su `Seq` ya está asignado) y avisa por
 * `dentro`, pero no devuelve la respuesta hasta `abrir()`. Las demás pasan sin esperar.
 */
function conPuerta(base: any) {
	let abrir!: () => void;
	const puerta = new Promise<void>((r) => (abrir = r));
	let avisarDentro!: () => void;
	const dentro = new Promise<void>((r) => (avisarDentro = r));
	let primera = true;
	return {
		abrir: () => abrir(),
		dentro,
		db: {
			...base,
			async batch(sentencias: any[], modo?: string) {
				const r = await base.batch(sentencias, modo);
				if (primera) {
					primera = false;
					avisarDentro();
					await puerta;
				}
				return r;
			},
		},
	};
}

/** Hub sin base central delante; devuelve lo que difunde, en orden. */
function prepararHub(hub: any, db: any): any[] {
	crearEsquemaTenant(hub.state.storage.sql);
	hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
	hub.touchLastSeen = async () => {};
	hub.isMainConnected = () => true;
	hub.isMainReady = () => true;
	hub.maybePurgeSyncLog = async () => {};
	const difundidos: any[] = [];
	hub.broadcastAuthed = (obj: any) => {
		if (obj?.type === "change") difundidos.push(obj);
	};
	return difundidos;
}

const seqDelLog = (sql: any, opId: string) =>
	Number(sql.exec("SELECT Seq FROM Sync_Changes WHERE Op_Id = ?;", opId).toArray()[0]?.Seq);

describe("AUD-18 · el TenantHub difunde en orden de Seq", () => {
	it("la escritura que confirma antes se difunde antes, aunque su respuesta tarde", async () => {
		await enElHub("aud18-orden", async (hub: any) => {
			const sql = hub.state.storage.sql;
			const puerta = conPuerta(clienteSobre(sql, hub.state.storage));
			const difundidos = prepararHub(hub, puerta.db);

			const a = hub.applyInternalCommandIdempotent(escritura("op-a", "z-a"));
			await puerta.dentro;
			const b = hub.applyInternalCommandIdempotent(escritura("op-b", "z-b"));
			// Tiempo de sobra para que, sin turno, la segunda confirme y se difunda entera.
			await esperar(50);
			expect(difundidos).toEqual([]);
			puerta.abrir();
			const [ra, rb] = await Promise.all([a, b]);

			expect(ra.seq).toBe(seqDelLog(sql, "op-a"));
			expect(rb.seq).toBe(seqDelLog(sql, "op-b"));
			expect(ra.seq).toBeLessThan(rb.seq);
			expect(difundidos.map((m) => m.opId)).toEqual(["op-a", "op-b"]);
			expect(difundidos.map((m) => m.seq)).toEqual([ra.seq, rb.seq]);
		});
	});

	it("un lote de la Main no se difunde por delante de una escritura que confirmó antes", async () => {
		await enElHub("aud18-orden-lote", async (hub: any) => {
			const sql = hub.state.storage.sql;
			const puerta = conPuerta(clienteSobre(sql, hub.state.storage));
			const difundidos = prepararHub(hub, puerta.db);

			const handy = hub.applyInternalCommandIdempotent(escritura("op-handy", "z-handy"));
			await puerta.dentro;
			const lote = loteDeLaMain(hub, [opDelLote("op-lote-1", "z-lote-1"), opDelLote("op-lote-2", "z-lote-2")]);
			await esperar(50);
			expect(difundidos).toEqual([]);
			puerta.abrir();
			const [, veredictos] = await Promise.all([handy, lote]);

			expect(veredictos.map((v: any) => v.seq)).toEqual([seqDelLog(sql, "op-lote-1"), seqDelLog(sql, "op-lote-2")]);
			expect(seqDelLog(sql, "op-handy")).toBeLessThan(seqDelLog(sql, "op-lote-1"));
			expect(difundidos.map((m) => m.opId)).toEqual(["op-handy", "op-lote-1", "op-lote-2"]);
		});
	});

	it("una escritura que espera turno no se confirma si entretanto la Main se pone al día", async () => {
		// La Handy pasó el congelado con la Main lista y esperaba su turno; entre medias la Main volvió
		// a saludar con `recovering` (AUD-15). Dentro del turno se vuelve a mirar: no entra.
		await enElHub("aud18-orden-congelado", async (hub: any) => {
			const sql = hub.state.storage.sql;
			const puerta = conPuerta(clienteSobre(sql, hub.state.storage));
			const difundidos = prepararHub(hub, puerta.db);

			const a = hub.applyInternalCommandIdempotent(escritura("op-a", "z-a"));
			await puerta.dentro;
			const b = hub.applyInternalCommandIdempotent(escritura("op-b", "z-b"));
			await esperar(20);
			hub.isMainReady = () => false;
			puerta.abrir();

			await a;
			await expect(b).rejects.toThrow("main_volcando");
			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes WHERE Op_Id = 'op-b';").toArray()[0].n).toBe(0);
			expect(difundidos[0]?.opId).toBe("op-a");
			expect(difundidos.map((m) => m.opId)).not.toContain("op-b");
		});
	});

	it("una escritura que la base rechaza suelta el turno", async () => {
		await enElHub("aud18-turno-libre", async (hub: any) => {
			const sql = hub.state.storage.sql;
			const base = clienteSobre(sql, hub.state.storage);
			const estado = { rechaza: true };
			const db = {
				...base,
				async batch(sentencias: any[], modo?: string) {
					if (estado.rechaza) throw new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed: Zonas.Nombre_Zona");
					return base.batch(sentencias, modo);
				},
			};
			const difundidos = prepararHub(hub, db);

			await expect(hub.applyInternalCommandIdempotent(escritura("op-x", "z-x"))).rejects.toThrow(
				"NOT NULL",
			);
			estado.rechaza = false;
			const r = await hub.applyInternalCommandIdempotent(escritura("op-y", "z-y"));

			expect(r.seq).toBe(seqDelLog(sql, "op-y"));
			expect(difundidos.map((m) => m.opId)).toEqual(["op-y"]);
		});
	});
});
