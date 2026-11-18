// AUD-25: toda gráfica se monta sobre `features/estadisticas/apexBase.ts` y ninguna escribe HTML
// por su cuenta.
//
// `apexBase.ts` hace dos cosas al importarlo: da `APEX_CHART_BASE` (sin el cual ApexCharts inyecta
// un `<style>` que la CSP bloquea) y fija en `window.Apex` los formateadores que escapan lo que
// ApexCharts escribe con `innerHTML`. Una gráfica puede quedarse sin ello de dos maneras, y ninguna
// se nota en `pnpm tauri dev`: montándose sin la base, o fijando en sus opciones algo que pisa esos
// formateadores o que ApexCharts escribe tal cual.
//
// Este test lee con el analizador de TypeScript las opciones de cada `<ReactApexChart options=…>`
// y falla en los dos casos. Caza lo corriente: sigue un nombre hasta el objeto que hay detrás si
// está escrito en el mismo fichero, y lo que no sabe leer lo da por malo y dice qué hacer. No es
// la protección de fondo. Ésa son el formateador de `apexBase.ts`, que escapa lo que una gráfica
// no toque, y `react/etiquetasApexEscapadas.test.tsx`, que monta las seis pantallas con nombres
// hostiles.

import ts from "typescript";
import { describe, expect, it } from "vitest";

type Proyecto = Record<string, string>;

const fuentes: Proyecto = import.meta.glob<string>("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

const BASE = "../src/features/estadisticas/apexBase.ts";

// ── Qué ficheros se miran ────────────────────────────────────────────────────────────────────

/** Los que pueden llevar opciones de una gráfica: su carpeta y quien importe ApexCharts o la base. */
const llevaOpciones = (ruta: string, fuente: string) =>
    ruta.startsWith("../src/features/estadisticas/") ||
    /from\s+["'](?:react-)?apexcharts["']/.test(fuente) ||
    /from\s+["'][^"']*\/apexBase["']/.test(fuente);

const revisados = (proyecto: Proyecto) =>
    Object.keys(proyecto).filter((ruta) => ruta !== BASE && llevaOpciones(ruta, proyecto[ruta]!));

/** El fichero del proyecto al que apunta un `import` relativo. */
function ficheroDe(desde: string, modulo: string, proyecto: Proyecto): string | undefined {
    if (!modulo.startsWith(".")) return undefined;
    const partes = desde.split("/").slice(0, -1);
    for (const parte of modulo.split("/")) {
        if (parte === "..") partes.pop();
        else if (parte !== ".") partes.push(parte);
    }
    const sinExtension = partes.join("/");
    return [`${sinExtension}.ts`, `${sinExtension}.tsx`, `${sinExtension}/index.ts`, `${sinExtension}/index.tsx`].find(
        (ruta) => proyecto[ruta] !== undefined,
    );
}

// ── Lo que ApexCharts 5.13.0 escribe con `innerHTML` y sale de las opciones de una gráfica ──────
//
// Las opciones se nombran por su ruta (`tooltip.y.title`), y una regla vale para toda ruta que
// acabe así: lo mismo da que esté en las opciones o dentro de `responsive[].options`.

/** Se escriben tal cual: no hay forma de usarlas que este test pueda dar por buena. */
const PROHIBIDAS: Array<[ruta: string, porque: string]> = [
    ["tooltip.custom", "tooltip.custom se escribe tal cual como HTML"],
    ["tooltip.z", "tooltip.z (su título y su valor) se escribe tal cual como HTML"],
    ["yaxis.tooltip", "el tooltip del eje Y se escribe como HTML"],
    ["legend.tooltipHoverFormatter", "legend.tooltipHoverFormatter se escribe tal cual en la leyenda"],
    ["markers.customHTML", "legend.markers.customHTML se escribe tal cual como HTML"],
    ["customSVG", "el customSVG de una anotación se escribe tal cual"],
    ["toolbar.tools", "chart.toolbar.tools (sus iconos y customIcons) se escribe tal cual como HTML"],
    ["chart.locales", "los textos de la barra de herramientas se escriben tal cual como HTML"],
    ["goals", "el nombre y el color de un goal se escriben tal cual como HTML"],
];

/**
 * Aquí viven los formateadores de `apexBase.ts`, y ApexCharts sólo funde objetos: una lista
 * (`tooltip.y` admite una, con un formateador por serie) o cualquier otra cosa los sustituye.
 */
const SOLO_OBJETO = ["tooltip", "tooltip.x", "tooltip.y", "tooltip.y.title", "legend"];

/** Además de ésas, las opciones de las que cuelga algo que se escribe como HTML: hay que poder leerlas. */
const HAY_QUE_LEERLAS = [
    ...SOLO_OBJETO,
    "legend.markers",
    "xaxis",
    "xaxis.tooltip",
    "yaxis",
    "yaxis.labels",
    "chart",
    "chart.toolbar",
    "annotations",
    "responsive",
    "responsive.options",
];

// Un `formatter` se juzga por la opción en la que está:
//
//   - "texto": recibe un nombre (la categoría, la serie, la entrada de la leyenda) y lo que devuelve
//     se escribe como HTML. Pisa el de `apexBase.ts`, así que tiene que escapar él.
//   - "valor": recibe el número de la serie y lo que devuelve se escribe como HTML. Vale si sólo
//     usa ese número y funciones de formato. `yaxis.labels` entra aquí porque ApexCharts lo usa
//     para el valor del tooltip cuando no hay `tooltip.y.formatter`.
//   - "libre": se pinta como texto SVG, o pasa después por el formateador de `apexBase.ts`.
type Clase = "texto" | "valor" | "libre" | "prohibido" | "desconocido";

function claseDelFormatter(camino: string[]): Clase {
    const padre = camino[camino.length - 2];
    const abuelo = camino[camino.length - 3];
    if (padre === "x" || padre === "title" || padre === "legend") return "texto"; // tooltip.x, tooltip.y.title, legend
    if (padre === "y") return "valor"; // tooltip.y
    if (padre === "labels" && abuelo === "yaxis") return "valor";
    if (padre === "labels" && abuelo === "xaxis") return "libre"; // el título lo escapa apexBase.ts
    if (padre === "value" || padre === "total" || padre === "name" || padre === "dataLabels") return "libre"; // SVG
    if (padre === "tooltip") return "prohibido"; // xaxis.tooltip.formatter
    return "desconocido";
}

/** Lo que un formateador de valores puede usar además de su número y de lo que él mismo declare. */
const DE_FORMATO = new Set(["eur", "deCentimos", "formatHours", "Math", "Number", "String"]);

// ── El análisis ──────────────────────────────────────────────────────────────────────────────

type Funcion = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | ts.FunctionDeclaration;
type Literal = ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
/** Los literales que hay detrás de una expresión; o que viene de un fichero que este test revisa; o por qué no se lee. */
type Resuelto = Literal[] | "revisado" | { porque: string };

function sinEnvoltorio(e: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
        e = e.expression;
    }
    return e;
}

const esFuncion = (n: ts.Node): n is Funcion =>
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n);

