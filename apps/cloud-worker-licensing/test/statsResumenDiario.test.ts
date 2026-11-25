// test/statsResumenDiario.test.ts
//
// Las estadísticas de productos y de mesas leen del resumen diario los días ya cerrados
// (`domains/stats/resumenDiario.ts`, §17 de `0001_inicial.sql`) y tienen que dar EXACTAMENTE lo que
// daban las sentencias que recorrían los cobros, que se conservan aquí como referencia: la de
// productos en una pasada y las cuatro de mesas.
//
// Las siembras son las de los casos de contrato, en el SQLite de un Durable Object. Las de
// `stats/productos_semana` y `stats/mesas_semana` traen además `cambios`: tandas de escrituras que
// se aplican una detrás de otra (anular, cambiar la fecha de un cobro, cobrar otra parte de una
// línea, borrar un producto o una comanda, cambiar una comanda de mesa…). Tras cada tanda:
//
// 1. todo día del resumen que no esté apuntado como sucio coincide con lo que sale de los cobros: si
//    no, a un cambio le falta su trigger;
// 2. las dos estadísticas, en los cuatro rangos, dan lo mismo que las de antes;
// 3. se rehace todo lo sucio, para que la tanda siguiente vuelva a mirar todos los días.
//
// La Main hace lo mismo con su propia copia (`tests_resumen_diario` en
// `tpv-infra-sqlite/src/stats.rs`), y el arnés de lectura fija que los dos lados dan lo mismo.

import type { Base } from "../src/lib/sql";
import { describe, expect, it } from "vitest";

import casoMesas from "../../../tests/contract/lecturas/casos/stats/mesas.json";
import casoMesasSemana from "../../../tests/contract/lecturas/casos/stats/mesas_semana.json";
import casoNombreId from "../../../tests/contract/lecturas/casos/stats/productos_nombre_que_es_un_id.json";
import casoProductosSemana from "../../../tests/contract/lecturas/casos/stats/productos_semana.json";
import casoVendidos from "../../../tests/contract/lecturas/casos/stats/productos_vendidos.json";

import { mesasDeAntes, productosDeAntes } from "./helpers/estadisticasDeAntes";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import {
	anotarResumen,
	coincideElDia,
	contrastarUnDia,
	esEscrituraDelResumen,
	recalcularDia,
	sentenciasDeRecalculo,
} from "../src/domains/stats/resumenDiario";
import {
	mesas,
	mesasCon,
	productos,
	productosCon,
	sqlMesaTopComandas,
	sqlMesasIngresos,
	sqlMesasServicios,
	sqlMesasTopIngresos,
	sqlProductos,
} from "../src/domains/stats/stats.queries";
import type { StatsRange } from "../src/domains/stats/stats.schemas";

// ── La comparación ───────────────────────────────────────────────────────────────────────────────

const RANGOS: StatsRange[] = ["hoy", "semana", "mes", "anio"];

/** Sin filtro, y con filtros que dejan dentro y fuera productos vendidos. */
const FILTROS: [string | null, string | null][] = [
	[null, null],
	["cat-platos", "cat-bebidas"],
	["cat-bebidas", "cat-platos"],
	["cat-materia", "cat-que-no-existe"],
];

type Caso = { seed: string[]; cambios?: string[][] };

const CASOS: [string, Caso][] = [
	["productos_semana", casoProductosSemana as Caso],
	["mesas_semana", casoMesasSemana as Caso],
	["productos_vendidos", casoVendidos as Caso],
	["productos_nombre_que_es_un_id", casoNombreId as Caso],
	["mesas", casoMesas as Caso],
];

