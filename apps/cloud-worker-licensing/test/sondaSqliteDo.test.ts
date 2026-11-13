// test/sondaSqliteDo.test.ts
//
// Sondas de la rama prueba/sqlite-do: qué hace el SQLite del Durable Object con lo que hoy hace
// Turso. No prueba código del worker, prueba el sustrato: claves foráneas, límites, jurisdicción y
// tiempos con un volumen de restaurante. Cada sonda deja su resultado en el informe que se imprime
// al final.

import { afterAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

const informe: Record<string, unknown> = {};

afterAll(() => {
	console.log("\n===== INFORME SONDAS SQLITE DO =====\n" + JSON.stringify(informe, null, 2));
});

function comanda(sql: any, id: string) {
	sql.exec(
		"INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES (?1, 'BARRA', '2026-11-11 10:00:00');",
		id,
	);
}

function lineaHuerfana(sql: any, id: string) {
	sql.exec(
		"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES (?1, 'NO-EXISTE', 1, 100);",
		id,
	);
}

function contar(sql: any, tabla: string): number {
	return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).one().n);
}

function error(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (e) {
		return String((e as Error)?.message ?? e);
	}
}

describe("claves foráneas", () => {
	it("vienen activas y una violación inmediata lanza dentro de transactionSync sin tumbar el DO", async () => {
		const nombre = "sonda-fk-inmediata";
		await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			crearEsquemaTenant(sql);
			comanda(sql, "c0");
			hub.__marca = "viva";
		});
		const res = await enElHub(nombre, (hub) => {
			const st = hub.state.storage;
			const fk = st.sql.exec("PRAGMA foreign_keys;").toArray()[0];
			const err = error(() =>
				st.transactionSync(() => {
					comanda(st.sql, "c1");
					lineaHuerfana(st.sql, "d1");
				}),
			);
			return { fk, err, comandas: contar(st.sql, "Comandas"), marca: hub.__marca ?? null };
		});
		const despues = await enElHub(nombre, (hub) => ({
			marca: hub.__marca ?? null,
			comandas: contar(hub.state.storage.sql, "Comandas"),
		}));
		informe.fkInmediata = { ...res, despues };
		expect(res.err).toMatch(/FOREIGN KEY/i);
		expect(res.comandas).toBe(1);
	});

	it("una violación aplazada (defer_foreign_keys): qué pasa al confirmar", async () => {
		const nombre = "sonda-fk-aplazada";
		await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			crearEsquemaTenant(sql);
			comanda(sql, "c0");
			hub.__marca = "viva";
		});
		let errLlamada: string | null = null;
		let res: any = null;
		try {
			res = await enElHub(nombre, (hub) => {
				const st = hub.state.storage;
				const err = error(() =>
					st.transactionSync(() => {
						st.sql.exec("PRAGMA defer_foreign_keys = ON;");
						comanda(st.sql, "c1");
						lineaHuerfana(st.sql, "d1");
					}),
				);
				return { errDentro: err, comandasDentro: contar(st.sql, "Comandas") };
			});
		} catch (e) {
			errLlamada = String((e as Error)?.message ?? e);
		}
		let despues: any = null;
		let errDespues: string | null = null;
		try {
			despues = await enElHub(nombre, (hub) => ({
				marca: hub.__marca ?? null,
				comandas: contar(hub.state.storage.sql, "Comandas"),
				lineas: contar(hub.state.storage.sql, "Detalle_Comanda"),
			}));
		} catch (e) {
			errDespues = String((e as Error)?.message ?? e);
		}
		informe.fkAplazada = { res, errLlamada, despues, errDespues };
	});

	it("aplazada + PRAGMA foreign_key_check antes de cerrar: se detecta y se deshace limpio", async () => {
		const nombre = "sonda-fk-check";
		await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			crearEsquemaTenant(sql);
			comanda(sql, "c0");
			hub.__marca = "viva";
		});
		const res = await enElHub(nombre, (hub) => {
			const st = hub.state.storage;
			let violaciones: any[] = [];
			const err = error(() =>
				st.transactionSync(() => {
					st.sql.exec("PRAGMA defer_foreign_keys = ON;");
					comanda(st.sql, "c1");
					lineaHuerfana(st.sql, "d1");
					violaciones = st.sql.exec("PRAGMA foreign_key_check(Detalle_Comanda);").toArray();
					if (violaciones.length > 0) throw new Error("fk_rota");
				}),
			);
			return { err, violaciones, comandas: contar(st.sql, "Comandas") };
		});
		const despues = await enElHub(nombre, (hub) => ({
			marca: hub.__marca ?? null,
			comandas: contar(hub.state.storage.sql, "Comandas"),
		}));
		informe.fkAplazadaConCheck = { ...res, despues };
		expect(res.err).toBe("fk_rota");
		expect(despues.marca).toBe("viva");
	});

	it("aplazada con orden hijo→padre válido al final: confirma sin problema", async () => {
		const nombre = "sonda-fk-orden";
		const res = await enElHub(nombre, (hub) => {
			const st = hub.state.storage;
			crearEsquemaTenant(st.sql);
			const err = error(() =>
				st.transactionSync(() => {
					st.sql.exec("PRAGMA defer_foreign_keys = ON;");
					st.sql.exec(
						"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES ('d1', 'c1', 1, 100);",
					);
					comanda(st.sql, "c1");
				}),
			);
			return { err, lineas: contar(st.sql, "Detalle_Comanda") };
		});
		informe.fkAplazadaOrdenValido = res;
		expect(res.err).toBeNull();
	});
});

