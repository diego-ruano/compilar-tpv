// src/durableObjects/tenantHub.turno.ts
//
// AUD-18 · La escritura en curso del turno del log.
//
// El DO confirma en Turso y difunde de una escritura en una (`MotorTenantHub.enTurnoDelLog`), así
// que la difusión sale en orden de `Seq` y la Main, que aplica en ese orden, nunca recibe un cambio
// antes que otro anterior. Lo que podía romperlo es una confirmación INCIERTA: un batch que salió
// hacia Turso y del que no se sabe si se confirmó (se cortó el transporte después de enviarlo,
// venció el plazo de `fetchConPlazo`, la respuesta no se deja leer, o el DO se apagó entre medias).
// Si se confirmó, tiene un `Seq` que nadie ha difundido, y lo siguiente que se difundiera llevaría
// a la Main por encima de él para siempre.
//
// Por eso cada escritura suelta se anota en el SQLite del propio DO ANTES de mandarla
// (`_Escritura_En_Curso`; la compuerta de salida del DO no deja salir la petición hasta que la nota
// es durable) y se borra al saber cómo acabó. Una nota que sigue ahí es una escritura que no se
// sabe si entró, y el turno siguiente la resuelve PRIMERO: la vuelve a mandar igual, por su
// `Op_Id`, que es idempotente porque el registro de idempotencia (`Applied_Operations`) y el log
// (`Sync_Changes`) van en el mismo batch atómico. Sólo una respuesta de la base la resuelve: si ya
// estaba confirmada, el reenvío choca con su `Op_Id` y se difunde la suya; si no, se confirma ahora
// y la original, si llega tarde, es la que choca. Nunca hay dos `Seq` para la misma operación.
//
// Abortar una petición no impide que Turso la confirme después, así que el tiempo no resuelve
// nada: mientras no haya respuesta, no se confirma ni se difunde nada posterior del negocio (es
// como si Turso estuviera caído para él), las Main se desconectan para ponerse al día por el
// catch-up y el reenvío se repite, con una espera cada vez mayor, en los turnos siguientes.
//
// Si el reenvío lo rechaza la propia base (una restricción, una tabla que no existe), repetirlo no
// cambiaría nada, pero la original podría seguir en vuelo y entrar más tarde, cuando otra escritura
// hubiera cambiado lo que la hacía fallar. Para darla por no aplicada se VETA su `Op_Id`
// (`vetarOperacion`): queda en `Applied_Operations` como `FAILED`, y cualquier copia que llegue
// después choca con él. El veto es la respuesta definitiva: si entra, la operación no se aplicó ni
// se aplicará; si choca, es que ya estaba aplicada, y se difunde.
//
// El lote de la cola (SYNC-18) no necesita nota: sus operaciones siguen en `_Cola_Entrada` hasta
// que se aplican, la cola no vacía congela todo lo demás, y el siguiente drenado las repite por
// `Op_Id` y difunde las que ya estaban confirmadas. Antes de apartar una, se veta igual.
//
// El gate y el veto sólo cierran el paso mientras su fila existe. La purga de `Applied_Operations`
// (`MotorTenantHub.maybePurgeSyncLog`) no puede retirarla mientras una copia de su operación
// pueda llegar todavía: ver `VIDA_MAXIMA_DE_UN_ENVIO_MS` y `anotarEnvioSinRespuesta`.
//
// ⚠️ Funciones libres y sin estado (SYNC-16): lo que hay que recordar está en la tabla.

import type { Client } from "@libsql/client/web";

import { safeJsonParse, stableStringify, stringifyJsonValue } from "./tenantHub.envelope";
import { esFalloPasajero, isTursoAuthError, rechazoDeterminista } from "./tenantHub.errores";
import { buildApplyBatch } from "./tenantHub.lote";
import { isUniqueOpIdViolation } from "./tenantHub.sentencias";
import { nowMs } from "./tenantHub.tiempo";
import type { InternalApplyCommand, ResolvedStmt } from "./tenantHub.types";

