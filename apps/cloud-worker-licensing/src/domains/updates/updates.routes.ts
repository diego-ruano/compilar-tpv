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
//   - Para PUBLICAR una versión: POST /v1/update/publish (token de release) inserta una fila activa.
//     El workflow de release publica en el canal `beta`.
//   - RI-30 · BARES PILOTO: los equipos de un negocio con `tenants.piloto = 1` reciben también el canal
//     `beta` (el updater manda su `device_id` en `X-Tpv-Device`); los demás, sólo `stable`. Una versión
//     nueva llega primero a los pilotos, y cuando lleva unos días sin problemas se PROMOCIONA a
//     `stable` (`pnpm release:promocionar`, ruta de administración). Sin staging (INFRA-01), es lo
//     más parecido a probar con clientes de verdad sin arriesgarlos a todos.
//   - Para ROLLBACK instantáneo: POST /v1/update/deactivate desactiva la versión mala; el feed
//     vuelve a servir la anterior activa. Sin tocar el equipo del cliente.
//
// Los binarios (instalador + .sig) se hospedan donde quieras (R2, etc.); aquí solo guardamos su
// URL y la firma. La fuente de versiones es la tabla `app_releases` de la base central.
//
// QUÉ SISTEMA Y QUÉ CANAL son dos cosas distintas. El sistema va en el `target`: `windows` es el de
// Windows 10/11 y `windows7` la variante de Windows 7, que se lo fija ella misma al updater. El canal
// (`stable`/`beta`) es a quién le llega antes. Así cada variante tiene su estable y su beta con sus
// pilotos, y un Windows 7 no puede recibir nunca un instalador de Windows 10/11, que instala bien y
// luego no arranca.

import { Hono, type MiddlewareHandler } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { capturarError } from "../../observability/errors";
import { getDb } from "../../server/db";
import { esPasajeroDeLaCentral } from "../../server/central/sinLaCentral";
import { checkAdminToken } from "../../middleware/requireAdmin";
import { filtroPorIp } from "../../lib/limitador";
import type { Sql } from "../../lib/sql";
import { cuerpo } from "../../lib/validacion";

export const updatesRoutes = new Hono<{ Bindings: Env }>();

/**
 * Lo único que se puede publicar. Una lista cerrada porque el feed sólo encuentra lo que se publicó
 * con el nombre exacto: un `windows-7` o un `Beta` dejaría la versión publicada sin que ningún equipo
 * la viera nunca, y sin un solo error.
 */
export const TARGETS = ["windows", "windows7"] as const;
export const CANALES = ["stable", "beta"] as const;

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
 * más duele, porque `publish` era un `INSERT OR REPLACE`: retocar la URL o las notas de una versión
 * vieja le ponía la fecha de hoy y esa volvía a ser «la última». El updater no la instalaría —no
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

/* ── Lo que el feed lee de la base central ───────────────────────────────────
 *
 * El feed es público: lo pide cada equipo de escritorio cada seis horas, y cualquiera puede pedirlo
 * con el sistema, la arquitectura y el equipo que quiera. Para que nada de eso llegue a la base
 * central, el feed no la consulta por petición: lee de una vez TODAS las versiones activas y los
 * equipos de los bares piloto, se los guarda en el isolate `VIDA_EN_CACHE_MS`, y cada petición
 * escoge de ahí. Ninguna combinación de camino ni de cabecera vuelve a la base antes de tiempo, y
 * delante va además el filtro por IP (`LIMITADOR_ACTUALIZACIONES`).
 *
 * Lo que cambia el feed —publicar, retirar o promocionar una versión, marcar un bar piloto— vacía la
 * caché del isolate que lo atiende (`olvidarLoQueLeeElFeed`), y lo que ese isolate estuviera leyendo
 * en ese momento ya no se guarda; los demás lo ven, como mucho, un minuto después. También tarda ese
 * minuto, como mucho, en dejar de contar como piloto un equipo revocado.
 */
const VIDA_EN_CACHE_MS = 60_000;

/** Una versión activa, con lo que la identifica: el sistema, la arquitectura y el canal. */
type VersionActiva = Release & { target: string; arch: string; channel: string };

