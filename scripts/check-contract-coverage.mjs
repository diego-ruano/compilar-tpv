// scripts/check-contract-coverage.mjs
//
// Cobertura de los harness de tests de contrato (ARCH-01 / CLI-05). **AVISA, NO ROMPE.**
//
// Los harness (tests/contract/) fijan que Rust y el worker se comporten igual en los caminos que
// tienen caso. Su punto débil es lo que NO tiene caso: la cobertura es una lista escrita a mano, así
// que algo nuevo —que es justo cuando más fácil es que las dos implementaciones nazcan distintas—
// entra sin caso y **nadie se entera**. Este script lo hace visible, para las dos vertientes:
//
//   ESCRITURA (mismo comando → mismas filas)
//     universo  = cada `export function` de domains/*/*.commands.ts
//                 (si el worker construye SQL para algo, ese algo está implementado dos veces)
//     cubierto  = los builders que test/contract.test.ts importa Y usa
//
//   LECTURA (mismas filas → mismo resultado devuelto)
//     universo  = cada `export function` de domains/*/*.queries.ts **que sirve a un GET**.
//                 El recorte no es cosmético: la mitad de los `*.queries.ts` son comprobaciones
//                 previas de una escritura (`cobrarPlan`, `datosDeLinea`, `hasPaidLines`, el
//                 throttle del login…), que ya viajan dentro del harness de escritura al correr su
//                 comando. Lo que la Handy LEE es lo que cuelga de un GET, y eso es lo que tiene
//                 una segunda implementación en `tpv-infra-sqlite` con la que poder discrepar.
//     cubierto  = las consultas que test/contractLectura.test.ts importa Y usa
//
//   excluido  = lo listado con motivo en el `cobertura.json` de cada vertiente
//   pendiente = universo − cubierto − excluido   ← esto es lo que se avisa
//
// **Sale SIEMPRE con código 0**: no debe tumbar CI. Algo sin contrastar es una deuda que hay que
// ver, no un push que haya que bloquear. En GitHub Actions escribe anotaciones `::warning::` (salen
// en la pestaña de checks y junto al fichero en el PR) y una tabla en el resumen del job.
//
// Uso: node scripts/check-contract-coverage.mjs
//      node scripts/check-contract-coverage.mjs --estricto   (sale 1 si hay pendientes; para uso
//                                                             manual, NO se usa en CI)

import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const domainsDir = join(root, "apps", "cloud-worker-licensing", "src", "domains");
const testDir = join(root, "apps", "cloud-worker-licensing", "test");

const estricto = process.argv.includes("--estricto");
const enGitHub = Boolean(process.env.GITHUB_ACTIONS);

const VERTIENTES = [
	{
		id: "escritura",
		titulo: "escritura (mismo comando → mismas filas)",
		sufijo: ".commands.ts",
		modulo: "commands",
		unidad: "comandos",
		soloSiEnRuta: false,
		testFile: join(testDir, "contract.test.ts"),
		coberturaFile: join(root, "tests", "contract", "cobertura.json"),
		comoArreglar:
			"Añade un caso en tests/contract/ o documenta por qué no aplica en tests/contract/cobertura.json.",
	},
	{
		id: "lectura",
		titulo: "lectura (mismas filas → mismo resultado devuelto)",
		sufijo: ".queries.ts",
		modulo: "queries",
		unidad: "lecturas",
		soloSiEnRuta: true,
		testFile: join(testDir, "contractLectura.test.ts"),
		coberturaFile: join(root, "tests", "contract", "lecturas", "cobertura.json"),
		comoArreglar:
			"Añade un caso en tests/contract/lecturas/ o documenta por qué no aplica en " +
			"tests/contract/lecturas/cobertura.json.",
	},
];

/**
 * Tramos de un `*.routes.ts` que son el cuerpo de un handler **GET**.
 *
 * El recorte importa: sólo un GET es una lectura que la Handy pide. Las demás consultas de un
 * `*.queries.ts` son comprobaciones previas de una escritura —el plan de un cobro, un "¿ya existe
 * este email?", el throttle del login— y ésas ya viajan dentro del harness de escritura, que las
 * ejecuta al correr su comando. Contarlas aquí llenaría el aviso de deuda que no existe, y un aviso
 * que nadie puede vaciar deja de leerse.
 */
