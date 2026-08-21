// test/syncStatements.test.ts
//
// De qué se entera la UI cuando llega un cambio de la nube.
//
// Este módulo lee el SQL ya resuelto de un `change` y decide dos cosas: qué comandas toca (para que
// el POS recargue el ticket SOLO si es el que está abierto) y qué claves de React Query invalidar.
// Sus fallos son **silenciosos**: no hay excepción ni pantalla roja, simplemente la vista se queda
// con datos viejos y quien está delante piensa que el TPV va lento.
//
// Lo que más se prueba aquí no es el camino bueno, sino los dos fallbacks seguros, que son lo
// primero que alguien "optimiza" sin darse cuenta de lo que sostienen:
//   · tabla desconocida o SQL no parseable → invalidar TODO
//   · tocó comanda pero no sabemos cuál   → recargar el ticket por si acaso

import { describe, it, expect } from "vitest";

import {
	affectedComandas,
	affectedFeatureKeys,
	shouldReloadTicket,
	type RawStatement,
} from "../src/shared/lib/syncStatements";

const st = (sql: string, args: unknown[] = []): RawStatement => ({ sql, args });

describe("affectedComandas · qué comandas toca un lote", () => {
	it("saca el id de un WHERE con placeholder numerado", () => {
		const info = affectedComandas([
			st("UPDATE Comandas SET Estado = ?2 WHERE ID_Comanda = ?1;", ["com-1", "Pagada"]),
		]);

		expect(info.ids).toEqual(["com-1"]);
		expect(info.touchedComanda).toBe(true);
		expect(info.uncertain).toBe(false);
	});

	it("saca el id de un INSERT por la posición de su columna", () => {
		// El id no está en un WHERE: hay que casar `ID_Comanda` con su sitio en la lista de columnas.
		const info = affectedComandas([
			st(
				"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad) VALUES (?1, ?2, ?3, ?4);",
				["det-1", "com-7", "prod-1", 2],
			),
		]);

		expect(info.ids).toEqual(["com-7"]);
		expect(info.uncertain).toBe(false);
	});

	it("un lote que toca varias comandas las devuelve todas, sin repetir", () => {
		const info = affectedComandas([
			st("UPDATE Comandas SET Estado='Pagada' WHERE ID_Comanda = ?1;", ["com-1"]),
			st("UPDATE Comandas SET Estado='Pagada' WHERE ID_Comanda = ?1;", ["com-2"]),
			st("DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;", ["com-1"]),
		]);

		expect(info.ids.sort()).toEqual(["com-1", "com-2"]);
	});

	it("si toca comanda pero no se puede identificar cuál, marca incertidumbre", () => {
		// El caso real: borrar una línea por su ID_Detalle. No hay forma de saber de qué comanda es,
		// así que hay que recargar por si acaso. Quitar esto deja tickets rancios en pantalla.
		const info = affectedComandas([
			st("DELETE FROM Detalle_Comanda WHERE ID_Detalle = ?1;", ["det-9"]),
		]);

		expect(info.ids).toEqual([]);
		expect(info.touchedComanda).toBe(true);
		expect(info.uncertain).toBe(true);
	});

	it("un alta de comanda nueva NO marca incertidumbre", () => {
		// Excepción deliberada: una comanda que acaba de nacer no puede ser la que ya está abierta
		// en el POS, así que no hay nada que recargar. Sin esta excepción, cada comanda que abriera
		// otro dispositivo forzaría una recarga del ticket ajeno.
		const info = affectedComandas([
			st("INSERT INTO Comandas (ID_Comanda, Canal, Estado) VALUES (?1, 'BARRA', 'Abierta');", [
				"com-nueva",
			]),
		]);

		expect(info.uncertain).toBe(false);
		expect(info.ids).toEqual(["com-nueva"]);
	});

	it("lo que no toca comandas no despierta al POS", () => {
		const info = affectedComandas([
			st("UPDATE Clientes SET Nombre = ?2 WHERE ID_Cliente = ?1;", ["cli-1", "Ana"]),
		]);

		expect(info.touchedComanda).toBe(false);
		expect(info.uncertain).toBe(false);
	});

	it("detecta que el lote tocó el catálogo, que es lo que refresca el grid del POS", () => {
		const info = affectedComandas([
			st("UPDATE Lotes_Producto SET Stock_Disponible = 5 WHERE ID_Lote = ?1;", ["lote-1"]),
		]);

		expect(info.touchedCatalog).toBe(true);
		expect(info.touchedComanda).toBe(false);
	});
});

describe("affectedFeatureKeys · qué se invalida en React Query", () => {
	it("traduce la tabla a las features que la miran", () => {
		expect(affectedFeatureKeys([st("INSERT INTO Pagos (ID_Pago) VALUES (?1);", ["p-1"])])).toEqual(
			["cuentas", "stats"],
		);
	});

	it("junta las claves de todo el lote sin repetirlas", () => {
		const keys = affectedFeatureKeys([
			st("INSERT INTO Pagos (ID_Pago) VALUES (?1);", ["p-1"]),
			st("UPDATE Productos SET Nombre='x' WHERE ID_Producto = ?1;", ["prod-1"]),
		]);

		expect(keys).not.toBeNull();
		expect([...keys!].sort()).toEqual(["cuentas", "inventario", "stats"]);
	});

	it("una tabla SIN features declaradas no invalida nada (y no es lo mismo que null)", () => {
		// Los ajustes viven en stores Zustand, no en React Query: no hay clave que invalidar. Que
		// devuelva lista vacía y no `null` es lo que evita una invalidación global gratuita.
		expect(affectedFeatureKeys([st("UPDATE business_settings SET Nombre='x';")])).toEqual([]);
	});

	it("una tabla desconocida cae a invalidación GLOBAL", () => {
		// El fallback que sostiene todo lo demás: si mañana alguien añade una tabla y olvida el
		// mapeo, la UI se refresca de más — nunca de menos.
		expect(affectedFeatureKeys([st("UPDATE Tabla_Nueva SET a=1;")])).toBeNull();
	});

	it("un SQL que no sabemos parsear también cae a global", () => {
		expect(affectedFeatureKeys([st("WITH x AS (SELECT 1) UPDATE Productos SET a=1;")])).toBeNull();
	});

	it("basta UNA sentencia desconocida para que todo el lote sea global", () => {
		expect(
			affectedFeatureKeys([
				st("INSERT INTO Pagos (ID_Pago) VALUES (?1);", ["p-1"]),
				st("UPDATE Tabla_Nueva SET a=1;"),
			]),
		).toBeNull();
	});
});

describe("shouldReloadTicket · si hay que recargar el ticket abierto", () => {
	const info = (parcial: Partial<ReturnType<typeof affectedComandas>>) => ({
		ids: [],
		touchedComanda: false,
		uncertain: false,
		touchedCatalog: false,
		...parcial,
	});

	it("recarga si el lote toca la comanda abierta", () => {
		expect(shouldReloadTicket(info({ ids: ["com-1"], touchedComanda: true }), "com-1")).toBe(true);
	});

	it("no recarga si toca la comanda de otro dispositivo", () => {
		expect(shouldReloadTicket(info({ ids: ["com-2"], touchedComanda: true }), "com-1")).toBe(false);
	});

	it("ante la duda, recarga", () => {
		expect(shouldReloadTicket(info({ touchedComanda: true, uncertain: true }), "com-1")).toBe(true);
	});

	it("sin ticket abierto no hay nada que recargar", () => {
		expect(shouldReloadTicket(info({ ids: ["com-1"], touchedComanda: true }), null)).toBe(false);
	});
});
