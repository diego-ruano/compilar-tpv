// test/applyLote.test.ts
//
// SYNC-18 · Fase 1: el apply AGRUPADO del TenantHub.
//
// Aplicar el atraso de una Main de una en una cuesta una ida y vuelta a Turso por operación; el
// agrupado mete N operaciones en una sola transacción. Lo que hay que demostrar no es que "va más
// rápido" (eso no se mide en un test), sino que **deja exactamente el mismo efecto** y que no se
// rompe en los dos sitios donde agrupar cambia las reglas:
//
//   1. Una operación repetida ya no puede tirar el lote entero (el gate por `Op_Id` está hecho
//      para que un duplicado haga rollback: agrupado, se llevaría por delante a las buenas).
//   2. Cada operación conserva su propio `Seq` y su propia fila en `Sync_Changes`, porque de eso
//      dependen el catch-up y el anti-eco de la Main.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { DDL_TABLAS_DE_NUBE } from "../src/durableObjects/tenantHub.sentencias";

/** Estado mínimo para poder insertar comandas y líneas. */
const SEMILLA = [
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);",
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-1', 'cat-1', 'Cerveza', 3.0);",
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('comanda-1', 'MESA', 'mesa-1', '2026-01-01 12:00:00', 'Abierta');",
];

/** Una operación de las que deja la Main en su outbox: añadir una línea a la comanda. */
function opLinea(n: number) {
	const idDetalle = `det-${n}`;
	return {
		opId: `op-${n}`,
		commandName: "add_linea",
		cmd: {
			type: "tenantDb.transaction" as const,
			payload: {
				steps: [
					{
						kind: "execute" as const,
						sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES (?1, 'comanda-1', 'prod-1', 1, 3.0);",
						args: [idDetalle],
					},
				],
			},
		},
		deviceId: "device-main",
		requestPayloadJson: JSON.stringify({ idDetalle }),
		cloudPayloadJson: JSON.stringify({ id_detalle: idDetalle }),
		clientNow: "2026-01-01 12:30:00",
	};
}

/**
 * Una operación que NO se puede aplicar: escribe en una tabla inexistente.
 *
 * Se usa eso y no una violación de clave foránea —que sería el fallo realista— porque el batch va
 * con `defer_foreign_keys`, y una FK que revienta al confirmar hace que el runtime **resetee el
 * Durable Object entero** y lo devuelva a su último estado bueno. Eso es del sustrato de estos
 * tests (el SQLite del propio DO), no de Turso, donde el lote simplemente lanza. Con un error
 * inmediato se prueba lo mismo sin pelearse con el entorno.
 */
function opRota(n: number) {
	const op = opLinea(n);
	op.cmd.payload.steps[0].sql = "INSERT INTO Tabla_Que_No_Existe (a) VALUES (?1);";
	return op;
}

/** Levanta el esquema del tenant + las tablas que solo existen en la nube. */
function prepararTenant(sql: any) {
	crearEsquemaTenant(sql);
	for (const ddl of DDL_TABLAS_DE_NUBE) sql.exec(ddl);
	for (const s of SEMILLA) sql.exec(s);
}

/** Llama al método privado del hub con el cliente de pruebas por delante. */
function aplicarLote(hub: any, db: any, ops: any[]) {
	return hub.applyBatchIdempotent(db, ops);
}