/** Techo de la espera entre reenvíos de una escritura en duda. */
const ESPERA_MAXIMA_MS = 60_000;

/**
 * AUD-18 · El supuesto, muy conservador: **ninguna petición a Turso sigue en vuelo un día después de
 * enviarse.** El cliente la aborta a los 15 s (`PLAZO_TURSO_MS`) y ni Turso ni nada de por medio
 * mantiene viva una petición HTTP tanto tiempo; pero abortarla no prueba que no se ejecute. Lo que
 * le cierra el paso a una copia tardía —el gate de idempotencia de `Applied_Operations` o el veto
 * de su `Op_Id`— tiene que seguir ahí al menos este tiempo después del último envío que pudo
 * quedarse sin respuesta: la purga no corre antes (`anotarEnvioSinRespuesta`).
 */
export const VIDA_MAXIMA_DE_UN_ENVIO_MS = 24 * 60 * 60 * 1000;

function asegurarEnvios(storage: DurableObjectState["storage"]): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS _Envio_Sin_Respuesta (
			Id INTEGER PRIMARY KEY CHECK (Id = 1),
			Ultimo_Ms INTEGER NOT NULL
		);
	`);
}

/**
 * AUD-18 · Ha salido hacia Turso algo cuya respuesta no se sabe, o puede no llegar a saberse (el DO
 * puede apagarse con ello en vuelo). Hasta `VIDA_MAXIMA_DE_UN_ENVIO_MS` después, la purga no toca
 * `Applied_Operations`. Se anota: cada turno que encuentra una escritura en duda, cada reenvío sin
 * respuesta y cada lote de la cola antes de mandarlo.
 */
export function anotarEnvioSinRespuesta(storage: DurableObjectState["storage"]): void {
	asegurarEnvios(storage);
	storage.sql.exec(
		`INSERT INTO _Envio_Sin_Respuesta (Id, Ultimo_Ms) VALUES (1, ?)
		 ON CONFLICT(Id) DO UPDATE SET Ultimo_Ms = MAX(Ultimo_Ms, excluded.Ultimo_Ms);`,
		nowMs(),
	);
}

/** AUD-18 · Cuándo salió el último envío sin respuesta (`anotarEnvioSinRespuesta`); 0 si ninguno. */
export function ultimoEnvioSinRespuesta(storage: DurableObjectState["storage"]): number {
	asegurarEnvios(storage);
	const fila = storage.sql
		.exec("SELECT Ultimo_Ms FROM _Envio_Sin_Respuesta WHERE Id = 1;")
		.toArray()[0] as any;
	return Number(fila?.Ultimo_Ms ?? 0);
}

/**
 * Cuánto se espera, desde el último envío, antes de volver a mandar una escritura en duda: nada
 * tras el original (se repite en el acto), y luego 1, 2, 4… s hasta un minuto. Mientras tanto no
 * entra nada posterior; esperar sólo evita martillear a una base que no contesta.
 */
export function esperaDeReenvio(envios: number): number {
	if (envios <= 1) return 0;
	return Math.min(ESPERA_MAXIMA_MS, 1000 * 2 ** Math.min(envios - 2, 16));
}

/** Una escritura tal como se manda a Turso: lo justo para repetirla igual. */
export type EscrituraPreparada = {
	opId: string;
	commandName: string;
	/** Con la hora ya fijada (`rewriteCmdNowLiterals`): repetirla no la cambia. */
	cmd: InternalApplyCommand;
	deviceId: string | null;
	requestHash: string;
	cloudPayloadJson: string;
};

type CambioConfirmado = {
	command: string;
	opId: string;
	deviceId: string | null;
	payloadJson: string;
	result: any;
	seq: number;
	statements: ResolvedStmt[];
};

/** Lo que el turno necesita del hub. */
export interface ContextoDeTurno {
	readonly storage: DurableObjectState["storage"];
	/** `broadcastChange`, con el originador excluido. */
	difundir(cambio: CambioConfirmado): void;
	/** Cierra los sockets de las Main, pasando por `sessionGone`. */
	cerrarSocketsDeLaMain(): void;
	emitSyncEvent(name: string, fields: Record<string, unknown>): void;
}

/** Cómo acabó la escritura anotada. */
export type Resolucion =
	| { opId: string; confirmada: true; seq: number; result: any }
	| { opId: string; confirmada: false; error: unknown };

/**
 * No se sabe si una escritura anterior se confirmó. Hasta que se sepa no entra nada posterior del
 * negocio; quien escribía lo vuelve a intentar (es un fallo pasajero: `escritura_en_duda`).
 */
export class EscrituraEnDuda extends Error {
	constructor(causa: unknown) {
		super(
			`escritura_en_duda: una escritura anterior no se sabe si se confirmó (${String((causa as any)?.message ?? causa).slice(0, 200)})`,
		);
		this.name = "EscrituraEnDuda";
	}
}

export function esEscrituraEnDuda(e: unknown): boolean {
	return e instanceof EscrituraEnDuda || String((e as any)?.message ?? "").startsWith("escritura_en_duda");
}

/**
 * ¿Puede haberse confirmado este batch sin que lo sepamos? Todo lo que no sea saber que no:
 * ni la repetición de una ya aplicada, ni un rechazo de credenciales (no llegó a ejecutarse), ni
 * un rechazo de la base que se repetiría igual (`rechazoDeterminista`). Es la pregunta para el
 * PRIMER envío de una operación: no hay otro en vuelo, así que si éste no entró, no entró.
 */
export function confirmacionIncierta(e: unknown): boolean {
	return !isUniqueOpIdViolation(e) && !isTursoAuthError(e) && !rechazoDeterminista(e);
}

// ---- Lo que la base dice de una operación ---------------------------------------------------

/** Una operación vetada queda en `Applied_Operations` con este estado. */
export const VETADA = "FAILED";

const SIN_MOTIVO = "rechazada en la nube sin aplicarse";

/** Lo que recibe quien reintenta una operación vetada: el rechazo que la vetó. */
export function rechazoDeVetada(motivo: string): Error {
	return new Error(motivo || SIN_MOTIVO);
}

/** Lo que la base tiene de una operación, por su `Op_Id`. */
export type EstadoDeOperacion =
	| { estado: "aplicada"; seq: number; statements: ResolvedStmt[]; result: any }
	| { estado: "vetada"; error: string };

/** Lo que se le guarda a una vetada como motivo, y lo que recibe quien la reintente. */
function motivoDelVeto(error: unknown): string {
	const texto = String((error as any)?.message ?? error ?? "").slice(0, 500);
	// Un texto de fallo pasajero haría que quien la reintente lo siga intentando sin gastar intentos.
	return !texto || esFalloPasajero(texto) ? SIN_MOTIVO : texto;
}

/**
 * Lo que la base tiene de una operación: aplicada (con su `Seq`, sus sentencias y el resultado que
 * se guardó con ella), vetada, o `null` si no está. Un error de lectura sale tal cual: no es un
 * «no está». Una aplicada sin línea en el log (`seq` 0) es una cuyo log ya se purgó (SYNC-12).
 */
export async function leerOperacion(db: Client, opId: string): Promise<EstadoDeOperacion | null> {
	const r = await db.execute({
		sql: `SELECT a.Status AS status, a.Error_Text AS error_text, a.Result_Json AS result_json,
		             c.Seq AS seq, c.Statements_Json AS statements_json
		        FROM Applied_Operations a LEFT JOIN Sync_Changes c ON c.Op_Id = a.Op_Id
		       WHERE a.Op_Id = ?1
		       ORDER BY c.Seq DESC LIMIT 1;`,
		args: [opId],
	});
	const fila = r.rows?.[0] as any;
	if (!fila) return null;
	if (String(fila.status ?? "") === VETADA) {
		return { estado: "vetada", error: String(fila.error_text ?? "") || SIN_MOTIVO };
	}
	const statements = safeJsonParse(String(fila.statements_json ?? "[]"));
	return {
		estado: "aplicada",
		seq: Number(fila.seq ?? 0),
		statements: Array.isArray(statements) ? statements : [],
		result: safeJsonParse(String(fila.result_json ?? "null")),
	};
}

/**
 * Veta una operación que no se ha aplicado: su `Op_Id` entra en `Applied_Operations` como
 * `FAILED`, y cualquier copia suya que siguiera en vuelo choca con él y no se confirma. Es una sola
 * sentencia, así que la respuesta es definitiva: si entra, la operación no se aplicó ni se
 * aplicará; si choca con su `Op_Id`, se devuelve lo que ya había (aplicada, o vetada de antes).
 *
 * Cualquier otro error sale tal cual: el veto puede haber entrado o no, y quien llama lo deja en
 * duda. Repetirlo es inocuo.
 */
export async function vetarOperacion(
	db: Client,
	op: { opId: string; commandName: string; requestHash: string; deviceId: string | null },
	error: unknown,
): Promise<EstadoDeOperacion> {
	const motivo = motivoDelVeto(error);
	const ahora = nowMs();
	try {
		await db.execute({
			sql: `INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status, Result_Json, Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms) VALUES (?1, ?2, ?3, ?4, '${VETADA}', NULL, ?5, ?6, NULL, ?6);`,
			args: [op.opId, op.commandName, op.requestHash, op.deviceId, motivo, ahora],
		});
		return { estado: "vetada", error: motivo };
	} catch (e) {
		if (!isUniqueOpIdViolation(e)) throw e;
	}
	const estado = await leerOperacion(db, op.opId);
	if (!estado) throw new Error("el veto choca con su Op_Id, pero la operación no se deja leer");
	return estado;
}

// ---- La escritura en curso ------------------------------------------------------------------

function asegurar(ctx: ContextoDeTurno): void {
	ctx.storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS _Escritura_En_Curso (
			Id INTEGER PRIMARY KEY CHECK (Id = 1),
			Tenant_Id TEXT NOT NULL,
			Escritura_Json TEXT NOT NULL,
			Envios INTEGER NOT NULL,
			Ultimo_Envio_Ms INTEGER NOT NULL
		);
	`);
}

