// test/syncVolcado.test.ts
//
// El techo en bytes de los volcados de sync (`domains/sync/volcado.ts`): `/v1/sync/bootstrap` e
// `/historico`.
//
// El tope de filas no acota lo que ocupa una respuesta: una fila puede ser una línea de ticket o un
// registro de facturación entero. Lo que se fija aquí es que el volcado para de escribir al pasar de
// `VOLCADO_MAX_BYTES` y que cada ruta contesta entonces lo que la Main ya sabe leer: el 413 de la
// fase 1 y una página más corta, con su cursor, en el histórico.
//
// El tope de verdad son 24 MiB; aquí se pone en 64 KiB para no sembrar un mes de un bar.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { pedirEnElHub } from "./helpers/volcadoEnElHub";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));


vi.mock("../src/domains/sync/volcado", async (original) => ({
	...(await (original as any)()),
	VOLCADO_MAX_BYTES: 64 * 1024,
	HISTORICO_MAX_BYTES: 64 * 1024,
}));

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "d1");
		await next();
	},
	soloLaMain: () => async (_c: any, next: any) => next(),
}));

const { bytesUtf8 } = await import("../src/lib/texto");
const { Escritor, VOLCADO_MAX_BYTES, HISTORICO_MAX_BYTES, escribirTablas, lectorDe, lectorDelHub, siguiente } =
	await import("../src/domains/sync/volcado");
const { syncRoutes, paginaDelHistorico, volcarFase1, BOOTSTRAP_MAX_FILAS } =
	await import("../src/domains/sync/sync.routes");

