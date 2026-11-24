// test/objetosDelNegocio.node.test.ts
//
// Nadie pide el Durable Object de un negocio, ni el de la base central, por su cuenta: sólo
// `lib/objetosDelNegocio.ts`.
//
// Los DO de un negocio (`TenantHub`, `AgendaWeb`) se piden con la jurisdicción y la pista de región
// del despliegue. Un sitio que le pidiera el objeto directamente al espacio de nombres
// (`env.TenantHub.get(env.TenantHub.idFromName(t))`) lo pediría sin la pista —y si es el primero en
// llamarlo, lo crearía donde caiga— o, con otra jurisdicción configurada, hablaría con otro objeto.
// Lo que hacen las puertas de verdad está en `objetosDelNegocio.test.ts`; aquí se lee el fuente de
// todo `src/` con el analizador de TypeScript (por eso corre en Node: workerd no puede cargarlo) y
// se exige:
//
//   · un espacio de nombres (`algo.TenantHub`, `algo["AgendaWeb"]`) sólo aparece como argumento de
//     `objetoDelNegocio(env, espacio, tenantId)`;
//   · los métodos que convierten un nombre en un objeto (`idFromName`, `idFromString`,
//     `newUniqueId`, `getByName`, `jurisdiction`) sólo se llaman en el ayudante;
//   · y nadie saca el espacio de nombres desestructurando el entorno.
//
// El de la base central (`BaseCentral`) sólo lo nombra el ayudante, en `centralDe`: con otro nombre
// o en otra jurisdicción sería otro objeto, vacío y sin error.
//
// Los tipos (`Env["TenantHub"]`, `DurableObjectStub<TenantHub>`) y los comentarios no cuentan. El
// último bloque se lo comprueba al propio barrido con código inventado.
//
// Lo que no ve: un acceso con el nombre calculado (`env[nombre]`) y un `get` sobre un espacio de
// nombres que llegue con otro nombre desde fuera de `src/`. Dentro de `src/` no puede llegar con
// otro nombre sin que alguien lo haya sacado antes del entorno, que es lo que se caza.

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

const AYUDANTE = "lib/objetosDelNegocio.ts";

/** Los espacios de nombres de los DO de un negocio, por el nombre de su binding. */
const ESPACIOS = new Set(["TenantHub", "AgendaWeb"]);
/** El de la base central: sólo lo toca el ayudante (`centralDe`). */
const CENTRAL = "BaseCentral";
/** Lo que convierte un nombre en un objeto, o cambia de jurisdicción. */
const METODOS = new Set(["idFromName", "idFromString", "newUniqueId", "getByName", "jurisdiction"]);

