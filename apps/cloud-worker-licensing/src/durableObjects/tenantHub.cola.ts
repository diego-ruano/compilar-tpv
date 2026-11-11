// src/durableObjects/tenantHub.cola.ts
//
// SYNC-18 · La cola de entrada del DO. (ARQ-04: sacada de la clase.)
//
// Una Main que vuelve de estar días sin conexión trae miles de operaciones. Antes tenía que
// quedarse conectada hasta que la última se aplicara; ahora las deja aquí --en el SQLite del propio
// DO, no en memoria-- y se puede ir. El DO las aplica por su cuenta, a golpe de `alarm`.
//
// ⚠️ ESTO NO TIENE ESTADO Y NO PUEDE TENERLO. Son funciones libres, no una clase, y es a propósito:
// el DO se evacúa de memoria mientras las conexiones están ociosas (SYNC-16), así que cualquier
// campo se evaporaría al hibernar. La escalera de esperas ya vivió ese error y por eso está en
// `_Cola_Estado`, una tabla, y no en una variable. Una clase con campos sería el sitio cómodo donde
// alguien volviera a cometerlo, y no lo cazaría ningún test: la cola simplemente reempezaría la
// escalera por abajo en cada despertar. Todo lo que hay que recordar entre invocaciones va al SQL.

import type { Client } from "@libsql/client/web";

import { esRechazoPermanente } from "./tenantHub.errores";
import { nowMs } from "./tenantHub.tiempo";
import { capturarError } from "../observability/errors";

import type { InternalApplyCommand, OpParaAplicar, Role } from "./tenantHub.types";

const COLA_LOTE = 50; // operaciones por batch contra la base del negocio
const COLA_MAX_INTENTOS = 5; // fallos de una operación antes de apartarla
// Espera tras un fallo que se le imputa a UNA operación. La base contesta, así que no hay nada que
// esperar salvo darle sus intentos con algo de aire entre medias.
const COLA_REINTENTO_MS = 5_000;
// REV-04: y la escalera para cuando quien falla es la BASE. Plana a 5 s, un Turso caído despertaba
// al DO doce veces por minuto —facturado a reloj de pared— para otras tantas idas y vueltas que ya
// se sabía que iban a fallar. El tope de 15 min no hace esperar a nadie en la práctica: `encolar`
// adelanta la alarma en cuanto la Main vuelve a escribir, y `setAlarm` es idempotente.
const COLA_ESPERAS_BASE_CAIDA_MS = [5_000, 30_000, 120_000, 300_000, 900_000];
// REV-04: cuánto se guarda una apartada que ninguna Main llegó a acusar. Es sólo la red por si ese
// equipo no vuelve nunca; el camino normal es que la Main la acuse y se borre en el acto.
const COLA_MUERTA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Presupuesto de un `alarm`. El runtime corta a los 15 min; se sale mucho antes y se reprograma,
// para no acercarse al límite y para que un despliegue no pille un drenado enorme a medias.
const COLA_PRESUPUESTO_MS = 60_000;
// PROD-06: con la cola apagada desde la nube, cada cuánto se vuelve a mirar si ya se encendió.
// Encender no avisa al DO, así que esto es lo que tarda en reanudarse como mucho.
const COLA_REVISAR_PAUSA_MS = 5 * 60_000;

/**
 * Lo que la cola necesita del hub, escrito. No es ceremonia: es la lista de todo aquello con lo
 * que este módulo puede contar, y tenerla delante es lo que impide que crezca sin que nadie lo
 * note.
 *
 * ⚠️ El hub lo construye con envoltorios que leen `this.X` AL LLAMAR, no con `.bind()`. La
 * diferencia importa: varios tests sustituyen un método de la instancia (la base del tenant, si
 * hay Main conectada) y con una referencia atada en el constructor esa sustitución dejaría de
 * verse.
 */
export interface ContextoDeCola {
	/** El SQLite del propio DO. Aquí vive la cola: esto es control, no negocio. */
	readonly storage: DurableObjectState["storage"];
	waitUntil(p: Promise<unknown>): void;

