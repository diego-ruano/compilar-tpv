// test/syncVentanaPlan.test.ts
//
// Lo que CUESTA cada sentencia de la ventana de la fase 1 (`bootstrap.ventana.ts`).
//
// `syncVentana.test.ts` fija qué filas entran; aquí se fija que traerlas no cueste el cuadrado de lo
// que hay. `Pago_Detalles` y `Devolucion_Lineas` tienen la clave `(ID_Pago, ID_Detalle)` y su
// predicado pide las dos columnas por lista: escrito tal cual, SQLite sondea el índice de la clave
// con cada pago y cada línea de la ventana. Las filas que salen son las mismas, así que ningún test
// de alcance lo ve; lo que se ve es un volcado que tarda trece segundos por sentencia con tres días
// de un bar con mucho movimiento, el día que ese bar ha perdido su base.
//
// Todo se mide dentro del SQLite del Durable Object, que es donde corre en producción: el plan con
// `EXPLAIN QUERY PLAN` y el coste con `rowsRead`, las filas que el cursor ha leído. El reloj no
// sirve: en workerd no avanza mientras el código no espera a nada.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import {
	esTablaDeNegocio,
	esTransaccional,
	sentenciaConteo,
	sentenciaVolcado,
} from "../src/domains/sync/bootstrap.ventana";

const DESDE = "2026-06-01 00:00:00";
const DENTRO = "2026-06-10 12:00:00";
const FUERA = "2026-01-10 12:00:00";

type Paso = { id: number; parent: number; detail: string };
type Sentencia = { sql: string; args: string[] };

function plan(sql: any, s: Sentencia): Paso[] {
	return sql.exec(`EXPLAIN QUERY PLAN ${s.sql}`, ...s.args).toArray() as Paso[];
}

/**
 * Los pasos de un plan que sondean un índice con dos listas a la vez: una búsqueda con dos o más
 * igualdades (`A=? AND B=?`) que cuelga del mismo nodo que dos o más `LIST SUBQUERY`. Cada lista da
 * un valor a una columna, así que el índice se sondea con el producto de las dos.
 */
function sondeosCruzados(pasos: Paso[]): string[] {
	return pasos
		.filter((p) => p.detail.startsWith("SEARCH "))
		.filter((p) => (p.detail.match(/=\?/g) ?? []).length >= 2)
		.filter(
			(p) =>
				pasos.filter((q) => q.parent === p.parent && q.detail.startsWith("LIST SUBQUERY"))
					.length >= 2,
		)
		.map((p) => p.detail);
}

/** La sentencia de antes: la misma, con `ID_Detalle` dentro del índice de la clave. */
function sinElMas(s: Sentencia): Sentencia {
	const sql = s.sql.replace("AND +ID_Detalle IN", "AND ID_Detalle IN");
	expect(sql, "la sentencia ya no lleva el `+` que este test quita").not.toBe(s.sql);
	return { sql, args: s.args };
}

function tablasDeNegocio(sql: any): string[] {
	return sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;")
		.toArray()
		.map((r: any) => String(r.name))
		.filter(esTablaDeNegocio);
}

/** Las dos sentencias que la fase 1 y la verificación ejecutan por tabla. */
function sentenciasDe(tabla: string): Array<[string, Sentencia]> {
	return [
		[`${tabla} · volcado`, sentenciaVolcado(tabla, DESDE)],
		[`${tabla} · conteo`, sentenciaConteo(tabla, DESDE)],
	];
}

const DE_DOS_LISTAS = ["Pago_Detalles", "Devolucion_Lineas"];

describe("la ventana de la fase 1 · el plan", () => {
	it("ninguna sentencia sondea un índice con dos listas a la vez", async () => {
		const cruzados = await enElHub("ventana-plan-todas", (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const tablas = tablasDeNegocio(sql);
			// Si la lista saliera vacía, el test pasaría sin mirar nada.
			expect(tablas.filter(esTransaccional).length).toBeGreaterThan(10);
			return tablas
				.flatMap(sentenciasDe)
				.flatMap(([nombre, s]) => sondeosCruzados(plan(sql, s)).map((d) => `${nombre}: ${d}`));
		});

		// Si esto falla con una tabla nueva: su predicado pide dos columnas del mismo índice por
		// lista. Deja una de las dos fuera del índice con un `+` delante (`+Columna IN (…)`), como
		// `Pago_Detalles`: la comparación es la misma y el plan pasa a ser lineal.
		expect(cruzados).toEqual([]);
	});

	it("sin el `+`, el plan de las dos tablas de clave (pago, línea) es el cruzado", async () => {
		// El detector tiene que ver el plan que se viene a evitar; si dejara de verlo (otro
		// planificador, otro texto en el plan), el test de arriba pasaría sin vigilar nada.
		const cruzados = await enElHub("ventana-plan-antes", (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			return DE_DOS_LISTAS.flatMap(sentenciasDe).map(
				([nombre, s]) => [nombre, sondeosCruzados(plan(sql, sinElMas(s))).length] as const,
			);
		});

		expect(cruzados).toHaveLength(4);
		for (const [nombre, n] of cruzados) expect(n, nombre).toBe(1);
	});
});