let versionesEnCache: { hastaMs: number; versiones: VersionActiva[] } | null = null;
let pilotosEnCache: { hastaMs: number; equipos: Set<string> } | null = null;
/**
 * Cuántas veces se ha vaciado lo guardado. Una lectura que empezó antes de un vaciado no guarda lo que
 * trae: es lo de antes del cambio, y quedaría un minuto más.
 */
let vaciados = 0;

/** Las versiones activas de todos los sistemas, arquitecturas y canales. Si la base falla, lanza. */
async function versionesActivas(db: Sql, ahoraMs: number): Promise<VersionActiva[]> {
	if (versionesEnCache && versionesEnCache.hastaMs > ahoraMs) return versionesEnCache.versiones;
	const vaciadosAlLeer = vaciados;
	const r = await db.execute(`
		SELECT version, target, arch, channel, notes, pub_date, signature, url
		FROM app_releases
		WHERE is_active = 1
	`);
	const versiones = (r.rows ?? []) as unknown as VersionActiva[];
	if (vaciadosAlLeer === vaciados) versionesEnCache = { hastaMs: ahoraMs + VIDA_EN_CACHE_MS, versiones };
	return versiones;
}

/**
 * RI-30 · ¿Es este equipo de un negocio piloto? El `device_id` llega sin firmar, y no hace falta más:
 * quien se haga pasar por un piloto sólo consigue una versión antes, y el instalador va firmado igual.
 *
 * Cualquier fallo (sin cabecera, equipo desconocido o revocado, la base que no contesta) es «no»: el
 * canal normal es siempre una respuesta segura. Un fallo no se guarda: la petición siguiente vuelve a
 * preguntar. La central saturada o un fallo pasajero de la plataforma se pasan solos y no van a Sentry.
 */
async function esPiloto(db: Sql, deviceId: string, ahoraMs: number): Promise<boolean> {
	if (!deviceId) return false;
	if (pilotosEnCache && pilotosEnCache.hastaMs > ahoraMs) return pilotosEnCache.equipos.has(deviceId);

	const vaciadosAlLeer = vaciados;
	let equipos: Set<string>;
	try {
		const r = await db.execute(`
			SELECT d.device_id AS device_id
			FROM devices d JOIN tenants t ON t.tenant_id = d.tenant_id
			WHERE t.piloto = 1 AND d.revoked_at_ms IS NULL
		`);
		equipos = new Set((r.rows ?? []).map((f) => String((f as any).device_id)));
	} catch (e: any) {
		if (!esPasajeroDeLaCentral(e)) {
			capturarError(e, "update.pilot_lookup");
			console.error("[update] no se pudo saber si el equipo es piloto:", String(e?.message || e));
		}
		return false;
	}
	if (vaciadosAlLeer === vaciados) pilotosEnCache = { hastaMs: ahoraMs + VIDA_EN_CACHE_MS, equipos };
	return equipos.has(deviceId);
}

/** Lo que el feed tiene guardado deja de valer: lo llama quien cambia una versión o un bar piloto. */
export function olvidarLoQueLeeElFeed(): void {
	versionesEnCache = null;
	pilotosEnCache = null;
	vaciados++;
}