	applyBatchIdempotent(
		db: Client,
		ops: OpParaAplicar[],
	): Promise<{ aplicadas: string[]; yaEstaban: string[] }>;
	withTenantDbRetry<T>(tenantId: string, run: (db: Client) => Promise<T>): Promise<T>;
	maybePurgeSyncLog(tenantId: string): Promise<void>;

	/**
	 * PROD-06: ¿está apagado el interruptor `cola_do` para este tenant? Devuelve hasta cuándo, o
	 * `null`. Tiene que fallar hacia «encendido» (no lanzar): lo garantiza `lib/interruptores.ts`.
	 */
	colaPausada(tenantId: string): Promise<{ hasta_ms: number } | null>;

	isMainRecovering(): boolean;
	broadcastAuthed(obj: any, exceptDeviceId?: string): void;
	broadcastRol(rol: Role, obj: any): void;
	emitSyncEvent(name: string, fields: Record<string, unknown>): void;
}

/**
 * Crea las tablas de la cola en el SQLite del propio DO, fuera del esquema del negocio (`0001`):
 * esto es control, no negocio, y no se replica. Es barato e idempotente, así que se llama al
 * principio de cada operación con la cola en vez de llevar un flag que se evapore al hibernar.
 */
export function asegurarCola(ctx: ContextoDeCola): void {
	const sql = ctx.storage.sql;
	sql.exec(`
		CREATE TABLE IF NOT EXISTS _Cola_Entrada (
			Seq INTEGER PRIMARY KEY AUTOINCREMENT,
			Op_Id TEXT NOT NULL UNIQUE,
			Tenant_Id TEXT NOT NULL,
			Command_Name TEXT NOT NULL,
			Cmd_Json TEXT NOT NULL,
			Device_Id TEXT,
			Request_Payload_Json TEXT NOT NULL,
			Cloud_Payload_Json TEXT NOT NULL,
			Client_Now TEXT,
			Recibida_En_Ms INTEGER NOT NULL,
			Intentos INTEGER NOT NULL DEFAULT 0,
			Ultimo_Error TEXT
		);
	`);
	// Lo que no se pudo aplicar por más que se reintentara. Se aparta para que el resto del
	// atraso siga entrando.
	//
	// REV-04: y una fila aquí es una CARTA SIN ENTREGAR, no un archivo. Mientras esta tabla no la
	// leyó nadie, la nube se quedaba con una fila distinta de la Main y el único que se enteraba
	// era Axiom; la Main seguía teniendo la operación marcada como encolada, o sea en camino.
	// Ahora cada fila espera aquí hasta que una Main la acuse (`cola_apartada_ack`), que es
	// cuando esa Main ya ha puesto su copia en cuarentena y ha encolado la reparación por estado
	// de SYNC-22. Reintentar la sentencia no serviría —lo que llega aquí es un rechazo
	// permanente, y dará el mismo rechazo dentro de una hora—: lo que repara la divergencia es
	// mandar cómo está la fila AHORA, y eso sólo lo sabe la Main.
	sql.exec(`
		CREATE TABLE IF NOT EXISTS _Cola_Muerta (
			Op_Id TEXT PRIMARY KEY,
			Command_Name TEXT NOT NULL,
			Device_Id TEXT,
			Error TEXT NOT NULL,
			Intentos INTEGER NOT NULL,
			Apartada_En_Ms INTEGER NOT NULL
		);
	`);
	// REV-04: los ciclos que ha fallado seguidos la BASE, para saber cuánto esperar antes del
	// siguiente. Va en el SQLite del DO y no en un campo de instancia porque al hibernar la
	// instancia se evacúa (SYNC-16) y la escalera volvería a empezar desde abajo en cada
	// despertar, que es exactamente la espera plana que esto sustituye.
	sql.exec(`
		CREATE TABLE IF NOT EXISTS _Cola_Estado (
			Id INTEGER PRIMARY KEY CHECK (Id = 1),
			Ciclos_Fallidos INTEGER NOT NULL DEFAULT 0
		);
	`);
}

