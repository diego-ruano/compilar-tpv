// scripts/check-contract-coverage.mjs
//
// Cobertura del harness de tests de contrato (ARCH-01). **AVISA, NO ROMPE.**
//
// El harness (tests/contract/) fija que Rust y el worker dejen el mismo efecto para los comandos
// que tienen caso. Su punto débil es lo que NO tiene caso: hoy la cobertura es una lista escrita a
// mano en dos ficheros, así que un comando nuevo —que es justo cuando más fácil es que las dos
// implementaciones nazcan distintas— entra sin caso y **nadie se entera**. Este script lo hace
// visible:
//
//   universo   = cada `export function` de apps/cloud-worker-licensing/src/domains/*/*.commands.ts
//                (si el worker construye SQL para algo, ese algo está implementado dos veces)
//   cubierto   = los builders que el test del worker (test/contract.test.ts) importa y usa
//   excluido   = lo listado con motivo en tests/contract/cobertura.json
//   pendiente  = universo − cubierto − excluido   ← esto es lo que se avisa
//
// **Sale SIEMPRE con código 0**: no debe tumbar CI. Un comando sin contrastar es una deuda que hay
// que ver, no un push que haya que bloquear. En GitHub Actions escribe anotaciones `::warning::`
// (salen en la pestaña de checks y junto al fichero en el PR) y una tabla en el resumen del job.
//
// Uso: node scripts/check-contract-coverage.mjs
//      node scripts/check-contract-coverage.mjs --estricto   (sale 1 si hay pendientes; para uso
//                                                             manual, NO se usa en CI)

import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const domainsDir = join(root, "apps", "cloud-worker-licensing", "src", "domains");
const testFile = join(root, "apps", "cloud-worker-licensing", "test", "contract.test.ts");
const coberturaFile = join(root, "tests", "contract", "cobertura.json");

const estricto = process.argv.includes("--estricto");
const enGitHub = Boolean(process.env.GITHUB_ACTIONS);

// ── 1. Universo: los command builders del worker ────────────────────────────────
// Un `*.commands.ts` contiene, por convención del repo, los constructores de sentencias
// replicables de su dominio. Se leen los `export function`; los `export type`/`export const` no
// son comandos y quedan fuera solos.
function buildersDelWorker() {
	const salida = [];
	for (const dominio of readdirSync(domainsDir, { withFileTypes: true })) {
		if (!dominio.isDirectory()) continue;
		const dir = join(domainsDir, dominio.name);
		for (const fichero of readdirSync(dir)) {
			if (!fichero.endsWith(".commands.ts")) continue;
			const ruta = join(dir, fichero);
			const src = readFileSync(ruta, "utf8");
			for (const m of src.matchAll(/^export function ([A-Za-z0-9_]+)/gm)) {
				salida.push({
					dominio: dominio.name,
					nombre: m[1],
					clave: `${dominio.name}.${m[1]}`,
					ruta: relative(root, ruta).replaceAll("\\", "/"),
				});
			}
		}
	}
	return salida.sort((a, b) => a.clave.localeCompare(b.clave));
}

// ── 2. Cubierto: lo que el test del worker importa de esos módulos ──────────────
// Se mira el import (no el nombre del caso) a propósito: es la única señal fiable de que el
// builder REAL se ejecuta. Los nombres lógicos de los casos (`clientes.crear`) no siguen el nombre
// de la función (`createCliente`), así que casarlos por convención daría falsos positivos.
function buildersCubiertos() {
	const src = readFileSync(testFile, "utf8");
	const cubiertos = new Set();

	const importRe = /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/src\/domains\/([^/]+)\/[^"']+\.commands["']/g;
	for (const m of src.matchAll(importRe)) {
		const dominio = m[2];
		for (const trozo of m[1].split(",")) {
			// `addLinea as addLineaMesa` → el builder es `addLinea`; el alias es cosa del test.
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
function exclusiones() {
	if (!existsSync(coberturaFile)) return {};
	const json = JSON.parse(readFileSync(coberturaFile, "utf8"));
	return json.exclusiones ?? {};
}

// ── 4. Informe ──────────────────────────────────────────────────────────────────
const universo = buildersDelWorker();
const cubiertos = buildersCubiertos();
const excluidos = exclusiones();

const pendientes = universo.filter((b) => !cubiertos.has(b.clave) && !(b.clave in excluidos));
const obsoletas = Object.keys(excluidos).filter(
	(clave) => !universo.some((b) => b.clave === clave) || cubiertos.has(clave),
);

const avisos = [];
for (const b of pendientes) {
	avisos.push({
		ruta: b.ruta,
		texto:
			`Sin test de contrato: '${b.clave}'. Tiene una segunda implementación en Rust, así que ` +
			`una divergencia entre las dos no la detecta nadie. Añade un caso en tests/contract/ o ` +
			`documenta por qué no aplica en tests/contract/cobertura.json.`,
	});
}
for (const clave of obsoletas) {
	avisos.push({
		ruta: relative(root, coberturaFile).replaceAll("\\", "/"),
		texto:
			`Exclusión obsoleta: '${clave}' en cobertura.json ya no hace falta (el comando ya no ` +
			`existe o ya tiene caso de contrato). Bórrala para que la lista siga diciendo la verdad.`,
	});
}

const total = universo.length;
const nCubiertos = universo.filter((b) => cubiertos.has(b.clave)).length;
const pct = total ? Math.round((nCubiertos / total) * 100) : 100;

console.log(
	`Cobertura del harness de contrato: ${nCubiertos}/${total} comandos (${pct}%), ` +
		`${Object.keys(excluidos).length} excluido(s) con motivo, ${pendientes.length} sin cubrir.`,
);

if (pendientes.length) {
	console.log("\nSin cubrir:");
	for (const b of pendientes) console.log(`  - ${b.clave}  (${b.ruta})`);
}
if (obsoletas.length) {
	console.log("\nExclusiones obsoletas:");
	for (const c of obsoletas) console.log(`  - ${c}`);
}

if (enGitHub) {
	// Anotaciones: salen en el PR sin marcar el job en rojo.
	for (const a of avisos) {
		const texto = a.texto.replaceAll("\n", " ");
		console.log(`::warning file=${a.ruta},title=Test de contrato pendiente::${texto}`);
	}

	const resumen = process.env.GITHUB_STEP_SUMMARY;
	if (resumen) {
		const filas = [
			"### Cobertura del harness de contrato (ARCH-01)",
			"",
			`**${nCubiertos}/${total}** comandos contrastados (${pct}%) · ` +
				`${Object.keys(excluidos).length} excluidos con motivo · **${pendientes.length} sin cubrir**`,
			"",
		];
		if (pendientes.length) {
			filas.push("| Comando | Dónde |", "|---|---|");
			for (const b of pendientes) filas.push(`| \`${b.clave}\` | ${b.ruta} |`);
			filas.push("", "_Avisa, no rompe: son deuda visible, no un motivo para bloquear el push._");
		} else {
			filas.push("Todo comando con doble implementación tiene caso o exclusión documentada.");
		}
		if (obsoletas.length) {
			filas.push("", "**Exclusiones obsoletas:** " + obsoletas.map((c) => `\`${c}\``).join(", "));
		}
		appendFileSync(resumen, filas.join("\n") + "\n");
	}
}

// SIEMPRE 0 salvo que se pida --estricto a mano: este chequeo informa, no bloquea.
process.exit(estricto && (pendientes.length || obsoletas.length) ? 1 : 0);
