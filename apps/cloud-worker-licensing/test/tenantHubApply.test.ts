// test/tenantHubApply.test.ts
//
// `buildApplyBatch`: convierte un comando en (a) lo que se EJECUTA aquí y (b) lo que se
// REPLICA a la Main. Dos listas separadas — y ahí está el riesgo: si divergen, la nube y la
// Main acaban con filas distintas y nadie se entera hasta que alguien cuadra una caja.
//
// Los casos salen del contrato documentado en el propio método, no de su implementación:
//   · middle      → sentencias a ejecutar, en orden (escrituras + lecturas)
//   · replicated  → SOLO las escrituras, con los args ya resueltos a literales, para que la
//                   Main las aplique contra su SQLite local
//   · los pasos `value` se evalúan en JS, sin ir a la base de datos
//
// ARQ-04: vive fuera de la clase (`tenantHub.lote.ts`) porque no toca nada del Durable Object,
// así que se llama directamente. Antes era `private` y había que levantar un DO para probarlo.

import { describe, it, expect } from "vitest";

import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";

import type { InternalApplyCommand } from "../src/durableObjects/tenantHub.types";

type Batch = {
	middle: { sql: string; args: any[] }[];
	replicated: { sql: string; args: any[] }[];
	resolveResult: (batchResults: any[], offset: number) => any;
	storageResult: any;
};

async function build(cmd: InternalApplyCommand): Promise<Batch> {
	return buildApplyBatch(cmd) as Batch;
}

async function buildFalla(cmd: InternalApplyCommand): Promise<string> {
	try {
		await build(cmd);
		return "__no_lanzo__";
	} catch (e: any) {
		return String(e?.message ?? e);
	}
}

const INSERT = "INSERT INTO Comandas (ID_Comanda, Total) VALUES (?1, ?2);";
const SELECT = "SELECT ID_Comanda FROM Comandas WHERE ID_Mesa = ?1;";

const exec = (sql: string, args: any[] = []): InternalApplyCommand => ({
	type: "tenantDb.exec",
	payload: { sql, args },
});

const tx = (steps: any[]): InternalApplyCommand => ({
	type: "tenantDb.transaction",
	payload: { steps },
});

/** Todos los args de una lista de sentencias, aplanados. */
const argsDe = (stmts: { args: any[] }[]) => stmts.flatMap((s) => s.args ?? []);

describe("buildApplyBatch · escritura simple", () => {
	it("una escritura se ejecuta y se replica", async () => {
		const b = await build(exec(INSERT, ["c-1", 12.5]));

		expect(b.middle).toHaveLength(1);
		expect(b.replicated).toHaveLength(1);
		expect(b.replicated[0].sql).toContain("INSERT INTO Comandas");
		expect(b.replicated[0].args).toEqual(["c-1", 12.5]);
	});

	it("lo que se replica es exactamente lo que se ejecuta", async () => {
		// Si estas dos se separaran, la Main aplicaría algo distinto de lo que quedó en la nube.
		const b = await build(exec(INSERT, ["c-1", 12.5]));
		expect(b.replicated[0]).toEqual(b.middle[0]);
	});

	it("una sentencia vacía falla en vez de replicar basura", async () => {
		expect(await buildFalla(exec(""))).toMatch(/missing_sql/);
		expect(await buildFalla(exec("   "))).toMatch(/missing_sql/);
	});
});

describe("buildApplyBatch · sólo escrituras", () => {
	/* El camino de apply existe para ESCRIBIR: lleva idempotencia por Op_Id, deja rastro en
	   `Sync_Changes` y hace broadcast. Una lectura no pinta nada ahí, y `ApplyCommand`
	   (lib/hub.ts) sólo admite `exec` y `transaction`, así que nada legítimo manda otra cosa.

	   Que el resto de variantes REVIENTEN es lo correcto: si un día alguien encaminara una
	   lectura por aquí, se enteraría al instante en vez de replicar un SELECT a todos los
	   dispositivos. Ojo con `InternalApplyCommand`: declara seis variantes pero por esta vía
	   sólo dos son aplicables. */
	it("las consultas no son aplicables y se rechazan", async () => {
		for (const type of ["tenantDb.value", "tenantDb.row", "tenantDb.rows"] as const) {
			const msg = await buildFalla({ type, payload: { sql: SELECT, args: ["m-1"] } } as any);
			expect(msg, type).toMatch(/batch_unsupported_command_type/);
		}
	});

	it("un ping tampoco es aplicable", async () => {
		// El ping se atiende en el canal del WebSocket, no por el motor de escritura.
		expect(await buildFalla({ type: "tenantDb.ping" })).toMatch(
			/batch_unsupported_command_type/,
		);
	});
});