/**
 * Anota la escritura justo antes de mandarla. Es un `INSERT` a secas a propósito: si quedara otra
 * sin resolver, el turno no habría llegado hasta aquí, y pisarla sería perderla.
 */
export function anotarEscritura(ctx: ContextoDeTurno, tenantId: string, e: EscrituraPreparada): void {
	asegurar(ctx);
	ctx.storage.sql.exec(
		`INSERT INTO _Escritura_En_Curso (Id, Tenant_Id, Escritura_Json, Envios, Ultimo_Envio_Ms)
		 VALUES (1, ?, ?, 1, ?);`,
		tenantId,
		JSON.stringify(e),
		nowMs(),
	);
}

/** La escritura acabó y se sabe cómo: se olvida. */
export function olvidarEscritura(ctx: ContextoDeTurno): void {
	asegurar(ctx);
	ctx.storage.sql.exec("DELETE FROM _Escritura_En_Curso WHERE Id = 1;");
}

function leerEscritura(
	ctx: ContextoDeTurno,
): { escritura: EscrituraPreparada; envios: number; ultimoEnvioMs: number } | null {
	asegurar(ctx);
	const fila = ctx.storage.sql
		.exec("SELECT Escritura_Json, Envios, Ultimo_Envio_Ms FROM _Escritura_En_Curso WHERE Id = 1;")
		.toArray()[0] as any;
	if (!fila) return null;
	return {
		escritura: JSON.parse(String(fila.Escritura_Json)) as EscrituraPreparada,
		envios: Number(fila.Envios),
		ultimoEnvioMs: Number(fila.Ultimo_Envio_Ms),
	};
}

