// test/helpers/central.ts
//
// Una base central de verdad para un test: un objeto `BaseCentral` propio y el cliente con el que le
// habla el worker (`clienteCentral`). El objeto de producción se pide siempre con el mismo nombre
// (`centralDe`); aquí cada test lo pide con el suyo, así que uno sin nombre recibe una base nueva y
// vacía, y dos que compartan nombre comparten base.
//
// Cada fichero de tests corre en su propio workerd, con sus objetos en memoria: dos ficheros no
// comparten nada. Los casos de un mismo fichero sí comparten los objetos que pidan con el mismo
// nombre, también la central del despliegue (`centralDe(env)`). Por eso cada caso pide la suya, sin
// nombre: lo que siembra uno no lo ve otro, corran en el orden que corran.
//
// Las rutas llegan a ella como en producción, por `getDb(env)`, si su `env` lleva el `entorno` de la
// central; un TenantHub, si se le pone con `enElHub(…, { central })` (`helpers/hub.ts`). Lo que el
// test siembra o comprueba por debajo va directo al SQLite del objeto (`filasDe`, `fotoDeLaCentral`,
// `negocioEnLaCentral`), sin pasar por sus guardas. Un fallo o un cruce que haya que provocar va en
// el stub (`centralInterceptada`, `conFalloEnLasOperaciones`), nunca en un doble de la base.

import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import type { BaseCentral } from "../../src/durableObjects/baseCentral";
import { claveConHora } from "../../src/durableObjects/baseCentral.copia";
import { CLAVE_VUELTA_EN_CURSO } from "../../src/durableObjects/baseCentral.guardas";
import type { RespuestaDeLaCentral, SentenciaEnlazada } from "../../src/durableObjects/baseCentral.rpc";
import { ejecutarOperacion } from "../../src/durableObjects/baseCentral.operar";
import type { Instantes } from "../../src/durableObjects/instantes";
import type { FilasEnBruto } from "../../src/durableObjects/sqliteDelObjeto";
import type { Env } from "../../src/env";
import type { SqlSync } from "../../src/lib/sql";
import { clienteCentral, ErrorDeLaCentral, type ClienteCentral } from "../../src/server/central/cliente";
import { MIGRACIONES_DE_LA_CENTRAL } from "../../src/server/central/migraciones";
import { OPERACIONES, type Operacion, type Operaciones } from "../../src/server/central/operaciones/registro";

/**
 * Los nombres de las migraciones de la central de este despliegue, en orden: los que tiene una central
 * recién aprovisionada. Se leen al cargar, antes de que un test añada las suyas.
 */
export const MIGRACIONES_DE_VERDAD: readonly string[] = MIGRACIONES_DE_LA_CENTRAL.map((m) => m.name);

export type CentralDePrueba = {
	db: ClienteCentral;
	/** El stub del objeto, pedido al crearla: sólo vale en ese contexto, no dentro de otro Durable Object. */
	stub: DurableObjectStub<BaseCentral>;
	/** Lo que el `Env` de una ruta tiene que llevar para que `getDb(env)` (`centralDe`) llegue aquí. */
	entorno: Pick<Env, "BaseCentral">;
};

/** Un nombre que no ha usado nadie: una base nueva. */
function nombreNuevo(): string {
	return `central-de-prueba-${crypto.randomUUID()}`;
}

/**
 * El objeto `nombre`, tal como esté: sin aprovisionar si nadie lo ha hecho. El cliente pide un stub
 * nuevo en cada viaje, como el de producción.
 */
export function centralSinAprovisionar(nombre: string = nombreNuevo()): CentralDePrueba {
	const id = env.BaseCentral.idFromName(nombre);
	const pedirStub = () => env.BaseCentral.get(id);
	// `centralDe` pide su nombre fijo y su pista de región: aquí cualquiera da este objeto.
	const espacio = { idFromName: () => id, get: () => pedirStub() } as unknown as Env["BaseCentral"];
	return { db: clienteCentral(pedirStub), stub: pedirStub(), entorno: { BaseCentral: espacio } };
}

