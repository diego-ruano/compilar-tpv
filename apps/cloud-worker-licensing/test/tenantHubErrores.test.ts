// test/tenantHubErrores.test.ts
//
// SYNC-20 — ¿este rechazo se arregla reintentando, o no?
//
// De esta decisión depende que una operación irreparable pare la cola entera o se aparte. Los dos
// errores posibles tienen coste, y no el mismo:
//
//   - Llamar PERMANENTE a un fallo de red aparta una venta que habría subido sola. Se pierde de la
//     nube un dato que sí existía.
//   - Llamar TRANSITORIO a un error de SQL sólo cuesta esperar: la operación se apartará igual al
//     agotar `MAX_SUBIDA_ATTEMPTS`.
//
// Por eso la función falla hacia transitorio, y por eso estos casos importan: los de abajo salen de
// lo que devuelven libsql y Turso de verdad, no de leer la implementación.

import { describe, it, expect } from "vitest";

import { esRechazoPermanente } from "../src/durableObjects/tenantHub.errores";

describe("un rechazo que NO se arregla reintentando", () => {
	it("reconoce el desajuste de esquema que motivó todo esto", () => {
		// El caso real: la Main manda un UPDATE con una columna que el tenant no tiene. Repetirlo
		// cada tres segundos durante meses da exactamente el mismo resultado.
		expect(esRechazoPermanente(new Error("no such column: Razon_Social"))).toBe(true);
		expect(esRechazoPermanente(new Error("no such table: Registros_Facturacion"))).toBe(true);
		expect(esRechazoPermanente(new Error("table Pagos has no column named Motivo_Baja"))).toBe(
			true,
		);
	});

	it("reconoce las violaciones de restricción", () => {
		expect(esRechazoPermanente(new Error("UNIQUE constraint failed: Usuarios.Email"))).toBe(true);
		expect(esRechazoPermanente(new Error("FOREIGN KEY constraint failed"))).toBe(true);
		expect(esRechazoPermanente(new Error("NOT NULL constraint failed: Pagos.Importe"))).toBe(true);
		expect(esRechazoPermanente(new Error("CHECK constraint failed: Comandas"))).toBe(true);
	});

	it("una hora que tendría que elegir la nube tampoco se arregla reintentando", () => {
		// CFG-04: el DO la rechaza antes de ejecutar nada, y el mismo comando da el mismo rechazo.
		expect(esRechazoPermanente(new Error("hora_no_determinista: CURRENT_*"))).toBe(true);
	});

	it("no se deja engañar por el prefijo que antepone libsql", () => {
		// Lo que llega no es el mensaje pelado de SQLite: viene envuelto.
		expect(
			esRechazoPermanente(new Error('SQLite error: near "SELCT": syntax error')),
		).toBe(true);
	});

	it("acepta un error que no sea un Error", () => {
		// El `catch (e: any)` del DO no garantiza nada sobre lo que atrapa.
		expect(esRechazoPermanente("no such column: X")).toBe(true);
	});
});

describe("un rechazo que SÍ se arregla solo", () => {
	it("no aparta nada por un corte o un timeout", () => {
		for (const msg of [
			"fetch failed",
			"Network connection lost",
			"The request timed out",
			"database is locked",
			"SQLITE_BUSY: database is busy",
			"stream closed",
			"503 Service Unavailable",
		]) {
			expect(esRechazoPermanente(new Error(msg))).toBe(false);
		}
	});

	it("ante la duda, NO aparta", () => {
		// Es la regla que impide que este arreglo se convierta en una forma nueva de perder datos.
		// Un error desconocido se reintenta; si de verdad es irreparable, se apartará al agotar los
		// intentos. Esperar de más cuesta tiempo; apartar de más cuesta un dato.
		expect(esRechazoPermanente(new Error("algo raro ha pasado"))).toBe(false);
		expect(esRechazoPermanente(undefined)).toBe(false);
		expect(esRechazoPermanente(null)).toBe(false);
		expect(esRechazoPermanente(new Error(""))).toBe(false);
	});

	it("un fallo de transporte MANDA sobre el texto de SQL que arrastre dentro", () => {
		// Un error de red puede traerse pegado el texto de la sentencia que se estaba mandando. Si
		// ganara la firma permanente, un bache de red apartaría una venta buena.
		expect(
			esRechazoPermanente(
				new Error('fetch failed while executing: UPDATE X SET unique constraint failed'),
			),
		).toBe(false);
	});
});