// Lo que necesita una migración que reconstruye una tabla (crear la nueva, copiar, borrar la vieja,
// renombrar): el runner de la Main apaga las FK alrededor de la tanda (`migrations.rs::run`). Aquí
// se mira si el SQLite del DO deja hacer lo mismo y qué pasa si no se hace.
describe("claves foráneas al migrar", () => {
	const fk = (sql: any): number => Number(sql.exec("PRAGMA foreign_keys;").toArray()[0]?.foreign_keys);
	const mesa = (sql: any, id: string, zona: string) =>
		sql.exec(
			"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES (?1, ?2, ?1, 4, 0, 0, 'rect', 10, 10);",
			id,
			zona,
		);
	/** Una zona con dos mesas (`Mesas.ID_Zona` es `ON DELETE CASCADE`). */
	const sembrar = (sql: any) => {
		crearEsquemaTenant(sql);
		sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
		mesa(sql, "m1", "z1");
		mesa(sql, "m2", "z1");
	};
	/** La reconstrucción de una tabla padre, como la haría una migración que le quita un `CHECK`. */
	const reconstruirZonas = (sql: any) => {
		sql.exec(
			"CREATE TABLE Zonas_nueva (ID_Zona TEXT NOT NULL PRIMARY KEY, Nombre_Zona TEXT NOT NULL, Room_Points TEXT NOT NULL DEFAULT '[]', Updated_At DATETIME, Archivada_En DATETIME);",
		);
		sql.exec("INSERT INTO Zonas_nueva SELECT * FROM Zonas;");
		sql.exec("DROP TABLE Zonas;");
		sql.exec("ALTER TABLE Zonas_nueva RENAME TO Zonas;");
	};

	it("PRAGMA foreign_keys = OFF fuera de transactionSync: se acepta, tiene efecto y dura hasta que se vuelve a encender", async () => {
		const nombre = "sonda-fk-apagar";
		await enElHub(nombre, (hub) => sembrar(hub.state.storage.sql));

		// Al empezar un turno, sin nada escrito todavía.
		const alEmpezar = await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			const antes = fk(sql);
			const errOff = error(() => sql.exec("PRAGMA foreign_keys = OFF;"));
			const trasOff = fk(sql);
			// Con las FK apagadas de verdad, una mesa de una zona que no existe entra.
			const errHuerfana = error(() => mesa(sql, "huerfana", "NO-EXISTE"));
			const violaciones = sql.exec("PRAGMA foreign_key_check;").toArray().length;
			sql.exec("DELETE FROM Mesas WHERE ID_Mesa = 'huerfana';");
			// Ya se ha escrito en este turno: ¿se puede volver a encender aquí mismo?
			const errOn = error(() => sql.exec("PRAGMA foreign_keys = ON;"));
			return { antes, errOff, trasOff, errHuerfana, violaciones, errOn, trasOnEnElMismoTurno: fk(sql) };
		});

		// En el turno siguiente: lo que quedó, y encender sin haber escrito nada.
		const turnoSiguiente = await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			const heredado = fk(sql);
			sql.exec("PRAGMA foreign_keys = ON;");
			const trasOn = fk(sql);
			return { heredado, trasOn, errHuerfana: error(() => mesa(sql, "huerfana-2", "NO-EXISTE")) };
		});

		// Después de escribir en el mismo turno, y dentro de `transactionSync`.
		const conEscrituraPrevia = await enElHub(nombre, (hub) => {
			const st = hub.state.storage;
			st.sql.exec("UPDATE Zonas SET Nombre_Zona = 'Sala 2' WHERE ID_Zona = 'z1';");
			const errOff = error(() => st.sql.exec("PRAGMA foreign_keys = OFF;"));
			const trasEscribir = fk(st.sql);
			let dentro: number | null = null;
			st.transactionSync(() => {
				st.sql.exec("PRAGMA foreign_keys = OFF;");
				dentro = fk(st.sql);
			});
			const alSalir = fk(st.sql);
			st.sql.exec("PRAGMA foreign_keys = ON;");
			return { errOff, trasEscribir, dentroDeTransactionSync: dentro, alSalir, trasOn: fk(st.sql) };
		});
		const alFinal = await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			const heredado = fk(sql);
			sql.exec("PRAGMA foreign_keys = ON;");
			return { heredado, trasOn: fk(sql) };
		});

		informe.fkApagar = { alEmpezar, turnoSiguiente, conEscrituraPrevia, alFinal };
		// De esto depende `migrarBaseLocal` (`tenantHub.sqlite.ts`): si cambia, hay que volver a mirarlo.
		expect(alEmpezar.antes).toBe(1);
		// Sin nada escrito en el turno, se apagan de verdad: una huérfana entra.
		expect(alEmpezar).toMatchObject({ errOff: null, trasOff: 0, errHuerfana: null, violaciones: 1 });
		// Con algo escrito en el turno, el PRAGMA no hace nada y no avisa: ni para encender…
		expect(alEmpezar).toMatchObject({ errOn: null, trasOnEnElMismoTurno: 0 });
		// …ni para apagar, ni dentro de `transactionSync`.
		expect(conEscrituraPrevia).toMatchObject({ errOff: null, trasEscribir: 1, dentroDeTransactionSync: 1 });
		// Y como se quedan, se quedan: el turno siguiente las hereda apagadas.
		expect(turnoSiguiente.heredado).toBe(0);
		expect(turnoSiguiente.trasOn).toBe(1);
		expect(turnoSiguiente.errHuerfana).toMatch(/FOREIGN KEY/i);
		expect(alFinal.trasOn).toBe(1);
	});

	it("reconstruir una tabla padre con las FK activas se lleva a sus hijas en cascada", async () => {
		const nombre = "sonda-fk-reconstruir-activas";
		await enElHub(nombre, (hub) => sembrar(hub.state.storage.sql));
		const res = await enElHub(nombre, (hub) => {
			const st = hub.state.storage;
			const mesasAntes = contar(st.sql, "Mesas");
			const err = error(() => st.transactionSync(() => reconstruirZonas(st.sql)));
			return {
				fk: fk(st.sql),
				err,
				mesasAntes,
				mesasDespues: contar(st.sql, "Mesas"),
				zonasDespues: contar(st.sql, "Zonas"),
				violaciones: st.sql.exec("PRAGMA foreign_key_check;").toArray().length,
			};
		});
		informe.fkReconstruirConFkActivas = res;
		expect(res.mesasAntes).toBe(2);
		// Sin error y sin nada que `foreign_key_check` pueda ver: las mesas ya no están.
		expect(res).toMatchObject({ fk: 1, err: null, mesasDespues: 0, zonasDespues: 1, violaciones: 0 });
	});

	it("y una hija sin acción (NO ACTION) impide borrar la tabla padre", async () => {
		const nombre = "sonda-fk-reconstruir-no-action";
		await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			sembrar(sql);
			// `Reservas.ID_Mesa` no lleva acción: borrar la mesa con una reserva que la apunta no se puede.
			sql.exec(
				"INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno) VALUES ('r1', 'm1', '2026-11-13', '21:00', 'CENA');",
			);
		});
		const res = await enElHub(nombre, (hub) => {
			const st = hub.state.storage;
			const err = error(() => st.transactionSync(() => st.sql.exec("DROP TABLE Mesas;")));
			return { fk: fk(st.sql), err, mesas: contar(st.sql, "Mesas"), reservas: contar(st.sql, "Reservas") };
		});
		informe.fkBorrarPadreConHijaSinAccion = res;
		expect(res.err).toMatch(/FOREIGN KEY/i);
		expect(res).toMatchObject({ mesas: 2, reservas: 1 });
	});

	it("con las FK apagadas alrededor, la reconstrucción conserva a las hijas", async () => {
		const nombre = "sonda-fk-reconstruir-apagadas";
		await enElHub(nombre, (hub) => sembrar(hub.state.storage.sql));
		const res = await enElHub(nombre, async (hub) => {
			const st = hub.state.storage;
			st.sql.exec("PRAGMA foreign_keys = OFF;");
			const apagadas = fk(st.sql);
			let violaciones = -1;
			const err = error(() =>
				st.transactionSync(() => {
					reconstruirZonas(st.sql);
					violaciones = st.sql.exec("PRAGMA foreign_key_check;").toArray().length;
				}),
			);
			const errOn = error(() => st.sql.exec("PRAGMA foreign_keys = ON;"));
			const trasOnEnElMismoTurno = fk(st.sql);
			// Ceder sólo a las microtareas no cierra la transacción que el DO abre al escribir.
			await Promise.resolve();
			st.sql.exec("PRAGMA foreign_keys = ON;");
			const trasCederALasMicrotareas = fk(st.sql);
			// Esperar a que lo escrito esté confirmado, sí.
			await st.sync();
			st.sql.exec("PRAGMA foreign_keys = ON;");
			const trasSync = fk(st.sql);
			return {
				apagadas,
				err,
				violaciones,
				errOn,
				trasOnEnElMismoTurno,
				trasCederALasMicrotareas,
				trasSync,
				mesas: contar(st.sql, "Mesas"),
				zonas: contar(st.sql, "Zonas"),
			};
		});
		const despues = await enElHub(nombre, (hub) => {
			const { sql } = hub.state.storage;
			const heredado = fk(sql);
			sql.exec("PRAGMA foreign_keys = ON;");
			return {
				heredado,
				trasOn: fk(sql),
				mesas: contar(sql, "Mesas"),
				// Encendidas otra vez, la FK de las hijas sigue apuntando a la tabla reconstruida.
				errHuerfana: error(() => mesa(sql, "huerfana", "NO-EXISTE")),
				errBorrarZona: error(() => sql.exec("DELETE FROM Zonas WHERE ID_Zona = 'z1';")),
				mesasTrasBorrarLaZona: contar(sql, "Mesas"),
			};
		});
		informe.fkReconstruirConFkApagadas = { ...res, despues };
		expect(res).toMatchObject({ apagadas: 0, err: null, violaciones: 0, mesas: 2, zonas: 1 });
		// Volver a encenderlas pide que lo escrito esté confirmado: ni en el mismo turno ni cediendo
		// a las microtareas, sí tras `storage.sync()`.
		expect(res).toMatchObject({ trasOnEnElMismoTurno: 0, trasCederALasMicrotareas: 0, trasSync: 1 });
		expect(despues).toMatchObject({ heredado: 1, mesas: 2, errBorrarZona: null, mesasTrasBorrarLaZona: 0 });
		expect(despues.errHuerfana).toMatch(/FOREIGN KEY/i);
	});

	it("reconstruir una tabla que lee una vista: el RENAME falla si la vista se queda sin tabla", async () => {
		const nombre = "sonda-fk-reconstruir-con-vista";
		await enElHub(nombre, (hub) => sembrar(hub.state.storage.sql));
		const res = await enElHub(nombre, async (hub) => {
			const st = hub.state.storage;
			const vistas = st.sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'view' AND sql LIKE '%Productos%' ORDER BY name;")
				.toArray()
				.map((v: any) => String(v.name));
			st.sql.exec("PRAGMA foreign_keys = OFF;");
			const reconstruir = () =>
				st.transactionSync(() => {
					st.sql.exec("CREATE TABLE Productos_nueva AS SELECT * FROM Productos;");
					st.sql.exec("DROP TABLE Productos;");
					st.sql.exec("ALTER TABLE Productos_nueva RENAME TO Productos;");
				});
			const err = error(reconstruir);
			await st.sync();
			st.sql.exec("PRAGMA foreign_keys = ON;");
			return { vistas, err, fk: fk(st.sql), sigueLaTabla: contar(st.sql, "Productos") };
		});
		informe.fkReconstruirConVista = res;
		expect(res.vistas.length).toBeGreaterThan(0);
		expect(res.err).toMatch(/error in view/i);
		expect(res).toMatchObject({ fk: 1, sigueLaTabla: 0 });
	});
});

