// scripts/check-comandos-tauri.mjs
//
// Anti-drift de la frontera UI↔Rust: que todo comando que el frontend invoca por su NOMBRE exista
// de verdad en el `generate_handler!` de `lib.rs`. **ROMPE** si falta alguno.
//
// Por qué hace falta un script y no basta con TypeScript: el nombre del comando es una cadena. Los
// tipos que cruzan la frontera sí están cerrados (ts-rs genera `bindings.ts` desde los DTO de Rust),
// pero el nombre no lo mira nadie. Renombrar un `#[tauri::command]` compila en Rust, compila en
// TypeScript, y la pantalla que lo llamaba revienta en tiempo de ejecución con "command not found"
// — en el equipo del cliente, no aquí.
//
// Es la misma clase de comprobación que `check-migration-registry.mjs` para las migraciones: barata,
// en CI, y cubre lo que el compilador no puede ver.
//
// Lo que NO puede comprobar: las invocaciones cuyo nombre es una variable. Se cuentan y se dicen,
// para que el hueco sea visible en vez de silencioso.
//
// Uso: node scripts/check-comandos-tauri.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Dónde se registran los comandos. */
const LIB_RS = join(raiz, "apps", "tpv-main", "src-tauri", "src", "lib.rs");

/** Dónde se invocan. El E2E entra: si un comando se renombra, el recorrido tiene que enterarse. */
const FUENTES = [
	join(raiz, "apps", "tpv-main", "src"),
	join(raiz, "apps", "tpv-main", "e2e"),
	join(raiz, "packages", "client", "src"),
];

const IGNORADAS = new Set(["node_modules", "dist", "target", "fallos"]);

/**
 * Cualquier función cuyo nombre empiece por `invoke` (así entran `invoke`, `invokeClient` y el
 * `invokeLocalSmart` local de las fichas de trabajador) más el `leerDeLaApp` del E2E. El nombre
 * puede ir en la línea siguiente, y en medio puede haber genéricos: `invokeLocalSmart<Rol[]>(\n
 * "trabajadores_get_roles"`.
 */
const LLAMADA = /\b(invoke[A-Za-z0-9_$]*|leerDeLaApp)\s*(?:<[^()]*?>)?\s*\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;