async function daLoMismoQueAntes(db: Base, etiqueta: string): Promise<void> {
	for (const range of RANGOS) {
		const antesMesas = await mesasCon(db, mesasDeAntes(range));
		// Primero sin rehacer los días sucios: lo que lee alguien a quien se le ha colado un cobro
		// entre rehacerlos y leer. Esos días se leen de los cobros, no del resumen.
		const sinRehacer = await mesasCon(db, {
			ingresos: sqlMesasIngresos(range),
			topComandas: sqlMesaTopComandas(range),
			servicios: sqlMesasServicios(range),
			topIngresos: sqlMesasTopIngresos(range),
		});
		expect(sinRehacer, `${etiqueta}: mesas sin rehacer los días sucios, ${range}`).toEqual(antesMesas);
		for (const [top, worst] of FILTROS) {
			const antes = await productosCon(db, productosDeAntes(range), top, worst);
			expect(
				await productosCon(db, sqlProductos(range), top, worst),
				`${etiqueta}: productos sin rehacer los días sucios, ${range}, top ${top}, peores ${worst}`,
			).toEqual(antes);
		}
		expect(await mesas(db, range), `${etiqueta}: mesas, ${range}`).toEqual(antesMesas);
		for (const [top, worst] of FILTROS) {
			const antes = await productosCon(db, productosDeAntes(range), top, worst);
			expect(
				await productos(db, range, top, worst),
				`${etiqueta}: productos, ${range}, top ${top}, peores ${worst}`,
			).toEqual(antes);
		}
	}
}

/** Todo día resumido que no esté apuntado como sucio coincide con lo que sale de los cobros. */
async function loNoApuntadoSigueValiendo(db: Base, sql: any, etiqueta: string): Promise<void> {
	const dias = sql
		.exec(
			`SELECT dia FROM (
				SELECT substr(Fecha_Hora, 1, 10) AS dia FROM Pagos
				UNION SELECT Dia FROM _Estad_Producto_Dia
				UNION SELECT Dia FROM _Estad_Mesa_Dia
			) WHERE dia NOT IN (SELECT Dia FROM _Estad_Dias_Sucios) ORDER BY dia;`,
		)
		.toArray()
		.map((f: any) => String(f.dia));
	for (const dia of dias) {
		expect(await coincideElDia(db, dia), `${etiqueta}: el resumen del ${dia} ya no vale y nadie lo apuntó`).toBe(true);
	}
}

async function rehacerTodo(db: Base, sql: any): Promise<void> {
	const sucios = sql.exec("SELECT Dia AS dia FROM _Estad_Dias_Sucios;").toArray();
	for (const f of sucios) await recalcularDia(db, String(f.dia));
	expect(Number(sql.exec("SELECT COUNT(*) AS n FROM _Estad_Dias_Sucios;").one().n)).toBe(0);
}

/** La base de un negocio en el SQLite de un Durable Object, con la siembra de un caso. */
function conLaSiembra<R>(nombre: string, siembra: string[], prueba: (db: Base, sql: any) => Promise<R>) {
	return enElHub(`stats-resumen-${nombre}`, async (hub: any) => {
		const storage = hub.state.storage;
		crearEsquemaTenant(storage.sql);
		for (const sentencia of siembra) storage.sql.exec(sentencia);
		return prueba(clienteLocal(storage), storage.sql);
	});
}