describe("límites del SQL", () => {
	it("parámetros, json_each, LIKE, UNION y longitud", async () => {
		const res = await enElHub("sonda-limites", (hub) => {
			const { sql } = hub.state.storage;
			const marcas = (n: number) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(", ");
			const valores = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
			const ids = valores(1000);
			return {
				params100: error(() => sql.exec(`SELECT 1 WHERE 'x' NOT IN (${marcas(100)});`, ...valores(100)).toArray()),
				params101: error(() => sql.exec(`SELECT 1 WHERE 'x' NOT IN (${marcas(101)});`, ...valores(101)).toArray()),
				jsonEach1000: error(() =>
					sql.exec("SELECT COUNT(*) FROM json_each(?1) WHERE value NOT IN ('x');", JSON.stringify(ids)).toArray(),
				),
				like50: error(() => sql.exec("SELECT 'a' LIKE ?1;", "%" + "a".repeat(48) + "%").toArray()),
				like51: error(() => sql.exec("SELECT 'a' LIKE ?1;", "%" + "a".repeat(49) + "%").toArray()),
				likeAcentos: error(() => sql.exec("SELECT 'a' LIKE ?1;", "%" + "á".repeat(25) + "%").toArray()),
				union5: error(() => sql.exec(Array.from({ length: 5 }, (_, i) => `SELECT ${i}`).join(" UNION ALL ")).toArray()),
				union6: error(() => sql.exec(Array.from({ length: 6 }, (_, i) => `SELECT ${i}`).join(" UNION ALL ")).toArray()),
				valuesMultifila200: error(() =>
					sql.exec("SELECT COUNT(*) FROM (VALUES " + Array.from({ length: 200 }, (_, i) => `(${i})`).join(", ") + ");").toArray(),
				),
				sentencia99k: error(() => sql.exec(`SELECT '${"a".repeat(99_000)}' AS x;`).toArray()),
				sentencia101k: error(() => sql.exec(`SELECT '${"a".repeat(101_000)}' AS x;`).toArray()),
				// Más de 100 marcas sin numerar, y un valor de varios megas en un parámetro.
				params101SinNumerar: error(() =>
					sql.exec(`SELECT 1 WHERE 'x' NOT IN (${Array.from({ length: 101 }, () => "?").join(", ")});`, ...valores(101)).toArray(),
				),
				valor1MB: error(() => sql.exec("SELECT length(?1) AS n;", "a".repeat(1_000_000)).toArray()),
				valor2MB: error(() => sql.exec("SELECT length(?1) AS n;", "a".repeat(2_000_000)).toArray()),
				valor2MiBYUnByte: error(() => sql.exec("SELECT length(?1) AS n;", "a".repeat(2 * 1024 * 1024 + 1)).toArray()),
				valor3MB: error(() => sql.exec("SELECT length(?1) AS n;", "a".repeat(3_000_000)).toArray()),
				valor9MB: error(() => sql.exec("SELECT length(?1) AS n;", "a".repeat(9_000_000)).toArray()),
				userVersion: error(() => sql.exec("PRAGMA user_version;").toArray()),
				beginTransaction: error(() => sql.exec("BEGIN TRANSACTION;")),
			};
		});
		informe.limites = res;
		expect(res.params100).toBeNull();
		expect(res.params101).not.toBeNull();
		expect(res.jsonEach1000).toBeNull();
	});

	it("un texto con varias sentencias las ejecuta todas, y un PRAGMA de las de detrás cambia la conexión", async () => {
		// Por qué en el DO no entra un texto que no sea de aquí: el `SELECT` de delante hace que parezca
		// una lectura, el `PRAGMA` no escribe ninguna fila, y la conexión se queda sin comprobar los
		// `CHECK` para todo lo que venga después en este objeto.
		const res = await enElHub("sonda-varias-sentencias", (hub) => {
			const { sql } = hub.state.storage;
			sql.exec("CREATE TABLE T (ID TEXT PRIMARY KEY, N INTEGER NOT NULL CHECK (N > 0));");
			const antes = error(() => sql.exec("INSERT INTO T VALUES ('a', 0);"));
			const cursor = sql.exec("SELECT 1 AS uno; PRAGMA ignore_check_constraints = ON;");
			const filas = cursor.toArray();
			const escritas = cursor.rowsWritten;
			const despues = error(() => sql.exec("INSERT INTO T VALUES ('b', 0);"));
			sql.exec("PRAGMA ignore_check_constraints = OFF;");
			const restaurado = error(() => sql.exec("INSERT INTO T VALUES ('c', 0);"));
			return { antes, filas, escritas, despues, restaurado, n: contar(sql, "T") };
		});
		informe.variasSentencias = res;
		expect(res.antes).toMatch(/CHECK constraint failed/);
		// Lo que devuelve es de la última sentencia, que no da filas ni escribe ninguna.
		expect(res.filas).toEqual([]);
		expect(res.escritas).toBe(0);
		// Y el `CHECK` ha dejado de comprobarse.
		expect(res.despues).toBeNull();
		expect(res.restaurado).toMatch(/CHECK constraint failed/);
		expect(res.n).toBe(1);
	});

	it("los mensajes de error acaban en su código, y llevan los nombres que traía la sentencia", async () => {
		// De lo que depende la clasificación de `tenantHub.errores.ts`: el código va al final, y el
		// texto de delante lo escribe en parte quien escribió la sentencia.
		const res = await enElHub("sonda-mensajes-de-error", (hub) => {
			const { sql } = hub.state.storage;
			sql.exec("CREATE TABLE T (ID TEXT PRIMARY KEY, N INTEGER NOT NULL CHECK (N > 0));");
			sql.exec("CREATE TABLE H (ID TEXT PRIMARY KEY, P TEXT REFERENCES T(ID));");
			sql.exec("INSERT INTO T VALUES ('a', 1);");
			return {
				unica: error(() => sql.exec("INSERT INTO T VALUES ('a', 2);")),
				nula: error(() => sql.exec("INSERT INTO T VALUES ('b', NULL);")),
				check: error(() => sql.exec("INSERT INTO T VALUES ('b', 0);")),
				foranea: error(() => sql.exec("INSERT INTO H VALUES ('h', 'no-existe');")),
				tipo: error(() => sql.exec("INSERT INTO T (rowid, ID, N) VALUES ('no', 'z', 1);")),
				columna: error(() => sql.exec("SELECT sqlite_full FROM T;").toArray()),
				tabla: error(() => sql.exec("SELECT 1 FROM sqlite_busy;").toArray()),
				entreComillas: error(() => sql.exec(`SELECT 1 FROM "database is locked";`).toArray()),
			};
		});
		informe.mensajesDeError = res;
		expect(res).toEqual({
			unica: "UNIQUE constraint failed: T.ID: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
			nula: "NOT NULL constraint failed: T.N: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)",
			check: "CHECK constraint failed: N > 0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
			foranea: "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
			tipo: "datatype mismatch: SQLITE_MISMATCH",
			columna: "no such column: sqlite_full at offset 7: SQLITE_ERROR",
			tabla: "no such table: sqlite_busy: SQLITE_ERROR",
			entreComillas: "no such table: database is locked: SQLITE_ERROR",
		});
	});
});