/** El batch atómico de una escritura: [PRAGMA] + [gate de idempotencia] + [trabajo] + [log]. */
export function loteDe(e: EscrituraPreparada, createdAtMs: number) {
	const built = buildApplyBatch(e.cmd);
	const gate: ResolvedStmt = {
		sql: `INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status, Result_Json, Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms) VALUES (?1, ?2, ?3, ?4, 'APPLIED', ?5, NULL, ?6, ?6, ?6);`,
		args: [e.opId, e.commandName, e.requestHash, e.deviceId, stringifyJsonValue(built.storageResult), createdAtMs],
	};
	const log: ResolvedStmt = {
		sql: `INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?1, ?2, ?3, ?4, ?5);`,
		args: [e.opId, e.commandName, stableStringify(built.replicated), e.deviceId, createdAtMs],
	};
	// Índices: 0 = PRAGMA, 1 = gate, 2.. = trabajo y lecturas, último = log.
	const stmts: ResolvedStmt[] = [
		{ sql: "PRAGMA defer_foreign_keys = ON;", args: [] },
		gate,
		...built.middle,
		log,
	];
	return { stmts, built, offsetTrabajo: 2, idxLog: stmts.length - 1 };
}

function difundirConfirmada(
	ctx: ContextoDeTurno,
	e: EscrituraPreparada,
	confirmada: { seq: number; statements: ResolvedStmt[]; result: any },
): Resolucion {
	ctx.difundir({
		command: e.commandName,
		opId: e.opId,
		deviceId: e.deviceId,
		payloadJson: e.cloudPayloadJson,
		result: confirmada.result,
		seq: confirmada.seq,
		statements: confirmada.statements,
	});
	olvidarEscritura(ctx);
	return { opId: e.opId, confirmada: true, seq: confirmada.seq, result: confirmada.result };
}

