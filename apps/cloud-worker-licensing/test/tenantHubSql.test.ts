// test/tenantHubSql.test.ts
//
// Resolución de `$ref` y evaluación de pasos `value` dentro de una transacción del DO.
//
// Es el mecanismo que permite que un paso use el resultado de otro (el caso típico: un UUID
// generado y guardado con `saveAs`, referenciado por el INSERT siguiente) sin perder el
// determinismo: el id se resuelve UNA vez y viaja ya resuelto a la Main.
//
// Los dos modos de fallo que importan son opuestos y ambos silenciosos: resolver mal un valor
// (fila distinta en cada lado) o aceptar como escalar algo que no lo es (argumento corrupto en
// el SQL). Por eso aquí se comprueba tanto lo que debe resolver como lo que debe RECHAZAR.

import { describe, it, expect } from "vitest";

import {
	allRowsFromResult,
	evalValueStep,
	firstRowFromResult,
	isSqlRef,
	isUniqueOpIdViolation,
	normalizeSql,
	resolveSqlArg,
	resolveSqlArgs,
	toPlainValue,
} from "../src/durableObjects/tenantHub.sentencias";

describe("resolución de $ref", () => {
	const bag = { id: "uuid-1", n: 42, flag: true, nulo: null };

	it("resuelve una referencia a un valor guardado", () => {
		expect(resolveSqlArg({ $ref: "id" }, bag)).toBe("uuid-1");
		expect(resolveSqlArg({ $ref: "n" }, bag)).toBe(42);
		expect(resolveSqlArg({ $ref: "flag" }, bag)).toBe(true);
	});

	it("un null guardado es un valor legítimo, no una referencia ausente", () => {
		// Distinguir `null` de `undefined` importa: una columna opcional guardada como null
		// debe poder referenciarse, y confundirlos haría fallar la transacción entera.
		expect(resolveSqlArg({ $ref: "nulo" }, bag)).toBeNull();
	});

	it("una referencia a algo que no existe falla en vez de resolver a null", () => {
		// Fail-fast: resolver un $ref inexistente como null escribiría una fila con un id
		// vacío y la replicación no volvería a cuadrar nunca.
		expect(() => resolveSqlArg({ $ref: "no_existe" }, bag)).toThrow(/missing_ref:no_existe/);
	});

	it("una referencia a un valor no escalar falla", () => {
		const raro = { obj: { a: 1 }, arr: [1, 2] };
		expect(() => resolveSqlArg({ $ref: "obj" }, raro)).toThrow(/bad_ref_value/);
		expect(() => resolveSqlArg({ $ref: "arr" }, raro)).toThrow(/bad_ref_value/);
	});

	it("deja pasar los escalares tal cual", () => {
		expect(resolveSqlArg("texto", bag)).toBe("texto");
		expect(resolveSqlArg(0, bag)).toBe(0);
		expect(resolveSqlArg(false, bag)).toBe(false);
		expect(resolveSqlArg(null, bag)).toBeNull();
	});

	it("rechaza un argumento que no es escalar ni referencia", () => {
		expect(() => resolveSqlArg({ a: 1 } as any, bag)).toThrow(/unsupported_sql_arg/);
		expect(() => resolveSqlArg([1] as any, bag)).toThrow(/unsupported_sql_arg/);
		expect(() => resolveSqlArg(undefined as any, bag)).toThrow(/unsupported_sql_arg/);
	});

	it("isSqlRef no confunde un objeto cualquiera con una referencia", () => {
		expect(isSqlRef({ $ref: "x" })).toBe(true);
		expect(isSqlRef({ $ref: 1 })).toBe(false);
		expect(isSqlRef({ ref: "x" })).toBe(false);
		expect(isSqlRef(null)).toBe(false);
		expect(isSqlRef("$ref")).toBe(false);
	});

	it("resuelve una lista entera conservando el orden", () => {
		// El orden ES el contrato: los args van posicionales (?1, ?2…).
		expect(resolveSqlArgs([{ $ref: "id" }, "x", 7, null], bag)).toEqual([
			"uuid-1",
			"x",
			7,
			null,
		]);
	});

	it("sin args devuelve lista vacía, y algo que no es lista falla", () => {
		expect(resolveSqlArgs(null, bag)).toEqual([]);
		expect(resolveSqlArgs(undefined, bag)).toEqual([]);
		expect(() => resolveSqlArgs("no soy lista", bag)).toThrow(/invalid_sql_args/);
		expect(() => resolveSqlArgs({ 0: "x" }, bag)).toThrow(/invalid_sql_args/);
	});
});

