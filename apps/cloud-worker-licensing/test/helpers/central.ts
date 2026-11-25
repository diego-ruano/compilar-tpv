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
import { CLAVE_VUELTA_EN_CURSO } from "../../src/durableObjects/baseCentral.guardas";
import type { RespuestaDeLaCentral, SentenciaEnlazada } from "../../src/durableObjects/baseCentral.rpc";
import { ejecutarOperacion } from "../../src/durableObjects/baseCentral.operar";
import type { FilasEnBruto } from "../../src/durableObjects/sqliteDelObjeto";
import type { Env } from "../../src/env";
import type { SqlSync } from "../../src/lib/sql";
import { clienteCentral, ErrorDeLaCentral, type ClienteCentral } from "../../src/server/central/cliente";
import { OPERACIONES, type Operacion, type Operaciones } from "../../src/server/central/operaciones/registro";

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
 * Los marcadores que contesta el doble de la plataforma, con la forma de los de Cloudflare
 * (`esMarcador`): el del instante al que se vuelve, el de ahora y el que devuelve la plataforma al
 * dejar preparada la vuelta.
 */
export const MARCADORES = {
	destino: "0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b",
	actual: "0000007c-00000000-00001539-1d4f98cc48c4ec6dd63ffec04de4ca7c",
	deshacer: "0000007c-ffffffff-0000153a-2e50a9dd59d5fd7ee740ffd15ef5db8d",
} as const;

/**
 * El doble de la vuelta a un instante (`Instantes`, que en local no existe), dentro del objeto. Apunta
 * en `llamadas` lo que le piden. Al «reiniciar», el objeto queda como diga `alReiniciar`: por omisión,
 * vuelto y sin la marca de la vuelta (de después del instante, o quitada al arrancar). Con
 * `alRestaurar`, dejar preparada la vuelta espera a lo que devuelva (para retenerla a mitad).
 */
export async function conDobleDeInstantes(
	central: Pick<CentralDePrueba, "stub">,
	llamadas: string[],
	opciones: {
		alReiniciar?: (state: DurableObjectState) => void;
		alRestaurar?: (marcador: string) => Promise<void> | void;
	} = {},
): Promise<void> {
	const { alReiniciar = vuelto, alRestaurar } = opciones;
	await enElObjeto(central, (state, objeto) => {
		(objeto as { instantes: unknown }).instantes = {
			marcadorActual: async () => (llamadas.push("actual"), MARCADORES.actual),
			marcadorDe: async (ms: number) => (llamadas.push(`de:${typeof ms}`), MARCADORES.destino),
			restaurarAlReiniciar: async (m: string) => {
				llamadas.push(`restaurar:${m}`);
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