describe("buildApplyBatch · transacciones", () => {
	it("conserva el orden de las escrituras", async () => {
		// El orden ES el contrato: un UPDATE que dependa de un INSERT anterior falla si se
		// reordena, y en la Main fallaría de forma distinta que en la nube.
		const b = await build(
			tx([
				{ kind: "execute", sql: "UPDATE A SET x = 1;" },
				{ kind: "execute", sql: "UPDATE B SET y = 2;" },
				{ kind: "execute", sql: "UPDATE C SET z = 3;" },
			]),
		);

		expect(b.replicated.map((s) => s.sql)).toEqual([
			"UPDATE A SET x = 1;",
			"UPDATE B SET y = 2;",
			"UPDATE C SET z = 3;",
		]);
	});

	it("de una transacción mixta sólo se replican las escrituras", async () => {
		const b = await build(
			tx([
				{ kind: "execute", sql: "UPDATE A SET x = 1;" },
				{ kind: "row", sql: SELECT, args: ["m-1"], saveAs: "fila" },
				{ kind: "execute", sql: "UPDATE B SET y = 2;" },
			]),
		);

		expect(b.replicated).toHaveLength(2);
		expect(b.replicated.every((s) => /^UPDATE/.test(s.sql))).toBe(true);
		expect(b.replicated.some((s) => s.sql.includes("SELECT"))).toBe(false);
	});

	/* ────────────────────────────────────────────────────────────────────
	   La propiedad más importante del módulo: nada que se replique puede
	   llevar un `$ref` sin resolver. La Main no tiene la bolsa de valores
	   del paso anterior, así que un `$ref` que se le escape es una fila
	   que NUNCA podrá aplicar.
	   ──────────────────────────────────────────────────────────────────── */
	it("lo replicado no lleva ni un $ref sin resolver", async () => {
		const b = await build(
			tx([
				{ kind: "value", sql: "SELECT ?1", args: ["uuid-fijo"], saveAs: "id" },
				{ kind: "execute", sql: INSERT, args: [{ $ref: "id" }, 10] },
				{ kind: "execute", sql: "UPDATE Mesas SET ID_Comanda = ?1;", args: [{ $ref: "id" }] },
			]),
		);

		const crudo = JSON.stringify(b.replicated);
		expect(crudo).not.toContain("$ref");

		for (const arg of argsDe(b.replicated)) {
			const escalar =
				arg === null || ["string", "number", "boolean"].includes(typeof arg);
			expect(escalar, `arg no escalar: ${JSON.stringify(arg)}`).toBe(true);
		}
	});

	it("el id generado en un paso `value` llega literal a las escrituras siguientes", async () => {
		// Es lo que hace que la nube y la Main acaben con el MISMO id de fila.
		const b = await build(
			tx([
				{ kind: "value", sql: "SELECT ?1", args: ["uuid-fijo"], saveAs: "id" },
				{ kind: "execute", sql: INSERT, args: [{ $ref: "id" }, 10] },
			]),
		);

		expect(argsDe(b.replicated)).toContain("uuid-fijo");
	});

	it("el mismo id se repite idéntico en todas las sentencias que lo usan", async () => {
		const b = await build(
			tx([
				{ kind: "value", sql: "SELECT ?1", args: ["uuid-fijo"], saveAs: "id" },
				{ kind: "execute", sql: INSERT, args: [{ $ref: "id" }, 10] },
				{ kind: "execute", sql: "UPDATE Mesas SET ID_Comanda = ?1;", args: [{ $ref: "id" }] },
			]),
		);

		const usos = argsDe(b.replicated).filter((a) => a === "uuid-fijo");
		expect(usos).toHaveLength(2);
	});

	it("una concatenación en un paso `value` se resuelve al literal completo", async () => {
		const b = await build(
			tx([
				{ kind: "value", sql: "SELECT 'TCK-' || ?1", args: ["77"], saveAs: "ticket" },
				{ kind: "execute", sql: "INSERT INTO T (n) VALUES (?1);", args: [{ $ref: "ticket" }] },
			]),
		);

		expect(argsDe(b.replicated)).toContain("TCK-77");
	});

	it("referenciar algo que no existe falla en vez de escribir un null", async () => {
		// Resolver a null dejaría una fila con id vacío y la replicación no volvería a cuadrar.
		const msg = await buildFalla(
			tx([{ kind: "execute", sql: INSERT, args: [{ $ref: "no_existe" }, 1] }]),
		);
		expect(msg).toMatch(/missing_ref/);
	});

	it("un paso `value` con SQL no evaluable falla en vez de adivinar", async () => {
		const msg = await buildFalla(
			tx([{ kind: "value", sql: "SELECT COUNT(*) FROM T", saveAs: "n" }]),
		);
		expect(msg).toMatch(/value_step_no_evaluable_en_batch/);
	});

	it("una transacción sin pasos se rechaza", async () => {
		// Aceptarla sería lo peligroso: el batch vacío se aplicaría "con éxito", la operación
		// quedaría marcada como aplicada por Op_Id y no se habría escrito nada. Un reintento
		// posterior la vería como ya hecha.
		expect(await buildFalla(tx([]))).toMatch(/missing_transaction_steps/);
	});
});

