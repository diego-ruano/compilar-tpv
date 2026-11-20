// src/domains/images/images.routes.ts
//
// Subrouter Hono de IMÁGENES (bucket R2 `IMAGES`). Se monta en /v1/images (index.ts).
//
// Modelo de claves: replican EXACTAMENTE la ruta local de la Main, con el tenant como
// carpeta raíz → `{tenantId}/images/{subcarpeta}/{uuid}.jpg`. Así la `Ruta_Imagen` que ya
// guarda la app (`images/{subcarpeta}/{uuid}.jpg`) sirve verbatim en los tres lados:
//   - Main:  appDataDir + Ruta_Imagen
//   - R2:    {tenant}/ + Ruta_Imagen
//   - Handy: {CDN}/{tenant}/ + Ruta_Imagen
//
// Rutas:
//   - GET    /:tenant/*   → PÚBLICO. Sirve el objeto desde R2 con Cache API (CDN edge) y
//                           Cache-Control inmutable. Es la URL que carga el <img> del Handy.
//                           El nombre de archivo es un UUID no adivinable (no enumerable).
//   - PUT    /*           → FIRMADO (JWT + device-proof). Sube bytes; el tenant sale del
//                           token (no del path). Sólo la app (Main/Handy emparejados) escribe.
//   - DELETE /*           → FIRMADO. Borra el objeto (reemplazo/limpieza) y purga su copia
//                           cacheada en el edge (REV-20; ver la nota del handler sobre el alcance).

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { cuerpoConIdentificador } from "../../lib/validacion";
// Lo que viaja en el camino: una carpeta de la lista y un UUID con su extensión (OBS-06).
import { RUTA_DE_IMAGEN } from "./rutaDeImagen";

type Ctx = { Bindings: Env; Variables: TenantVars };

/**
 * La carpeta de un negocio en el bucket: todas sus claves empiezan por aquí. Acaba en `/`, así que
 * la de un negocio no es el principio de la de otro (`abc/` no casa con `abcd/…`). Es también lo
 * que se borra al retirar un negocio de pruebas (`domains/admin/pruebas.ts`).
 */
export function prefijoDelNegocio(tenantId: string): string {
	return `${tenantId}/`;
}

export const imagesRoutes = new Hono<Ctx>();

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB (la Main ya comprime antes de subir)
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** RI-67: la query no transforma la imagen; todas sus variantes comparten entrada de caché. */
export function claveCacheImagen(request: Request): Request {
	const url = new URL(request.url);
	url.search = "";
	return new Request(url, { method: "GET", headers: request.headers });
}

function contentTypeFor(relPath: string): string {
    const ext = relPath.split(".").pop()?.toLowerCase();
    return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

// RI-07: no confiar en el MIME enviado; el procesamiento completo ocurre en Rust.
export function tipoImagen(bytes: Uint8Array): string | null {
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return "image/png";
    if (bytes.length >= 12 && [82,73,70,70].every((b, i) => bytes[i] === b) && [87,69,66,80].every((b, i) => bytes[i + 8] === b)) return "image/webp";
    return null;
}

// AUD-31: las cotas de RI-07 en la Main (`imagenes::decodificar`): 8192 px de lado y 24 Mpx. Lo que se
// sube a R2 lo pinta la Handy tal cual desde r2.dev y lo baja la Main; la app sube siempre lo que ya ha
// reconstruido `imagenes::procesar` (1024 px como mucho), así que esto sólo para a quien sube otra cosa
// con las credenciales de un dispositivo.
const MAX_LADO = 8192;
const MAX_PIXELES = 24_000_000;

/**
 * AUD-31 · Las dimensiones que declara la cabecera de un PNG (`IHDR`) o de un JPEG (su `SOF`), sin
 * decodificar nada. `null` si no se encuentran: una imagen así no se sube.
 */
export function dimensionesDeImagen(bytes: Uint8Array): { ancho: number; alto: number } | null {
    const u16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];
    const u32 = (i: number) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
    if (tipoImagen(bytes) === "image/png") {
        // La firma (8), la longitud del primer trozo (4) y su tipo, que tiene que ser IHDR.
        if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
        return { ancho: u32(16), alto: u32(20) };
    }
    if (tipoImagen(bytes) === "image/jpeg") {
        let i = 2;
        while (i + 3 < bytes.length) {
            if (bytes[i] !== 0xff) return null;
            const marca = bytes[i + 1];
            // Relleno (0xFF repetido) y marcas sin longitud.
            if (marca === 0xff) { i++; continue; }
            if (marca === 0x01 || (marca >= 0xd0 && marca <= 0xd8)) { i += 2; continue; }
            // Fin de la imagen o principio de los datos sin haber dicho su tamaño.
            if (marca === 0xd9 || marca === 0xda) return null;
            // SOF0–SOF15, salvo DHT (C4), JPG (C8) y DAC (CC): longitud, precisión, alto y ancho.
            if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
                if (i + 8 >= bytes.length) return null;
                return { alto: u16(i + 5), ancho: u16(i + 7) };
            }
            i += 2 + u16(i + 2);
        }
        return null;
    }
    return null;
}