/** El objeto `nombre`, aprovisionado: con el esquema de sus migraciones. */
export async function centralDePrueba(nombre: string = nombreNuevo()): Promise<CentralDePrueba> {
	const central = centralSinAprovisionar(nombre);
	if (!(await central.stub.estado()).aprovisionada) {
		const aprovisionada = await central.stub.aprovisionar();
		if (!aprovisionada.ok) {
			throw new Error(`No se ha podido aprovisionar la central de prueba: ${aprovisionada.error} ${aprovisionada.detalle ?? ""}`);
		}
	}
	return central;
}

/**
 * Corre `fn` dentro del objeto de la central, con su `state` y la instancia. Con un stub pedido aquí:
 * el de `central.stub` es del contexto en el que se creó, y dentro de otro Durable Object (una prueba
 * que corre en su TenantHub) no se puede usar.
 */
function enElObjeto<R>(
	central: Pick<CentralDePrueba, "stub">,
	fn: (state: DurableObjectState, objeto: unknown) => R | Promise<R>,
): Promise<R> {
	return runInDurableObject(env.BaseCentral.get(central.stub.id), (objeto, state) => fn(state, objeto));
}

/**
 * Las filas de una sentencia ejecutada directamente en el SQLite del objeto, por fuera de sus guardas
 * y de su cliente: para sembrar lo que una prueba necesita y comprobar lo que ha quedado.
 */
export function filasDe(
	central: Pick<CentralDePrueba, "stub">,
	texto: string,
	...args: unknown[]
): Promise<Record<string, any>[]> {
	return enElObjeto(central, (state) => state.storage.sql.exec(texto, ...args).toArray());
}

/** Las tablas que ha creado alguien en `sql`, por su nombre: sin las de SQLite ni las del propio Durable Object. */
export function tablasPropias(sql: SqlStorage): string[] {
	return sql
		.exec(
			`SELECT name FROM sqlite_master
			  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			  ORDER BY name;`,
		)
		.toArray()
		.map((f) => String(f.name));
}

/**
 * La central entera: cada tabla, con sus filas en el orden en que se insertaron. Con `sinMigraciones`,
 * sin `_migrations`, que lleva cuándo se aplicó cada una: para comparar dos centrales.
 */
export function fotoDeLaCentral(
	central: Pick<CentralDePrueba, "stub">,
	opciones: { sinMigraciones?: boolean } = {},
): Promise<Record<string, unknown[]>> {
	return enElObjeto(central, (state) => {
		const sql = state.storage.sql;
		const tablas = tablasPropias(sql).filter((t) => !(opciones.sinMigraciones && t === "_migrations"));
		return Object.fromEntries(tablas.map((t) => [t, sql.exec(`SELECT * FROM "${t}" ORDER BY rowid;`).toArray()]));
	});
}

/** El código con el que la central ha dicho que no a `promesa`. */
export async function codigoDe(promesa: Promise<unknown>): Promise<string> {
	const error = await promesa.then(
		() => null,
		(e) => e,
	);
	expect(error).toBeInstanceOf(ErrorDeLaCentral);
	return (error as ErrorDeLaCentral).code;
}

/** «Reiniciar» como se ve desde fuera: el objeto arranca vuelto, sin la marca de la vuelta. */
const vuelto = (state: DurableObjectState) => state.storage.kv.delete(CLAVE_VUELTA_EN_CURSO);

/**
 * La clave de una copia de la central que no está en el bucket: una de a mano, de una hora al azar de
 * hace unos años, para que cada prueba tenga la suya (la gramática no admite texto libre).
 */
export function claveDeCopiaNueva(): string {
	return claveConHora("a-mano", new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 100_000_000_000)));
}

/**
 * Los marcadores que contesta el doble de la plataforma, con la forma de los de Cloudflare
 * (`esMarcador`): el del instante al que se vuelve, el de ahora y el que devuelve la plataforma al
 * dejar preparada la vuelta.
 */
