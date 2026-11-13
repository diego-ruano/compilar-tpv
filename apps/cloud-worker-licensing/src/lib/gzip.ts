// src/lib/gzip.ts
//
// La respuesta de una ruta, comprimida con gzip si quien pregunta lo acepta.
//
// Es para las respuestas que crecen con el negocio: los volcados y el catch-up de sync. Son JSON de
// filas, que comprime mucho, y la Main las descarga enteras dentro del plazo de su petición.
//
// - **Sólo si se pide.** Sin `Accept-Encoding: gzip` la respuesta sale como siempre: es lo que
//   reciben las Main que no lo mandan.
// - **En el Worker, una vez.** La ruta se ejecuta también dentro del TenantHub (`lib/enElHub.ts`), y
//   allí no se comprime: un negocio es un hilo, y comprimir es CPU que no tiene por qué gastar el
//   suyo. El DO devuelve la respuesta tal cual y la comprime el Worker que la recibe.
// - **`encodeBody: "manual"`.** Una respuesta con `Content-Encoding` la comprime el propio runtime
//   al transmitirla, salvo que se le diga que el cuerpo ya viene comprimido. Sin esto saldría
//   comprimida dos veces.
//
// Detrás de Cloudflare, quien no acepta gzip no lo recibe aunque el Worker lo mande: el borde lo
// descomprime para él. Aun así se mira lo que pidió el cliente y no lo que el borde le dice al
// Worker que acepta (`cf.clientAcceptEncoding`), para no comprimir lo que se va a descomprimir.

import type { MiddlewareHandler } from "hono";

import { hubLocal } from "./hubLocal";
import { recortar } from "./texto";

/** ¿Esta lista de `Accept-Encoding` admite gzip? Con `q=0` lo nombra para rechazarlo. */
export function aceptaGzip(aceptadas: string | null | undefined): boolean {
	if (!aceptadas) return false;
	return aceptadas.split(",").some((parte) => {
		const [nombre, ...parametros] = parte.split(";").map((p) => recortar(p).toLowerCase());
		if (nombre !== "gzip" && nombre !== "x-gzip") return false;
		const q = parametros.find((p) => p.startsWith("q="));
		return q === undefined || Number(q.slice(2)) > 0;
	});
}

/**
 * Lo que acepta quien pregunta. Cloudflare puede cambiar la cabecera `Accept-Encoding` antes de
 * que llegue al Worker; cuando lo hace, la que mandó el cliente queda en `cf.clientAcceptEncoding`.
 */
function loQueAcepta(peticion: Request): string | null {
	const delCliente = (peticion.cf as { clientAcceptEncoding?: unknown } | undefined)?.clientAcceptEncoding;
	return typeof delCliente === "string" ? delCliente : peticion.headers.get("Accept-Encoding");
}

/**
 * Comprime con gzip la respuesta de la ruta si es un 200 con cuerpo, no viene ya codificada y quien
 * pregunta lo acepta. Va delante de `tenantAuth` y de `alHub`, para envolver lo que vuelve del
 * TenantHub:
 *
 *     xRoutes.use("/ruta", gzipSiSeAcepta);
 *     xRoutes.use("*", tenantAuth, alHub);
 */
export const gzipSiSeAcepta: MiddlewareHandler = async (c, next) => {
	await next();
	if (hubLocal()) return;

	const res = c.res;
	if (res.status !== 200 || !res.body || res.headers.has("Content-Encoding")) return;
	if (!aceptaGzip(loQueAcepta(c.req.raw))) return;

	const headers = new Headers(res.headers);
	headers.set("Content-Encoding", "gzip");
	headers.append("Vary", "Accept-Encoding");
	// El tamaño ya no es el del cuerpo sin comprimir.
	headers.delete("Content-Length");

	// Sin el `undefined` de en medio, Hono volvería a montar la respuesta con `new Response(…)` y se
	// perdería `encodeBody`.
	c.res = undefined;
	c.res = new Response(res.body.pipeThrough(new CompressionStream("gzip")), {
		status: res.status,
		headers,
		encodeBody: "manual",
	});
};
