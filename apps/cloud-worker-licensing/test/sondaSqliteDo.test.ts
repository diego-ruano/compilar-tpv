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
				userVersion: error(() => sql.exec("PRAGMA user_version;").toArray()),
				beginTransaction: error(() => sql.exec("BEGIN TRANSACTION;")),
			};
		});
		informe.limites = res;
		expect(res.params100).toBeNull();
		expect(res.params101).not.toBeNull();
		expect(res.jsonEach1000).toBeNull();
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