export const MARCADORES = {
	destino: "0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b",
	actual: "0000007c-00000000-00001539-1d4f98cc48c4ec6dd63ffec04de4ca7c",
	deshacer: "0000007c-ffffffff-0000153a-2e50a9dd59d5fd7ee740ffd15ef5db8d",
} as const;

/** Lo que contesta el doble de la plataforma cuando una llamada falla (`fallaAl`). */
export const RECHAZO_DE_LA_PLATAFORMA = "La plataforma no acepta ese marcador";

/**
 * El doble de la vuelta a un instante (`Instantes`, que en local no existe), dentro del objeto. Apunta
 * en `llamadas` lo que le piden. Al «reiniciar», el objeto queda como diga `alReiniciar`: por omisión,
 * vuelto y sin la marca de la vuelta (de después del instante, o quitada al arrancar). Con
 * `alRestaurar`, dejar preparada la vuelta espera a lo que devuelva (para retenerla a mitad). El
 * marcador de ahora (con el que se deshace) es siempre `MARCADORES.actual`, salvo que `marcadorActual`
 * dé otro: para distinguir dos preparaciones. Con `fallaAl`, esa llamada a la plataforma falla con
 * `RECHAZO_DE_LA_PLATAFORMA`, como cuando no acepta un marcador.
 */
export async function conDobleDeInstantes(
	central: Pick<CentralDePrueba, "stub">,
	llamadas: string[],
	opciones: {
		alReiniciar?: (state: DurableObjectState) => void;
		alRestaurar?: (marcador: string) => Promise<void> | void;
		marcadorActual?: () => string;
		fallaAl?: "marcadorDe" | "marcadorActual" | "restaurarAlReiniciar";
	} = {},
): Promise<void> {
	const { alReiniciar = vuelto, alRestaurar, marcadorActual = () => MARCADORES.actual, fallaAl } = opciones;
	const siFalla = (metodo: typeof fallaAl) => {
		if (metodo === fallaAl) throw new Error(RECHAZO_DE_LA_PLATAFORMA);
	};
	await enElObjeto(central, (state, objeto) => {
		(objeto as { instantes: unknown }).instantes = {
			marcadorActual: async () => (llamadas.push("actual"), siFalla("marcadorActual"), marcadorActual()),
			marcadorDe: async (ms: number) => (llamadas.push(`de:${typeof ms}`), siFalla("marcadorDe"), MARCADORES.destino),
			restaurarAlReiniciar: async (m: string) => {
				llamadas.push(`restaurar:${m}`);
				siFalla("restaurarAlReiniciar");
				await alRestaurar?.(m);
				return MARCADORES.deshacer;
			},
			reiniciar: () => {
				llamadas.push("reiniciar");
				alReiniciar(state);
			},
		};
	});
}

/** Lo que guarda un objeto, tal cual: cada tabla con su SQL y sus filas, el resto de su esquema y sus marcas. */
type FotoDelObjeto = {
	tablas: { nombre: string; sql: string; columnas: string[]; filas: unknown[][] }[];
	resto: string[];
	marcas: [string, unknown][];
};

function fotografiar(storage: DurableObjectStorage): FotoDelObjeto {
	const sql = storage.sql;
	const esquema = sql
		.exec(
			`SELECT type, name, sql FROM sqlite_master
			  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			  ORDER BY rowid;`,
		)
		.toArray() as { type: string; name: string; sql: string }[];
	const tablas = esquema
		.filter((o) => o.type === "table")
		.map((t) => {
			const cursor = sql.exec(`SELECT * FROM "${t.name}";`);
			const columnas = [...cursor.columnNames];
			return { nombre: t.name, sql: t.sql, columnas, filas: [...cursor.raw()] };
		});
	return { tablas, resto: esquema.filter((o) => o.type !== "table").map((o) => o.sql), marcas: [...storage.kv.list()] };
}

