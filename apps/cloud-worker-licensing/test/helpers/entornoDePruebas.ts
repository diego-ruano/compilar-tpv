// test/helpers/entornoDePruebas.ts
//
// Los textos del entorno con los que corre la suite: variables y secretos. Los lee
// `vitest.config.ts`, que los pone por encima de `wrangler.json`, y `test/sinRed.test.ts`, que
// comprueba que son los que recibe el worker de pruebas.
//
// Todo lo que nombra un servicio o una cuenta es ficticio: un host `.invalid` no resuelve nunca
// (RFC 2606), así que un test al que le falte un doble no puede acertar con nada de verdad.
//
// Es sólo de tests: no forma parte del worker ni se despliega. No importa nada de workerd porque
// también se carga en Node, desde la configuración.

import type { Env } from "../../src/env";

/** Las claves de `Env` que son texto: las que pueden venir de `vars`, de un secreto o de `.dev.vars`. */
type ClaveDeTexto = {
	[K in keyof Env]-?: NonNullable<Env[K]> extends string | number ? K : never;
}[keyof Env];

/**
 * Vacío es «sin configurar»: el worker trata un secreto vacío igual que uno ausente (los lee con
 * `||` o mira que no estén en blanco). Hace falta escribirlo porque wrangler carga también el
 * `.dev.vars` y el `.env` de la carpeta del worker, y un secreto de desarrollo que no se pisara
 * aquí entraría en la suite.
 */
const SIN_CONFIGURAR = "";

/**
 * Una entrada por cada texto de `Env` (lo exige el tipo: una variable nueva no compila hasta que
 * tiene aquí su valor de pruebas).
 */
export const ENTORNO_DE_PRUEBAS: Record<ClaveDeTexto, string> = {
	// ── Lo que `wrangler.json` (`vars`) apunta a un servicio o a una cuenta de verdad ──
	TURSO_DATABASE_URL: "libsql://base-central.invalid",
	TURSO_ORG_SLUG: "organizacion-de-pruebas",
	EMAIL_FROM_ADDRESS: "pedidos@correo.invalid",
	EMAIL_RESERVAS_FROM_ADDRESS: "reservas@correo.invalid",
	TURNSTILE_SITE_KEY: "clave-de-sitio-de-pruebas",
	RESERVAS_WEB_ORIGEN: "https://reservas-web.invalid",
	AXIOM_DATASET: "dataset-de-pruebas",
	AXIOM_DATASET_SYNC: "dataset-sync-de-pruebas",
	AXIOM_DOMAIN: "axiom.invalid",
	// Se queda como en producción (ver `IGUAL_QUE_EN_PRODUCCION`).
	EMAIL_FROM_NAME: "TPV",

	// ── Secretos que la suite necesita: deterministas y de pruebas ──
	LICENSE_JWT_SECRET: "secreto-de-pruebas-no-usar-en-produccion",
	TURSO_AUTH_TOKEN: "token-de-pruebas-no-usar-en-produccion",
	TURSO_PLATFORM_TOKEN: "token-de-plataforma-de-pruebas",

	// ── Lo demás, sin configurar: el test que lo necesita lo pasa en su propio entorno ──
	LICENSE_STORE_KEY: SIN_CONFIGURAR,
	LICENSE_STORE_KEY_ID: SIN_CONFIGURAR,
	LICENSE_STORE_KEY_ANTERIOR: SIN_CONFIGURAR,
	LICENSE_STORE_KEY_ANTERIOR_ID: SIN_CONFIGURAR,
	LICENSE_SIGNING_PRIVATE_KEY: SIN_CONFIGURAR,
	ADMIN_API_TOKEN: SIN_CONFIGURAR,
	STRIPE_SECRET_KEY: SIN_CONFIGURAR,
	STRIPE_WEBHOOK_SECRET: SIN_CONFIGURAR,
	CHECKOUT_URL: SIN_CONFIGURAR,
	PAIR_PEPPER: SIN_CONFIGURAR,
	HANDY_TOKEN_TTL_SECONDS: SIN_CONFIGURAR,
	TURNSTILE_SECRET_KEY: SIN_CONFIGURAR,
	RELEASE_ADMIN_TOKEN: SIN_CONFIGURAR,
	SENTRY_DSN: SIN_CONFIGURAR,
	ENVIRONMENT: SIN_CONFIGURAR,
	SENTRY_RELEASE: SIN_CONFIGURAR,
	BUILD_COMMIT: SIN_CONFIGURAR,
	AXIOM_TOKEN: SIN_CONFIGURAR,
	BETTERSTACK_HEARTBEAT_URL: SIN_CONFIGURAR,
	BETTERSTACK_HEARTBEAT_COPIAS_URL: SIN_CONFIGURAR,
};

/**
 * El entorno con el que corre la suite: la tabla y, **vacío**, cualquier otro texto que wrangler
 * fuera a cargar. La tabla pisa las claves que conoce; una clave de más en el `.dev.vars` de un
 * equipo (o en su `.env`) no está en ella, y sin esto llegaría a los tests con su valor de verdad.
 */
export function entornoDeLaSuite(textosQueCargaWrangler: readonly string[]): Record<string, string> {
	return {
		...Object.fromEntries(textosQueCargaWrangler.map((nombre) => [nombre, SIN_CONFIGURAR])),
		...ENTORNO_DE_PRUEBAS,
	};
}

/**
 * Las variables de `wrangler.json` que la suite deja con el valor de producción, y por qué. Todas
 * las demás tienen que valer otra cosa (`test/sinRed.test.ts`).
 */
export const IGUAL_QUE_EN_PRODUCCION: Record<string, string> = {
	EMAIL_FROM_NAME: "Es el nombre que se enseña como remitente: no es una dirección ni una cuenta.",
};

/** El nombre del worker auxiliar por el que sale todo lo que el worker de pruebas manda fuera. */
export const WORKER_SIN_RED = "red-bloqueada";

/** El binding por el que la suite le pregunta a ese worker qué ha cortado. Sólo existe en los tests. */
export const COLECTOR_DE_SALIDAS = "SALIDAS_BLOQUEADAS";

/**
 * Empieza así el aviso de cualquier salida que no tenga doble, la corte la guarda de
 * `test/helpers/sinRed.ts` o el worker auxiliar. Detrás va lo que da `describirSalida`.
 */
export const SALIDA_BLOQUEADA = "Salida a la red bloqueada en los tests";

/**
 * «POST https://host:puerto»: el método y el origen, y nada más. Ni la ruta ni la consulta, que es
 * donde viajan los secretos: la dirección de un latido de Better Stack es un secreto entera.
 *
 * No usa nada de fuera de su cuerpo: `vitest.config.ts` mete su texto en el worker auxiliar, para
 * que los dos cierres digan lo mismo.
 */
export function describirSalida(metodo: string, direccion: string): string {
	try {
		const url = new URL(direccion);
		return `${metodo} ${url.protocol}//${url.host}`;
	} catch {
		return `${metodo} (dirección que no se puede interpretar)`;
	}
}
