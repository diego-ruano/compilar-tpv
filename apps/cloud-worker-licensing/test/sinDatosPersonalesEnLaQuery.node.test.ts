// test/sinDatosPersonalesEnLaQuery.node.test.ts
//
// AUD-27: ningún dato personal ni texto libre en la query ni en el camino.
//
// La plataforma guarda la URL de cada invocación —el registro de invocación de Workers Logs
// (`observability.enabled`) y, si el job lo incluye, el `Event` de los `workers_trace_events` de
// Logpush (`logpush: true`)— sin pasar por el filtro OBS-01, y su redacción sólo tapa lo que parece
// un id largo: un teléfono, un correo o un nombre se quedan como están. El cuerpo no se registra.
// La Handy mandaba en la query el teléfono y el correo del cliente de una reserva
// (`GET /v1/reservas/buscar-cliente`) y lo que se escribía en los buscadores de Cuentas y de
// productos (`?q=`, `?query=`).
//
// La regla se lee del fuente de todo `src/` con el analizador de TypeScript (por eso este test corre
// en Node: workerd no puede cargarlo, ver `vitest.config.ts`):
//
//   · en la query sólo viaja lo de `EN_LA_QUERY` (identificadores, fechas, filtros cerrados y
//     paginación) y en el camino lo de `EN_EL_CAMINO`. Lo demás va en el cuerpo de un POST;
//   · una lectura que va por POST se declara con `lecturaPorPost(…)` (`lib/rutas.ts`) delante de
//     `tenantAuth`, y sigue siendo una lectura: valida su cuerpo, sólo consulta y no lleva ningún
//     veto de los que son para escrituras. Y al revés: lo que no es un GET y sólo consulta, la lleva.
//
// **Falla cerrado.** Lo que el barrido no sabe leer —un nombre de parámetro que no es un literal, un
// schema escrito en la propia ruta o ampliado al vuelo, la query entera, un camino que no es un
// literal, un router usado con otro nombre— sale en `ilegibles` y el test falla. Los alias de
// importación se siguen, y los comentarios y los textos no cuentan. El último bloque se lo comprueba
// al propio barrido con código inventado.
//
// Lo que no ve, y por eso no es la protección de fondo: una URL troceada a mano como texto
// (`c.req.url.split("?")`), y lo que una ruta lee a través de una función que vive fuera de su
// registro (para saber si «sólo consulta», mira las llamadas escritas en el propio registro). La de
// fondo son `lecturasPorPost.test.ts` y los tests de `tpv-infra-http`, que miran lo que sale y entra.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { RUTA_DE_IMAGEN } from "../src/domains/images/rutaDeImagen";

type Fuentes = Record<string, string>;
type Modulos = Record<string, Record<string, unknown>>;
type Hallazgo = { donde: string; nombre: string };

/** Un registro en un router de Hono: `xRoutes.post("/ruta", …)`, `app.use(…)`. */
type Registro = {
	fichero: string;
	/** El router en el que se registra. */
	receptor: string;
	verbo: string;
	/** `null`: un `use(middleware)` sin camino. */
	ruta: string | null;
	inicio: number;
	/** Lo que se llama dentro de sus argumentos, por el nombre con el que se exporta. */
	llamadas: Set<string>;
	/** Los identificadores que aparecen en sus argumentos. */
	nombres: Set<string>;
	/** Si alguno de sus argumentos es `lecturaPorPost(…)`. */
	declaraLectura: boolean;
};

type Analisis = {
	query: Hallazgo[];
	camino: Hallazgo[];
	comodines: string[];
	registros: Registro[];
	ilegibles: string[];
	/** Las claves de `URL_AJENAS` que han hecho falta. */
	ajenas: Set<string>;
};

/** `../src/domains/x/y.ts` → `domains/x/y.ts`. */
const sinPrefijo = (fichero: string) => fichero.replace("../src/", "");

/** Todo el worker. */
const todoElWorker: Fuentes = Object.fromEntries(
	Object.entries(import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true })).map(
		([f, t]) => [sinPrefijo(f), t],
	),
);
delete todoElWorker["server/worker-configuration.d.ts"];

/** Los schemas de verdad: de ellos se sacan las claves que acepta un `consulta(schema)`. */
const modulos: Modulos = Object.fromEntries(
	Object.entries(import.meta.glob("../src/domains/**/*.schemas.ts", { eager: true })).map(([f, m]) => [
		sinPrefijo(f),
		m,
	]),
);

/**
 * Lo único que puede ir en la query: identificadores, fechas, filtros cerrados y paginación.
 *
 * **Antes de añadir un nombre aquí**: ¿puede llevar el nombre, el teléfono, el correo o el
 * documento de alguien, una nota, o lo que se escribe en un buscador? Entonces no va en la query:
 * la ruta pasa a `post` con `cuerpo(schema)` y se declara con `lecturaPorPost(…)`.
 */
const EN_LA_QUERY = new Set([
	// identificadores
	"categoria",
	"categoria_top_id",
	"categoria_worst_id",
	"tenant",
	"trabajador",
	"usuario",
	// fechas y horas
	"desde",
	"dia",
	"fecha_lunes",
	"hasta",
	"hora",
	// filtros cerrados y cantidades
	"historial",
	"personas",
	"range",
	"ranking",
	"solo_no_leidas",
	"todos",
	"turno",
	"vueltas",
	// paginación
	"limit",
	"limite",
	"offset",
	// la web del negocio que incrusta la verificación (uno de sus dominios dados de alta) y el
	// ticket de un solo uso del WebSocket
	"origen",
	"ticket",
]);