/** Deja el objeto exactamente como `foto`: lo vacía entero y lo vuelve a llenar. */
async function ponerLaFoto(storage: DurableObjectStorage, foto: FotoDelObjeto): Promise<void> {
	await storage.deleteAll();
	const sql = storage.sql;
	storage.transactionSync(() => {
		// Una hija puede ir antes que su madre: las claves foráneas se miran al confirmar.
		sql.exec("PRAGMA defer_foreign_keys = ON;");
		for (const t of foto.tablas) {
			sql.exec(t.sql);
			const columnas = t.columnas.map((c) => `"${c}"`).join(", ");
			const huecos = t.columnas.map(() => "?").join(", ");
			for (const fila of t.filas) sql.exec(`INSERT INTO "${t.nombre}" (${columnas}) VALUES (${huecos});`, ...fila);
		}
		for (const s of foto.resto) sql.exec(s);
	});
	for (const [clave, valor] of foto.marcas) storage.kv.put(clave, valor);
}

/**
 * Una plataforma de mentira que vuelve de verdad, dentro del objeto (la de verdad no existe en local,
 * `instantes.ts`). Cada marcador es una foto de lo que guarda el objeto: sus tablas, con sus filas, y
 * sus marcas. `marcadorActual` saca una de cómo está; `marcadorDe`, para cualquier instante, da el
 * que diga `alPedirUnInstante`; y al reiniciar, el objeto se queda como la foto del marcador
 * preparado y vuelve a arrancar como al despertar (su constructor: quita la marca de la vuelta y se
 * pone al día con sus migraciones). Sin nada preparado, reiniciar sólo vuelve a arrancar.
 */
export async function conPlataformaQueVuelve(central: Pick<CentralDePrueba, "stub">) {
	const { BaseCentral } = await import("../../src/durableObjects/baseCentral");
	const fotos = new Map<string, FotoDelObjeto>();
	let siguiente = 0;
	const nuevoMarcador = () => `${(++siguiente).toString(16).padStart(8, "0")}-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b`;
	const fotoNueva = (storage: DurableObjectStorage) => {
		const marcador = nuevoMarcador();
		fotos.set(marcador, fotografiar(storage));
		return marcador;
	};
	const llamadas: string[] = [];
	let instante: string | null = null;
	let preparada: { marcador: string; deshacer: string } | null = null;

	await enElObjeto(central, (state, objeto) => {
		const instancia = objeto as { instantes: Instantes; averia: Promise<unknown>; env: Env };
		instancia.instantes = {
			marcadorActual: async () => (llamadas.push("actual"), fotoNueva(state.storage)),
			marcadorDe: async () => {
				llamadas.push("de");
				if (!instante) throw new Error("La prueba no ha dicho qué instante da la plataforma");
				return instante;
			},
			restaurarAlReiniciar: async (marcador) => {
				llamadas.push(`restaurar:${marcador}`);
				if (!fotos.has(marcador)) throw new Error("Ese marcador no es de este objeto");
				preparada = { marcador, deshacer: nuevoMarcador() };
				return preparada.deshacer;
			},
			reiniciar: () => {
				llamadas.push("reiniciar");
				const vuelta = preparada;
				preparada = null;
				const vuelto = state.blockConcurrencyWhile(async () => {
					if (!vuelta) return;
					// El marcador que devolvió la plataforma: cómo estaba justo antes de volver.
					fotos.set(vuelta.deshacer, fotografiar(state.storage));
					await ponerLaFoto(state.storage, fotos.get(vuelta.marcador)!);
				});
				instancia.averia = vuelto.then(
					() => (new BaseCentral(state, instancia.env) as unknown as { averia: Promise<unknown> }).averia,
				);
			},
		} satisfies Instantes;
	});
	return {
		llamadas,
		/** Una foto de cómo está el objeto ahora: su marcador. */
		fotografiar: () => enElObjeto(central, (state) => fotoNueva(state.storage)),
		/** El marcador que da la plataforma para cualquier instante que se le pida. */
		alPedirUnInstante: (marcador: string) => void (instante = marcador),
		/** Deja el objeto como la foto de `marcador`, por debajo: lo que pasó antes de la prueba. */
		ponerLaFoto: (marcador: string) => enElObjeto(central, (state) => ponerLaFoto(state.storage, fotos.get(marcador)!)),
		/**
		 * Reinicia el objeto por su cuenta, como un despliegue: vuelve a arrancar y, si había una vuelta
		 * pedida, vuelve. No pasa por `BaseCentral.reiniciar`, que sólo reinicia para aplicar la suya.
		 */
		reiniciar: () =>
			enElObjeto(central, (_state, objeto) => (objeto as { instantes: Instantes }).instantes.reiniciar("prueba")),
	};
}

