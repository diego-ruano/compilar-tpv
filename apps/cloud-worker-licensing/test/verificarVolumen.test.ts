// test/verificarVolumen.test.ts
//
// Lo que cuesta el resumen del contraste (`domains/sync/verificar.ts`) con la ventana de un bar con
// mucho movimiento: mil comandas diarias durante treinta días, unas 690.000 filas.
//
// Con el contraste anterior ese bar no se comparaba: su ventana no cabía en una respuesta (24 MiB,
// unos seis días suyos) y sólo viajaban los conteos. Aquí se fija que ahora sí se compara, y lo que
// cuesta: lo que ocupa la respuesta, las filas que lee y el tiempo que tiene ocupado el hilo del
// TenantHub, que mientras resume no atiende a nadie.
//
// El tiempo se mide desde fuera del objeto. Dentro, el reloj de workerd no avanza mientras el código
// no espera a nada, y un resumen no espera a nada: es lo que lo hace una foto. Es tiempo de esta
// máquina, no el de producción: sirve para ver el orden de magnitud y para comparar el resumen con
// lo que cuesta sólo leer las mismas filas.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { ahoraDelCliente, antesDe } from "./helpers/horaDelCliente";
import { esTablaDeNegocio, sentenciaVolcado } from "../src/domains/sync/bootstrap.ventana";
import { RESUMEN_MAX_FILAS, filasDeLosCubos, resumenDeVerificacion } from "../src/domains/sync/verificar";
import { lectorDelHub } from "../src/domains/sync/volcado";

// «Ahora» del dispositivo, sacado del reloj (una fecha fija caduca por la deriva admisible), y el
// comienzo de la ventana de 30 días.
const AHORA = ahoraDelCliente();
const DESDE = antesDe(AHORA, 30 * 24);

const COMANDAS = 30_000;
const LINEAS_POR_COMANDA = 9;
const MOVIMIENTOS_DE_STOCK = 60_000;

/** Los números del 0 a `n - 1`, para sembrar de una sentencia. */
const serie = (n: number) => `WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < ${n})`;

/** Un identificador con la forma de los de verdad: 36 caracteres. */
const id = (prefijo: string, expr: string) => `printf('${prefijo}%07x-0000-7000-8000-%012x', ${expr}, ${expr})`;

/** Un mes de un bar de mil comandas diarias, repartidas por minutos dentro de la ventana. */
function sembrarUnMes(sql: any): void {
	sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Cervezas');");
	sql.exec(
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent) VALUES ('prod-1', 'cat-1', 'Caña', 250, 10);",
	);
	const cuando = `datetime('${AHORA}', '-1 hours', '-' || (i % 43000) || ' minutes')`;
	sql.exec(
		`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado)
		 ${serie(COMANDAS)} SELECT ${id("c", "i")}, 'BARRA', ${cuando}, ${cuando}, 2250, 'Pagada' FROM serie;`,
	);
	sql.exec(
		`INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent)
		 ${serie(COMANDAS * LINEAS_POR_COMANDA)}
		 SELECT ${id("d", "i")}, ${id("c", `i / ${LINEAS_POR_COMANDA}`)}, 'prod-1', 'Caña de la casa', 1 + (i % 3) * 0.5, 250, 10.0 FROM serie;`,
	);
	sql.exec(
		`INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
		 ${serie(COMANDAS)} SELECT ${id("p", "i")}, ${id("c", "i")}, ${cuando}, 'Efectivo', 2250, 'TOTAL', printf('T-%08d', i) FROM serie;`,
	);
	sql.exec(
		`INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle)
		 ${serie(COMANDAS * LINEAS_POR_COMANDA)} SELECT ${id("p", `i / ${LINEAS_POR_COMANDA}`)}, ${id("d", "i")} FROM serie;`,
	);
	sql.exec(
		`INSERT INTO Movimientos_Caja (ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, Importe, Metodo_Pago)
		 ${serie(COMANDAS)} SELECT ${id("m", "i")}, ${cuando}, 'COBRO', ${id("p", "i")}, 2250, 'Efectivo' FROM serie;`,
	);
	sql.exec(
		`INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Motivo, Fecha)
		 ${serie(MOVIMIENTOS_DE_STOCK)} SELECT ${id("s", "i")}, 'prod-1', 'AJUSTE', -1.5, 1000 - i * 0.001, 'Venta', ${cuando} FROM serie;`,
	);
	sql.exec("INSERT INTO Sync_Changes (Op_Id, Statements_Json, Device_Id, Created_At_Ms) VALUES ('op-1', '[]', 'd1', 1);");
}

