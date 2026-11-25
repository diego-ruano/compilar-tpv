// test/centralAnonimas.test.ts
//
// La base central es un solo objeto que atiende de una en una (`durableObjects/baseCentral.ts`): una
// ruta sin autenticar que la lea en cada petición deja que una sola red la sature. Toda ruta anónima
// que llega a ella lleva delante un filtro por IP (`lib/limitador.ts`) o una caché, y aquí se vigila
// desde la `app` entera, con una base central de verdad que cuenta los viajes:
//
//   · Se recorren TODAS las rutas registradas (`app.routes`), también las de `all`. Las que pasan por
//     `tenantAuth` o por el token de administración (`requireAdmin`) antes de llegar a su manejador
//     están autenticadas, y con un token inventado no llegan a la central. Cualquier otra tiene que
//     estar en `ANONIMAS`, con lo que la protege: una ruta anónima nueva hace fallar el test hasta que
//     alguien decide qué la protege y lo apunta aquí.
//   · Lo apuntado se comprueba, no se cree: con su limitador cerrado, la ruta contesta 429 sin llegar
//     a la central, y el limitador cuenta por red (dos direcciones del mismo /64 son una cuenta); con
//     caché, la segunda petición no llega; con un secreto, una petición inventada no llega; y la que
//     dice no tocarla, no la toca.
//
// Los viajes se cuentan en el espacio `BaseCentral` del entorno de la petición: cada viaje del Worker
// pide su objeto con `centralDe(c.env)`, también los de `getDb`. Lo que lean desde dentro un
// TenantHub o una AgendaWeb, con su propio entorno, no se ve: con el limitador cerrado tampoco llega
// a ellos, pero una caché o un «no la toca» de una ruta así no se podría comprobar aquí.
//
// Lo que no puede ver: una puerta que sólo se abre con una petición bien hecha (un cuerpo válido, una
// firma de su propia clave) y que lea la central sin un limitador delante. Por eso la lista es
// cerrada y cada entrada dice por qué está protegida: es una decisión que se revisa al añadirla.
// Lo de cada protección por dentro lo prueban sus propios tests (el feed y las claves, abajo).
//
// Qué middlewares tiene cada ruta se le pregunta al router de Hono (`app.router.match`). Si algo
// esconde `tenantAuth` (otra versión de Hono, un router con su propio `onError`, que envuelve sus
// manejadores), las autenticadas salen como anónimas sin apuntar: el test falla, no pasa en falso.

import { env as entorno } from "cloudflare:test";
import { COMPOSED_HANDLER } from "hono/utils/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

