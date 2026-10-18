// src/domains/reservas_web/claves.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): la clave pública de cada negocio.
//
// Es la que va en la línea que se pega en la web del restaurante, así que la ve cualquiera: sólo
// identifica al negocio, no protege nada. Lo que protege la puerta pública es lo demás
// (`publico.ts`): Turnstile, los limitadores, la licencia y los dominios autorizados. Por eso no se
// usa el `tenant_id` directamente: una clave aparte se revoca sin tocar el negocio y no expone un
// identificador interno.

import type { Sql } from "../../server/db";

/** `rw_` y 128 bits aleatorios en base64url: no se adivina ni se recorre. */
export function generarClave(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const b64 = btoa(String.fromCharCode(...bytes));
	return `rw_${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** La forma de una clave: el resto no se pregunta a la base. */
export const CLAVE_RE = /^rw_[A-Za-z0-9_-]{22}$/;

export async function claveActivaDelNegocio(db: Sql, tenantId: string): Promise<string | null> {
	const rs = await db.execute({
		sql: "SELECT clave FROM reserva_web_claves WHERE tenant_id = ? AND revoked_at_ms IS NULL LIMIT 1;",
		args: [tenantId],
	});
	return ((rs.rows?.[0] as any)?.clave as string | undefined) ?? null;
}

/**
 * La clave activa del negocio, o una nueva si no tiene. Dos llamadas a la vez no crean dos: el
 * índice único parcial (`ux_reserva_web_claves_activa`) deja entrar sólo una, y la otra se queda con
 * la que entró.
 */
export async function claveDelNegocio(db: Sql, tenantId: string, ahoraMs: number): Promise<string> {
	const actual = await claveActivaDelNegocio(db, tenantId);
	if (actual) return actual;
	await db.execute({
		sql: `INSERT INTO reserva_web_claves (clave, tenant_id, created_at_ms) VALUES (?, ?, ?)
		      ON CONFLICT DO NOTHING;`,
		args: [generarClave(), tenantId, ahoraMs],
	});
	const creada = await claveActivaDelNegocio(db, tenantId);
	if (!creada) throw new Error("reserva_web: la clave no ha quedado guardada");
	return creada;
}

/** La línea que se pega en la web, con el origen desde el que se sirve el widget. */
export function codigoParaLaWeb(origen: string, clave: string): string {
	return (
		`<div data-negocio="${clave}"></div>\n` +
		`<script src="${origen}/reservas-web/v1/embed.js" async></script>`
	);
}

const CACHE_MS = 60_000;
const CACHE_MAX = 1000;
const cache = new Map<string, { hasta: number; tenantId: string | null }>();

/**
 * El negocio de una clave, o `null` si no existe o está revocada. Se cachea por isolate un minuto,
 * como la licencia (`lib/licenciaEnUso.ts`): sin caché, cada visita a un widget sería una consulta
 * más a la base central. Revocar una clave tarda, como mucho, ese minuto en notarse.
 */
export async function negocioDeLaClave(db: Sql, clave: string): Promise<string | null> {
	if (!CLAVE_RE.test(clave)) return null;
	const ahora = Date.now();
	const guardado = cache.get(clave);
	if (guardado && guardado.hasta > ahora) return guardado.tenantId;

	const rs = await db.execute({
		sql: "SELECT tenant_id FROM reserva_web_claves WHERE clave = ? AND revoked_at_ms IS NULL LIMIT 1;",
		args: [clave],
	});
	const tenantId = ((rs.rows?.[0] as any)?.tenant_id as string | undefined) ?? null;

	if (cache.size >= CACHE_MAX) cache.clear();
	cache.set(clave, { hasta: ahora + CACHE_MS, tenantId });
	return tenantId;
}

/** Los orígenes donde se puede incrustar el widget del negocio (`frame-ancestors`). */
export async function dominiosDelNegocio(db: Sql, tenantId: string): Promise<string[]> {
	const rs = await db.execute({
		sql: "SELECT origen FROM reserva_web_dominios WHERE tenant_id = ? ORDER BY origen;",
		args: [tenantId],
	});
	return (rs.rows ?? []).map((r: any) => String(r.origen));
}

/** Sólo para los tests: un isolate de vitest se reutiliza entre casos. */
export function olvidarClavesCacheadas(): void {
	cache.clear();
}