describe("buildApplyBatch · entradas hostiles", () => {
	it("un tipo de comando desconocido falla en vez de devolver un batch vacío", async () => {
		// Un batch vacío se aplicaría "con éxito" sin escribir nada: el peor resultado posible,
		// porque la operación quedaría marcada como aplicada.
		const msg = await buildFalla({ type: "tenantDb.explota" } as any);
		expect(msg).toMatch(/batch_unsupported_command_type/);
		expect(msg).not.toBe("__no_lanzo__");
	});

	it("un paso con kind desconocido no se cuela como escritura", async () => {
		const cmd = tx([
			{ kind: "execute", sql: "UPDATE A SET x = 1;" },
			{ kind: "borrar_todo", sql: "DELETE FROM Comandas;" },
		]);

		let replicadas: string[] = [];
		try {
			replicadas = (await build(cmd)).replicated.map((s) => s.sql);
		} catch {
			return; // rechazarlo también es una respuesta correcta
		}

		expect(replicadas, "un kind desconocido no puede acabar replicándose").not.toContain(
			"DELETE FROM Comandas;",
		);
	});

	it("args que no son escalares se rechazan", async () => {
		const msg = await buildFalla(exec(INSERT, [{ objeto: 1 }, 2]));
		expect(msg).toMatch(/unsupported_sql_arg/);
	});

	it("args que no son una lista se rechazan", async () => {
		const msg = await buildFalla(exec(INSERT, "no soy una lista" as any));
		expect(msg).toMatch(/invalid_sql_args/);
	});

	it("es determinista: el mismo comando produce el mismo batch", async () => {
		const cmd = tx([
			{ kind: "value", sql: "SELECT ?1", args: ["uuid-fijo"], saveAs: "id" },
			{ kind: "execute", sql: INSERT, args: [{ $ref: "id" }, 10] },
		]);

		const a = await build(cmd);
		const b = await build(cmd);

		expect(JSON.stringify(a.replicated)).toBe(JSON.stringify(b.replicated));
	});

	it("no muta el comando de entrada", async () => {
		// El comando se reutiliza para hashear la operación: mutarlo cambiaría el hash según
		// el orden de las llamadas y rompería la idempotencia.
		const cmd = tx([
			{ kind: "value", sql: "SELECT ?1", args: ["uuid-fijo"], saveAs: "id" },
			{ kind: "execute", sql: INSERT, args: [{ $ref: "id" }, 10] },
		]);
		const antes = JSON.stringify(cmd);

		await build(cmd);

		expect(JSON.stringify(cmd)).toBe(antes);
	});
});