import configuracionDelWorker from "../wrangler.json";
import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import { app } from "../src/app";
import type { RespuestaDeLaCentral, SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import type { FilasEnBruto } from "../src/durableObjects/sqliteDelObjeto";
import { tenantAuth } from "../src/middleware/tenant";
import { requireAdmin } from "../src/middleware/requireAdmin";
import { DEMASIADAS_PETICIONES } from "../src/lib/limitador";
import { olvidarSalud } from "../src/server/salud";
import { olvidarLoQueLeeElFeed } from "../src/domains/updates/updates.routes";
import { negocioCacheado, negocioDeLaClave, olvidarClavesCacheadas } from "../src/domains/reservas_web/claves";
import { centralDe } from "../src/lib/objetosDelNegocio";
import { getDb } from "../src/server/db";

const env = entorno as any;

// ── La base central que cuenta los viajes ─────────────────────────────────────

/** La base central del caso: aprovisionada y vacía (`beforeEach`). */
let central: CentralDePrueba;
/** Por donde le llegan las peticiones: la central tal cual, o vista a través de su stub (`centralInterceptada`). */
let vista: CentralDePrueba;
let viajes = 0;

/**
 * El espacio `BaseCentral` del entorno de cada petición, el de `vista`, contando cada objeto que se
 * le pide: cada viaje a la central desde el Worker pide el suyo (`centralDe(c.env)`).
 */
function espacioQueCuenta(): unknown {
	return new Proxy(vista.entorno.BaseCentral, {
		get(espacio, nombre) {
			const valor = Reflect.get(espacio, nombre);
			if (typeof valor !== "function") return valor;
			return (...args: unknown[]) => {
				if (nombre === "get" || nombre === "getByName") viajes++;
				return valor.apply(espacio, args);
			};
		},
	});
}

// ── Las rutas de la app ───────────────────────────────────────────────────────

const LIMITADORES = (configuracionDelWorker as any).ratelimits.map((r: { name: string }) => r.name) as string[];

/** Todos los limitadores abiertos: cada comprobación cierra el suyo. */
const ABIERTOS = Object.fromEntries(LIMITADORES.map((nombre) => [nombre, undefined]));
const CERRADO = { limit: async () => ({ success: false }) };

/** Un camino de Hono con valores: `:clave` y `*` pasan a ser `x`. */
const concreto = (camino: string) => camino.replace(/:[A-Za-z_]+/g, "x").replace(/\*/g, "x");

/** Con qué método se pide una ruta: la de `all` atiende a todos, y se prueba con GET. */
const metodoDe = (ruta: string) => (ruta.startsWith("ALL ") ? "GET" : ruta.split(" ")[0]);

const METODOS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/**
 * Cada ruta registrada en la `app`, una vez, con su manejador: `GET /v1/update/:target/:arch/:current`.
 *
 * Hono apunta cada pieza de `get(camino, filtro, …, manejador)` como una entrada, y el manejador es
 * la última. Un `use` y un `all` se apuntan igual, con el método `ALL`: el de `all` es una ruta
 * (`ALL /reservas-web/*`) y se distingue porque su manejador no recibe `next`, que un middleware
 * siempre recibe. Un router con su propio `onError` envuelve sus manejadores (`COMPOSED_HANDLER`
 * guarda el de verdad).
 */
function rutasDeLaApp(): Map<string, unknown> {
	const rutas = new Map<string, unknown>();
	for (const r of app.routes) {
		const original = (r.handler as any)[COMPOSED_HANDLER] ?? r.handler;
		if (METODOS.has(r.method) || (r.method === "ALL" && original.length < 2)) rutas.set(`${r.method} ${r.path}`, r.handler);
	}
	return rutas;
}

/** Lo que Hono ejecuta para esa ruta, en orden. */
function cadenaDe(ruta: string): unknown[] {
	const camino = ruta.split(" ")[1];
	const [coincidencias] = (app.router as any).match(metodoDe(ruta), concreto(camino));
	return coincidencias.map(([[manejador]]: any) => manejador);
}

/** ¿Pasa por `tenantAuth` o por el token de administración antes de llegar a su manejador? */
function autenticada(ruta: string, manejador: unknown): boolean {
	const cadena = cadenaDe(ruta);
	const guardia = cadena.findIndex((h) => h === tenantAuth || h === requireAdmin);
	return guardia >= 0 && guardia < cadena.indexOf(manejador);
}

const anonimasDeLaApp = () => [...rutasDeLaApp()].filter(([r, m]) => !autenticada(r, m)).map(([r]) => r);
const autenticadasDeLaApp = () => [...rutasDeLaApp()].filter(([r, m]) => autenticada(r, m)).map(([r]) => r);

/**
 * Una petición de alguien que no es nadie: un token con la forma de uno de verdad y una firma de
 * dispositivo con la de una de verdad, los dos inventados.
 */
function peticionAnonima(ruta: string, cabeceras: Record<string, string> = {}): Request {
	const metodo = metodoDe(ruta);
	const camino = ruta.split(" ")[1];
	const conCuerpo = !["GET", "OPTIONS"].includes(metodo);
	const claims = btoa(JSON.stringify({ tenantId: "negocio", deviceId: "equipo", licHash: "hash" })).replace(/=+$/, "");
	return new Request(`https://tpv-api.test${concreto(camino)}`, {
		method: metodo,
		headers: {
			authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${claims}.firma-inventada`,
			"X-Device-Ts": String(Date.now()),
			"X-Device-Sig": `${"A".repeat(86)}==`,
			"stripe-signature": "t=1,v1=00",
			"CF-Connecting-IP": "203.0.113.7",
			...(conCuerpo ? { "content-type": "application/json" } : {}),
			...cabeceras,
		},
		...(conCuerpo ? { body: "{}" } : {}),
	});
}

/** El entorno de una petición: los limitadores abiertos y la central contando. */
const entornoDeLaPeticion = (extra: Record<string, unknown> = {}) => ({
	...env,
	...ABIERTOS,
	BaseCentral: espacioQueCuenta(),
	...extra,
});

async function pedir(ruta: string, entornoExtra: Record<string, unknown> = {}, cabeceras?: Record<string, string>) {
	return app.request(peticionAnonima(ruta, cabeceras), undefined, entornoDeLaPeticion(entornoExtra));
}

// ── Las rutas anónimas y lo que las protege ───────────────────────────────────

type Proteccion = {
	/** El filtro por IP que va delante: cerrado, la ruta contesta 429 sin llegar a la central. */
	limitador?: string;
	/** Lo que lee lo guarda el isolate: la segunda petición no llega a la central. */
	cache?: true;
	/** Lo que tiene que presentar quien llama antes de llegar a la central. */
	secreto?: string;
	/** No toca la central. */
	sinCentral?: string;
	/** Lo que necesita la petición para llegar hasta su filtro. */
	cabeceras?: Record<string, string>;
};

const ANONIMAS: Record<string, Proteccion> = {
	"GET /health": { cache: true },
	"GET /ws": { limitador: "LIMITADOR_SESION" },
	"OPTIONS /*": { sinCentral: "el preflight de todo el worker contesta sin mirar nada" },
	"OPTIONS /v1/publico/reservas/:clave/*": {
		limitador: "LIMITADOR_RESERVA_WEB",
		// Sin `Origin` no hay nada que permitir, y contesta antes del filtro sin mirar la clave.
		cabeceras: { Origin: "https://web.test" },
	},

	"POST /v1/pair/claim": { limitador: "LIMITADOR_CLAIM" },
	"POST /v1/pair/fetch-token": { limitador: "LIMITADOR_SESION" },
	"POST /v1/pair/cancel": { limitador: "LIMITADOR_SESION" },

	"POST /v1/license/activate": { limitador: "LIMITADOR_LICENCIA" },
	"POST /v1/license/device-change/request": { limitador: "LIMITADOR_LICENCIA" },
	"GET /v1/license/status": { secreto: "el token de sesión, verificado antes de leer nada" },
	"POST /v1/license/refresh": { limitador: "LIMITADOR_SESION" },

	"POST /v1/stripe/webhook": { secreto: "la firma de Stripe, comprobada antes de leer nada" },

	"GET /v1/update/:target/:arch/:current": { limitador: "LIMITADOR_ACTUALIZACIONES", cache: true },
	"POST /v1/update/publish": { secreto: "el token de publicación (`soloConTokenDeRelease`)" },
	"POST /v1/update/deactivate": { secreto: "el token de publicación (`soloConTokenDeRelease`)" },

	"GET /v1/images/:tenant/*": { sinCentral: "las imágenes salen de R2; su filtro es por lo que cuesta R2" },

	"GET /v1/publico/reservas/:clave/negocio": { limitador: "LIMITADOR_RESERVA_WEB" },
	"GET /v1/publico/reservas/:clave/dia": { limitador: "LIMITADOR_RESERVA_WEB" },
	"GET /v1/publico/reservas/:clave/plano": { limitador: "LIMITADOR_RESERVA_WEB" },
	"GET /v1/publico/reservas/:clave/disponibles": { limitador: "LIMITADOR_RESERVA_WEB" },
	"POST /v1/publico/reservas/:clave/reservas": { limitador: "LIMITADOR_RESERVA_WEB" },
	"POST /v1/publico/reservas/:clave/reserva": { limitador: "LIMITADOR_RESERVA_WEB" },
	"POST /v1/publico/reservas/:clave/cancelar": { limitador: "LIMITADOR_RESERVA_WEB" },

	"GET /reservas-web/v1/embed.js": { sinCentral: "un fichero del widget compilado" },
	"GET /reservas-web/assets/*": { sinCentral: "un fichero del widget compilado" },
	"GET /reservas-web/v1/sdk.js": { sinCentral: "un fichero del widget compilado" },
	"GET /reservas-web/v1/w/:clave": { limitador: "LIMITADOR_RESERVA_WEB" },
	"GET /reservas-web/v1/w/:clave/cancelar": { limitador: "LIMITADOR_RESERVA_WEB" },
	"GET /reservas-web/v1/w/:clave/verificar": { limitador: "LIMITADOR_RESERVA_WEB" },
	"ALL /reservas-web/*": { sinCentral: "lo demás bajo `/reservas-web/` no existe: un 404" },
};

beforeEach(async () => {
	olvidarSalud();
	olvidarLoQueLeeElFeed();
	olvidarClavesCacheadas();
	central = await centralDePrueba();
	vista = central;
	viajes = 0;
});

describe("toda ruta que no está autenticada está en la lista, con lo que la protege", () => {
	it("no hay ninguna sin apuntar, ni una apuntada que ya no existe", () => {
		const anonimas = anonimasDeLaApp();
		const sinApuntar = anonimas.filter((r) => !(r in ANONIMAS));
		expect(sinApuntar, "rutas anónimas nuevas: ponles un limitador o una caché y apúntalas en ANONIMAS").toEqual([]);
		expect(Object.keys(ANONIMAS).filter((r) => !anonimas.includes(r))).toEqual([]);
	});

	it("cada ruta apuntada dice qué la protege, y una que lee la central no se apunta como que no la toca", () => {
		for (const [ruta, p] of Object.entries(ANONIMAS)) {
			expect(p.limitador || p.cache || p.secreto || p.sinCentral, ruta).toBeTruthy();
			if (p.limitador) expect(LIMITADORES, ruta).toContain(p.limitador);
		}
	});

	it("el contador ve cada objeto que se pide con `centralDe`, también los viajes de `getDb`", async () => {
		centralDe(entornoDeLaPeticion());
		expect(viajes).toBe(1);
		await getDb(entornoDeLaPeticion()).execute("SELECT 1;");
		expect(viajes).toBe(2);
	});

	it("las autenticadas no llegan a la central con un token inventado", async () => {
		const autenticadas = autenticadasDeLaApp();
		expect(autenticadas.length).toBeGreaterThan(50);
		for (const ruta of autenticadas) {
			const res = await pedir(ruta);
			expect([401, 403, 503], ruta).toContain(res.status);
			expect(viajes, ruta).toBe(0);
		}
	});
});

describe("lo que protege a cada una, comprobado", () => {
	for (const [ruta, p] of Object.entries(ANONIMAS)) {
		if (p.limitador) {
			it(`${ruta}: con ${p.limitador} cerrado, 429 sin llegar a la central`, async () => {
				const res = await pedir(ruta, { [p.limitador!]: CERRADO }, p.cabeceras);
				expect(res.status).toBe(429);
				expect(viajes).toBe(0);
			});
			it(`${ruta}: ${p.limitador} cuenta por red, y dos direcciones del mismo /64 son una cuenta`, async () => {
				const claves: string[] = [];
				const queApunta = { limit: async ({ key }: { key: string }) => (claves.push(key), { success: true }) };
				for (const ip of ["2001:db8:bbbb:1::1", "2001:db8:bbbb:1::2"]) {
					await pedir(ruta, { [p.limitador!]: queApunta }, { ...p.cabeceras, "CF-Connecting-IP": ip });
				}
				expect(claves.length).toBeGreaterThanOrEqual(2);
				expect(new Set(claves)).toEqual(new Set(["2001:db8:bbbb:1::/64"]));
			});
		}
		if (p.cache) {
			it(`${ruta}: la segunda petición no llega a la central`, async () => {
				await pedir(ruta, {}, p.cabeceras);
				expect(viajes).toBeGreaterThan(0);
				viajes = 0;
				await pedir(ruta, {}, p.cabeceras);
				expect(viajes).toBe(0);
			});
		}
		if (p.secreto || p.sinCentral) {
			it(`${ruta}: una petición inventada no llega a la central`, async () => {
				const res = await pedir(ruta, {}, p.cabeceras);
				if (p.secreto) expect(res.status).toBeGreaterThanOrEqual(400);
				expect(viajes).toBe(0);
			});
		}
	}

	it("los filtros nuevos siguen declarados en wrangler.json, por minuto", () => {
		const limitadores = (configuracionDelWorker as any).ratelimits as {
			name: string;
			simple: { limit: number; period: number };
		}[];
		for (const nombre of ["LIMITADOR_ACTUALIZACIONES", "LIMITADOR_SESION"]) {
			const declarado = limitadores.find((l) => l.name === nombre);
			// El 429 dice «dentro de 1 minuto» y manda `Retry-After: 60`.
			expect(declarado?.simple.period, nombre).toBe(60);
			expect(declarado?.simple.limit, nombre).toBeGreaterThan(0);
		}
		expect(DEMASIADAS_PETICIONES).toContain("1 minuto");
	});

	it("el 429 de un filtro por IP lleva su frase y `Retry-After`", async () => {
		const res = await pedir("GET /ws", { LIMITADOR_SESION: CERRADO });
		expect(res.headers.get("Retry-After")).toBe("60");
		expect(await res.json()).toMatchObject({ ok: false, error: "too_many_attempts", message: DEMASIADAS_PETICIONES });
	});
});

// ── El feed de actualizaciones ────────────────────────────────────────────────

describe("el feed de actualizaciones no vuelve a la central por petición", () => {
	const publicar = (version: string, channel: "stable" | "beta") =>
		central.db.execute({
			sql: `INSERT INTO app_releases (version, target, arch, channel, notes, pub_date, signature, url, is_active)
			      VALUES (?1, 'windows', 'x86_64', ?2, '', '2026-01-01', ?3, ?4, 1);`,
			args: [version, channel, `sig-${version}`, `https://cdn.test/${version}.exe`],
		});

	async function feed(camino: string, equipo?: string): Promise<string | null> {
		const res = await app.request(
			`https://tpv-api.test/v1/update/${camino}`,
			{ headers: equipo ? { "X-Tpv-Device": equipo } : {} },
			entornoDeLaPeticion(),
		);
		return res.status === 204 ? null : ((await res.json()) as any).version;
	}

	it("ni otro sistema, ni otra arquitectura, ni otro equipo la vuelven a leer antes de tiempo", async () => {
		await publicar("1.0.0", "stable");
		viajes = 0;

		expect(await feed("windows/x86_64/0.9.0", "equipo-1")).toBe("1.0.0");
		// Las versiones activas y los equipos piloto, una vez cada cosa.
		expect(viajes).toBe(2);

		viajes = 0;
		for (let i = 0; i < 20; i++) {
			await feed(`sistema-${i}/arch-${i}/0.0.${i}`, `equipo-inventado-${i}`);
			await feed("windows/x86_64/0.9.0", `otro-equipo-${i}`);
		}
		expect(viajes).toBe(0);
	});

	it("pasado el minuto vuelve a leer, y lo publicado se ve", async () => {
		const ahora = Date.now();
		const reloj = vi.spyOn(Date, "now").mockReturnValue(ahora);
		try {
			await publicar("1.0.0", "stable");
			expect(await feed("windows/x86_64/0.9.0")).toBe("1.0.0");

			// Publicada por otro isolate: éste no la ve hasta que caduca lo que guardó.
			await publicar("1.1.0", "stable");
			reloj.mockReturnValue(ahora + 59_000);
			expect(await feed("windows/x86_64/0.9.0")).toBe("1.0.0");

			reloj.mockReturnValue(ahora + 60_000);
			expect(await feed("windows/x86_64/0.9.0")).toBe("1.1.0");
		} finally {
			reloj.mockRestore();
		}
	});

	it("si la central falla, no se guarda nada: la siguiente petición vuelve a preguntar", async () => {
		// La central contesta que la sentencia ha fallado.
		vista = centralInterceptada(central, async () => ({ ok: false, error: "central_error_sql", detalle: "prueba" }));
		const res = await app.request("https://tpv-api.test/v1/update/windows/x86_64/0.9.0", {}, entornoDeLaPeticion());
		expect(res.status).toBe(500);
		expect(viajes).toBe(1);

		vista = central;
		await publicar("1.0.0", "stable");
		expect(await feed("windows/x86_64/0.9.0")).toBe("1.0.0");
	});

	it("lo que se estaba leyendo al publicar no vuelve a guardar lo de antes", async () => {
		await publicar("1.0.0", "stable");
		let retenida = false;
		let soltar!: () => void;
		const suelta = new Promise<void>((r) => (soltar = r));
		// La lectura de las versiones ya se ha hecho; lo que tarda es que llegue su respuesta.
		vista = centralInterceptada(central, async (metodo, [sentencia], llamar) => {
			const r = await llamar();
			if (!retenida && metodo === "ejecutar" && /FROM app_releases/.test((sentencia as SentenciaEnlazada).sql)) {
				retenida = true;
				await suelta;
			}
			return r;
		});

		const enCurso = feed("windows/x86_64/0.9.0");
		await vi.waitFor(() => expect(retenida).toBe(true));
		const publicada = await app.request(
			"https://tpv-api.test/v1/update/publish",
			{
				method: "POST",
				headers: { authorization: "Bearer token-de-publicar", "content-type": "application/json" },
				body: JSON.stringify({ version: "1.1.0", signature: "sig-1.1.0", url: "https://cdn.test/1.1.0.exe" }),
			},
			entornoDeLaPeticion({ RELEASE_ADMIN_TOKEN: "token-de-publicar" }),
		);
		expect(publicada.status).toBe(200);
		soltar();

		expect(await enCurso).toBe("1.0.0");
		expect(await feed("windows/x86_64/0.9.0")).toBe("1.1.0");
	});
});

// ── Las claves de la reserva web ──────────────────────────────────────────────

describe("las claves inventadas de la reserva web no vacían la caché de las buenas", () => {
	const BUENA = `rw_${"b".repeat(22)}`;
	const inventada = (i: number) => `rw_${i.toString().padStart(22, "0")}`;
	/** El tope de la caché de las que no valen (`CACHE_NEGATIVA_MAX` de claves.ts). */
	const CACHE_NEGATIVA_MAX = 1000;

	/** Lo que contesta la central a una clave que no tiene: ninguna fila. */
	const sinFilas: RespuestaDeLaCentral<FilasEnBruto> = {
		ok: true,
		valor: { columns: ["tenant_id"], rows: [], rowsAffected: 0, lastInsertRowid: null },
	};

	/**
	 * La base central del caso con una sola clave, y las claves por las que se le pregunta, en orden.
	 * Lo que se prueba es la caché del isolate, no la central: sólo la buena viaja hasta ella, y a las
	 * inventadas el doble les contesta lo que contestaría la central (ninguna fila) sin el viaje, que con
	 * miles de claves se comía el plazo del caso.
	 */
	async function baseConUnaClave() {
		await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES ('negocio-bueno');`);
		await filasDe(
			central,
			`INSERT INTO reserva_web_claves (clave, tenant_id, created_at_ms) VALUES (?, 'negocio-bueno', 1);`,
			BUENA,
		);
		const consultas: string[] = [];
		const { db } = centralInterceptada(central, (metodo, [sentencia], llamar) => {
			if (metodo !== "ejecutar") return llamar();
			const clave = String((sentencia as SentenciaEnlazada).args[0]);
			consultas.push(clave);
			return clave === BUENA ? llamar() : sinFilas;
		});
		return { db, consultas };
	}

	it("más claves inventadas de las que caben: la buena sigue en la caché y no vuelve a la base", async () => {
		const { db, consultas } = await baseConUnaClave();
		expect(await negocioDeLaClave(db, BUENA)).toBe("negocio-bueno");

		// Una más de las que caben en la caché de las que no valen: si compartieran caché con las buenas,
		// la llenarían y la vaciarían.
		for (let i = 0; i < CACHE_NEGATIVA_MAX + 1; i++) expect(await negocioDeLaClave(db, inventada(i))).toBeNull();
		expect(consultas).toHaveLength(CACHE_NEGATIVA_MAX + 2);

		consultas.length = 0;
		expect(negocioCacheado(BUENA)).toBe("negocio-bueno");
		expect(await negocioDeLaClave(db, BUENA)).toBe("negocio-bueno");
		expect(consultas).toEqual([]);
	});

	it("una clave que no vale se recuerda: la misma otra vez no vuelve a la base", async () => {
		const { db, consultas } = await baseConUnaClave();
		expect(await negocioDeLaClave(db, inventada(1))).toBeNull();
		expect(await negocioDeLaClave(db, inventada(1))).toBeNull();
		expect(negocioCacheado(inventada(1))).toBeNull();
		expect(consultas).toEqual([inventada(1)]);
	});

	it("la caché de las que no valen tiene tope: se olvidan las más antiguas", async () => {
		const { db } = await baseConUnaClave();
		for (let i = 0; i < CACHE_NEGATIVA_MAX + 1; i++) await negocioDeLaClave(db, inventada(i));
		expect(negocioCacheado(inventada(0))).toBeUndefined();
		expect(negocioCacheado(inventada(1))).toBeNull();
		expect(negocioCacheado(inventada(CACHE_NEGATIVA_MAX))).toBeNull();
	});
});
