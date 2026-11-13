// test/scrubCoste.test.ts
//
// AUD-32 — el filtro de datos personales cuesta un tiempo lineal.
//
// El filtro corre síncrono sobre texto que elige quien llama, y este motor de expresiones regulares
// retrocede: una repetición sin tope que puede empezar en cada posición de un tramo lo recorre
// entero desde cada una, y el tiempo crece con el cuadrado del tamaño. Aquí se comprueba de tres
// maneras, las dos primeras sin reloj:
//
//   1. Las expresiones regulares, leyendo sus fuentes: una con alguna repetición sin tope (`*`, `+`,
//      `{n,}`) sólo vale si está en la lista de excepciones de abajo con su fuente entera, carácter a
//      carácter, y el porqué escrito: cualquier cambio en ella obliga a revisarla. Y el filtro no
//      ejecuta ninguna expresión que no esté en esa lista de fuentes.
//   2. Lo que se recorre a mano (los tres tramos de un JWT y los separadores pegados a un número),
//      contando sus pasos: no pasan de un múltiplo fijo del tamaño del texto.
//   3. Un diagnóstico con reloj, que avisa en la consola y no falla: el mismo texto, entero y en
//      dieciséis trozos. Con un coste lineal tardan lo mismo; con uno cuadrático, el entero tarda
//      dieciséis veces más.
//
// La copia de la Webview es este mismo código (lo comprueba `apps/tpv-main/test/scrub.test.ts`); la
// de Rust usa un motor que no retrocede y el mismo recorrido a mano para los JWT.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-telemetry/src/scrub_casos.json?raw";
import { EXPRESIONES, scrub, scrubContando, scrubDeep, scrubEvent } from "../src/observability/scrub";

const casos = JSON.parse(casosJson) as { redacta: [string, string][]; no_toca: string[]; objetos: [unknown, unknown][] };

/** Repite `pieza` hasta llenar `n` caracteres. */
const llenar = (pieza: string, n: number) => pieza.repeat(Math.ceil(n / pieza.length)).slice(0, n);

// ── 1. Las expresiones regulares ────────────────────────────────────────────────────────────────

/** Los blancos del filtro alrededor de un separador, como están escritos (sin el espacio). */
const BLANCOS = String.raw`\t-\r\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
/** Los que terminan un valor, como están escritos (con el espacio). */
const FIN_DE_VALOR = String.raw` \t-\r\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

/**
 * La fuente de una expresión con las clases de blancos abreviadas: `B` (todos), `T` (todos menos el
 * espacio), `C` (los comunes a las dos copias de antes), `D` (los comunes menos el espacio) y `F` (los
 * comunes, dentro de una clase negada: lo que termina un valor).
 */
function legible(fuente: string): string {
	return fuente
		.replaceAll(String.raw`\/`, "/")
		.replaceAll(`[ ${BLANCOS}]`, "B")
		.replaceAll(`[${BLANCOS}]`, "T")
		.replaceAll(`[${FIN_DE_VALOR}]`, "C")
		.replaceAll(`[${FIN_DE_VALOR.slice(1)}]`, "D")
		.replaceAll(`[^${FIN_DE_VALOR}`, "[^F");
}

/** Las repeticiones sin tope de una expresión, cada una con lo que repite. */
function repeticionesSinTope(fuente: string): string[] {
	const halladas: string[] = [];
	const grupos: number[] = [];
	let atomo = 0;
	let i = 0;
	while (i < fuente.length) {
		const c = fuente[i];
		if (c === "\\") {
			atomo = i;
			i += fuente[i + 1] === "x" ? 4 : fuente[i + 1] === "u" ? 6 : 2;
		} else if (c === "[") {
			atomo = i;
			i++;
			while (fuente[i] !== "]") i += fuente[i] === "\\" ? 2 : 1;
			i++;
		} else if (c === "(") {
			grupos.push(i);
			i++;
		} else if (c === ")") {
			atomo = grupos.pop()!;
			i++;
		} else if (c === "*" || c === "+") {
			halladas.push(fuente.slice(atomo, i + 1));
			i++;
		} else if (c === "{") {
			const llaves = /^\{[0-9]+(,[0-9]*)?\}/.exec(fuente.slice(i));
			if (!llaves) throw new Error(`llave suelta en ${fuente}`);
			if (llaves[1] === ",") halladas.push(fuente.slice(atomo, i + llaves[0].length));
			i += llaves[0].length;
		} else {
			// `?`, `|`, `^` y `$` no repiten nada sin tope; lo demás es un carácter suelto.
			if (!"?|^$".includes(c)) atomo = i;
			i++;
		}
	}
	return halladas;
}