/** Una invocación cuyo primer argumento NO es una cadena literal: el punto ciego del script. */
const LLAMADA_DINAMICA = /\b(invoke[A-Za-z0-9_$]*|leerDeLaApp)\s*(?:<[^()]*?>)?\s*\(\s*(?!["'`)])[A-Za-z_$]/g;

function ficheros(dir) {
	const out = [];
	const visitar = (d) => {
		for (const entrada of readdirSync(d)) {
			if (IGNORADAS.has(entrada)) continue;
			const p = join(d, entrada);
			if (statSync(p).isDirectory()) visitar(p);
			else if (/\.(ts|tsx)$/.test(p)) out.push(p);
		}
	};
	try {
		visitar(dir);
	} catch {
		/* una raíz que no existe no es un error: el repo puede no tener E2E montado */
	}
	return out;
}

/** Los nombres del `generate_handler!`, quedándose con el último segmento de `commands::x::y`. */
function comandosRegistrados() {
	const fuente = readFileSync(LIB_RS, "utf8");
	const i = fuente.indexOf("generate_handler!");
	if (i === -1) {
		console.error(`\n  ✖ No encuentro generate_handler! en ${relative(raiz, LIB_RS)}\n`);
		process.exit(1);
	}

	// Del `[` al `]` que lo cierra, contando corchetes por si algún día hay anidamiento.
	const inicio = fuente.indexOf("[", i);
	let nivel = 0;
	let fin = inicio;
	for (; fin < fuente.length; fin++) {
		if (fuente[fin] === "[") nivel++;
		else if (fuente[fin] === "]" && --nivel === 0) break;
	}

	const bloque = fuente.slice(inicio + 1, fin);
	const nombres = new Set();
	for (const trozo of bloque.split(",")) {
		// Fuera comentarios de línea y espacios; `commands::mesas::mesas_meta_all` → `mesas_meta_all`.
		//
		// El comentario se corta con `/\/\/.*/` y NO con `$`: los finales de línea son `\r\n`, y `$`
		// sin la bandera `m` sólo casa el final de la cadena, así que el `\r` dejaba el comentario
		// intacto y se llevaba por delante el comando que va justo después de cada `// sección`.
		const limpio = trozo
			.split("\n")
			.map((l) => l.replace(/\/\/.*/, "").trim())
			.filter(Boolean)
			.join("");
		if (!limpio) continue;
		const nombre = limpio.split("::").pop();
		if (/^[a-z][a-z0-9_]*$/.test(nombre)) nombres.add(nombre);
	}
	return nombres;
}

/* ── Recuento ─────────────────────────────────────────────────────────────── */

const registrados = comandosRegistrados();

/** nombre → [ "ruta:línea", … ] */
const invocados = new Map();
/** Dónde queda el punto ciego: se enseñan una a una, para poder mirarlas. */
const dinamicas = [];

/**
 * Nombres de comando que aparecen como cadena en algún sitio, aunque no sea en la posición de
 * argumento (`forceNow ? "license_check_now" : "license_gate"`). No sirven para la comprobación
 * dura —no se sabe si de verdad se invocan— pero sí para no acusar de muertos a comandos que se
 * usan de esa forma.
 */
const mencionados = new Set();

for (const raizFuente of FUENTES) {
	for (const fichero of ficheros(raizFuente)) {
		const texto = readFileSync(fichero, "utf8");
		const rel = relative(raiz, fichero).replace(/\\/g, "/");

		for (const m of texto.matchAll(LLAMADA)) {
			const linea = texto.slice(0, m.index).split("\n").length;
			const lista = invocados.get(m[2]) ?? [];
			lista.push(`${rel}:${linea}`);
			invocados.set(m[2], lista);
		}
		for (const m of texto.matchAll(LLAMADA_DINAMICA)) {
			// `function invokeClient<T>(command, …)` es la DECLARACIÓN del envoltorio, no una
			// invocación: contarla inflaría el número que este script publica como punto ciego.
			if (/\bfunction\s+$/.test(texto.slice(Math.max(0, m.index - 12), m.index))) continue;
			dinamicas.push(`${rel}:${texto.slice(0, m.index).split("\n").length}`);
		}
		for (const m of texto.matchAll(/["'`]([a-z][a-z0-9_]*)["'`]/g)) {
			if (registrados.has(m[1])) mencionados.add(m[1]);
		}
	}
}

const huerfanos = [...invocados.keys()].filter((c) => !registrados.has(c)).sort();
const sinUsar = [...registrados]
	.filter((c) => !invocados.has(c) && !mencionados.has(c))
	.sort();

/* ── Informe ──────────────────────────────────────────────────────────────── */

console.log(
	`\n  Comandos Tauri: ${registrados.size} registrados · ${invocados.size} invocados por nombre` +
		` · ${dinamicas.length} con nombre variable\n`,
);

if (dinamicas.length) {
	// El punto ciego, con nombre y apellidos: aquí el comando es una variable, así que este script
	// no puede saber cuál es. Verlas una a una es lo que impide que crezcan sin que nadie mire.
	console.log("  Invocaciones con nombre variable (fuera del alcance de esta comprobación):");
	for (const donde of dinamicas) console.log(`    ${donde}`);
	console.log("");
}

if (sinUsar.length) {
	// Informativo: muchos son legítimos (la Handy lee por REST, y algunos comandos sólo los usa
	// otro comando). Aquí sólo se enseñan, porque es donde asoma el código muerto.
	console.log(`  Registrados que el frontend no invoca por nombre (${sinUsar.length}):`);
	console.log(`    ${sinUsar.join(", ")}\n`);
}

if (huerfanos.length) {
	console.error("  ✖ El frontend invoca comandos que NO están registrados en generate_handler!:\n");
	for (const cmd of huerfanos) {
		console.error(`    ${cmd}`);
		for (const donde of invocados.get(cmd)) console.error(`      ${donde}`);
	}
	console.error(
		"\n  Eso es un 'command not found' en tiempo de ejecución, en el equipo del cliente.\n",
	);
	process.exit(1);
}

console.log("  ✔ Todos los comandos invocados por nombre están registrados.\n");
