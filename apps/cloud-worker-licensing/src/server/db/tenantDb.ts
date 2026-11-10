// src/server/db/tenantDb.ts
//
// Resolución LOCAL de las credenciales de la base de datos por-tenant.
//
// Antes esto vivía únicamente dentro del worker de licensing y se consultaba
// desde el worker de API por un service binding (`TPV_LICENSING`) con una
// petición HTTP firmada por HMAC. Al fusionar ambos workers en `tpv-api`, esa
// llamada cruzada desaparece: el Durable Object (y, en el futuro, el middleware
// de tenant de la API) resuelven las credenciales invocando estas funciones
// directamente contra la DB central.
//
// La rotación del token de Turso se mantiene idéntica al comportamiento previo:
// el token se regenera de forma proactiva si supera `TENANT_DB_ROTATE_INTERVAL_MS`
// (o si se fuerza por un fallo de autenticación 401 contra la DB del tenant).

import type { Client } from "@libsql/client/web";

import { HubError } from "../../lib/errorHttp";
import { cifrar, descifrar, type ClavesDeAlmacen } from "../crypto";
import { runTenantMigrations } from "../tenantMigrations";

/** Campos del Env que necesita la resolución/rotación de la DB del tenant. */
export type TenantDbEnv = ClavesDeAlmacen & {
	TURSO_PLATFORM_TOKEN: string;
	TURSO_ORG_SLUG: string;
};

export type ResolvedTenantDb = {
	dbName: string;
	tursoUrl: string;
	tursoAuthToken: string;
	rotated: boolean;
	rotatedAtMs: number;
};

const TENANT_DB_ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Lo que dura el token que acuña `tursoCreateDbToken` (`?expiration=7d`). La rotación cada 24 h
// deja seis días de margen, y ese margen es justo lo que REV-09 aprovecha: si la API de plataforma
// de Turso no contesta, el token guardado sigue sirviendo.
const TENANT_DB_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Cuánto antes de que caduque se deja de tolerar el fallo. Pasado ese punto, seguir con el token
// guardado sólo cambia un error claro ahora por un 401 opaco dentro de unas horas.
const TENANT_DB_MARGEN_CADUCIDAD_MS = 12 * 60 * 60 * 1000;

// ---------------- Guard de migración por tenant (caché por isolate) ----------------
//
// Comprobar la tabla `_migrations` en Turso por HTTP en CADA petición arruinaría el rendimiento.
// Aquí cacheamos, durante el ciclo de vida del isolate del Worker, qué tenants ya han sido
// verificados/migrados. Tras la primera vez, el guard deja pasar la petición al instante.
//
// Guardamos la PROMESA (no un boolean) a propósito: así varias peticiones concurrentes del MISMO
// tenant comparten la misma migración en vuelo (single-flight) en lugar de lanzar dos a la vez.
// - Éxito  → la entrada (promesa resuelta) queda cacheada para siempre en este isolate.
// - Fallo  → se borra la entrada para reintentar en la próxima petición.
const migrationGuard = new Map<string, Promise<void>>();

/**
 * Garantiza —una sola vez por isolate y por tenant— que la BD del tenant tiene aplicadas todas las
 * migraciones. Idempotente y barato tras la primera vez (devuelve la promesa ya resuelta, sin tocar
 * Turso). Es el camino que hace que un cambio de esquema llegue a tenants YA activos sin necesidad
 * de re-provisionar manualmente.
 */
export function ensureTenantMigrated(client: Client, tenantId: string): Promise<void> {
	let inFlight = migrationGuard.get(tenantId);
	if (!inFlight) {
		inFlight = runTenantMigrations(client).catch((e) => {
			// Permite reintentar en la próxima petición (no dejamos el fallo cacheado).
			migrationGuard.delete(tenantId);
			throw e;
		});
		migrationGuard.set(tenantId, inFlight);
	}
	return inFlight;
}

// ---------------- El token guardado, cifrado con LICENSE_STORE_KEY ----------------

