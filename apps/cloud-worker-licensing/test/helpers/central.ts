// test/helpers/central.ts
//
// Una base central de verdad para un test: un objeto `BaseCentral` propio y el cliente con el que le
// habla el worker (`clienteCentral`). El objeto de producción se pide siempre con el mismo nombre
// (`centralDe`); aquí cada test lo pide con el suyo, así que uno sin nombre recibe una base nueva y
// vacía, y dos que compartan nombre comparten base.
//
// Las rutas llegan a ella como en producción, por `getDb(env)`, si su `env` lleva el `entorno` de la
// central. Lo que el test siembra o comprueba por debajo va directo al SQLite del objeto
// (`filasDe`, `fotoDeLaCentral`), sin pasar por sus guardas.

import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import type { BaseCentral } from "../../src/durableObjects/baseCentral";
import { CLAVE_VUELTA_EN_CURSO } from "../../src/durableObjects/baseCentral.guardas";
import type { RespuestaDeLaCentral } from "../../src/durableObjects/baseCentral.rpc";
import { ejecutarOperacion } from "../../src/durableObjects/baseCentral.operar";
import type { Env } from "../../src/env";
import type { SqlSync } from "../../src/lib/sql";
import { clienteCentral, ErrorDeLaCentral, type ClienteCentral } from "../../src/server/central/cliente";
import { OPERACIONES, type Operacion, type Operaciones } from "../../src/server/central/operaciones/registro";

export type CentralDePrueba = {
	db: ClienteCentral;
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
 * Las filas de una sentencia ejecutada directamente en el SQLite del objeto, por fuera de sus guardas
 * y de su cliente: para sembrar lo que una prueba necesita y comprobar lo que ha quedado.
 */
export function filasDe(
	central: Pick<CentralDePrueba, "stub">,
	texto: string,
	...args: unknown[]
): Promise<Record<string, any>[]> {
	return runInDurableObject(central.stub, (_objeto, state) => state.storage.sql.exec(texto, ...args).toArray());
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
	return runInDurableObject(central.stub, (_objeto, state) => {
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
 * El doble de la vuelta a un instante (`Instantes`, que en local no existe), dentro del objeto. Apunta
 * en `llamadas` lo que le piden. Al «reiniciar», el objeto queda como diga `alReiniciar`: por omisión,
 * vuelto y sin la marca de la vuelta (de después del instante, o quitada al arrancar).
 */
export async function conDobleDeInstantes(
	central: Pick<CentralDePrueba, "stub">,
	llamadas: string[],
	opciones: { alReiniciar?: (state: DurableObjectState) => void } = {},
): Promise<void> {
	const { alReiniciar = vuelto } = opciones;
	await runInDurableObject(central.stub, (objeto, state) => {
		(objeto as unknown as { instantes: unknown }).instantes = {
			marcadorActual: async () => (llamadas.push("actual"), "m-actual"),
			marcadorDe: async (ms: number) => (llamadas.push(`de:${typeof ms}`), "m-destino"),
			restaurarAlReiniciar: async (m: string) => (llamadas.push(`restaurar:${m}`), "m-deshacer"),
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
	await runInDurableObject(central.stub, (objeto, state) => {
		const conEntorno = objeto as unknown as { env: Record<string, unknown> };
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
	return runInDurableObject(central.stub, (_objeto, state) =>
		ejecutarOperacion(
			state.storage,
			{ [nombre]: (sql: SqlSync, d: never) => operacion(conFallo(sql, falla), d) },
			nombre,
			datos,
		),
	) as Promise<RespuestaDeLaCentral<ReturnType<Operaciones[N]>>>;
}

/** Cómo atiende `interceptar` una llamada a un método RPC: `llamar` la hace sobre el stub de verdad. */
type Atender = (metodo: string, argumentos: unknown[], llamar: () => Promise<unknown>) => unknown;

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
 * La misma central, pero con un fallo dentro de sus operaciones: cada una revienta tras la primera
 * sentencia que case con `patron`, y no deja nada escrito. Las sentencias sueltas y los lotes van sin
 * fallo. Es su stub el que lo lleva, así que el cliente (`db`) y las rutas que llegan por `getDb`
 * (`entorno`) ven lo mismo que con la central de verdad: `ErrorDeLaCentral` con
 * `central_operacion_fallida`.
 */
export function conFalloEnLasOperaciones(
	central: CentralDePrueba,
	patron: RegExp,
): Pick<CentralDePrueba, "db" | "entorno"> {
	const stub = interceptar(central.stub, (metodo, [operacion, datos], llamar) =>
		metodo === "operar"
			? operarConFallo(central, operacion as keyof Operaciones, datos as never, (texto) => patron.test(texto))
			: llamar(),
	);
	const espacio = { idFromName: () => central.stub.id, get: () => stub } as unknown as Env["BaseCentral"];
	return { db: clienteCentral(() => stub), entorno: { BaseCentral: espacio } };
}