/**
 * Cambia, dentro del objeto, el bucket de sus copias por lo que devuelva `sustituto` a partir del de
 * verdad: para que falle o tarde lo que haga falta. `state` es el del objeto, para mirar dentro
 * mientras tanto.
 */
export async function conCopiasDentro(
	central: Pick<CentralDePrueba, "stub">,
	sustituto: (real: R2Bucket, state: DurableObjectState) => unknown,
): Promise<void> {
	await enElObjeto(central, (state, objeto) => {
		const conEntorno = objeto as { env: Record<string, unknown> };
		conEntorno.env = { ...conEntorno.env, COPIAS: sustituto(conEntorno.env.COPIAS as R2Bucket, state) };
	});
}

/** Que las copias de la central fallen al subir, dentro del objeto, con «R2 no contesta». */
export function conR2Caido(central: Pick<CentralDePrueba, "stub">): Promise<void> {
	return conCopiasDentro(central, () => ({
		put: async () => {
			throw new Error("R2 no contesta");
		},
	}));
}

/**
 * Cuándo revienta una operación: tras ejecutar su sentencia número `n` (desde 1), cuyo texto es
 * `texto`. Lo que la sentencia escribió ya está en la transacción de la operación cuando revienta.
 */
export type CuandoFalla = (texto: string, n: number) => boolean;

/** La base de una operación, que revienta con `fallo_simulado` cuando diga `falla`. */
function conFallo(sql: SqlSync, falla: CuandoFalla): SqlSync {
	let n = 0;
	return {
		execute(sentencia) {
			const resultado = sql.execute(sentencia);
			n++;
			if (falla(typeof sentencia === "string" ? sentencia : sentencia.sql, n)) throw new Error("fallo_simulado");
			return resultado;
		},
	};
}

/**
 * Ejecuta la operación `nombre` dentro del objeto, como `BaseCentral.operar` (en su transacción, con
 * su base sin esperas), pero con un fallo dentro: la base revienta cuando diga `falla`. Lo que no es
 * la operación (las guardas del objeto, el RPC) no entra.
 */
export function operarConFallo<N extends keyof Operaciones>(
	central: Pick<CentralDePrueba, "stub">,
	nombre: N,
	datos: Parameters<Operaciones[N]>[1],
	falla: CuandoFalla,
): Promise<RespuestaDeLaCentral<ReturnType<Operaciones[N]>>> {
	const operacion: Operacion = OPERACIONES[nombre];
	return enElObjeto(central, (state) =>
		ejecutarOperacion(
			state.storage,
			{ [nombre]: (sql: SqlSync, d: never) => operacion(conFallo(sql, falla), d) },
			nombre,
			datos,
		),
	) as Promise<RespuestaDeLaCentral<ReturnType<Operaciones[N]>>>;
}

/**
 * Un negocio en la central, como lo deja su alta: su fila de `tenants`, una licencia activa y en
 * vigor de la que `main` es la Main, y sus `dispositivos`. Todo en una transacción, por debajo de las
 * guardas del objeto (como `filasDe`).
 */
