// test/errorHttp.test.ts
//
// ARQ-07: los errores propios llegan estructurados a HTTP sin volver a clasificarlos por su texto.

import { describe, expect, it } from "vitest";

import { completarCuerpoDeError } from "../src/lib/errorCodes";
import { cuerpoDeErrorConStatus, HubError } from "../src/lib/errorHttp";

describe("HubError en la frontera HTTP", () => {
	it("conserva el contrato de una base de tenant sin aprovisionar", () => {
		const err = new HubError("tenant_db_not_provisioned", 404);
		const body = completarCuerpoDeError(cuerpoDeErrorConStatus(err), err.status);

		expect(body).toEqual({
			ok: false,
			error: "tenant_db_not_provisioned",
			code: "tenant_db_not_provisioned",
		});
	});

	it("transporta el diagnóstico de una migración alterada sin usarlo como identificador", () => {
		const details = { message: "migration_altered: 0001 tiene un hash distinto" };
		const err = new HubError("migration_altered", 500, details);
		const body = completarCuerpoDeError(cuerpoDeErrorConStatus(err), err.status);

		expect(err.message).toBe(details.message);
		expect(body).toEqual({
			ok: false,
			error: "migration_altered",
			details,
			code: "tenant_migration_altered",
		});
	});
});
