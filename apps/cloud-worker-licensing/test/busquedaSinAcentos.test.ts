// test/busquedaSinAcentos.test.ts
//
// Lo que teclea el usuario en un buscador se compara sin acentos y sin distinguir mayúsculas, igual
// que en la Main. Aquí, contra la tabla que comparten (`crates/tpv-domain/src/busqueda_casos.json`):
//
//   · las tablas de `lib/busqueda.ts` son las de los casos, letra a letra;
//   · `normalizarBusqueda` deja cada texto como dicen los casos;
//   · la expresión SQL, en el SQLite de un Durable Object, deja la columna igual que el código deja
//     el texto, y `instr` sobre ella encuentra lo que dicen los casos;
//   · las tres búsquedas del worker (productos en mesas y en la barra, listados de caja) encuentran
//     «CAFÉ Solo» con «café» y «Caña» con «CAÑA».
//
// Que la Main devuelve las mismas filas lo fijan los casos de lectura `*_sin_acentos`
// (`tests/contract/lecturas/`).

import type { Client } from "@libsql/client/web";
import { describe, expect, it } from "vitest";

import casos from "../../../crates/tpv-domain/src/busqueda_casos.json";
import { normalizada, normalizarBusqueda, PLIEGUES, SE_QUITAN, textoABuscar } from "../src/lib/busqueda";
import { entradas, resumen, salidas } from "../src/domains/cuentas/cuentas.queries";
import { searchProductos as buscarEnMesas } from "../src/domains/mesas/mesas.queries";
import { searchProductos as buscarEnLaBarra } from "../src/domains/venta_rapida/venta_rapida.queries";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

describe("la tabla compartida con la Main", () => {
	it("las letras que se pliegan y las marcas que se quitan son las de los casos", () => {
		expect(Object.fromEntries(PLIEGUES)).toEqual(casos.pliegues);
		expect([...SE_QUITAN]).toEqual(casos.se_quitan);
	});

	it.each(casos.normalizar)("normaliza $texto", ({ texto, queda }) => {
		expect(normalizarBusqueda(texto)).toBe(queda);
		expect(normalizarBusqueda(normalizarBusqueda(texto))).toBe(queda);
	});

	it.each(casos.buscar)("$nombre con $busca", ({ nombre, busca, encuentra }) => {
		expect(normalizarBusqueda(nombre).includes(normalizarBusqueda(busca))).toBe(encuentra);
	});

	it.each(casos.a_buscar)("lo tecleado $texto se busca como $queda", ({ texto, queda }) => {
		expect(textoABuscar(texto)).toBe(queda);
	});

	it("sin texto no es una búsqueda", () => {
		expect(textoABuscar(null)).toBeNull();
	});
});

describe("la expresión SQL, en el SQLite del Durable Object", () => {
	it("deja cada texto como el código", async () => {
		await enElHub("busqueda-sin-acentos-sql", (hub: any) => {
			const sql = hub.state.storage.sql;
			for (const { texto, queda } of casos.normalizar) {
				const fila = sql.exec(`SELECT ${normalizada("?")} AS n;`, texto).toArray()[0];
				expect(fila.n, JSON.stringify(texto)).toBe(queda);
			}
		});
	});

	it("y `instr` sobre la columna normalizada encuentra lo de los casos", async () => {
		await enElHub("busqueda-sin-acentos-instr", (hub: any) => {
			const sql = hub.state.storage.sql;
			for (const { nombre, busca, encuentra } of casos.buscar) {
				const fila = sql
					.exec(`SELECT instr(${normalizada("?1")}, ?2) > 0 AS si;`, nombre, textoABuscar(busca))
					.toArray()[0];
				expect(Number(fila.si) === 1, `${nombre} con ${busca}`).toBe(encuentra);
			}
		});
	});
});

describe("las búsquedas del worker no distinguen acentos ni mayúsculas", () => {
	async function conDatos<R>(nombre: string, prueba: (db: Client) => Promise<R>): Promise<R> {
		return enElHub(`busqueda-sin-acentos-${nombre}`, async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Carta');");
			for (const [id, producto] of Object.entries({
				"p-cafe": "CAFÉ Solo",
				"p-cafe-leche": "Café con leche",
				"p-cana": "Caña",
				"p-cerveza": "Cerveza",
			})) {
				sql.exec(
					"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES (?, 'cat-1', ?, 100);",
					id,
					producto,
				);
			}
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salón');");
			sql.exec(
				"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '7', 4, 0, 0, 'rect', 80, 80);",
			);
			sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-1', 'MARÍA Núñez');");
			sql.exec(
				"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, ID_Cliente, Fecha_Hora_Apertura, Estado) VALUES ('com-1', 'MESA', 'mesa-1', 'cli-1', '2026-05-10 09:00:00', 'Pagada');",
			);
			sql.exec(
				"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('pago-1', 'com-1', '2026-05-10 10:00:00', 'Efectivo', 2450, 'total');",
			);
			sql.exec(
				"INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Tipo_Gasto, Concepto, Importe) VALUES ('gasto-1', '2026-05-12', 'Compras', 'Limón y azúcar', 1500);",
			);
			return prueba(clienteSobre(sql) as unknown as Client);
		});
	}

	it("productos de las mesas y de la barra", async () => {
		await conDatos("productos", async (db) => {
			for (const buscar of [
				async (t: string) => (await buscarEnMesas(db, t)).map((p) => p.ID_Producto),
				async (t: string) => (await buscarEnLaBarra(db, t, 50)).map((p) => p.ID_Producto),
			]) {
				expect(await buscar("café")).toEqual(["p-cafe", "p-cafe-leche"]);
				expect(await buscar("CAFE")).toEqual(["p-cafe", "p-cafe-leche"]);
				expect(await buscar("CAÑA")).toEqual(["p-cana"]);
				expect(await buscar("cana")).toEqual(["p-cana"]);
				expect(await buscar("́")).toEqual([]);
			}
		});
	});

	it("los listados de caja y su cabecera", async () => {
		await conDatos("caja", async (db) => {
			const ids = (pagina: { filas: { id: string }[] }) => pagina.filas.map((f) => f.id);
			expect(ids(await entradas(db, "2026-05-01", "2026-05-31", "maria nuñez"))).toEqual(["pago-1"]);
			expect(ids(await salidas(db, "2026-05-01", "2026-05-31", "LIMON Y AZUCAR"))).toEqual(["gasto-1"]);
			const cabecera = await resumen(db, "2026-05-01", "2026-05-31", "maría");
			expect([cabecera.count_entradas, cabecera.total_entradas]).toEqual([1, 2450]);
		});
	});
});