/** Una petición a la ruta, dentro del TenantHub, y además lo que ocupó la respuesta. */
async function conTenant<R>(
	nombre: string,
	sembrar: (sql: any) => void,
	usar: (
		pedir: (ruta: string, cuerpo?: unknown) => Promise<{ status: number; body: any; bytes: number }>,
		sql: any,
	) => Promise<R>,
): Promise<R> {
	return enElHub(`volcado-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sembrar(sql);

		const app = new Hono();
		app.route("/", syncRoutes);
		const pedir = async (ruta: string, cuerpo?: unknown) => {
			const r = await pedirEnElHub(
				() =>
					app.request(
						ruta,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
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

/** `n` clientes con una nota larga: una tabla maestra, que viaja entera, de unos 250 bytes por fila. */
function sembrarClientes(sql: any, n: number): void {
	const nota = "No le pongas hielo. ".repeat(10);
	for (let i = 0; i < n; i++) {
		sql.exec(
			"INSERT INTO Clientes (ID_Cliente, Nombre, Notas) VALUES (?, ?, ?);",
			`cl-${String(i).padStart(5, "0")}`,
			`Cliente ${i}`,
			nota,
		);
	}
}

/** `n` comandas de barra antiguas: histórico que sólo baja por la fase 2. */
function sembrarComandas(sql: any, n: number): void {
	for (let i = 0; i < n; i++) {
		sql.exec(
			`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
			 VALUES (?, 'BARRA', '2020-01-01 12:00:00', '2020-01-01 13:00:00', 'Pagada');`,
			`c-${String(i).padStart(5, "0")}`,
		);
	}
}

function sembrarSeq(sql: any, n: number): void {
	for (let i = 1; i <= n; i++) {
		sql.exec(
			"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES (?, '[]', ?);",
			`op-${i}`,
			i,
		);
	}
}

describe("el lector del TenantHub", () => {
	it("fuera del TenantHub de su negocio no lee: la ruta no lleva alHub", async () => {
		// Como `tenantQuery`: no hay otro sitio del que leer la base del negocio.
		const c = { env: {} as any, get: () => "t1", req: { header: () => undefined } };
		await expect(lectorDe(c).foto([{ sql: "SELECT 1;", args: [] }], () => 1)).rejects.toThrow("falta alHub");
	});

	it("no deja ninguna sentencia a medias, aunque quien lee no termine un resultado", async () => {
		await enElHub("volcado-lector-agota", async (hub: any) => {
			const sql = hub.state.storage.sql;
			for (const tabla of ["Prueba_Uno", "Prueba_Dos"]) {
				sql.exec(`CREATE TABLE ${tabla} (a INTEGER);`);
				sql.exec(`INSERT INTO ${tabla} (a) VALUES (1), (2), (3), (4);`);
			}

			// Por qué importa: un cursor a medias deja su sentencia abierta, y con ella su lectura.
			// Aquí se ve en que la tabla no se puede tocar hasta que el cursor se agota.
			const aMedias = sql.exec("SELECT a FROM Prueba_Uno ORDER BY a;").raw();
			expect(aMedias.next().value).toEqual([1]);
			expect(() => sql.exec("DROP TABLE Prueba_Uno;")).toThrow(/locked/);
			while (!aMedias.next().done);

			// Por el lector, quien lee se queda con la primera fila de cada resultado, como hace con
			// un `COUNT` o con un volcado que para al pasar del tope.
			const primeras = await lectorDelHub(sql).foto(
				[
					{ sql: "SELECT a FROM Prueba_Uno ORDER BY a;", args: [] },
					{ sql: "SELECT a FROM Prueba_Dos ORDER BY a;", args: [] },
				],
				(rs: Iterator<any>) => [
					siguiente(rs).filas[Symbol.iterator]().next().value,
					siguiente(rs).filas[Symbol.iterator]().next().value,
				],
			);
			expect(primeras).toEqual([[1], [1]]);
			// Las dos sentencias han terminado: ni la primera, que quedó a medias al pedir la
			// segunda, ni la última, que quedó a medias al acabar la foto.
			sql.exec("DROP TABLE Prueba_Uno;");
			sql.exec("DROP TABLE Prueba_Dos;");

			// Y también si quien lee revienta a mitad.
			sql.exec("CREATE TABLE Prueba_Tres (a INTEGER);");
			sql.exec("INSERT INTO Prueba_Tres (a) VALUES (1), (2);");
			await expect(
				lectorDelHub(sql).foto([{ sql: "SELECT a FROM Prueba_Tres;", args: [] }], (rs: Iterator<any>) => {
					siguiente(rs).filas[Symbol.iterator]().next();
					throw new Error("a mitad");
				}),
			).rejects.toThrow("a mitad");
			sql.exec("DROP TABLE Prueba_Tres;");
		});
	});
});

describe("el Escritor de un volcado", () => {
	const leer = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

	it("el tope se mide en bytes de UTF-8, no en caracteres", () => {
		// Cinco eñes son cinco caracteres y diez bytes.
		const justo = new Escritor(10);
		justo.texto("ñññññ");
		expect(justo.desbordado).toBe(false);
		expect(justo.cerrar()?.byteLength).toBe(10);

		// Seis ya no caben, y se sabe al escribirlas, sin esperar a codificar: son doce bytes.
		const pasado = new Escritor(10);
		pasado.texto("ññññññ");
		expect(pasado.ocupado).toBe(12);
		expect(pasado.desbordado).toBe(true);
		expect(pasado.cerrar()).toBeNull();
	});

	it("cuenta los bytes de un texto sin codificarlo, igual que el codificador", () => {
		const casos = [
			"",
			"abc",
			"ñ", // dos bytes
			"€", // tres
			"🍺", // cuatro, en dos unidades de UTF-16
			"caña 🍺 y tapa a 2,50 €",
			"\u0000\u007f\u0080\u07ff\u0800\uffff",
			// Lo que no puede salir de un `JSON.stringify`, pero el codificador lo cuenta igual: un
			// sustituto suelto se codifica como U+FFFD, tres bytes.
			"a\ud83cb",
			"\udc00",
			"\ud83c",
		];
		for (const texto of casos) {
			expect(bytesUtf8(texto), JSON.stringify(texto)).toBe(new TextEncoder().encode(texto).byteLength);
		}
	});

	it("avisa del desborde en cuanto lo escrito ya no puede caber", () => {
		const e = new Escritor(100);
		e.texto("a".repeat(100));
		expect(e.desbordado).toBe(false);
		e.texto("a");
		expect(e.desbordado).toBe(true);
		expect(e.cerrar()).toBeNull();
		// `todo` no mira el tope: es de quien ya decidió dónde parar.
		expect(e.todo().byteLength).toBe(101);
	});

	it("las tablas se dejan de escribir al pasar del tope de filas, aunque se contaran menos", () => {
		// Las filas se cuentan antes de leer, en otra foto: si entre medias entra una escritura, lo
		// que vale son las que hay al escribir.
		const dosTablas = () =>
			[
				{ columnas: ["a"], filas: [[1], [2]] },
				{ columnas: ["b"], filas: [[3], [4]] },
			][Symbol.iterator]();
		const sinTope = new Escritor(Number.MAX_SAFE_INTEGER);
		expect(escribirTablas(sinTope, ["Uno", "Dos"], dosTablas(), 4)).toBe(4);
		expect(leer(sinTope.cerrar())).toBe(
			'[{"nombre":"Uno","columnas":["a"],"filas":[[1],[2]]},{"nombre":"Dos","columnas":["b"],"filas":[[3],[4]]}]',
		);
		expect(escribirTablas(new Escritor(Number.MAX_SAFE_INTEGER), ["Uno", "Dos"], dosTablas(), 3)).toBeNull();
	});

	it("lo escrito sale entero y en orden, también con caracteres de varios bytes entre trozos", () => {
		// Cada parte es un texto completo, así que ningún carácter queda partido entre dos trozos.
		const partes = Array.from({ length: 3_000 }, (_, i) => JSON.stringify([i, "caña 🍺 y tapa", "añejo"]));
		const e = new Escritor(Number.MAX_SAFE_INTEGER);
		for (const p of partes) e.texto(p);
		const texto = partes.join("");
		expect(texto.length).toBeGreaterThan(64 * 1024);
		expect(leer(e.cerrar())).toBe(texto);
		expect(e.ocupado).toBe(new TextEncoder().encode(texto).byteLength);
	});
});

describe("POST /v1/sync/bootstrap · el tope en bytes", () => {
	it("lo que cabe se vuelca, con el nº de filas que viajan", async () => {
		await conTenant(
			"fase1-cabe",
			(sql) => sembrarClientes(sql, 20),
			async (pedir) => {
				const { status, body, bytes } = await pedir("/bootstrap");
				expect(status).toBe(200);
				expect(bytes).toBeLessThan(VOLCADO_MAX_BYTES);
				const filas = body.tablas.reduce((n: number, t: any) => n + t.filas.length, 0);
				expect(body.total_filas).toBe(filas);
				expect(body.tablas.find((t: any) => t.nombre === "Clientes").filas).toHaveLength(20);
			},
		);
	});

	it("lo que no cabe da el mismo 413 que el tope de filas", async () => {
		// Una tabla maestra viaja entera, así que no hay ventana que la encoja: 600 clientes son
		// 150 KB con un tope de 64.
		await conTenant(
			"fase1-no-cabe",
			(sql) => sembrarClientes(sql, 600),
			async (pedir) => {
				const { status, body } = await pedir("/bootstrap");
				// Es lo que lee la Main: el status y el `code` (`AppError::from_api_body`), y con ese
				// código la pantalla de recuperación dice que el volcado es demasiado grande.
				expect(status).toBe(413);
				expect(body).toMatchObject({
					ok: false,
					code: "bootstrap_too_large",
					error: "bootstrap_demasiado_grande",
					limite: BOOTSTRAP_MAX_FILAS,
					limiteBytes: VOLCADO_MAX_BYTES,
				});
				expect(body.totalFilas).toBeGreaterThanOrEqual(600);
			},
		);
	});

	it("el tope corta al escribir: ningún intento llega a escribir la tabla entera", async () => {
		const porFoto = await enElHub("volcado-fase1-corta", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			// 1.200 clientes con una nota larga (300 KB) y, detrás, 64 sin ella. Lo que ocupa una
			// tabla se mide con sus últimas filas, así que la medida previa da por bueno un volcado
			// que no cabe en 128 KB: quien lo para es el tope, al escribir.
			sembrarClientes(sql, 1_200);
			for (let i = 0; i < 64; i++) {
				sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES (?, 'Ana');", `cl-corto-${i}`);
			}

			// Un lector que cuenta las filas que le llegan a quien escribe, en cada foto.
			const porFoto: number[] = [];
			const real = lectorDelHub(sql);
			const contador = {
				foto: (sentencias: any, usar: any) =>
					real.foto(sentencias, (rs: Iterator<any>) => {
						let n = 0;
						const resultado = usar({
							next: () => {
								const r = rs.next();
								if (r.done) return r;
								const filas = r.value.filas;
								return {
									done: false,
									value: {
										columnas: r.value.columnas,
										filas: (function* () {
											for (const fila of filas) {
												n++;
												yield fila;
											}
										})(),
									},
								};
							},
						});
						porFoto.push(n);
						return resultado;
					}),
			};

			const r = await volcarFase1(contador as any, null, { filas: BOOTSTRAP_MAX_FILAS, bytes: 128 * 1024 });
			expect(r.cuerpo).toBeNull();
			return porFoto;
		});

		// Se llegó a intentar el volcado (una foto con cientos de filas, no sólo conteos y muestras)…
		expect(Math.max(...porFoto)).toBeGreaterThan(200);
		// …y todos los intentos dejaron de escribir dentro de `Clientes`, lejos de sus 1.264 filas.
		expect(Math.max(...porFoto)).toBeLessThan(800);
	});
});

describe("POST /v1/sync/historico · el tope en bytes", () => {
	it("una página se corta por tamaño y el recorrido sigue sin saltar ni repetir", async () => {
		// 1.500 comandas son unos 120 KB: con el tope en 64, la página de 2.000 filas que pide el
		// cliente no cabe entera.
		await conTenant(
			"historico-corta",
			(sql) => sembrarComandas(sql, 1_500),
			async (pedir) => {
				const vistas: string[] = [];
				const tamanos: number[] = [];
				let cursor: number | null = 0;
				let vueltas = 0;
				do {
					const { status, body, bytes } = await pedir("/historico", {
						tabla: "Comandas",
						cursor,
						limite: 2_000,
					});
					expect(status).toBe(200);
					const i = body.columnas.indexOf("ID_Comanda");
					vistas.push(...body.filas.map((f: any[]) => String(f[i])));
					tamanos.push(bytes);
					cursor = body.siguiente_cursor;
					vueltas++;
				} while (cursor !== null && vueltas < 20);

				// Más de una página, ninguna por encima del tope, y la tabla entera en su orden.
				expect(vueltas).toBeGreaterThan(1);
				expect(vueltas).toBeLessThan(20);
				for (const t of tamanos) expect(t).toBeLessThanOrEqual(HISTORICO_MAX_BYTES);
				expect(vistas).toHaveLength(1_500);
				expect(vistas).toEqual([...vistas].sort());
				expect(new Set(vistas).size).toBe(1_500);
			},
		);
	});

	it("el corte cuenta bytes, no caracteres: con texto que no es ASCII tampoco se pasa", async () => {
		// Un gasto con cien eñes son cien caracteres y doscientos bytes: contando caracteres, una
		// página podía salir casi el doble de grande que el tope.
		await enElHub("volcado-historico-bytes", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (let i = 0; i < 300; i++) {
				sql.exec(
					"INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto) VALUES (?, '2020-01-01', ?, 100, 'VARIOS');",
					`g-${String(i).padStart(3, "0")}`,
					"ñ".repeat(100),
				);
			}

			const TOPE = 20_000;
			for (const lector of [lectorDelHub(sql)]) {
				const vistas: string[] = [];
				let cursor: number | null = 0;
				let vueltas = 0;
				do {
					const bytes = await paginaDelHistorico(lector, { tabla: "Cuentas_Gastos", cursor, limite: 1_000 }, TOPE);
					expect(bytes.byteLength).toBeLessThanOrEqual(TOPE);
					const pagina: any = JSON.parse(new TextDecoder().decode(bytes));
					// Y se aprovecha: cada página que no es la última va casi llena.
					if (pagina.siguiente_cursor !== null) expect(bytes.byteLength).toBeGreaterThan(TOPE - 600);
					vistas.push(...pagina.filas.map((f: any[]) => String(f[0])));
					cursor = pagina.siguiente_cursor;
					vueltas++;
				} while (cursor !== null && vueltas < 50);

				expect(vistas).toHaveLength(300);
				expect(new Set(vistas).size).toBe(300);
			}
		});
	});

	it("una página lleva al menos una fila aunque esa fila sola pase del tope", async () => {
		// Con una página vacía y su cursor, el backfill pediría la misma para siempre.
		await enElHub("volcado-historico-una", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarComandas(sql, 3);

			for (const lector of [lectorDelHub(sql)]) {
				const vistas: string[] = [];
				let cursor: number | null = 0;
				let vueltas = 0;
				do {
					const pagina: any = JSON.parse(
						new TextDecoder().decode(
							await paginaDelHistorico(lector, { tabla: "Comandas", cursor, limite: 1_000 }, 1),
						),
					);
					// La última vuelta puede venir vacía: es la que dice que no queda nada.
					expect(pagina.filas.length).toBeLessThanOrEqual(1);
					vistas.push(...pagina.filas.map((f: any[]) => String(f[0])));
					cursor = pagina.siguiente_cursor;
					vueltas++;
				} while (cursor !== null && vueltas < 10);

				expect(vistas).toEqual(["c-00000", "c-00001", "c-00002"]);
			}
		});
	});
});