/** AUD-31 · ¿Cabe en las cotas de RI-07? Un JPEG o un PNG que dice cuánto mide y no se pasa. */
export function dentroDeLasCotas(bytes: Uint8Array): boolean {
    const d = dimensionesDeImagen(bytes);
    return !!d && d.ancho > 0 && d.alto > 0 && d.ancho <= MAX_LADO && d.alto <= MAX_LADO && d.ancho * d.alto <= MAX_PIXELES;
}

// ───────────────── LECTURA (pública, cacheada en el edge) ─────────────────

imagesRoutes.get("/:tenant/*", async (c) => {
	const tenant = (c.req.param("tenant") || "").trim();
	// Hono no registra `*` como parámetro con nombre. Derivar la ruta del pathname montado.
	const relPath = relPathFromUrl(c.req.url).split("/").slice(1).join("/");
	if (!tenant || !RUTA_DE_IMAGEN.test(relPath)) {
		return c.json({ error: "bad_image_path" }, 400);
	}

	const cache = caches.default;
	const cacheKey = claveCacheImagen(c.req.raw);
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const key = prefijoDelNegocio(tenant) + relPath;
	const obj = await c.env.IMAGES.get(key);
	if (!obj) {
		// 404 SIN cachear: la imagen puede llegar en segundos (la subida va por otro canal);
		// el frontend reintenta el mismo URL y, cuando exista, el GET ya responde 200.
		return c.json({ error: "not_found" }, 404);
	}

	const headers = new Headers();
	headers.set("Content-Type", contentTypeFor(relPath));
	headers.set("Cache-Control", CACHE_CONTROL);
	headers.set("X-Content-Type-Options", "nosniff");
	if (obj.httpEtag) headers.set("ETag", obj.httpEtag);

	const res = new Response(obj.body, { headers });
	// Sólo cacheamos las respuestas 200 (nunca los 404).
	c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
	return res;
});

// ───────────────── ESCRITURA (firmada) ─────────────────

/** Extrae `relPath` del pathname completo de la petición, eliminando el prefijo `/v1/images/`.
 *  Más robusto que `c.req.param("*")` en subrouters de Hono, que puede incluir o excluir
 *  la barra inicial dependiendo de la versión y del modo de montaje. */