export function negocioEnLaCentral(
	central: Pick<CentralDePrueba, "stub">,
	negocio: {
		tenantId: string;
		main: string;
		/** Por defecto, `lic-<tenantId>` y `hash-<tenantId>`: únicos en cada central. */
		licenseId?: string;
		licenseKeyHash?: string;
		dispositivos?: { deviceId: string; rol: "tpv" | "handy"; pubkeyB64?: string }[];
	},
): Promise<void> {
	const { tenantId, main, dispositivos = [] } = negocio;
	const licenseId = negocio.licenseId ?? `lic-${tenantId}`;
	const licenseKeyHash = negocio.licenseKeyHash ?? `hash-${tenantId}`;
	return enElObjeto(central, (state) =>
		state.storage.transactionSync(() => {
			const sql = state.storage.sql;
			sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, tenantId);
			sql.exec(
				`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
				                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
				                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, 'active', 0, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
				licenseId,
				licenseKeyHash,
				tenantId,
				main,
				Date.now() + 30 * 24 * 60 * 60 * 1000,
			);
			for (const d of dispositivos) {
				sql.exec(
					`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
					 VALUES (?, ?, ?, ?, 'ed25519');`,
					d.deviceId,
					tenantId,
					d.rol,
					d.pubkeyB64 ?? null,
				);
			}
		}),
	);
}

/** Cómo atiende `interceptar` una llamada a un método RPC: `llamar` la hace sobre el stub de verdad. */
export type Atender = (metodo: string, argumentos: unknown[], llamar: () => Promise<unknown>) => unknown;

/**
 * El stub `stub`, pero cada llamada a uno de sus métodos RPC pasa por `atender`, que puede dejarla
 * pasar (`llamar`), rodearla o cambiarla. No es «thenable»: un `await` sobre él no lo confunde con una
 * promesa.
 */
export function interceptar(stub: DurableObjectStub<BaseCentral>, atender: Atender): DurableObjectStub<BaseCentral> {
	return new Proxy(stub, {
		get(objetivo, nombre) {
			if (nombre === "then") return undefined;
			const valor = Reflect.get(objetivo, nombre);
			if (typeof valor !== "function" || typeof nombre !== "string") return valor;
			// Un método RPC se llama tal cual, sobre su stub: no admite `apply` ni `call`.
			const metodos = objetivo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
			return (...argumentos: unknown[]) => atender(nombre, argumentos, () => metodos[nombre](...argumentos));
		},
	});
}

/**
 * La central `central` vista a través de `interceptar`: cada llamada de su cliente (`db`) y de lo que
 * llegue por su `entorno` (una ruta, un TenantHub) pasa por `atender`, que puede dejarla pasar,
 * retenerla, cambiarla o hacerla fallar. Es donde va un fallo o un cruce que haya que provocar. El
 * `stub` sigue siendo el de verdad, para sembrar y mirar por debajo (`filasDe`).
 */
export function centralInterceptada(central: Pick<CentralDePrueba, "stub">, atender: Atender): CentralDePrueba {
	// Un stub nuevo en cada viaje, como el cliente de producción.
	const pedirStub = () => interceptar(env.BaseCentral.get(central.stub.id), atender);
	const espacio = { idFromName: () => central.stub.id, get: () => pedirStub() } as unknown as Env["BaseCentral"];
	return { db: clienteCentral(pedirStub), stub: central.stub, entorno: { BaseCentral: espacio } };
}

/**
 * Un `Atender` que se cambia a mitad de una prueba: deja pasar cada llamada hasta que `desviar` le da
 * otro, y vuelve a dejarlas pasar con `desviar(null)`. Es para una central que ya tienen puesta una
 * ruta o un TenantHub, y a la que hay que cambiarle lo que contesta sin volver a ponérsela:
 * `const { atender, desviar } = desvio(); centralInterceptada(central, atender)`.
 */
export function desvio(): { atender: Atender; desviar: (atender: Atender | null) => void } {
	let actual: Atender | null = null;
	return {
		atender: (metodo, argumentos, llamar) => (actual ? actual(metodo, argumentos, llamar) : llamar()),
		desviar: (atender) => void (actual = atender),
	};
}

/** El texto de una sentencia, con los espacios juntados: como se busca en lo que ha pedido una prueba. */
const textoDe = (s: SentenciaEnlazada) => s.sql.replace(/\s+/g, " ").trim();

/**
 * La central `central`, apuntando en `pedido` lo que le llega por su cliente y su `entorno`, en orden:
 * cada sentencia (también las de un lote) y, por cada operación, `operar <nombre>`. Después de apuntar,
 * la llamada sigue por `atender` (por defecto, a la central sin más).
 */
export function centralQueApunta(
	central: Pick<CentralDePrueba, "stub">,
	atender: Atender = (_metodo, _argumentos, llamar) => llamar(),
): CentralDePrueba & { pedido: string[] } {
	const pedido: string[] = [];
	const vista = centralInterceptada(central, (metodo, argumentos, llamar) => {
		if (metodo === "ejecutar") pedido.push(textoDe(argumentos[0] as SentenciaEnlazada));
		if (metodo === "lote") pedido.push(...(argumentos[0] as SentenciaEnlazada[]).map(textoDe));
		if (metodo === "operar") pedido.push(`operar ${String(argumentos[0])}`);
		return atender(metodo, argumentos, llamar);
	});
	return { ...vista, pedido };
}

/**
 * Una central con un solo dispositivo, `d1` del negocio `t1`, con el rol `rol` (`null`: sin fila;
 * `revocado`: con su fila, dado de baja). Es la de los vetos de rol: `consultas` apunta las
 * sentencias que le llegan por su cliente (`db`) o su `entorno`, con sus argumentos, y `contestar`
 * cambia el rol en lo que contesta (la base no admite más roles que `tpv` y `handy`, y quien lee la
 * fila no se puede fiar de ello).
 */
export async function centralConUnDispositivo(
	rol: "tpv" | "handy" | null,
	opciones: { revocado?: boolean; contestar?: string } = {},
): Promise<CentralDePrueba & { consultas: SentenciaEnlazada[] }> {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES ('t1');`);
	if (rol !== null) {
		await filasDe(
			central,
			`INSERT INTO devices (device_id, tenant_id, role, revoked_at_ms) VALUES ('d1', 't1', ?, ?);`,
			rol,
			opciones.revocado ? Date.now() : null,
		);
	}
	const { contestar } = opciones;
	const consultas: SentenciaEnlazada[] = [];
	const vista = centralInterceptada(central, async (metodo, argumentos, llamar) => {
		if (metodo !== "ejecutar") return llamar();
		consultas.push(argumentos[0] as SentenciaEnlazada);
		const respuesta = (await llamar()) as RespuestaDeLaCentral<FilasEnBruto>;
		if (contestar === undefined || !respuesta.ok) return respuesta;
		const i = respuesta.valor.columns.indexOf("role");
		if (i < 0) return respuesta;
		const rows = respuesta.valor.rows.map((fila) => fila.map((v, j) => (j === i ? contestar : v)));
		return { ...respuesta, valor: { ...respuesta.valor, rows } };
	});
	return { ...vista, consultas };
}

/**
 * La misma central, pero con un fallo dentro de sus operaciones: cada una revienta tras la primera
 * sentencia que case con `patron`, y no deja nada escrito. Las sentencias sueltas y los lotes van sin
 * fallo. Es su stub el que lo lleva, así que el cliente (`db`) y las rutas que llegan por `getDb`
 * (`entorno`) ven lo mismo que con la central de verdad: `ErrorDeLaCentral` con
 * `central_operacion_fallida`.
 */
export function conFalloEnLasOperaciones(central: CentralDePrueba, patron: RegExp): CentralDePrueba {
	return centralInterceptada(central, (metodo, [operacion, datos], llamar) =>
		metodo === "operar"
			? operarConFallo(central, operacion as keyof Operaciones, datos as never, (texto) => patron.test(texto))
			: llamar(),
	);
}
