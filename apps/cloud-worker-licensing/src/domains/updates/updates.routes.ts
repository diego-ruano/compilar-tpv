// src/domains/updates/updates.routes.ts
//
// Feed de auto-actualización de la app de escritorio (Tauri updater) servido por `tpv-api`.
//
// La app consulta GET /v1/update/{target}/{arch}/{version} al arrancar. Respondemos con el
// manifiesto que espera el plugin de Tauri (formato estático con `platforms`) o 204 si no hay
// nada que servir. El plugin compara la versión y verifica la firma del instalador contra la
// clave pública embebida en la app, así que el feed puede ser público sin riesgo.
//
// CONTROL REMOTO (el motivo de servirlo nosotros y no GitHub Releases):
//   - Para PUBLICAR una versión: POST /v1/update/publish (token admin) inserta una fila activa.
//   - Para ROLLBACK instantáneo: POST /v1/update/deactivate desactiva la versión mala; el feed
//     vuelve a servir la anterior activa. Sin tocar el equipo del cliente.
//
// Los binarios (instalador + .sig) se hospedan donde quieras (R2, etc.); aquí solo guardamos su
// URL y la firma. La fuente de versiones es la tabla `app_releases` de la Turso central.

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import { checkAdminToken } from "../../middleware/requireAdmin";
import { cuerpo } from "../../lib/validacion";

export const updatesRoutes = new Hono<{ Bindings: Env }>();

// Verifica el token admin del header `Authorization: Bearer <token>`. Si el secreto no está
// configurado, la publicación queda DESHABILITADA (fail-safe: nadie puede publicar por accidente).
// La comparación es *timing-safe* (ver middleware/requireAdmin.ts): antes era un `!==`, que filtra
// por tiempo cuántos caracteres del token acertaste.
//
// Es un MIDDLEWARE y no una comprobación dentro del handler porque el validador del cuerpo
// también es middleware: al revés, quien no tiene el token se llevaría un 400 describiéndole el
// schema antes de llegar al 401.
const soloConTokenDeRelease: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const fail = await checkAdminToken(c.req.header("authorization"), c.env.RELEASE_ADMIN_TOKEN);
	if (fail) {
		const error = fail.status === 503 ? "publish_disabled" : fail.error;
		return c.json({ error }, fail.status);
	}
	await next();
};

/* ── Feed que consume el updater de Tauri ──────────────────────────────────── */

/**
 * Compara dos versiones semánticas. Devuelve >0 si `a` es más nueva.
 *
 * REV-23: el feed ordenaba por `created_at_ms`, o sea por **cuándo se insertó la fila**, no por
 * qué versión es. Casi siempre coinciden y por eso no se notaba; dejan de coincidir justo cuando
 * más duele, porque `publish` es un `INSERT OR REPLACE`: retocar la URL o las notas de una versión
 * vieja le pone la fecha de hoy y esa vuelve a ser «la última». El updater no la instalaría —no
 * baja de versión— pero sí dejaría de ofrecer la buena, y un equipo recién instalado se queda
 * clavado en una versión antigua sin que nada lo diga.
 *
 * Los tramos no numéricos (`1.2.0-beta.1`) se comparan como texto y **pierden** contra la versión
 * sin sufijo, que es lo que dice semver: una preliberación es anterior a su versión final.
 */
export function compararVersiones(a: string, b: string): number {
	const partir = (v: string) => {
		const [nucleo, ...resto] = String(v).trim().split("-");
		return {
			numeros: nucleo.split(".").map((n) => Number.parseInt(n, 10) || 0),
			sufijo: resto.join("-"),
		};
	};
	const x = partir(a);
	const y = partir(b);

	for (let i = 0; i < Math.max(x.numeros.length, y.numeros.length); i++) {
		const d = (x.numeros[i] ?? 0) - (y.numeros[i] ?? 0);
		if (d !== 0) return d;
	}

	// Mismo núcleo: sin sufijo gana a con sufijo; entre dos sufijos, orden de texto.
	if (!x.sufijo && y.sufijo) return 1;
	if (x.sufijo && !y.sufijo) return -1;
	return x.sufijo === y.sufijo ? 0 : x.sufijo > y.sufijo ? 1 : -1;
}

type Release = {
	version: string;
	notes: string | null;
	pub_date: string;
	signature: string;
	url: string;
};

