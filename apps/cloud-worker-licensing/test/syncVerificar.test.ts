// test/syncVerificar.test.ts
//
// El contraste por resúmenes (`domains/sync/verificar.ts`): `/v1/sync/verificar/resumen`, `/filas`
// y `/claves`, contra el SQLite de un TenantHub de verdad, con la ruta dentro de él
// (`helpers/volcadoEnElHub.ts`).
//
// Lo que se fija:
//
// - el sobre del resumen lleva los nombres que deserializa Rust (`tpv-contracts/src/sync.rs`), y lo
//   que resume es lo que devuelve la sentencia que manda: quien la ejecute sobre las mismas filas
//   obtiene el mismo resumen;
// - una fila distinta, una de menos y una de más dejan sin cuadrar su cubo y ningún otro, y las
//   filas de ese cubo son las que devuelve `/filas`;
// - cuándo se aplaza: con el negocio escribiendo, o con cambios ajenos por encima del checkpoint de
//   quien pregunta;
// - los techos: las filas que lee un resumen, los bytes de una página de filas y de una de claves.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { pedirEnElHub } from "./helpers/volcadoEnElHub";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { ahoraDelCliente, antesDe } from "./helpers/horaDelCliente";

// «Ahora» del dispositivo que pregunta, y el comienzo de la ventana de 30 días que sale de él.
const AHORA = ahoraDelCliente();
const DESDE = antesDe(AHORA, 30 * 24);

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));


vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "d1");
		await next();
	},
	soloLaMain: () => async (_c: any, next: any) => next(),
}));

const { lectorDelHub } = await import("../src/domains/sync/volcado");
const { syncRoutes } = await import("../src/domains/sync/sync.routes");
const { Resumidor, cubosPara } = await import("../src/domains/sync/resumenCubos");
const { CALMA_PARA_RESUMIR_MS, filasDeLosCubos, filasPorClave, paginaDeClaves, resumenDeVerificacion } = await import(
	"../src/domains/sync/verificar"
);
const { CLAVES_POR_PAGINA_MAX } = await import("../src/domains/sync/sync.schemas");
const { sentenciaVolcado } = await import("../src/domains/sync/bootstrap.ventana");

type Pedir = (ruta: string, cuerpo?: unknown) => Promise<{ status: number; body: any; bytes: number }>;

