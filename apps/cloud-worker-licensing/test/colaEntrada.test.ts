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

/**
 * Una operación cuya hora la elegiría la base que la ejecute (REV-22). No es una sentencia que se
 * pueda escribir hoy —lo vigila el scan de `*.commands.ts`—, pero es contra lo que existe el guard.
 */
function opConHoraDeTurso(n: number) {
	const op = opLinea(n);
	op.cmd.payload.steps[0].sql =
		"UPDATE Comandas SET Fecha_Hora_Apertura = CURRENT_TIMESTAMP WHERE ID_Comanda = 'comanda-1';";
	op.cmd.payload.steps[0].args = [];
	return op;
}

/** Ver `applyLote.test.ts`: una FK diferida resetearía el DO entero; esto falla en el acto. */
function opRota(n: number) {
	const op = opLinea(n);
	op.cmd.payload.steps[0].sql = "INSERT INTO Tabla_Que_No_Existe (a) VALUES (?1);";
	return op;
}

/**
 * Prepara el hub para drenar sin un Turso delante: el SQLite del propio DO hace de BD de tenant y
 * se sustituye el RESOLUTOR DE CREDENCIALES por uno que devuelve ese cliente.
 *
 * ⚠️ REV-04: lo que se sustituye es el resolutor, no `withTenantDbRetry`. Mientras se puenteaba el
 * envoltorio entero, su reintento por credenciales caducadas quedaba fuera de todo lo que se
 * probaba aquí — y resultó estar roto: el `try`/`catch` del drenado se tragaba el 401 y la rotación
 * no llegaba a dispararse nunca. Un doble que reemplaza la pieza que hay que vigilar no prueba
 * nada. `credenciales` cuenta cuántas veces se ha pedido el cliente, que es como se ve la rotación.
 */
function prepararHub(hub: any) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	for (const s of SEMILLA) sql.exec(s);

	const db = clienteSobre(sql, hub.state.storage);
	const credenciales = { veces: 0 };
	hub.getTenantDb = async () => {
		credenciales.veces++;
		return db;
	};
	hub.resolveTenantDbClient = async () => {
		credenciales.veces++;
		return db;
	};
	// El interruptor `cola_do` se lee de la base central, que aquí no existe: nadie ha pausado la cola.
	hub.colaPausada = async () => null;
	return { sql, db, credenciales };
}

/**
 * Envuelve el cliente para que la base se caiga y se levante a voluntad.
 *
 * Falla en `batch` y en `execute` —los dos— porque el veredicto de `aplicarLote` depende justo de
 * eso: cuando una operación falla, le pregunta a la base si sigue ahí con un `SELECT 1`. Un doble
 * que sólo rompiera el `batch` contestaría que la base está viva y el test probaría lo contrario de
 * lo que dice probar.
 */
function conLaBase(db: any, estado: { caida: boolean; error?: string }) {
	const reventar = () => {
		throw new Error(estado.error ?? "fetch failed: connect ECONNREFUSED");
	};
	return {
		...db,
		async execute(entrada: any) {
			if (estado.caida) reventar();
			return db.execute(entrada);
		},
		async batch(sentencias: any[], modo?: string) {
			if (estado.caida) reventar();
			return db.batch(sentencias, modo);
		},
	} as any;
}

const intentosEnCola = (sql: any) =>
	sql
		.exec("SELECT Op_Id, Intentos FROM _Cola_Entrada ORDER BY Seq;")
		.toArray()
		.map((f: any) => [String(f.Op_Id), Number(f.Intentos)]);

const muertas = (sql: any) =>
	sql.exec("SELECT Op_Id FROM _Cola_Muerta ORDER BY Apartada_En_Ms;").toArray().map((f: any) => f.Op_Id);