function tramosGet(srcRutas) {
	const handlers = [
		...srcRutas.matchAll(/\b[A-Za-z0-9_$]*Routes\.(get|post|put|patch|delete)\s*\(/g),
	];
	return handlers
		.map((h, i) => ({
			verbo: h[1],
			desde: h.index,
			hasta: i + 1 < handlers.length ? handlers[i + 1].index : srcRutas.length,
		}))
		.filter((t) => t.verbo === "get");
}

/**
 * ¿La sirve algún GET del dominio?
 *
 * Los `*.routes.ts` importan sus consultas con un namespace (`import * as q from "./x.queries"`),
 * así que se busca `q.<nombre>` dentro del cuerpo de un GET. Se resuelve el alias en vez de darlo
 * por hecho: si mañana alguien importa `as consultas`, esto lo sigue viendo. Un import con nombres
 * sueltos también cuenta.
 */
function laSirveUnGet(srcRutas, dominio, nombre) {
	if (!srcRutas) return false;

	const usados = [];

	const nsRe = new RegExp(
		`import\\s*\\*\\s*as\\s+([A-Za-z0-9_$]+)\\s*from\\s*["']\\./${dominio}\\.queries["']`,
		"g",
	);
	for (const m of srcRutas.matchAll(nsRe)) usados.push(`${m[1]}.${nombre}`);

	const namedRe = new RegExp(
		`import\\s*\\{([^}]+)\\}\\s*from\\s*["']\\./${dominio}\\.queries["']`,
		"g",
	);
	for (const m of srcRutas.matchAll(namedRe)) {
		for (const trozo of m[1].split(",")) {
			const [orig, alias] = trozo.trim().split(/\s+as\s+/).map((x) => x.trim());
			if (orig === nombre) usados.push(alias || orig);
		}
	}
	if (!usados.length) return false;

	return tramosGet(srcRutas).some((t) => {
		const cuerpo = srcRutas.slice(t.desde, t.hasta);
		return usados.some((u) => new RegExp(`${u.replace(".", "\\.")}\\s*\\(`).test(cuerpo));
	});
}

// ── 1. Universo ─────────────────────────────────────────────────────────────────
function universoDe(v) {
	const salida = [];
	for (const dominio of readdirSync(domainsDir, { withFileTypes: true })) {
		if (!dominio.isDirectory()) continue;
		const dir = join(domainsDir, dominio.name);

		const rutasFile = join(dir, `${dominio.name}.routes.ts`);
		const srcRutas = existsSync(rutasFile) ? readFileSync(rutasFile, "utf8") : "";

		for (const fichero of readdirSync(dir)) {
			if (!fichero.endsWith(v.sufijo)) continue;
			const ruta = join(dir, fichero);
			const src = readFileSync(ruta, "utf8");
			for (const m of src.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
				const nombre = m[1];
				if (v.soloSiEnRuta && !laSirveUnGet(srcRutas, dominio.name, nombre)) continue;
				salida.push({
					dominio: dominio.name,
					nombre,
					clave: `${dominio.name}.${nombre}`,
					ruta: relative(root, ruta).replaceAll("\\", "/"),
				});
			}
		}
	}
	return salida.sort((a, b) => a.clave.localeCompare(b.clave));
}

// ── 2. Cubierto: lo que el test del worker importa y usa ────────────────────────
// Se mira el import (no el nombre del caso) a propósito: es la única señal fiable de que la
// implementación REAL se ejecuta. Los nombres lógicos de los casos (`clientes.crear`) no siguen el
// nombre de la función (`createCliente`), así que casarlos por convención daría falsos positivos.
function cubiertosDe(v) {
	if (!existsSync(v.testFile)) return new Set();
	const src = readFileSync(v.testFile, "utf8");
	const cubiertos = new Set();

	const importRe = new RegExp(
		`import\\s*\\{([^}]+)\\}\\s*from\\s*["']\\.\\./src/domains/([^/]+)/[^"']+\\.${v.modulo}["']`,
		"g",
	);
	for (const m of src.matchAll(importRe)) {
		const dominio = m[2];
		for (const trozo of m[1].split(",")) {
			// `addLinea as addLineaMesa` → la función es `addLinea`; el alias es cosa del test.
			const nombre = trozo.trim().split(/\s+as\s+/)[0].trim();
			if (!nombre) continue;
			// Un import que nadie usa no cubre nada: se exige que el identificador (o su alias)
			// aparezca además en el cuerpo del test.
			const usado = trozo.trim().split(/\s+as\s+/).pop().trim();
			const apariciones = src.split(new RegExp(`\\b${usado}\\b`)).length - 1;
			if (apariciones > 1) cubiertos.add(`${dominio}.${nombre}`);
		}
	}
	return cubiertos;
}

// ── 3. Excluido con motivo ──────────────────────────────────────────────────────
function exclusionesDe(v) {
	if (!existsSync(v.coberturaFile)) return {};
	const json = JSON.parse(readFileSync(v.coberturaFile, "utf8"));
	return json.exclusiones ?? {};
}

// ── 4. Informe ──────────────────────────────────────────────────────────────────
const avisos = [];
const resumenes = [];
let hayPendientes = false;

for (const v of VERTIENTES) {
	const universo = universoDe(v);
	const cubiertos = cubiertosDe(v);
	const excluidos = exclusionesDe(v);

	const pendientes = universo.filter((b) => !cubiertos.has(b.clave) && !(b.clave in excluidos));
	const obsoletas = Object.keys(excluidos).filter(
		(clave) => !universo.some((b) => b.clave === clave) || cubiertos.has(clave),
	);

	for (const b of pendientes) {
		avisos.push({
			ruta: b.ruta,
			titulo: `Test de contrato de ${v.id} pendiente`,
			texto:
				`Sin test de contrato de ${v.id}: '${b.clave}'. Tiene una segunda implementación en ` +
				`Rust, así que una divergencia entre las dos no la detecta nadie. ${v.comoArreglar}`,
		});
	}
	for (const clave of obsoletas) {
		avisos.push({
			ruta: relative(root, v.coberturaFile).replaceAll("\\", "/"),
			titulo: `Exclusión obsoleta (${v.id})`,
			texto:
				`Exclusión obsoleta: '${clave}' ya no hace falta (no existe o ya tiene caso de ` +
				`contrato). Bórrala para que la lista siga diciendo la verdad.`,
		});
	}

	const total = universo.length;
	const nCubiertos = universo.filter((b) => cubiertos.has(b.clave)).length;
	const pct = total ? Math.round((nCubiertos / total) * 100) : 100;
	const nExcluidos = Object.keys(excluidos).length;

	console.log(
		`Contrato de ${v.id}: ${nCubiertos}/${total} ${v.unidad} (${pct}%), ` +
			`${nExcluidos} excluido(s) con motivo, ${pendientes.length} sin cubrir.`,
	);
	if (pendientes.length) {
		console.log("  Sin cubrir:");
		for (const b of pendientes) console.log(`    - ${b.clave}  (${b.ruta})`);
	}
	if (obsoletas.length) {
		console.log("  Exclusiones obsoletas:");
		for (const c of obsoletas) console.log(`    - ${c}`);
	}

	if (pendientes.length || obsoletas.length) hayPendientes = true;
	resumenes.push({ v, total, nCubiertos, pct, nExcluidos, pendientes, obsoletas });
}

if (enGitHub) {
	// Anotaciones: salen en el PR sin marcar el job en rojo.
	for (const a of avisos) {
		console.log(`::warning file=${a.ruta},title=${a.titulo}::${a.texto.replaceAll("\n", " ")}`);
	}

	const resumen = process.env.GITHUB_STEP_SUMMARY;
	if (resumen) {
		const filas = ["### Cobertura de los harness de contrato (ARCH-01 / CLI-05)", ""];
		for (const r of resumenes) {
			filas.push(
				`#### ${r.v.titulo}`,
				"",
				`**${r.nCubiertos}/${r.total}** ${r.v.unidad} contrastadas (${r.pct}%) · ` +
					`${r.nExcluidos} excluidas con motivo · **${r.pendientes.length} sin cubrir**`,
				"",
			);
			if (r.pendientes.length) {
				filas.push("| Qué | Dónde |", "|---|---|");
				for (const b of r.pendientes) filas.push(`| \`${b.clave}\` | ${b.ruta} |`);
				filas.push("");
			} else {
				filas.push("Todo lo que tiene doble implementación tiene caso o exclusión documentada.", "");
			}
			if (r.obsoletas.length) {
				filas.push(
					"**Exclusiones obsoletas:** " + r.obsoletas.map((c) => `\`${c}\``).join(", "),
					"",
				);
			}
		}
		filas.push("_Avisa, no rompe: son deuda visible, no un motivo para bloquear el push._");
		appendFileSync(resumen, filas.join("\n") + "\n");
	}
}

// SIEMPRE 0 salvo que se pida --estricto a mano: este chequeo informa, no bloquea.
process.exit(estricto && hayPendientes ? 1 : 0);