/**
 * No se ha podido saber. La nota se queda. Si se acaba de mandar algo, las Main se desconectan
 * (puede haber un `Seq` nuevo sin difundir) y se avisa; si sólo se está esperando para reenviar,
 * no: ya se desconectaron cuando se mandó.
 */
function enDuda(ctx: ContextoDeTurno, e: EscrituraPreparada, causa: unknown, enviada: boolean): never {
	if (enviada) {
		anotarEnvioSinRespuesta(ctx.storage);
		ctx.cerrarSocketsDeLaMain();
		ctx.emitSyncEvent("escritura_en_duda", {
			op_id: e.opId,
			command_name: e.commandName,
			error: String((causa as any)?.message ?? causa).slice(0, 300),
		});
	}
	throw new EscrituraEnDuda(causa);
}

/** Resuelve la nota con lo que la base dice de la operación; si no lo dice, sigue en duda. */
async function segunLaBase(
	ctx: ContextoDeTurno,
	e: EscrituraPreparada,
	preguntar: () => Promise<EstadoDeOperacion | null>,
): Promise<Resolucion> {
	let estado: EstadoDeOperacion | null;
	try {
		estado = await preguntar();
	} catch (error) {
		if (isTursoAuthError(error)) throw error;
		return enDuda(ctx, e, error, true);
	}
	if (estado?.estado === "vetada") {
		olvidarEscritura(ctx);
		ctx.emitSyncEvent("escritura_no_confirmada", {
			op_id: e.opId,
			command_name: e.commandName,
			error: estado.error.slice(0, 300),
		});
		return { opId: e.opId, confirmada: false, error: rechazoDeVetada(estado.error) };
	}
	if (estado?.estado === "aplicada") {
		if (estado.seq > 0) return difundirConfirmada(ctx, e, estado);
		// Aplicada y con su línea del log ya purgada, lo que sólo pasa por debajo del checkpoint de
		// todas las Main (SYNC-12): no queda nada que difundir.
		olvidarEscritura(ctx);
		return { opId: e.opId, confirmada: true, seq: 0, result: estado.result };
	}
	return enDuda(ctx, e, new Error("choca con su Op_Id, pero no se deja leer"), true);
}

