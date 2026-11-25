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
//   el esquema sólo lo crea `aprovisionar` (administración), vacío o desde una copia, y hasta
//   entonces todo lo demás contesta `central_sin_aprovisionar` sin crear nada. Lo marca
//   `_migrations`, que nace con la primera migración.
// - **Con algo a medias no atiende**: una restauración desde una copia que no terminó, o una vuelta a
//   un instante preparada y sin aplicar. Lo dicen sus marcas, y es lo primero que se mira
//   (`baseCentral.guardas.ts`).
// - **Al arrancar se pone al día** con sus migraciones (`server/central/migraciones.ts`), sin atender
//   nada mientras tanto. Si una ya aplicada ha cambiado, o una nueva no entra, no atiende y lo dice
//   en cada llamada (`central_migracion_alterada`, `central_migracion_fallida`).
// - **Al empezar cada llamada** reafirma las claves foráneas y los CHECK, y sólo ejecuta sentencias
//   de filas, una a una (`baseCentral.guardas.ts`), con los argumentos convertidos por su enlace
//   estricto (`server/central/enlace.ts`).
// - **Nunca llama a otro objeto** (un `TenantHub`, una `AgendaWeb`): lo que hay que avisar después de
//   escribir lo avisa quien llama (`test/centralOperaciones.node.test.ts`).
//
// Además de las sentencias y las operaciones: se copia a sí misma a R2 (`baseCentral.copia.ts`), se
// restaura desde una copia (`baseCentral.restaurar.ts`) y vuelve a un instante
// (`baseCentral.instante.ts`). Lo pide la administración (`domains/admin/central.ts`), y la copia del
// día, el cron.
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
	CentralAprovisionada,
	CopiaRestaurada,
	DestinoDeLaVuelta,
	EstadoDeLaCentral,
	FalloDeLaCentral,
	RespuestaDeLaCentral,
	SentenciaEnlazada,
	VueltaPreparada,
} from "./baseCentral.rpc";
import {
	claveConHora,
	claveDelDia,
	COPIA_A_MANO,
	copiarLaCentral,
	esTablaDeLaCopia,
	type CopiaHecha,
} from "./baseCentral.copia";
import {
	CLAVE_VUELTA_EN_CURSO,
	falloPorLasMarcas,
	marcasDe,
	motivoDeRechazo,
	reafirmarPragmas,
} from "./baseCentral.guardas";
import { prepararVueltaDeLaCentral, reiniciarParaAplicar } from "./baseCentral.instante";
import { ejecutarOperacion } from "./baseCentral.operar";
import { restaurarLaCentral } from "./baseCentral.restaurar";
import { instantesDe, type Instantes } from "./instantes";
import { baseAprovisionada, ejecutarEnBruto, migrarBase, type FilasEnBruto } from "./sqliteDelObjeto";
import { identificador } from "./volcadoSql";

export class BaseCentral extends DurableObject<Env> {
	// Por qué no atiende, si no atiende: una migración que no ha podido aplicar al arrancar o al
	// aprovisionarlo. Es de esta instancia (los campos de instancia no son visibles por RPC): cada
	// arranque lo vuelve a calcular.
	private averia: Promise<FalloDeLaCentral | null>;
	// La vuelta a un instante, detrás de algo que un test puede sustituir (en local no existe).
	private instantes: Instantes;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.instantes = instantesDe(ctx);
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
	 * Una copia a R2 (`baseCentral.copia.ts`): la del día `cual` (AAAA-MM-DD), la que pide el cron, o
	 * con `COPIA_A_MANO`, una con la hora en el nombre, que no pisa la del día (administración). Si no
	 * llega a subirla (R2, el techo, un día mal escrito), contesta `central_copia_fallida`: lo cuenta
	 * quien la ha pedido.
	 */
	async copiar(cual: string): Promise<RespuestaDeLaCentral<CopiaHecha>> {
		const fallo = await antesDeTocarLaBase(this.ctx.storage, this.averia);
		if (fallo) return fallo;
		try {
			const clave = cual === COPIA_A_MANO ? claveConHora("a-mano", new Date()) : claveDelDia(cual);
			return { ok: true, valor: await copiarLaCentral(this.ctx.storage.sql, this.env.COPIAS, clave) };
		} catch (error) {
			return { ok: false, error: "central_copia_fallida", detalle: String((error as Error)?.message ?? error) };
		}
	}

	/** Cómo está el objeto (administración). Sólo lee. */
	async estado(): Promise<EstadoDeLaCentral> {
		return estadoDe(this.ctx.storage, await this.averia);
	}

	/**
	 * Crea el esquema de un objeto que no lo tiene (administración): vacío, con todas sus migraciones,
	 * o con `claveDeCopia`, restaurado desde esa copia de R2 (`baseCentral.restaurar.ts`). En uno que
	 * ya lo tiene no toca nada y contesta `central_ya_aprovisionada`. Con una restauración a medias,
	 * sólo otra restauración lo vacía y termina: vacío no se aprovisiona. Con una vuelta a un instante
	 * en curso, nada (`central_vuelta_en_curso`): restaurar empieza vaciando el objeto, marca incluida,
	 * y la central atendería con una vuelta pedida a la plataforma.
	 *
	 * Sin copia, cada migración entra en su propia transacción: si una falla detrás de otras que ya han
	 * entrado, la base queda aprovisionada a medias, y el objeto no atiende hasta que vuelva a arrancar
	 * y se ponga al día, igual que si hubiera arrancado así.
	 */
	async aprovisionar(opciones: { claveDeCopia?: string } = {}): Promise<RespuestaDeLaCentral<CentralAprovisionada>> {
		const storage = this.ctx.storage;
		const { claveDeCopia } = opciones;
		const hecho = await this.ctx.blockConcurrencyWhile(async (): Promise<RespuestaDeLaCentral<CopiaRestaurada | null>> => {
			const marcas = marcasDe(storage);
			if (marcas.vuelta) return falloPorLasMarcas({ restauracion: null, vuelta: marcas.vuelta })!;
			if (claveDeCopia !== undefined) return restaurarLaCentral(storage, this.env.COPIAS, claveDeCopia);
			if (marcas.restauracion) return falloPorLasMarcas(marcas)!;
			if (baseAprovisionada(storage.sql)) return { ok: false, error: "central_ya_aprovisionada" };
			const fallo = await migrar(storage);
			if (fallo && baseAprovisionada(storage.sql)) this.averia = Promise.resolve(fallo);
			return fallo ?? { ok: true, valor: null };
		});
		if (!hecho.ok) return hecho;
		return { ok: true, valor: { ...estadoDe(storage, await this.averia), copia: hecho.valor } };
	}

