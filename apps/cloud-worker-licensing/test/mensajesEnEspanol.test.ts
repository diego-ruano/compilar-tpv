// test/mensajesEnEspanol.test.ts
//
// VALID-03: lo que se le dice a quien está delante cuando un dato no vale es una frase en español
// que dice qué hacer («Escribe el nombre del producto.»), no el nombre de un campo ni inglés
// («nombre required», «id_mesa invalido»). Desde VALID-02 el texto de un schema llega a la Handy,
// así que un mensaje así vuelve a verse en cuanto alguien lo escribe. Si salta, escribe la frase:
// la misma que da la Main para esa regla. El espejo de la Main es
// `tpv-application/src/error.rs::tests_mensajes_en_espanol`.
//
// Dos pasadas. Cualquier texto del fuente no puede estar en inglés ni llevar un campo junto a
// «inválido»/«requerido». Y lo que va donde se escribe un mensaje (`message:`, `.min(1, "…")`,
// `refine(…, "…")`, `idField("…")`, `MSG_… =`…) no puede llevar ningún nombre con guion bajo: ahí sólo
// cabe una frase o un identificador de máquina de los que ya clasifica `lib/errorCodes.ts`.

import { describe, expect, it } from "vitest";

import { MENSAJES, SIN_MENSAJE_PROPIO, claveDeError } from "../src/lib/errorCodes";

const fuentes = import.meta.glob("../src/{domains,lib}/**/*.ts", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

/** El texto por defecto de zod, que `lib/validacion.ts` usa para reconocerlo y no enseñarlo. */
const EXCEPCIONES = new Set(["Invalid input"]);

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
/** Un identificador, solo o con su diagnóstico detrás (`insufficient_stock:12`, `cantidad_invalida (0)`). */
const IDENTIFICADOR = /^[A-Za-z][A-Za-z0-9_]*(?: \(.*\)|:.*)?$/;
const INGLES = /\b(?:required|invalid|missing)\b/i;
const CAMPO = /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\b/;
/** Un campo que se rellena al componer el texto: «${campo} inválido». */
const CAMPO_INTERPOLADO = /\$\{[^}]*\}\s*(?:inv[aá]lid|requerid|required|invalid)/i;
/** Una sentencia, que no se le enseña a nadie (`ELSE 'invalid'`). */
const SQL = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/;
/** Lo que precede a un texto que es un mensaje. */
const POSICION_DE_MENSAJE = new RegExp(
	[
		String.raw`\bmessage:\s*$`,
		String.raw`\.(?:min|max|length|email|regex|int|positive|nonnegative|refine|url)\((?:[^"\x60]*,)?\s*$`,
		String.raw`\b(?:idField|idCon|requiredString|zDia|zDiaDeHorario|positiveNumber|positiveInt)\(\s*$`,
		String.raw`\bfallo\(\s*(?:\d+\s*,\s*)?"[^"]*"\s*,\s*$`,
		String.raw`\bMSG_[A-Z0-9_]+\s*=\s*$`,
	].join("|"),
);

/** Un código que el worker ya sabe enseñar: con frase en `MENSAJES` o declarado sin ella. */
function esCodigoClasificado(texto: string): boolean {
	const tal = texto.split(":")[0].trim();
	const clave = claveDeError(texto);
	return [tal, clave].some((c) => Object.prototype.hasOwnProperty.call(MENSAJES, c) || SIN_MENSAJE_PROPIO.has(c));
}

/** Lo que no puede decir un mensaje de validación de este fuente. */
function malos(fuente: string): string[] {
	// Los comentarios no se le enseñan a nadie.
	const codigo = fuente
		.split("\n")
		.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
		.join("\n");
	const out: string[] = [];
	for (const m of codigo.matchAll(LITERAL)) {
		const s = m[1] ?? m[2] ?? "";
		if (EXCEPCIONES.has(s) || SQL.test(s)) continue;
		const sinHuecos = s.replace(/\$\{[^}]*\}/g, "");
		const antes = codigo.slice(Math.max(0, m.index - 120), m.index).replace(/\s+/g, " ");
		if (POSICION_DE_MENSAJE.test(antes)) {
			if (esCodigoClasificado(s)) continue;
			// Ahí va una frase: ni un nombre suelto («titulo»), ni uno con guion bajo, ni inglés.
			if (IDENTIFICADOR.test(s) || INGLES.test(sinHuecos) || CAMPO.test(sinHuecos) || CAMPO_INTERPOLADO.test(s)) {
				out.push(s);
			}
		} else if (!IDENTIFICADOR.test(s) && (INGLES.test(sinHuecos) || (/inv[aá]lid|requerid/i.test(sinHuecos) && CAMPO.test(sinHuecos)))) {
			out.push(s);
		}
	}
	return out;
}

describe("los mensajes de validación son frases en español", () => {
	it("lee el fuente de verdad", () => {
		expect(Object.keys(fuentes).length).toBeGreaterThan(80);
	});

	it("caza lo que no es una frase, también donde va un mensaje", () => {
		for (const fuente of [
			`nombre: z.string().min(1, "nombre required"),`,
			`nombre: z.string().min(1, "required"),`,
			`id_mesa: idField("id_mesa"),`,
			`titulo: z.string().min(1, "titulo"),`,
			`codigo: z.string().min(1, "Falta el producto (id_producto)."),`,
			`.refine((v) => v.length > 0, {\n\tmessage: "detalle_ids requerido",\n})`,
			`if (id == null) return badRequest(c, "id_mesa invalido");`,
			"const MSG_DIA = `${campo} inválido`;",
		]) {
			expect(malos(fuente), fuente).not.toEqual([]);
		}
	});

	it("deja pasar las frases y los códigos clasificados", () => {
		for (const fuente of [
			`nombre: z.string().min(1, "Escribe el nombre del producto."),`,
			`id_mesa: idField("Falta la mesa."),`,
			`.refine((v) => v.length > 0, { message: "Elige qué líneas se cobran." })`,
			`pairCode: textoObligatorio("missing_pairCode"),`,
			`.refine(esCodigo, { message: "invalid_pair_code" })`,
			`if (id == null) return badRequest(c, "id_mesa_invalido");`,
			`fallo("personas", \`El número de personas tiene que estar entre 1 y \${PERSONAS_MAX}\`);`,
		]) {
			expect(malos(fuente), fuente).toEqual([]);
		}
	});

	it("ningún mensaje de los dominios ni de lib es un campo o está en inglés", () => {
		const encontrados = Object.entries(fuentes).flatMap(([ruta, texto]) => malos(texto).map((s) => `${ruta}  «${s}»`));
		expect(encontrados).toEqual([]);
	});
});