describe("la ventana de la fase 1 · las mismas filas que antes", () => {
	it("con el `+` y sin él salen las mismas filas, también con un pago y una línea de comandas distintas", async () => {
		const r = await enElHub("ventana-plan-equivalencia", (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);

			const comanda = (id: string, fecha: string, estado: string) =>
				sql.exec(
					`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
					 VALUES (?, 'BARRA', ?, ?, ?);`,
					id,
					fecha,
					estado === "Pagada" ? fecha : null,
					estado,
				);
			const linea = (id: string, idComanda: string) =>
				sql.exec(
					`INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario)
					 VALUES (?, ?, 'Caña', 2, 250);`,
					id,
					idComanda,
				);
			const pago = (id: string, idComanda: string, fecha: string) =>
				sql.exec(
					`INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
					 VALUES (?, ?, ?, 'Efectivo', 500, 'TOTAL');`,
					id,
					idComanda,
					fecha,
				);
			const devolucion = (id: string, idComanda: string, idOrigen: string, fecha: string) =>
				sql.exec(
					`INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
					                    ID_Pago_Origen, Motivo_Devolucion)
					 VALUES (?, ?, ?, 'Efectivo', -250, 'DEVOLUCION', ?, 'Estaba caliente');`,
					id,
					idComanda,
					fecha,
					idOrigen,
				);
			const cobrada = (idPago: string, idDetalle: string) =>
				sql.exec("INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES (?, ?);", idPago, idDetalle);
			const devuelta = (idPago: string, idDetalle: string) =>
				sql.exec(
					"INSERT INTO Devolucion_Lineas (ID_Pago, ID_Detalle, Cantidad, Importe) VALUES (?, ?, 1, 250);",
					idPago,
					idDetalle,
				);

			// Dentro de la ventana, con dos líneas y una devolución.
			comanda("c-dentro", DENTRO, "Pagada");
			linea("d-dentro-1", "c-dentro");
			linea("d-dentro-2", "c-dentro");
			pago("p-dentro", "c-dentro", DENTRO);
			cobrada("p-dentro", "d-dentro-1");
			cobrada("p-dentro", "d-dentro-2");
			devolucion("dev-dentro", "c-dentro", "p-dentro", DENTRO);
			devuelta("dev-dentro", "d-dentro-1");

			// Fuera: cerrada y cobrada antes de la ventana.
			comanda("c-fuera", FUERA, "Pagada");
			linea("d-fuera", "c-fuera");
			pago("p-fuera", "c-fuera", FUERA);
			cobrada("p-fuera", "d-fuera");
			devolucion("dev-fuera", "c-fuera", "p-fuera", FUERA);
			devuelta("dev-fuera", "d-fuera");

			// Antigua pero abierta: entra entera, con el cobro parcial que ya tiene.
			comanda("c-abierta", FUERA, "Abierta");
			linea("d-abierta", "c-abierta");
			pago("p-abierta", "c-abierta", FUERA);
			cobrada("p-abierta", "d-abierta");

			// Lo que el predicado existe para dejar fuera: filas con un solo lado en la ventana. La
			// aplicación no las escribe (pago y línea son de la misma comanda), pero es justo lo que
			// distingue pedir las dos columnas de pedir una.
			cobrada("p-dentro", "d-fuera");
			cobrada("p-fuera", "d-dentro-1");
			devuelta("dev-dentro", "d-fuera");
			devuelta("dev-fuera", "d-dentro-2");

			const filas = (s: Sentencia) =>
				(sql.exec(s.sql, ...s.args).toArray() as any[])
					.map((f) => JSON.stringify(f))
					.sort();

			return DE_DOS_LISTAS.map((tabla) => {
				const volcado = sentenciaVolcado(tabla, DESDE);
				const conteo = sentenciaConteo(tabla, DESDE);
				return {
					tabla,
					ahora: filas(volcado),
					antes: filas(sinElMas(volcado)),
					conteoAhora: filas(conteo),
					conteoAntes: filas(sinElMas(conteo)),
				};
			});
		});

		for (const t of r) {
			expect(t.ahora, t.tabla).toEqual(t.antes);
			expect(t.conteoAhora, t.tabla).toEqual(t.conteoAntes);
			expect(t.conteoAhora, t.tabla).toEqual([JSON.stringify({ n: t.ahora.length })]);
		}
		const claves = (tabla: string) =>
			r
				.find((t) => t.tabla === tabla)!
				.ahora.map((f) => JSON.parse(f))
				.map((f) => `${f.ID_Pago}/${f.ID_Detalle}`)
				.sort();
		expect(claves("Pago_Detalles")).toEqual([
			"p-abierta/d-abierta",
			"p-dentro/d-dentro-1",
			"p-dentro/d-dentro-2",
		]);
		expect(claves("Devolucion_Lineas")).toEqual(["dev-dentro/d-dentro-1"]);
	});
});

