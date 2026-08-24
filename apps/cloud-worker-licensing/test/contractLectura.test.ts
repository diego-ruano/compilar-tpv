// test/contractLectura.test.ts
//
// Tests de contrato de LECTURA Main(Rust) ↔ worker(TS) — CLI-05 / ARCH-01.
// Ver `tests/contract/README.md` y el lado canónico en `crates/tpv-infra-sqlite/src/contract_read_tests.rs`.
//
// El hermano de `contract.test.ts`: aquel fija las escrituras (mismo comando → mismas filas), éste
// fija las lecturas (mismas filas → mismo resultado devuelto). Aquí se siembra el MISMO estado que
// el lado Rust, se corre LA consulta de este worker y se comprueba que devuelve exactamente lo que
// devolvió el repositorio SQLite de la Main.
//
// **El orden importa.** Es la diferencia de fondo con el harness de escritura, que compara las filas
// como multiconjunto porque el orden en el que queden en la tabla no es parte del contrato. Una
// lectura, en cambio, es una lista que se pinta en la pantalla en ese orden: dos implementaciones
// que devuelvan lo mismo desordenado NO son equivalentes. Se compara por secuencia.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { form as clienteForm, overview } from "../src/domains/clientes/clientes.queries";
import {
	entradas,
	resumen as resumenCuentas,
	salidas,
} from "../src/domains/cuentas/cuentas.queries";
import {
	listProductosByCategoria,
	resumen as resumenInventario,
} from "../src/domains/inventario/inventario.queries";
import { lineas as lineasMesa } from "../src/domains/mesas/mesas.queries";
import { getMisTareas, getTareasAdmin } from "../src/domains/tareas/tareas.queries";
import { asignacionesSemana } from "../src/domains/trabajadores/trabajadores.queries";
import {
	lineas as lineasBarra,
	listComandas,
} from "../src/domains/venta_rapida/venta_rapida.queries";

// Casos del harness. Los goldens los bendice Rust (lado canónico). Añadir uno: crear el fixture,
// bendecir su golden y sumar aquí su par caso/golden (workerd no lee del disco: los imports son
// estáticos y esbuild los empaqueta). La misma lista, en Rust, es la macro `lecturas_de_contrato!`.
import casoCliReciente from "../../../tests/contract/lecturas/casos/clientes/overview_reciente.json";
import goldenCliReciente from "../../../tests/contract/lecturas/golden/clientes/overview_reciente.json";
import casoCliReservas from "../../../tests/contract/lecturas/casos/clientes/overview_por_reservas.json";
import goldenCliReservas from "../../../tests/contract/lecturas/golden/clientes/overview_por_reservas.json";
import casoCliGasto from "../../../tests/contract/lecturas/casos/clientes/overview_por_gasto.json";
import goldenCliGasto from "../../../tests/contract/lecturas/golden/clientes/overview_por_gasto.json";
import casoCliForm from "../../../tests/contract/lecturas/casos/clientes/form.json";
import goldenCliForm from "../../../tests/contract/lecturas/golden/clientes/form.json";
import casoCtaEntradas from "../../../tests/contract/lecturas/casos/cuentas/entradas.json";
import goldenCtaEntradas from "../../../tests/contract/lecturas/golden/cuentas/entradas.json";
import casoCtaEntradasPag from "../../../tests/contract/lecturas/casos/cuentas/entradas_busqueda_paginada.json";
import goldenCtaEntradasPag from "../../../tests/contract/lecturas/golden/cuentas/entradas_busqueda_paginada.json";
import casoCtaSalidas from "../../../tests/contract/lecturas/casos/cuentas/salidas.json";
import goldenCtaSalidas from "../../../tests/contract/lecturas/golden/cuentas/salidas.json";
import casoCtaResumen from "../../../tests/contract/lecturas/casos/cuentas/resumen.json";
import goldenCtaResumen from "../../../tests/contract/lecturas/golden/cuentas/resumen.json";
import casoInvProductos from "../../../tests/contract/lecturas/casos/inventario/productos_por_categoria.json";
import goldenInvProductos from "../../../tests/contract/lecturas/golden/inventario/productos_por_categoria.json";
import casoInvResumen from "../../../tests/contract/lecturas/casos/inventario/resumen.json";
import goldenInvResumen from "../../../tests/contract/lecturas/golden/inventario/resumen.json";
import casoMesaLineas from "../../../tests/contract/lecturas/casos/mesas/lineas_comanda.json";
import goldenMesaLineas from "../../../tests/contract/lecturas/golden/mesas/lineas_comanda.json";
import casoVrComandas from "../../../tests/contract/lecturas/casos/venta_rapida/comandas_barra.json";
import goldenVrComandas from "../../../tests/contract/lecturas/golden/venta_rapida/comandas_barra.json";
import casoVrLineas from "../../../tests/contract/lecturas/casos/venta_rapida/lineas_comanda.json";
import goldenVrLineas from "../../../tests/contract/lecturas/golden/venta_rapida/lineas_comanda.json";
import casoTareasAdmin from "../../../tests/contract/lecturas/casos/tareas/admin.json";
import goldenTareasAdmin from "../../../tests/contract/lecturas/golden/tareas/admin.json";
import casoTareasMias from "../../../tests/contract/lecturas/casos/tareas/mias.json";
import goldenTareasMias from "../../../tests/contract/lecturas/golden/tareas/mias.json";
import casoHorSemana from "../../../tests/contract/lecturas/casos/trabajadores/asignaciones_semana.json";
import goldenHorSemana from "../../../tests/contract/lecturas/golden/trabajadores/asignaciones_semana.json";
import casoHorSemanaDef from "../../../tests/contract/lecturas/casos/trabajadores/asignaciones_semana_con_predeterminado.json";
import goldenHorSemanaDef from "../../../tests/contract/lecturas/golden/trabajadores/asignaciones_semana_con_predeterminado.json";