/** Recorre el cuerpo de `fn` sin entrar en las funciones que tenga dentro. */
function porElCuerpo(fn: Funcion, mirar: (n: ts.Node) => void) {
    const bajar = (n: ts.Node) => {
        if (esFuncion(n)) return;
        mirar(n);
        ts.forEachChild(n, bajar);
    };
    if (fn.body) ts.forEachChild(fn.body, bajar);
}

/** Todo lo que devuelve `fn`. */
function devoluciones(fn: Funcion): ts.Expression[] {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const todas: ts.Expression[] = [];
    porElCuerpo(fn, (n) => {
        if (ts.isReturnStatement(n) && n.expression) todas.push(n.expression);
    });
    return todas;
}

/** Acaba siempre en un `return` con algo (o lanzando): no hay camino que salga sin devolver nada. */
function siempreDevuelve(s: ts.Statement | undefined): boolean {
    if (!s) return false;
    if (ts.isReturnStatement(s)) return s.expression !== undefined;
    if (ts.isThrowStatement(s)) return true;
    if (ts.isBlock(s)) return siempreDevuelve(s.statements[s.statements.length - 1]);
    if (ts.isIfStatement(s)) return siempreDevuelve(s.thenStatement) && siempreDevuelve(s.elseStatement);
    return false;
}

/** Las constantes que declara `fn`, con lo que valen. */
function constantesDe(fn: Funcion): Map<string, ts.Expression> {
    const constantes = new Map<string, ts.Expression>();
    porElCuerpo(fn, (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (n.parent.flags & ts.NodeFlags.Const) !== 0) {
            constantes.set(n.name.text, n.initializer);
        }
    });
    return constantes;
}

/** Un texto fijo, algo pasado por `escaparHtml`, una mezcla de las dos cosas, o una constante que lo sea. */
function esTextoSeguro(e: ts.Expression, constantes: Map<string, ts.Expression>, hondura = 0): boolean {
    e = sinEnvoltorio(e);
    const seguro = (parte: ts.Expression) => esTextoSeguro(parte, constantes, hondura + 1);
    if (hondura > 8) return false;
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return true;
    if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === "escaparHtml";
    if (ts.isTemplateExpression(e)) return e.templateSpans.every((tramo) => seguro(tramo.expression));
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return seguro(e.left) && seguro(e.right);
    if (ts.isConditionalExpression(e)) return seguro(e.whenTrue) && seguro(e.whenFalse);
    if (ts.isIdentifier(e)) {
        const valor = constantes.get(e.text);
        return valor !== undefined && seguro(valor);
    }
    return false;
}

/**
 * Todo lo que devuelve es texto seguro, y siempre devuelve algo: si no, ApexCharts escribiría el
 * nombre tal cual.
 */
function devuelveTextoSeguro(fn: Funcion): boolean {
    if (!fn.body) return false;
    if (ts.isBlock(fn.body) && !siempreDevuelve(fn.body)) return false;
    const constantes = constantesDe(fn);
    return devoluciones(fn).every((e) => esTextoSeguro(e, constantes));
}

