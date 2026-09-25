// test/opIdSchemaGuard.test.ts
//
// ARQ-07: `isUniqueOpIdViolation` sólo es seguro mientras ninguna tabla de negocio pueda producir
// la misma señal que el gate idempotente de `Applied_Operations`.

import { describe, expect, it } from "vitest";

import { esTablaDeNegocio } from "../src/domains/sync/bootstrap.ventana";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

describe("guardia del Op_Id idempotente", () => {
	it("ninguna tabla de negocio declara Op_Id como UNIQUE", async () => {
		await enElHub("guard-op-id", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const tablas = sql
				.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
				.toArray()
				.map((r: any) => String(r.name))
				.filter(esTablaDeNegocio);
			const peligrosas: string[] = [];

			for (const tabla of tablas) {
				const nombre = tabla.replaceAll('"', '""');
				const indices = sql.exec(`PRAGMA index_list("${nombre}");`).toArray();
				for (const indice of indices) {
					if (Number((indice as any).unique) !== 1) continue;
					const indiceNombre = String((indice as any).name).replaceAll('"', '""');
					const columnas = sql
						.exec(`PRAGMA index_info("${indiceNombre}");`)
						.toArray()
						.map((r: any) => String(r.name).toLowerCase());
					if (columnas.includes("op_id")) peligrosas.push(tabla);
				}
			}

			expect(peligrosas).toEqual([]);
		});
	});
});