/** El token de Turso guardado, en claro. El cifrado lo lleva `server/crypto.ts` (RI-73). */
async function descifrarToken(env: ClavesDeAlmacen, guardado: unknown): Promise<string> {
	return (await descifrar(env, String(guardado))).texto;
}

// ---------------- tenant_databases (DB central) ----------------

export async function getTenantDbRow(dbCentral: Client, tenantId: string) {
	const r = await dbCentral.execute({
		sql: `
			SELECT
				tenant_id,
				turso_db_name,
				turso_url,
				turso_auth_token_enc,
				created_at_ms,
				rotated_at_ms
			FROM tenant_databases
			WHERE tenant_id = ?
			LIMIT 1
		`,
		args: [tenantId],
	});
	return r.rows?.[0] as any | undefined;
}

export async function upsertTenantDbRow(
	dbCentral: Client,
	env: TenantDbEnv,
	tenantId: string,
	dbName: string,
	tursoUrl: string,
	tursoTokenPlain: string,
) {
	const enc = await cifrar(env, tursoTokenPlain);
	await dbCentral.execute({
		sql: `INSERT INTO tenant_databases (tenant_id, turso_db_name, turso_url, turso_auth_token_enc, created_at_ms, rotated_at_ms)
		      VALUES (?, ?, ?, ?, unixepoch()*1000, NULL)
		      ON CONFLICT(tenant_id) DO UPDATE SET
		        turso_db_name = excluded.turso_db_name,
		        turso_url = excluded.turso_url,
		        turso_auth_token_enc = excluded.turso_auth_token_enc,
		        rotated_at_ms = unixepoch()*1000`,
		args: [tenantId, dbName, tursoUrl, enc],
	});
}

/**
 * Cómo sale una petición a la API de plataforma de Turso: `fetch` a secas, o con plazo
 * (`fetchConPlazo`) cuando quien rota el token no puede quedarse esperando sin límite. AUD-02: el
 * `TenantHub` rota dentro del turno del log, y el turno no puede quedarse cogido.
 */
export type PedirATurso = (peticion: Request) => Promise<Response>;

const pedirSinPlazo: PedirATurso = (peticion) => fetch(peticion);

export async function tursoCreateDbToken(
	env: TenantDbEnv,
	dbName: string,
	pedir: PedirATurso = pedirSinPlazo,
): Promise<string> {
	const r = await pedir(
		new Request(
			`https://api.turso.tech/v1/organizations/${encodeURIComponent(
				env.TURSO_ORG_SLUG,
			)}/databases/${encodeURIComponent(dbName)}/auth/tokens?expiration=7d`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
					Accept: "application/json",
				},
			},
		),
	);

	const text = await r.text();
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch {}

	if (!r.ok) throw new Error(`turso_create_db_token_failed (${r.status}) ${text}`);

	const jwt = String(data?.jwt || "");
	if (!jwt) throw new Error(`turso_create_db_token_failed_missing_jwt ${text}`);
	return jwt;
}

/**
 * Borra la base de un tenant en Turso. Que ya no exista (404) cuenta como hecho: es lo que
 * permite repetir un borrado que se quedó a medias.
 */
export async function tursoDeleteDatabase(
	env: Pick<TenantDbEnv, "TURSO_PLATFORM_TOKEN" | "TURSO_ORG_SLUG">,
	dbName: string,
): Promise<"borrada" | "no_existia"> {
	const r = await fetch(
		`https://api.turso.tech/v1/organizations/${encodeURIComponent(
			env.TURSO_ORG_SLUG,
		)}/databases/${encodeURIComponent(dbName)}`,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
				Accept: "application/json",
			},
		},
	);
	if (r.status === 404) return "no_existia";
	if (!r.ok) throw new Error(`turso_delete_db_failed (${r.status}) ${await r.text()}`);
	return "borrada";
}