/** Cuántas operaciones esperan en la cola. Es el estado del que cuelga todo lo demás. */
export function cuantasEnCola(ctx: ContextoDeCola): number {
	asegurarCola(ctx);
	const r = ctx.storage.sql
		.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;")
		.toArray();
	return Number((r[0] as any)?.n ?? 0);
}

/**
 * Mete operaciones en la cola, en orden y sin duplicar (`INSERT OR IGNORE` por `Op_Id`: si la
 * Main reenvía un trozo del que no llegó a ver el ack, no entra dos veces).
 *
 * Devuelve los `Op_Id` aceptados, que es lo que la Main necesita para dejar de tenerlos
 * pendientes de subir. Todo va en una transacción: o entra el trozo entero o no entra nada.
 */
export function encolar(
	ctx: ContextoDeCola,
	tenantId: string,
	ops: OpParaAplicar[],
): string[] {
	if (!ops.length) return [];
	asegurarCola(ctx);

	const sql = ctx.storage.sql;
	const ahora = nowMs();
	const estabaVacia = cuantasEnCola(ctx) === 0;
	ctx.storage.transactionSync(() => {
		for (const o of ops) {
			sql.exec(
				`INSERT OR IGNORE INTO _Cola_Entrada
					(Op_Id, Tenant_Id, Command_Name, Cmd_Json, Device_Id, Request_Payload_Json, Cloud_Payload_Json, Client_Now, Recibida_En_Ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
				o.opId,
				tenantId,
				o.commandName,
				JSON.stringify(o.cmd),
				o.deviceId ?? null,
				o.requestPayloadJson,
				o.cloudPayloadJson,
				o.clientNow ?? null,
				ahora,
			);
		}
	});

	// Que empiece a drenar ya. `setAlarm` es idempotente: si ya había una programada, esto la
	// adelanta como mucho, nunca encola dos.
	//
	// Por `waitUntil` y no suelta: `encolar` es síncrona (devuelve los `Op_Id` aceptados), así
	// que no hay dónde esperarla. Dejarla flotando haría que un fallo al programar la alarma
	// fuera una promesa rechazada que nadie ve — y sin alarma la cola no se drena.
	ctx.waitUntil(ctx.storage.setAlarm(nowMs()));

	// Las Handy se congelan mientras dure. Solo en la transición: si ya estaba volcando, ya lo
	// saben.
	if (estabaVacia && cuantasEnCola(ctx) > 0) {
		ctx.broadcastAuthed({ type: "main_volcando", volcando: true, cola: cuantasEnCola(ctx) });
		ctx.emitSyncEvent("cola_volcado_inicio", { pendientes: cuantasEnCola(ctx) });
	}

	return ops.map((o) => o.opId);
}

/** Fila de la cola → la forma que consume el apply agrupado. */
function filaAOp(f: any): OpParaAplicar {
	return {
		opId: String(f.Op_Id),
		commandName: String(f.Command_Name),
		cmd: JSON.parse(String(f.Cmd_Json)) as InternalApplyCommand,
		deviceId: f.Device_Id ?? null,
		requestPayloadJson: String(f.Request_Payload_Json),
		cloudPayloadJson: String(f.Cloud_Payload_Json),
		clientNow: f.Client_Now ?? null,
	};
}

export function sacarDeLaCola(ctx: ContextoDeCola, opIds: string[]): void {
	if (!opIds.length) return;
	const sql = ctx.storage.sql;
	ctx.storage.transactionSync(() => {
		for (const id of opIds) sql.exec("DELETE FROM _Cola_Entrada WHERE Op_Id = ?;", id);
	});
}

/** Los intentos que lleva la operación contando éste. */
function intentosConEste(ctx: ContextoDeCola, op: OpParaAplicar): number {
	const fila = ctx.storage.sql
		.exec("SELECT Intentos FROM _Cola_Entrada WHERE Op_Id = ?;", op.opId)
		.toArray()[0] as any;
	return Number(fila?.Intentos ?? 0) + 1;
}

/** ¿Este fallo la aparta? */
function laAparta(ctx: ContextoDeCola, op: OpParaAplicar, permanente: boolean): boolean {
	return permanente || intentosConEste(ctx, op) >= COLA_MAX_INTENTOS;
}

/**
 * Anota el fallo de una operación y, si no tiene arreglo, la aparta.
 *
 * Apartarla es una decisión consciente: el resto del atraso —que puede ser un día entero de
 * ventas— no se queda sin subir por una operación que no hay forma de aplicar.
 *
 * ⚠️ REV-04: aquí sólo llega lo que se le imputa a ESTA operación. Un fallo de la base no pasa
 * por aquí y no gasta intentos de nadie (ver `aplicarLote`). Antes sí: cualquier excepción
 * contaba, así que un corte de Turso de veinticinco segundos se llevaba las cincuenta primeras
 * operaciones del atraso a la lápida —operaciones perfectamente sanas, que habrían entrado a la
 * primera en cuanto la base volviera—.
 *
 * `permanente` viene de `esRechazoPermanente`: un rechazo que no cambia por repetirlo se aparta
 * a la primera en vez de gastar cinco vueltas para llegar a la misma conclusión.
 */
function anotarFallo(
	ctx: ContextoDeCola,
	op: OpParaAplicar,
	error: string,
	permanente: boolean,
): void {
	const sql = ctx.storage.sql;
	const intentos = intentosConEste(ctx, op);

	if (laAparta(ctx, op, permanente)) {
		ctx.storage.transactionSync(() => {
			sql.exec(
				`INSERT OR REPLACE INTO _Cola_Muerta (Op_Id, Command_Name, Device_Id, Error, Intentos, Apartada_En_Ms)
				 VALUES (?, ?, ?, ?, ?, ?);`,
				op.opId,
				op.commandName,
				op.deviceId ?? null,
				error.slice(0, 500),
				intentos,
				nowMs(),
			);
			sql.exec("DELETE FROM _Cola_Entrada WHERE Op_Id = ?;", op.opId);
		});
		ctx.emitSyncEvent("cola_apartada", {
			op_id: op.opId,
			command_name: op.commandName,
			device_id: op.deviceId ?? null,
			error: error.slice(0, 500),
			intentos,
			permanente,
		});
		// REV-04: y que se entere la Main, que es la única que puede reparar la divergencia.
		avisarApartadas(ctx);
		return;
	}

	sql.exec(
		"UPDATE _Cola_Entrada SET Intentos = ?, Ultimo_Error = ? WHERE Op_Id = ?;",
		intentos,
		error.slice(0, 500),
		op.opId,
	);
}

/**
 * Aplica un lote y, cuando algo falla, decide DE QUIÉN es la culpa. Es el corazón de REV-04.
 *
 * Devuelve qué ha pasado, porque de eso depende cuánto esperar:
 *  - `"ok"`: entró todo lo que podía entrar (lo apartado también cuenta: la cola avanzó).
 *  - `"base_caida"`: la base del tenant no contesta. No se le anota nada a nadie y se insiste.
 *  - `"operacion_en_duda"`: la base contesta pero una operación falla por algo que no sabemos
 *    clasificar. Se le anota el intento y se para: lo de detrás se apoya en ella.
 *
 * El orden importa tanto como el veredicto. El outbox de la Main está ordenado y sus
 * operaciones se apoyan unas en otras, así que lo único que puede saltarse es un rechazo
 * PERMANENTE —que no va a entrar hoy ni dentro de un mes, y esperarlo sería parar la cola para
 * siempre—. Cualquier otro fallo detiene el lote donde está.
 */
async function aplicarLote(
	ctx: ContextoDeCola,
	db: Client,
	ops: OpParaAplicar[],
): Promise<"ok" | "base_caida" | "operacion_en_duda"> {
	try {
		const r = await ctx.applyBatchIdempotent(db, ops);
		sacarDeLaCola(ctx, [...r.aplicadas, ...r.yaEstaban]);
		return "ok";
	} catch {
		/* se aísla abajo, de una en una */
	}

	// El lote ha fallado y no sabemos cuál lo rompió: se prueban de una en una, EN ORDEN, que es
	// lo que separa a la culpable de sus compañeras.
	for (const op of ops) {
		try {
			const r = await ctx.applyBatchIdempotent(db, [op]);
			sacarDeLaCola(ctx, [...r.aplicadas, ...r.yaEstaban]);
			continue;
		} catch (e: any) {
			capturarError(e, "sync.queue_apply");
			const error = String(e?.message || e);

			// Un rechazo permanente se aparta en el acto y la cola sigue por la de detrás: es la
			// política de SYNC-20, que hasta ahora sólo aplicaba el camino en vivo.
			const permanente = esRechazoPermanente(error);

			// Y si no sabemos que sea definitivo, puede ser la base. Preguntárselo a ella es la
			// única respuesta fiable: el texto de un error de libsql no distingue "estoy caída"
			// de "esta sentencia no me gusta", y fiarlo al texto es lo que se pudre en silencio
			// cuando cambia una redacción entre versiones.
			if (!permanente && !(await baseResponde(db))) return "base_caida";

			anotarFallo(ctx, op, error, permanente);
			if (permanente) continue;
			return "operacion_en_duda";
		}
	}

	return "ok";
}

/**
 * ¿Sigue ahí la base del tenant? Una ida y vuelta, y sólo por el camino del fallo: en el ciclo
 * normal esto no se ejecuta nunca.
 */
async function baseResponde(db: Client): Promise<boolean> {
	try {
		await db.execute({ sql: "SELECT 1 AS ok;", args: [] });
		return true;
	} catch {
		return false;
	}
}

/** REV-04: cuánto esperar tras un ciclo que se fue al suelo por la base, y anotarlo. */
function esperaTrasBaseCaida(ctx: ContextoDeCola): number {
	asegurarCola(ctx);
	const sql = ctx.storage.sql;
	sql.exec(
		`INSERT INTO _Cola_Estado (Id, Ciclos_Fallidos) VALUES (1, 1)
		 ON CONFLICT(Id) DO UPDATE SET Ciclos_Fallidos = Ciclos_Fallidos + 1;`,
	);
	const fila = sql
		.exec("SELECT Ciclos_Fallidos FROM _Cola_Estado WHERE Id = 1;")
		.toArray()[0] as any;
	const n = Math.max(1, Number(fila?.Ciclos_Fallidos ?? 1));
	return COLA_ESPERAS_BASE_CAIDA_MS[
		Math.min(n - 1, COLA_ESPERAS_BASE_CAIDA_MS.length - 1)
	];
}

/** La base ha vuelto a contestar: la escalera empieza otra vez por abajo. */
function reiniciarEspera(ctx: ContextoDeCola): void {
	asegurarCola(ctx);
	ctx.storage.sql.exec("UPDATE _Cola_Estado SET Ciclos_Fallidos = 0 WHERE Id = 1;");
}

/**
 * REV-04: las apartadas que ninguna Main ha acusado todavía.
 *
 * De paso tira las que ya no va a acusar nadie. El TTL es la red de un equipo que no vuelve
 * nunca, no la política: lo normal es que la fila dure lo que tarde la Main en conectarse.
 */
export function apartadasPendientes(
	ctx: ContextoDeCola,
): { opId: string; commandName: string; error: string }[] {
	asegurarCola(ctx);
	const sql = ctx.storage.sql;
	sql.exec("DELETE FROM _Cola_Muerta WHERE Apartada_En_Ms < ?;", nowMs() - COLA_MUERTA_TTL_MS);
	return sql
		.exec("SELECT Op_Id, Command_Name, Error FROM _Cola_Muerta ORDER BY Apartada_En_Ms;")
		.toArray()
		.map((f: any) => ({
			opId: String(f.Op_Id),
			commandName: String(f.Command_Name),
			error: String(f.Error),
		}));
}

/**
 * Le cuenta a la Main lo que la nube ha apartado, para que ponga su copia en cuarentena y
 * dispare la reparación por estado (SYNC-22).
 *
 * Va sólo al rol `tpv`, y el rol sale del attachment que fijó la BD central: un aviso que dice
 * "esto no está en la nube" no puede acabar en las Handy, que no tienen con qué repararlo.
 */
function avisarApartadas(ctx: ContextoDeCola): void {
	const ops = apartadasPendientes(ctx);
	if (!ops.length) return;
	ctx.broadcastRol("tpv", { type: "cola_apartada", ops });
}

/** La Main ya lo ha anotado: la carta está entregada y la lápida sobra. */
export function olvidarApartadas(ctx: ContextoDeCola, opIds: string[]): number {
	if (!opIds.length) return 0;
	asegurarCola(ctx);
	const sql = ctx.storage.sql;
	ctx.storage.transactionSync(() => {
		for (const id of opIds) sql.exec("DELETE FROM _Cola_Muerta WHERE Op_Id = ?;", id);
	});
	return opIds.length;
}

/**
 * Drena la cola en lotes hasta vaciarla o agotar el presupuesto de esta invocación.
 *
 * Aplica en la base del negocio **primero** y borra de la cola después. Si el DO muere entre las dos cosas,
 * la operación se reaplica y el filtro de `Op_Id` la reconoce como ya aplicada: se pierde una
 * lectura, nunca un dato. Al revés (borrar y luego aplicar) se perdería la operación.
 *
 * De quién es la culpa cuando algo falla lo decide `aplicarLote`; aquí sólo se traduce ese
 * veredicto a cuánto se espera para la vuelta siguiente.
 */
export async function drenarCola(ctx: ContextoDeCola): Promise<void> {
	const limite = nowMs() + COLA_PRESUPUESTO_MS;
	let huboTrabajo = false;

	while (nowMs() < limite) {
		asegurarCola(ctx);
		const filas = ctx.storage.sql
			.exec(
				"SELECT * FROM _Cola_Entrada ORDER BY Seq LIMIT ?;",
				COLA_LOTE,
			)
			.toArray();
		if (!filas.length) {
			// Cola vacía: no se reprograma nada y el DO puede volver a hibernar. Es el momento de
			// soltar a las Handy. AUD-15: también si esta vuelta no ha drenado nada: la alarma sólo
			// se programa con trabajo, así que encontrarla vacía es que una salida anterior la dejó
			// así sin avisar, y repetir el aviso no cuesta nada.
			reiniciarEspera(ctx);
			avisarColaVacia(ctx);
			return;
		}
		const antes = filas.length === COLA_LOTE ? cuantasEnCola(ctx) : filas.length;

		const tenantId = String((filas[0] as any).Tenant_Id);

		// PROD-06: apagada desde la nube, no se toca nada. La cola es durable, así que esperar no
		// cuesta ningún dato, y las Handy siguen esperando (`main_volcando`) porque la cola no está
		// vacía: es lo correcto, la nube sigue a medio construir. Se vuelve a mirar cada pocos
		// minutos, o al caducar el apagado si llega antes.
		const pausa = await ctx.colaPausada(tenantId);
		if (pausa) {
			ctx.emitSyncEvent("cola_pausada", {
				pendientes: cuantasEnCola(ctx),
				hasta_ms: pausa.hasta_ms,
			});
			await ctx.storage.setAlarm(
				Math.min(pausa.hasta_ms, nowMs() + COLA_REVISAR_PAUSA_MS),
			);
			return;
		}

		huboTrabajo = true;
		// Un lote no mezcla tenants (el DO es de uno solo, pero la cola guarda el tenant por si
		// acaso: si apareciera otro, se drena en la vuelta siguiente).
		const delTenant = filas.filter((f: any) => String(f.Tenant_Id) === tenantId);
		const ops = delTenant.map((f) => filaAOp(f));

		const veredicto = await ctx.withTenantDbRetry(tenantId, (db) =>
			aplicarLote(ctx, db, ops),
		);

		// Aprovechamos el ciclo para purgar el log de sync ya consumido (throttleado dentro).
		ctx.waitUntil(ctx.maybePurgeSyncLog(tenantId));

		if (veredicto === "base_caida") {
			// REV-04: nadie ha gastado un intento y nada se ha apartado. Se espera —cada vez
			// más— y se vuelve. La cola es durable: esperar no cuesta ningún dato, y apartar
			// aquí tiraría operaciones sanas que entrarán a la primera cuando la base vuelva.
			const espera = esperaTrasBaseCaida(ctx);
			ctx.emitSyncEvent("cola_base_caida", {
				pendientes: cuantasEnCola(ctx),
				espera_ms: espera,
			});
			await ctx.storage.setAlarm(nowMs() + espera);
			return;
		}

		// La base contesta, así que la escalera vuelve a cero aunque esta vuelta no haya sido
		// limpia: lo que mide la escalera es la caída, no el tropiezo de una operación.
		reiniciarEspera(ctx);

		if (veredicto === "operacion_en_duda") {
			// AUD-15: si su quinto fallo la ha apartado y era la última, la cola ya está vacía:
			// se avisa ahora, sin esperar a una alarma que no tiene nada que drenar.
			if (cuantasEnCola(ctx) === 0) {
				avisarColaVacia(ctx);
				return;
			}
			await ctx.storage.setAlarm(nowMs() + COLA_REINTENTO_MS);
			return;
		}

		// Guardia de progreso: una vuelta que no reduce la cola volvería a leer las mismas filas
		// y a intentar lo mismo, girando en caliente hasta agotar el presupuesto (y facturando
		// ese tiempo). Si no se avanza, se para y se reintenta más tarde con calma.
		if (cuantasEnCola(ctx) >= antes) {
			await ctx.storage.setAlarm(nowMs() + COLA_REINTENTO_MS);
			return;
		}
	}

	// Se acabó el presupuesto pero queda cola: seguimos en la siguiente alarma. AUD-15: si la última
	// vuelta la vació, el aviso va aquí: la alarma siguiente ya no llegaría a darlo.
	if (cuantasEnCola(ctx) > 0) await ctx.storage.setAlarm(nowMs());
	else if (huboTrabajo) avisarColaVacia(ctx);
}

/**
 * La cola se ha vaciado. Las Handy se sueltan si la Main no las retiene (`recovering`), y la Main
 * se entera de que lo que dejó en la cola ya está aplicado o apartado: lo apartado se le avisó antes
 * (`cola_apartada`), por el mismo socket, así que cuando le llega esto ya lo tiene (AUD-15).
 */
function avisarColaVacia(ctx: ContextoDeCola): void {
	ctx.broadcastAuthed({
		type: "main_volcando",
		volcando: ctx.isMainRecovering(),
		cola: 0,
	});
	ctx.emitSyncEvent("cola_volcado_fin", {});
}

/**
 * Único punto de entrada del drenado.
 *
 * ⚠️ El reintento automático de un `alarm` que lanza se rinde a los 6 intentos y **la cola se
 * quedaría muerta en silencio**. Por eso aquí se captura todo y se reprograma a mano: el
 * drenado tiene que ser insistente, no valiente.
 */
export async function ciclo(ctx: ContextoDeCola): Promise<void> {
	try {
		await drenarCola(ctx);
	} catch (e: any) {
		capturarError(e, "sync.queue_cycle");
		ctx.emitSyncEvent("cola_ciclo_error", {
			error: String(e?.message || e).slice(0, 500),
		});
		await ctx.storage.setAlarm(nowMs() + COLA_REINTENTO_MS);
	}
}