/**
 * Lo único que puede ir en el camino de una ruta: identificadores y valores cerrados (la clave
 * pública de un negocio, el destino de una actualización). La misma pregunta que arriba antes de
 * añadir uno.
 */
const EN_EL_CAMINO = new Set([
	"arch",
	"clave",
	"current",
	"id",
	"idCategoria",
	"idMesa",
	"target",
	"tenant",
	"tenantId",
]);

/**
 * Las rutas que reciben «el resto del camino» (`*`), que es texto que nadie ha nombrado. Una
 * nueva se apunta aquí después de mirar qué puede venir en él.
 */
const COMODINES = new Set([
	// Los ficheros del widget compilado, y el 404 de todo lo demás.
	"domains/reservas_web/widget.routes.ts: /assets/*",
	"domains/reservas_web/widget.routes.ts: *",
]);

/**
 * OBS-06: las rutas de una imagen reciben en el resto del camino la ruta del fichero. No son una
 * excepción: cada una la valida con `RUTA_DE_IMAGEN`, que sólo admite una carpeta de la lista y un
 * UUID con su extensión. Lo comprueba el bloque «OBS-06» de abajo.
 */
const COMODINES_DE_IMAGEN = new Set([
	"domains/images/images.routes.ts: /:tenant/*",
	"domains/images/images.routes.ts: /*",
]);

/**
 * Lo que toca la query de una URL que no es la de la petición que se atiende, o que la lee entera
 * para algo que no es un dato. Cualquier otro `.search` o `searchParams` que no sea
 * `searchParams.get("nombre")` no se deja pasar.
 */
const URL_AJENAS: Record<string, string> = {
	"server/middleware/auth.ts: url.search": "la firma del dispositivo cubre la ruta con su query",
	"domains/licensing/licensing.helpers.ts: url.search": "la firma del dispositivo cubre la ruta con su query",
	"domains/reservas_web/claves.ts: url.search": "comprueba que el dominio dado de alta no trae query",
	"domains/licensing/avisosDeCaducidad.ts: searchParams.set": "el enlace de Stripe que va en el correo de renovación",
	"domains/stripe/stripe.helpers.ts: searchParams.append": "la petición a la API de Stripe",
};

/** Las lecturas que van por POST: `fichero → rutas`. */
const LECTURAS_POR_POST: Record<string, string[]> = {
	"domains/cuentas/cuentas.routes.ts": ["/entradas", "/salidas", "/resumen"],
	"domains/mesas/mesas.routes.ts": ["/productos/search"],
	"domains/reservas/reservas.routes.ts": ["/buscar-cliente"],
	"domains/venta_rapida/venta_rapida.routes.ts": ["/productos/search", "/index-rows"],
};

/**
 * Lo que no es un GET, consulta la base del negocio sin aplicar nada por el `TenantHub` y aun así
 * **no** es una lectura por POST, con su porqué. Lo demás que sólo consulte tiene que declararse
 * con `lecturaPorPost(…)`.
 */
const SOLO_CONSULTAN_Y_NO_SON_LECTURAS: Record<string, string> = {
	"domains/email/email.routes.ts → /enviar-pedido": "manda un correo; lee el proveedor para acotar a quién",
	"domains/login/login.routes.ts → /login": "verifica un PIN y cuenta el intento (LOGIN-01)",
	"domains/reservas_web/main.routes.ts → /avisos": "manda un correo al cliente de una reserva web",
	// El protocolo de réplica y de recuperación de la Main (sincronizacion.md): sus cuerpos y sus
	// techos son los suyos, y sólo la Main pasa de la puerta del router.
	"domains/sync/sync.routes.ts → /changes": "réplica de la Main",
	"domains/sync/sync.routes.ts → /bootstrap": "réplica de la Main",
	"domains/sync/sync.routes.ts → /historico": "réplica de la Main",

	"domains/sync/sync.routes.ts → /verificar/resumen": "réplica de la Main",
	"domains/sync/sync.routes.ts → /verificar/filas": "réplica de la Main",
	"domains/sync/sync.routes.ts → /verificar/claves": "réplica de la Main",
	"domains/sync/sync.routes.ts → /verificar/por-clave": "réplica de la Main",
};

// ── El barrido ────────────────────────────────────────────────────────────────────────────────

const VALIDACION = "lib/validacion.ts";
const RUTAS = "lib/rutas.ts";
/** Validadores que no son `consulta` ni `cuerpo`: sólo `lib/validacion.ts` los usa, para definirlos. */
const VALIDADORES_DE_FUERA = new Set(["@hono/zod-validator", "hono/validator"]);

/** Los métodos de un router que registran algo en un camino (`use`, además, puede ir sin él). */
const CON_CAMINO = new Set(["get", "post", "put", "patch", "delete", "options", "all", "route", "basePath", "use"]);
/** Los que registran de una forma que el barrido no lee. */
const SIN_LEER = new Set(["on", "mount"]);

/** `./x.schemas` visto desde `domains/y/y.routes.ts` → `domains/y/x.schemas.ts`. */
function moduloDe(desde: string, especificador: string): string {
	if (!especificador.startsWith(".")) return especificador;
	const partes = desde.split("/").slice(0, -1);
	for (const p of especificador.split("/")) {
		if (p === "..") partes.pop();
		else if (p !== ".") partes.push(p);
	}
	return `${partes.join("/")}.ts`;
}

function sinEnvoltorio(e: ts.Expression): ts.Expression {
	while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
		e = e.expression;
	}
	return e;
}

const esTexto = (e: ts.Node | undefined): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
	e !== undefined && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e));

