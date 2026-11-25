// test/busquedaDeTexto.test.ts
//
// Lo que teclea el usuario se busca con `instr(<columna normalizada>, ?) > 0` (`lib/busqueda.ts`, sin
// acentos ni mayúsculas: `test/busquedaSinAcentos.test.ts`), nunca con `LIKE`.
//
// El SQLite del Durable Object no admite un patrón de `LIKE` de más de 50 bytes
// (`sondaSqliteDo.test.ts`): buscar un producto con 49 letras, o con 25 acentuadas, tumbaba la
// búsqueda de la Handy con un `internal_error`. Y en un patrón el `%` y el `_` que teclea el usuario
// son comodines: buscar «50%» encontraba también «500». Aquí se prueba contra el SQLite de un DO:
//
//   · las tres búsquedas del worker (productos en mesas, productos en la barra y los listados de
//     caja) con textos de más de 50 bytes, que es lo que el arnés de contrato no ve si los dos
//     lados fallan igual, y con `%` y `_` tal cual;
//   · que ninguna consulta de un dominio vuelve a componer un patrón de `LIKE` con algo que no sea
//     un texto fijo.
//
// Que la Main devuelve las mismas filas lo fijan los casos de lectura `*_comodines` y
// `*_texto_largo` (`tests/contract/lecturas/`).
//
// Aparte de los comodines, `instr` sólo se aparta de `LIKE` con un carácter NUL dentro del texto:
// `LIKE` deja de mirar al llegar a él e `instr` busca en el texto entero, igual en los dos lados.

import type { Base } from "../src/lib/sql";
import { describe, expect, it } from "vitest";

import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { entradas, resumen, salidas } from "../src/domains/cuentas/cuentas.queries";
import { searchProductos as buscarEnMesas } from "../src/domains/mesas/mesas.queries";
import { searchProductos as buscarEnLaBarra } from "../src/domains/venta_rapida/venta_rapida.queries";

const bytes = (texto: string) => new TextEncoder().encode(texto).length;

/** Un nombre de 26 letras, todas acentuadas: pocas letras y 52 bytes. */
const ACENTOS = "áéíóúñü".repeat(4).slice(0, 26);
/** Un nombre largo de los de verdad: 71 letras y 73 bytes. */
const LARGO = "degustación de otoño con maridaje de vinos de la tierra y postre casero";