/** No usa nada más que su primer parámetro (el número), lo que ella misma declara y funciones de formato. */
function soloUsaElNumero(fn: Funcion): boolean {
    const numero = fn.parameters[0]?.name;
    if (!fn.body || !numero || !ts.isIdentifier(numero)) return false;
    const propios = new Set([numero.text]);
    const usados: string[] = [];
    let limpio = true;
    const mirar = (n: ts.Node) => {
        if (ts.isTypeNode(n)) return;
        if (n.kind === ts.SyntaxKind.ThisKeyword) limpio = false;
        if (ts.isIdentifier(n)) {
            const p = n.parent;
            const declara =
                (ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) && p.name === n;
            const esNombreDeMiembro =
                (ts.isPropertyAccessExpression(p) && p.name === n) ||
                (ts.isPropertyAssignment(p) && p.name === n) ||
                (ts.isBindingElement(p) && p.propertyName === n);
            if (declara) propios.add(n.text);
            else if (!esNombreDeMiembro) usados.push(n.text);
            return;
        }
        ts.forEachChild(n, mirar);
    };
    mirar(fn.body);
    return limpio && usados.every((nombre) => propios.has(nombre) || DE_FORMATO.has(nombre));
}

/** El nombre de una propiedad; nada si es una clave calculada. */
function nombreDe(n: ts.PropertyName): string | undefined {
    return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n) ? n.text : undefined;
}