const CLAVES = String.raw`authorization|auth|password|passwd|pwd|contrase[nñÑ]a|secret|token|api[_-]?key|apikey|pin|otp|(?:access|refresh|id)[_-]?token|client[_-]?secret|field[_-]?dek|password[_-]?hash|ticket`;
const VALOR = String.raw`(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^F,;&}"']+)`;
const DE_UNA_CLAVE =
	"Sólo se empieza en una clave con frontera delante, así que cada tramo se mira una vez. Los blancos no se pueden " +
	"repartir de dos maneras: lo que los sigue (`:`, `=`, el valor) no es un blanco. El valor entre comillas avanza de " +
	"carácter en carácter o de escape en escape, y sus dos ramas no casan con lo mismo. El valor sin comillas es lo " +
	"último de la expresión: nada lo hace retroceder.";

/**
 * Las expresiones con alguna repetición sin tope, **con su fuente entera**, y por qué no cuestan más
 * que una pasada. Cualquier cambio en una de ellas, por pequeño que sea (quitar un ancla, por ejemplo),
 * hace fallar el test hasta que alguien la vuelva a revisar y copie aquí la fuente nueva.
 */
const EXCEPCIONES: Record<string, { fuente: string; porque: string }> = {
	autorizacion: {
		fuente: String.raw`\b(authorization|auth)\bB*[:=]B*(?:(?:bearer|basic)B+)?[^F,;&}"']+`,
		porque: "Sólo se empieza en `authorization` o `auth` con frontera delante. " + DE_UNA_CLAVE,
	},
	esquema: {
		fuente: String.raw`\b(?:bearer|basic)B+[A-Za-z0-9._~+/=\-]{4,}`,
		porque:
			"Sólo se empieza en `bearer` o `basic` con frontera delante, los blancos van seguidos de algo que no lo es, " +
			"y la credencial es lo último.",
	},
	secretoEntreComillas: {
		fuente: String.raw`(["'])(${CLAVES})["']B*[:=]B*${VALOR}`,
		porque: "Sólo se empieza en una comilla seguida de una clave. " + DE_UNA_CLAVE,
	},
	secreto: { fuente: String.raw`\b(${CLAVES})\bB*[:=]B*${VALOR}`, porque: DE_UNA_CLAVE },
	diagnostico: {
		fuente:
			String.raw`\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` +
			String.raw`|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?` +
			String.raw`|(?:[a-z_][a-z0-9_]*_ms|timestamp|epoch|ts)C*[:=]C*[0-9]{10,16}` +
			String.raw`|(?:hash|huella|event(?:_id)?)(?:C*[:=]|D*[ ])C*[a-f0-9]{16,128})\b`,
		porque:
			"`[a-z0-9_]*_ms` sólo empieza en una frontera de palabra y no sale de la palabra: una pasada por palabra. " +
			"Los blancos sólo se miran detrás de una palabra clave, y lo que los sigue no es un blanco; en `D*[ ]`, D no " +
			"incluye el espacio, así que sólo hay una forma de repartirlos. Son los blancos comunes (C, y D sin el " +
			"espacio): esto deja algo sin tapar, y ninguna copia tiene que dejar sin tapar más que antes.",
	},
	soloEspacios: {
		fuente: "^ +$",
		porque:
			"Anclada al principio y al final: sólo se prueba desde la primera posición. Sin el `^`, un hueco de n espacios " +
			"seguido de otra cosa se probaría desde cada uno: n² pasos.",
	},
};

