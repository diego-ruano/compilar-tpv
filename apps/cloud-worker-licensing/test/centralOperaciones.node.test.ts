// test/centralOperaciones.node.test.ts
//
// Lo que tiene que ser verdad en el fuente de la base central, leído con el analizador de TypeScript
// (por eso corre en Node: workerd no puede cargarlo):
//
//   · Una operación (`server/central/operaciones/`) es síncrona de principio a fin, y también todo lo
//     que importa para ejecutarlo: ni `async`, ni `await`, ni promesas (`Promise`, `.then`, `.catch`,
//     `.finally`, un `import()`), ni temporizadores, ni `fetch` o `crypto.subtle`. Una espera dentro
//     abriría el objeto a otras llamadas a mitad de su transacción, y lo escrito después quedaría
//     fuera de ella sin avisar: es justo lo que la transacción existe para impedir.
//   · La central (`durableObjects/baseCentral*.ts` y sus operaciones) no llama a ningún otro objeto:
//     ni lo que importa ni lo que importa eso alcanza un `TenantHub` o una `AgendaWeb`. Lo que hay que
//     avisar después de escribir lo avisa quien llama, que puede esperar.
//
// Que nada abra una transacción interactiva contra la central no hace falta leerlo aquí: el cliente
// (`ClienteCentral`) no tiene con qué, y no compilaría.
//
// Los tipos (`import type`) y los comentarios no cuentan. El último bloque se lo comprueba al propio
// barrido con código inventado.

import ts from "typescript";
import { describe, expect, it } from "vitest";

const sinPrefijo = (fichero: string) => fichero.replace("../src/", "");

/** Todo el worker, menos los tipos generados de la plataforma. */
const todoElWorker: Record<string, string> = Object.fromEntries(
	Object.entries(import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true })).map(([f, t]) => [
		sinPrefijo(f),
		t as string,
	]),
);
delete todoElWorker["server/worker-configuration.d.ts"];

const CARPETA_DE_OPERACIONES = "server/central/operaciones/";
const operaciones = Object.keys(todoElWorker).filter((f) => f.startsWith(CARPETA_DE_OPERACIONES));
/** La central: su objeto y sus operaciones. */
const laCentral = [
	...Object.keys(todoElWorker).filter((f) => /^durableObjects\/baseCentral(\.[a-z]+)?\.ts$/.test(f)),
	...operaciones,
];

/** Lo que no puede alcanzar la central: los objetos de los negocios y lo que los pide. */
const OBJETOS_AJENOS = /^(durableObjects\/(tenantHub|agendaWeb)[^/]*\.ts|lib\/hub\.ts|lib\/objetosDelNegocio\.ts)$/;

const fuente = (fichero: string, texto: string) => ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);

function linea(sf: ts.SourceFile, n: ts.Node): number {
	return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

/** El nombre de una propiedad, se lea con punto (`x.then`) o con corchetes y un texto (`x["then"]`). */
function propiedad(n: ts.Node): string | null {
	if (ts.isPropertyAccessExpression(n)) return n.name.text;
	if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
	return null;
}

/** Lo que hace asíncrona a una operación. */
function esperasEn(fichero: string, texto: string): string[] {
	const sf = fuente(fichero, texto);
	const hallazgos: string[] = [];
	const raro = (motivo: string, n: ts.Node) => hallazgos.push(`${fichero}:${linea(sf, n)}: ${motivo}`);
	const ver = (n: ts.Node): void => {
		if (ts.isImportDeclaration(n) || ts.isTypeNode(n)) return;
		if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
			raro("una función `async`", n);
		}
		if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) raro("un `await`", n);
		if (ts.isIdentifier(n) && n.text === "Promise") raro("una `Promise`", n);
		const nombre = propiedad(n);
		if (nombre && /^(then|catch|finally)$/.test(nombre)) raro(`un \`.${nombre}\``, n);
		if (nombre === "subtle") raro("`crypto.subtle`", n);
		if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) raro("un `import()`", n);
		if (ts.isIdentifier(n) && /^(setTimeout|setInterval|queueMicrotask|scheduler|fetch)$/.test(n.text)) {
			raro(`\`${n.text}\``, n);
		}
		ts.forEachChild(n, ver);
	};
	ver(sf);
	return hallazgos;
}

