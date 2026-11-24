// src/durableObjects/baseCentral.ts
//
// La base central (control-plane) en el SQLite de un Durable Object: un solo objeto para todo el
// servicio, que se pide sólo por `centralDe` (`lib/objetosDelNegocio.ts`) y al que se le habla con
// `clienteCentral` (`server/central/cliente.ts`). Esto es el adaptador RPC, como el del `TenantHub`
// (RI-45): lo que hace cada método vive en funciones de módulo, que no forman parte del prototipo.
//
// Lo que cuida, porque un objeto mal pedido o tocado a mano no falla en voz alta:
//
// - **Sin aprovisionar no atiende.** Un nombre o una jurisdicción equivocados dan otro objeto, vacío
//   y sin error; si creara su esquema solo, contestaría «no existe» a todas las licencias. Así que
//   el esquema sólo lo crea `aprovisionar` (administración), y hasta entonces todo lo demás contesta
//   `central_sin_aprovisionar` sin crear nada. Lo marca `_migrations`, que nace con la primera
//   migración.
// - **Al arrancar se pone al día** con sus migraciones (`server/central/migraciones.ts`), sin atender
//   nada mientras tanto. Si una ya aplicada ha cambiado, o una nueva no entra, no atiende y lo dice
//   en cada llamada (`central_migracion_alterada`, `central_migracion_fallida`).
// - **Al empezar cada llamada** reafirma las claves foráneas y los CHECK, y sólo ejecuta sentencias
//   de filas, una a una (`baseCentral.guardas.ts`), con los argumentos convertidos por su enlace
//   estricto (`server/central/enlace.ts`).
// - **Nunca llama a otro objeto** (un `TenantHub`, una `AgendaWeb`): lo que hay que avisar después de
//   escribir lo avisa quien llama (`test/centralOperaciones.node.test.ts`).
//
// Además de las sentencias y las operaciones, se copia a sí misma a R2 una vez al día
// (`baseCentral.copia.ts`).
//
// Lo que no ha hecho viaja como resultado (`baseCentral.rpc.ts`), también un error de SQL: lo lanza
// quien llama, en su lado (`server/central/cliente.ts`). Así el objeto no cuenta como fallo suyo una
// restricción que quien escribe espera y sabe tratar. Lo que lanza aquí es un fallo del programa.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { HubError } from "../lib/errorHttp";
import { capturarError } from "../observability/errors";
import { enlazar } from "../server/central/enlace";
import { MIGRACIONES_DE_LA_CENTRAL } from "../server/central/migraciones";
import { OPERACIONES } from "../server/central/operaciones/registro";
import type {
	EstadoDeLaCentral,
	FalloDeLaCentral,
	RespuestaDeLaCentral,
	SentenciaEnlazada,
} from "./baseCentral.rpc";
import { copiarLaCentral, type CopiaHecha } from "./baseCentral.copia";
import { motivoDeRechazo, reafirmarPragmas } from "./baseCentral.guardas";
import { ejecutarOperacion } from "./baseCentral.operar";
import { baseAprovisionada, ejecutarEnBruto, migrarBase, type FilasEnBruto } from "./sqliteDelObjeto";