/** `c.req`, o un `req` suelto (desestructurado de la petición). */
const esPeticion = (e: ts.Expression): boolean =>
	(ts.isPropertyAccessExpression(e) && e.name.text === "req") || (ts.isIdentifier(e) && e.text === "req");

/** Un identificador que nombra algo, no el nombre de una propiedad ni el de lo que se declara. */
function esReferencia(id: ts.Identifier): boolean {
	const p = id.parent;
	if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
	if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
	if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === id) return false;
	if (ts.isBindingElement(p) && p.propertyName === id) return false;
	if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) {
		return false;
	}
	return true;
}

/**
 * Las claves del objeto que valida un schema, tenga o no un `transform` detrás. `null` si no es un
 * objeto del que se puedan leer, o si deja pasar claves que no declara (`.loose()`, `.catchall()`).
 */
function clavesDe(schema: any): string[] | null {
	let s = schema;
	for (let i = 0; i < 8 && s; i++) {
		if (s.shape && typeof s.shape === "object") {
			const resto = s.def?.catchall;
			if (resto && resto.def?.type !== "never") return null;
			return Object.keys(s.shape);
		}
		s = s.in ?? s.def?.in ?? s.def?.innerType;
	}
	return null;
}

type Importado = { modulo: string; importado: string };