describe("las estadísticas leen del resumen diario y dan lo mismo que recorriendo los cobros", () => {
	for (const [nombre, caso] of CASOS) {
		it(`${nombre}: tras la siembra y tras cada tanda de cambios`, async () => {
			await conLaSiembra(nombre, caso.seed, async (db, sql) => {
				await daLoMismoQueAntes(db, `${nombre}, siembra`);
				await rehacerTodo(db, sql);
				await loNoApuntadoSigueValiendo(db, sql, `${nombre}, siembra`);

				for (const [i, tanda] of (caso.cambios ?? []).entries()) {
					const etiqueta = `${nombre}, tanda ${i + 1}`;
					for (const sentencia of tanda) sql.exec(sentencia);
					await loNoApuntadoSigueValiendo(db, sql, etiqueta);
					await daLoMismoQueAntes(db, etiqueta);
					await rehacerTodo(db, sql);
				}
			});
		});
	}

	it("un cobro futuro no hace aparecer el mes de hoy en la gráfica del año", async () => {
		// Revisión de Codex (segunda pasada): una comanda cobrada el último día del mes pasado y otra
		// vez después de ahora, y nada más. Su fila sin importe de hoy suma a las comandas del rango,
		// pero no puede sacar en la gráfica del año el mes de hoy, que no tiene cobros. (En enero el
		// mes pasado es del año anterior y no hay nada que comparar.) La misma siembra, en
		// `tests_resumen_diario` de `stats.rs`.
		const siembra = [
			"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z', 'Sala');",
			"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1', 'z', '1', 4, 0, 0, 'rect', 120, 70);",
			"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'MESA', 'm1', datetime('now','localtime','start of month','-1 day','+12 hours'), 'Pagada');",
			"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p1', 'c1', datetime('now','localtime','start of month','-1 day','+12 hours'), 'Efectivo', 500, 'parcial');",
			"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p2', 'c1', datetime('now','localtime','+1 day'), 'Efectivo', 500, 'parcial');",
		];
		await conLaSiembra("cobro-futuro-mes-pasado", siembra, (db) =>
			daLoMismoQueAntes(db, "cobro futuro de una comanda del mes pasado"),
		);
	});

	it("las siembras con cambios tienen días cerrados en la semana y cambios de sobra", async () => {
		// Si dejaran de tenerlos, la comparación de arriba pasaría sin leer nada del resumen.
		for (const [nombre, caso] of [
			["productos_semana", casoProductosSemana as Caso],
			["mesas_semana", casoMesasSemana as Caso],
		] as const) {
			await conLaSiembra(`${nombre}-ejercita`, caso.seed, async (db, sql) => {
				await mesas(db, "semana");
				const dias = sql
					.exec(
						`SELECT (SELECT COUNT(DISTINCT Dia) FROM _Estad_Producto_Dia WHERE Dia >= date('now','localtime','-6 days'))
							+ (SELECT COUNT(DISTINCT Dia) FROM _Estad_Mesa_Dia WHERE Dia >= date('now','localtime','-6 days')) AS n;`,
					)
					.one().n;
				expect(Number(dias), nombre).toBeGreaterThanOrEqual(4);
				expect(caso.cambios?.length ?? 0, nombre).toBeGreaterThanOrEqual(8);
			});
		}
	});

	it("el vigía ve un día resumido que no cuadra con los cobros y lo rehace", async () => {
		await conLaSiembra("vigia", casoProductosSemana.seed, async (db, sql) => {
			await mesas(db, "semana");
			const ayer = "date('now','localtime','-1 day')";
			// Con el rango en un solo día cerrado, el día al azar es ése.
			expect(await contrastarUnDia(db, ayer)).toBeNull();

			// Lo que haría un cambio sin su trigger: el resumen de ayer deja de valer sin que nadie lo apunte.
			sql.exec(`UPDATE _Estad_Producto_Dia SET Milesimas = Milesimas + 1 WHERE Dia = ${ayer};`);
			const dia = sql.exec(`SELECT ${ayer} AS d;`).one().d;
			expect(await coincideElDia(db, dia)).toBe(false);
			expect(await contrastarUnDia(db, ayer)).toBe(dia);
			expect(await coincideElDia(db, dia)).toBe(true);

			// Con su marca puesta no es un descuadre (un cobro que acaba de entrar, con su trigger): se
			// mira en la misma sentencia que compara (revisión de Codex, tercera pasada).
			sql.exec(`UPDATE _Estad_Producto_Dia SET Milesimas = Milesimas + 1 WHERE Dia = ${ayer};`);
			sql.exec(`INSERT INTO _Estad_Dias_Sucios (Dia) VALUES (${ayer});`);
			expect(await coincideElDia(db, dia)).toBe(true);
		});
	});

	it("con el resumen al día, la lectura de un año no recorre los cobros de antes de hoy", async () => {
		await conLaSiembra("plan", casoProductosSemana.seed, async (db, sql) => {
			await productos(db, "anio", null, null);
			const plan = (texto: string) =>
				sql
					.exec(`EXPLAIN QUERY PLAN ${texto}`)
					.toArray()
					.map((f: any) => String(f.detail));
			for (const [nombre, texto, cobros, resumen] of [
				[
					"productos",
					sqlProductos("anio"),
					"SEARCH p USING INDEX idx_pagos_estado_fecha (Estado=? AND Fecha_Hora>? AND Fecha_Hora<?)",
					"SEARCH e USING INDEX idx_estad_producto_dia (Dia>? AND Dia<?)",
				],
				[
					"mesas",
					sqlMesasIngresos("anio"),
					"SEARCH p USING INDEX idx_pagos_fecha (Fecha_Hora>? AND Fecha_Hora<?)",
					"SEARCH e USING PRIMARY KEY (Dia>? AND Dia<?)",
				],
			] as const) {
				const pasos = plan(texto);
				// Los días cerrados, por el resumen; los cobros, sólo los de hoy y los de los días sucios,
				// por su fecha. Nada recorre el histórico, tampoco un acceso a los cobros sólo por su
				// estado, que los leería todos (la sentencia compartida fija el orden con `CROSS JOIN`).
				expect(pasos, `${nombre}: ${pasos.join(" | ")}`).toContain(resumen);
				expect(pasos, `${nombre}: ${pasos.join(" | ")}`).toContain(cobros);
				expect(pasos.filter((l: string) => /^SCAN (p|pd|dc|c|e)( |$)/.test(l)), nombre).toEqual([]);
				expect(pasos.filter((l: string) => l.endsWith("(Estado=?)")), nombre).toEqual([]);
			}
		});
	});
});