describe("jurisdicción", () => {
	it("el subespacio eu existe en local y da otro id para el mismo nombre", () => {
		const ns = (env as any).TenantHub as DurableObjectNamespace;
		let eu: string | null = null;
		let err: string | null = null;
		try {
			eu = ns.jurisdiction("eu").idFromName("negocio-1").toString();
		} catch (e) {
			err = String((e as Error)?.message ?? e);
		}
		const normal = ns.idFromName("negocio-1").toString();
		informe.jurisdiccion = { normal, eu, err, distintos: eu !== null && eu !== normal };
	});
});

/**
 * La sonda de volumen tarda minuto y medio: no va en la suite. Para lanzarla, `true` aquí y
 * `pnpm exec vitest run test/sondaSqliteDo.test.ts -t volumen` (el informe sale como fallo).
 */
const SONDA_DE_VOLUMEN = false;

describe("volumen y tiempos", () => {
	it.runIf(SONDA_DE_VOLUMEN)("medio año de un restaurante con mucho movimiento", { timeout: 600_000 }, async () => {
		const COMANDAS = 50_000;
		const LINEAS_POR_COMANDA = 5;
		const res = await enElHub("sonda-volumen", (hub) => {
			const st = hub.state.storage;
			const { sql } = st;
			const t = () => performance.now();
			const tiempos: Record<string, number> = {};
			const medir = <T>(clave: string, fn: () => T): T => {
				const t0 = Date.now();
				const r = fn();
				tiempos[clave] = Date.now() - t0;
				return r;
			};
			void t;

			medir("esquema_ms", () => crearEsquemaTenant(sql));

			// Una comanda y sus líneas: lo que escribe un cobro típico, para ver las filas que se facturan.
			const tipico = st.transactionSync(() => {
				const c = sql.exec(
					"INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura) VALUES ('tipica', 'BARRA', '2026-11-11 10:00:00');",
				);
				const l = sql.exec(
					"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent) VALUES ('tipica-1', 'tipica', NULL, 'Café', 1, 150, 10);",
				);
				return { comanda: c.rowsWritten, linea: l.rowsWritten };
			});

			medir("carga_ms", () => {
				const LOTE = 2_000;
				for (let base = 0; base < COMANDAS; base += LOTE) {
					st.transactionSync(() => {
						for (let i = base; i < Math.min(base + LOTE, COMANDAS); i++) {
							const dia = new Date(Date.UTC(2026, 4, 1) + Math.floor(i / 275) * 86_400_000);
							const fecha = dia.toISOString().slice(0, 10) + ` ${String(12 + (i % 10)).padStart(2, "0")}:30:00`;
							const id = `c-${i}`;
							sql.exec(
								"INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado) VALUES (?1, 'BARRA', ?2, ?2, 0, 'Pagada');",
								id,
								fecha,
							);
							for (let j = 0; j < LINEAS_POR_COMANDA; j++) {
								sql.exec(
									"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent, Estado_Cocina, Fecha_Hora_Cocina) VALUES (?1, ?2, ?3, ?4, ?5, 10, 'PREPARADO', ?6);",
									`${id}-${j}`,
									id,
									`Producto ${(i * 7 + j) % 120}`,
									1 + (j % 3),
									150 + ((i + j) % 40) * 25,
									fecha,
								);
							}
						}
					});
				}
			});

			const tamano = Number(sql.databaseSize);

			const lineasDeUnaComanda = medir("lineas_de_una_comanda_ms", () =>
				sql.exec("SELECT * FROM Detalle_Comanda WHERE ID_Comanda = 'c-25000';").toArray().length,
			);

			const ventasMes = medir("ventas_por_dia_un_mes_ms", () =>
				sql
					.exec(
						`SELECT substr(c.Fecha_Hora_Apertura, 1, 10) AS dia,
						        SUM(CAST(ROUND(d.Cantidad * d.Precio_Unitario) AS INTEGER)) AS importe
						   FROM Comandas c JOIN Detalle_Comanda d ON d.ID_Comanda = c.ID_Comanda
						  WHERE c.Fecha_Hora_Apertura >= '2026-08-01' AND c.Fecha_Hora_Apertura < '2026-09-01'
						  GROUP BY dia;`,
					)
					.toArray().length,
			);

			const ventasTodo = medir("ventas_por_dia_todo_ms", () =>
				sql
					.exec(
						`SELECT substr(c.Fecha_Hora_Apertura, 1, 10) AS dia,
						        SUM(CAST(ROUND(d.Cantidad * d.Precio_Unitario) AS INTEGER)) AS importe
						   FROM Comandas c JOIN Detalle_Comanda d ON d.ID_Comanda = c.ID_Comanda
						  GROUP BY dia;`,
					)
					.toArray().length,
			);

			const topProductos = medir("top_productos_todo_ms", () =>
				sql
					.exec(
						`SELECT Nombre_Producto, SUM(Cantidad) AS uds
						   FROM Detalle_Comanda GROUP BY Nombre_Producto ORDER BY uds DESC LIMIT 10;`,
					)
					.toArray().length,
			);

			const volcado = medir("leer_todas_las_lineas_ms", () => {
				const filas = sql.exec("SELECT * FROM Detalle_Comanda;").toArray();
				return { filas: filas.length, bytesJson: JSON.stringify(filas).length };
			});

			const fkCheckLineas = medir("foreign_key_check_detalle_ms", () =>
				sql.exec("PRAGMA foreign_key_check(Detalle_Comanda);").toArray().length,
			);
			const fkCheckTodo = medir("foreign_key_check_todo_ms", () =>
				sql.exec("PRAGMA foreign_key_check;").toArray().length,
			);

			return {
				comandas: COMANDAS,
				lineas: COMANDAS * LINEAS_POR_COMANDA,
				tamanoMB: Math.round((tamano / 1_048_576) * 10) / 10,
				filasEscritasCobroTipico: tipico,
				lineasDeUnaComanda,
				ventasMes,
				ventasTodo,
				topProductos,
				volcado,
				fkCheckLineas,
				fkCheckTodo,
				tiempos,
			};
		});
		informe.volumen = res;
		// Vitest no enseña la consola de un test que pasa: el informe sale como fallo a propósito.
		throw new Error("INFORME_VOLUMEN " + JSON.stringify(res));
	});
});