function relPathFromUrl(url: string): string {
	try {
		const pathname = new URL(url).pathname; // /v1/images/images/productos/uuid.jpg
		return pathname.replace(/^\/v1\/images\//, "").trim();
	} catch {
		return "";
	}
}

imagesRoutes.put("/*", bodyLimit({ maxSize: MAX_BYTES, onError: (c) => c.json({ error: "image_too_large" }, 413) }), tenantAuth, async (c) => {
	const relPath = relPathFromUrl(c.req.url);
	if (!RUTA_DE_IMAGEN.test(relPath)) {
		return c.json({ error: "bad_image_path" }, 400);
	}

	const body = await c.req.arrayBuffer();
	if (!body.byteLength) return c.json({ error: "empty_body" }, 400);
	if (body.byteLength > MAX_BYTES) return c.json({ error: "image_too_large" }, 413);

	const bytes = new Uint8Array(body);
	const contentType = tipoImagen(bytes);
	if (!contentType || contentType !== contentTypeFor(relPath)) return c.json({ error: "bad_image_path" }, 400);
	// AUD-31: lo que la Main no decodificaría (`imagenes::decodificar`) tampoco lo pinta la Handy desde
	// r2.dev: ni WebP (AUD-30) ni una cabecera de más de 8192 px de lado o 24 Mpx.
	if (contentType === "image/webp") return c.json({ error: "bad_image_path" }, 400);
	if (!dentroDeLasCotas(bytes)) return c.json({ error: "image_too_large" }, 413);
	// El tenant SIEMPRE sale del token (no del cliente): aislamiento por tenant garantizado.
	const key = prefijoDelNegocio(c.get("tenantId")) + relPath;

	await c.env.IMAGES.put(key, body, {
		httpMetadata: { contentType, cacheControl: CACHE_CONTROL },
	});

	return c.json({ ok: true, key });
});

// ───────────────── DESCARGA (firmada, R2 → Main) ─────────────────
//
// La Main sirve las imágenes desde su disco local, así que necesita BAJAR de R2 las que se
// crearon en otra Handy (cuya fila ya le llegó por sync, pero cuyo binario solo vive en R2).
// Es un POST firmado (no el GET público): el tenant sale del token, no del path, así la Main
// no necesita conocer su propio tenant. El `rel_path` viaja en el cuerpo.
imagesRoutes.post(
	"/download",
	tenantAuth,
	cuerpoConIdentificador(
		z.object({
			rel_path: z
				.string({ message: "bad_image_path" })
				.trim()
				.regex(RUTA_DE_IMAGEN, { message: "bad_image_path" }),
		}),
	),
	async (c) => {
		const key = prefijoDelNegocio(c.get("tenantId")) + c.req.valid("json").rel_path;
		const obj = await c.env.IMAGES.get(key);
		if (!obj) {
			// 404: el binario aún no se ha subido (la subida va por otro canal). La Main reintenta.
			return c.json({ error: "not_found" }, 404);
		}

		const headers = new Headers();
		headers.set("Content-Type", contentTypeFor(c.req.valid("json").rel_path));
		if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
		return new Response(obj.body, { headers });
	},
);

/**
 * URL pública de una imagen: la clave con la que el GET de arriba la guardó en el caché del edge.
 * Se construye sobre el origen de ESTA petición porque es el mismo worker el que sirve las dos.
 */
function urlPublica(reqUrl: string, tenantId: string, relPath: string): string {
	const u = new URL(reqUrl);
	u.pathname = `/v1/images/${tenantId}/${relPath}`;
	u.search = "";
	return u.toString();
}

imagesRoutes.delete("/*", tenantAuth, async (c) => {
	const relPath = relPathFromUrl(c.req.url);
	if (!RUTA_DE_IMAGEN.test(relPath)) {
		return c.json({ error: "bad_image_path" }, 400);
	}
	const tenantId = c.get("tenantId");
	const key = prefijoDelNegocio(tenantId) + relPath;
	await c.env.IMAGES.delete(key);

	// REV-20: borrarla de R2 no la quitaba de la calle. El GET público la guarda en el caché del
	// edge con `max-age=31536000, immutable`, así que la copia cacheada seguía sirviéndose un año
	// después de borrar el original — para siempre, a efectos prácticos. Es poco enumerable (el
	// nombre es un UUID) pero «borrar» tiene que significar que deja de ser pública.
	//
	// ⚠️ **Esto purga el colo que atiende esta petición, no toda la red.** La Cache API de Workers
	// es por centro de datos y no hay forma de barrer los demás sin el API de purga de Cloudflare,
	// que pide un token nuevo. Cubre el caso real —el bar borra una foto y sus propios
	// dispositivos, que salen por el mismo colo, dejan de verla— y no cubre a quien guardó la URL
	// y la abre desde otro país. Si algún día hace falta que cubra eso, la pieza que falta es ese
	// token, no este código.
	await caches.default.delete(new Request(urlPublica(c.req.url, tenantId, relPath)));

	return c.json({ ok: true });
});