/** El fichero de `src/` al que lleva `ruta` desde `fichero`, si es uno nuestro. */
function resolver(fichero: string, ruta: string): string | null {
	if (!ruta.startsWith(".")) return null;
	const partes = fichero.split("/").slice(0, -1);
	for (const trozo of ruta.replace(/\.js$/, "").split("/")) {
		if (trozo === "..") partes.pop();
		else if (trozo !== ".") partes.push(trozo);
	}
	const base = partes.join("/");
	return [`${base}.ts`, `${base}/index.ts`].find((f) => f in todoElWorker) ?? null;
}

/**
 * Los ficheros de `src/` que `fichero` carga para ejecutarlos (no sólo por sus tipos): los que importa,
 * los que reexporta (`export … from`) y los que importa al vuelo (`import("…")`).
 */
function importaDeVerdad(fichero: string, texto: string): string[] {
	const sf = fuente(fichero, texto);
	const destinos: string[] = [];
	const apuntar = (especificador: ts.Expression | undefined) => {
		if (!especificador || !ts.isStringLiteralLike(especificador)) return;
		const destino = resolver(fichero, especificador.text);
		if (destino) destinos.push(destino);
	};
	const ver = (n: ts.Node): void => {
		if (ts.isImportDeclaration(n)) {
			const clausula = n.importClause;
			const soloTipos =
				clausula?.isTypeOnly ||
				(clausula && !clausula.name && clausula.namedBindings && ts.isNamedImports(clausula.namedBindings) &&
					clausula.namedBindings.elements.every((e) => e.isTypeOnly));
			if (!soloTipos) apuntar(n.moduleSpecifier);
			return;
		}
		if (ts.isExportDeclaration(n)) {
			const soloTipos =
				n.isTypeOnly ||
				(n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.every((e) => e.isTypeOnly));
			if (!soloTipos) apuntar(n.moduleSpecifier);
			return;
		}
		if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) apuntar(n.arguments[0]);
		ts.forEachChild(n, ver);
	};
	ver(sf);
	return destinos;
}

/** Todo lo que alcanza `desde` importando de verdad, con el camino por el que llega a cada uno. */
function alcance(desde: string[]): Map<string, string[]> {
	const caminos = new Map<string, string[]>(desde.map((f) => [f, [f]]));
	const pendientes = [...desde];
	while (pendientes.length > 0) {
		const actual = pendientes.shift()!;
		for (const siguiente of importaDeVerdad(actual, todoElWorker[actual])) {
			if (caminos.has(siguiente)) continue;
			caminos.set(siguiente, [...caminos.get(actual)!, siguiente]);
			pendientes.push(siguiente);
		}
	}
	return caminos;
}

/** Lo que llama a otro objeto desde la central: su espacio de nombres o las puertas de los negocios. */
function llamadasAOtrosObjetos(fichero: string, texto: string): string[] {
	const sf = fuente(fichero, texto);
	const hallazgos: string[] = [];
	const ver = (n: ts.Node): void => {
		if (ts.isImportDeclaration(n) || ts.isTypeNode(n)) return;
		const nombre = propiedad(n) ?? (ts.isIdentifier(n) ? n.text : null);
		if (nombre && /^(TenantHub|AgendaWeb|hubDe|agendaDe|objetoDelNegocio|avisarCambioDeLicencia)$/.test(nombre)) {
			hallazgos.push(`${fichero}:${linea(sf, n)}: \`${nombre}\``);
		}
		ts.forEachChild(n, ver);
	};
	ver(sf);
	return hallazgos;
}

describe("las operaciones de la central son síncronas", () => {
	it("el barrido ha leído las operaciones y el objeto", () => {
		// Si los globs no encontraran nada, lo de abajo pasaría sin mirar nada.
		expect(operaciones).toEqual(expect.arrayContaining([`${CARPETA_DE_OPERACIONES}registro.ts`, `${CARPETA_DE_OPERACIONES}cobros.ts`]));
		expect(laCentral).toEqual(expect.arrayContaining(["durableObjects/baseCentral.ts", "durableObjects/baseCentral.operar.ts"]));
	});

	it("ni ellas ni lo que cargan esperan nada", () => {
		const alcanzados = [...alcance(operaciones).keys()];
		// Que el barrido sigue sus imports: las operaciones cargan cosas de fuera de su carpeta.
		expect(alcanzados.some((f) => !f.startsWith(CARPETA_DE_OPERACIONES))).toBe(true);
		expect(alcanzados.flatMap((f) => esperasEn(f, todoElWorker[f]))).toEqual([]);
	});
});