async function conProductos<R>(nombre: string, prueba: (db: Base) => Promise<R>): Promise<R> {
	return enElHub(`busqueda-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Carta');");
		for (const [id, producto] of Object.entries({
			"p-largo": `Menú ${LARGO}`,
			"p-acentos": `Sopa ${ACENTOS} fría`,
			"p-vale": "Vale_50% barra",
			"p-500": "Vale 500 barra",
			"p-guion": "Vale-50 barra",
			"p-barra-invertida": "Corte 3\\4",
			"p-cerveza": "Cerveza",
		})) {
			sql.exec(
				"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES (?, 'cat-1', ?, 100);",
				id,
				producto,
			);
		}
		return prueba(clienteLocal(hub.state.storage));
	});
}

describe("buscar productos con lo que teclea el usuario", () => {
	// Los dos buscadores, con la misma forma: texto → los ID que salen.
	const BUSCADORES = {
		mesas: async (db: Base, texto: string) => (await buscarEnMesas(db, texto)).map((p) => p.ID_Producto),
		barra: async (db: Base, texto: string) => (await buscarEnLaBarra(db, texto, 50)).map((p) => p.ID_Producto),
	};

	for (const [donde, buscar] of Object.entries(BUSCADORES)) {
		it(`${donde}: un texto de más de 50 bytes encuentra su producto`, async () => {
			expect(bytes(LARGO)).toBeGreaterThan(50);
			expect(ACENTOS.length).toBeLessThan(50);
			expect(bytes(ACENTOS)).toBeGreaterThan(50);
			await conProductos(`${donde}-largo`, async (db) => {
				expect(await buscar(db, LARGO)).toEqual(["p-largo"]);
				expect(await buscar(db, ACENTOS)).toEqual(["p-acentos"]);
				// Sin distinguir mayúsculas ni acentos.
				expect(await buscar(db, LARGO.replace("maridaje", "MARIDAJE"))).toEqual(["p-largo"]);
				// Con una letra cambiada al final ya no está.
				expect(await buscar(db, `${LARGO}s`)).toEqual([]);
			});
		});

		it(`${donde}: el % y el _ se buscan tal cual`, async () => {
			await conProductos(`${donde}-comodines`, async (db) => {
				expect(await buscar(db, "_50%")).toEqual(["p-vale"]);
				expect(await buscar(db, "50%")).toEqual(["p-vale"]);
				expect(await buscar(db, "%")).toEqual(["p-vale"]);
				expect(await buscar(db, "_")).toEqual(["p-vale"]);
				expect(await buscar(db, "3\\4")).toEqual(["p-barra-invertida"]);
				// Y sin ellos, como siempre: por el nombre, en su orden.
				expect(await buscar(db, "vale")).toEqual(["p-500", "p-guion", "p-vale"]);
			});
		});
	}
});

describe("buscar en los listados de caja con lo que teclea el usuario", () => {
	const CLIENTA = "María Ángeles Fernández de Córdoba y Martínez de la Sierra-Núñez";
	const RANGO = ["2026-05-01", "2026-05-31"] as const;

	async function conCaja<R>(nombre: string, prueba: (db: Base) => Promise<R>): Promise<R> {
		return enElHub(`busqueda-caja-${nombre}`, async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');");
			sql.exec(
				"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '7', 4, 0, 0, 'rect', 80, 80);",
			);
			for (const [n, cliente, importe] of [
				[1, CLIENTA, 2450],
				[2, "Socio_100% Real", 3000],
				[3, "Socio 1000 Real", 300],
			] as const) {
				sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES (?, ?);", `cli-${n}`, cliente);
				sql.exec(
					"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, ID_Cliente, Fecha_Hora_Apertura, Estado) VALUES (?, 'MESA', 'mesa-1', ?, '2026-05-10 09:00:00', 'Pagada');",
					`com-${n}`,
					`cli-${n}`,
				);
				sql.exec(
					"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES (?, ?, ?, 'Efectivo', ?, 'total');",
					`pago-${n}`,
					`com-${n}`,
					`2026-05-10 1${n}:00:00`,
					importe,
				);
			}
			for (const [n, concepto, importe] of [
				[1, `Cena de empresa: ${LARGO}`, 15000],
				[2, "Rappel 10%_anual", 4000],
				[3, "Rappel 1000 anual", 1050],
			] as const) {
				sql.exec(
					"INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Tipo_Gasto, Concepto, Importe) VALUES (?, '2026-05-12', 'Compras', ?, ?);",
					`gasto-${n}`,
					concepto,
					importe,
				);
			}
			return prueba(clienteLocal(hub.state.storage));
		});
	}

	const ids = (pagina: { filas: { id: string }[] }) => pagina.filas.map((f) => f.id);

	it("un texto de más de 50 bytes encuentra su cobro y su gasto", async () => {
		expect(bytes(CLIENTA)).toBeGreaterThan(50);
		await conCaja("largo", async (db) => {
			expect(ids(await entradas(db, ...RANGO, CLIENTA))).toEqual(["pago-1"]);
			expect(ids(await salidas(db, ...RANGO, LARGO))).toEqual(["gasto-1"]);
			// La cabecera suma lo mismo que enseñan los listados.
			const cabecera = await resumen(db, ...RANGO, CLIENTA);
			expect([cabecera.count_entradas, cabecera.total_entradas, cabecera.count_salidas]).toEqual([1, 2450, 0]);
		});
	});

	it("el % y el _ se buscan tal cual", async () => {
		await conCaja("comodines", async (db) => {
			expect(ids(await entradas(db, ...RANGO, "_100%"))).toEqual(["pago-2"]);
			expect(ids(await salidas(db, ...RANGO, "10%_"))).toEqual(["gasto-2"]);
			const cabecera = await resumen(db, ...RANGO, "100%");
			expect([cabecera.count_entradas, cabecera.total_entradas, cabecera.count_salidas]).toEqual([1, 3000, 0]);
			// Sin ellos, como siempre: los dos socios, del más reciente al más antiguo.
			expect(ids(await entradas(db, ...RANGO, "socio"))).toEqual(["pago-3", "pago-2"]);
		});
	});
});

describe("ninguna consulta de un dominio compone un patrón de LIKE ni de GLOB", () => {
	// Todo el fuente de los dominios, como texto (dentro del pool de workers no hay `node:fs`).
	const fuentes = import.meta.glob("../src/domains/**/*.ts", { query: "?raw", import: "default", eager: true });

	/**
	 * Un `LIKE` o un `GLOB` que no va seguido de un patrón fijo (`GLOB` tiene el mismo tope de 50
	 * bytes). Sólo vale lo que se reconoce: la palabra, un literal de SQL entero —con sus comillas
	 * dobladas (`'it''s'`) y sin nada que lo componga desde JavaScript— y, detrás, el final de la
	 * condición. Todo lo demás se da por un patrón de fuera: un parámetro, una concatenación, una
	 * interpolación, un comentario o un `COLLATE` por medio, la forma de función (`like(patron, x)`).
	 *
	 * Es conservador a propósito: un patrón fijo con `$`, `+`, comillas dobles o acento grave también
	 * salta, y hay que escribirlo de otra forma. El `$` es el final del texto, no el de la línea: un
	 * `||` en la línea siguiente sigue siendo una concatenación.
	 */
	const PATRON_DE_FUERA =
		/\b(?:LIKE|GLOB)\b(?!\s+'(?:[^'$"`+]|'')*'(?!')\s*(?:$|[),;]|(?:THEN|AND|OR|ESCAPE|END|ELSE|WHEN|GROUP|ORDER|LIMIT)\b))/gi;

	it("lee el fuente de verdad", () => {
		expect(Object.keys(fuentes).length).toBeGreaterThan(40);
		// Los patrones fijos que ya hay sí se ven, y no cuentan.
		const fijos = Object.values(fuentes).join("\n").match(/\b(?:LIKE|GLOB)\s+'[^'$]*'/gi) ?? [];
		expect(fijos.length).toBeGreaterThan(0);
	});

	it("el detector caza un parámetro, una concatenación y una interpolación, y deja los textos fijos", () => {
		const caza = (sql: string) => (sql.match(PATRON_DE_FUERA) ?? []).length;
		expect(caza("WHERE p.Nombre LIKE ?1")).toBe(1);
		expect(caza("WHERE x LIKE '%' || lower(?2) || '%'")).toBe(1);
		expect(caza("WHERE x LIKE ${patron}")).toBe(1);
		expect(caza("WHERE x LIKE '%${texto}%'")).toBe(1);
		expect(caza(`WHERE x LIKE '%" + texto + "%'`)).toBe(1);
		expect(caza("WHERE x like :texto")).toBe(1);
		expect(caza("WHERE x GLOB ?1")).toBe(1);
		expect(caza("WHERE x LIKE 'it''s' || ?1")).toBe(1);
		expect(caza("WHERE like(?1, x)")).toBe(1);
		expect(caza("WHERE glob(?1, x)")).toBe(1);
		expect(caza("WHERE x LIKE '%' /* búsqueda */ || ?1")).toBe(1);
		expect(caza("WHERE x GLOB '*' /* búsqueda */ || ?1")).toBe(1);
		expect(caza("WHERE x LIKE/**/?1")).toBe(1);
		expect(caza("WHERE x LIKE '%' COLLATE NOCASE || ?1")).toBe(1);
		expect(caza("WHERE x LIKE '%'\n || ?1")).toBe(1);
		expect(caza("WHERE x GLOB '*'\n || ?1")).toBe(1);
		expect(caza("WHERE x LIKE 'it''s%'")).toBe(0);
		expect(caza("WHERE x LIKE 'it''s%' AND y = 1")).toBe(0);
		expect(caza("WHERE x LIKE '%a\\_b%' ESCAPE '\\'")).toBe(0);
		expect(caza("CASE WHEN f.Hora LIKE '%-%' THEN 1 END")).toBe(0);
		expect(caza("lower(cg.Tipo_Gasto) LIKE '%proveedor%')")).toBe(0);
		expect(caza("m.Numero_Mesa NOT GLOB '*[^0-9]*'\n\tAND instr(m.Numero_Mesa, char(0)) = 0")).toBe(0);
	});

	it("en los dominios sólo hay patrones fijos", () => {
		const hallazgos: string[] = [];
		for (const [ruta, texto] of Object.entries(fuentes)) {
			// Los comentarios hablan de `LIKE`; lo que se mira es el SQL.
			const sinComentarios = texto
				.split("\n")
				.filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l))
				.join("\n");
			for (const m of sinComentarios.matchAll(PATRON_DE_FUERA)) {
				hallazgos.push(`${ruta}: ${sinComentarios.slice(m.index, m.index + 60).split("\n")[0]}`);
			}
		}
		expect(hallazgos, "usa instr(normalizada(col), ?) > 0 (lib/busqueda.ts)").toEqual([]);
	});
});