describe("SYNC-18 · apply agrupado", () => {
	it("aplica N operaciones en un solo lote, cada una con su Seq y su fila de sync", async () => {
		await enElHub("lote-basico", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararTenant(sql);
			const db = clienteSobre(sql, hub.state.storage);

			const ops = [opLinea(1), opLinea(2), opLinea(3)];
			const r = await aplicarLote(hub, db, ops);

			expect(r.aplicadas).toEqual(["op-1", "op-2", "op-3"]);
			expect(r.yaEstaban).toEqual([]);

			const lineas = sql.exec("SELECT ID_Detalle FROM Detalle_Comanda ORDER BY ID_Detalle;").toArray();
			expect(lineas.map((f: any) => f.ID_Detalle)).toEqual(["det-1", "det-2", "det-3"]);

			// Una fila de log por operación, con Seq distinto: es de donde sale el checkpoint.
			const cambios = sql
				.exec("SELECT Op_Id, Seq FROM Sync_Changes ORDER BY Seq;")
				.toArray();
			expect(cambios.map((f: any) => f.Op_Id)).toEqual(["op-1", "op-2", "op-3"]);
			expect(new Set(cambios.map((f: any) => Number(f.Seq))).size).toBe(3);

			// Y su gate de idempotencia, uno por operación.
			const gates = sql
				.exec("SELECT Op_Id FROM Applied_Operations ORDER BY Op_Id;")
				.toArray();
			expect(gates.map((f: any) => f.Op_Id)).toEqual(["op-1", "op-2", "op-3"]);
		});
	});

	it("reenviar el mismo lote no duplica nada ni se atasca", async () => {
		// El caso real: se cae la conexión antes del ack, la Main reenvía el trozo entero. Sin el
		// filtro previo, el `Op_Id` repetido violaría el UNIQUE del gate y tiraría el lote completo
		// — y el reintento volvería a chocar, para siempre.
		await enElHub("lote-reenvio", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararTenant(sql);
			const db = clienteSobre(sql, hub.state.storage);

			const ops = [opLinea(1), opLinea(2), opLinea(3)];
			await aplicarLote(hub, db, ops);
			const r2 = await aplicarLote(hub, db, ops);

			expect(r2.aplicadas).toEqual([]);
			expect(r2.yaEstaban.sort()).toEqual(["op-1", "op-2", "op-3"]);

			expect(sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").toArray()[0].n).toBe(3);
			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes;").toArray()[0].n).toBe(3);
			expect(sql.exec("SELECT COUNT(*) AS n FROM Applied_Operations;").toArray()[0].n).toBe(3);
		});
	});

	it("un lote a medio aplicar se completa sin repetir lo que ya estaba", async () => {
		// El caso de verdad: el DO aplicó 2 de 5 y se cayó. La Main reenvía las 5.
		await enElHub("lote-parcial", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararTenant(sql);
			const db = clienteSobre(sql, hub.state.storage);

			await aplicarLote(hub, db, [opLinea(1), opLinea(2)]);
			const r = await aplicarLote(hub, db, [1, 2, 3, 4, 5].map(opLinea));

			expect(r.yaEstaban.sort()).toEqual(["op-1", "op-2"]);
			expect(r.aplicadas).toEqual(["op-3", "op-4", "op-5"]);

			const lineas = sql.exec("SELECT ID_Detalle FROM Detalle_Comanda ORDER BY ID_Detalle;").toArray();
			expect(lineas.map((f: any) => f.ID_Detalle)).toEqual([
				"det-1",
				"det-2",
				"det-3",
				"det-4",
				"det-5",
			]);
		});
	});

	it("si una operación del lote es imposible, no se aplica ninguna", async () => {
		// El todo-o-nada importa: quien llama tiene que poder reintentar de una en una para aislar a
		// la culpable, y eso solo es seguro si el lote fallido no dejó nada a medias.
		await enElHub("lote-atomico", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararTenant(sql);
			const db = clienteSobre(sql, hub.state.storage);

			await expect(
				aplicarLote(hub, db, [opLinea(1), opRota(2), opLinea(3)]),
			).rejects.toThrow();

			expect(sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").toArray()[0].n).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM Applied_Operations;").toArray()[0].n).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes;").toArray()[0].n).toBe(0);
		});
	});

	it("aplicar de una en una aísla a la culpable y deja pasar a las demás", async () => {
		// Es lo que hará el drenado de la cola tras un lote fallido.
		await enElHub("lote-aislar", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararTenant(sql);
			const db = clienteSobre(sql, hub.state.storage);

			const culpables: string[] = [];
			for (const op of [opLinea(1), opRota(2), opLinea(3)]) {
				try {
					await aplicarLote(hub, db, [op]);
				} catch {
					culpables.push(op.opId);
				}
			}

			expect(culpables).toEqual(["op-2"]);
			const lineas = sql.exec("SELECT ID_Detalle FROM Detalle_Comanda ORDER BY ID_Detalle;").toArray();
			expect(lineas.map((f: any) => f.ID_Detalle)).toEqual(["det-1", "det-3"]);
		});
	});
});