/** Lee lo que todos los ficheros ponen en la URL y lo que registran como rutas. */
function analizar(proyecto: Fuentes, schemas: Modulos): Analisis {
	const a: Analisis = { query: [], camino: [], comodines: [], registros: [], ilegibles: [], ajenas: new Set() };

	for (const [fichero, texto] of Object.entries(proyecto)) {
		const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const trozo = (n: ts.Node) => n.getText(sf).replace(/\s+/g, " ").slice(0, 80);
		const raro = (motivo: string, n: ts.Node) => a.ilegibles.push(`${fichero}: ${motivo} → ${trozo(n)}`);

		// Lo que importa el fichero, por el nombre con el que lo usa.
		const importados = new Map<string, Importado>();
		for (const s of sf.statements) {
			if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause) continue;
			if (s.importClause.isTypeOnly) continue;
			const modulo = moduloDe(fichero, s.moduleSpecifier.text);
			const { name, namedBindings } = s.importClause;
			if (name) importados.set(name.text, { modulo, importado: "default" });
			if (namedBindings && ts.isNamespaceImport(namedBindings)) {
				importados.set(namedBindings.name.text, { modulo, importado: "*" });
			} else if (namedBindings) {
				for (const e of namedBindings.elements) {
					if (!e.isTypeOnly) importados.set(e.name.text, { modulo, importado: (e.propertyName ?? e.name).text });
				}
			}
		}

		/** `e` es `nombre` de `modulo`: importado con su nombre, con un alias o por su espacio. */
		const refiereA = (e: ts.Expression, modulo: string, nombre: string): boolean => {
			if (ts.isIdentifier(e)) {
				const o = importados.get(e.text);
				return o !== undefined && o.modulo === modulo && o.importado === nombre && esReferencia(e);
			}
			if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
				const o = importados.get(e.expression.text);
				return o !== undefined && o.modulo === modulo && o.importado === "*" && e.name.text === nombre;
			}
			return false;
		};

		/** El nombre con el que se exporta lo que se llama: `validar` importado como `consulta` es `consulta`. */
		const nombreImportado = (e: ts.Expression): string | undefined => {
			if (ts.isIdentifier(e)) return importados.get(e.text)?.importado ?? e.text;
			if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
				return importados.get(e.expression.text)?.importado === "*" ? e.name.text : undefined;
			}
			return undefined;
		};

		// Los routers del fichero: lo que se crea con `new Hono(…)`.
		const esHono = (e: ts.Node) => ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Hono";
		const routers = new Set<string>();
		const recogerRouters = (n: ts.Node) => {
			if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && esHono(sinEnvoltorio(n.initializer))) {
				routers.add(n.name.text);
			}
			ts.forEachChild(n, recogerRouters);
		};
		recogerRouters(sf);

		/** El router en el que acaba una cadena `xRoutes.get(…).post(…)`, si acaba en uno. */
		const routerDe = (e: ts.Expression): string | undefined => {
			let r: ts.Expression = sinEnvoltorio(e);
			while (ts.isCallExpression(r) || ts.isPropertyAccessExpression(r)) r = sinEnvoltorio(r.expression);
			if (ts.isIdentifier(r) && routers.has(r.text)) return r.text;
			return esHono(r) ? "new Hono()" : undefined;
		};

		/** Lo que se llama y se nombra dentro de unos argumentos. */
		const contenido = (args: readonly ts.Expression[]) => {
			const llamadas = new Set<string>();
			const nombres = new Set<string>();
			const bajar = (n: ts.Node) => {
				if (ts.isCallExpression(n)) {
					const llamada = nombreImportado(n.expression);
					if (llamada) llamadas.add(llamada);
				}
				if (ts.isIdentifier(n) && esReferencia(n)) nombres.add(n.text);
				ts.forEachChild(n, bajar);
			};
			args.forEach(bajar);
			return { llamadas, nombres };
		};

		function leerConsulta(llamada: ts.CallExpression) {
			const arg = llamada.arguments.length === 1 ? sinEnvoltorio(llamada.arguments[0]) : undefined;
			let origen: Importado | undefined;
			if (arg && ts.isIdentifier(arg)) {
				origen = importados.get(arg.text);
			} else if (arg && ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
				const espacio = importados.get(arg.expression.text);
				if (espacio?.importado === "*") origen = { modulo: espacio.modulo, importado: arg.name.text };
			}
			const modulo =
				origen && origen.modulo.endsWith(".schemas.ts") && origen.importado !== "*" ? schemas[origen.modulo] : undefined;
			if (!origen || !modulo) {
				raro("valida la query con algo que no es un schema con nombre de un `*.schemas.ts`", llamada);
				return;
			}
			const claves = clavesDe(modulo[origen.importado]);
			if (!claves) {
				raro("no sé leer las claves de ese schema, o deja pasar las que no declara", llamada);
				return;
			}
			for (const clave of claves) a.query.push({ donde: `${fichero} (${origen.importado})`, nombre: clave });
		}

		function registrar(n: ts.CallExpression, receptor: string, verbo: string) {
			const primero = n.arguments[0] ? sinEnvoltorio(n.arguments[0]) : undefined;
			let ruta: string | null = null;
			if (esTexto(primero)) {
				ruta = primero.text;
			} else if (verbo !== "use" || (primero && (ts.isTemplateExpression(primero) || ts.isBinaryExpression(primero)))) {
				// Un `use(middleware)` va sin camino; cualquier otro registro lo lleva escrito.
				raro("registra un camino que no es un texto literal", n);
				return;
			}
			const resto = ruta === null ? n.arguments : n.arguments.slice(1);
			const { llamadas, nombres } = contenido(resto);
			const declaraLectura = resto.some((e) => {
				const s = sinEnvoltorio(e);
				return ts.isCallExpression(s) && refiereA(s.expression, RUTAS, "lecturaPorPost");
			});
			a.registros.push({ fichero, receptor, verbo, ruta, inicio: n.getStart(sf), llamadas, nombres, declaraLectura });
			if (ruta === null) return;
			for (const p of ruta.matchAll(/:(\w+)/g)) a.camino.push({ donde: `${fichero} (${ruta})`, nombre: p[1] });
			if (ruta.includes("*") && verbo !== "use" && verbo !== "options") a.comodines.push(`${fichero}: ${ruta}`);
		}

		const ver = (n: ts.Node): void => {
			if (ts.isTypeNode(n) || ts.isImportDeclaration(n)) return;

			// `consulta(S.unSchema)`, también con alias o por su espacio de nombres.
			if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && refiereA(n, VALIDACION, "consulta")) {
				const llamada = n.parent;
				if (ts.isCallExpression(llamada) && llamada.expression === n) leerConsulta(llamada);
				else raro("usa `consulta` sin llamarla", n);
			}

			// Otro validador: la query se valida con `consulta(schema)` y nada más.
			if (ts.isIdentifier(n) && esReferencia(n) && fichero !== VALIDACION) {
				const o = importados.get(n.text);
				if (o && VALIDADORES_DE_FUERA.has(o.modulo)) raro("valida por su cuenta: usa `consulta(schema)`", n);
			}
			if (ts.isPropertyAccessExpression(n) && n.name.text === "addValidatedData" && fichero !== VALIDACION) {
				raro("rellena lo validado por su cuenta", n);
			}

			// `c.req.query("x")` y `c.req.param("x")`.
			if (ts.isPropertyAccessExpression(n) && ["query", "queries", "param"].includes(n.name.text) && esPeticion(n.expression)) {
				const llamada = n.parent;
				const nombre =
					ts.isCallExpression(llamada) && llamada.expression === n && llamada.arguments.length === 1
						? llamada.arguments[0]
						: undefined;
				if (n.name.text !== "queries" && esTexto(nombre)) {
					(n.name.text === "query" ? a.query : a.camino).push({ donde: fichero, nombre: nombre.text });
				} else {
					raro(`lee la petición de una forma que no es \`c.req.${n.name.text === "param" ? "param" : "query"}("nombre")\``, n);
				}
			}
			if (ts.isElementAccessExpression(n) && esPeticion(n.expression)) raro("lee la petición por un nombre calculado", n);
			if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && esPeticion(sinEnvoltorio(n.initializer))) {
				raro('desestructura la petición: usa `c.req.query("nombre")`', n);
			}

			// `url.searchParams.get("x")`; cualquier otro uso, sólo en una URL ajena apuntada.
			if (ts.isPropertyAccessExpression(n) && n.name.text === "searchParams") {
				const metodo = n.parent;
				const llamada = metodo.parent;
				const nombre =
					ts.isPropertyAccessExpression(metodo) &&
					metodo.name.text === "get" &&
					ts.isCallExpression(llamada) &&
					llamada.expression === metodo &&
					llamada.arguments.length === 1
						? llamada.arguments[0]
						: undefined;
				if (esTexto(nombre)) {
					a.query.push({ donde: fichero, nombre: nombre.text });
				} else {
					const clave = `${fichero}: searchParams${ts.isPropertyAccessExpression(metodo) ? `.${metodo.name.text}` : ""}`;
					if (clave in URL_AJENAS) a.ajenas.add(clave);
					else raro('usa `searchParams` de una forma que no es `.get("nombre")`', n);
				}
			}

			// `url.search`: vaciarla vale; leerla, sólo en una URL ajena apuntada (`texto.search()` es otra cosa).
			if (ts.isPropertyAccessExpression(n) && n.name.text === "search") {
				const p = n.parent;
				const vaciada =
					ts.isBinaryExpression(p) &&
					p.left === n &&
					p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					esTexto(p.right) &&
					p.right.text === "";
				const esMetodo = ts.isCallExpression(p) && p.expression === n;
				const clave = `${fichero}: ${n.getText(sf)}`;
				if (!vaciada && !esMetodo) {
					if (clave in URL_AJENAS) a.ajenas.add(clave);
					else raro("lee la query entera de una URL", n);
				}
			}
			if (ts.isIdentifier(n) && n.text === "URLSearchParams" && esReferencia(n)) raro("lee la query con `URLSearchParams`", n);

			// `lecturaPorPost(…)` sólo sirve como argumento de un `use` con su camino.
			if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && refiereA(n, RUTAS, "lecturaPorPost")) {
				const llamada = n.parent;
				const use = llamada.parent;
				const bien =
					ts.isCallExpression(llamada) &&
					llamada.expression === n &&
					ts.isCallExpression(use) &&
					ts.isPropertyAccessExpression(use.expression) &&
					use.expression.name.text === "use" &&
					routerDe(use.expression.expression) !== undefined &&
					esTexto(use.arguments[0]);
				if (!bien) raro('`lecturaPorPost` va en `xRoutes.use("/ruta", lecturaPorPost(…))`', n);
			}

			// Un router sólo se usa para registrar en él, montarlo o exportarlo.
			if (ts.isIdentifier(n) && routers.has(n.text) && esReferencia(n)) {
				const p = n.parent;
				const bien =
					(ts.isPropertyAccessExpression(p) && p.expression === n) ||
					(ts.isCallExpression(p) && p.expression !== n && routerDe(p.expression) !== undefined);
				if (!bien) raro("usa un router de una forma que el barrido no sigue", n);
			}

			// Un registro de ruta.
			if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
				const receptor = routerDe(n.expression.expression);
				const verbo = n.expression.name.text;
				if (receptor !== undefined && SIN_LEER.has(verbo)) raro(`registra con \`.${verbo}\`: usa \`xRoutes.verbo("/ruta", …)\``, n);
				if (receptor !== undefined && CON_CAMINO.has(verbo)) registrar(n, receptor, verbo);
			}

			ts.forEachChild(n, ver);
		};

		ver(sf);
	}
	return a;
}