/** Lo que una gráfica no puede llevar en sus opciones; vacío si no lleva nada de eso. */
function revisar(ruta: string, proyecto: Proyecto): string[] {
    const fichero = ts.createSourceFile(ruta, proyecto[ruta]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const queSeRevisa = new Set(revisados(proyecto));
    const problemas = new Set<string>();
    const camino: string[] = [];
    const anotar = (motivo: string, n: ts.Node): void => {
        problemas.add(`${camino.join(".") || "(opciones)"}: ${motivo} → ${n.getText(fichero).replace(/\s+/g, " ").slice(0, 80)}`);
    };
    const acabaEn = (rutaDeOpcion: string) => {
        const sufijo = rutaDeOpcion.split(".");
        return sufijo.every((nombre, i) => camino[camino.length - sufijo.length + i] === nombre);
    };

    // Lo que el fichero declara y lo que importa, por su nombre (sin ámbitos: basta para lo corriente).
    const iniciales = new Map<string, ts.Expression[]>();
    const funciones = new Map<string, Funcion[]>();
    const importados = new Map<string, string>();
    const graficas = new Set<string>(); // los nombres con los que se importa el componente
    const deLaBase = new Set<string>();
    const apuntar = <T>(mapa: Map<string, T[]>, nombre: string, valor: T) => mapa.set(nombre, [...(mapa.get(nombre) ?? []), valor]);
    const recoger = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) apuntar(iniciales, n.name.text, n.initializer);
        if (ts.isFunctionDeclaration(n) && n.name) apuntar(funciones, n.name.text, n);
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
            const modulo = n.moduleSpecifier.text;
            const { name, namedBindings } = n.importClause;
            const nombres = namedBindings && ts.isNamedImports(namedBindings) ? [...namedBindings.elements] : [];
            if (name) importados.set(name.text, modulo);
            if (name && modulo === "react-apexcharts") graficas.add(name.text);
            if (namedBindings && ts.isNamespaceImport(namedBindings)) importados.set(namedBindings.name.text, modulo);
            for (const e of nombres) importados.set(e.name.text, modulo);
            if (/(^|\/)apexBase$/.test(modulo)) for (const e of nombres) if (!e.propertyName) deLaBase.add(e.name.text);
        }
        ts.forEachChild(n, recoger);
    };
    recoger(fichero);

    /** La función que hay escrita en `e`, también dentro de un `useCallback`. */
    function funcionEn(e: ts.Expression | undefined): Funcion | undefined {
        if (!e) return undefined;
        e = sinEnvoltorio(e);
        if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "useCallback") return funcionEn(e.arguments[0]);
        return undefined;
    }

    const lasQueHaya = (candidatas: Array<Funcion | undefined>) => candidatas.filter((fn): fn is Funcion => fn !== undefined);

    /** Las funciones de este fichero que se llaman `nombre`. */
    const funcionesLlamadas = (nombre: string): Funcion[] => [
        ...(funciones.get(nombre) ?? []),
        ...lasQueHaya((iniciales.get(nombre) ?? []).map(funcionEn)),
    ];

    /** Si `nombre` se importa: de un fichero que este test revisa, o de dónde. */
    function deOtroFichero(nombre: string): Resuelto | undefined {
        const modulo = importados.get(nombre);
        if (modulo === undefined) return undefined;
        const destino = ficheroDe(ruta, modulo, proyecto);
        return destino !== undefined && queSeRevisa.has(destino)
            ? "revisado"
            : { porque: `\`${nombre}\` viene de «${modulo}», que este test no revisa` };
    }

    function juntar(partes: ts.Expression[], hondura: number): Resuelto {
        if (partes.length === 0) return { porque: "no devuelve nada" };
        const literales = new Set<Literal>();
        for (const parte of partes) {
            const r = resolver(parte, hondura + 1);
            if (r === "revisado") continue;
            if (!Array.isArray(r)) return r;
            r.forEach((literal) => literales.add(literal));
        }
        return literales.size > 0 ? [...literales] : "revisado";
    }

    /** Sigue `e` hasta el objeto que hay detrás: una constante, un `useMemo`, una función de este fichero. */
    function resolver(e: ts.Expression, hondura = 0): Resuelto {
        e = sinEnvoltorio(e);
        if (hondura > 8) return { porque: "da demasiadas vueltas" };
        if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return [e];
        if (ts.isConditionalExpression(e)) return juntar([e.whenTrue, e.whenFalse], hondura);
        if (ts.isIdentifier(e)) {
            const valores = iniciales.get(e.text);
            return deOtroFichero(e.text) ?? (valores ? juntar(valores, hondura) : { porque: `no se ve qué vale \`${e.text}\`` });
        }
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
            const llamada = e.expression.text;
            const escritas = llamada === "useMemo" ? lasQueHaya([funcionEn(e.arguments[0])]) : funcionesLlamadas(llamada);
            if (escritas.length > 0) return juntar(escritas.flatMap(devoluciones), hondura);
            const deFuera = deOtroFichero(llamada);
            if (deFuera) return deFuera;
        }
        const suelto = ts.isLiteralExpression(e) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(e.kind);
        return { porque: suelto ? "no es un objeto" : "se fabrica de una forma que este test no sabe leer" };
    }

    let usaEscaparHtml = false;
    let conBase = false;
    const enCurso = new Set<ts.Node>();

    function juzgarFormatter(valor: ts.Expression | undefined, n: ts.ObjectLiteralElementLike) {
        const clase = claseDelFormatter(camino);
        if (clase === "libre") return;
        if (clase === "prohibido") return anotar("el formatter del tooltip de un eje se salta el de apexBase.ts: quítalo", n);
        if (clase === "desconocido") return anotar("formatter en una opción que este test no conoce: si se escribe como HTML, añádela a su tabla", n);
        // Una función escrita aquí, o el nombre de una que lo esté.
        const escrita = valor && sinEnvoltorio(valor);
        const candidatas = ts.isMethodDeclaration(n) ? [n] : escrita && ts.isIdentifier(escrita) ? funcionesLlamadas(escrita.text) : [funcionEn(escrita)];
        const fn = candidatas.length === 1 ? candidatas[0] : undefined;
        if (!fn) return anotar("el formateador tiene que ser una función escrita en este fichero, para poder leerla", n);
        if (devuelveTextoSeguro(fn)) {
            if (/\bescaparHtml\(/.test(fn.getText(fichero))) usaEscaparHtml = true;
        } else if (clase === "texto") {
            anotar("lo que devuelve se escribe como HTML: devuelve un texto fijo o escaparHtml(…)", n);
        } else if (!soloUsaElNumero(fn)) {
            anotar("lo que devuelve se escribe como HTML: usa sólo el número con funciones de formato, o escaparHtml(…)", n);
        }
    }

    /** `estricto`: son las opciones de una gráfica, y lo que no se pueda leer es un problema. */
    function objeto(literal: ts.ObjectLiteralExpression, estricto: boolean) {
        if (enCurso.has(literal)) return;
        enCurso.add(literal);
        for (const p of literal.properties) {
            if (ts.isSpreadAssignment(p)) {
                esparcido(p, estricto);
            } else if (ts.isGetAccessor(p) || ts.isSetAccessor(p) || nombreDe(p.name) === undefined) {
                if (estricto) anotar("clave calculada o propiedad con get/set: escribe la opción con su nombre y su valor", p);
            } else {
                camino.push(nombreDe(p.name)!);
                miembro(p, estricto);
                camino.pop();
            }
        }
        enCurso.delete(literal);
    }

    function esparcido(p: ts.SpreadAssignment, estricto: boolean) {
        const e = sinEnvoltorio(p.expression);
        if (ts.isIdentifier(e) && e.text === "APEX_CHART_BASE") {
            if (camino.join(".") === "chart") conBase = true;
            return;
        }
        const r = resolver(e);
        if (r === "revisado") return;
        if (!Array.isArray(r)) {
            if (estricto) anotar(`objeto esparcido que no se puede leer (${r.porque}): escríbelo en este fichero o en features/estadisticas/`, p);
            return;
        }
        for (const literal of r) {
            if (ts.isObjectLiteralExpression(literal)) objeto(literal, estricto);
            else if (estricto) anotar("se esparce una lista dentro de las opciones: escribe las opciones como un objeto", p);
        }
    }

    /** Baja por el valor de una opción. `p`: la propiedad de la que es valor; nada si es un elemento de una lista. */
    function valorDe(valor: ts.Expression, estricto: boolean, p: ts.Node | undefined) {
        const soloObjeto = p !== undefined && SOLO_OBJETO.some(acabaEn);
        const hayQueLeerlo = p !== undefined && HAY_QUE_LEERLAS.some(acabaEn);
        const r = resolver(valor);
        if (r === "revisado") return;
        if (!Array.isArray(r)) {
            // Un dato (las categorías, un color) puede ser cualquier cosa. Una opción de la que
            // cuelga HTML, no; y donde vive un formateador de la base, tampoco en una pieza suelta.
            if (hayQueLeerlo && (estricto || soloObjeto)) anotar(`no se puede leer (${r.porque}): escríbelo como un objeto en este fichero`, p);
            return;
        }
        for (const literal of r) {
            if (ts.isObjectLiteralExpression(literal)) objeto(literal, estricto);
            else if (soloObjeto) anotar("una lista aquí sustituye al formateador de apexBase.ts en vez de fundirse con él: escríbelo como un objeto", p);
            else literal.elements.forEach((elemento) => valorDe(elemento, estricto, undefined));
        }
    }

    function miembro(p: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.MethodDeclaration, estricto: boolean) {
        const prohibida = PROHIBIDAS.find(([rutaDeOpcion]) => acabaEn(rutaDeOpcion));
        const valor = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
        if (prohibida) anotar(`${prohibida[1]}: quítalo`, p);
        else if (camino[camino.length - 1] === "formatter") juzgarFormatter(valor, p);
        else if (valor) valorDe(valor, estricto, p);
    }

    // Las gráficas del fichero: las opciones y las series de cada `<ReactApexChart …>`.
    let montadas = 0;
    const buscarGraficas = (n: ts.Node) => {
        if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && graficas.has(n.tagName.getText(fichero))) {
            montadas += 1;
            const expresion = (nombre: string) => {
                const atributo = n.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(fichero) === nombre);
                return atributo?.initializer && ts.isJsxExpression(atributo.initializer) ? atributo.initializer.expression : undefined;
            };
            const opciones = expresion("options");
            const r: Resuelto = opciones ? resolver(opciones) : { porque: "no lleva `options={…}`" };
            if (r === "revisado") {
                // Vienen de otro fichero de los que se revisan: allí se miran como piezas sueltas.
            } else if (!Array.isArray(r)) {
                anotar(`no se pueden leer las opciones de la gráfica (${r.porque}): escríbelas como un objeto en este fichero`, n);
            } else {
                for (const literal of r) {
                    conBase = false;
                    if (ts.isObjectLiteralExpression(literal)) objeto(literal, true);
                    if (!conBase) anotar("la gráfica no esparce APEX_CHART_BASE en su `chart: {}`", literal);
                }
            }
            const series = expresion("series");
            const s = series ? resolver(series) : "revisado";
            if (Array.isArray(s)) s.forEach((literal) => valorDe(literal, false, undefined));
        }
        ts.forEachChild(n, buscarGraficas);
    };
    buscarGraficas(fichero);

    if (graficas.size > 0 && montadas === 0) {
        problemas.add("importa react-apexcharts pero no se ve dónde monta la gráfica: usa <ReactApexChart options={…} />");
    }
    if (/import\s+(?!type\b)[^;]*?from\s+["']apexcharts["']/.test(proyecto[ruta]!)) {
        problemas.add("usa ApexCharts sin react-apexcharts: este test sólo sabe leer <ReactApexChart options={…} />");
    }

    // Un fichero que no monta gráficas pero puede llevar opciones (una pieza común): sus objetos
    // se miran sueltos, sin exigirles lo que no se sabe si son.
    if (graficas.size === 0) {
        const sueltos = (n: ts.Node) => {
            if (ts.isObjectLiteralExpression(n)) objeto(n, false);
            else ts.forEachChild(n, sueltos);
        };
        sueltos(fichero);
    }

    // `opciones.tooltip.x.formatter = …`: fuera del objeto no se sabe de qué opción es.
    const asignados = (n: ts.Node) => {
        if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(n.left) &&
            ["formatter", "tooltipHoverFormatter", "customHTML"].includes(n.left.name.text)
        ) {
            anotar(`${n.left.name.text} asignado fuera de las opciones: escríbelo dentro de ellas`, n);
        }
        ts.forEachChild(n, asignados);
    };
    asignados(fichero);

    if (usaEscaparHtml && !deLaBase.has("escaparHtml")) problemas.add("usa escaparHtml sin importarlo de apexBase");
    if (montadas > 0 && !deLaBase.has("APEX_CHART_BASE")) problemas.add("monta una gráfica sin importar APEX_CHART_BASE de apexBase");
    return [...problemas];
}