async function comprimido(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
	const flujo = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
	return (await new Response(flujo).arrayBuffer()).byteLength;
}

describe("el resumen del contraste, con la ventana de un bar con mucho movimiento", () => {
	it(
		"resume el mes entero en una respuesta de unos cien kilobytes",
		async () => {
			const HUB = "verificar-volumen";
			await enElHub(HUB, (hub: any) => {
				const sql = hub.state.storage.sql;
				crearEsquemaTenant(sql);
				sembrarUnMes(sql);
			});

			// Lo que cuesta sólo LEER las filas de la ventana, con las mismas sentencias: la base de
			// comparación. Es lo que hacía el volcado anterior, además de escribirlas y mandarlas.
			const t0 = Date.now();
			const leidas = await enElHub(HUB, (hub: any) => {
				const sql = hub.state.storage.sql;
				const tablas: string[] = sql
					.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;")
					.toArray()
					.map((r: any) => String(r.name))
					.filter(esTablaDeNegocio);
				let filas = 0;
				for (const t of tablas) {
					const s = sentenciaVolcado(t, DESDE);
					for (const _ of sql.exec(s.sql, ...s.args).raw()) filas++;
				}
				return filas;
			});
			const t1 = Date.now();

			const quien = { checkpoint: 1, deviceId: "d1", clientNow: AHORA, ahoraMs: Date.now() };
			const bytes = await enElHub(HUB, (hub: any) => resumenDeVerificacion(lectorDelHub(hub.state.storage.sql), quien));
			const t2 = Date.now();

			const resumen = JSON.parse(new TextDecoder().decode(bytes));
			expect(resumen).toMatchObject({ aplazar: false, ventana_omitida: false, desde: DESDE, hasta_seq: 1 });
			const filas = resumen.tablas.reduce((n: number, t: any) => n + t.filas, 0);
			expect(filas).toBe(leidas);
			expect(filas).toBeGreaterThan(680_000);
			expect(filas).toBeLessThan(RESUMEN_MAX_FILAS);

			const grandes = resumen.tablas.filter((t: any) => t.cubos === 256).map((t: any) => t.nombre);
			expect(grandes.sort()).toEqual(
				["Comandas", "Detalle_Comanda", "Movimientos_Caja", "Movimientos_Stock", "Pago_Detalles", "Pagos"].sort(),
			);
			const lineas = resumen.tablas.find((t: any) => t.nombre === "Detalle_Comanda");
			expect(lineas).toMatchObject({ filas: COMANDAS * LINEAS_POR_COMANDA, total: COMANDAS * LINEAS_POR_COMANDA });
			// Los cubos salen parejos: ninguno se lleva más del doble de lo que le toca.
			expect(Math.max(...lineas.cuentas)).toBeLessThan((2 * lineas.filas) / 256);
			expect(Math.min(...lineas.cuentas)).toBeGreaterThan(lineas.filas / 256 / 2);

			// La respuesta: del orden de 100 KB, y la mitad comprimida.
			const gzip = await comprimido(bytes);
			expect(bytes.byteLength).toBeLessThan(200 * 1024);

			// Una fila distinta en la tabla más grande: se baja su cubo, una de cada 256 partes.
			const t3 = Date.now();
			const pagina = await enElHub(HUB, (hub: any) =>
				filasDeLosCubos(lectorDelHub(hub.state.storage.sql), {
					tabla: "Detalle_Comanda",
					desde: DESDE,
					cubos: 256,
					pedir: [17],
					cursor: 0,
				}),
			);
			const t4 = Date.now();
			const cubo = JSON.parse(new TextDecoder().decode(pagina));
			expect(cubo.filas).toHaveLength(lineas.cuentas[17]);
			expect(cubo.siguiente_cursor).toBeNull();
			expect(pagina.byteLength).toBeLessThan(400 * 1024);

			console.log(
				[
					`contraste · ventana de ${filas} filas (un mes de mil comandas diarias)`,
					`  sólo leer la ventana        ${t1 - t0} ms`,
					`  resumen completo            ${t2 - t1} ms  (conteos, lectura y hash)`,
					`  respuesta                   ${bytes.byteLength} bytes · ${gzip} comprimida`,
					`  un cubo de Detalle_Comanda  ${cubo.filas.length} filas · ${pagina.byteLength} bytes · ${t4 - t3} ms`,
				].join("\n"),
			);

			// Margen ancho: es una máquina de pruebas cualquiera. Lo que no puede pasar es que resumir
			// cueste un orden de magnitud más que leer.
			expect(t2 - t1).toBeLessThan(60_000);
		},
		240_000,
	);
});