/**
 * Lo que no es un GET y consulta la base del negocio sin aplicar nada. Las tres puertas por las que
 * una ruta lee esa base: `tenantQuery`, `leerParaLaWeb` y el `lectorDe` de los volcados de sync
 * (`domains/sync/volcado.ts`).
 */
const soloConsulta = (r: Registro) =>
	["post", "put", "patch", "delete", "all"].includes(r.verbo) &&
	(r.llamadas.has("tenantQuery") || r.llamadas.has("leerParaLaWeb") || r.llamadas.has("lectorDe")) &&
	!r.llamadas.has("apply") &&
	!r.llamadas.has("applyViaHub");

const claveDe = (r: Registro) => `${r.fichero} → ${r.ruta}`;
const declaracionDe = (r: Registro) => `${r.fichero}|${r.receptor}|${r.ruta}`;

/** Las rutas declaradas como lectura por POST, por fichero. */
function declaradas(a: Analisis): Record<string, string[]> {
	const salida: Record<string, string[]> = {};
	for (const r of a.registros) if (r.verbo === "use" && r.declaraLectura && r.ruta) (salida[r.fichero] ??= []).push(r.ruta);
	return salida;
}

/** Lo que no es un GET y sólo consulta, sin declarar ni apuntar. */
function sinDeclarar(a: Analisis, apuntadas: Record<string, string>): string[] {
	const yaDeclaradas = new Set(a.registros.filter((r) => r.verbo === "use" && r.declaraLectura).map(declaracionDe));
	return a.registros
		.filter(soloConsulta)
		.filter((r) => !yaDeclaradas.has(declaracionDe(r)) && !(claveDe(r) in apuntadas))
		.map(claveDe);
}

const delWorker = analizar(todoElWorker, modulos);

describe("AUD-27: ningún dato personal ni texto libre en la URL", () => {
	it("buscar el cliente de una reserva no es un GET", () => {
		const suyos = delWorker.registros.filter(
			(r) => r.fichero === "domains/reservas/reservas.routes.ts" && r.ruta === "/buscar-cliente",
		);
		expect(suyos.map((r) => r.verbo).sort()).toEqual(["post", "use"]);
	});

	it("todo lo que toca la URL lo toca de una forma que el barrido entiende", () => {
		expect(delWorker.ilegibles).toEqual([]);
	});

	it("lo que se lee de la query está en la lista de lo que puede ir en ella", () => {
		const fuera = delWorker.query.filter((p) => !EN_LA_QUERY.has(p.nombre)).map((p) => `${p.donde}: ${p.nombre}`);
		expect(
			fuera,
			"si es de una persona o texto libre, va en el cuerpo de un POST declarado con `lecturaPorPost(…)`",
		).toEqual([]);
	});

	it("lo que una ruta lleva en su camino es un identificador o un valor cerrado", () => {
		const fuera = delWorker.camino.filter((p) => !EN_EL_CAMINO.has(p.nombre)).map((p) => `${p.donde}: ${p.nombre}`);
		expect(fuera, "el camino también se registra: lo que sea de una persona va en el cuerpo").toEqual([]);
	});

	it("las rutas que reciben el resto del camino son las que ya se han mirado", () => {
		expect([...new Set(delWorker.comodines)].sort()).toEqual([...COMODINES, ...COMODINES_DE_IMAGEN].sort());
	});

	it("lo apuntado como URL ajena se usa: la lista no se queda vieja", () => {
		expect([...delWorker.ajenas].sort()).toEqual(Object.keys(URL_AJENAS).sort());
	});

	it("el barrido mira de verdad, no una lista vacía", () => {
		// Sin esto, un glob o una regla que dejara de casar convertiría lo de arriba en verde
		// permanente — que es exactamente el fallo mudo que vienen a evitar.
		expect(Object.keys(todoElWorker).length).toBeGreaterThan(50);
		expect(delWorker.query.length).toBeGreaterThan(20);
		expect(delWorker.query.filter((p) => p.donde.includes("(")).length).toBeGreaterThan(5);
		expect(delWorker.query.map((p) => p.nombre)).toEqual(expect.arrayContaining(["ticket", "desde", "limite"]));
		expect(delWorker.camino.length).toBeGreaterThan(60);
		expect(delWorker.camino.map((p) => p.nombre)).toEqual(expect.arrayContaining(["id", "clave", "tenant"]));
		expect(delWorker.registros.length).toBeGreaterThan(150);
		// Y lee los schemas de los que salió el hallazgo.
		expect(clavesDe(modulos["domains/reservas/reservas.schemas.ts"].buscarClienteSchema)).toEqual(["telefono", "email"]);
		expect(clavesDe(modulos["domains/cuentas/cuentas.schemas.ts"].listadoSchema)).toContain("q");
	});
});