/** Los problemas de cada fichero revisado que tenga alguno. */
function problemasDe(proyecto: Proyecto): Record<string, string[]> {
    return Object.fromEntries(
        revisados(proyecto)
            .map((ruta) => [ruta, revisar(ruta, proyecto)] as const)
            .filter(([, problemas]) => problemas.length > 0),
    );
}

// ── Las pantallas de verdad ──────────────────────────────────────────────────────────────────

describe("AUD-25: las gráficas se montan sobre apexBase y no escriben HTML por su cuenta", () => {
    it("el test mira las pantallas de Estadísticas", () => {
        expect(fuentes[BASE]).toBeDefined();
        expect(revisados(fuentes)).toEqual(
            expect.arrayContaining([
                "../src/features/estadisticas/ClientesStats.tsx",
                "../src/features/estadisticas/MesasStats.tsx",
                "../src/features/estadisticas/ProductosStats.tsx",
                "../src/features/estadisticas/ProveedoresStats.tsx",
                "../src/features/estadisticas/ReservasStats.tsx",
                "../src/features/estadisticas/TrabajadoresStats.tsx",
            ]),
        );
    });

    it.each(revisados(fuentes))("%s", (ruta) => {
        expect(revisar(ruta, fuentes)).toEqual([]);
    });

    it("nadie más toca los valores por defecto de ApexCharts", () => {
        const otros = Object.entries(fuentes)
            .filter(([ruta, fuente]) => ruta !== BASE && /\bApex\s*=[^=]|\.Apex\b/.test(fuente))
            .map(([ruta]) => ruta);
        expect(otros).toEqual([]);
    });
});

// ── El eje de una barra horizontal de dinero ─────────────────────────────────────────────────
//
// EST-INC-03: en una barra horizontal el eje de valores es `xaxis`, no `yaxis`, y sin formateador
// ApexCharts pinta el número tal cual: los céntimos (12000 en vez de 120,00 €). Una gráfica de
// barras horizontales cuyo tooltip da el valor en euros tiene que dárselo también al eje.

