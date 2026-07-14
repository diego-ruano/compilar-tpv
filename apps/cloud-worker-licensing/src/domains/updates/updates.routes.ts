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

import { Hono } from "hono";
import { z } from "zod";
import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import { checkAdminToken } from "../../middleware/requireAdmin";

export const updatesRoutes = new Hono<{ Bindings: Env }>();

// Crea la tabla de releases una vez por aislado (lazy). No usa DEFAULT en la PK para mantener el
// control explícito de version/target/channel.
let schemaReady = false;
async function ensureReleasesSchema(db: Client) {
	if (schemaReady) return;
	await db.execute(`
		CREATE TABLE IF NOT EXISTS app_releases (
			version       TEXT NOT NULL,
			target        TEXT NOT NULL DEFAULT 'windows',
			channel       TEXT NOT NULL DEFAULT 'stable',
			notes         TEXT,
			pub_date      TEXT NOT NULL,
			signature     TEXT NOT NULL,
			url           TEXT NOT NULL,
			is_active     INTEGER NOT NULL DEFAULT 1,
			created_at_ms INTEGER NOT NULL DEFAULT (unixepoch()*1000),
			PRIMARY KEY (version, target, channel)
		);
	`);
	schemaReady = true;
}

// Verifica el token admin del header `Authorization: Bearer <token>`. Si el secreto no está
// configurado, la publicación queda DESHABILITADA (fail-safe: nadie puede publicar por accidente).
// La comparación es *timing-safe* (ver middleware/requireAdmin.ts): antes era un `!==`, que filtra
// por tiempo cuántos caracteres del token acertaste.
async function checkAdmin(c: { req: { header: (n: string) => string | undefined }; env: Env }): Promise<
	{ ok: true } | { ok: false; status: 401 | 503; error: string }
> {
	const fail = await checkAdminToken(c.req.header("authorization"), c.env.RELEASE_ADMIN_TOKEN);
	if (!fail) return { ok: true };
	return {
		ok: false,
		status: fail.status,
		error: fail.status === 503 ? "publish_disabled" : fail.error,
	};
}

/* ── Feed que consume el updater de Tauri ──────────────────────────────────── */

updatesRoutes.get("/:target/:arch/:current", async (c) => {
	const target = c.req.param("target"); // p. ej. "windows"
	const arch = c.req.param("arch"); // p. ej. "x86_64"
	const current = c.req.param("current"); // versión instalada (sólo para observabilidad)

	const db = getDb(c.env);
	await ensureReleasesSchema(db);

	const r = await db.execute({
		sql: `
			SELECT version, notes, pub_date, signature, url
			FROM app_releases
			WHERE target = ? AND channel = 'stable' AND is_active = 1
			ORDER BY created_at_ms DESC
			LIMIT 1
		`,
		args: [target],
	});

	const row = r.rows?.[0] as unknown as
		| { version: string; notes: string | null; pub_date: string; signature: string; url: string }
		| undefined;

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
	channel: z.string().optional(), // por defecto "stable"
});

updatesRoutes.post("/publish", async (c) => {
	const auth = await checkAdmin(c);
	if (!auth.ok) return c.json({ error: auth.error }, auth.status);

	const body = await c.req.json().catch(() => null);
	const parsed = publishSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
	}

	const target = parsed.data.target || "windows";
	const channel = parsed.data.channel || "stable";
	const pubDate = parsed.data.pub_date || new Date().toISOString();

	const db = getDb(c.env);
	await ensureReleasesSchema(db);

	await db.execute({
		sql: `
			INSERT OR REPLACE INTO app_releases
				(version, target, channel, notes, pub_date, signature, url, is_active, created_at_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, 1, unixepoch()*1000)
		`,
		args: [
			parsed.data.version,
			target,
			channel,
			parsed.data.notes ?? null,
			pubDate,
			parsed.data.signature,
			parsed.data.url,
		],
	});

	return c.json({ ok: true, version: parsed.data.version, target, channel });
});

/* ── Rollback: desactivar una release (admin) ──────────────────────────────── */

const deactivateSchema = z.object({
	version: z.string().min(1),
	target: z.string().optional(),
	channel: z.string().optional(),
});

updatesRoutes.post("/deactivate", async (c) => {
	const auth = await checkAdmin(c);
	if (!auth.ok) return c.json({ error: auth.error }, auth.status);

	const body = await c.req.json().catch(() => null);
	const parsed = deactivateSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "validation_error", issues: parsed.error.issues }, 400);
	}

	const target = parsed.data.target || "windows";
	const channel = parsed.data.channel || "stable";

	const db = getDb(c.env);
	await ensureReleasesSchema(db);

	await db.execute({
		sql: `
			UPDATE app_releases SET is_active = 0
			WHERE version = ? AND target = ? AND channel = ?
		`,
		args: [parsed.data.version, target, channel],
	});

	return c.json({ ok: true, deactivated: parsed.data.version, target, channel });
});