const CASOS = [
	{ nombre: "clientes_overview_reciente", caso: casoCliReciente, golden: goldenCliReciente },
	{ nombre: "clientes_overview_por_reservas", caso: casoCliReservas, golden: goldenCliReservas },
	{ nombre: "clientes_overview_por_gasto", caso: casoCliGasto, golden: goldenCliGasto },
	{ nombre: "clientes_form", caso: casoCliForm, golden: goldenCliForm },
	{ nombre: "cuentas_entradas", caso: casoCtaEntradas, golden: goldenCtaEntradas },
	{
		nombre: "cuentas_entradas_busqueda_paginada",
		caso: casoCtaEntradasPag,
		golden: goldenCtaEntradasPag,
	},
	{ nombre: "cuentas_salidas", caso: casoCtaSalidas, golden: goldenCtaSalidas },
	{ nombre: "cuentas_resumen", caso: casoCtaResumen, golden: goldenCtaResumen },
	{
		nombre: "inventario_productos_por_categoria",
		caso: casoInvProductos,
		golden: goldenInvProductos,
	},
	{ nombre: "inventario_resumen", caso: casoInvResumen, golden: goldenInvResumen },
	{ nombre: "mesas_lineas_comanda", caso: casoMesaLineas, golden: goldenMesaLineas },
	{ nombre: "venta_rapida_comandas_barra", caso: casoVrComandas, golden: goldenVrComandas },
	{ nombre: "venta_rapida_lineas_comanda", caso: casoVrLineas, golden: goldenVrLineas },
	{ nombre: "tareas_admin", caso: casoTareasAdmin, golden: goldenTareasAdmin },
	{ nombre: "tareas_mias", caso: casoTareasMias, golden: goldenTareasMias },
	{ nombre: "trabajadores_asignaciones_semana", caso: casoHorSemana, golden: goldenHorSemana },
	{
		nombre: "trabajadores_asignaciones_semana_con_predeterminado",
		caso: casoHorSemanaDef,
		golden: goldenHorSemanaDef,
	},
];

// ── Comparación estructural ORDENADA (misma spec que el lado Rust) ───────────────────

const TOL = 1e-9;

const aNumero = (v: any): number => (typeof v === "bigint" ? Number(v) : v);

function celdaIgual(a: any, b: any): boolean {
	if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
	const numericos =
		["number", "bigint"].includes(typeof a) || ["number", "bigint"].includes(typeof b);
	if (numericos) return Math.abs(aNumero(a) - aNumero(b)) < TOL;
	return a === b;
}

