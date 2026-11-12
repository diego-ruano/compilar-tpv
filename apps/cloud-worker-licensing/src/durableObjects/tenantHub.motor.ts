import type { Env } from "../env";
import { HubError } from "../lib/errorHttp";
import type { Client } from "@libsql/client/web";
import { createDbClient } from "../server/db/clients";
import { getDb } from "../server/db";
import { estaApagado } from "../lib/interruptores";
import { ingestToAxiom } from "../observability/axiom";
import { PURGADO_HASTA } from "../domains/sync/cambiosJson";

import type { ContextoDeCola } from "./tenantHub.cola";
import {
	apartadasPendientes,
	asegurarCola,
	ciclo,
	cuantasEnCola,
	drenarCola,
	encolar,
	olvidarApartadas,
	sacarDeLaCola,
} from "./tenantHub.cola";
import {
	safeJsonParse,
	sha256Hex,
	stableStringify,
	stringifyJsonValue,
} from "./tenantHub.envelope";
import { loadDeviceFromCentral, verifyHelloSigned } from "./tenantHub.identidad";
import { buildApplyBatch, loteDe, type EscrituraPreparada } from "./tenantHub.lote";
import type { ContextoDeMensajes } from "./tenantHub.mensajes";
import { despachar } from "./tenantHub.mensajes";
import type { ApplyParams, IdentidadDelWorker, RespuestaDeConsulta, ResultadoAplicacion } from "./tenantHub.rpc";
import { app } from "../app";
import { dentroDelHub } from "../lib/hubLocal";
import {
	baseAprovisionada,
	clienteLocal,
	ejecutarEnBruto,
	loteEnBruto,
	migrarBaseLocal,
	type Sentencia,
} from "./tenantHub.sqlite";
import type { ContextoDeRutas } from "./tenantHub.rutas";
import {
	abrirWebSocket,
	aplicar,
	avisoDePairing,
	avisoDeReservasWeb,
	esUpgradeDeWebSocket,
	revocar,
} from "./tenantHub.rutas";
import { isUniqueOpIdViolation } from "./tenantHub.sentencias";
import {
	commandHasNowLiteral,
	horaSinFijar,
	nowMs,
	parseClientNow,
	rewriteCmdNowLiterals,
	serverNowFixed,
} from "./tenantHub.tiempo";

import type {
	HelloSignedMsg,
	InternalApplyCommand,
	OpParaAplicar,
	ResolvedStmt,
	Role,
	WsAttachment,
} from "./tenantHub.types";


// SYNC-08: ventana mínima entre escrituras de `last_seen_at_ms` por dispositivo en la BD central.
// Absorbe los pings (cada 30 s) sin perder utilidad de presencia (granularidad de minutos basta).
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

// ---- SYNC-12: purga del log de sync en la nube ------------------------------
// `Sync_Changes` y `Applied_Operations` crecían sin límite; el catch-up escanea `Sync_Changes`
// cada reconexión. Purgamos con SUELO por el checkpoint mínimo de las Main activas (nunca borramos
// algo que una Main aún no ha consumido) y con TTL (solo filas suficientemente antiguas).
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // como mucho una purga por hora y por instancia de DO
const CHECKPOINT_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000; // una Main cuenta para el suelo si reportó < 7 días
const PURGE_SEQ_MARGIN = 1000; // holgura de Seq por debajo del suelo (cubre solape catch-up/live)
const SYNC_CHANGES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // no borrar cambios de menos de 7 días
// idempotencia: un reintento nunca llega tan tarde.
const APPLIED_OPS_TTL_MS = 7 * 24 * 60 * 60 * 1000;


export class MotorTenantHub {
	// SYNC-16: este DO usa la WebSocket Hibernation API. Mientras las conexiones están ociosas el
	// runtime evacúa el objeto de memoria (deja de facturar duración) y lo despierta al llegar un
	// mensaje real. Consecuencia de diseño: NO puede haber estado de sesión en campos de instancia.
	//   · lo que describe a un socket        → su attachment (`WsAttachment`)
	//   · el censo de conexiones             → `state.getWebSockets()` (etiquetadas por deviceId)
	// Lo único que queda abajo son cachés best-effort que pueden perderse sin consecuencias.

	// SYNC-08: último `last_seen` empujado a la BD central por dispositivo (throttle en memoria).
	// Se pierde al hibernar: como mucho provoca un UPDATE extra tras despertar. Aceptable.
	private lastSeenPushedAtMs = new Map<string, number>();
	// SYNC-12: instante de la última purga del log de sync (throttle en memoria del DO).
	private lastPurgeAtMs = 0;

	private centralDb: Client | null = null;

	// La base del negocio es el SQLite de este DO. El cliente se monta una vez por
	// instancia, tras comprobar que el negocio está aprovisionado y su esquema al día.
	private baseLocal: Client | null = null;
	// El negocio de este DO, para las trazas: lo dice la primera petición que llega.
	private tenantIdVisto: string | null = null;

	// AUD-18: la cola de lo que está confirmando y difundiendo ahora mismo (ver `enTurnoDelLog`). Es
	// lo que está en vuelo, no algo que recordar entre invocaciones: el DO sólo hiberna sin nada en
	// vuelo, así que al despertar vacía es lo correcto (SYNC-16, regla 4).
	private turnoDelLog: Promise<void> = Promise.resolve();