describe("la central no llama a otro objeto", () => {
	it("no alcanza un TenantHub, una AgendaWeb ni lo que los pide", () => {
		const alcanzados = alcance(laCentral);
		// Que el barrido sigue los imports: el objeto llega a sus operaciones y a su SQLite.
		expect([...alcanzados.keys()]).toEqual(
			expect.arrayContaining([`${CARPETA_DE_OPERACIONES}cobros.ts`, "durableObjects/sqliteDelObjeto.ts"]),
		);
		const ajenos = [...alcanzados].filter(([f]) => OBJETOS_AJENOS.test(f)).map(([, camino]) => camino.join(" → "));
		expect(ajenos).toEqual([]);
	});

	it("y nada de lo que alcanza nombra sus espacios de nombres ni sus puertas", () => {
		const alcanzados = [...alcance(laCentral).keys()];
		expect(alcanzados.flatMap((f) => llamadasAOtrosObjetos(f, todoElWorker[f]))).toEqual([]);
	});
});

describe("el barrido caza lo que tiene que cazar", () => {
	const enUnaOperacion = (codigo: string) => esperasEn(`${CARPETA_DE_OPERACIONES}inventada.ts`, codigo);

	it.each([
		["una función async", "export async function op(sql) { return 1; }"],
		["una flecha async", "export const op = async (sql) => 1;"],
		["un await", "function op(sql) { const r = await sql.execute('SELECT 1;'); return r; }"],
		["un for await", "function op(sql) { for await (const x of y) {} }"],
		["una promesa", "function op(sql) { return Promise.resolve(1); }"],
		["un then", "function op(sql) { sql.execute('SELECT 1;').then(() => 1); }"],
		["un then entre corchetes", "function op(p) { p['then'](() => 1); }"],
		["un catch", "function op(p) { p.catch(() => 1); }"],
		["un finally entre corchetes", 'function op(p) { p["finally"](() => 1); }'],
		["un temporizador", "function op(sql) { setTimeout(() => sql.execute('SELECT 1;'), 0); }"],
		["un fetch", "function op() { fetch('https://ejemplo.test'); }"],
		["crypto.subtle", "function op(b) { crypto.subtle.digest('SHA-256', b); }"],
		["un import al vuelo", "function op() { import('./otra'); }"],
	])("en una operación: %s", (_que, codigo) => {
		expect(enUnaOperacion(codigo), codigo).not.toEqual([]);
	});

	it.each([
		["una operación síncrona", "export function op(sql, d) { const r = sql.execute({ sql: 'SELECT 1;', args: [] }); return r.rows.length; }"],
		["un comentario", "// await sql.execute(); Promise.resolve(); setTimeout()\nexport function op() { return null; }"],
		["un texto", "export function op() { return 'await Promise then'; }"],
		["un tipo", "export function op(): Readonly<Record<string, unknown>> { return {}; }"],
		["un try con su catch", "export function op(sql) { try { return sql.execute('SELECT 1;'); } catch { return null; } }"],
	])("en una operación no molesta: %s", (_que, codigo) => {
		expect(enUnaOperacion(codigo), codigo).toEqual([]);
	});

	it.each([
		["el espacio de nombres de un negocio", "const s = this.env.TenantHub.get(id);"],
		["el espacio de nombres entre corchetes", 'const s = this.env["TenantHub"].get(id);'],
		["la puerta de un negocio", "await hubDe(env, tenantId).releerMain(tenantId);"],
		["el aviso de licencia", "await avisarCambioDeLicencia(env, tenantId);"],
	])("en la central: %s", (_que, codigo) => {
		expect(llamadasAOtrosObjetos("durableObjects/baseCentral.inventado.ts", codigo), codigo).not.toEqual([]);
	});

	it("un import de verdad se sigue; uno de tipos, no", () => {
		const texto = 'import { a } from "../lib/hub";\nimport type { B } from "./tenantHub";\nimport { type C } from "./agendaWeb";';
		expect(importaDeVerdad("durableObjects/baseCentral.inventado.ts", texto)).toEqual(["lib/hub.ts"]);
	});

	it("también se sigue lo que se reexporta, lo que se importa al vuelo y una ruta con `.js`", () => {
		const texto = [
			'export { a } from "../lib/hub";',
			'export type { B } from "./tenantHub";',
			'export * from "./agendaWeb";',
			'const c = () => import("../lib/objetosDelNegocio");',
			'import { d } from "./tenantHub.motor.js";',
		].join("\n");
		expect(importaDeVerdad("durableObjects/baseCentral.inventado.ts", texto).sort()).toEqual([
			"durableObjects/agendaWeb.ts",
			"durableObjects/tenantHub.motor.ts",
			"lib/hub.ts",
			"lib/objetosDelNegocio.ts",
		]);
	});
});