export class BaseCentral extends DurableObject<Env> {
	// Por qué no atiende, si no atiende: una migración que no ha podido aplicar al arrancar o al
	// aprovisionarlo. Es de esta instancia (los campos de instancia no son visibles por RPC): cada
	// arranque lo vuelve a calcular.
	private averia: Promise<FalloDeLaCentral | null>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.averia = ctx.blockConcurrencyWhile(() => ponerAlDia(ctx.storage));
	}

	/** Una sentencia suelta. */
	async ejecutar(sentencia: SentenciaEnlazada): Promise<RespuestaDeLaCentral<FilasEnBruto>> {
		const { sql, args } = enlazar(sentencia);
		const motivo = motivoDeRechazo(sql);
		if (motivo) return { ok: false, error: "central_sentencia_prohibida", detalle: motivo };
		const fallo = await antesDeTocarLaBase(this.ctx.storage, this.averia);
		if (fallo) return fallo;
		return conErrorDeSql(() => ejecutarEnBruto(this.ctx.storage.sql, sql, args));
	}

	/** Varias sentencias, todo o nada: si una falla, no queda nada de las anteriores. */
	async lote(sentencias: SentenciaEnlazada[]): Promise<RespuestaDeLaCentral<FilasEnBruto[]>> {
		const enlazadas = sentencias.map(enlazar);
		for (const { sql } of enlazadas) {
			const motivo = motivoDeRechazo(sql);
			if (motivo) return { ok: false, error: "central_sentencia_prohibida", detalle: motivo };
		}
		const fallo = await antesDeTocarLaBase(this.ctx.storage, this.averia);
		if (fallo) return fallo;
		const storage = this.ctx.storage;
		return conErrorDeSql(() =>
			storage.transactionSync(() => enlazadas.map(({ sql, args }) => ejecutarEnBruto(storage.sql, sql, args))),
		);
	}

	/** Una operación (`server/central/operaciones/registro.ts`), entera en una transacción. */
	async operar(nombre: string, datos: unknown): Promise<RespuestaDeLaCentral<unknown>> {
		const fallo = await antesDeTocarLaBase(this.ctx.storage, this.averia);
		if (fallo) return fallo;
		return ejecutarOperacion(this.ctx.storage, OPERACIONES, nombre, datos);
	}

	/**
	 * La copia del día `dia` (AAAA-MM-DD) a R2 (`baseCentral.copia.ts`), la que pide el cron. Si no
	 * llega a subirla (R2, el techo, un día mal escrito), contesta `central_copia_fallida`: lo cuenta
	 * el cron, que es quien la ha pedido.
	 */
	async copiar(dia: string): Promise<RespuestaDeLaCentral<CopiaHecha>> {
		const fallo = await antesDeTocarLaBase(this.ctx.storage, this.averia);
		if (fallo) return fallo;
		try {
			return { ok: true, valor: await copiarLaCentral(this.ctx.storage.sql, this.env.COPIAS, dia) };
		} catch (error) {
			return { ok: false, error: "central_copia_fallida", detalle: String((error as Error)?.message ?? error) };
		}
	}

	/** Cómo está el objeto (administración). Sólo lee. */
	async estado(): Promise<EstadoDeLaCentral> {
		return estadoDe(this.ctx.storage.sql, await this.averia);
	}

	/**
	 * Crea el esquema de un objeto que no lo tiene: le aplica todas sus migraciones (administración).
	 * En uno que ya lo tiene no toca nada y contesta `central_ya_aprovisionada`.
	 *
	 * Cada migración entra en su propia transacción: si una falla detrás de otras que ya han entrado,
	 * la base queda aprovisionada a medias, y el objeto no atiende hasta que vuelva a arrancar y se
	 * ponga al día, igual que si hubiera arrancado así.
	 */
	async aprovisionar(): Promise<RespuestaDeLaCentral<EstadoDeLaCentral>> {
		const storage = this.ctx.storage;
		const fallo = await this.ctx.blockConcurrencyWhile(async (): Promise<FalloDeLaCentral | null> => {
			if (baseAprovisionada(storage.sql)) return { ok: false, error: "central_ya_aprovisionada" };
			const fallo = await migrar(storage);
			if (fallo && baseAprovisionada(storage.sql)) this.averia = Promise.resolve(fallo);
			return fallo;
		});
		if (fallo) return fallo;
		return { ok: true, valor: estadoDe(storage.sql, null) };
	}
}

/**
 * Lo que devuelven unas sentencias, o el error de SQLite con el que han fallado. Lo recibe quien las
 * mandó, que lo lanza en su lado (`server/central/cliente.ts`): para el objeto no es un fallo suyo.
 */
function conErrorDeSql<T>(ejecutar: () => T): RespuestaDeLaCentral<T> {
	try {
		return { ok: true, valor: ejecutar() };
	} catch (error) {
		return { ok: false, error: "central_error_sql", detalle: String((error as Error)?.message ?? error) };
	}
}

/**
 * Aplica las migraciones de la central. Quien llama lo hace dentro de `blockConcurrencyWhile`: el
 * runner apaga las claves foráneas alrededor de la tanda, y nada más puede correr entretanto. Si no
 * puede, devuelve por qué, y el objeto no atiende.
 */
async function migrar(storage: DurableObjectStorage): Promise<FalloDeLaCentral | null> {
	try {
		await migrarBase(storage, MIGRACIONES_DE_LA_CENTRAL);
		return null;
	} catch (error) {
		capturarError(error, "central.migracion");
		const detalle = String((error as Error)?.message ?? error);
		if (error instanceof HubError && error.code === "migration_altered") {
			return { ok: false, error: "central_migracion_alterada", detalle };
		}
		return { ok: false, error: "central_migracion_fallida", detalle };
	}
}

/** Al arrancar: una base aprovisionada se pone al día. Una sin aprovisionar se queda como está. */
function ponerAlDia(storage: DurableObjectStorage): Promise<FalloDeLaCentral | null> {
	return baseAprovisionada(storage.sql) ? migrar(storage) : Promise.resolve(null);
}

/**
 * Lo que se mira al empezar cada llamada que toca la base: que no esté averiado, que la conexión
 * esté como debe y que el objeto esté aprovisionado. Lo de la conexión va antes porque puede tener
 * que esperar (`reafirmarPragmas`), y nada de lo que decide se lee antes de esa espera: de aquí a
 * ejecutar no hay ninguna más.
 */
async function antesDeTocarLaBase(
	storage: DurableObjectStorage,
	averiado: Promise<FalloDeLaCentral | null>,
): Promise<FalloDeLaCentral | null> {
	const averia = await averiado;
	if (averia) return averia;
	await reafirmarPragmas(storage);
	if (!baseAprovisionada(storage.sql)) return { ok: false, error: "central_sin_aprovisionar" };
	return null;
}

function estadoDe(sql: SqlStorage, averia: FalloDeLaCentral | null): EstadoDeLaCentral {
	const aprovisionada = baseAprovisionada(sql);
	const migraciones = aprovisionada
		? sql
				.exec("SELECT name, hash, applied_at FROM _migrations ORDER BY name;")
				.toArray()
				.map((r: any) => ({ nombre: String(r.name), hash: String(r.hash), aplicadaMs: Number(r.applied_at) }))
		: [];
	return { aprovisionada, migraciones, averia };
}