/** Cuánto falta para la alarma programada, en ms. */
async function esperaProgramada(hub: any): Promise<number> {
	const t = await hub.state.storage.getAlarm();
	return t === null ? -1 : Number(t) - Date.now();
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

	it("una operación imposible se aparta a la primera y el resto del atraso entra igual", async () => {
		// Lo que no puede pasar es que un día entero de ventas se quede sin subir por una operación
		// que no hay forma de aplicar. Y `no such table` no va a dejar de serlo dentro de 25
		// segundos: desde REV-04 se aparta en el acto en vez de gastar cinco vueltas para llegar a
		// la misma conclusión.
		await enElHub("cola-apartar", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opRota(2), opLinea(3)]);

			await hub.drenarCola();

			expect(enCola(sql)).toEqual([]);
			expect(lineas(sql)).toEqual(["det-1", "det-3"]);

			const filas = sql.exec("SELECT Op_Id, Intentos FROM _Cola_Muerta;").toArray();
			expect(filas.map((f: any) => f.Op_Id)).toEqual(["op-2"]);
			expect(Number(filas[0].Intentos)).toBe(1);
		});
	});

	it("aplica primero y borra después: si el DO muere entre medias no se pierde nada", async () => {
		// La muerte se simula donde de verdad puede ocurrir: la escritura en Turso entra, pero el
		// DO no llega a enterarse de cuáles fueron, así que no borra nada de la cola. Al volver a
		// drenar, el filtro por `Op_Id` reconoce lo ya aplicado y limpia la cola sin repetir el
		// trabajo. Al revés --borrar y luego aplicar-- ese hueco perdería las dos operaciones.
		await enElHub("cola-crash", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opLinea(1), opLinea(2)]);

			const aplicarDeVerdad = hub.applyBatchIdempotent.bind(hub);
			hub.applyBatchIdempotent = async (db: any, ops: any[]) => {
				await aplicarDeVerdad(db, ops);
				return { aplicadas: [], yaEstaban: [] };
			};
			await hub.drenarCola();

			expect(lineas(sql)).toEqual(["det-1", "det-2"]);
			expect(enCola(sql)).toEqual(["op-1", "op-2"]); // siguen ahí

			hub.applyBatchIdempotent = aplicarDeVerdad;
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

			// Revienta por donde revienta de verdad --la base del tenant-- en vez de sustituir al
			// propio drenado, que es lo que se está probando.
			hub.encolar(TENANT, [opLinea(1)]);
			hub.withTenantDbRetry = async () => {
				throw new Error("turso caido");
			};
			await hub.state.storage.deleteAlarm();

			await hub.alarm();

			expect(await hub.state.storage.getAlarm()).not.toBeNull();
		});
	});

	it("volcar deja EXACTAMENTE el mismo estado que subir de una en una", async () => {
		// La pregunta que de verdad importa: ¿cambia algo por haber ido por la cola? El mismo lote
		// de operaciones se aplica por los dos caminos, en dos hubs distintos, y se comparan las
		// filas resultantes. Si algún día el camino nuevo altera el resultado, esto se pone rojo.
		const ops = [1, 2, 3, 4, 5].map(opLinea);

		const fotografiar = (sql: any) => ({
			lineas: lineas(sql),
			cambios: sql
				.exec("SELECT Op_Id FROM Sync_Changes ORDER BY Seq;")
				.toArray()
				.map((f: any) => f.Op_Id),
			gates: sql
				.exec("SELECT Op_Id FROM Applied_Operations ORDER BY Op_Id;")
				.toArray()
				.map((f: any) => f.Op_Id),
		});

		const unaAUna = await enElHub("equiv-una-a-una", async (hub: any) => {
			const { sql, db } = prepararHub(hub);
			for (const op of ops) await hub.applyBatchIdempotent(db, [op]);
			return fotografiar(sql);
		});

		const volcadas = await enElHub("equiv-volcado", async (hub: any) => {
			const { sql } = prepararHub(hub);
			hub.encolar(TENANT, ops);
			await hub.drenarCola();
			return fotografiar(sql);
		});

		expect(volcadas).toEqual(unaAUna);
	});

	it("mientras hay atraso, una escritura de Handy se rechaza con main_volcando", async () => {
		// Es el freeze: la nube está a medio construir, así que dejar escribir a una Handy sobre ese
		// estado es pedir un choque. Se congela igual que sin Main, con otro motivo (y otro texto:
		// el camarero ve "haciendo copia de seguridad", no "la Main no está activa").
		await enElHub("cola-freeze", async (hub: any) => {
			prepararHub(hub);
			// AUD-15: hay Main y está lista (sin sockets, `isMainReady` daría `main_volcando` también
			// con la cola vacía): lo único que falta es que termine de volcar.
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;

			hub.encolar(TENANT, [opLinea(1)]);

			await expect(
				hub.applyInternalCommandIdempotent({
					tenantId: TENANT,
					cmd: opLinea(9).cmd,
					opId: "op-handy",
					commandName: "add_linea",
					deviceId: "device-handy",
					requestPayloadJson: "{}",
					cloudPayloadJson: "{}",
					clientNow: "2026-01-01 12:30:00",
				}),
			).rejects.toThrow("main_volcando");
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

describe("REV-04 · de quién es la culpa cuando la cola falla", () => {
	it("un corte de Turso no gasta ni un intento, y al volver entra todo en orden", async () => {
		// El bug que esto cierra: cualquier excepción contaba como intento, así que cinco vueltas de
		// cinco segundos —veinticinco segundos de Turso caído— mandaban a la lápida las cincuenta
		// primeras operaciones del atraso. Operaciones sanas, que entran a la primera en cuanto la
		// base vuelve. Es el peor fallo posible aquí: se pierde el dato en la nube y en silencio.
		await enElHub("rev04-corte", async (hub: any) => {
			const { sql, db } = prepararHub(hub);
			const estado = { caida: true };
			hub.getTenantDb = async () => conLaBase(db, estado);

			hub.encolar(TENANT, [opLinea(1), opLinea(2), opLinea(3)]);

			for (let i = 0; i < 6; i++) await hub.drenarCola();

			expect(muertas(sql)).toEqual([]);
			expect(intentosEnCola(sql)).toEqual([
				["op-1", 0],
				["op-2", 0],
				["op-3", 0],
			]);
			expect(lineas(sql)).toEqual([]);

			estado.caida = false;
			await hub.drenarCola();

			expect(enCola(sql)).toEqual([]);
			expect(muertas(sql)).toEqual([]);
			expect(lineas(sql)).toEqual(["det-1", "det-2", "det-3"]);
			// Y en el orden en que salieron de la Main: sus operaciones se apoyan unas en otras.
			expect(
				sql.exec("SELECT Op_Id FROM Sync_Changes ORDER BY Seq;").toArray().map((f: any) => f.Op_Id),
			).toEqual(["op-1", "op-2", "op-3"]);
		});
	});

	it("mientras la base no contesta, la espera crece en escalera y se reinicia al volver", async () => {
		// Plana a 5 s, un Turso caído despertaba al DO doce veces por minuto para otras tantas idas
		// y vueltas que ya se sabía que iban a fallar — y el DO factura a reloj de pared.
		await enElHub("rev04-escalera", async (hub: any) => {
			const { sql, db } = prepararHub(hub);
			const estado = { caida: true };
			hub.getTenantDb = async () => conLaBase(db, estado);

			hub.encolar(TENANT, [opLinea(1)]);

			const esperas: number[] = [];
			for (let i = 0; i < 3; i++) {
				await hub.state.storage.deleteAlarm();
				await hub.drenarCola();
				esperas.push(await esperaProgramada(hub));
			}

			// 5 s → 30 s → 2 min. Se comparan con holgura: entre programar y leer pasa tiempo real.
			expect(esperas[0]).toBeGreaterThan(3_000);
			expect(esperas[0]).toBeLessThanOrEqual(5_000);
			expect(esperas[1]).toBeGreaterThan(25_000);
			expect(esperas[1]).toBeLessThanOrEqual(30_000);
			expect(esperas[2]).toBeGreaterThan(110_000);
			expect(esperas[2]).toBeLessThanOrEqual(120_000);

			estado.caida = false;
			await hub.drenarCola();

			expect(enCola(sql)).toEqual([]);
			// La escalera vuelve abajo: si no, el corte siguiente empezaría esperando un cuarto de
			// hora y el atraso de un bar tardaría toda la mañana en subir.
			const n = sql.exec("SELECT Ciclos_Fallidos AS n FROM _Cola_Estado WHERE Id = 1;").toArray()[0];
			expect(Number(n?.n ?? 0)).toBe(0);
		});
	});

	it("un fallo que no se sabe clasificar no deja pasar a las de detrás", async () => {
		// La base contesta, así que la culpa es de esta operación: se le anota el intento. Pero NO se
		// aplican las de detrás mientras siga en duda —podría ser un `SQLITE_BUSY` que se arregle
		// solo—, porque colarlas sería aplicar el futuro antes que el pasado. Sólo un rechazo
		// PERMANENTE permite saltarse a una: ésa no va a entrar nunca y esperarla es parar la cola.
		await enElHub("rev04-orden-fallo", async (hub: any) => {
			const { sql, db } = prepararHub(hub);
			let rompeALa1 = true;
			hub.getTenantDb = async () => ({
				...db,
				async batch(sentencias: any[], modo?: string) {
					if (rompeALa1 && JSON.stringify(sentencias).includes("det-1")) {
						throw new Error("internal error: unexpected response from server");
					}
					return db.batch(sentencias, modo);
				},
			});

			hub.encolar(TENANT, [opLinea(1), opLinea(2), opLinea(3)]);

			await hub.drenarCola();

			expect(lineas(sql)).toEqual([]);
			expect(intentosEnCola(sql)).toEqual([
				["op-1", 1],
				["op-2", 0],
				["op-3", 0],
			]);
			// Y se reintenta pronto, no con la escalera de una caída: la base está viva.
			expect(await esperaProgramada(hub)).toBeLessThanOrEqual(5_000);

			// Agotados los intentos se aparta, y entonces sí pasa el resto del atraso.
			for (let i = 0; i < 5; i++) await hub.drenarCola();
			expect(muertas(sql)).toEqual(["op-1"]);

			rompeALa1 = false;
			await hub.drenarCola();
			expect(lineas(sql)).toEqual(["det-2", "det-3"]);
		});
	});

	it("un token de Turso caducado se rota, no se lleva el lote por delante", async () => {
		// `withTenantDbRetry` sabe rotar credenciales desde siempre; lo que pasaba es que el drenado
		// capturaba el 401 antes de que llegara a enterarse, así que su reintento era código
		// inalcanzable desde la cola y las cincuenta operaciones del lote gastaban un intento por un
		// problema que se arregla pidiendo un token nuevo.
		await enElHub("rev04-credenciales", async (hub: any) => {
			const { sql, db, credenciales } = prepararHub(hub);

			// Un token caducado no falla una vez: falla TODAS hasta que se rota. Modelarlo con un
			// solo fallo dejaba el test en verde con el bug puesto —el reintento de una en una
			// aplicaba lo mismo sin rotar nada—, así que aquí el cliente viejo no vuelve a servir.
			let rotado = false;
			const caducado = conLaBase(db, { caida: true, error: "Server returned HTTP status 401" });
			hub.getTenantDb = async () => {
				credenciales.veces++;
				return rotado ? db : caducado;
			};
			hub.resolveTenantDbClient = async (_t: string, forzar: boolean) => {
				credenciales.veces++;
				if (forzar) rotado = true;
				return rotado ? db : caducado;
			};

			hub.encolar(TENANT, [opLinea(1), opLinea(2)]);
			credenciales.veces = 0;

			await hub.drenarCola();

			expect(rotado).toBe(true); // el 401 llegó hasta quien sabe rotar
			expect(credenciales.veces).toBeGreaterThanOrEqual(2);
			expect(enCola(sql)).toEqual([]);
			expect(muertas(sql)).toEqual([]);
			expect(intentosEnCola(sql)).toEqual([]);
			expect(lineas(sql)).toEqual(["det-1", "det-2"]);
		});
	});

	it("una hora que tendría que poner Turso se rechaza también por la cola", async () => {
		// REV-22: el guard de CFG-04 estaba sólo en el camino en vivo. Por la cola entraba, y Turso
		// resolvía el `CURRENT_TIMESTAMP` con su reloj y en UTC: la fila de la nube decía otra hora
		// que la de la Main. Es el mismo motor — una operación no puede valer o no según hubiera
		// atraso por delante cuando se subió.
		await enElHub("rev22-hora", async (hub: any) => {
			const { sql } = prepararHub(hub);
			const antes = sql
				.exec("SELECT Fecha_Hora_Apertura AS f FROM Comandas WHERE ID_Comanda = 'comanda-1';")
				.toArray()[0].f;

			hub.encolar(TENANT, [opLinea(1), opConHoraDeTurso(2), opLinea(3)]);

			// Y se aparta a la PRIMERA: `hora_no_determinista` es un rechazo permanente, así que no
			// tiene sentido parar el atraso de detrás cinco vueltas para llegar a lo mismo.
			await hub.drenarCola();

			expect(muertas(sql)).toEqual(["op-2"]);
			expect(lineas(sql)).toEqual(["det-1", "det-3"]);
			expect(
				sql
					.exec("SELECT Fecha_Hora_Apertura AS f FROM Comandas WHERE ID_Comanda = 'comanda-1';")
					.toArray()[0].f,
			).toBe(antes);

			const error = String(
				sql.exec("SELECT Error FROM _Cola_Muerta WHERE Op_Id = 'op-2';").toArray()[0].Error,
			);
			expect(error).toContain("hora_no_determinista");
		});
	});

	it("lo apartado espera a que la Main lo acuse, y entonces se olvida", async () => {
		// `_Cola_Muerta` era una lápida que no visitaba nadie: la nube se quedaba con una fila
		// distinta de la Main y el único que se enteraba era Axiom. Ahora es una bandeja de salida.
		await enElHub("rev04-acuse", async (hub: any) => {
			const { sql } = prepararHub(hub);

			hub.encolar(TENANT, [opRota(1)]);
			await hub.drenarCola();

			const pendientes = hub.apartadasPendientes();
			expect(pendientes.map((o: any) => o.opId)).toEqual(["op-1"]);
			expect(pendientes[0].error).toMatch(/Tabla_Que_No_Existe|no such table/i);

			// Repetir el aviso es inocuo: mientras nadie acuse, la nube lo vuelve a ofrecer.
			expect(hub.apartadasPendientes().map((o: any) => o.opId)).toEqual(["op-1"]);

			hub.olvidarApartadas(["op-1"]);
			expect(hub.apartadasPendientes()).toEqual([]);
			expect(muertas(sql)).toEqual([]);
		});
	});
});
