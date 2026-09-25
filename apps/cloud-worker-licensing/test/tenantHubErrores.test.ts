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

import {
	esFalloPasajero,
	esRechazoPermanente,
	isTursoAuthError,
} from "../src/durableObjects/tenantHub.errores";

describe("ARQ-07 · credenciales de Turso", () => {
	it("reconoce las redacciones reales de un 401 de Turso", () => {
		for (const error of [
			new Error("Server returned HTTP status 401"),
			new Error("Hrana: server returned HTTP status 401 Unauthorized"),
			"Unauthorized",
		]) {
			expect(isTursoAuthError(error), String(error)).toBe(true);
		}
		expect(isTursoAuthError(new Error("503 Service Unavailable"))).toBe(false);
		expect(isTursoAuthError(undefined)).toBe(false);
	});

	// El motivo de que la comparación sea larga y no un `includes("401")`: en la cola del DO esta
	// pregunta va ANTES que `esRechazoPermanente`, así que un falso positivo saca al error del
	// aislamiento por operación y se lleva el lote entero a la rotación de credenciales (REV-04).
	// Los tres de abajo son mensajes que un lote puede producir de verdad.
	it("no confunde un 401 con una cifra que aparezca dentro de otro error", () => {
		for (const error of [
			// Dinero en céntimos: 401 son 4,01 €, y el importe viaja dentro de la sentencia.
			new Error("SQLite error: CHECK constraint failed: Importe_401"),
			new Error('SQLite error: no such column: "401"'),
			new Error("UNIQUE constraint failed: Pagos.Numero_Ticket (2401/000001)"),
		]) {
			expect(isTursoAuthError(error), String(error)).toBe(false);
		}
	});

	// Y la otra mitad: lo que NO es de credenciales tiene que poder llegar a clasificarse.
	it("un rechazo permanente con un 401 dentro se sigue apartando", () => {
		const error = new Error("SQLite error: no such column: Importe_401");
		expect(isTursoAuthError(error)).toBe(false);
		expect(esRechazoPermanente(error)).toBe(true);
	});
});

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

describe("REV-11 · y el reverso: lo que SÍ sabemos que es pasajero", () => {
	// `esRechazoPermanente` sólo dice «no lo apartes todavía». Eso no basta para el otro lado de la
	// decisión: la Main necesita saber cuándo el fallo no dice nada de SU operación, para no gastar
	// uno de los veinte intentos que tiene antes de apartarla. Cuatro baches de red bastaban.

	it("reconoce lo que está en la lista", () => {
		for (const msg of [
			"fetch failed",
			"Network connection lost",
			"The request timed out",
			"database is locked",
			"SQLITE_BUSY: database is busy",
			"stream closed",
			"503 Service Unavailable",
		]) {
			expect(esFalloPasajero(new Error(msg))).toBe(true);
		}
	});

	it("NO es la negación de `esRechazoPermanente`, y ahí está el matiz", () => {
		// Lo desconocido no es permanente —no se aparta a la primera— pero tampoco se puede
		// prometer que se arregle solo. Si aquí dijera que sí, no se gastaría nunca un intento y
		// una operación que la nube no puede aplicar detendría la cola para siempre: exactamente el
		// atasco que SYNC-20 existe para romper.
		const desconocido = new Error("algo raro ha pasado");
		expect(esRechazoPermanente(desconocido)).toBe(false);
		expect(esFalloPasajero(desconocido)).toBe(false);
	});

	it("un rechazo de SQL no es pasajero", () => {
		expect(esFalloPasajero(new Error("no such column: Razon_Social"))).toBe(false);
		expect(esFalloPasajero(new Error("UNIQUE constraint failed: Usuarios.Email"))).toBe(false);
	});

	it("y los dos no pueden ser ciertos a la vez", () => {
		// Serían órdenes contradictorias para la Main: apartar ya y no contar el intento.
		for (const msg of [
			"fetch failed while executing: UPDATE X SET unique constraint failed",
			"no such table: Pagos",
			"timeout",
			"algo raro",
			"",
		]) {
			const e = new Error(msg);
			expect(esRechazoPermanente(e) && esFalloPasajero(e)).toBe(false);
		}
	});

	it("aguanta lo que no sea un Error", () => {
		expect(esFalloPasajero("fetch failed")).toBe(true);
		expect(esFalloPasajero(undefined)).toBe(false);
		expect(esFalloPasajero(null)).toBe(false);
	});
});