/** El valor de la propiedad `ruta` dentro de un objeto escrito, si está escrita tal cual. */
function propiedadEn(objeto: ts.ObjectLiteralExpression, ruta: string[]): ts.Expression | undefined {
    const [primero, ...resto] = ruta;
    const p = objeto.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && nombreDe(x.name) === primero);
    if (!p) return undefined;
    const valor = sinEnvoltorio(p.initializer);
    if (resto.length === 0) return valor;
    return ts.isObjectLiteralExpression(valor) ? propiedadEn(valor, resto) : undefined;
}

/** Las barras horizontales de dinero de un fichero cuyo eje de valores no sale en euros. */
function ejesSinEuros(ruta: string, fuente: string): string[] {
    const fichero = ts.createSourceFile(ruta, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const enEuros = (e: ts.Expression | undefined) => e !== undefined && /\beur\(/.test(e.getText(fichero));
    const malas: string[] = [];
    const mirar = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
            const horizontal = propiedadEn(n, ["plotOptions", "bar", "horizontal"]);
            if (horizontal?.kind === ts.SyntaxKind.TrueKeyword && enEuros(propiedadEn(n, ["tooltip", "y", "formatter"]))) {
                if (!enEuros(propiedadEn(n, ["xaxis", "labels", "formatter"]))) {
                    malas.push(`línea ${fichero.getLineAndCharacterOfPosition(n.getStart(fichero)).line + 1}`);
                }
            }
        }
        ts.forEachChild(n, mirar);
    };
    mirar(fichero);
    return malas;
}

describe("EST-INC-03: una barra horizontal de dinero enseña euros en su eje", () => {
    it.each(revisados(fuentes))("%s", (ruta) => {
        expect(ejesSinEuros(ruta, fuentes[ruta]!)).toEqual([]);
    });

    it("ve el eje sin formato y deja pasar el que lo tiene", () => {
        const opciones = (eje: string) =>
            `const o = { plotOptions: { bar: { horizontal: true } }, xaxis: { categories: c${eje} }, tooltip: { y: { formatter: (v: number) => eur(deCentimos(v)) } } };`;
        expect(ejesSinEuros("a.tsx", opciones(""))).toHaveLength(1);
        expect(ejesSinEuros("a.tsx", opciones(", labels: { formatter: (v: string) => eur(deCentimos(Number(v))) }"))).toEqual([]);
        // Una barra vertical o una que no es de dinero no entran.
        expect(ejesSinEuros("a.tsx", opciones("").replace("horizontal: true", "horizontal: false"))).toEqual([]);
        expect(ejesSinEuros("a.tsx", opciones("").replace("eur(deCentimos(v))", "`${v} h`"))).toEqual([]);
    });
});

// ── El propio guardián ───────────────────────────────────────────────────────────────────────
//
// Es un programa y también se equivoca. Estos casos son las formas de saltárselo que se le han
// encontrado y el código razonable que tiene que dejar pasar. Cada uno es una pantalla que monta
// una gráfica fuera de la carpeta de Estadísticas: entra en la revisión por lo que importa.