describe("OBS-06: en la ruta de una imagen no viaja ningún nombre", () => {
	const UUID = "0190f3a1-7b2c-4d4e-8f00-123456789abc";

	it("cada ruta de imagen que recibe el resto del camino lo valida con RUTA_DE_IMAGEN", () => {
		const deImagen = delWorker.registros.filter(
			(r) => r.ruta !== null && r.verbo !== "use" && COMODINES_DE_IMAGEN.has(`${r.fichero}: ${r.ruta}`),
		);
		expect(deImagen.map((r) => `${r.verbo} ${r.ruta}`).sort()).toEqual(["delete /*", "get /:tenant/*", "put /*"]);
		for (const r of deImagen) expect(r.nombres.has("RUTA_DE_IMAGEN"), `${r.verbo} ${r.ruta}`).toBe(true);
	});

	it("RUTA_DE_IMAGEN sólo admite una carpeta de la lista y un UUID con su extensión", () => {
		for (const carpeta of ["productos", "categorias", "proveedores", "alergenos", "logo"]) {
			for (const ext of ["jpg", "jpeg", "png", "webp", "JPG"]) {
				expect(RUTA_DE_IMAGEN.test(`images/${carpeta}/${UUID}.${ext}`), `${carpeta} ${ext}`).toBe(true);
			}
		}
		expect(RUTA_DE_IMAGEN.test(`images/productos/${UUID.toUpperCase()}.jpg`)).toBe(true);
		for (const mala of [
			"images/proveedores/Juan-Perez.jpg",
			"images/productos/tarta_de_ana.png",
			`images/productos/${UUID.replaceAll("-", "")}.jpg`,
			`images/productos/${UUID}x.jpg`,
			`images/productos/x${UUID}.jpg`,
			`images/productos/${UUID}.jpg.jpg`,
			`images/productos/${UUID}.svg`,
			`images/otra/${UUID}.jpg`,
			// La carpeta y el prefijo, en minúsculas: la Main no admite otra cosa al bajarla o al imprimirla.
			`images/PRODUCTOS/${UUID}.jpg`,
			`IMAGES/productos/${UUID}.jpg`,
			`images/productos/../${UUID}.jpg`,
			`images/productos/${UUID}`,
		]) {
			expect(RUTA_DE_IMAGEN.test(mala), mala).toBe(false);
		}
	});
});

describe("AUD-27: una lectura por POST sigue siendo una lectura", () => {
	const usos = delWorker.registros.filter((r) => r.verbo === "use" && r.declaraLectura);

	it("las lecturas por POST son las que ya se han mirado", () => {
		expect(declaradas(delWorker)).toEqual(LECTURAS_POR_POST);
	});

	it("la declaración va delante de `tenantAuth`, que lee el cuerpo entero para comprobar la firma", () => {
		expect(usos.length).toBeGreaterThan(0);
		for (const d of usos) {
			const auth = delWorker.registros.find(
				(r) =>
					r.fichero === d.fichero && r.receptor === d.receptor && r.verbo === "use" && r.ruta === "*" && r.nombres.has("tenantAuth"),
			);
			expect(auth, `${d.fichero}: no encuentro su \`use("*", tenantAuth)\``).toBeDefined();
			expect(d.inicio, claveDe(d)).toBeLessThan(auth!.inicio);
		}
	});

	it("es un POST que valida su cuerpo y sólo consulta: ni `apply` ni vetos de escritura", () => {
		for (const d of usos) {
			const suyos = delWorker.registros.filter(
				(r) => r.fichero === d.fichero && r.receptor === d.receptor && r.ruta === d.ruta && r.verbo !== "use",
			);
			expect(suyos.map((r) => r.verbo), claveDe(d)).toEqual(["post"]);
			const [r] = suyos;
			expect(r.llamadas.has("cuerpo"), claveDe(d)).toBe(true);
			expect(soloConsulta(r), claveDe(d)).toBe(true);
			// Leer no está vetado a una Handy: `soloLaMain…` es para lo que escribe.
			expect([...r.nombres].filter((n) => n.startsWith("soloLaMain")), claveDe(d)).toEqual([]);
		}
	});

	it("lo que no es un GET y sólo consulta está declarado, o apuntado con su porqué", () => {
		expect(
			sinDeclarar(delWorker, SOLO_CONSULTAN_Y_NO_SON_LECTURAS),
			"una lectura por POST se declara con `xRoutes.use(ruta, lecturaPorPost(…))` delante de `tenantAuth`",
		).toEqual([]);
		// Y la lista de las que no lo son dice la verdad: ninguna sobra.
		const apuntadas = delWorker.registros
			.filter(soloConsulta)
			.map(claveDe)
			.filter((c) => c in SOLO_CONSULTAN_Y_NO_SON_LECTURAS);
		expect([...new Set(apuntadas)].sort()).toEqual(Object.keys(SOLO_CONSULTAN_Y_NO_SON_LECTURAS).sort());
	});
});