describe("la ventana de la fase 1 · el coste con volumen", () => {
	// Un día y medio de un bar de mil comandas diarias, todo dentro de la ventana: 1.500 comandas de
	// tres líneas, cobradas, y una devolución cada tres.
	const COMANDAS = 1_500;
	const LINEAS = COMANDAS * 3;
	const DEVOLUCIONES = COMANDAS / 3;
	const FILAS_SEMBRADAS = COMANDAS + LINEAS + COMANDAS + DEVOLUCIONES + LINEAS + DEVOLUCIONES;
	// Lo que puede leer una sentencia: unas pocas veces lo que hay. El plan cruzado lee, sólo en
	// `Pago_Detalles`, más de 2.000 pagos × 4.500 líneas: nueve millones.
	const TECHO_DE_LECTURAS = FILAS_SEMBRADAS * 10;

	function sembrar(sql: any): void {
		const serie = (n: number) =>
			`WITH RECURSIVE serie(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM serie WHERE i < ${n})`;
		sql.exec(
			`${serie(COMANDAS)}
			 INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
			 SELECT 'c-' || i, 'BARRA', ?1, ?1, 'Pagada' FROM serie;`,
			DENTRO,
		);
		sql.exec(
			`${serie(LINEAS)}
			 INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario)
			 SELECT 'd-' || i, 'c-' || ((i - 1) / 3 + 1), 'Caña', 1, 250 FROM serie;`,
		);
		sql.exec(
			`${serie(COMANDAS)}
			 INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
			 SELECT 'p-' || i, 'c-' || i, ?1, 'Efectivo', 750, 'TOTAL' FROM serie;`,
			DENTRO,
		);
		sql.exec(
			`${serie(LINEAS)}
			 INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle)
			 SELECT 'p-' || ((i - 1) / 3 + 1), 'd-' || i FROM serie;`,
		);
		sql.exec(
			`${serie(DEVOLUCIONES)}
			 INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
			                    ID_Pago_Origen, Motivo_Devolucion)
			 SELECT 'dev-' || i, 'c-' || (i * 3), ?1, 'Efectivo', -250, 'DEVOLUCION', 'p-' || (i * 3), 'Devuelto'
			   FROM serie;`,
			DENTRO,
		);
		sql.exec(
			`${serie(DEVOLUCIONES)}
			 INSERT INTO Devolucion_Lineas (ID_Pago, ID_Detalle, Cantidad, Importe)
			 SELECT 'dev-' || i, 'd-' || (i * 9), 1, 250 FROM serie;`,
		);
	}

	it("cada sentencia lee unas pocas veces lo que hay, no el producto de pagos por líneas", async () => {
		const lecturas = await enElHub("ventana-plan-volumen", (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrar(sql);
			return tablasDeNegocio(sql)
				.filter(esTransaccional)
				.flatMap(sentenciasDe)
				.map(([nombre, s]) => {
					const cursor = sql.exec(s.sql, ...s.args);
					const filas = cursor.toArray() as any[];
					return { nombre, filas: filas.length, n: filas[0]?.n, leidas: Number(cursor.rowsRead) };
				});
		});

		const de = (nombre: string) => lecturas.find((l) => l.nombre === nombre)!;
		// Lo sembrado está entero dentro de la ventana y sale entero.
		expect(de("Pago_Detalles · volcado").filas).toBe(LINEAS);
		expect(de("Pago_Detalles · conteo").n).toBe(LINEAS);
		expect(de("Devolucion_Lineas · volcado").filas).toBe(DEVOLUCIONES);
		expect(de("Devolucion_Lineas · conteo").n).toBe(DEVOLUCIONES);
		expect(de("Pagos · volcado").filas).toBe(COMANDAS + DEVOLUCIONES);

		for (const l of lecturas) {
			expect(l.leidas, `${l.nombre} leyó ${l.leidas} filas`).toBeLessThan(TECHO_DE_LECTURAS);
		}
	});
});