describe("AUD-25: el guardián de las gráficas", () => {
    const PANTALLA = "../src/features/otra/Pantalla.tsx";
    const CABECERA = 'import Grafica from "react-apexcharts";\nimport { APEX_CHART_BASE, escaparHtml } from "../estadisticas/apexBase";\n';

    /** Una pantalla con una gráfica cuyas opciones son `cuerpo`; `antes`, lo que haya fuera de ellas. */
    const pantalla = (cuerpo: string, antes = "") =>
        `${CABECERA}${antes}\nexport function Pantalla() {\n` +
        `    const opciones = { chart: { ...APEX_CHART_BASE, type: "bar" }, ${cuerpo} };\n` +
        '    return <Grafica options={opciones} series={[]} type="bar" />;\n}\n';

    const problemas = (cuerpo: string, antes = "", otros: Proyecto = {}) => problemasDe({ [PANTALLA]: pantalla(cuerpo, antes), ...otros });

    const INSEGURAS: Array<[caso: string, cuerpo: string, antes?: string]> = [
        // El título del tooltip, el nombre de la serie y la leyenda: pisan el formateador de la base.
        ["tooltip.x.formatter que devuelve la categoría", "tooltip: { x: { formatter: (v) => v } }"],
        ["…sin paréntesis", "tooltip: { x: { formatter: v => v } }"],
        ["…detrás de un objeto anidado", "tooltip: { x: { estilo: { a: 1 }, show: true, formatter: (v) => v } }"],
        ["…que escapa a medias", "tooltip: { x: { formatter: (v) => `${escaparHtml(v)} · ${v}` } }"],
        ["…que no siempre devuelve algo", "tooltip: { x: { formatter: (v) => { if (v) return escaparHtml(v); } } }"],
        ["…con una rama sin escapar", "tooltip: { x: { formatter: (v) => { if (v) { return escaparHtml(v); } else { return v; } } } }"],
        ["…que no está escrito en el fichero", "tooltip: { x: { formatter: miFormateador } }"],
        ["…escrito como método", "tooltip: { x: { formatter(v) { return v; } } }"],
        ["…con la clave calculada", 'tooltip: { x: { ["formatter"]: (v) => v } }'],
        ["tooltip.y.title.formatter con el nombre de la serie", "tooltip: { y: { title: { formatter: nombre => nombre } } }"],
        ["…con paréntesis y dos puntos", 'tooltip: { y: { title: { formatter: (nombre) => nombre + ": " } } }'],
        ["…con un rótulo que no es fijo", "tooltip: { y: { title: { formatter: () => rotulo } } }"],
        ["legend.formatter", "legend: { position: 'bottom', formatter: (nombre) => nombre }"],
        ["legend.formatter en una constante aparte", "legend: leyenda", "const leyenda = { show: true, formatter: (nombre) => nombre };"],
        // Lo que sustituye al formateador de la base sin fijar otro: ApexCharts sólo funde objetos.
        ["una lista en tooltip.y, aunque su formateador sea bueno", "tooltip: { y: [{ formatter: (v) => String(v) }] }"],
        ["…escrita en una constante", "tooltip: { y: porSerie }", "const porSerie = [{ formatter: (v) => String(v) }];"],
        ["tooltip.y.title que no es un objeto", 'tooltip: { y: { title: "Ventas" } }'],
        ["tooltip.x que no es un objeto", "tooltip: { x: false }"],
        ["una leyenda que no es un objeto", "legend: false"],
        // El valor: recibe un número, pero puede devolver otra cosa.
        ["tooltip.y.formatter que saca un nombre del contexto", "tooltip: { y: { formatter: (v, { w, dataPointIndex }) => w.globals.labels[dataPointIndex] } }"],
        ["tooltip.y.formatter que usa algo de fuera", "tooltip: { y: { formatter: (v) => `${nombres[v]}` } }"],
        ["…a través de una variable suya", "tooltip: { y: { formatter: (v) => { const n = nombres[v]; return String(n); } } }"],
        ["yaxis.labels.formatter que usa algo de fuera", "yaxis: { labels: { formatter: (v) => etiquetas[v] } }"],
        ["yaxis como lista, con lo mismo", "yaxis: [{ labels: { formatter: (v) => etiquetas[v] } }]"],
        // Lo que se salta el formateador de la base o se escribe tal cual.
        ["xaxis.tooltip.formatter", "xaxis: { tooltip: { formatter: (v) => v } }"],
        ["yaxis.tooltip", "yaxis: { tooltip: { enabled: true } }"],
        ["tooltip.z", "tooltip: { z: { title: nombre } }"],
        ["tooltip.custom", "tooltip: { custom: () => '<b>x</b>' }"],
        ["tooltip.custom en una constante aparte", "tooltip: comun", "const comun = { custom: () => '<b>x</b>' };"],
        ["legend.tooltipHoverFormatter", "legend: { tooltipHoverFormatter: (nombre) => nombre }"],
        ["legend.markers.customHTML", "legend: { markers: { customHTML: () => '<i></i>' } }"],
        ["annotations con customSVG", "annotations: { points: [{ x: 1, y: 1, customSVG: { SVG: dibujo } }] }"],
        ["un icono de la barra de herramientas", "chart: { ...APEX_CHART_BASE, toolbar: { tools: { download: icono } } }"],
        ["customIcons", "chart: { ...APEX_CHART_BASE, toolbar: { tools: { customIcons: [{ icon: icono }] } } }"],
        ["las opciones dentro de responsive", "responsive: [{ breakpoint: 480, options: { tooltip: { x: { formatter: (v) => v } } } }]"],
        // Lo que no se puede leer se da por malo.
        ["una opción fabricada con Object.fromEntries", 'tooltip: Object.fromEntries([["x", { formatter: (v) => v }]])'],
        ["…un nivel más abajo", 'tooltip: { x: Object.fromEntries([["formatter", (v) => v]]) }'],
        ["un objeto esparcido que se fabrica", "...Object.fromEntries(pares)"],
        ["un objeto esparcido que llega por parámetro", "...resto"],
        ["un formatter asignado después", "tooltip: {}", "opciones.tooltip.x.formatter = (v) => v;"],
    ];

    it.each(INSEGURAS)("no deja pasar %s", (_caso, cuerpo, antes) => {
        expect(problemas(cuerpo, antes)).not.toEqual({});
    });

    const SEGURAS: Array<[caso: string, cuerpo: string, antes?: string]> = [
        ["un rótulo fijo", 'tooltip: { y: { title: { formatter: () => "Total" } } }'],
        ["un nombre escapado", "tooltip: { x: { formatter: (v) => escaparHtml(v) } }"],
        ["…con texto alrededor", "legend: { formatter: (nombre) => `${escaparHtml(nombre)} (total)` }"],
        ["…en una función con cuerpo", "tooltip: { x: { formatter: (v) => { const t = recortar(v); return escaparHtml(t); } } }"],
        ["…guardado en una constante", "legend: { formatter: (nombre) => { const t = escaparHtml(nombre); return `${t} (total)`; } }"],
        ["…con un if/else que escapa en las dos ramas", 'tooltip: { x: { formatter: (v) => { if (v) { return escaparHtml(v); } else { return "—"; } } } }'],
        ["una leyenda segura en una constante aparte", "legend: leyenda", "const leyenda = { show: true, formatter: (nombre) => escaparHtml(nombre) };"],
        ["una leyenda que sale de un hook del fichero", "legend: leyenda", "function useLeyenda() { return useMemo(() => ({ show: true }) as any, []); }\nconst leyenda = useLeyenda();"],
        ["un valor con formato", "tooltip: { y: { formatter: (v: number) => eur(deCentimos(v)) } }"],
        ["un valor con unidades", "tooltip: { y: { formatter: (v: number) => `${Math.round(v)} clientes` } }"],
        ["un valor que pasa por una variable suya", "tooltip: { y: { formatter: (v) => { const n = Math.round(v); return String(n); } } }"],
        ["un formateador de valores con nombre", "tooltip: { y: { formatter: aEuros } }", "const aEuros = (v: number) => eur(deCentimos(v));"],
        ["el eje Y con formato", "yaxis: { labels: { formatter: (v: any) => String(Math.round(v)) } }"],
        ["el eje X, que pasa por la base", "xaxis: { categories: nombres, labels: { formatter: (v) => recortar(v) } }"],
        ["el centro de una tarta, que es SVG", "plotOptions: { pie: { donut: { labels: { value: { formatter: (v) => v }, total: { label: nombre, formatter: () => `${n}%` } } } } }"],
        ["apagar el tooltip del eje X", "xaxis: { tooltip: { enabled: false } }"],
        ["entradas de leyenda propias, que pasan por el formateador de la base", "legend: { customLegendItems: nombres }"],
        ["los datos, vengan de donde vengan", "xaxis: { categories: props.nombres }, colors: [color], labels: etiquetas"],
        ["`custom`, `z` y `goals` en objetos que no son de la gráfica", "tooltip: { enabled: true }", "const estilo = { custom: 1, z: 2, goals: [3], formatter: (v) => v };"],
    ];

    it.each(SEGURAS)("deja pasar %s", (_caso, cuerpo, antes) => {
        expect(problemas(cuerpo, antes)).toEqual({});
    });

    it("que `escaparHtml` aparezca en otro sitio del fichero no autoriza nada", () => {
        expect(problemas("tooltip: { x: { formatter: (v) => v } }", 'const rotulo = escaparHtml("x");')[PANTALLA]).toHaveLength(1);
    });

    it("`escaparHtml` y `APEX_CHART_BASE` tienen que ser los de la base", () => {
        const sinImportar = pantalla("tooltip: { x: { formatter: (v) => escaparHtml(v) } }").replace(
            /import \{[^}]*\} from "[^"]*apexBase";/,
            "const APEX_CHART_BASE = {};\nconst escaparHtml = (t) => t;",
        );
        expect(problemasDe({ [PANTALLA]: sinImportar })[PANTALLA]).toEqual([
            "usa escaparHtml sin importarlo de apexBase",
            "monta una gráfica sin importar APEX_CHART_BASE de apexBase",
        ]);
    });

    it("ve una gráfica sin la base", () => {
        const sinBase = pantalla("tooltip: {}").replace("...APEX_CHART_BASE, ", "");
        expect(problemasDe({ [PANTALLA]: sinBase })).not.toEqual({});
        const sinChart = `${CABECERA}export const P = () => <Grafica options={{ tooltip: { enabled: true } }} series={[]} />;`;
        expect(problemasDe({ [PANTALLA]: sinChart })).not.toEqual({});
    });

    it("no da por buenas unas opciones que no puede leer", () => {
        const montada = (atributos: string) => ({ [PANTALLA]: `${CABECERA}export const P = (props) => <Grafica ${atributos} series={[]} />;` });
        expect(problemasDe(montada("options={Object.fromEntries(pares)}"))).not.toEqual({});
        expect(problemasDe(montada("options={props.opciones}"))).not.toEqual({});
        expect(problemasDe(montada("{...props}"))).not.toEqual({});
        expect(problemasDe({ [PANTALLA]: `${CABECERA}export const P = () => React.createElement(Grafica, { options: {} });` })).not.toEqual({});
    });

    // La selección de ficheros: unas opciones escritas en otro módulo.
    const INSEGURO = "export const comunes = { tooltip: { x: { formatter: (v) => v } } };\n";
    const DE_FUERA = "../src/shared/comunes.ts";
    const DE_LA_CARPETA = "../src/features/estadisticas/comunes.ts";

    it("no deja traer opciones de un fichero que no revisa", () => {
        const antes = 'import { comunes } from "../../shared/comunes";';
        const otros = { [DE_FUERA]: INSEGURO };
        expect(problemas("...comunes", antes, otros)[PANTALLA]).toHaveLength(1);
        expect(problemas("tooltip: comunes.tooltip", antes, otros)[PANTALLA]).toHaveLength(1);
        expect(problemas("legend: comunes", antes, otros)[PANTALLA]).toHaveLength(1);
        const enteras = `${CABECERA}${antes}\nexport const P = () => <Grafica options={comunes} series={[]} />;`;
        expect(problemasDe({ [PANTALLA]: enteras, ...otros })[PANTALLA]).toHaveLength(1);
    });

    it("y si el fichero es de los que revisa, el que falla es ese fichero", () => {
        const antes = 'import { comunes } from "../estadisticas/comunes";';
        expect(Object.keys(problemas("...comunes", antes, { [DE_LA_CARPETA]: INSEGURO }))).toEqual([DE_LA_CARPETA]);
        const seguro = 'import { escaparHtml } from "./apexBase";\nexport const comunes = { tooltip: { x: { formatter: (v) => escaparHtml(v) } } };\n';
        expect(problemas("...comunes", antes, { [DE_LA_CARPETA]: seguro })).toEqual({});
    });
});