updatesRoutes.get("/:target/:arch/:current", filtroPorIp("LIMITADOR_ACTUALIZACIONES", "update"), async (c) => {
	const target = c.req.param("target"); // p. ej. "windows"
	const arch = c.req.param("arch"); // p. ej. "x86_64"
	const current = c.req.param("current"); // versión instalada (sólo para observabilidad)

	const db = getDb(c.env);
	const ahoraMs = Date.now();
	// Las versiones antes que el piloto: si la base no puede atender, la petición falla en el primer
	// viaje (su 503, por el `onError`) sin hacer otro.
	const activas = await versionesActivas(db, ahoraMs);
	const piloto = await esPiloto(db, String(c.req.header("X-Tpv-Device") || "").trim(), ahoraMs);

	// REV-23: se filtra por `arch`, que antes se ignoraba —llegaba en la ruta, no entraba en la
	// consulta y sólo servía para componer la clave de `platforms`—. O sea que un equipo aarch64
	// se llevaba el instalador x86_64 etiquetado como suyo. En Windows arranca emulado y por eso
	// no se ha notado; el día que exista una build aarch64 se notaría instalando la que no es.
	//
	// Y se miran TODAS las activas en vez de la última insertada: cuál es la más nueva lo decide
	// la versión, no la fecha de la fila. Son unas pocas decenas de filas como mucho.
	const candidatas = activas.filter(
		(v) => v.target === target && v.arch === arch && (v.channel === "stable" || (piloto && v.channel === "beta")),
	);

	const row = candidatas.reduce<Release | undefined>(
		(mejor, fila) =>
			!mejor || compararVersiones(fila.version, mejor.version) > 0 ? fila : mejor,
		undefined,
	);

	// Visibilidad de versiones: queda en los logs del worker (observability ya activa).
	console.log("[update] check", {
		target,
		arch,
		current,
		piloto,
		serving: row?.version ?? null,
	});

	// Sin release publicada para esta plataforma → 204: el plugin entiende "estás al día".
	if (!row) return new Response(null, { status: 204 });

	// Formato estático del updater de Tauri. Por defecto el plugin busca su plataforma como
	// "<target>-<arch>"; con un target fijado por la app (`windows7`) busca la clave tal cual, sin la
	// arquitectura. Van las dos: a cada equipo le sobra una y no le estorba.
	const plataforma = { signature: row.signature, url: row.url };
	const manifest = {
		version: row.version,
		notes: row.notes || "",
		pub_date: row.pub_date,
		platforms: {
			[`${target}-${arch}`]: plataforma,
			[target]: plataforma,
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
	target: z.enum(TARGETS).optional(), // por defecto "windows"
	arch: z.string().optional(), // por defecto "x86_64" (REV-23: forma parte de la identidad)
	channel: z.enum(CANALES).optional(), // por defecto "stable"
});

updatesRoutes.post("/publish", soloConTokenDeRelease, cuerpo(publishSchema), async (c) => {
	const datos = c.req.valid("json");

	const target = datos.target || "windows";
	const arch = datos.arch || "x86_64";
	const channel = datos.channel || "stable";
	const pubDate = datos.pub_date || new Date().toISOString();

	const db = getDb(c.env);

	// RI-30: `ON CONFLICT … DO UPDATE` y no `INSERT OR REPLACE`, que borra la fila y la vuelve a crear:
	// retocar las notas de una versión le ponía la fecha de hoy (REV-23). Volver a publicar una versión
	// la reactiva, que es lo que se espera de publicarla.
	await db.execute({
		sql: `
			INSERT INTO app_releases
				(version, target, arch, channel, notes, pub_date, signature, url, is_active, created_at_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, unixepoch()*1000)
			ON CONFLICT(version, target, arch, channel) DO UPDATE SET
				notes = excluded.notes,
				pub_date = excluded.pub_date,
				signature = excluded.signature,
				url = excluded.url,
				is_active = 1
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
	olvidarLoQueLeeElFeed();

	return c.json({ ok: true, version: datos.version, target, arch, channel });
});

/* ── Rollback: desactivar una release (admin) ──────────────────────────────── */

const deactivateSchema = z.object({
	version: z.string().min(1),
	target: z.enum(TARGETS).optional(),
	arch: z.string().optional(),
	channel: z.enum(CANALES).optional(),
});

updatesRoutes.post("/deactivate", soloConTokenDeRelease, cuerpo(deactivateSchema), async (c) => {
	const datos = c.req.valid("json");

	const target = datos.target || "windows";

	const db = getDb(c.env);

	// Sin `arch` se desactiva la versión en TODOS los arch, que es lo que quiere un rollback: si
	// una versión está mal, lo está en todas partes. Indicándolo se acota a uno. Lo mismo con el
	// canal (RI-30): una versión mala lo es en `beta` y en `stable`.
	const arch = datos.arch;
	const channel = datos.channel;
	await db.execute({
		sql: `
			UPDATE app_releases SET is_active = 0
			WHERE version = ?1 AND target = ?2 AND (?3 IS NULL OR channel = ?3) AND (?4 IS NULL OR arch = ?4)
		`,
		args: [datos.version, target, channel ?? null, arch ?? null],
	});
	olvidarLoQueLeeElFeed();

	return c.json({
		ok: true,
		deactivated: datos.version,
		target,
		arch: arch ?? "todos",
		channel: channel ?? "todos",
	});
});
