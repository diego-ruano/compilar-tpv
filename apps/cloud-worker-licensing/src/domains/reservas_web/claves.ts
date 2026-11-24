// src/domains/reservas_web/claves.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): la clave pública de cada negocio.
//
// Es la que va en la línea que se pega en la web del restaurante, así que la ve cualquiera: sólo
// identifica al negocio, no protege nada. Lo que protege la puerta pública es lo demás
// (`puerta.ts`): Turnstile, los limitadores, la licencia y los dominios autorizados. Por eso no se
// usa el `tenant_id` directamente: una clave aparte se revoca sin tocar el negocio y no expone un
// identificador interno.

import type { Sql } from "../../lib/sql";
import { recortar } from "../../lib/texto";

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

/**
 * Desde dónde se sirve el widget para las webs: `RESERVAS_WEB_ORIGEN`, la dirección que queda pegada en
 * cada web y en cada correo (hoy la de `workers.dev`, INFRA-04), o, si no está, el origen de la
 * petición. Fija, y no la de la petición: la línea y los enlaces no pueden depender de por qué
 * dirección llame quien los pide.
 */
export function origenDelWidget(env: { RESERVAS_WEB_ORIGEN?: string }, urlDeLaPeticion: string): string {
	return recortar(env.RESERVAS_WEB_ORIGEN ?? "").replace(/\/+$/, "") || new URL(urlDeLaPeticion).origin;
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
/** Las claves que existen, con su negocio. Sólo las crea la Main de un negocio, así que caben todas. */
const cache = new Map<string, { hasta: number; tenantId: string }>();
/**
 * Las que no existen o están revocadas, con hasta cuándo se recuerdan. Van aparte porque cualquiera
 * puede inventarlas, con la forma buena y sin límite: llenar ésta no vacía la de arriba. Llegada a su
 * tope, se olvida la más antigua.
 */
const cacheNegativa = new Map<string, number>();
const CACHE_NEGATIVA_MAX = 1000;

/**
 * El negocio de una clave, o `null` si no existe o está revocada. Se cachea por isolate un minuto,
 * como la licencia (`lib/licenciaEnUso.ts`): sin caché, cada visita a un widget sería una consulta
 * más a la base central. Revocar una clave tarda, como mucho, ese minuto en notarse. Una clave que no
 * vale también se recuerda ese minuto (la de una web que la sigue teniendo pegada), en su caché.
 */
export async function negocioDeLaClave(db: Sql, clave: string): Promise<string | null> {
	if (!CLAVE_RE.test(clave)) return null;
	const ahora = Date.now();
	const cacheado = deLaCache(clave, ahora);
	if (cacheado !== undefined) return cacheado;

	const rs = await db.execute({
		sql: "SELECT tenant_id FROM reserva_web_claves WHERE clave = ? AND revoked_at_ms IS NULL LIMIT 1;",
		args: [clave],
	});
	const tenantId = ((rs.rows?.[0] as any)?.tenant_id as string | undefined) ?? null;

	if (tenantId) {
		cacheNegativa.delete(clave);
		if (cache.size >= CACHE_MAX) cache.clear();
		cache.set(clave, { hasta: ahora + CACHE_MS, tenantId });
	} else {
		cache.delete(clave);
		// Se borra antes de apuntarla para que quede la última en el orden en que se olvidan.
		cacheNegativa.delete(clave);
		if (cacheNegativa.size >= CACHE_NEGATIVA_MAX) {
			const masAntigua = cacheNegativa.keys().next();
			if (!masAntigua.done) cacheNegativa.delete(masAntigua.value);
		}
		cacheNegativa.set(clave, ahora + CACHE_MS);
	}
	return tenantId;
}

/** El negocio de la clave según las cachés: el negocio, `null` si no vale, o `undefined` si no lo saben. */
function deLaCache(clave: string, ahora: number): string | null | undefined {
	const buena = cache.get(clave);
	if (buena && buena.hasta > ahora) return buena.tenantId;
	const mala = cacheNegativa.get(clave);
	return mala !== undefined && mala > ahora ? null : undefined;
}

/**
 * El negocio de una clave sólo si este isolate ya la ha resuelto hace menos de un minuto; `undefined`
 * si no lo sabe. Para lo que no debe preguntar a la base: el CORS de una respuesta que la puerta ha
 * cortado antes de resolver la clave (el limitador) no puede abrir la puerta a un barrido de claves.
 */
export function negocioCacheado(clave: string): string | null | undefined {
	return deLaCache(clave, Date.now());
}

const cacheDominios = new Map<string, { hasta: number; dominios: string[] }>();

/**
 * Los de abajo, con la misma caché de un minuto por isolate que las claves: se piden cada vez que
 * alguien abre el widget. Poner o quitar una web se nota en el acto en este isolate y en un minuto
 * en los demás.
 */
export async function dominiosCacheados(db: Sql, tenantId: string): Promise<string[]> {
	const ahora = Date.now();
	const guardado = cacheDominios.get(tenantId);
	if (guardado && guardado.hasta > ahora) return guardado.dominios;
	const dominios = await dominiosDelNegocio(db, tenantId);
	if (cacheDominios.size >= CACHE_MAX) cacheDominios.clear();
	cacheDominios.set(tenantId, { hasta: ahora + CACHE_MS, dominios });
	return dominios;
}

/** Los orígenes donde se puede incrustar el widget del negocio (`frame-ancestors`). */
export async function dominiosDelNegocio(db: Sql, tenantId: string): Promise<string[]> {
	const rs = await db.execute({
		sql: "SELECT origen FROM reserva_web_dominios WHERE tenant_id = ? ORDER BY origen;",
		args: [tenantId],
	});
	return (rs.rows ?? []).map((r: any) => String(r.origen));
}

/**
 * La clave activa de un negocio, revocada; o `null` si no tenía. La siguiente vez que la Main la
 * pida se crea otra, y la línea pegada en su web deja de funcionar: hay que cambiarla.
 */
export async function revocarClave(db: Sql, tenantId: string, ahoraMs: number): Promise<string | null> {
	const rs = await db.execute({
		sql: `UPDATE reserva_web_claves SET revoked_at_ms = ?
		      WHERE tenant_id = ? AND revoked_at_ms IS NULL RETURNING clave;`,
		args: [ahoraMs, tenantId],
	});
	// En este isolate se nota en el acto; en los demás, al caducar su caché (un minuto).
	cache.clear();
	return ((rs.rows?.[0] as any)?.clave as string | undefined) ?? null;
}

/**
 * Un origen donde se puede incrustar el widget, como lo compara el navegador en `frame-ancestors`:
 * esquema, host y puerto, sin ruta. Sólo `https`, salvo `http://localhost` y `http://127.0.0.1`
 * para desarrollar. `null` si no lo es.
 */
export function normalizarOrigen(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(recortar(raw));
	} catch {
		return null;
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
	return url.origin;
}

export async function ponerDominio(db: Sql, tenantId: string, origen: string, ahoraMs: number): Promise<void> {
	cacheDominios.delete(tenantId);
	await db.execute({
		sql: `INSERT INTO reserva_web_dominios (tenant_id, origen, created_at_ms) VALUES (?, ?, ?)
		      ON CONFLICT (tenant_id, origen) DO NOTHING;`,
		args: [tenantId, origen, ahoraMs],
	});
}

/** ¿Estaba? */
export async function quitarDominio(db: Sql, tenantId: string, origen: string): Promise<boolean> {
	cacheDominios.delete(tenantId);
	const rs = await db.execute({
		sql: `DELETE FROM reserva_web_dominios WHERE tenant_id = ? AND origen = ? RETURNING origen;`,
		args: [tenantId, origen],
	});
	return (rs.rows?.length ?? 0) > 0;
}

/** Sólo para los tests: un isolate de vitest se reutiliza entre casos. */
export function olvidarClavesCacheadas(): void {
	cache.clear();
	cacheNegativa.clear();
	cacheDominios.clear();
}