	constructor(private state: DurableObjectState, private env: Env) {
		// SYNC-16: el latido (cada 30 s por dispositivo) se responde EN EL EDGE, sin despertar al DO
		// ni facturar duración. Es lo que hace que un hub con conexiones abiertas pero ociosas (la
		// mayor parte del día en hostelería) cueste prácticamente cero.
		// ⚠️ El par casa cadenas EXACTAS: debe coincidir byte a byte con lo que envían
		// `useMainSocket`/`useHandySocket` (`JSON.stringify({ type: "ping" })`). Si algún día cambia
		// el formato del latido en el frontend, hay que cambiarlo aquí o el DO despertará en cada uno.
		this.state.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(
				JSON.stringify({ type: "ping" }),
				JSON.stringify({ type: "pong" }),
			),
		);
	}

	// ---- SYNC-16: helpers de sesión sobre la Hibernation API --------------------------------

	/** Lee el attachment de un socket (o `null` si no lo tiene / está corrupto). */
	private att(ws: WebSocket): WsAttachment | null {
		try {
			return (ws.deserializeAttachment() as WsAttachment | null) ?? null;
		} catch {
			return null;
		}
	}

	/** Persiste el attachment. Hay que llamarlo tras CADA mutación del estado de sesión. */
	private setAtt(ws: WebSocket, att: WsAttachment): void {
		try {
			ws.serializeAttachment(att);
		} catch {
			/* nunca romper el flujo del WS por el attachment */
		}
	}

	/** Sockets vivos de un dispositivo (los cerrados pueden seguir apareciendo en getWebSockets). */
	private liveSocketsFor(deviceId: string, except?: WebSocket): WebSocket[] {
		const out: WebSocket[] = [];
		for (const ws of this.state.getWebSockets(deviceId)) {
			if (except && ws === except) continue;
			// 1 = OPEN. Filtramos explícitamente porque `getWebSockets` puede devolver sockets ya
			// cerrados (documentado), lo que falsearía el "¿me han reemplazado?" y el freeze.
			if (ws.readyState === 1) out.push(ws);
		}
		return out;
	}

	private getCentralDb(): Client {
		if (!this.centralDb) {
			this.centralDb = createDbClient({
				url: this.env.TURSO_DATABASE_URL,
				authToken: this.env.TURSO_AUTH_TOKEN,
			});
		}
		return this.centralDb;
	}

	/**
	 * La base del negocio: el SQLite de este mismo DO.
	 *
	 * Sin aprovisionar contesta `tenant_db_not_provisioned`. Aprovisionado, migra lo pendiente una
	 * vez por instancia (al desplegar un esquema nuevo, el DO se reinicia y el primer acceso lo
	 * aplica). No hay credenciales, ni red, ni plazos: una escritura entra o no entra, y se sabe en
	 * el acto.
	 */
	private async getTenantDb(tenantId: string): Promise<Client> {
		this.tenantIdVisto ??= tenantId || null;
		if (this.baseLocal) return this.baseLocal;
		const storage = this.state.storage;
		if (!baseAprovisionada(storage.sql)) throw new HubError("tenant_db_not_provisioned", 404);
		await migrarBaseLocal(storage);
		this.baseLocal = clienteLocal(storage);
		return this.baseLocal;
	}

	private async withTenantDbRetry<T>(
		tenantId: string,
		run: (db: Client) => Promise<T>,
	): Promise<T> {
		return run(await this.getTenantDb(tenantId));
	}

	/** El alta del negocio: crea su esquema (idempotente). */
	async aprovisionar(tenantId: string): Promise<void> {
		this.tenantIdVisto ??= tenantId;
		await migrarBaseLocal(this.state.storage);
		this.baseLocal = clienteLocal(this.state.storage);
	}

	estaAprovisionado(): boolean {
		return baseAprovisionada(this.state.storage.sql);
	}

	/**
	 * Las lecturas del Worker (`tenantQuery`). Una sentencia suelta,
	 * o un lote atómico: el lote de lectura da una foto coherente, como el `batch("read")` de libsql.
	 *
	 * No pasan por el turno del log: el SQL del DO es síncrono, así que ven lo confirmado o lo que
	 * otra petición acaba de escribir en este mismo DO, nunca una escritura a medias.
	 */
	async consultar(
		tenantId: string,
		sentencias: Sentencia[],
		enLote: boolean,
	): Promise<RespuestaDeConsulta> {
		try {
			await this.getTenantDb(tenantId);
		} catch (e) {
			if (e instanceof HubError) {
				return { ok: false, code: e.code, status: e.status, details: e.details };
			}
			throw e;
		}
		const storage = this.state.storage;
		const resultados = enLote
			? loteEnBruto(storage, sentencias)
			: [ejecutarEnBruto(storage.sql, sentencias[0])];
		return { ok: true, resultados };
	}

	/** Retirar un negocio de pruebas: su base entera, con la cola y lo demás del DO. */
	async borrarTodo(): Promise<void> {
		await this.state.storage.deleteAll();
		this.baseLocal = null;
	}

	private async touchLastSeen(tenantId: string, deviceId: string, force = false) {
		// SYNC-08: sin throttle, cada ping (30 s) por dispositivo escribía en la BD central →
		// amplificación de escrituras proporcional al nº de dispositivos. Guardamos en memoria del
		// DO el último instante empujado y solo re-escribimos pasada la ventana (o si `force`, p. ej.
		// al conectar). La precisión de `last_seen` no necesita ser al segundo.
		// SYNC-16: el ping ya NO llega hasta aquí (lo contesta el auto-response sin despertar al DO),
		// así que ahora esto se alimenta de: conexión (force) y actividad real (apply/event). El
		// throttle en memoria se pierde al hibernar → como mucho un UPDATE extra por despertar.
		const now = nowMs();
		if (!force) {
			const last = this.lastSeenPushedAtMs.get(deviceId) ?? 0;
			if (now - last < LAST_SEEN_THROTTLE_MS) return;
		}
		this.lastSeenPushedAtMs.set(deviceId, now);
		const dbCentral = this.getCentralDb();
		await dbCentral.execute({
			sql: `UPDATE devices SET last_seen_at_ms=? WHERE tenant_id=? AND device_id=?`,
			args: [now, tenantId, deviceId],
		});
	}

	// SYNC-12: purga (throttled) del log de sync en el tenant. Solo borra filas por DEBAJO del
	// checkpoint mínimo de las Main activas (con holgura) Y suficientemente antiguas (TTL), de modo
	// que jamás retira un cambio que una Main aún no ha consumido. Best-effort: nunca rompe el sync.
	//
	// AUD-18: va en el turno del log, como todo lo que toca `Sync_Changes`.
	private async maybePurgeSyncLog(tenantId: string): Promise<void> {
		const now = nowMs();
		if (now - this.lastPurgeAtMs < PURGE_INTERVAL_MS) return;
		this.lastPurgeAtMs = now;
		try {
			await this.withTenantDbRetry(tenantId, (db) => this.enTurnoDelLog(async () => {
				// Suelo = mínimo Last_Seq de las Main que reportaron checkpoint recientemente. Si no
				// hay ninguna activa, MIN devuelve NULL → no purgamos Sync_Changes (fail-safe). La
				// marca de lo purgado (AUD-19) vive en la misma tabla y no es una Main.
				const r = await db.execute({
					sql: `SELECT MIN(Last_Seq) AS floor FROM Sync_Main_Checkpoints WHERE Updated_At_Ms > ?1 AND Device_Id <> ?2;`,
					args: [now - CHECKPOINT_ACTIVE_MS, PURGADO_HASTA],
				});
				const floorRaw = (r.rows?.[0] as any)?.floor;
				const floor = floorRaw == null ? null : Number(floorRaw);

				if (floor != null && floor > PURGE_SEQ_MARGIN) {
					const hasta = floor - PURGE_SEQ_MARGIN;
					const antesDe = now - SYNC_CHANGES_TTL_MS;
					// AUD-19: el mayor Seq que se borra queda anotado en la misma transacción, y
					// `/v1/sync/changes` lo devuelve. Hace falta el dato y no el principio del log: la
					// purga mira también la antigüedad, que se fija antes de que el turno numere, así
					// que puede llevarse el 12 y dejar el 11.
					await db.batch(
						[
							{
								sql: `INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms)
									SELECT ?3, m, ?4 FROM (
										SELECT MAX(Seq) AS m FROM Sync_Changes WHERE Seq <= ?1 AND Created_At_Ms < ?2
									) WHERE m IS NOT NULL
									ON CONFLICT(Device_Id) DO UPDATE SET
										Last_Seq = MAX(Last_Seq, excluded.Last_Seq),
										Updated_At_Ms = excluded.Updated_At_Ms;`,
								args: [hasta, antesDe, PURGADO_HASTA, now],
							},
							{
								sql: `DELETE FROM Sync_Changes WHERE Seq <= ?1 AND Created_At_Ms < ?2;`,
								args: [hasta, antesDe],
							},
						],
						"write",
					);
				}

				// Applied_Operations es dedup por Op_Id: un reintento idempotente nunca llega días
				// después, así que basta un TTL (independiente del checkpoint) para acotarla. Con la
				// cola sin vaciar, no: si el DO se apagó entre aplicar un lote y sacarlo de la cola,
				// el gate es lo que impide que el drenado siguiente lo aplique otra vez.
				if (this.cuantasEnCola() === 0) {
					await db.execute({
						sql: `DELETE FROM Applied_Operations WHERE Created_At_Ms < ?1;`,
						args: [now - APPLIED_OPS_TTL_MS],
					});
				}
			}));
		} catch {
			/* la purga es best-effort: nunca debe afectar al camino de escritura del sync */
		}
	}

	/**
	 * AUD-18 · El turno del log: confirmar y difundir, de una escritura en una.
	 *
	 * La Main aplica en orden de `Seq` y guarda como checkpoint el último que le llega. Si el DO
	 * difundiera el 11 antes que el 10 y a la Main se le cayera el socket entre medias, al reconectar
	 * pediría desde el 11 y el 10 se perdería sin rastro. Entre que una escritura confirma y difunde
	 * hay `await` (el cliente de la base es asíncrono aunque el SQL del DO no lo sea), y por ahí
	 * puede colarse otra.
	 *
	 * Con el turno la difusión sale en orden de `Seq`, sin suponer que sea contiguo: (1) sólo este
	 * DO escribe `Sync_Changes`, y las dos inserciones (`applyInternalCommandIdempotent` y
	 * `applyBatchIdempotent`) van dentro; (2) el `Seq` lo asigna el commit, que acaba antes de soltar
	 * el turno, y la difusión va justo después; (3) un WebSocket entrega en orden, y el catch-up de
	 * cada conexión de la Main va después de autenticarse, así que lo confirmado antes le llega por
	 * REST y lo posterior por el socket.
	 *
	 * Nada de temporizadores ni de estado que deba sobrevivir (SYNC-16): es una cadena de promesas de
	 * lo que está en vuelo, y un fallo no la rompe para el siguiente.
	 */
	private enTurnoDelLog<T>(trabajo: () => Promise<T>): Promise<T> {
		const resultado = this.turnoDelLog.then(trabajo);
		this.turnoDelLog = resultado.then(
			() => undefined,
			() => undefined,
		);
		return resultado;
	}

	private async applyInternalCommandIdempotent(params: {
		tenantId: string;
		cmd: InternalApplyCommand;
		opId: string;
		commandName: string;
		deviceId?: string | null;
		requestPayloadJson: string;
		cloudPayloadJson: string;
		clientNow?: string | null;
		/** Sólo el outbox de la Main que está ejecutando la propia recuperación puede escribir. */
		allowWhileRecovering?: boolean;
	}): Promise<{ result: any; seq: number }> {
		const {
			tenantId,
			opId,
			commandName,
			deviceId,
			requestPayloadJson,
			cloudPayloadJson,
		} = params;

		// El tiempo lo fija el dispositivo emisor (cabecera X-Client-Now); resolvemos los
		// `datetime('now')` del comando a literal ANTES de ejecutar y de registrar el cambio,
		// para que la fila sea idéntica en nube, Main y Handy (replicación determinista).
		//
		// SYNC-04 (guard duro): si el comando lleva una forma `datetime('now',...)` SIN resolver y el
		// emisor NO mandó una X-Client-Now válida, RECHAZAMOS en vez de caer en silencio a UTC (lo que
		// dejaba la fila con zona horaria distinta al resto). Todo escritor legítimo pasa por el proxy
		// Rust `tpv_server_post_json`, que siempre fija la cabecera; este guard blinda contra cualquier
		// caller futuro que la omitiera. Los comandos ya-literales (p. ej. de la Main) no la exigen.
		const parsedNow = parseClientNow(params.clientNow);
		if (parsedNow === null && commandHasNowLiteral(params.cmd)) {
			throw new HubError("missing_client_now", 400);
		}
		const cmd = rewriteCmdNowLiterals(params.cmd, parsedNow ?? serverNowFixed());

		// CFG-04: lo que no se ha podido fijar lo pondría la base, con su reloj y en UTC, y la fila de la
		// nube diría otra hora que la del dispositivo. Se rechaza antes de ejecutar nada. Ningún
		// comando lo hace hoy (lo vigila el scan de `*.commands.ts` en Rust): esto sólo salta con uno
		// nuevo mal escrito, y es mejor que salte a que deje horas distintas.
		const sinFijar = horaSinFijar(cmd);
		if (sinFijar) {
			throw new HubError("hora_no_determinista", 400, { message: `hora_no_determinista: ${sinFijar}` });
		}

		const op = opId.trim();
		const command = commandName.trim();

		if (!op) {
			throw new HubError("missing_op_id", 400);
		}

		if (!command) {
			throw new HubError("missing_command_name", 400);
		}

		// Freeze global: si no hay una Main (tpv) autenticada conectada, NO se
		// aplica nada. Vale tanto para escrituras REST de la Handy como para el
		// WS-write de la propia Main (que cuenta como presente al estar conectada).
		//
		// SYNC-18: y si la Main tiene atraso sin aplicar, la nube está a medio construir. Dejar
		// escribir a una Handy sobre ese estado es pedir un choque (dos comandas abiertas para la
		// misma mesa, por ejemplo). Se congela igual que sin Main, con otro motivo.
		//
		// Solo afecta a las escrituras que NO son el propio atraso: las de la cola no pasan por
		// aquí, van por `applyBatchIdempotent`. Se mira aquí, para no esperar en balde, y otra vez
		// dentro del turno, que es lo que vale.
		const exigirQueSePuedaEscribir = () => {
			if (!this.isMainConnected()) {
				throw new HubError("main_offline", 400);
			}
			if (!params.allowWhileRecovering && !this.isMainReady()) {
				throw new HubError("main_volcando", 400);
			}
			if (this.cuantasEnCola() > 0) {
				throw new HubError("main_volcando", 400);
			}
		};
		exigirQueSePuedaEscribir();

		const requestHash = await sha256Hex(requestPayloadJson);
		const createdAtMs = nowMs();

		// Aplanamos el comando a un único batch atómico (`loteDe`):
		// [PRAGMA defer FK] + [gate idempotente] + [trabajo] + [log de sync].
		// El gate va SIN ON CONFLICT: en un reintento (mismo Op_Id) viola UNIQUE(Op_Id) y hace
		// rollback de TODO el batch → ni se duplica el trabajo ni el log. No existe estado
		// PROCESSING intermedio: la op está APPLIED (commit) o ausente (rollback).
		const escritura: EscrituraPreparada = {
			opId: op,
			commandName: command,
			cmd,
			deviceId: deviceId || null,
			requestHash,
			cloudPayloadJson,
		};
		const { stmts: batchStmts, built, offsetTrabajo: MIDDLE_OFFSET } = loteDe(escritura, createdAtMs);

		// AUD-18: confirmar y difundir van dentro del turno del log (`enTurnoDelLog`).
		const runApply = () => this.withTenantDbRetry(tenantId, (db) => this.enTurnoDelLog(async () => {
			// AUD-18: otra vez dentro del turno, el congelado de la cola (SYNC-18): mientras se esperaba
			// el turno pudo llegar un volcado, y nada puede confirmarse por delante de él. AUD-15: y el
			// de la Main, por lo mismo: la que estaba lista pudo irse, o reconectar y saludar
			// congelando, y lo que la Handy decidió con ella lista no puede entrar después.
			exigirQueSePuedaEscribir();

			let batchResults: any[];
			try {
				batchResults = await db.batch(batchStmts as any, "write");
			} catch (e: any) {
				if (isUniqueOpIdViolation(e)) {
					// Reintento idempotente: la op ya estaba aplicada. Recuperamos result + seq.
					const recovered = await this.recoverAppliedOp(db, op, command, requestHash);
					// SYNC-03: si el DO se reinició/evictó tras el commit y ANTES del broadcast
					// original, las Handy (sin checkpoint) nunca recibieron el cambio. Al reintentar,
					// el emisor entra por este path idempotente: re-emitimos el broadcast para que el
					// resto de dispositivos converja. La Main secundaria lo descarta por Op_Id.
					if (recovered.statements.length) {
						this.broadcastChange(
							{
								command,
								opId: op,
								deviceId: deviceId || null,
								payloadJson: cloudPayloadJson,
								result: recovered.result,
								seq: recovered.seq,
								statements: recovered.statements,
							},
							deviceId || undefined,
						);
					}
					return { result: recovered.result, seq: recovered.seq };
				}
				// La base la rechazó: el lote se deshizo entero y no hay nada que difundir.
				throw e;
			}

			// El `Seq` lo asigna el commit, y el lote es local: siempre se puede leer.
			const seq = Number(batchResults[batchResults.length - 1]?.lastInsertRowid ?? 0);
			let result: any = null;
			try {
				result = built.resolveResult(batchResults, MIDDLE_OFFSET);
			} catch (e) {
				// Está confirmada igual: un resultado que no se deja leer viaja como `null`.
				this.emitSyncEvent("resultado_ilegible", {
					op_id: op,
					error: String((e as any)?.message || e).slice(0, 200),
				});
			}

			// Tras confirmar, propagamos el cambio (payload + resultado) al resto de dispositivos
			// autenticados. El originador queda excluido. La Main aplica el payload directo a su
			// SQLite local (no hay refetch). AUD-18: antes que nada más en el turno.
			this.broadcastChange(
				{
					command,
					opId: op,
					deviceId: deviceId || null,
					payloadJson: cloudPayloadJson,
					result,
					seq,
					statements: built.replicated,
				},
				deviceId || undefined,
			);

			// SYNC-10: el gate guardó un Result_Json best-effort (solo literales; lo derivado de la
			// DB quedó null). Si el resultado REAL difiere (incluye campos derivados de la DB), lo
			// persistimos ahora para que un reintento idempotente (p. ej. una Handy con
			// timeout+retry) devuelva el MISMO `data` que el primer intento, no uno degradado.
			// Solo pagamos el round trip extra cuando de verdad hay algo que refinar.
			const realResultJson = stringifyJsonValue(result);
			if (realResultJson !== stringifyJsonValue(built.storageResult)) {
				try {
					await db.execute({
						sql: "UPDATE Applied_Operations SET Result_Json = ?1, Updated_At_Ms = ?2 WHERE Op_Id = ?3;",
						args: [realResultJson, nowMs(), op],
					});
				} catch {
					/* refinar el cache es best-effort: nunca romper el apply por esto */
				}
			}

			// SYNC-12: aprovechamos una escritura confirmada para purgar (throttled, fire-and-forget)
			// el log de sync ya consumido por todas las Main. No bloquea el apply.
			this.state.waitUntil(this.maybePurgeSyncLog(tenantId));

			// OBS-04: en el ÉXITO no emitimos nada a Axiom. El coste que disparaba el volumen era
			// justo este evento por cada `apply`; el detalle de un apply correcto no se necesita.
			return { result, seq };
		}));

		try {
			return await runApply();
		} catch (e: any) {
			// Sólo los FALLOS van a Axiom (100%), con payload RECORTADO: nombre de comando + ids +
			// error truncado. NO incluimos el comando ni sus args (evita filtrar datos y volumen).
			// El freeze `main_offline` no llega aquí (se lanza antes) y ya tiene su propio evento.
			this.emitSyncEvent("apply_error", {
				command_name: command,
				op_id: op,
				device_id: deviceId || null,
				tenant_id: tenantId,
				error: String(e?.message || e).slice(0, 500),
				latency_ms: nowMs() - createdAtMs,
			});
			throw e;
		}
	}

	/**
	 * SYNC-18: aplica **N operaciones en un único batch** contra la base del negocio.
	 *
	 * El atraso de una Main que estuvo días sin conexión son miles de operaciones. Aquí el trabajo de
	 * todas va junto: una sola transacción con el PRAGMA, los gates, el trabajo y el log de sync de
	 * cada una.
	 *
	 * Tres diferencias deliberadas con el camino de una en una:
	 *
	 * 1. **Se filtran antes las ya aplicadas.** El gate de idempotencia funciona porque un `Op_Id`
	 *    repetido viola el UNIQUE y tira la transacción; agrupadas, esa repetida se llevaría por
	 *    delante a todas sus compañeras y el reintento volvería a chocar — atascada para siempre.
	 *    Así que una lectura previa las descarta. Es el precio de agrupar, y es una lectura.
	 * 2. **No exige que haya una Main conectada.** El freeze existe para que una Handy no escriba
	 *    sin Main; estas operaciones YA son de la Main, que las dejó encoladas antes de irse.
	 *    Aplicarlas sin ella delante es justo el objetivo.
	 * 3. **No refina el `Result_Json`.** Ese refinamiento existe para que el reintento de una Handy
	 *    devuelva el mismo `data`; de una operación de la Main sólo se usa el `seq`. Nos ahorra una
	 *    escritura extra por operación.
	 *
	 * Si el batch falla no sabemos cuál lo rompió: **lanza**, y quien llama reintenta de una en una
	 * (que es este mismo método con una sola operación) para aislar a la culpable.
	 *
	 * Recibe el `db` ya resuelto en vez de resolverlo dentro: quien drena la cola lo resuelve una vez
	 * para todo su ciclo, y los tests pueden ponerle delante la base que quieran.
	 */
	private async applyBatchIdempotent(
		db: Client,
		ops: OpParaAplicar[],
	): Promise<{ aplicadas: string[]; yaEstaban: string[] }> {
		if (!ops.length) return { aplicadas: [], yaEstaban: [] };

		// 1) Normalizar: mismo trato que el camino de una en una (validación + `now` a literal).
		const preparadas = ops.map((o) => {
			const op = o.opId.trim();
			const command = o.commandName.trim();
			if (!op) throw new HubError("missing_op_id", 400);
			if (!command) throw new HubError("missing_command_name", 400);

			const parsedNow = parseClientNow(o.clientNow);
			if (parsedNow === null && commandHasNowLiteral(o.cmd)) {
				throw new HubError("missing_client_now", 400);
			}
			const cmd = rewriteCmdNowLiterals(o.cmd, parsedNow ?? serverNowFixed());

			// REV-22: y el guard duro de CFG-04, que aquí faltaba. Sin él, lo que llegara con una
			// hora sin fijar —un `CURRENT_TIMESTAMP`, un `'now'` en UTC— lo resolvía la base con su
			// reloj, y la fila de la nube decía otra hora que la de la Main. Por el camino en vivo
			// eso se rechaza desde SYNC-04; por la cola entraba, y es el MISMO motor: una operación
			// no puede valer o no según haya atraso por delante cuando se subió.
			const sinFijar = horaSinFijar(cmd);
			if (sinFijar) {
				throw new HubError("hora_no_determinista", 400, { message: `hora_no_determinista: ${sinFijar}` });
			}

			return { ...o, opId: op, commandName: command, cmd };
		});

		// AUD-18: lo que toca `Sync_Changes` va en el turno del log (`enTurnoDelLog`), igual que una
		// escritura suelta: si no, una de una Handy podría confirmarse entre medias y difundirse
		// fuera de orden.
		return this.enTurnoDelLog(() => this.aplicarPreparadas(db, preparadas));
	}

	/** SYNC-18 · pasos 2 a 4 de `applyBatchIdempotent`, ya dentro del turno del log (AUD-18). */
	private async aplicarPreparadas(
		db: Client,
		preparadas: OpParaAplicar[],
	): Promise<{ aplicadas: string[]; yaEstaban: string[] }> {
		// 2) Fuera las ya aplicadas (ver punto 1 del comentario de arriba).
		const yaAplicadas = new Set<string>();
		const r = await db.execute({
			sql: `SELECT Op_Id FROM Applied_Operations WHERE Op_Id IN (SELECT value FROM json_each(?1));`,
			args: [JSON.stringify(preparadas.map((p) => p.opId))],
		});
		for (const fila of r.rows ?? []) {
			const v = String((fila as any).Op_Id ?? "");
			if (v) yaAplicadas.add(v);
		}

		// Lo ya confirmado se difunde otra vez, en orden de `Seq` y antes que lo nuevo. Sólo pasa si
		// el DO se apagó entre aplicar un lote y sacarlo de la cola, y entonces la difusión pudo
		// perderse con él. Repetirla es inocuo: la Main la descarta por estar por debajo de su
		// checkpoint, o por ser suya.
		if (yaAplicadas.size) {
			await this.difundirYaConfirmadas(
				db,
				preparadas.filter((p) => yaAplicadas.has(p.opId)),
			);
		}

		const pendientes = preparadas.filter((p) => !yaAplicadas.has(p.opId));
		if (!pendientes.length) {
			return { aplicadas: [], yaEstaban: [...yaAplicadas] };
		}
		// 3) Un solo array de sentencias: [PRAGMA] + por operación [gate, ...trabajo, syncLog].
		const createdAtMs = nowMs();
		const stmts: ResolvedStmt[] = [{ sql: "PRAGMA defer_foreign_keys = ON;", args: [] }];
		const tramos: {
			op: (typeof pendientes)[number];
			built: ReturnType<typeof buildApplyBatch>;
			offsetMiddle: number;
			idxSyncLog: number;
		}[] = [];

		for (const p of pendientes) {
			const built = buildApplyBatch(p.cmd);
			const requestHash = await sha256Hex(p.requestPayloadJson);

			stmts.push({
				sql: `INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Device_Id, Status, Result_Json, Error_Text, Created_At_Ms, Applied_At_Ms, Updated_At_Ms) VALUES (?1, ?2, ?3, ?4, 'APPLIED', ?5, NULL, ?6, ?6, ?6);`,
				args: [
					p.opId,
					p.commandName,
					requestHash,
					p.deviceId || null,
					stringifyJsonValue(built.storageResult),
					createdAtMs,
				],
			});
			const offsetMiddle = stmts.length;
			stmts.push(...built.middle);
			const idxSyncLog = stmts.length;
			stmts.push({
				sql: `INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?1, ?2, ?3, ?4, ?5);`,
				args: [
					p.opId,
					p.commandName,
					stableStringify(built.replicated),
					p.deviceId || null,
					createdAtMs,
				],
			});

			tramos.push({ op: p, built, offsetMiddle, idxSyncLog });
		}

		const batchResults = await db.batch(stmts as any, "write");

		// 4) Ya confirmado: cada operación recupera su `seq` y se difunde por separado, para que el
		//    anti-eco por `Op_Id` de la Main y el refetch de las Handy sigan funcionando igual.
		//    TODAS se difunden, aunque el resultado de alguna no se deje leer: de una operación de
		//    la cola sólo se usa el `seq` (un resultado ilegible viaja como `null`).
		const aplicadas: string[] = [];
		for (const t of tramos) {
			const seq = Number(batchResults[t.idxSyncLog]?.lastInsertRowid ?? 0);
			let result: any = null;
			try {
				result = t.built.resolveResult(batchResults, t.offsetMiddle);
			} catch (e) {
				this.emitSyncEvent("resultado_ilegible", {
					op_id: t.op.opId,
					error: String((e as any)?.message || e).slice(0, 200),
				});
			}
			aplicadas.push(t.op.opId);
			this.broadcastChange(
				{
					command: t.op.commandName,
					opId: t.op.opId,
					deviceId: t.op.deviceId || null,
					payloadJson: t.op.cloudPayloadJson,
					result,
					seq,
					statements: t.built.replicated,
				},
				t.op.deviceId || undefined,
			);
		}

		return { aplicadas, yaEstaban: [...yaAplicadas] };
	}

	/**
	 * Difunde, en orden de `Seq`, operaciones de la cola que ya estaban confirmadas. Una que no tenga
	 * línea en el log es una cuyo log ya se purgó, por debajo del checkpoint de todas las Main
	 * (SYNC-12): nada que difundir.
	 */
	private async difundirYaConfirmadas(db: Client, ops: OpParaAplicar[]): Promise<void> {
		const porId = new Map(ops.map((o) => [o.opId, o]));
		const r = await db.execute({
			sql: `SELECT Op_Id AS op_id, Seq AS seq, Statements_Json AS statements_json
			        FROM Sync_Changes WHERE Op_Id IN (SELECT value FROM json_each(?1))
			       ORDER BY Seq;`,
			args: [JSON.stringify(ops.map((o) => o.opId))],
		});
		for (const fila of (r.rows ?? []) as any[]) {
			const op = porId.get(String(fila.op_id ?? ""));
			const seq = Number(fila.seq ?? 0);
			if (!op || !(seq > 0)) continue;
			const statements = safeJsonParse(String(fila.statements_json ?? "[]"));
			this.broadcastChange(
				{
					command: op.commandName,
					opId: op.opId,
					deviceId: op.deviceId || null,
					payloadJson: op.cloudPayloadJson,
					result: null,
					seq,
					statements: Array.isArray(statements) ? statements : [],
				},
				op.deviceId || undefined,
			);
		}
	}

	// ---- SYNC-18: cola de entrada -----------------------------------------------------------
	//
	// ARQ-04: la maquinaria vive en `tenantHub.cola.ts`. Aquí sólo queda atarle el contexto y la
	// fachada por la que entra el resto de la clase. Lo que la cola necesita saber está escrito en
	// `ContextoDeCola`, y esa lista es justamente lo que impide que crezca sin que nadie lo vea.

	/**
	 * ⚠️ Envoltorios que leen `this.X` AL LLAMAR, nunca `.bind(this)`. Varios tests sustituyen un
	 * método de la instancia --qué base del tenant se usa, si hay Main conectada-- y con la
	 * referencia atada aquí esa sustitución dejaría de verse.
	 *
	 * Y no se guarda en un campo: no habría nada que ganar (esto no tiene estado) y sí un sitio
	 * donde alguien acabara metiéndolo, que es lo que el módulo de la cola no quiere tener.
	 */
	private ctxCola(): ContextoDeCola {
		return {
			storage: this.state.storage,
			waitUntil: (p) => this.state.waitUntil(p),
			applyBatchIdempotent: (db, ops) => this.applyBatchIdempotent(db, ops),
			withTenantDbRetry: (tenantId, run) => this.withTenantDbRetry(tenantId, run),
			maybePurgeSyncLog: (tenantId) => this.maybePurgeSyncLog(tenantId),
			colaPausada: (tenantId) => this.colaPausada(tenantId),
			isMainRecovering: () => this.isMainRecovering(),
			broadcastAuthed: (obj, except) => this.broadcastAuthed(obj, except),
			broadcastRol: (rol, obj) => this.broadcastRol(rol, obj),
			emitSyncEvent: (name, fields) => this.emitSyncEvent(name, fields),
		};
	}

	/**
	 * PROD-06: el interruptor `cola_do` de este tenant. Método y no lambda para que los tests
	 * puedan sustituirlo, como hacen con la base del tenant. No lanza: si la base central no
	 * contesta, la cola sigue drenando.
	 */
	private colaPausada(tenantId: string): Promise<{ hasta_ms: number } | null> {
		return estaApagado(() => getDb(this.env), tenantId, "cola_do");
	}

	private asegurarCola(): void {
		asegurarCola(this.ctxCola());
	}

	/** Cuántas operaciones esperan en la cola. Es el estado del que cuelga todo lo demás. */
	private cuantasEnCola(): number {
		return cuantasEnCola(this.ctxCola());
	}

	private encolar(tenantId: string, ops: OpParaAplicar[]): string[] {
		return encolar(this.ctxCola(), tenantId, ops);
	}

	private sacarDeLaCola(opIds: string[]): void {
		sacarDeLaCola(this.ctxCola(), opIds);
	}

	/** REV-04: las apartadas que ninguna Main ha acusado todavía. */
	private apartadasPendientes(): { opId: string; commandName: string; error: string }[] {
		return apartadasPendientes(this.ctxCola());
	}

	/** La Main ya lo ha anotado: la carta está entregada y la lápida sobra. */
	private olvidarApartadas(opIds: string[]): number {
		return olvidarApartadas(this.ctxCola(), opIds);
	}

	private async drenarCola(): Promise<void> {
		return drenarCola(this.ctxCola());
	}

	/**
	 * Único punto de entrada del drenado, y punto de entrada del runtime: por eso se queda en la
	 * clase. Lo que hace está en `cola.ciclo`, incluida la razón de que capture todo.
	 */
	async alarm(): Promise<void> {
		return ciclo(this.ctxCola());
	}


	// Reintento idempotente: la op ya existe (violación UNIQUE en el gate). Recuperamos el
	// resultado cacheado y el `seq` del log, validando que no haya mismatch de comando/payload.
	private async recoverAppliedOp(
		db: any,
		op: string,
		command: string,
		requestHash: string,
	): Promise<{ result: any; seq: number; statements: ResolvedStmt[] }> {
		const r = await db.execute({
			sql: `SELECT Command_Name AS command_name, Request_Hash AS request_hash, Result_Json AS result_json, Status AS status, Error_Text AS error_text FROM Applied_Operations WHERE Op_Id = ?1 LIMIT 1;`,
			args: [op],
		});
		const row = r.rows?.[0] as any | undefined;
		if (!row) throw new HubError("idempotency_operation_processing", 409);
		if (String(row.command_name || "") !== command) throw new HubError("idempotency_command_mismatch", 409);
		if (String(row.request_hash || "") !== requestHash) throw new HubError("idempotency_payload_mismatch", 409);
		const result = safeJsonParse(String(row.result_json ?? "null"));
		const { seq, statements } = await this.lookupChange(db, op);
		return { result, seq, statements };
	}

	// Recupera el `Seq` y las sentencias replicadas que el log de cambios asignó a una op ya
	// aplicada (reintentos idempotentes). Las sentencias permiten re-emitir el broadcast (SYNC-03).
	// Devuelve `{ seq: 0, statements: [] }` si no hay registro, lo que sólo pasa si la purga del log
	// ya se lo llevó (SYNC-12), por debajo del checkpoint de todas las Main activas.
	//
	// AUD-18: un error de lectura sale tal cual, y quien manda la operación lo vuelve a intentar.
	// Contestarle con `Seq` 0 le dejaba a la Main el anti-eco sin `Seq` (no se asciende) y fuera del
	// outbox: la purga TTL podía retirarlo antes de que volviera su eco, y entonces se aplicaba otra vez.
	private async lookupChange(
		executor: any,
		opId: string,
	): Promise<{ seq: number; statements: ResolvedStmt[] }> {
		const r = await executor.execute({
			sql: "SELECT Seq AS seq, Statements_Json AS statements_json FROM Sync_Changes WHERE Op_Id = ?1 ORDER BY Seq DESC LIMIT 1;",
			args: [opId],
		});
		const row = r.rows?.[0] as any | undefined;
		const seq = Number(row?.seq ?? 0);
		const parsed = safeJsonParse(String(row?.statements_json ?? "[]"));
		const statements: ResolvedStmt[] = Array.isArray(parsed) ? parsed : [];
		return { seq, statements };
	}

	/**
	 * Emite un evento de SALUD del sistema de sincronización a Axiom (dataset AXIOM_DATASET_SYNC).
	 * Fire-and-forget: la observabilidad jamás debe afectar al camino de escritura del sync, así que
	 * no se espera ni se propagan errores. No-op si Axiom no está configurado.
	 */
	private emitSyncEvent(name: string, fields: Record<string, unknown>): void {
		const dataset = this.env.AXIOM_DATASET_SYNC;
		if (!this.env.AXIOM_TOKEN || !dataset) return;
		try {
			const event = {
				_time: new Date().toISOString(),
				service: "tpv-sync",
				event: name,
				tenant_id: this.tenantIdVisto ?? undefined,
				connected_devices: this.authedCount(),
				main_connected: this.isMainConnected(),
				...fields,
			};
			// `state.waitUntil` y no `void`: un DO con hibernación puede evacuarse en cuanto deja de
			// tener trabajo registrado, y entonces la entrega se cancela a medio vuelo. Es lo que
			// hacía que estos eventos no llegaran nunca a Axiom.
			this.state.waitUntil(ingestToAxiom(this.env, dataset, [event]));
		} catch {
			/* la salud de sync es best-effort; nunca afecta al sync */
		}
	}

	private send(ws: WebSocket, obj: any) {
		try {
			ws.send(JSON.stringify(obj));
		} catch { }
	}

	private broadcast(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);
		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!a) continue;
			if (exceptDeviceId && a.deviceId === exceptDeviceId) continue;
			try {
				ws.send(msg);
			} catch { }
		}
	}

	/**
	 * Manda un mensaje solo a los sockets autenticados con un rol concreto.
	 *
	 * El rol sale del attachment (que lo fijó la BD central al autenticar, no una cabecera del
	 * cliente), así que esto NO es cosmética: un aviso dirigido a la Main no puede acabar en las
	 * Handy del local.
	 */
	private broadcastRol(rol: Role, obj: any) {
		const msg = JSON.stringify(obj);

		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!a || !a.authed) continue;
			if (a.role !== rol) continue;

			try {
				ws.send(msg);
			} catch { }
		}
	}

	private broadcastAuthed(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);

		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!a || !a.authed) continue;
			if (exceptDeviceId && a.deviceId === exceptDeviceId) continue;

			try {
				ws.send(msg);
			} catch { }
		}
	}

	/**
	 * Las sesiones de Main que cuentan: autenticadas y con el socket abierto. AUD-15: `getWebSockets`
	 * puede devolver un socket después de su `close` (en `CLOSING`), así que sin mirar `readyState`
	 * una sesión reemplazada seguiría autorizando —o congelando— a las Handy. Al reemplazarla se le
	 * quita además la autenticación en su attachment (`abrirWebSocket`), que sobrevive a la
	 * hibernación aunque el estado del socket no fuera fiable al despertar.
	 */
	private mainsAbiertas(except?: WebSocket): WsAttachment[] {
		const out: WsAttachment[] = [];
		for (const ws of this.state.getWebSockets()) {
			if (except && ws === except) continue;
			if (ws.readyState !== 1) continue;
			const a = this.att(ws);
			if (a?.authed && a.role === "tpv") out.push(a);
		}
		return out;
	}

	// ¿Hay alguna Main (rol tpv) autenticada y conectada ahora mismo?
	// `except` excluye un socket concreto: al procesar `webSocketClose` el socket que se va puede
	// seguir apareciendo en `getWebSockets()`, y sin excluirlo nunca detectaríamos el freeze.
	private isMainConnected(except?: WebSocket): boolean {
		return this.mainsAbiertas(except).length > 0;
	}

	/** Una Main en recuperación está conectada, pero aún no autoriza trabajo de las Handy. */
	private isMainReady(except?: WebSocket): boolean {
		return this.mainsAbiertas(except).some((a) => !a.recovering);
	}

	private isMainRecovering(): boolean {
		return this.mainsAbiertas().some((a) => a.recovering);
	}

	/** Nº de dispositivos autenticados ahora mismo (telemetría). */
	private authedCount(): number {
		let n = 0;
		for (const ws of this.state.getWebSockets()) {
			if (this.att(ws)?.authed) n++;
		}
		return n;
	}

	// Propaga un cambio aplicado (payload + resultado) a los dispositivos
	// autenticados, excluyendo al originador. Reemplaza la antigua señal
	// `cloud_changes_available` (modelo de refetch) por el envío directo del JSON.
	private broadcastChange(
		params: {
			command: string;
			opId: string;
			deviceId: string | null;
			payloadJson: string;
			result: any;
			seq: number;
			statements: ResolvedStmt[];
		},
		exceptDeviceId?: string,
	) {
		this.broadcastAuthed(
			{
				type: "change",
				command: params.command,
				opId: params.opId,
				deviceId: params.deviceId,
				payload: safeJsonParse(params.payloadJson),
				result: params.result ?? null,
				// Opción 3: sentencias ya resueltas + cursor, para que la Main las aplique
				// directamente a su SQLite local (y sepa su checkpoint).
				seq: params.seq,
				statements: params.statements,
				ts: nowMs(),
			},
			exceptDeviceId,
		);
	}

	/**
	 * ARQ-04: las reglas del handshake viven en `tenantHub.identidad.ts`; aquí sólo se les ata la
	 * base central, que es lo único que la clase aporta. Sigue siendo un método porque es la
	 * costura por la que un test sustituye la verificación de la firma cuando lo que prueba es
	 * otra cosa (`volcadoWs.test.ts`): sin ella habría que firmar de verdad para comprobar un
	 * mensaje de estado.
	 */
	private async verifyHelloSigned(params: {
		tenantId: string;
		deviceId: string;
		msg: HelloSignedMsg;
		challenge: { nonceB64: string; expiresAtMs: number } | null;
		pubkeyB64Hint?: string | null;
	}): Promise<{ roleFinal: Role; pubkeyB64: string }> {
		// `return await` y no `return` a secas: `verifyHelloSigned` rechaza ANTES de su primer
		// `await` cuando el saludo es inválido, y devolverla sin esperar engancha el manejador un
		// microtask tarde. workerd da la promesa por no manejada en ese hueco y cada saludo
		// rechazado dejaba además un «unhandled rejection» en los logs, aunque quien llama sí lo
		// captura. Mismo arreglo en `tenantHubHello.test.ts`, donde rompía el CI.
		return await verifyHelloSigned({
			...params,
			cargarDispositivo: (tenantId, deviceId) =>
				loadDeviceFromCentral(this.getCentralDb(), tenantId, deviceId),
		});
	}

	/**
	 * ARQ-04: las rutas viven en `tenantHub.rutas.ts`. Aquí queda el reparto, que es lo que sí es
	 * de la clase: un `fetch` es un punto de entrada del runtime.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const ctx = this.ctxRutas();


		if (url.pathname !== "/ws") {
			return new Response("Not found", { status: 404 });
		}

		if (!esUpgradeDeWebSocket(request)) {
			return new Response("Expected WebSocket", { status: 426 });
		}

		return abrirWebSocket(ctx, request);
	}

	async aplicar(params: ApplyParams): Promise<ResultadoAplicacion> {
		return aplicar(this.ctxRutas(), params);
	}

	/**
	 * Una ruta de negocio entera, ejecutada aquí (`lib/enElHub.ts`): la misma `app` que sirve el
	 * Worker, con la identidad que ya comprobó él. Sus lecturas van al SQLite de este DO y sus
	 * escrituras a `aplicar`, sin RPC: la petición cuesta un viaje, el que la ha traído.
	 */
	async ejecutarRuta(peticion: Request, identidad: IdentidadDelWorker): Promise<Response> {
		const ctxEjecucion = {
			waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p),
			passThroughOnException: () => undefined,
			props: {},
		} as unknown as ExecutionContext;
		return dentroDelHub(
			{
				identidad,
				base: () => this.getTenantDb(identidad.tenantId),
				aplicar: (params) => aplicar(this.ctxRutas(), params),
			},
			async () => app.fetch(peticion, this.env, ctxEjecucion),
		);
	}

	revocarDispositivo(deviceId: string): void {
		revocar(this.ctxRutas(), deviceId);
	}

	avisarEmparejamiento(): void {
		avisoDePairing(this.ctxRutas());
	}

	avisarReservasWeb(): void {
		avisoDeReservasWeb(this.ctxRutas());
	}

	/** ⚠️ Envoltorios que leen `this.X` AL LLAMAR, nunca `.bind(this)`. Ver `ctxCola`. */
	private ctxRutas(): ContextoDeRutas {
		return {
			att: (ws) => this.att(ws),
			setAtt: (ws, att) => this.setAtt(ws, att),
			send: (ws, obj) => this.send(ws, obj),
			broadcast: (obj, except) => this.broadcast(obj, except),
			broadcastRol: (rol, obj) => this.broadcastRol(rol, obj),
			liveSocketsFor: (deviceId, except) => this.liveSocketsFor(deviceId, except),
			sessionGone: (ws, a) => this.sessionGone(ws, a),
			aceptarWebSocket: (ws, tags) => this.state.acceptWebSocket(ws, tags),
			waitUntil: (p) => this.state.waitUntil(p),
			touchLastSeen: (tenantId, deviceId, force) =>
				this.touchLastSeen(tenantId, deviceId, force),
			applyInternalCommandIdempotent: (params) =>
				this.applyInternalCommandIdempotent(params),
		};
	}


	// ---- SYNC-16: handlers de la Hibernation API --------------------------------------------
	// Sustituyen a los antiguos `server.addEventListener(...)`. Al despertar de la hibernación la
	// instancia es NUEVA (campos vacíos, sin closures), así que el runtime invoca estos métodos y
	// todo el contexto de la sesión se recupera del attachment del socket.

	/**
	 * ARQ-04: las ramas viven en `tenantHub.mensajes.ts`. Aquí sólo se ata el contexto; el ORDEN
	 * --y con él el gate de autenticación-- lo guarda `despachar`.
	 */
	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		return despachar(this.ctxMensajes(), ws, message);
	}

	/**
	 * ⚠️ Envoltorios que leen `this.X` AL LLAMAR, nunca `.bind(this)`. Es lo mismo que en
	 * `ctxCola`, y por lo mismo: varios tests sustituyen un método de la instancia --la
	 * verificación de la firma, si hay Main conectada-- y con la referencia atada aquí esa
	 * sustitución dejaría de verse.
	 */
	private ctxMensajes(): ContextoDeMensajes {
		return {
			att: (ws) => this.att(ws),
			setAtt: (ws, att) => this.setAtt(ws, att),
			send: (ws, obj) => this.send(ws, obj),
			broadcast: (obj, except) => this.broadcast(obj, except),
			broadcastAuthed: (obj, except) => this.broadcastAuthed(obj, except),
			emitSyncEvent: (name, fields) => this.emitSyncEvent(name, fields),
			waitUntil: (p) => this.state.waitUntil(p),
			touchLastSeen: (tenantId, deviceId, force) =>
				this.touchLastSeen(tenantId, deviceId, force),
			verifyHelloSigned: (params) => this.verifyHelloSigned(params),
			isMainConnected: (except) => this.isMainConnected(except),
			isMainRecovering: () => this.isMainRecovering(),
			cuantasEnCola: () => this.cuantasEnCola(),
			encolar: (tenantId, ops) => this.encolar(tenantId, ops),
			apartadasPendientes: () => this.apartadasPendientes(),
			olvidarApartadas: (opIds) => this.olvidarApartadas(opIds),
			applyInternalCommandIdempotent: (params) =>
				this.applyInternalCommandIdempotent(params),
			withTenantDbRetry: (tenantId, run) => this.withTenantDbRetry(tenantId, run),
		};
	}


	/**
	 * Contabilidad de una sesión que se va: presencia + freeze. Se invoca desde `webSocketClose`
	 * (cierre del cliente / caída de red) y TAMBIÉN de forma explícita en los cierres que inicia el
	 * servidor (revoke), porque la documentación de Cloudflare no garantiza que `webSocketClose` se
	 * dispare cuando el cierre lo provoca el propio DO. Es **idempotente y auto-inhibida**: si queda
	 * otro socket vivo del mismo dispositivo no hace nada, y repetirla solo reemite señales que el
	 * cliente ya trata como idempotentes.
	 */
	private sessionGone(ws: WebSocket, a: WsAttachment): void {
		const { deviceId } = a;

		// Si ya nos reemplazó una reconexión bajo el mismo deviceId, no dispares presencia ni
		// main_offline en falso: la sesión nueva sigue viva.
		if (this.liveSocketsFor(deviceId, ws).length > 0) return;

		const wasMain = a.role === "tpv";

		this.lastSeenPushedAtMs.delete(deviceId);
		this.broadcast({ type: "presence", action: "leave", deviceId }, deviceId);

		// Si se va la Main y no queda ninguna conectada, congelamos todo: las
		// Handy reciben main_offline y deben bloquear su UI hasta que vuelva.
		// `ws` se excluye explícitamente del censo: un socket cerrándose puede seguir apareciendo
		// en `getWebSockets()` y nos haría creer que la Main sigue ahí.
		if (wasMain && !this.isMainConnected(ws)) {
			this.broadcast({ type: "main_offline", deviceId }, deviceId);
			this.emitSyncEvent("main_offline", { device_id: deviceId });
		}
	}

	async webSocketClose(
		ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const a = this.att(ws);
		if (!a) return;
		this.sessionGone(ws, a);
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		const a = this.att(ws);
		try {
			ws.close(1011, "ws_error");
		} catch { }
		// Cierre iniciado por el servidor → contabilizamos la salida nosotros (ver `sessionGone`).
		if (a) this.sessionGone(ws, a);
	}
}
