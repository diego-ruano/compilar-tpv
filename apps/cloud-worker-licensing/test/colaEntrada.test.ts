// test/colaEntrada.test.ts
//
// SYNC-18 · Fase 2: la cola de entrada del TenantHub.
//
// La Main que vuelve de estar sin conexión suelta su atraso aquí y se va; el DO lo aplica por su
// cuenta. Eso mueve la responsabilidad al servidor, así que lo que hay que demostrar es que el
// servidor no pierde nada: que la cola es durable, que respeta el orden, que reenviar un trozo no
// duplica, que una operación imposible no bloquea al resto, y que el drenado es insistente —un
// `alarm` que lanza deja de reintentarse solo a los 6 intentos, y la cola se quedaría muerta en
// silencio.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { DDL_TABLAS_DE_NUBE } from "../src/durableObjects/tenantHub.sql";

const TENANT = "tenant-1";

const SEMILLA = [
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);",
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-1', 'cat-1', 'Cerveza', 3.0);",
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('comanda-1', 'MESA', 'mesa-1', '2026-01-01 12:00:00', 'Abierta');",
];

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

/** Ver `applyLote.test.ts`: una FK diferida resetearía el DO entero; esto falla en el acto. */
function opRota(n: number) {
	const op = opLinea(n);
	op.cmd.payload.steps[0].sql = "INSERT INTO Tabla_Que_No_Existe (a) VALUES (?1);";
	return op;
}

/**
 * Prepara el hub para drenar sin un Turso delante: el SQLite del propio DO hace de BD de tenant y
 * se sustituye el resolutor de credenciales por uno que devuelve ese cliente.
 */
function prepararHub(hub: any) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	for (const ddl of DDL_TABLAS_DE_NUBE) sql.exec(ddl);
	for (const s of SEMILLA) sql.exec(s);

	const db = clienteSobre(sql, hub.state.storage);
	hub.withTenantDbRetry = async (_tenantId: string, run: any) => run(db);
	return { sql, db };
}

const enCola = (sql: any) =>
	sql.exec("SELECT Op_Id FROM _Cola_Entrada ORDER BY Seq;").toArray().map((f: any) => f.Op_Id);

const lineas = (sql: any) =>
	sql
		.exec("SELECT ID_Detalle FROM Detalle_Comanda ORDER BY ID_Detalle;")
		.toArray()
		.map((f: any) => f.ID_Detalle);

describe("SYNC-18 · cola de entrada del DO", () => {
	it("encolar guarda en orden y no toca la BD del tenant", async () => {
		// Es lo que hace que el ack sea inmediato y la Main pueda desconectarse: encolar no escribe
		// en Turso, solo en el SQLite del propio DO.
		await enElHub("cola-encolar", async (hub: any) => {
			const { sql } = prepararHub(hub);

			const aceptadas = hub.encolar(TENANT, [opLinea(1), opLinea(2), opLinea(3)]);

			expect(aceptadas).toEqual(["op-1", "op-2", "op-3"]);
			expect(enCola(sql)).toEqual(["op-1", "op-2", "op-3"]);
			expect(lineas(sql)).toEqual([]);
		});
	});

	it("reenviar un trozo del que no se vio el ack no lo duplica", async () => {
		await enElHub("cola-reenvio", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opLinea(2)]);
			hub.encolar(TENANT, [opLinea(2), opLinea(3)]);

			expect(enCola(sql)).toEqual(["op-1", "op-2", "op-3"]);
		});
	});

	it("el drenado aplica todo y vacía la cola", async () => {
		await enElHub("cola-drenar", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opLinea(2), opLinea(3)]);
			await hub.drenarCola();

			expect(enCola(sql)).toEqual([]);
			expect(lineas(sql)).toEqual(["det-1", "det-2", "det-3"]);
			// Y cada una con su fila de log, que es lo que consume el catch-up.
			expect(sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes;").toArray()[0].n).toBe(3);
		});
	});

	it("una operación imposible se aparta y el resto del atraso entra igual", async () => {
		// Lo que no puede pasar es que un día entero de ventas se quede sin subir por una operación
		// que no hay forma de aplicar.
		await enElHub("cola-apartar", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opRota(2), opLinea(3)]);

			// Cada vuelta gasta un intento de la rota; a los 5 se aparta.
			for (let i = 0; i < 6; i++) await hub.drenarCola();

			expect(enCola(sql)).toEqual([]);
			expect(lineas(sql)).toEqual(["det-1", "det-3"]);

			const muertas = sql.exec("SELECT Op_Id, Intentos FROM _Cola_Muerta;").toArray();
			expect(muertas.map((f: any) => f.Op_Id)).toEqual(["op-2"]);
			expect(Number(muertas[0].Intentos)).toBeGreaterThanOrEqual(5);
		});
	});

	it("aplica primero y borra después: si el DO muere entre medias no se pierde nada", async () => {
		// Se simula la muerte haciendo que el borrado no ocurra; al volver a drenar, el filtro por
		// `Op_Id` reconoce lo ya aplicado y limpia la cola sin repetir el trabajo.
		await enElHub("cola-crash", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opLinea(2)]);

			const borradoReal = hub.sacarDeLaCola.bind(hub);
			hub.sacarDeLaCola = () => {}; // el DO "muere" justo antes de limpiar
			await hub.drenarCola();

			expect(lineas(sql)).toEqual(["det-1", "det-2"]);
			expect(enCola(sql)).toEqual(["op-1", "op-2"]); // siguen ahí

			hub.sacarDeLaCola = borradoReal;
			await hub.drenarCola();

			expect(enCola(sql)).toEqual([]);
			expect(lineas(sql)).toEqual(["det-1", "det-2"]); // sin duplicar
		});
	});

	it("si el ciclo revienta, la alarma se reprograma sola", async () => {
		// El reintento automático de un alarm se rinde a los 6; sin esta reprogramación la cola se
		// quedaría muerta en silencio, que es el peor fallo posible aquí.
		await enElHub("cola-alarma", async (hub: any) => {
			prepararHub(hub);

			hub.drenarCola = async () => {
				throw new Error("turso caido");
			};
			await hub.state.storage.deleteAlarm();

			await hub.alarm();

			expect(await hub.state.storage.getAlarm()).not.toBeNull();
		});
	});

	it("con cola pendiente, el drenado respeta el orden de llegada", async () => {
		// El outbox de la Main está ordenado y sus operaciones se apoyan unas en otras: lo que llega
		// nuevo tiene que ir DETRÁS del atraso, nunca colarse.
		await enElHub("cola-orden", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opLinea(2)]);
			hub.encolar(TENANT, [opLinea(3)]); // llega después, va al final

			expect(enCola(sql)).toEqual(["op-1", "op-2", "op-3"]);

			await hub.drenarCola();

			const orden = sql
				.exec("SELECT Op_Id FROM Sync_Changes ORDER BY Seq;")
				.toArray()
				.map((f: any) => f.Op_Id);
			expect(orden).toEqual(["op-1", "op-2", "op-3"]);
		});
	});
});
