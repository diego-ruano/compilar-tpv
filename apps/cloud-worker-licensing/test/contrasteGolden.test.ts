// test/contrasteGolden.test.ts
//
// Las mismas filas resumen igual en la nube y en la Main, cada una con su SQLite
// (`tests/contract/contraste/`).
//
// Rust siembra la semilla en una base de la Main, resume cada tabla entera con el mismo código que la
// ventana del contraste y bendice `golden.json` (`tpv-infra-sqlite/src/contraste.rs`,
// `contraste_golden_…`). Aquí se siembra lo mismo en el SQLite de un TenantHub y se pide el resumen
// del contraste (`domains/sync/verificar.ts`): tiene que dar los mismos cubos, con las mismas cuentas
// y las mismas sumas.
//
// La tabla de casos (`verificacion_casos.json`) fija la forma canónica y el hash valor a valor; esto
// fija lo que ninguna tabla puede: que los dos SQLite entregan los mismos valores para las mismas
// filas (un `INTEGER` de más de 53 bits, un `-0`, un texto con un NUL, un real calculado en SQL).

import { describe, expect, it } from "vitest";

import golden from "../../../tests/contract/contraste/golden.json";
import semilla from "../../../tests/contract/contraste/semilla.json";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { resumenDeVerificacion } from "../src/domains/sync/verificar";
import { lectorDelHub } from "../src/domains/sync/volcado";

type Resumida = { nombre: string; total: number; filas: number; cubos: number; cuentas: number[]; sumas: string[] };

describe("el resumen del contraste, igual que el de la Main", () => {
	it("las mismas filas dan los mismos cubos, cuentas y sumas", async () => {
		await enElHub("contraste-golden", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (const sentencia of semilla.sentencias) sql.exec(sentencia);

			const quien = { checkpoint: null, deviceId: "d1", clientNow: semilla.ahora, ahoraMs: Date.now() };
			const resumen = JSON.parse(new TextDecoder().decode(await resumenDeVerificacion(lectorDelHub(sql), quien)));
			expect(resumen).toMatchObject({ ok: true, aplazar: false, ventana_omitida: false });

			const esperado = golden as Record<string, { filas: number; cubos: number; cuentas: number[]; sumas: string[] }>;
			expect(Object.keys(esperado).sort()).toEqual([...semilla.tablas].sort());
			for (const tabla of semilla.tablas) {
				const t = resumen.tablas.find((x: Resumida) => x.nombre === tabla) as Resumida;
				// La ventana es la tabla entera: todo lo sembrado cae dentro.
				expect(t.filas, tabla).toBe(t.total);
				expect({ filas: t.filas, cubos: t.cubos, cuentas: t.cuentas, sumas: t.sumas }, tabla).toEqual(esperado[tabla]);
			}
		});
	});
});
