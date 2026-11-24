// test/statsClientesUnaLectura.test.ts
//
// La estadística de clientes lee los cobros de la historia UNA vez.
//
// Para saber quién es recurrente hace falta el primer cobro de cada cliente en toda la historia, no
// sólo en el rango: el CTE `allp` (los cobros de comandas con reserva de un cliente). Lo leen otros
// tres CTE de la misma sentencia y, sin `MATERIALIZED`, SQLite lo deshace dentro de cada uno: tres
// recorridos de todos los cobros, se pida el rango que se pida. En el SQLite del Durable Object,
// que atiende a todo el negocio en un solo hilo, eso son segundos con un año de datos.
//
// Aquí se mira el plan en el SQLite de un DO, sin estadísticas, que es como corre. Que el resultado
// no cambia lo fija el caso de lectura `stats/clientes` del arnés de contrato, y la Main tiene el
// mismo test en `tpv-infra-sqlite/src/planes.rs`.

import type { Base } from "../src/lib/sql";
import { describe, expect, it } from "vitest";

import caso from "../../../tests/contract/lecturas/casos/stats/clientes.json";
import golden from "../../../tests/contract/lecturas/golden/stats/clientes.json";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { clientes } from "../src/domains/stats/stats.queries";

describe("la estadística de clientes", () => {
	it("lee los cobros de la historia una sola vez", async () => {
		await enElHub("stats-clientes-una-lectura", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const sentencia of caso.seed) sql.exec(sentencia);

			const db = clienteSobre(sql) as unknown as Base;
			const sentencias: string[] = [];
			const espia = {
				execute: (entrada: any) => {
					sentencias.push(typeof entrada === "string" ? entrada : entrada.sql);
					return db.execute(entrada);
				},
			} as unknown as Base;

			const r = await clientes(espia, "hoy");
			// La siembra tiene un cliente recurrente: la sentencia que se mira es la que lo calcula.
			expect(r.recurrentes).toBe(golden.recurrentes);
			expect(r.recurrentes).toBeGreaterThan(0);

			const recurrentes = sentencias.filter((s) => /\ballp\b/.test(s));
			expect(recurrentes).toHaveLength(1);

			const plan: string[] = sql
				.exec(`EXPLAIN QUERY PLAN ${recurrentes[0]}`)
				.toArray()
				.map((f: any) => String(f.detail));
			// `p` son los cobros y `c` sus comandas: se leen para construir `allp`, y nada más.
			expect(plan).toContain("MATERIALIZE allp");
			expect(plan.filter((l) => /^(SCAN|SEARCH) p( |$)/.test(l)), plan.join("\n")).toHaveLength(1);
			expect(plan.filter((l) => /^(SCAN|SEARCH) c( |$)/.test(l)), plan.join("\n")).toHaveLength(1);
			expect(plan.filter((l) => l === "SCAN allp")).toHaveLength(3);
		});
	});
});