updatesRoutes.get("/:target/:arch/:current", async (c) => {
	const target = c.req.param("target"); // p. ej. "windows"
	const arch = c.req.param("arch"); // p. ej. "x86_64"
	const current = c.req.param("current"); // versión instalada (sólo para observabilidad)

	const db = getDb(c.env);

	// REV-23: se filtra por `arch`, que antes se ignoraba —llegaba en la ruta, no entraba en la
	// consulta y sólo servía para componer la clave de `platforms`—. O sea que un equipo aarch64
	// se llevaba el instalador x86_64 etiquetado como suyo. En Windows arranca emulado y por eso
	// no se ha notado; el día que exista una build aarch64 se notaría instalando la que no es.
	//
	// Y se traen TODAS las activas en vez de la última insertada: cuál es la más nueva lo decide
	// la versión, no la fecha de la fila. Son unas pocas decenas de filas como mucho.
	const r = await db.execute({
		sql: `
			SELECT version, notes, pub_date, signature, url
			FROM app_releases
			WHERE target = ? AND arch = ? AND channel = 'stable' AND is_active = 1
		`,
		args: [target, arch],
	});

	const row = ((r.rows ?? []) as unknown as Release[]).reduce<Release | undefined>(
		(mejor, fila) =>
			!mejor || compararVersiones(fila.version, mejor.version) > 0 ? fila : mejor,
		undefined,
	);

	// Visibilidad de versiones: queda en los logs del worker (observability ya activa).
	console.log("[update] check", {
		target,
		arch,
		current,
		serving: row?.version ?? null,
	});

	// Sin release publicada para esta plataforma → 204: el plugin entiende "estás al día".
	if (!row) return new Response(null, { status: 204 });

	// Formato estático del updater de Tauri. La clave de `platforms` es "<target>-<arch>".
	const manifest = {
		version: row.version,
		notes: row.notes || "",
		pub_date: row.pub_date,
		platforms: {
			[`${target}-${arch}`]: {
				signature: row.signature,
				url: row.url,
			},
		},
	};

	return c.json(manifest);
});

/* ── Publicar una release (admin) ──────────────────────────────────────────── */

const publishSchema = z.object({
	version: z.string().min(1),
	signature: z.string().min(1), // contenido del fichero .sig del instalador
	url: z.string().url(), // URL pública del instalador (R2, etc.)
	notes: z.string().nullable().optional(),
	pub_date: z.string().optional(), // ISO; si falta, ahora
	target: z.string().optional(), // por defecto "windows"
	arch: z.string().optional(), // por defecto "x86_64" (REV-23: forma parte de la identidad)
	channel: z.string().optional(), // por defecto "stable"
});

updatesRoutes.post("/publish", soloConTokenDeRelease, cuerpo(publishSchema), async (c) => {
	const datos = c.req.valid("json");

	const target = datos.target || "windows";
	const arch = datos.arch || "x86_64";
	const channel = datos.channel || "stable";
	const pubDate = datos.pub_date || new Date().toISOString();

	const db = getDb(c.env);

	await db.execute({
		sql: `
			INSERT OR REPLACE INTO app_releases
				(version, target, arch, channel, notes, pub_date, signature, url, is_active, created_at_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, unixepoch()*1000)
		`,
		args: [
			datos.version,
			target,
			arch,
			channel,
			datos.notes ?? null,
			pubDate,
			datos.signature,
			datos.url,
		],
	});

	return c.json({ ok: true, version: datos.version, target, arch, channel });
});

/* ── Rollback: desactivar una release (admin) ──────────────────────────────── */

const deactivateSchema = z.object({
	version: z.string().min(1),
	target: z.string().optional(),
	arch: z.string().optional(),
	channel: z.string().optional(),
});

updatesRoutes.post("/deactivate", soloConTokenDeRelease, cuerpo(deactivateSchema), async (c) => {
	const datos = c.req.valid("json");

	const target = datos.target || "windows";
	const channel = datos.channel || "stable";

	const db = getDb(c.env);

	// Sin `arch` se desactiva la versión en TODOS los arch, que es lo que quiere un rollback: si
	// una versión está mal, lo está en todas partes. Indicándolo se acota a uno.
	const arch = datos.arch;
	await db.execute({
		sql: `
			UPDATE app_releases SET is_active = 0
			WHERE version = ? AND target = ? AND channel = ? AND (?4 IS NULL OR arch = ?4)
		`,
		args: [datos.version, target, channel, arch ?? null],
	});

	return c.json({ ok: true, deactivated: datos.version, target, arch: arch ?? "todos", channel });
});