/** Lo que el barrido encuentra mal en un fichero. */
function analizar(fichero: string, texto: string): string[] {
	const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true);
	const hallazgos: string[] = [];
	const linea = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
	const raro = (motivo: string, n: ts.Node) => hallazgos.push(`${fichero}:${linea(n)}: ${motivo}`);

	/** El nombre al que accede `x.Nombre` o `x["Nombre"]`, o `null`. */
	const miembro = (n: ts.Node): string | null => {
		if (ts.isPropertyAccessExpression(n)) return n.name.text;
		if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
		return null;
	};

	/** Sin paréntesis ni afirmaciones de tipo alrededor. */
	const haciaFuera = (n: ts.Node): ts.Node => {
		let actual = n;
		while (
			ts.isParenthesizedExpression(actual.parent) ||
			ts.isAsExpression(actual.parent) ||
			ts.isNonNullExpression(actual.parent) ||
			ts.isSatisfiesExpression(actual.parent)
		) {
			actual = actual.parent;
		}
		return actual;
	};

	/** ¿Es `n` el argumento `posicion` de una llamada a `funcion(…)`? */
	const esArgumentoDe = (n: ts.Node, funcion: string, posicion: number): boolean => {
		const fuera = haciaFuera(n);
		const llamada = fuera.parent;
		return (
			ts.isCallExpression(llamada) &&
			ts.isIdentifier(llamada.expression) &&
			llamada.expression.text === funcion &&
			llamada.arguments[posicion] === fuera
		);
	};

	const ver = (n: ts.Node): void => {
		// Los tipos y los imports no piden nada.
		if (ts.isTypeNode(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;

		const nombre = miembro(n);
		if (nombre !== null && ESPACIOS.has(nombre)) {
			if (!esArgumentoDe(n, "objetoDelNegocio", 1)) {
				raro(`usa el espacio de nombres \`${nombre}\` por su cuenta: pide el objeto con \`hubDe\` o \`agendaDe\``, n);
			}
		}
		if (nombre === CENTRAL && fichero !== AYUDANTE) {
			raro(`usa el espacio de nombres \`${CENTRAL}\` por su cuenta: pide la central con \`centralDe\``, n);
		}
		if (nombre !== null && METODOS.has(nombre) && fichero !== AYUDANTE) {
			raro(`llama a \`${nombre}\` fuera de \`${AYUDANTE}\``, n);
		}
		if (ts.isBindingElement(n)) {
			const clave = n.propertyName ?? n.name;
			if ((ts.isIdentifier(clave) || ts.isStringLiteralLike(clave)) && (ESPACIOS.has(clave.text) || clave.text === CENTRAL)) {
				raro(`saca el espacio de nombres \`${clave.text}\` desestructurando`, n);
			}
		}
		ts.forEachChild(n, ver);
	};
	ver(sf);
	return hallazgos;
}

describe("nadie pide el objeto de un negocio por su cuenta", () => {
	it("el barrido ha leído el worker", () => {
		// Si el glob no encontrara nada, lo de abajo pasaría sin mirar nada.
		expect(Object.keys(todoElWorker).length).toBeGreaterThan(100);
		for (const fichero of [AYUDANTE, "lib/hub.ts", "durableObjects/agendaWeb.ts"]) {
			expect(todoElWorker[fichero], fichero).toBeTypeOf("string");
		}
	});

	it("en todo `src/`, los espacios de nombres sólo pasan por el ayudante", () => {
		const hallazgos = Object.entries(todoElWorker).flatMap(([fichero, texto]) => analizar(fichero, texto));
		expect(hallazgos).toEqual([]);
	});

	it("las dos puertas piden su espacio de nombres, y sólo el suyo", () => {
		// `hubDe` y `agendaDe` son quienes nombran los bindings: si dejaran de pasar por el ayudante,
		// el test de arriba seguiría en verde sin mirar nada.
		expect(todoElWorker["lib/hub.ts"]).toContain("objetoDelNegocio(env, env.TenantHub, tenantId)");
		expect(todoElWorker["durableObjects/agendaWeb.ts"]).toContain("objetoDelNegocio(env, env.AgendaWeb, tenantId)");
	});

	it("la central sólo la nombra `centralDe`", () => {
		expect(todoElWorker[AYUDANTE]).toMatch(/export function centralDe\([^)]*\)[^{]*\{\s*const espacio = env\.BaseCentral;/);
	});
});

describe("el barrido caza lo que tiene que cazar", () => {
	const enUnaRuta = (codigo: string) => analizar("domains/inventado/inventado.routes.ts", codigo);

	it.each([
		["pedirlo al espacio de nombres", "const stub = env.TenantHub.get(env.TenantHub.idFromName(tenantId));"],
		["un `get` con un id que viene de fuera", "const stub = c.env.TenantHub.get(id);"],
		["por corchetes", 'const stub = env["AgendaWeb"]["getByName"](tenantId);'],
		["guardarlo en una variable", "const ns = this.env.AgendaWeb;"],
		["pasárselo a otra función", "cerrar(env.TenantHub, tenantId);"],
		["desestructurarlo", "const { TenantHub } = env;"],
		["desestructurarlo con otro nombre", "const { AgendaWeb: agenda } = c.env;"],
		["cambiar de jurisdicción", 'const ns = espacio.jurisdiction("eu");'],
		["detrás de un texto con dos barras", 'const u = "https://ejemplo.invalid"; const s = env.TenantHub.get(id);'],
		["como segundo argumento de otra cosa", "const stub = otraCosa(env, env.TenantHub, tenantId);"],
		["pedir la central por su cuenta", 'const central = env.BaseCentral.get(env.BaseCentral.idFromName("central"));'],
		["la central por el ayudante de los negocios", "const central = objetoDelNegocio(env, env.BaseCentral, 'central');"],
		["desestructurar la central", "const { BaseCentral } = c.env;"],
	])("%s", (_que, codigo) => {
		expect(enUnaRuta(codigo), codigo).not.toEqual([]);
	});

	it.each([
		["por el ayudante", "const stub = objetoDelNegocio(env, env.TenantHub, tenantId);"],
		["por el ayudante, con el espacio entre paréntesis y afirmado", "const stub = objetoDelNegocio(env, (env.AgendaWeb as any), tenantId);"],
		["por las puertas", "const hub = hubDe(c.env, tenantId); const agenda = agendaDe(c.env, tenantId);"],
		["un tipo", 'type E = Pick<Env, "TenantHub" | "AgendaWeb">; let ns: Env["TenantHub"]; let s: DurableObjectStub<TenantHub>;'],
		["un comentario", "// env.TenantHub.get(env.TenantHub.idFromName(tenantId))\nconst x = 1;"],
		["un texto", 'const ayuda = "env.TenantHub.idFromName(tenantId)";'],
		["la clase del DO", "export class TenantHub extends DurableObject<Env> {}"],
		["la central por su puerta", "const db = clienteCentral(() => centralDe(c.env));"],
		["el tipo de la central", 'let ns: Env["BaseCentral"]; let s: DurableObjectStub<BaseCentral>;'],
	])("no molesta: %s", (_que, codigo) => {
		expect(enUnaRuta(codigo), codigo).toEqual([]);
	});
});