describe("el resumen sólo escribe en sus propias tablas", () => {
	// Se escribe sin pasar por el motor (ni log, ni difusión), dentro del TenantHub y con el cliente de
	// al lado. No hay una puerta que mire qué se escribe por ahí, así que lo mira quien escribe
	// (`anotarResumen`): una sentencia del negocio que se colara cambiaría la nube sin que la Main lo
	// viera nunca.
	const DIA = "2026-03-02";
	const SIEMBRA = [
		"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');",
		"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 10, 10);",
		"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'MESA', 'm1', '2026-03-02 12:00:00', 'Pagada');",
		"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p1', 'c1', '2026-03-02 13:00:00', 'Efectivo', 900, 'total');",
	];

	it("un día se rehace con el cliente del TenantHub, todo o nada, y un lote con algo del negocio no entra", async () => {
		await enElHub("stats-resumen-solo-sus-tablas", async (hub: any) => {
			const storage = hub.state.storage;
			crearEsquemaTenant(storage.sql);
			for (const sentencia of SIEMBRA) storage.sql.exec(sentencia);
			const db = clienteLocal(storage);

			await recalcularDia(db, DIA);
			expect(Number(storage.sql.exec("SELECT COUNT(*) AS n FROM _Estad_Dias_Sucios;").one().n)).toBe(0);
			expect(storage.sql.exec("SELECT ID_Mesa, Importe, Comandas FROM _Estad_Mesa_Dia;").toArray()).toEqual([
				{ ID_Mesa: "m1", Importe: 900, Comandas: 1 },
			]);

			// Con una sentencia del negocio detrás no se ejecuta ninguna: ni se rehace el día (su
			// trigger lo ha apuntado) ni se toca Zonas.
			storage.sql.exec("UPDATE Pagos SET Importe_Total = 1000 WHERE ID_Pago = 'p1';");
			const conIntrusa = [...sentenciasDeRecalculo(DIA), { sql: "DELETE FROM Zonas;", args: [] }];
			await expect(anotarResumen(db, conIntrusa)).rejects.toThrow(/sólo escribe en sus propias tablas/);
			expect(storage.sql.exec("SELECT Nombre_Zona AS z FROM Zonas;").toArray()).toEqual([{ z: "Sala" }]);
			expect(storage.sql.exec("SELECT Importe FROM _Estad_Mesa_Dia;").one().Importe).toBe(900);
			expect(storage.sql.exec("SELECT Dia FROM _Estad_Dias_Sucios;").toArray()).toEqual([{ Dia: DIA }]);
		});
	});

	it("reconoce lo que escribe en el resumen, y nada más", () => {
		for (const { sql } of sentenciasDeRecalculo(DIA)) expect(esEscrituraDelResumen(sql), sql).toBe(true);
		for (const ajena of [
			"DELETE FROM Zonas;",
			"INSERT INTO Pagos (ID_Pago) VALUES ('x');",
			"DELETE FROM _Estad_Dias_Sucios; DELETE FROM Zonas;",
			"WITH x AS (SELECT 1) DELETE FROM Zonas;",
			"INSERT OR REPLACE INTO _Estad_Dias_Sucios (Dia) VALUES ('2026-03-02');",
			"DELETE FROM _Estad_Producto_Dia_De_Otro WHERE 1;",
		]) {
			expect(esEscrituraDelResumen(ajena), ajena).toBe(false);
		}
	});
});
