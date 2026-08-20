// test/contract.test.ts
//
// Tests de contrato Main(Rust) ↔ worker(TS) — ARCH-01. Ver `tests/contract/README.md`.
//
// La lógica de convertir un cobro en SQL vive dos veces (Rust en la Main, este worker para la Handy)
// y tiene que dejar el MISMO efecto para que la replicación converja. Aquí el worker siembra el mismo
// estado que el lado Rust, corre SU cobro, aplica las sentencias y comprueba que las filas resultantes
// coinciden con el `golden` que bendijo Rust (el lado canónico: escritor único).
//
// Se compara el EFECTO (las filas), no el texto SQL: los dos lados escribieron su SQL por separado y
// difiere aunque el resultado sea idéntico; comparar el texto daría falsos positivos.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { cobrarDetalles } from "../src/domains/mesas/mesas.commands";
import { cobrarDetallesPlan } from "../src/domains/mesas/mesas.queries";
import { cobrarFraccionado } from "../src/domains/venta_rapida/venta_rapida.commands";
import { cobrarPlan } from "../src/domains/venta_rapida/venta_rapida.queries";

// Casos del harness. Los goldens los bendice Rust (lado canónico). Añadir uno: crear el fixture,
// bendecir su golden y sumar aquí su par caso/golden (workerd no lee del disco: los imports son
// estáticos y esbuild los empaqueta). La misma lista, en Rust, vive en `contract_tests.rs::CASOS`.
import casoVrUnLote from "../../../tests/contract/casos/venta_rapida__cobro_fraccionado_un_lote.json";
import goldenVrUnLote from "../../../tests/contract/golden/venta_rapida__cobro_fraccionado_un_lote.json";
import casoVrMultilote from "../../../tests/contract/casos/venta_rapida__cobro_fraccionado_fefo_multilote.json";
import goldenVrMultilote from "../../../tests/contract/golden/venta_rapida__cobro_fraccionado_fefo_multilote.json";
import casoMesasCobro from "../../../tests/contract/casos/mesas__cobrar_detalles_un_lote.json";
import goldenMesasCobro from "../../../tests/contract/golden/mesas__cobrar_detalles_un_lote.json";

const CASOS = [
	{ nombre: "vr_un_lote", caso: casoVrUnLote, golden: goldenVrUnLote },
	{ nombre: "vr_fefo_multilote", caso: casoVrMultilote, golden: goldenVrMultilote },
	{ nombre: "mesas_cobro_un_lote", caso: casoMesasCobro, golden: goldenMesasCobro },
];

// ── Comparación estructural (misma spec que el lado Rust) ────────────────────────
const TOL = 1e-9;

const aNumero = (v: any): number => (typeof v === "bigint" ? Number(v) : v);

function celdaIgual(a: any, b: any): boolean {
	if (a === null && b === null) return true;
	const numericos =
		["number", "bigint"].includes(typeof a) || ["number", "bigint"].includes(typeof b);
	if (numericos) return Math.abs(aNumero(a) - aNumero(b)) < TOL;
	return a === b;
}

function filaIgual(a: any, b: any): boolean {
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => k in b && celdaIgual(a[k], b[k]));
}

/** Compara dos tablas como multiconjuntos (sin depender del orden). Devuelve el error o `null`. */
function multiconjuntoIgual(got: any[], want: any[]): string | null {
	if (got.length !== want.length) {
		return `${got.length} filas frente a ${want.length} esperadas`;
	}
	const restantes = [...want];
	for (const fila of got) {
		const i = restantes.findIndex((w) => filaIgual(fila, w));
		if (i < 0) return `fila sin equivalente en el golden: ${JSON.stringify(fila)}`;
		restantes.splice(i, 1);
	}
	return null;
}

/** Corre el comando del caso por su camino real (plan → builder → apply). El `switch` es el punto de
 *  extensión: un dominio nuevo añade su brazo aquí y en el lado Rust (`aplicar_comando`). */
async function aplicarComando(hub: any, sql: any, db: any, caso: any): Promise<void> {
	switch (caso.comando) {
		case "venta_rapida.cobrar_fraccionado": {
			const entrada = {
				id_comanda: caso.entrada.id_comanda,
				metodo: caso.entrada.metodo,
				detalles: caso.entrada.detalles,
				id_usuario_cobrador: null,
				id_trabajador_cobrador: null,
			};
			const plan = await cobrarPlan(db, entrada as any);
			expect(plan.ok, "el plan de cobro debe resolverse").toBe(true);
			const built = cobrarFraccionado(entrada as any, plan as any);
			const batch = hub.buildApplyBatch(built.command);
			for (const st of batch.middle) sql.exec(st.sql, ...(st.args ?? []));
			return;
		}
		case "mesas.cobrar_detalles": {
			const entrada = {
				id_comanda: caso.entrada.id_comanda,
				detalle_ids: caso.entrada.detalle_ids,
				metodo: caso.entrada.metodo,
				tipo: caso.entrada.tipo,
				id_usuario: null,
			};
			const plan = await cobrarDetallesPlan(db, entrada as any);
			expect(plan.ok, "el plan de cobro de mesa debe resolverse").toBe(true);
			const built = cobrarDetalles(entrada as any, plan as any);
			const batch = hub.buildApplyBatch(built.command);
			for (const st of batch.middle) sql.exec(st.sql, ...(st.args ?? []));
			return;
		}
		default:
			throw new Error(`comando sin soporte en el harness de contrato: ${caso.comando}`);
	}
}

describe("contrato Main↔worker · efecto == golden", () => {
	for (const { nombre, caso, golden } of CASOS) {
		it(`${nombre}: deja el mismo efecto que la Main`, async () => {
			await enElHub(`contract-${nombre}`, async (hub: any) => {
				const sql = hub.state.storage.sql;
				const db = clienteSobre(sql);

				// 1) Esquema real + siembra del caso (idéntica al lado Rust).
				crearEsquemaTenant(sql);
				for (const s of (caso as any).seed) sql.exec(s);

				// 2) El comando por su camino real.
				await aplicarComando(hub, sql, db, caso);

				// 3) Estado resultante frente al golden, tabla a tabla.
				for (const [tabla, select] of Object.entries((caso as any).snapshot)) {
					const rs = await db.execute(select as string);
					const err = multiconjuntoIgual(rs.rows, (golden as any)[tabla]);
					expect(err, `${tabla}: ${err}`).toBeNull();
				}
			});
		});
	}
});