/** Un TenantHub con su esquema, y una forma de pedirle una ruta. */
async function conTenant<R>(nombre: string, sembrar: (sql: any) => void, usar: (pedir: Pedir, sql: any) => Promise<R>): Promise<R> {
	return enElHub(`verificar-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sembrar(sql);

		const app = new Hono();
		app.route("/", syncRoutes);
		const pedir: Pedir = async (ruta, cuerpo) => {
			const r = await pedirEnElHub(
				() =>
					app.request(
						ruta,
						{
							method: "POST",
							headers: { "content-type": "application/json", "x-client-now": AHORA },
							body: JSON.stringify(cuerpo ?? {}),
						},
						{} as any,
					),
				sql,
			);
			return { ...r, bytes: new TextEncoder().encode(JSON.stringify(r.body)).byteLength };
		};
		return usar(pedir, sql);
	});
}

const HACE_UN_RATO = Date.now() - 60 * 60 * 1000;

/** `n` escrituras en el log, de `dispositivo`, hechas en `ms`. */
function sembrarLog(sql: any, n: number, dispositivo: string | null = "d1", ms: number = HACE_UN_RATO): void {
	for (let i = 0; i < n; i++) {
		sql.exec(
			"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Device_Id, Created_At_Ms) VALUES (?, '[]', ?, ?);",
			crypto.randomUUID(),
			dispositivo,
			ms,
		);
	}
}

function sembrarZonas(sql: any, n: number): void {
	for (let i = 0; i < n; i++) {
		sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?, ?);", `z-${String(i).padStart(4, "0")}`, `Zona ${i}`);
	}
}

/** Comandas de barra: las de ayer entran en la ventana; las de 2020, sólo en el conteo. */
function sembrarComandas(sql: any, recientes: number, antiguas: number): void {
	for (let i = 0; i < recientes; i++) {
		sql.exec(
			`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado, Total_Comanda)
			 VALUES (?, 'BARRA', ?, ?, 'Pagada', ?);`,
			`c-nueva-${String(i).padStart(4, "0")}`,
			antesDe(AHORA, 15),
			antesDe(AHORA, 14),
			1250 + i,
		);
	}
	for (let i = 0; i < antiguas; i++) {
		sql.exec(
			`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
			 VALUES (?, 'BARRA', '2020-01-01 12:00:00', '2020-01-01 13:00:00', 'Pagada');`,
			`c-vieja-${String(i).padStart(4, "0")}`,
		);
	}
}

/** Lo que haría la Main con una tabla del resumen: ejecutar su sentencia y resumir lo que devuelve. */
function resumirComoLaMain(sql: any, tabla: any): { filas: number; cuentas: number[]; sumas: string[] } {
	const cursor = sql.exec(tabla.sql, ...tabla.args);
	const columnas: string[] = cursor.columnNames;
	const posiciones = tabla.claves.map((k: string) => columnas.indexOf(k));
	const r = new Resumidor();
	for (const fila of cursor.raw()) r.fila(fila as unknown[], posiciones);
	const { cuentas, sumas } = r.resumen(tabla.cubos);
	return { filas: r.filas, cuentas, sumas };
}

const tablaDe = (body: any, nombre: string) => body.tablas.find((t: any) => t.nombre === nombre);

/** Los cubos de `a` que no cuadran con los de `b`. */
function cubosDistintos(a: any, b: any): number[] {
	expect(a.cubos).toBe(b.cubos);
	return a.cuentas.flatMap((n: number, i: number) => (n !== b.cuentas[i] || a.sumas[i] !== b.sumas[i] ? [i] : []));
}

describe("POST /v1/sync/verificar/resumen", () => {
	it("el sobre lleva los nombres que deserializa Rust, y resume lo que devuelve su sentencia", async () => {
		await conTenant(
			"resumen-sobre",
			(sql) => {
				sembrarZonas(sql, 70);
				sembrarComandas(sql, 12, 5);
				sembrarLog(sql, 4);
			},
			async (pedir, sql) => {
				const { status, body } = await pedir("/verificar/resumen", { checkpoint: 4 });
				expect(status).toBe(200);
				// `crates/tpv-contracts/src/sync.rs::ResumenNube`.
				expect(Object.keys(body).sort()).toEqual(
					["aplazar", "checkpoint", "desde", "hasta_seq", "ok", "tablas", "ventana_omitida"].sort(),
				);
				expect(body).toMatchObject({ ok: true, aplazar: false, checkpoint: 4, hasta_seq: 4, ventana_omitida: false });
				// 30 días antes de la hora de quien pregunta.
				expect(body.desde).toBe(DESDE);

				const zonas = tablaDe(body, "Zonas");
				expect(Object.keys(zonas).sort()).toEqual(
					["args", "claves", "columnas", "cubos", "cuentas", "filas", "nombre", "sql", "sumas", "total"].sort(),
				);
				// Una maestra viaja entera: su ventana es la tabla.
				expect(zonas).toMatchObject({ total: 70, filas: 70, claves: ["ID_Zona"], cubos: cubosPara(70), args: [] });
				expect(zonas.cubos).toBe(4);
				expect(zonas.columnas[0]).toBe("ID_Zona");
				expect(zonas.cuentas.reduce((a: number, b: number) => a + b, 0)).toBe(70);
				expect(zonas.sumas.every((s: string) => /^[0-9a-f]{16}$/.test(s))).toBe(true);

				// Una transaccional: el total es de la tabla entera y el resumen, de su ventana.
				const comandas = tablaDe(body, "Comandas");
				expect(comandas).toMatchObject({ total: 17, filas: 12, claves: ["ID_Comanda"], args: [body.desde] });
				// La sentencia es la de la ventana de la fase 1: una sola fuente.
				expect({ sql: comandas.sql, args: comandas.args }).toEqual(sentenciaVolcado("Comandas", body.desde));

				// Quien ejecute esas sentencias sobre las mismas filas obtiene los mismos resúmenes.
				for (const tabla of body.tablas) {
					expect(resumirComoLaMain(sql, tabla), tabla.nombre).toEqual({
						filas: tabla.filas,
						cuentas: tabla.cuentas,
						sumas: tabla.sumas,
					});
				}
			},
		);
	});

	it("un valor distinto, una fila de menos y una de más descuadran su cubo, y `/filas` trae sus filas", async () => {
		await conTenant(
			"resumen-divergencia",
			(sql) => {
				sembrarZonas(sql, 300);
				sembrarLog(sql, 1);
			},
			async (pedir, sql) => {
				const antes = tablaDe((await pedir("/verificar/resumen")).body, "Zonas");
				expect(antes.cubos).toBe(16);

				sql.exec("UPDATE Zonas SET Nombre_Zona = 'Terraza de la ría' WHERE ID_Zona = 'z-0007';");
				const trasCambiar = tablaDe((await pedir("/verificar/resumen")).body, "Zonas");
				const cambiados = cubosDistintos(antes, trasCambiar);
				expect(cambiados).toHaveLength(1);

				// Las filas de ese cubo, y sólo ésas: entre ellas, la que ha cambiado.
				const { status, body } = await pedir("/verificar/filas", {
					tabla: "Zonas",
					desde: DESDE,
					cubos: 16,
					pedir: cambiados,
				});
				expect(status).toBe(200);
				expect(Object.keys(body).sort()).toEqual(["columnas", "filas", "hasta_seq", "ok", "siguiente_cursor", "tabla"].sort());
				expect(body).toMatchObject({ ok: true, tabla: "Zonas", siguiente_cursor: null, hasta_seq: 1 });
				expect(body.filas).toHaveLength(trasCambiar.cuentas[cambiados[0]]);
				const nombre = body.columnas.indexOf("Nombre_Zona");
				expect(body.filas.filter((f: any[]) => f[nombre] === "Terraza de la ría")).toHaveLength(1);
				// Lo que viaja resume igual que el cubo del que sale.
				const r = new Resumidor();
				for (const fila of body.filas) r.fila(fila, [0]);
				const deLaPagina = r.resumen(16);
				expect(deLaPagina.sumas[cambiados[0]]).toBe(trasCambiar.sumas[cambiados[0]]);

				sql.exec("DELETE FROM Zonas WHERE ID_Zona = 'z-0100';");
				const trasBorrar = tablaDe((await pedir("/verificar/resumen")).body, "Zonas");
				expect(cubosDistintos(trasCambiar, trasBorrar)).toHaveLength(1);
				expect(trasBorrar.total).toBe(299);

				sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-nueva', 'Reservado');");
				const trasCrear = tablaDe((await pedir("/verificar/resumen")).body, "Zonas");
				expect(cubosDistintos(trasBorrar, trasCrear)).toHaveLength(1);
			},
		);
	});

	it("un número guardado como entero y como real resume igual; como texto, no", async () => {
		await conTenant(
			"resumen-numeros",
			(sql) => {
				// Sin afinidad: cada fila guarda el valor con la clase con la que llega.
				sql.exec("CREATE TABLE Prueba_Numeros (Id TEXT NOT NULL PRIMARY KEY, Valor);");
				sql.exec("INSERT INTO Prueba_Numeros VALUES ('a', 4), ('b', 2.5), ('c', NULL);");
				sembrarLog(sql, 1);
			},
			async (pedir, sql) => {
				const resumen = async () => tablaDe((await pedir("/verificar/resumen")).body, "Prueba_Numeros");
				const base = await resumen();
				expect(base).toMatchObject({ total: 3, filas: 3, cubos: 1 });

				sql.exec("UPDATE Prueba_Numeros SET Valor = 4.0 WHERE Id = 'a';");
				expect(sql.exec("SELECT typeof(Valor) AS t FROM Prueba_Numeros WHERE Id = 'a';").one().t).toBe("real");
				expect((await resumen()).sumas).toEqual(base.sumas);

				sql.exec("UPDATE Prueba_Numeros SET Valor = '2.50' WHERE Id = 'b';");
				expect((await resumen()).sumas).not.toEqual(base.sumas);
			},
		);
	});

	it("una tabla sin clave primaria se cuenta, pero no se resume", async () => {
		await conTenant(
			"resumen-sin-clave",
			(sql) => {
				sql.exec("CREATE TABLE Prueba_Sin_Clave (a TEXT, b INTEGER);");
				sql.exec("INSERT INTO Prueba_Sin_Clave VALUES ('x', 1), ('y', 2);");
			},
			async (pedir) => {
				const tabla = tablaDe((await pedir("/verificar/resumen")).body, "Prueba_Sin_Clave");
				expect(tabla).toMatchObject({ total: 2, filas: 2, claves: [], cubos: 1, cuentas: [0] });
			},
		);
	});

	it("con el negocio escribiendo se aplaza, y dice cuánto esperar", async () => {
		await conTenant(
			"resumen-actividad",
			(sql) => {
				sembrarZonas(sql, 3);
				sembrarLog(sql, 2);
				sembrarLog(sql, 1, "d1", Date.now() - 30_000);
			},
			async (pedir) => {
				const { status, body } = await pedir("/verificar/resumen", { checkpoint: 3 });
				expect(status).toBe(200);
				expect(body).toEqual({ ok: true, aplazar: true, motivo: "actividad", reintentar_en_s: 90, hasta_seq: 3 });
			},
		);
	});

	it("con cambios ajenos por encima del checkpoint de quien pregunta, se aplaza", async () => {
		await conTenant(
			"resumen-por-delante",
			(sql) => {
				sembrarZonas(sql, 3);
				sembrarLog(sql, 5, "d1");
				sembrarLog(sql, 1, "handy-1");
				sembrarLog(sql, 2, "d1");
			},
			async (pedir, sql) => {
				// El 6 es de una Handy: con el checkpoint en 5 todavía no lo ha aplicado.
				expect((await pedir("/verificar/resumen", { checkpoint: 5 })).body).toEqual({
					ok: true,
					aplazar: true,
					motivo: "por_delante",
					reintentar_en_s: 60,
					hasta_seq: 8,
				});
				// Con el checkpoint en 6, lo que queda por encima (7 y 8) es suyo: no le falta nada.
				const alDia = (await pedir("/verificar/resumen", { checkpoint: 6 })).body;
				expect(alDia).toMatchObject({ aplazar: false, checkpoint: 6, hasta_seq: 8 });

				// Lo que escribe la propia nube no lleva dispositivo, y también es ajeno.
				sembrarLog(sql, 1, null);
				expect((await pedir("/verificar/resumen", { checkpoint: 6 })).body.motivo).toBe("por_delante");

				// Quien no dice su checkpoint recibe el resumen, sin nada que lo avale.
				const sinCheckpoint = (await pedir("/verificar/resumen", {})).body;
				expect(sinCheckpoint).toMatchObject({ aplazar: false, checkpoint: null, hasta_seq: 9 });
				expect((await pedir("/verificar/resumen", { checkpoint: "9" })).body.checkpoint).toBeNull();
			},
		);
	});

	it("un checkpoint que no casa con el log se aplaza: por delante del final, o por debajo de lo purgado", async () => {
		await conTenant(
			"resumen-desfase",
			(sql) => {
				sembrarLog(sql, 10);
				// La purga se ha llevado los seis primeros.
				sql.exec("DELETE FROM Sync_Changes WHERE Seq <= 6;");
				sql.exec(
					"INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('_purgado_hasta', 6, 1);",
				);
			},
			async (pedir) => {
				expect((await pedir("/verificar/resumen", { checkpoint: 11 })).body).toMatchObject({ aplazar: true, motivo: "desfase" });
				expect((await pedir("/verificar/resumen", { checkpoint: 5 })).body).toMatchObject({ aplazar: true, motivo: "desfase" });
				expect((await pedir("/verificar/resumen", { checkpoint: 6 })).body).toMatchObject({ aplazar: false, hasta_seq: 10 });
			},
		);
	});

	it("si la ventana pasa de lo que se resume de una vez, se encoge; y si no cabe ni lo imprescindible, van los conteos", async () => {
		await enElHub("verificar-resumen-tope", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarZonas(sql, 20);
			// 40 comandas de hace tres semanas y 10 de ayer.
			for (let i = 0; i < 40; i++) {
				sql.exec(
					`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
					 VALUES (?, 'BARRA', ?, ?, 'Pagada');`,
					`c-octubre-${i}`,
					antesDe(AHORA, 21 * 24),
					antesDe(AHORA, 21 * 24 - 1),
				);
			}
			sembrarComandas(sql, 10, 0);
			const maestras = Number(
				sql.exec("SELECT COUNT(*) AS n FROM Zonas;").one().n,
			);
			expect(maestras).toBe(20);

			for (const lector of [lectorDelHub(sql)]) {
				const quien = { checkpoint: null, deviceId: "d1", clientNow: AHORA, ahoraMs: Date.now() };
				const leer = async (maxFilas: number) =>
					JSON.parse(new TextDecoder().decode(await resumenDeVerificacion(lector, quien, maxFilas)));

				const todo = await leer(1_000_000);
				const filasDe = (cuerpo: any) => cuerpo.tablas.reduce((n: number, t: any) => n + (t.filas ?? 0), 0);
				expect(todo).toMatchObject({ ventana_omitida: false, desde: DESDE });
				expect(tablaDe(todo, "Comandas").filas).toBe(50);

				// Con sitio para todo menos las 40 de hace tres semanas: la ventana de una semana.
				const semana = await leer(filasDe(todo) - 40);
				expect(semana).toMatchObject({ ventana_omitida: false, desde: antesDe(AHORA, 7 * 24) });
				expect(tablaDe(semana, "Comandas")).toMatchObject({ filas: 10, total: 50 });

				// Sin sitio ni para los maestros: sólo los conteos.
				const nada = await leer(5);
				expect(nada.ventana_omitida).toBe(true);
				expect(tablaDe(nada, "Comandas")).toEqual({ nombre: "Comandas", total: 50 });
				expect(tablaDe(nada, "Zonas")).toEqual({ nombre: "Zonas", total: 20 });
			}
		});
	});
});

describe("POST /v1/sync/verificar/filas", () => {
	it("una página se corta por tamaño y el recorrido sigue sin saltar ni repetir", async () => {
		await enElHub("verificar-filas-paginas", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarZonas(sql, 400);
			sembrarLog(sql, 3);

			for (const lector of [lectorDelHub(sql)]) {
				const pedido = { tabla: "Zonas", desde: DESDE, cubos: 4, pedir: [1, 3] };
				const vistas: string[] = [];
				let cursor = 0;
				let paginas = 0;
				for (;;) {
					const bytes = await filasDeLosCubos(lector, { ...pedido, cursor }, 3_000);
					const pagina = JSON.parse(new TextDecoder().decode(bytes));
					expect(bytes.byteLength).toBeLessThanOrEqual(3_000);
					expect(pagina.hasta_seq).toBe(3);
					expect(pagina.filas.length).toBeGreaterThan(0);
					vistas.push(...pagina.filas.map((f: any[]) => f[0]));
					paginas++;
					if (pagina.siguiente_cursor === null) break;
					expect(pagina.siguiente_cursor).toBeGreaterThan(cursor);
					cursor = pagina.siguiente_cursor;
				}
				expect(paginas).toBeGreaterThan(2);

				// Exactamente las filas de los cubos 1 y 3, una vez cada una.
				const r = new Resumidor();
				const esperadas: string[] = [];
				for (const fila of sql.exec("SELECT * FROM Zonas;").raw()) {
					const cubo = r.fila(fila as unknown[], [0]) >>> 6;
					if (cubo === 1 || cubo === 3) esperadas.push(String((fila as unknown[])[0]));
				}
				expect(vistas.sort()).toEqual(esperadas.sort());
				expect(new Set(vistas).size).toBe(vistas.length);
			}
		});
	});

	it("una página no recorre más filas de la ventana que su tope, aunque no lleve ninguna", async () => {
		await enElHub("verificar-filas-recorridas", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarZonas(sql, 100);
			const pedido = { tabla: "Zonas", desde: DESDE, cubos: 4, pedir: [2] };
			const vistas: string[] = [];
			let cursor = 0;
			let paginas = 0;
			for (;;) {
				const pagina = JSON.parse(
					new TextDecoder().decode(await filasDeLosCubos(lectorDelHub(sql), { ...pedido, cursor }, 1_000_000, 10)),
				);
				vistas.push(...pagina.filas.map((f: any[]) => f[0]));
				paginas++;
				if (pagina.siguiente_cursor === null) break;
				expect(pagina.siguiente_cursor).toBe(cursor + 10);
				cursor = pagina.siguiente_cursor;
			}
			expect(paginas).toBe(10);
			const r = new Resumidor();
			const esperadas = [...sql.exec("SELECT * FROM Zonas;").raw()].filter((f: any) => r.fila(f, [0]) >>> 6 === 2);
			expect(vistas.sort()).toEqual(esperadas.map((f: any) => f[0]).sort());
		});
	});

	it("una fila que sola pasa del tope viaja igual: la página no puede venir vacía", async () => {
		await enElHub("verificar-filas-gorda", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', ?);", "x".repeat(5_000));
			const pagina = JSON.parse(
				new TextDecoder().decode(
					await filasDeLosCubos(
						lectorDelHub(sql),
						{ tabla: "Zonas", desde: DESDE, cubos: 1, pedir: [0], cursor: 0 },
						1_000,
					),
				),
			);
			expect(pagina.filas).toHaveLength(1);
			expect(pagina.siguiente_cursor).toBeNull();
		});
	});

	it("sólo se pregunta por una tabla de negocio, y con un número de cubos que exista", async () => {
		await conTenant(
			"filas-validacion",
			(sql) => sembrarZonas(sql, 3),
			async (pedir) => {
				for (const tabla of ["_Sync_Outbox", "Sync_Changes", "Intentos_Login", 'Zonas"; DROP TABLE Zonas; --', "", 7]) {
					const { status, body } = await pedir("/verificar/filas", { tabla, desde: "", cubos: 1, pedir: [0] });
					expect(status, String(tabla)).toBe(400);
					expect(body).toMatchObject({ ok: false, code: "validation", error: "tabla_no_verificable" });
				}
				for (const cubos of [0, 3, 512, "16", null]) {
					const { status, body } = await pedir("/verificar/filas", { tabla: "Zonas", desde: "", cubos, pedir: [0] });
					expect(status, String(cubos)).toBe(400);
					expect(body.error).toBe("cubos_no_validos");
				}
				// Una tabla que este negocio no tiene (un esquema por detrás) no tiene filas que dar.
				const sinTabla = await pedir("/verificar/filas", { tabla: "Tabla_Que_No_Existe", desde: "", cubos: 1, pedir: [0] });
				expect(sinTabla).toMatchObject({ status: 200, body: { ok: true, columnas: [], filas: [], siguiente_cursor: null } });
				// Lo que no es un cubo de la tabla no pide nada, y un cuerpo vacío no rompe nada.
				const sinPedir = await pedir("/verificar/filas", { tabla: "Zonas", desde: "", cubos: 4, pedir: [-1, 4, "0", 1.5] });
				expect(sinPedir.body).toMatchObject({ ok: true, filas: [], siguiente_cursor: null });
				expect((await pedir("/verificar/filas", {})).status).toBe(400);
			},
		);
	});
});

describe("POST /v1/sync/verificar/por-clave", () => {
	it("trae las filas de esas claves, estén o no en la ventana, y la que no está no viene", async () => {
		await conTenant(
			"por-clave",
			(sql) => {
				sembrarComandas(sql, 3, 3);
				sembrarLog(sql, 2);
			},
			async (pedir) => {
				const { status, body } = await pedir("/verificar/por-clave", {
					tabla: "Comandas",
					claves: [["c-nueva-0001"], ["c-vieja-0002"], ["c-que-no-esta"]],
				});
				expect(status).toBe(200);
				expect(Object.keys(body).sort()).toEqual(["columnas", "cortada", "filas", "hasta_seq", "ok", "tabla"].sort());
				expect(body).toMatchObject({ ok: true, tabla: "Comandas", cortada: false, hasta_seq: 2 });
				expect(body.filas.map((f: any[]) => f[0]).sort()).toEqual(["c-nueva-0001", "c-vieja-0002"]);
				expect(body.columnas[0]).toBe("ID_Comanda");
				const muchas = await pedir("/verificar/por-clave", {
					tabla: "Comandas",
					claves: Array.from({ length: 500 }, (_, i) => [`c-vieja-${String(i).padStart(4, "0")}`]),
				});
				expect(muchas).toMatchObject({ status: 200, body: { cortada: false } });
				expect(muchas.body.filas).toHaveLength(3);

				// Sin claves, nada; con una que no es de la tabla, 400.
				expect((await pedir("/verificar/por-clave", { tabla: "Comandas", claves: [] })).body).toMatchObject({ filas: [] });
				for (const claves of [[["a", "b"]], [[null]], [[{}]], ["c-nueva-0001"]]) {
					const r = await pedir("/verificar/por-clave", { tabla: "Comandas", claves });
					expect(r.status, JSON.stringify(claves)).toBe(400);
					expect(r.body.error).toBe("claves_no_validas");
				}
				expect((await pedir("/verificar/por-clave", { tabla: "_Sync_Outbox", claves: [["x"]] })).status).toBe(400);
			},
		);
	});

	it("una clave compuesta, y una respuesta que no cabe se corta y lo dice", async () => {
		await enElHub("verificar-por-clave-compuesta", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec("CREATE TABLE Prueba_Compuesta (A TEXT NOT NULL, B INTEGER NOT NULL, C TEXT, PRIMARY KEY (A, B));");
			for (let b = 1; b <= 30; b++) sql.exec("INSERT INTO Prueba_Compuesta VALUES ('x', ?, ?);", b, "c".repeat(100));
			const leer = async (claves: unknown[][], maxBytes?: number) =>
				JSON.parse(new TextDecoder().decode((await filasPorClave(lectorDelHub(sql), { tabla: "Prueba_Compuesta", claves }, maxBytes))!));

			const dos = await leer([["x", 3], ["x", 7], ["y", 3]]);
			expect(dos.filas.map((f: any[]) => f[1]).sort()).toEqual([3, 7]);
			expect(dos.cortada).toBe(false);

			// Una tanda de la Main son 500 claves; el SQLite del DO no admite más de cien parámetros.
			const muchas = await leer(Array.from({ length: 500 }, (_, i) => ["x", i + 1]));
			expect(muchas.filas).toHaveLength(30);

			const todas = Array.from({ length: 30 }, (_, i) => ["x", i + 1]);
			const bytes = await filasPorClave(lectorDelHub(sql), { tabla: "Prueba_Compuesta", claves: todas }, 1_500);
			const cortada = JSON.parse(new TextDecoder().decode(bytes!));
			expect(bytes!.byteLength).toBeLessThanOrEqual(1_500);
			expect(cortada.cortada).toBe(true);
			expect(cortada.filas.length).toBeGreaterThan(0);
			expect(cortada.filas.length).toBeLessThan(30);
		});
	});
});

describe("POST /v1/sync/verificar/claves", () => {
	it("una página con claves largas no pasa de sus bytes, contando el cursor que repite la última", async () => {
		await enElHub("verificar-claves-largas", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (let i = 0; i < 20; i++) {
				sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?, ?);", `${String(i).padStart(2, "0")}${"k".repeat(300)}`, `Zona ${i}`);
			}
			const bytes = await paginaDeClaves(lectorDelHub(sql), { tabla: "Zonas", cursor: null, limite: 100 }, 2_000);
			const pagina = JSON.parse(new TextDecoder().decode(bytes!));
			expect(bytes!.byteLength).toBeLessThanOrEqual(2_000);
			expect(pagina.siguiente_cursor).toEqual(pagina.claves[pagina.claves.length - 1]);
		});
	});

	it("las claves van por páginas y en orden, sin saltar ni repetir", async () => {
		await conTenant(
			"claves-paginas",
			(sql) => {
				sembrarZonas(sql, 25);
				sembrarLog(sql, 2);
			},
			async (pedir) => {
				const vistas: string[] = [];
				let cursor: unknown[] | null = null;
				let paginas = 0;
				for (;;) {
					const { status, body } = await pedir("/verificar/claves", { tabla: "Zonas", cursor, limite: 10 });
					expect(status).toBe(200);
					expect(Object.keys(body).sort()).toEqual(["claves", "columnas", "hasta_seq", "ok", "siguiente_cursor", "tabla"].sort());
					expect(body).toMatchObject({ ok: true, tabla: "Zonas", columnas: ["ID_Zona"], hasta_seq: 2 });
					vistas.push(...body.claves.map((k: unknown[]) => String(k[0])));
					paginas++;
					if (body.siguiente_cursor === null) break;
					expect(body.siguiente_cursor).toEqual(body.claves[body.claves.length - 1]);
					cursor = body.siguiente_cursor;
				}
				expect(paginas).toBe(3);
				expect(vistas).toEqual(Array.from({ length: 25 }, (_, i) => `z-${String(i).padStart(4, "0")}`));
			},
		);
	});

	it("una clave compuesta se recorre entera, por su orden", async () => {
		await conTenant(
			"claves-compuesta",
			(sql) => {
				sql.exec("CREATE TABLE Prueba_Compuesta (A TEXT NOT NULL, B INTEGER NOT NULL, C TEXT, PRIMARY KEY (A, B));");
				for (const a of ["x", "y", "z"]) for (let b = 1; b <= 4; b++) sql.exec("INSERT INTO Prueba_Compuesta VALUES (?, ?, 'c');", a, b);
			},
			async (pedir) => {
				const vistas: unknown[][] = [];
				let cursor: unknown[] | null = null;
				for (;;) {
					const { body } = await pedir("/verificar/claves", { tabla: "Prueba_Compuesta", cursor, limite: 5 });
					expect(body.columnas).toEqual(["A", "B"]);
					vistas.push(...body.claves);
					if (body.siguiente_cursor === null) break;
					cursor = body.siguiente_cursor;
				}
				expect(vistas).toEqual(["x", "y", "z"].flatMap((a) => [1, 2, 3, 4].map((b) => [a, b])));

				// Un cursor que no es una clave de esa tabla no se enlaza.
				for (const malo of [["x"], ["x", 1, 2], ["x", null], [{}, 1]]) {
					const { status, body } = await pedir("/verificar/claves", { tabla: "Prueba_Compuesta", cursor: malo });
					expect(status, JSON.stringify(malo)).toBe(400);
					expect(body.error).toBe("cursor_no_valido");
				}
			},
		);
	});

	it("una página no pasa de sus bytes, y el límite lo pone el servidor", async () => {
		await enElHub("verificar-claves-bytes", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarZonas(sql, 200);
			for (const lector of [lectorDelHub(sql)]) {
				const bytes = await paginaDeClaves(lector, { tabla: "Zonas", cursor: null, limite: 200 }, 2_000);
				expect(bytes).not.toBeNull();
				const pagina = JSON.parse(new TextDecoder().decode(bytes!));
				expect(bytes!.byteLength).toBeLessThanOrEqual(2_000);
				expect(pagina.claves.length).toBeGreaterThan(10);
				expect(pagina.claves.length).toBeLessThan(200);
				expect(pagina.siguiente_cursor).toEqual(pagina.claves[pagina.claves.length - 1]);
			}
		});

		await conTenant(
			"claves-limite",
			(sql) => sembrarZonas(sql, 3),
			async (pedir) => {
				const { body } = await pedir("/verificar/claves", { tabla: "Zonas", limite: 10_000_000 });
				expect(body.claves).toHaveLength(3);
				expect(body.siguiente_cursor).toBeNull();
				expect(CLAVES_POR_PAGINA_MAX).toBe(20_000);
				// Una tabla sin clave primaria no tiene nada que listar; una que no es de negocio no se lista.
				expect((await pedir("/verificar/claves", { tabla: "_Sync_Outbox" })).status).toBe(400);
			},
		);
	});

	it("la calma que se exige para resumir son dos minutos", () => {
		expect(CALMA_PARA_RESUMIR_MS).toBe(120_000);
	});
});