describe("AUD-32 · las expresiones del filtro no llevan repeticiones sin tope, salvo las revisadas", () => {
	it.each(Object.entries(EXPRESIONES))("%s", (nombre, expresion) => {
		const fuente = legible(expresion.source);
		const excepcion = EXCEPCIONES[nombre];
		if (!excepcion) {
			expect(repeticionesSinTope(fuente), `${nombre}: /${fuente}/`).toEqual([]);
			return;
		}
		// La fuente entera, carácter a carácter: es lo que se revisó.
		expect(fuente, nombre).toBe(excepcion.fuente);
		expect(repeticionesSinTope(fuente).length).toBeGreaterThan(0);
		expect(excepcion.porque.length).toBeGreaterThan(60);
	});

	it("no sobra ninguna excepción, y quien busca repeticiones las encuentra", () => {
		expect(Object.keys(EXCEPCIONES).filter((nombre) => !(nombre in EXPRESIONES))).toEqual([]);
		expect(repeticionesSinTope(String.raw`\beyJ[A-Za-z0-9_-]+\.[a-z]{1,64}@(?:x|y)*z{2,}\u2000+`)).toEqual([
			"[A-Za-z0-9_-]+", "(?:x|y)*", "z{2,}", String.raw`\u2000+`,
		]);
	});

	it("el filtro no ejecuta ninguna expresión que no esté en esa lista", () => {
		// Toda operación con una expresión regular acaba llamando a su `exec`: se apunta cuáles pasan
		// por ahí mientras el filtro recorre la tabla compartida entera y un evento de Sentry.
		const vistas = new Set<string>();
		const original = RegExp.prototype.exec;
		RegExp.prototype.exec = function (this: RegExp, texto: string) {
			vistas.add(this.source);
			return original.call(this, texto);
		};
		try {
			for (const [entrada] of casos.redacta) scrub(entrada);
			for (const texto of casos.no_toca) scrub(texto);
			for (const [entrada] of casos.objetos) scrubDeep(structuredClone(entrada));
			scrubEvent({
				message: "tel=612345678 911222333 tarjeta 4111 1111 1111 1111",
				logentry: { message: "ana@example.com", params: ["12.345.678-Z"] },
				exception: { values: [{ value: "IBAN ES91 2100 0418 4502 0005 1332" }] },
				breadcrumbs: [{ message: "NSS 28/12345678/40", data: { last_ok_ms: "1727450000002", hash: "abcdef1234567890abcdef" } }],
				tags: { token: "secreto" },
				request: { url: "https://tpv-api.test/v1/clientes", query_string: "correo=ana@example.com" },
			});
		} finally {
			RegExp.prototype.exec = original;
		}
		const registradas = Object.values(EXPRESIONES).map((expresion) => expresion.source);
		expect([...vistas].filter((fuente) => !registradas.includes(fuente))).toEqual([]);
		// Y al revés: la tabla las ejercita todas, así que ninguna se queda sin mirar.
		expect(registradas.filter((fuente) => !vistas.has(fuente))).toEqual([]);
	});
});

// ── 2. Lo que se recorre a mano ─────────────────────────────────────────────────────────────────

/** Textos escritos contra los dos recorridos: los tramos de un JWT y los separadores de un número. */
const RECORRIDOS: [string, (n: number) => string][] = [
	["JWT: cabeceras sin punto", (n) => llenar("eyJ-", n)],
	["JWT: 64 cabeceras y una carga sin firma", (n) => llenar("eyJ-".repeat(64) + "." + "b".repeat(255) + " ", n)],
	["JWT: una cabecera y una carga sin firma", (n) => "eyJ-".repeat(64) + "." + "b".repeat(n - 257)],
	["JWT: cabeceras y cargas sin firma", (n) => llenar("eyJa.b ", n)],
	["JWT: uno detrás de otro", (n) => llenar("eyJa.eyJb.c ", n)],
	["JWT: un tramo sin ninguno", (n) => "a".repeat(n)],
	["números: teléfonos detrás de un tramo de espacios", (n) => " ".repeat(n / 2) + llenar("600000000,", n / 2)],
	["números: teléfonos separados por comas", (n) => llenar("600000000,", n)],
	["números: teléfonos entre tramos de guiones", (n) => llenar("-".repeat(1000) + "612345678", n)],
	["números: teléfonos entre tramos de separadores y cifras", (n) => llenar("1" + " .-".repeat(300) + "612345678", n)],
	["números: teléfonos seguidos", (n) => llenar("612345678 ", n)],
	["números: tarjetas separadas por comas", (n) => llenar("4111111111111111,", n)],
	["números: teléfonos separados por blancos largos", (n) => "612345678" + " ".repeat(n - 19) + "x612345678"],
	["números: cifras separadas por espacios", (n) => llenar("6 ", n)],
];

/** Pasos por carácter que no se rebasan. El peor de los textos de arriba da algo menos de 5. */
const PASOS_POR_CARACTER = 8;

