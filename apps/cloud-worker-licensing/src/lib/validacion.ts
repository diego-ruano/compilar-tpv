// src/lib/validacion.ts
//
// La validación del cuerpo de una petición, en un solo sitio (ARQ-03).
//
// Antes cada router de dominio traía su propio `parseBody` —once copias idénticas salvo el nombre
// de un parámetro genérico— y los handlers de pairing ni siquiera eso: cuatro `readJsonSafe` y dos
// `req.json().catch(() => ({}))` a pelo, cada uno con sus propios `if` de campo obligatorio. Aquí
// se usa el validador de Hono (`@hono/zod-validator`), que además deja el cuerpo **tipado** en
// `c.req.valid("json")` a partir del propio schema: eso es lo que el `parseBody` casero no podía
// dar sin que cada llamante colaborase.
//
// Dos cosas que el validador de Hono hace distinto de aquel `parseBody`, y que aquí se igualan
// para no cambiar en silencio lo que ve un cliente ya instalado:
//
//   · **Sin `Content-Type` de JSON no lee el cuerpo y valida `{}`** (ver `hono/validator`), así que
//     un schema con todos los campos opcionales aceptaría una petición sin cuerpo. Antes eso era
//     `null` y fallaba. Se comprueba la cabecera en el gancho.
//   · **Un JSON mal formado lanza `HTTPException(400)`** con una frase en inglés, que acabaría
//     viajando como identificador. Lo reconduce `index.ts::onError` al `validation_error` de
//     siempre.

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";

import { badRequest } from "../server/utils/response";

/** El mismo criterio que `hono/validator` usa para decidir si lee el cuerpo. */
const ES_JSON = /^application\/([a-z-.]+\+)?json(;|$)/i;

/** Un identificador de máquina (`missing_deviceId`), no una frase. */
const IDENTIFICADOR = /^[A-Za-z][A-Za-z0-9_]*$/;

type Fallo = { success: false; error: z.ZodError };
type Resultado = { success: true } | Fallo;

function revisar(
	r: Resultado,
	c: Context<any, any>,
	identificar: (e: z.ZodError) => string,
): Response | undefined {
	if (!ES_JSON.test(c.req.header("Content-Type") ?? "")) {
		return badRequest(c, "validation_error");
	}
	if (r.success) return undefined;

	const identificador = identificar(r.error);
	// Los `issues` sólo acompañan al `validation_error` genérico. Cuando el fallo ya sale con su
	// propio identificador, el cuerpo es el mismo que devolvían los `if` que esto sustituye — y
	// estas rutas son anónimas: no hay por qué describirle el schema a quien no se ha presentado.
	return identificador === "validation_error"
		? badRequest(c, identificador, r.error)
		: badRequest(c, identificador);
}

/**
 * Valida el cuerpo contra el schema y lo deja en `c.req.valid("json")`.
 *
 * Un fallo sale como `validation_error` con los `issues` de zod, que es lo que han estado
 * devolviendo todos los routers de dominio desde siempre.
 */
export function cuerpo<T extends z.ZodType>(schema: T) {
	return zValidator("json", schema, (r, c) => revisar(r as Resultado, c, () => "validation_error"));
}

/**
 * Valida la CADENA DE CONSULTA contra el schema y la deja en `c.req.valid("query")`.
 *
 * Sustituye al `safeParse({ desde: c.req.query("desde"), … })` que se escribía a mano en cada
 * ruta: el validador entrega el objeto entero y zod se queda con las claves que declara el
 * schema, así que la lista de parámetros deja de estar escrita dos veces.
 */
export function consulta<T extends z.ZodType>(schema: T) {
	return zValidator("query", schema, (r, c) => {
		const f = r as Resultado;
		if (!f.success) return badRequest(c, "validation_error", f.error);
		return undefined;
	});
}

/**
 * Igual, pero el fallo sale con el identificador que lleve escrito el primer campo que no cuadra
 * (`invalid_pair_code`, `missing_deviceId`…).
 *
 * Lo usa el emparejamiento, y sólo él, porque ahí el identificador **es parte del contrato**: la
 * Handy no tiene sesión ni pantalla que consultar, así que lo único que puede enseñarle a quien
 * está delante es la frase que `lib/errorCodes.ts` tiene asociada a ese identificador. Colapsarlos
 * todos en `validation_error` convertiría «El código son 6 cifras» en «datos no válidos».
 *
 * El orden en que zod recorre las claves del objeto es el de su declaración, así que el schema se
 * escribe en el mismo orden en que el handler comprobaba los campos a mano.
 */
export function cuerpoConIdentificador<T extends z.ZodType>(schema: T) {
	return zValidator("json", schema, (r, c) => revisar(r as Resultado, c, primerIdentificador));
}

function primerIdentificador(e: z.ZodError): string {
	const primero = e.issues[0]?.message ?? "";
	return IDENTIFICADOR.test(primero) ? primero : "validation_error";
}

/**
 * Un texto obligatorio cuyo fallo se cuenta con `identificador`, venga vacío, ausente o de otro
 * tipo. Se escribe con la forma `{ message }` a propósito: es la que reconoce el barrido del
 * fuente de `test/mensajesDeError.test.ts`, que es lo que impide que un identificador nuevo se
 * quede sin frase.
 */
export function textoObligatorio(identificador: string) {
	return z
		.string({ message: identificador })
		.trim()
		.min(1, { message: identificador });
}