function toNumOrNull(v: any): number | null {
	// ⚠️ `Number(null)` es 0 (y es finito), así que sin este guardia una columna SQL NULL se
	// convertía en 0 en vez de en null. Eso rompía la rotación del token del tenant de dos formas:
	//   · `oldRotatedAtMs` valía 0 → el CAS `WHERE rotated_at_ms IS 0` NUNCA casaba con la fila real
	//     (`rotated_at_ms IS NULL`) → 0 filas afectadas → `won=false` → se devolvía el token VIEJO y
	//     la rotación no se persistía jamás. Al caducar el token (7 d) toda lectura del tenant
	//     quedaba en 401 permanente, sin recuperación posible.
	//   · `getTenantTokenAgeBaseMs` devolvía 0 en vez de caer a `created_at_ms` → `shouldRotate`
	//     siempre true → se acuñaba un token de Turso en cada arranque de isolate (desperdicio).
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function getTenantTokenAgeBaseMs(row: any): number {
	return toNumOrNull(row?.rotated_at_ms) ?? toNumOrNull(row?.created_at_ms) ?? 0;
}

/**
 * Resuelve (y rota si procede) las credenciales de la DB del tenant.
 *
 * Usa locking optimista en la rotación: el UPDATE solo escribe si `rotated_at_ms`
 * sigue siendo el valor que leyó este isolate. Si otro isolate ganó la carrera,
 * se relee la fila y se descifra el token que él escribió, sin sobreescribir.
 *
 * @param dbCentral   Cliente libsql a la DB central (control).
 * @param env         Secretos para descifrar/rotar el token.
 * @param tenantId    Tenant a resolver.
 * @param forceRotate Fuerza la generación de un token nuevo (p. ej. tras un 401).
 */
export async function resolveTenantDbCredentials(
	dbCentral: Client,
	env: TenantDbEnv,
	tenantId: string,
	forceRotate = false,
	pedir?: PedirATurso,
): Promise<ResolvedTenantDb> {
	const row = await getTenantDbRow(dbCentral, tenantId);

	if (!row?.turso_db_name || !row?.turso_url || !row?.turso_auth_token_enc) {
		throw new HubError("tenant_db_not_provisioned", 404);
	}

	const dbName = String(row.turso_db_name);
	const tursoUrl = String(row.turso_url);
	const oldRotatedAtMs = toNumOrNull(row?.rotated_at_ms); // null = nunca rotado
	const lastRotationBaseMs = getTenantTokenAgeBaseMs(row);

	const shouldRotate =
		forceRotate ||
		!lastRotationBaseMs ||
		Date.now() - lastRotationBaseMs >= TENANT_DB_ROTATE_INTERVAL_MS;

	if (shouldRotate) {
		// REV-09: una rotación PROACTIVA que falla no puede tumbar la nube entera.
		//
		// El token guardado dura 7 días y se rota cada 24 h, así que cuando toca rotar suele
		// quedarle casi una semana de vida. Aun así, un fallo de la API de plataforma de Turso
		// —que es otro servicio, con su propia disponibilidad— salía por aquí y dejaba sin
		// resolver la credencial: todas las lecturas REST y el Durable Object, de TODOS los
		// negocios, mientras durase. Se cambiaba una molestia (no rotar hoy) por una caída.
		//
		// Reglas de este `catch`:
		//   · Sólo vale para la rotación proactiva. Con `forceRotate` venimos de un 401, o sea que
		//     el token guardado YA no sirve: reutilizarlo sería girar en el mismo error.
		//   · Y sólo mientras al token le quede holgura. Cerca de su caducidad se vuelve a fallar,
		//     porque entonces seguir con él sólo cambia un error claro ahora por un 401 opaco luego.
		let freshToken: string;
		try {
			freshToken = await tursoCreateDbToken(env, dbName, pedir);
		} catch (e: any) {
			const vidaRestante = lastRotationBaseMs
				? lastRotationBaseMs + TENANT_DB_TOKEN_TTL_MS - Date.now()
				: 0;
			if (forceRotate || vidaRestante < TENANT_DB_MARGEN_CADUCIDAD_MS) throw e;

			console.warn(
				`[tenantDb] no se pudo rotar el token de tenant=${tenantId}: ${String(e?.message || e)}. ` +
				`Se sigue con el guardado (le quedan ${Math.round(vidaRestante / 3_600_000)} h).`,
			);
			const token = await descifrarToken(env, row.turso_auth_token_enc);
			return { dbName, tursoUrl, tursoAuthToken: token, rotated: false, rotatedAtMs: lastRotationBaseMs };
		}

		// CAS: solo escribe si nadie más ha rotado mientras generábamos el token.
		const won = await rotateTokenIfOwner(
			dbCentral,
			env,
			tenantId,
			freshToken,
			oldRotatedAtMs,
		);

		if (won) {
			return {
				dbName,
				tursoUrl,
				tursoAuthToken: freshToken,
				rotated: true,
				rotatedAtMs: Date.now(),
			};
		}

		// Otro isolate ganó la carrera: leer y descifrar su token (no sobreescribir).
		// Si esto se repite con `forceRotate` (es decir, veníamos de un 401), NO es una carrera:
		// significa que el CAS no casa y la rotación es inefectiva → el token caducado se reusará y
		// el tenant se queda en 401 permanente. Lo hacemos ruidoso para que no vuelva a pasar mudo.
		if (forceRotate) {
			console.warn(
				`[tenantDb] rotacion forzada NO persistida para tenant=${tenantId} ` +
				`(CAS sin filas, oldRotatedAtMs=${oldRotatedAtMs}). Se reutiliza el token almacenado.`,
			);
		}
		const updated = await getTenantDbRow(dbCentral, tenantId);
		if (!updated?.turso_auth_token_enc) {
			throw new HubError("tenant_db_not_provisioned", 404);
		}
		const token = await descifrarToken(env, updated.turso_auth_token_enc);
		return {
			dbName,
			tursoUrl,
			tursoAuthToken: token,
			rotated: false,
			rotatedAtMs: toNumOrNull(updated?.rotated_at_ms) ?? lastRotationBaseMs,
		};
	}

	// RI-73: un token guardado que no se deja descifrar (se cambió `LICENSE_STORE_KEY` sin pasar la
	// anterior) no tiene arreglo leyéndolo otra vez, pero sí acuñando otro: para eso no hace falta el
	// viejo. Antes el negocio se quedaba sin Handy ni Durable Object hasta la rotación del día
	// siguiente.
	let token: string;
	try {
		token = await descifrarToken(env, row.turso_auth_token_enc);
	} catch (e: any) {
		console.warn(
			`[tenantDb] el token guardado de tenant=${tenantId} no se puede descifrar (${String(e?.message || e)}): se rota ya.`,
		);
		return resolveTenantDbCredentials(dbCentral, env, tenantId, true, pedir);
	}

	return {
		dbName,
		tursoUrl,
		tursoAuthToken: token,
		rotated: false,
		rotatedAtMs: lastRotationBaseMs,
	};
}

/**
 * Actualiza el token cifrado solo si `rotated_at_ms` sigue siendo `oldRotatedAtMs`
 * (o NULL si nunca se ha rotado). Devuelve true si la escritura se completó, false
 * si otro isolate ya había rotado antes.
 */
async function rotateTokenIfOwner(
	dbCentral: Client,
	env: TenantDbEnv,
	tenantId: string,
	freshToken: string,
	oldRotatedAtMs: number | null,
): Promise<boolean> {
	const enc = await cifrar(env, freshToken);
	// IS hace comparación NULL-safe: `col IS NULL` cuando el arg es null,
	// `col IS 1234` (equivalente a =) cuando es un número.
	const result = await dbCentral.execute({
		sql: `UPDATE tenant_databases
		      SET turso_auth_token_enc = ?,
		          rotated_at_ms        = unixepoch() * 1000
		      WHERE tenant_id     = ?
		        AND rotated_at_ms IS ?`,
		args: [enc, tenantId, oldRotatedAtMs],
	});
	return result.rowsAffected > 0;
}