/**
 * Claves con valor no nulo, ordenadas.
 *
 * Un `null` y una clave ausente cuentan como lo mismo, y no por laxitud: en producción esta
 * respuesta la deserializa `tpv-infra-http` dentro del DTO, y un `Option<T>` de serde acepta las dos
 * formas. Exigir que coincidan sería inventarse un requisito que el sistema real no tiene.
 */
function clavesUtiles(o: any): string[] {
	return Object.keys(o)
		.filter((k) => o[k] !== null && o[k] !== undefined)
		.sort();
}

/** Devuelve el error encontrado, o `null` si son estructuralmente iguales. Los arrays van EN ORDEN. */
function valorIgual(a: any, b: any): string | null {
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return `uno es lista y el otro no`;
		if (a.length !== b.length) {
			return `${a.length} elementos frente a ${b.length} esperados`;
		}
		for (let i = 0; i < a.length; i++) {
			const e = valorIgual(a[i], b[i]);
			if (e) return `[${i}] ${e}`;
		}
		return null;
	}

	const objetos =
		a !== null && b !== null && typeof a === "object" && typeof b === "object";
	if (objetos) {
		const ka = clavesUtiles(a);
		const kb = clavesUtiles(b);
		if (ka.join(",") !== kb.join(",")) {
			return `campos [${ka}] frente a [${kb}]`;
		}
		for (const k of ka) {
			const e = valorIgual(a[k], b[k]);
			if (e) return `.${k} ${e}`;
		}
		return null;
	}

	return celdaIgual(a, b) ? null : `${JSON.stringify(a)} frente a ${JSON.stringify(b)}`;
}

/** Corre la lectura del caso por su camino real. El `switch` es el punto de extensión: una lectura
 *  nueva añade su brazo aquí y en el lado Rust (`ejecutar_lectura`). */
async function ejecutarLectura(db: any, caso: any): Promise<any> {
	const e = caso.entrada ?? {};
	switch (caso.lectura) {
		case "clientes.overview":
			return overview(db, e.ranking);
		case "clientes.form":
			return clienteForm(db, e.id_cliente);
		case "cuentas.entradas":
			return entradas(db, e.del ?? null, e.al ?? null, e.q ?? null, e.page ?? null, e.page_size ?? null);
		case "cuentas.salidas":
			return salidas(db, e.del ?? null, e.al ?? null, e.q ?? null, e.page ?? null, e.page_size ?? null);
		case "cuentas.resumen":
			return resumenCuentas(db, e.del ?? null, e.al ?? null, e.q ?? null);
		case "inventario.productos_por_categoria":
			return listProductosByCategoria(db, e.id_categoria);
		case "inventario.resumen":
			return resumenInventario(db, e.limit);
		case "mesas.lineas_comanda":
			return lineasMesa(db, e.id_comanda);
		case "venta_rapida.comandas_barra":
			return listComandas(db, e.include_pagadas, e.limit);
		case "venta_rapida.lineas_comanda":
			return lineasBarra(db, e.id_comanda);
		case "tareas.admin":
			return getTareasAdmin(db);
		case "tareas.mias":
			return getMisTareas(db, e.id_trabajador);
		case "trabajadores.asignaciones_semana":
			return asignacionesSemana(db, e.fecha_lunes);
		default:
			throw new Error(`lectura sin soporte en el harness de contrato: ${caso.lectura}`);
	}
}

describe("contrato de lectura Main↔worker · resultado == golden", () => {
	for (const { nombre, caso, golden } of CASOS) {
		it(`${nombre}: devuelve lo mismo que la Main`, async () => {
			await enElHub(`contract-lectura-${nombre}`, async (hub: any) => {
				const sql = hub.state.storage.sql;
				const db = clienteSobre(sql);

				// 1) Esquema real + siembra del caso (idéntica al lado Rust).
				crearEsquemaTenant(sql);
				for (const s of (caso as any).seed) sql.exec(s);

				// 2) La consulta por su camino real.
				const obtenido = await ejecutarLectura(db, caso);

				// 3) Resultado frente al golden que bendijo Rust.
				const err = valorIgual(obtenido, golden);
				expect(err, `${nombre}: ${err}`).toBeNull();
			});
		});
	}
});