/**
 * Resuelve la escritura anotada, si la hay. Al volver se sabe si se confirmó (y entonces ya está
 * difundida, antes que nada posterior) o si no se confirmó ni se confirmará (y se dice con qué
 * error). Si todavía no se puede saber, lanza `EscrituraEnDuda` con la nota en su sitio.
 *
 * Sólo la resuelve una respuesta de la base a su `Op_Id`:
 *  - el reenvío se confirma (y la original, si llega tarde, choca con su `Op_Id`);
 *  - el reenvío choca con su `Op_Id`: ya estaba confirmada, y se difunde la suya;
 *  - el reenvío lo rechaza la base y el veto entra: no se aplicó ni se aplicará.
 * Lo demás —sin respuesta, un 5xx, una respuesta ilegible— no dice nada de la original, que puede
 * confirmarse en cualquier momento: se vuelve a mandar en un turno posterior, cuando venza su
 * espera (`esperaDeReenvio`).
 */
export async function resolverEscrituraEnCurso(
	ctx: ContextoDeTurno,
	db: Client,
): Promise<Resolucion | null> {
	const anotada = leerEscritura(ctx);
	if (!anotada) return null;
	const e = anotada.escritura;
	// Su último envío no tiene respuesta conocida, también si el DO se apagó con él en vuelo.
	anotarEnvioSinRespuesta(ctx.storage);

	if (nowMs() - anotada.ultimoEnvioMs < esperaDeReenvio(anotada.envios)) {
		return enDuda(ctx, e, new Error("se volverá a mandar cuando venza su espera"), false);
	}

	// Se cuenta ANTES de mandarla: si el DO se apaga a medias, este envío también cuenta.
	ctx.storage.sql.exec(
		"UPDATE _Escritura_En_Curso SET Envios = Envios + 1, Ultimo_Envio_Ms = ? WHERE Id = 1;",
		nowMs(),
	);
	const { stmts, built, offsetTrabajo, idxLog } = loteDe(e, nowMs());
	let res: any[];
	try {
		res = await db.batch(stmts as any, "write");
	} catch (error) {
		if (isTursoAuthError(error)) {
			// Unas credenciales caducadas no dejan ejecutar nada: este envío no cuenta. Se rota y se
			// vuelve a resolver.
			ctx.storage.sql.exec(
				"UPDATE _Escritura_En_Curso SET Envios = ?, Ultimo_Envio_Ms = ? WHERE Id = 1;",
				anotada.envios,
				anotada.ultimoEnvioMs,
			);
			throw error;
		}
		if (isUniqueOpIdViolation(error)) return segunLaBase(ctx, e, () => leerOperacion(db, e.opId));
		if (rechazoDeterminista(error)) return segunLaBase(ctx, e, () => vetarOperacion(db, e, error));
		return enDuda(ctx, e, error, true);
	}
	// Confirmada ahora.
	let result: any = null;
	try {
		result = built.resolveResult(res, offsetTrabajo);
	} catch {
		/* está confirmada igual: un resultado que no se deja leer viaja como `null` */
	}
	const seq = Number(res[idxLog]?.lastInsertRowid ?? 0);
	if (seq > 0) return difundirConfirmada(ctx, e, { seq, statements: built.replicated, result });
	// Confirmada, pero sin un `Seq` legible no se puede difundir en su sitio. Se lee del log; si
	// tampoco se puede, sigue anotada: el reenvío siguiente chocará con su `Op_Id` y lo leerá.
	try {
		const estado = await leerOperacion(db, e.opId);
		if (estado?.estado === "aplicada" && estado.seq > 0) {
			return difundirConfirmada(ctx, e, { ...estado, result });
		}
	} catch (lectura) {
		if (isTursoAuthError(lectura)) throw lectura;
	}
	return enDuda(ctx, e, new Error("confirmada, pero su Seq no se deja leer"), true);
}