describe("evalValueStep", () => {
	it("resuelve el eco de un parámetro", () => {
		expect(evalValueStep("SELECT ?1", ["uuid-1"])).toBe("uuid-1");
		expect(evalValueStep("SELECT ?2", ["a", "b"])).toBe("b");
	});

	it("resuelve constantes numéricas, negativos y decimales incluidos", () => {
		expect(evalValueStep("SELECT 0", [])).toBe(0);
		expect(evalValueStep("SELECT 42", [])).toBe(42);
		expect(evalValueStep("SELECT -7", [])).toBe(-7);
		expect(evalValueStep("SELECT 3.5", [])).toBe(3.5);
	});

	it("resuelve la concatenación de prefijo y parámetro", () => {
		expect(evalValueStep("SELECT 'TCK-' || ?1", ["001"])).toBe("TCK-001");
	});

	it("tolera el punto y coma final y los espacios", () => {
		expect(evalValueStep("  SELECT ?1 ;; ", ["x"])).toBe("x");
		expect(evalValueStep("select ?1", ["x"])).toBe("x");
	});

	// SYNC-34: el `;` final se quitaba con `/;+\s*$/`, que con una racha de `;` que no está al final
	// tardaba el cuadrado de su longitud. Una Main autenticada sube el SQL de sus pasos `value`.
	it("una racha larga de punto y coma no cuesta el cuadrado de su longitud", () => {
		const racha = ";".repeat(200_000);
		const inicio = performance.now();
		expect(() => evalValueStep(`SELECT ${racha}x`, [])).toThrow(/value_step_no_evaluable_en_batch/);
		expect(evalValueStep(`SELECT ?1${racha}`, ["x"])).toBe("x");
		expect(evalValueStep(`SELECT ?1 ${racha}  `, ["x"])).toBe("x");
		// Con la expresión de antes, minutos.
		expect(performance.now() - inicio).toBeLessThan(1000);
	});

	it("sólo quita la racha de punto y coma del final, como antes", () => {
		// Un `;` que no está al final deja una forma que no es del conjunto cerrado.
		expect(() => evalValueStep("SELECT ?1; ;", ["x"])).toThrow(/value_step_no_evaluable_en_batch/);
		expect(() => evalValueStep("SELECT ;?1", ["x"])).toThrow(/value_step_no_evaluable_en_batch/);
		expect(evalValueStep("SELECT 'a;' || ?1;", ["x"])).toBe("a;x");
	});

	it("un parámetro que falta se resuelve a null, no a undefined", () => {
		// `undefined` no es un escalar SQL válido: acabaría como argumento corrupto.
		expect(evalValueStep("SELECT ?3", ["a"])).toBeNull();
	});

	it("falla en vez de adivinar cuando la forma no está en el set cerrado", () => {
		// El diseño es fail-fast a propósito: una forma nueva debe romper el test, no
		// resolverse a medias en producción.
		const fuera = [
			"SELECT COUNT(*) FROM T",
			"SELECT ?1 + ?2",
			"SELECT 'a' || 'b'",
			"SELECT MAX(Seq) FROM Sync_Changes",
			"INSERT INTO T VALUES (1)",
			"",
		];

		for (const sql of fuera) {
			expect(() => evalValueStep(sql, ["x", "y"]), sql).toThrow(
				/value_step_no_evaluable_en_batch/,
			);
		}
	});
});

describe("normalización de valores para guardarlos en JSON", () => {
	it("convierte bigint a number", () => {
		// JSON.stringify no sabe serializar un bigint: sin esta conversión, guardar un valor que lo
		// lleve lanzaría.
		expect(toPlainValue(9007199254740991n)).toBe(9007199254740991);
		expect(() => JSON.stringify(toPlainValue({ n: 1n }))).not.toThrow();
	});

	it("baja en profundidad por objetos y listas", () => {
		expect(toPlainValue({ a: [1n, { b: 2n }] })).toEqual({ a: [1, { b: 2 }] });
	});

	it("deja intactos los escalares normales", () => {
		expect(toPlainValue("x")).toBe("x");
		expect(toPlainValue(1.5)).toBe(1.5);
		expect(toPlainValue(true)).toBe(true);
		expect(toPlainValue(null)).toBeNull();
		expect(toPlainValue(undefined)).toBeNull();
	});

	it("lee la primera fila y todas las filas de un resultado", () => {
		const result = { rows: [{ a: 1n }, { a: 2n }] };
		expect(firstRowFromResult(result)).toEqual({ a: 1 });
		expect(allRowsFromResult(result)).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("un resultado vacío o raro no revienta", () => {
		for (const r of [null, undefined, {}, { rows: null }, { rows: [] }]) {
			expect(firstRowFromResult(r)).toBeNull();
			expect(allRowsFromResult(r)).toEqual([]);
		}
	});
});

describe("normalizeSql", () => {
	it("recorta y exige que haya sentencia", () => {
		expect(normalizeSql("  SELECT 1;  ")).toBe("SELECT 1;");
		for (const v of ["", "   ", null, undefined]) {
			expect(() => normalizeSql(v), String(v)).toThrow(/missing_sql/);
		}
	});
});

describe("isUniqueOpIdViolation", () => {
	it("reconoce la señal de que la operación ya estaba aplicada", () => {
		// Es lo que convierte un reintento en un no-op idempotente en vez de un 500.
		expect(
			isUniqueOpIdViolation(new Error("UNIQUE constraint failed: Applied_Operations.Op_Id")),
		).toBe(true);
		expect(isUniqueOpIdViolation("unique constraint failed: applied_operations.op_id")).toBe(
			true,
		);
	});

	it("no confunde otras violaciones de UNIQUE con esa", () => {
		// Un DNI repetido también es un UNIQUE, y tratarlo como reintento idempotente
		// silenciaría un error de negocio real.
		expect(
			isUniqueOpIdViolation(new Error("UNIQUE constraint failed: Trabajadores.DNI")),
		).toBe(false);
		expect(isUniqueOpIdViolation(new Error("no such table: T"))).toBe(false);
		expect(isUniqueOpIdViolation(null)).toBe(false);
		expect(isUniqueOpIdViolation(undefined)).toBe(false);
	});
});