// ── El propio barrido ─────────────────────────────────────────────────────────────────────────
//
// Es un programa y también se equivoca. Estos casos son las formas de saltárselo que se le han
// encontrado y el código razonable que tiene que dejar pasar.

describe("AUD-27: el barrido falla cerrado", () => {
	const RUTA = "domains/inventado/inventado.routes.ts";
	const AYUDANTE = "lib/ayudante.ts";
	const inventados: Modulos = {
		"domains/inventado/inventado.schemas.ts": {
			fechas: z.object({ desde: z.string(), hasta: z.string() }),
			conBusqueda: z.object({ q: z.string() }).transform((v) => v),
			suelto: z.looseObject({ desde: z.string() }),
			dosFormas: z.union([z.object({ desde: z.string() }), z.object({ q: z.string() })]),
		},
	};
	const CABECERA = [
		'import { Hono } from "hono";',
		'import * as S from "./inventado.schemas";',
		'import { fechas } from "./inventado.schemas";',
		'import { otro } from "./otros";',
		'import { consulta, cuerpo } from "../../lib/validacion";',
		'import { lecturaPorPost } from "../../lib/rutas";',
		"export const xRoutes = new Hono();",
	].join("\n");

	/** El barrido sobre un router inventado con ese cuerpo (y, si hace falta, otros ficheros). */
	const router = (cuerpo: string, otros: Fuentes = {}) =>
		analizar({ [RUTA]: `${CABECERA}\n${cuerpo}\n`, ...otros }, inventados);
	const query = (a: Analisis) => a.query.map((p) => p.nombre);
	const camino = (a: Analisis) => a.camino.map((p) => p.nombre);

	it("entiende las formas de siempre, y los comentarios y los textos no cuentan", () => {
		const a = router(`
			xRoutes.get("/a", consulta(S.fechas), async (c) => c.json(c.req.valid("query")));
			xRoutes.get("/b", consulta(fechas), async (c) => c.json(c.req.query("limit")));
			xRoutes.get("/c", consulta(S.conBusqueda), async (c) => c.json(null));
			// xRoutes.get("/d", async (c) => c.json(c.req.query(nombre)));
			const AYUDA = "c.req.query() o c.req.query(nombre)";
		`);
		expect(a.ilegibles).toEqual([]);
		expect(query(a)).toEqual(["desde", "hasta", "desde", "hasta", "limit", "q"]);
	});

	it("un comentario o un texto sobre la query en un ayudante no hace fallar nada", () => {
		const a = analizar(
			{
				[AYUDANTE]: [
					"// No usar c.req.query() ni new URL(c.req.url).searchParams: la query se lee por su nombre.",
					'export const AYUDA = "usa c.req.query(\'nombre\'), no c.req.queries()";',
					"export const pathname = (c) => new URL(c.req.url).pathname;",
				].join("\n"),
			},
			inventados,
		);
		expect(a.ilegibles).toEqual([]);
		expect(a.query).toEqual([]);
	});

	it("sigue los alias de importación", () => {
		const conAlias = analizar(
			{
				[RUTA]: [
					'import { Hono } from "hono";',
					'import { consulta as validar } from "../../lib/validacion";',
					'import * as V from "../../lib/validacion";',
					'import { conBusqueda as filtros, fechas as rango } from "./inventado.schemas";',
					"export const xRoutes = new Hono();",
					'xRoutes.get("/a", validar(filtros), h);',
					'xRoutes.get("/b", V.consulta(rango), h);',
				].join("\n"),
			},
			inventados,
		);
		expect(conAlias.ilegibles).toEqual([]);
		expect(query(conAlias)).toEqual(["q", "desde", "hasta"]);

		const sinLlamar = analizar(
			{ [RUTA]: 'import { consulta as validar } from "../../lib/validacion";\nexport const v = validar;' },
			inventados,
		);
		expect(sinLlamar.ilegibles).toHaveLength(1);
	});

	it("ve la query que se lee en un ayudante, fuera de los routers", () => {
		const a = analizar(
			{
				[AYUDANTE]: [
					'export const correo = (c) => new URL(c.req.url).searchParams.get("email");',
					"export const telefono = (c) => c.req.query('telefono');",
				].join("\n"),
			},
			inventados,
		);
		expect(a.ilegibles).toEqual([]);
		expect(query(a)).toEqual(["email", "telefono"]);
	});

	it("y lo que sabe leer lo cuenta, aunque lleve un nombre que no puede ir en la query", () => {
		const a = router(`
			xRoutes.get("/a", consulta(S.conBusqueda), async (c) => c.json(c.req.query("email")));
			xRoutes.get("/b", async (c) => c.json(c.req.query('telefono') ?? c.req.query(\`nombre\`)));
		`);
		expect(a.ilegibles).toEqual([]);
		expect(query(a).filter((n) => !EN_LA_QUERY.has(n))).toEqual(["q", "email", "telefono", "nombre"]);
	});

	it.each([
		["un schema escrito en la propia ruta", 'xRoutes.get("/a", consulta(z.object({ q: z.string() })), h);'],
		["un schema ampliado al vuelo", 'xRoutes.get("/a", consulta(S.fechas.extend({ telefono: z.string() })), h);'],
		["un schema declarado en el router", 'const local = z.object({ q: z.string() });\nxRoutes.get("/a", consulta(local), h);'],
		["un schema que no viene de un `*.schemas.ts`", 'xRoutes.get("/a", consulta(otro), h);'],
		["un espacio de nombres que no se ha importado", 'xRoutes.get("/a", consulta(T.fechas), h);'],
		["un schema que deja pasar claves que no declara", 'xRoutes.get("/a", consulta(S.suelto), h);'],
		["un schema que no es un objeto", 'xRoutes.get("/a", consulta(S.dosFormas), h);'],
		["un schema que no existe", 'xRoutes.get("/a", consulta(S.noEsta), h);'],
		["`consulta` pasada como valor", "const validar = consulta;"],
		["un nombre que no es un literal", 'xRoutes.get("/a", async (c) => c.json(c.req.query(nombre)));'],
		["la query entera", 'xRoutes.get("/a", async (c) => c.json(c.req.query()));'],
		["`queries`", 'xRoutes.get("/a", async (c) => c.json(c.req.queries("q")));'],
		["la petición desestructurada en el parámetro", 'xRoutes.get("/a", async ({ req }) => new Response(req.query(nombre)));'],
		[
			"la petición desestructurada en una variable",
			'xRoutes.get("/a", async (c) => { const { query } = c.req; return c.json(query("q")); });',
		],
		["la petición por un nombre calculado", 'xRoutes.get("/a", async (c) => c.json(c.req["query"]("q")));'],
		["`searchParams` recorrido", 'xRoutes.get("/a", async (c) => c.json([...new URL(c.req.url).searchParams]));'],
		["`searchParams.get` sin literal", 'xRoutes.get("/a", async (c) => c.json(new URL(c.req.url).searchParams.get(nombre)));'],
		["la query cruda", 'xRoutes.get("/a", async (c) => c.json(new URL(c.req.url).search));'],
		["`URLSearchParams`", 'xRoutes.get("/a", async (c) => c.json(new URLSearchParams(c.req.url.split("?")[1]).get("q")));'],
		["un validador puesto a mano", 'import { zValidator } from "@hono/zod-validator";\nxRoutes.get("/a", zValidator("query", S.fechas), h);'],
	])("no deja pasar %s", (_que, cuerpo) => {
		expect(router(cuerpo).ilegibles, cuerpo).not.toEqual([]);
	});

	it('en el camino entiende `/:nombre`, `c.req.param("nombre")` y los registros encadenados', () => {
		const a = router(`
			xRoutes.use("*", tenantAuth);
			xRoutes.use(otroMiddleware);
			xRoutes.get("/clientes/:email/form", async (c) => c.json(c.req.param('email')));
			xRoutes.put(
				"/ficheros/*",
				async (c) => c.json(null),
			);
			export const otroRouter = new Hono().get("/proveedores/:nombre", h);
		`);
		expect(a.ilegibles).toEqual([]);
		expect(camino(a)).toEqual(["email", "email", "nombre"]);
		expect(a.comodines).toEqual([`${RUTA}: /ficheros/*`]);
	});

	it.each([
		["un camino en una plantilla", "xRoutes.get(`/clientes/${cual}`, h);"],
		["un camino que no es un texto", "xRoutes.get(RUTA_DE_CLIENTES, h);"],
		["un camino que se compone", 'xRoutes.get("/clientes/" + cual, h);'],
		["un `use` con el camino en una plantilla", "xRoutes.use(`/clientes/${cual}`, h);"],
		["todos los parámetros de golpe", 'xRoutes.get("/a/:id", async (c) => c.json(c.req.param()));'],
		["un parámetro que no es un literal", 'xRoutes.get("/a/:id", async (c) => c.json(c.req.param(nombre)));'],
		["un registro con `.on`", 'xRoutes.on("GET", "/clientes/:email", h);'],
		["un router con otro nombre", 'const r = xRoutes;\nr.get("/clientes/:email", h);'],
		["un router pasado a una función", "registrarTodo(xRoutes);"],
	])("en el camino no deja pasar %s", (_que, cuerpo) => {
		expect(router(cuerpo).ilegibles, cuerpo).not.toEqual([]);
	});

	describe("y exige la marca a toda lectura por POST", () => {
		const LECTURA = 'cuerpo(S.fechas), async (c) => c.json(await tenantQuery(c, (db) => q.x(db, c.req.valid("json"))))';

		it.each([
			["con un espacio antes del paréntesis", `xRoutes.post ("/nueva", ${LECTURA});`],
			["con `.post` en otra línea", `xRoutes\n\t.post("/nueva", ${LECTURA});`],
			["encadenada tras otra ruta", `xRoutes.get("/otra", h).post("/nueva", ${LECTURA});`],
		])("no se le escapa una %s", (_que, cuerpo) => {
			const a = router(cuerpo);
			expect(a.ilegibles).toEqual([]);
			expect(sinDeclarar(a, {})).toEqual([`${RUTA} → /nueva`]);
		});

		it("declarada delante de `tenantAuth`, cuenta como lectura; lo que aplica no es una lectura", () => {
			const a = router(`
				xRoutes.use("/nueva", lecturaPorPost());
				xRoutes.use("*", tenantAuth);
				xRoutes.post("/nueva", ${LECTURA});
				xRoutes.post("/escribe", cuerpo(S.fechas), async (c) => c.json(await apply(c, cmd.x(await tenantQuery(c, f)))));
			`);
			expect(a.ilegibles).toEqual([]);
			expect(sinDeclarar(a, {})).toEqual([]);
			expect(declaradas(a)).toEqual({ [RUTA]: ["/nueva"] });
		});

		it("`lecturaPorPost` fuera de un `use` con su camino no vale", () => {
			expect(router("const tope = lecturaPorPost();").ilegibles).toHaveLength(1);
			expect(router('xRoutes.post("/nueva", lecturaPorPost(), h);').ilegibles).toHaveLength(1);
		});
	});
});