	/**
	 * La primera mitad de la vuelta a un instante, o a un marcador (`baseCentral.instante.ts`), esté
	 * como esté la central: deja una copia de cómo está (si se puede copiar), la vuelta preparada para
	 * el siguiente arranque y la central cerrada hasta entonces. Contesta el marcador con el que se
	 * deshace.
	 */
	async prepararVuelta(destino: DestinoDeLaVuelta): Promise<RespuestaDeLaCentral<VueltaPreparada>> {
		return prepararVueltaDeLaCentral(this.ctx.storage, this.env.COPIAS, this.instantes, this.averia, destino);
	}

	/**
	 * Reinicia el objeto, que al arrancar vuelve al instante preparado, sólo si la vuelta preparada es
	 * la que se deshace con `deshacer` (`baseCentral.instante.ts`): si lo reinicia, lanza en quien lo
	 * llama. Con otra vuelta en curso contesta `central_vuelta_a_la_vez`, y sin ninguna,
	 * `central_sin_vuelta_preparada`, sin reiniciar.
	 */
	reiniciar(deshacer: string): RespuestaDeLaCentral<null> {
		return reiniciarParaAplicar(this.ctx.storage, this.instantes, deshacer);
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

/**
 * Al arrancar: una base aprovisionada se pone al día. Una sin aprovisionar se queda como está.
 *
 * - Una restauración a medias no se pone al día: sus filas no están enteras, y no atiende hasta que
 *   otra restauración la vacíe y termine (`antesDeTocarLaBase`).
 * - La marca de una vuelta a un instante se quita: la vuelta preparada se aplica al arrancar, sea
 *   cual sea la causa del reinicio, y lo que quede de su marca es de antes (al deshacer una vuelta, el
 *   marcador de deshacer la lleva puesta). Ver `baseCentral.instante.ts`.
 */
function ponerAlDia(storage: DurableObjectStorage): Promise<FalloDeLaCentral | null> {
	const marcas = marcasDe(storage);
	if (marcas.vuelta) storage.kv.delete(CLAVE_VUELTA_EN_CURSO);
	if (marcas.restauracion) return Promise.resolve(null);
	return baseAprovisionada(storage.sql) ? migrar(storage) : Promise.resolve(null);
}

/**
 * Lo que se mira al empezar cada llamada que toca la base, una vez el objeto ha arrancado
 * (`averiado`): que no tenga nada a medias, que no esté averiado, que la conexión esté como debe y
 * que el objeto esté aprovisionado. Lo de la conexión va antes que lo último porque puede tener que
 * esperar (`reafirmarPragmas`), y nada de lo que decide se lee antes de esa espera: de aquí a
 * ejecutar no hay ninguna más.
 */
async function antesDeTocarLaBase(
	storage: DurableObjectStorage,
	averiado: Promise<FalloDeLaCentral | null>,
): Promise<FalloDeLaCentral | null> {
	const averia = await averiado;
	const aMedias = falloPorLasMarcas(marcasDe(storage));
	if (aMedias) return aMedias;
	if (averia) return averia;
	await reafirmarPragmas(storage);
	if (!baseAprovisionada(storage.sql)) return { ok: false, error: "central_sin_aprovisionar" };
	return null;
}

/**
 * Cómo está el objeto. Con algo a medias no se mira nada más: ni sus migraciones ni sus filas, que
 * pueden estar a medio cargar.
 */
function estadoDe(storage: DurableObjectStorage, averia: FalloDeLaCentral | null): EstadoDeLaCentral {
	const sql = storage.sql;
	const enCurso = marcasDe(storage);
	const bytes = sql.databaseSize;
	const aMedias = falloPorLasMarcas(enCurso);
	if (aMedias) {
		// Una restauración la aprovisiona al terminar; una vuelta se prepara también sin esquema.
		const aprovisionada = enCurso.restauracion === null && baseAprovisionada(sql);
		return { aprovisionada, migraciones: [], averia: aMedias, enCurso, filas: {}, bytes };
	}
	const aprovisionada = baseAprovisionada(sql);
	if (!aprovisionada) return { aprovisionada, migraciones: [], averia, enCurso, filas: {}, bytes };
	const migraciones = sql
		.exec("SELECT name, hash, applied_at FROM _migrations ORDER BY name;")
		.toArray()
		.map((r: any) => ({ nombre: String(r.name), hash: String(r.hash), aplicadaMs: Number(r.applied_at) }));
	const tablas = sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;")
		.toArray()
		.map((r) => String(r.name))
		.filter(esTablaDeLaCopia);
	const filas = Object.fromEntries(
		tablas.map((t) => [t, Number(sql.exec(`SELECT COUNT(*) AS n FROM ${identificador(t)};`).one().n)]),
	);
	return { aprovisionada, migraciones, averia, enCurso, filas, bytes };
}
