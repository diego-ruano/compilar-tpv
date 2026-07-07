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
//   - DELETE /*           → FIRMADO. Borra el objeto (reemplazo/limpieza).

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const imagesRoutes = new Hono<Ctx>();

// Sólo se permiten estas subcarpetas y nombres de archivo seguros (uuid + extensión).
// Evita path traversal y claves arbitrarias en el bucket.
const REL_PATH_RE =
	/^images\/(productos|categorias|proveedores|alergenos|logo)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp)$/i;

const ALLOWED_CONTENT_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
]);

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB (la Main ya comprime antes de subir)
const CACHE_CONTROL = "public, max-age=31536000, immutable";

function contentTypeFor(relPath: string, requested: string | null | undefined): string {
	const req = (requested || "").toLowerCase().trim();
	if (ALLOWED_CONTENT_TYPES.has(req)) return req;
	const ext = relPath.split(".").pop()?.toLowerCase() || "";
	if (ext === "png") return "image/png";
	if (ext === "webp") return "image/webp";
	return "image/jpeg";
}

// ───────────────── LECTURA (pública, cacheada en el edge) ─────────────────

imagesRoutes.get("/:tenant/*", async (c) => {
	const tenant = (c.req.param("tenant") || "").trim();
	const relPath = (c.req.param("*") || "").trim();
	if (!tenant || !REL_PATH_RE.test(relPath)) {
		return c.json({ error: "bad_image_path" }, 400);
	}

	const cache = caches.default;
	const cached = await cache.match(c.req.raw);
	if (cached) return cached;

	const key = `${tenant}/${relPath}`;
	const obj = await c.env.IMAGES.get(key);
	if (!obj) {
		// 404 SIN cachear: la imagen puede llegar en segundos (la subida va por otro canal);
		// el frontend reintenta el mismo URL y, cuando exista, el GET ya responde 200.
		return c.json({ error: "not_found" }, 404);
	}

	const headers = new Headers();
	headers.set("Content-Type", obj.httpMetadata?.contentType || "image/jpeg");
	headers.set("Cache-Control", CACHE_CONTROL);
	if (obj.httpEtag) headers.set("ETag", obj.httpEtag);

	const res = new Response(obj.body, { headers });
	// Sólo cacheamos las respuestas 200 (nunca los 404).
	c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()));
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

imagesRoutes.put("/*", tenantAuth, async (c) => {
	const relPath = relPathFromUrl(c.req.url);
	console.log("[images PUT] relPath:", relPath);
	if (!REL_PATH_RE.test(relPath)) {
		console.log("[images PUT] bad_image_path para:", relPath);
		return c.json({ error: "bad_image_path" }, 400);
	}

	const body = await c.req.arrayBuffer();
	if (!body.byteLength) return c.json({ error: "empty_body" }, 400);
	if (body.byteLength > MAX_BYTES) return c.json({ error: "image_too_large" }, 413);

	const contentType = contentTypeFor(relPath, c.req.header("Content-Type"));
	// El tenant SIEMPRE sale del token (no del cliente): aislamiento por tenant garantizado.
	const key = `${c.get("tenantId")}/${relPath}`;
	console.log("[images PUT] R2 key:", key);

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
imagesRoutes.post("/download", tenantAuth, async (c) => {
	const body = await c.req.json().catch(() => null);
	const relPath = String(body?.rel_path ?? "").trim();
	if (!REL_PATH_RE.test(relPath)) {
		return c.json({ error: "bad_image_path" }, 400);
	}

	const key = `${c.get("tenantId")}/${relPath}`;
	const obj = await c.env.IMAGES.get(key);
	if (!obj) {
		// 404: el binario aún no se ha subido (la subida va por otro canal). La Main reintenta.
		return c.json({ error: "not_found" }, 404);
	}

	const headers = new Headers();
	headers.set("Content-Type", obj.httpMetadata?.contentType || "image/jpeg");
	if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
	return new Response(obj.body, { headers });
});

imagesRoutes.delete("/*", tenantAuth, async (c) => {
	const relPath = relPathFromUrl(c.req.url);
	if (!REL_PATH_RE.test(relPath)) {
		return c.json({ error: "bad_image_path" }, 400);
	}
	const key = `${c.get("tenantId")}/${relPath}`;
	await c.env.IMAGES.delete(key);
	return c.json({ ok: true });
});
