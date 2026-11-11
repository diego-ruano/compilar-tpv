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
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";

import { badRequest } from "../server/utils/response";
import { registrarCuerpoValidado } from "../observability/requestContext";

/** El mismo criterio que `hono/validator` usa para decidir si lee el cuerpo. */
const ES_JSON = /^application\/([a-z-.]+\+)?json(;|$)/i;

/** Un identificador de máquina (`missing_deviceId`), no una frase. */
const IDENTIFICADOR = /^[A-Za-z][A-Za-z0-9_]*$/;

type Fallo = { success: false; error: z.ZodError; mensaje?: string };
type Resultado = { success: true; data: unknown } | Fallo;

/** El mensaje que zod pone a un issue que no trae el suyo: el de la configuración global. */
function mensajePorDefecto(issue: Parameters<NonNullable<z.core.$ZodConfig["localeError"]>>[0]): string {
	const config = z.config();
	const m = config.customError?.(issue) ?? config.localeError?.(issue);
	return typeof m === "string" ? m : (m?.message ?? "Invalid input");
}

/**
 * VALID-02: valida y, si no pasa, dice el texto del primer fallo cuando lo escribimos nosotros en el
 * schema (un `MSG_*`, el de un `refine`, el de un `.min(1, "…")`), que es el mismo que da la Main.
 * Los de zod por defecto salen en inglés y sólo con un cuerpo mal formado: ésos no. zod pide el
 * mensaje al `error` de la llamada sólo cuando el issue no trae el suyo, así que lo que pase por ahí
 * es lo que no cuenta; se le devuelve el mismo texto que habría puesto, y los `issues` no cambian.
 */
export async function validarConMensaje(schema: z.ZodType, valor: unknown) {
	const porDefecto = new Set<string>();
	const r = await schema.safeParseAsync(valor, {
		error: (issue) => {
			const m = mensajePorDefecto(issue);
			porDefecto.add(m);
			return m;
		},
	});
	const primero = r.success ? undefined : r.error.issues[0]?.message;
	// El validador de Hono pasa al gancho el resultado tal cual: el texto va en el mismo objeto.
	if (primero && !porDefecto.has(primero)) Object.assign(r, { mensaje: primero });
	return r;
}

// Para `zValidator`. El tipo de resultado que pide depende del schema concreto y TypeScript no lo
// resuelve con uno genérico; lo que devuelve es el resultado de zod tal cual.
const CON_MENSAJE = { validationFunction: validarConMensaje as (s: z.ZodType, v: unknown) => Promise<any> };

function revisar(
	r: Resultado,
	c: Context<any, any>,
	identificar: (e: z.ZodError) => string,
): Response | undefined {
	if (!ES_JSON.test(c.req.header("Content-Type") ?? "")) {
		return badRequest(c, "validation_error");
	}
	if (r.success) {
		registrarCuerpoValidado(c, r.data);
		return undefined;
	}

	const identificador = identificar(r.error);
	// Los `issues` sólo acompañan al `validation_error` genérico. Cuando el fallo ya sale con su
	// propio identificador, el cuerpo es el mismo que devolvían los `if` que esto sustituye — y
	// estas rutas son anónimas: no hay por qué describirle el schema a quien no se ha presentado.
	return identificador === "validation_error"
		? badRequest(c, identificador, r.error, r.mensaje)
		: badRequest(c, identificador);
}

/**
 * Valida el cuerpo contra el schema y lo deja en `c.req.valid("json")`.
 *
 * Un fallo sale como `validation_error` con los `issues` de zod, que es lo que han estado
 * devolviendo todos los routers de dominio desde siempre, y con el texto de la regla como `message`
 * cuando lo hay (VALID-02).
 */
export function cuerpo<T extends z.ZodType>(schema: T) {
	return zValidator("json", schema, (r, c) => revisar(r as Resultado, c, () => "validation_error"), CON_MENSAJE);
}

type EntradaJson<T extends z.ZodType> = {
	in: { json: z.input<T> };
	out: { json: z.output<T> };
};

/**
 * Variante fail-open para los informes y rutas de recuperación de `sync` (ARQ-06).
 *
 * `zValidator` rechaza el JSON roto antes de ejecutar el schema y no lee un cuerpo sin cabecera
 * JSON. Estas rutas históricamente convierten cualquiera de esos casos en `{}` y siguen con sus
 * defaults: dejar de hacerlo podría atascar una recuperación por un dato auxiliar mal formado.
 * El resultado sí queda registrado como JSON validado, para que el handler no vuelva a leerlo.
 */
export function cuerpoTolerante<T extends z.ZodType>(
	schema: T,
): MiddlewareHandler<any, string, EntradaJson<T>> {
	return async (c, next) => {
		let valor: unknown = {};
		try {
			valor = await c.req.json();
		} catch {
			// Fail-open deliberado: cuerpo ausente o JSON roto equivale a no mandar campos.
		}

		const resultado = (await validarConMensaje(schema, valor)) as Resultado;
		if (!resultado.success) {
			return badRequest(c, "validation_error", resultado.error, resultado.mensaje);
		}

		c.req.addValidatedData("json", resultado.data as Record<string, unknown>);
		registrarCuerpoValidado(c, resultado.data);
		await next();
	};
}

/**
 * Valida la CADENA DE CONSULTA contra el schema y la deja en `c.req.valid("query")`.
 *
 * Sustituye al `safeParse({ desde: c.req.query("desde"), … })` que se escribía a mano en cada
 * ruta: el validador entrega el objeto entero y zod se queda con las claves que declara el
 * schema, así que la lista de parámetros deja de estar escrita dos veces.
 */
export function consulta<T extends z.ZodType>(schema: T) {
	return zValidator(
		"query",
		schema,
		(r, c) => {
			const f = r as Resultado;
			if (!f.success) return badRequest(c, "validation_error", f.error, f.mensaje);
			return undefined;
		},
		CON_MENSAJE,
	);
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

/**
 * Lo más grande que manda la app a una ruta anónima: la activación firmada, con todos sus campos en
 * su tope y en caracteres de tres bytes, no llega a 5 KB; el emparejamiento, a medio KB.
 */
export const TOPE_ANONIMO = 8 * 1024;

/**
 * AUD-34 · El tope del cuerpo de una ruta ANÓNIMA, la que no pasa por `tenantAuth` ni por un token de
 * administración. Antes de saber quién llama no se lee un cuerpo entero: sin esto, cualquiera hacía
 * al worker leer, parsear o firmar decenas de megas, y un isolate (128 MB) atiende a todos los
 * negocios a la vez.
 *
 * Va DELANTE de todo lo que lee el cuerpo (el validador, la firma), declarado antes que la ruta:
 *
 *     xRoutes.use("/ruta", topeAnonimo());
 *
 * Con `Content-Length` decide sin leer nada; sin él, deja de leer en cuanto pasa del tope. Lo vigila
 * `test/vetoAntesDelCuerpo.test.ts`.
 */
export function topeAnonimo(maxSize: number = TOPE_ANONIMO) {
	return bodyLimit({
		maxSize,
		onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
	});
}