describe("AUD-32 · los recorridos escritos a mano dan un número de pasos proporcional al texto", () => {
	it.each(RECORRIDOS)("%s", (_nombre, entrada) => {
		for (const n of [1024, 4096, 16_384, 65_536]) {
			const cuenta = { pasos: 0 };
			const texto = entrada(n);
			expect(texto.length).toBe(n);
			expect(scrubContando(texto, cuenta)).toBe(scrub(texto));
			expect(cuenta.pasos, `${cuenta.pasos} pasos con ${n} caracteres`).toBeLessThanOrEqual(PASOS_POR_CARACTER * n);
			expect(cuenta.pasos).toBeGreaterThan(0);
		}
	});

	it("el recorrido de los JWT sustituye lo mismo que la expresión de siempre", () => {
		// La regla que había antes de AUD-32. Con textos cortos su coste no se nota.
		const referencia = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
		// Sin cifras, arrobas ni letras con las que escribir una clave: ninguna otra regla interviene.
		const piezas = ["eyJ", "eyJa", "a", "b", ".", ".", "-", "_", " ", "é", "x-", "J", "\n"];
		// Un generador congruencial: los mismos textos en cada pasada.
		let semilla = 20261111;
		const azar = (n: number) => {
			semilla = (Math.imul(semilla, 1103515245) + 12345) & 0x7fffffff;
			return semilla % n;
		};
		let conJwt = 0;
		for (let caso = 0; caso < 20_000; caso++) {
			let texto = "";
			for (let i = 2 + azar(15); i > 0; i--) texto += piezas[azar(piezas.length)];
			const esperado = texto.replace(referencia, "[jwt]");
			if (esperado !== texto) conJwt++;
			expect(scrub(texto), JSON.stringify(texto)).toBe(esperado);
		}
		expect(conJwt).toBeGreaterThan(200);
		// Y sin cota: una cabecera, una carga y una firma de 100.000 caracteres cada una.
		const tramo = "x".repeat(100_000);
		expect(scrub(`fallo eyJ${tramo}.${tramo}.${tramo} fin`)).toBe("fallo [jwt] fin");
	});
});

// ── 3. Diagnóstico con reloj: avisa, no falla ───────────────────────────────────────────────────

const TROZOS = 16;
/** Lineal: 1. Cuadrático: 16. */
const COCIENTE_SOSPECHOSO = 4;

/** Las familias que distinguen: con las reglas de antes de AUD-32, las seis pasaban del cociente. */
const DIAGNOSTICO: [string, number, (n: number) => string][] = [
	["correos: un tramo sin arroba", 8 * 1024, (n) => "a".repeat(n)],
	["JWT: cabeceras sin punto", 8 * 1024, (n) => llenar("eyJ-", n)],
	["diagnóstico: hash y espacios", 8 * 1024, (n) => "hash" + " ".repeat(n - 4)],
	["números: teléfonos detrás de un tramo de espacios", 2 * 1024, (n) => " ".repeat(n / 2) + llenar("600000000,", n / 2)],
	["números: teléfonos separados por comas", 64 * 1024, (n) => llenar("600000000,", n)],
	["números: teléfonos separados por blancos largos", 8 * 1024, (n) => "612345678" + " ".repeat(n - 19) + "x612345678"],
];

const turno = () => new Promise((r) => setTimeout(r, 0));

/** Lo que tarda `f`. El reloj se lee tras ceder el turno: dentro de código síncrono puede no avanzar. */
async function cronometrar(f: () => void): Promise<number> {
	await turno();
	const t0 = Date.now();
	f();
	await turno();
	return Date.now() - t0;
}

// No hace fallar la suite: cada medida incluye la espera del turno siguiente, y la carga ajena de la
// máquina pesa en ella. Lo que vigila el coste son las dos secciones de arriba; esto sólo avisa en la
// consola si un texto entero tarda bastante más que sus trozos, para mirarlo.
describe("AUD-32 · diagnóstico: un texto entero frente a sus trozos (avisa, no falla)", () => {
	it.each(DIAGNOSTICO)("%s", async (nombre, n, entrada) => {
		const entero = entrada(n);
		const trozos = Array.from({ length: TROZOS }, () => entrada(n / TROZOS));
		const enTrozos = (veces: number) => cronometrar(() => {
			for (let v = 0; v < veces; v++) for (const trozo of trozos) scrub(trozo);
		});
		const deUnaVez = (veces: number) => cronometrar(() => {
			for (let v = 0; v < veces; v++) scrub(entero);
		});
		let veces = 1;
		let msEntero = 0;
		let msTrozos = 0;
		for (;;) {
			msTrozos = await enTrozos(veces);
			msEntero = await deUnaVez(veces);
			if (Math.max(msEntero, msTrozos) >= 100 || veces >= 1024) break;
			veces *= 4;
		}
		if (msEntero > COCIENTE_SOSPECHOSO * Math.max(msTrozos, 1)) {
			console.warn(`AUD-32 · ${nombre}: entero ${msEntero} ms, en ${TROZOS} trozos ${msTrozos} ms (${veces} veces). ¿Una regla que no es lineal?`);
		}
	}, 120_000);
});
