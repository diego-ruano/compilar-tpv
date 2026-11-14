import type { Env } from "../env";
import { HubError } from "../lib/errorHttp";
import { forbidden, json, serverError } from "../server/utils/response";
import type { Client } from "@libsql/client/web";
import { createDbClient } from "../server/db/clients";
import { ingestToAxiom } from "../observability/axiom";
import { capturarError } from "../observability/errors";
import { bytesUtf8 } from "../observability/tope";
import { PURGADO_HASTA } from "../domains/sync/cambiosJson";

import { safeJsonParse, sha256Hex, stringifyJsonValue } from "./tenantHub.envelope";
import { mainDeLaLicencia, verifyHelloSigned } from "./tenantHub.identidad";
import { loteDe, type EscrituraPreparada } from "./tenantHub.lote";
import {
	aplicarLectura,
	empezarLectura,
	mainVigente,
	olvidarComprobacion,
	tocaComprobar,
} from "./tenantHub.main";
import type { MainVigente } from "./tenantHub.main";
import { apuntarNegocio, negocioApuntado } from "./tenantHub.negocio";
import type { ContextoDeMensajes } from "./tenantHub.mensajes";
import { despachar } from "./tenantHub.mensajes";
import type { ApplyParams, IdentidadDelWorker, ResultadoAplicacion } from "./tenantHub.rpc";
import {
	leerConLaHoraDelNegocio,
	type LecturaWeb,
	type RespuestaDeLecturaWeb,
} from "../domains/reservas_web/lecturasDeLaWeb";
import { app } from "../app";
import { dentroDelHub } from "../lib/hubLocal";
import {
	baseAprovisionada,
	clienteLocal,
	HaceFaltaAplazar,
	loteEnBruto,
	type FilasEnBruto,
	migrarBaseLocal,
} from "./tenantHub.sqlite";
import { sembrarAdminInicial } from "./tenantHub.alta";
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
import { esBaseLlena, esFalloPasajero, esRechazoPermanente } from "./tenantHub.errores";
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
	OpDeLote,
	ResolvedStmt,
	Role,
	VeredictoDeLote,
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

// AUD-02: plazo de la lectura que pone al día quién es la Main (`mainEnCentral`). Es una consulta
// por índice, de milisegundos; puede ir delante de una escritura o dentro del turno del log, la
// Main espera su `apply_ack` 10 s, y una base central colgada no puede comerse esa espera. Vencido,
// es una lectura que no ha contestado: la tabla se queda como estaba.
const PLAZO_LEER_MAIN_MS = 5_000;

// ---- El lote de la Main (`apply_lote`) -------------------------------------
// Un lote se aplica entero en un turno, sin ceder el control, así que lo que cabe en él se mide en
// TRABAJO y no en tiempo: en producción el reloj no avanza mientras el objeto consume CPU, y un
// tope en milisegundos no saltaría nunca. Lo que pasa del tope no se toca (`noIntentada`) y la Main
// lo vuelve a mandar en el lote siguiente. La primera operación se intenta siempre.
const LOTE_MAX_OPS = 200; // las que manda la Main de una vez (`replicacion.rs`)
const LOTE_MAX_BYTES = 512 * 1024; // de SQL y argumentos, en UTF-8; la Main corta a 256 KB
// Las que sólo entran aplazando las claves foráneas (o traen una rota): cada una recorre las tablas
// con FK antes de cerrar (`loteEnBruto`), unos 230 ms con 250.000 líneas.
const LOTE_MAX_APLAZADAS = 3;

/** Una operación de un lote, lista para aplicarse: validada, con la hora fijada y sus sentencias. */
type LotePreparado = { escritura: EscrituraPreparada; lote: ReturnType<typeof loteDe> };


/** Dónde anota el objeto la última baja de cada dispositivo (`revocarDispositivo`). */
const CLAVE_REVOCADO = "revocado:";
/** Holgura entre el reloj del Worker que canjea el ticket y el del objeto que anota la baja. */
const MARGEN_CANJE_MS = 5_000;

export class MotorTenantHub {
	// SYNC-16: este DO usa la WebSocket Hibernation API. Mientras las conexiones están ociosas el
	// runtime evacúa el objeto de memoria (deja de facturar duración) y lo despierta al llegar un
	// mensaje real. Consecuencia de diseño: NO puede haber estado de sesión en campos de instancia.
	//   · lo que describe a un socket        → su attachment (`WsAttachment`)
	//   · el censo de conexiones             → `state.getWebSockets()` (etiquetadas por deviceId)
	// Lo único que queda abajo son cachés best-effort que pueden perderse sin consecuencias.
	// Tampoco hay `alarm`: nada se deja para después, y un negocio parado no despierta al objeto.

	// SYNC-08: último `last_seen` empujado a la BD central por dispositivo (throttle en memoria).
	// Se pierde al hibernar: como mucho provoca un UPDATE extra tras despertar. Aceptable.
	private lastSeenPushedAtMs = new Map<string, number>();
	// SYNC-12: instante de la última purga del log de sync (throttle en memoria del DO).
	private lastPurgeAtMs = 0;

	private centralDb: Client | null = null;

	// La base del negocio es el SQLite de este DO. El cliente se monta una vez por
	// instancia, tras comprobar que el negocio está aprovisionado y su esquema al día.
	private baseLocal: Client | null = null;
	// El negocio de este DO para las trazas de un objeto que todavía no lo tiene apuntado (sin base):
	// lo dice la primera petición que llega. Con base, manda el apuntado (`negocioParaTrazas`).
	private tenantIdVisto: string | null = null;
	// Lo que ya se ha avisado desde esta instancia (`avisarUnaVez`): una avería de la base del
	// negocio la ve cada petición, y con un aviso basta. Se pierde al hibernar: vuelve a avisar.
	private avisados = new Set<string>();

	// AUD-18: la cola de lo que está confirmando y difundiendo ahora mismo (ver `enTurnoDelLog`). Es
	// lo que está en vuelo, no algo que recordar entre invocaciones: el DO sólo hiberna sin nada en
	// vuelo, así que al despertar vacía es lo correcto (SYNC-16, regla 4).
	private turnoDelLog: Promise<void> = Promise.resolve();

	// AUD-02: la cola de lo que la Main manda por el socket y entra en el acto (`apply` y
	// `apply_lote`, ver `enTurnoDeEntrada`). Como el turno del log, es lo que está en vuelo y nada
	// más: lo que se pierda al descartar la instancia no tenía respuesta todavía, y la Main lo vuelve
	// a mandar.
	private turnoDeEntrada: Promise<void> = Promise.resolve();

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

	private getCentralDb(plazoMs?: number): Client {
		// AUD-02: con plazo, un cliente que vive lo que su lectura. No se guarda: el plazo es de
		// quien lo pide, y las demás lecturas de la base central siguen sin él.
		if (plazoMs) {
			return createDbClient({
				url: this.env.TURSO_DATABASE_URL,
				authToken: this.env.TURSO_AUTH_TOKEN,
				plazoMs,
			});
		}
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
		try {
			await this.migrarEnExclusiva();
		} catch (causa) {
			throw this.migracionFallida(causa);
		}
		this.baseLocal = clienteLocal(storage);
		return this.baseLocal;
	}

	/**
	 * Pone al día el esquema de la base sin que nada más corra en el objeto entretanto.
	 *
	 * El runner apaga las claves foráneas alrededor de la tanda (`migrarBaseLocal`) y para volver a
	 * encenderlas tiene que esperar: sin esto, otra petición podría escribir con ellas apagadas, sin
	 * que se comprobaran y sin que sus cascadas se ejecutaran. `blockConcurrencyWhile` no entrega
	 * ningún otro evento al objeto hasta que su cuerpo acaba; como resetea el objeto si el cuerpo
	 * lanza, el fallo sale como dato. Tiene 30 s: una migración que reconstruya una tabla grande
	 * tiene que caber ahí.
	 */
	private async migrarEnExclusiva(): Promise<void> {
		const storage = this.state.storage;
		const fallo = await this.state.blockConcurrencyWhile(async () => {
			try {
				await migrarBaseLocal(storage);
				return null;
			} catch (error) {
				return { error };
			}
		});
		if (!fallo) return;
		// Si las claves foráneas se hubieran quedado apagadas, el siguiente acceso lo vuelve a mirar
		// antes de servir nada.
		this.baseLocal = null;
		throw fallo.error;
	}

	/**
	 * La base del negocio no ha podido ponerse al día. Hasta que alguien lo arregle fallará cada
	 * petición de este negocio, así que se avisa una vez por instancia (`avisarUnaVez`) y lo que ve
	 * quien pregunta es un 503 con nombre, no un 500 con el texto de SQLite por clasificar. Para una
	 * operación de la Main es pasajero (`tenantHub.errores.ts`): no se aparta por ello.
	 *
	 * Una migración ya aplicada que ha cambiado conserva su código, que está en el catálogo
	 * (`tenant_migration_altered`).
	 */
	private migracionFallida(causa: unknown): HubError {
		this.avisarUnaVez("migracion_fallida", causa, "tenant_db.migration");
		if (causa instanceof HubError && causa.code === "migration_altered") return causa;
		return new HubError("tenant_db_migration_failed", 503);
	}

	private async withTenantDbRetry<T>(
		tenantId: string,
		run: (db: Client) => Promise<T>,
	): Promise<T> {
		return run(await this.getTenantDb(tenantId));
	}

	/**
	 * El alta del negocio: crea su esquema y, si la base nace vacía, su administrador inicial
	 * (`tenantHub.alta.ts`). Es idempotente: con la base ya creada sólo aplica las migraciones
	 * pendientes, y dice que ya estaba (`reused`).
	 */
	async aprovisionar(tenantId: string): Promise<{ reused: boolean }> {
		if (!tenantId) throw new HubError("missing_tenant_id", 400);
		const ajeno = this.negocioAjeno(tenantId, "aprovisionar");
		if (ajeno) throw ajeno;
		this.tenantIdVisto ??= tenantId;
		const storage = this.state.storage;
		const reused = baseAprovisionada(storage.sql);
		await this.migrarEnExclusiva();
		// DO-NEGOCIO: el objeto queda con su negocio apuntado desde que tiene base.
		apuntarNegocio(storage, tenantId);
		await sembrarAdminInicial(storage);
		this.baseLocal = clienteLocal(storage);
		return { reused };
	}

	estaAprovisionado(): boolean {
		return baseAprovisionada(this.state.storage.sql);
	}

	// ---- DO-NEGOCIO: de qué negocio es este objeto ------------------------------------------
	//
	// El negocio se apunta en el alta, en el sello de la base (`tenantHub.negocio.ts`), y toda
	// llamada que trae uno se contrasta con él antes de hacer nada: `ejecutarRuta`, `aplicar`,
	// `leerParaLaWeb`, `aprovisionar`, `releerMain` y la apertura del WebSocket. El Worker ya llega
	// al objeto por el nombre del negocio, así que en condiciones normales esto no decide nada: es
	// la segunda comprobación, y si salta es un fallo del programa.

	/**
	 * ¿Trae esta llamada el negocio de otro objeto? Devuelve el error con el que se rechaza, o
	 * `null` si el negocio es el de éste.
	 *
	 * - **Con negocio apuntado**, cualquier otro (también uno vacío) se rechaza con `negocio_ajeno`
	 *   (500): va a Sentry, una vez por instancia, y a Axiom cada vez, con la operación.
	 * - **Con base y sin negocio apuntado** (un objeto dado de alta antes de que se apuntara), la
	 *   base se queda con el de la primera llamada que llegue. Esa llamada viene del Worker, que
	 *   ha encontrado el objeto por ese mismo nombre; dentro no hay nada más con lo que contrastarlo.
	 * - **Sin base** no hay nada que guardar: la llamada sigue, y contestará que no hay base o la
	 *   creará (`aprovisionar`), que es quien apunta el negocio.
	 */
	private negocioAjeno(tenantId: string, operacion: string): HubError | null {
		const storage = this.state.storage;
		const propio = negocioApuntado(storage);
		if (propio === null) {
			if (apuntarNegocio(storage, tenantId)) this.emitSyncEvent("negocio_adoptado", { operacion });
			return null;
		}
		if (propio === tenantId) return null;

		const error = new HubError("negocio_ajeno", 500);
		if (!this.avisados.has("negocio_ajeno")) {
			this.avisados.add("negocio_ajeno");
			capturarError(error, "hub.negocio_ajeno");
		}
		this.emitSyncEvent("negocio_ajeno", { operacion, recibido: tenantId });
		return error;
	}

	/** El negocio que llevan los eventos de salud: el apuntado y, sin base, el de la última llamada. */
	private negocioParaTrazas(): string | undefined {
		return negocioApuntado(this.state.storage) ?? this.tenantIdVisto ?? undefined;
	}

	/**
	 * Una lectura de la agenda de reservas web o de la API pública de la reserva, entera, con la base al
	 * lado (`domains/reservas_web/lecturasDeLaWeb.ts`): un viaje por lectura, no uno por consulta. Sólo
	 * lee. Un fallo con status decidido (la base sin aprovisionar) viaja como dato, porque el RPC no
	 * conserva las propiedades de un `HubError`; un error de SQL, como excepción, con su mensaje.
	 *
	 * No pasa por el turno del log: el SQL del DO es síncrono, así que ve lo confirmado o lo que otra
	 * petición acaba de escribir en este mismo DO, nunca una escritura a medias.
	 */
	async leerParaLaWeb(tenantId: string, lectura: LecturaWeb): Promise<RespuestaDeLecturaWeb> {
		try {
			const ajeno = this.negocioAjeno(tenantId, "leerParaLaWeb");
			if (ajeno) throw ajeno;
			return { ok: true, valor: await leerConLaHoraDelNegocio(await this.getTenantDb(tenantId), lectura) };
		} catch (e) {
			if (e instanceof HubError) {
				return { ok: false, code: e.code, status: e.status, details: e.details };
			}
			throw e;
		}
	}

	/**
	 * Retirar un negocio de pruebas: todo lo que este objeto guarda de él.
	 *
	 * - **Las sesiones vivas se cierran primero**, por `cerrar` como todo cierre que inicia el DO: quedan
	 *   fuera y su salida se contabiliza con la tabla de quién es la Main todavía delante. Una Main o
	 *   una Handy que siguiera conectada no puede seguir escribiendo en una base recién vaciada.
	 * - **`deleteAll`** se lleva la base del negocio y la tabla de la Main.
	 *
	 * Después el objeto no vuelve a hacer nada por su cuenta (no tiene temporizadores ni alarma), y el
	 * cierre de esos sockets, que llega más tarde, es de sesiones que ya están fuera (`cerrar`,
	 * `webSocketClose`). Lo que estuviera esperando su turno tampoco escribe: toda escritura vuelve
	 * a mirar, justo antes de aplicarse, que haya una Main conectada (un lote, que su sesión siga
	 * siendo la de la Main), y ya no la hay.
	 */
	async borrarTodo(): Promise<void> {
		for (const ws of this.state.getWebSockets()) {
			this.cerrar(ws, this.att(ws), 4001, "negocio_retirado");
		}
		await this.state.storage.deleteAll();
		this.baseLocal = null;
		this.lastSeenPushedAtMs.clear();
		this.lastPurgeAtMs = 0;
		this.avisados.clear();
	}

	private async touchLastSeen(tenantId: string, deviceId: string) {
		// SYNC-08: sin throttle, cada ping (30 s) por dispositivo escribía en la BD central →
		// amplificación de escrituras proporcional al nº de dispositivos. Guardamos en memoria del
		// DO el último instante empujado y solo re-escribimos pasada la ventana. La precisión de
		// `last_seen` no necesita ser al segundo.
		// SYNC-16: el ping ya NO llega hasta aquí (lo contesta el auto-response sin despertar al DO),
		// así que esto se alimenta de la actividad real (apply/event). Al conectar lo apunta el Worker,
		// en el mismo lote que canjea el ticket, y el upgrade sólo marca el instante (`vistoAhora`). El
		// throttle en memoria se pierde al hibernar → como mucho un UPDATE extra por despertar.
		const now = nowMs();
		const last = this.lastSeenPushedAtMs.get(deviceId) ?? 0;
		if (now - last < LAST_SEEN_THROTTLE_MS) return;
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
				// después, así que basta un TTL (independiente del checkpoint) para acotarla.
				await db.execute({
					sql: `DELETE FROM Applied_Operations WHERE Created_At_Ms < ?1;`,
					args: [now - APPLIED_OPS_TTL_MS],
				});
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
	 * `aplicarLote`) van dentro; (2) el `Seq` lo asigna el commit, que acaba antes de soltar
	 * el turno, y la difusión va justo después; (3) un WebSocket entrega en orden, y el catch-up de
	 * cada conexión de la Main va después de autenticarse, así que lo confirmado antes le llega por
	 * REST y lo posterior por el socket.
	 *
	 * Nada de temporizadores ni de estado que deba sobrevivir (SYNC-16): es una cadena de promesas de
	 * lo que está en vuelo, y un fallo no la rompe para el siguiente.
	 *
	 * AUD-02: `alReservar` se llama en cuanto el trabajo tiene sitio en la cadena, antes de que
	 * empiece. Es lo que espera la fila de entrada de la Main (`enTurnoDeEntrada`) para soltar al
	 * siguiente `apply` o `apply_lote`: a partir de ahí el orden en que se confirman ya está fijado.
	 */
	private enTurnoDelLog<T>(trabajo: () => Promise<T>, alReservar?: () => void): Promise<T> {
		const resultado = this.turnoDelLog.then(trabajo);
		this.turnoDelLog = resultado.then(
			() => undefined,
			() => undefined,
		);
		alReservar?.();
		return resultado;
	}

	// ---- AUD-02: quién es la Main -----------------------------------------------------------
	//
	// El rol `tpv` de una sesión dice que el equipo se activó como Main; que lo SIGA siendo lo dice
	// la licencia, en la base central, y puede cambiar con el socket abierto (un traslado, una
	// anulación, un reembolso). Quién lo es ahora está apuntado en el SQL del DO
	// (`tenantHub.main.ts`), y todo lo que depende de ello lo mira ahí, sin esperar a nadie:
	// `esLaMain`. Las lecturas de la base central sólo ponen la tabla al día, y lo hacen por un único
	// sitio, `fijarMain`, que en el mismo paso echa a la sesión `tpv` que ha dejado de serlo.
	//
	// La tabla se pone al día: (a) en el saludo de un `tpv` (`leerMain`); (b) cuando hay trabajo y
	// hace más de un minuto de la última lectura (`comprobarMain`); y (c) cuando las rutas avisan de
	// que la licencia ha cambiado (`releerMain`: un traslado, una anulación, un reembolso), que no
	// echa a nadie por su cuenta: vuelve a leer. Si la base central no contesta, la tabla se queda
	// como está.

	/** AUD-02 · Quién es la Main ahora mismo, según la tabla del DO. No espera. */
	private mainVigente(): MainVigente {
		return mainVigente(this.state.storage);
	}

	/**
	 * AUD-02 · ¿Es esta sesión la de la Main? Autenticada, no echada, de un `tpv`, y del dispositivo
	 * que la tabla dice que es la Main. Es síncrono a propósito: se llama justo antes de actuar,
	 * después de la última espera, y entre la pregunta y el acto no cabe nada.
	 *
	 * Si la tabla dice que no hay Main (la licencia está anulada), ninguna sesión lo es.
	 *
	 * Si no se ha leído nunca, lo es cualquier sesión `tpv` autenticada, como antes de que hubiera
	 * tabla. Sólo puede pasar con una sesión que saludó antes de que existiera (el saludo de un `tpv`
	 * siempre la lee, y sin respuesta no entra), y dura hasta la primera comprobación por actividad,
	 * que la lee y echa a la que no lo sea. Sin esto, una sesión así se quedaría sin poder soltar a las
	 * Handy ni escribir en vivo, que deciden con la tabla sin leerla.
	 */
	private esLaMain(a: WsAttachment | null, vigente: MainVigente = this.mainVigente()): boolean {
		if (!a?.authed || a.fuera || a.role !== "tpv") return false;
		if (!vigente.leida) return true;
		return vigente.deviceId !== null && a.deviceId === vigente.deviceId;
	}

	/**
	 * AUD-02 · Apunta quién es la Main según la lectura `lectura`, y echa a toda sesión `tpv` que no
	 * sea de ese dispositivo. Es el único sitio donde cambia la tabla y el único que echa por este
	 * motivo; las dos cosas van juntas y sin esperas, así que nunca hay dentro una sesión `tpv`
	 * autenticada que la tabla no reconozca.
	 *
	 * Si ya se apuntó una lectura que empezó después, ésta no cuenta: ni toca la tabla ni echa a
	 * nadie (`aplicarLectura`).
	 */
	private fijarMain(lectura: number, deviceId: string | null): void {
		if (!aplicarLectura(this.state.storage, lectura, deviceId)) return;

		const motivo = deviceId ? "device_replaced" : "license_revoked";
		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!a?.authed || a.fuera || a.role !== "tpv" || a.deviceId === deviceId) continue;
			this.emitSyncEvent("main_expulsada", { device_id: a.deviceId, motivo });
			this.cerrar(ws, a, 4001, motivo);
		}
	}

	/**
	 * AUD-02 · Lo que dice ahora la base central: la Main de la licencia viva, o `null`. Método, y
	 * no una lambda del contexto, para que un test lo sustituya, como `verifyHelloSigned`.
	 *
	 * Con plazo, porque puede ir delante de una escritura o dentro del turno del log y no puede
	 * retenerlos. Lanza si no hay respuesta.
	 */
	private async mainEnCentral(tenantId: string): Promise<string | null> {
		return await mainDeLaLicencia(this.getCentralDb(PLAZO_LEER_MAIN_MS), tenantId);
	}

	/**
	 * AUD-02 · Una lectura de la base central, numerada al empezar, y su respuesta apuntada
	 * (`fijarMain`). Lanza si la base central no contesta o rechaza la consulta, sin tocar la tabla:
	 * es la lectura del saludo de un `tpv`, que sin respuesta no puede entrar.
	 */
	private async leerMain(tenantId: string): Promise<void> {
		const lectura = empezarLectura(this.state.storage);
		const main = await this.mainEnCentral(tenantId);
		this.fijarMain(lectura, main);
	}

	/**
	 * AUD-02 · La comprobación por actividad: si hay dentro alguna sesión `tpv` y hace más de un
	 * minuto de la última lectura, pregunta a la base central. Devuelve la lectura en marcha, para
	 * quien quiera esperarla antes de decidir, o `null` si no toca.
	 *
	 * - Una vez por minuto y por negocio, haya los mensajes que haya: quien pregunta se queda la
	 *   marca antes de esperar (`tocaComprobar`), y los demás siguen con lo que dice la tabla. Lo
	 *   que se decide mientras esa lectura está en vuelo se decide, por tanto, con la tabla de antes;
	 *   menos lo que espera en el turno del log detrás de quien pregunta, que sale después.
	 * - Sin sesiones `tpv` dentro no hay a quién echar ni nadie que cuente como Main: no se pregunta.
	 * - No lanza. Si la base central no contesta o rechaza la consulta, queda registrado, la tabla
	 *   se queda como está y nadie se queda fuera por ello; se vuelve a preguntar al minuto.
	 * - Ni temporizador ni alarma (SYNC-16): un negocio parado no pregunta.
	 */
	private comprobarMain(): Promise<void> | null {
		const tenantId = this.tenantConSesionTpv();
		if (!tenantId) return null;
		if (!tocaComprobar(this.state.storage)) return null;
		return this.leerMain(tenantId).catch((e) => {
			capturarError(e, "sync.main_vigente");
		});
	}

	/** AUD-02 · El negocio de este hub, si hay dentro una sesión `tpv` por la que preguntar. */
	private tenantConSesionTpv(): string | null {
		for (const ws of this.state.getWebSockets()) {
			if (ws.readyState !== 1) continue;
			const a = this.att(ws);
			if (a?.authed && !a.fuera && a.role === "tpv") return a.tenantId;
		}
		return null;
	}

	/**
	 * AUD-02 · Un aviso para la Main (una solicitud de emparejamiento, una reserva de la web) también
	 * es actividad: si toca preguntar quién es la Main, sale después de la respuesta. Si no toca,
	 * sale en el acto.
	 */
	private trasComprobarMain(avisar: () => void): void {
		const comprobando = this.comprobarMain();
		if (!comprobando) return avisar();
		this.state.waitUntil(comprobando.then(avisar));
	}

	/**
	 * AUD-02 · Las lecturas de la base central que piden las rutas cuando cambia la licencia del
	 * negocio (un traslado, una anulación, un reembolso: `lib/hub.ts::avisarCambioDeLicencia`).
	 *
	 * No echa a nadie por su cuenta: vuelve a leer quién es la Main, y `fijarMain` echa a la sesión
	 * `tpv` que no lo sea. Así un aviso que llega tarde no hace daño: si entretanto la licencia volvió
	 * a la Main que nombraba (B→A→B), la lectura dice B y B sigue dentro; y si dos avisos se cruzan,
	 * manda la lectura que empezó después, como siempre.
	 *
	 * Lee siempre, también sin ninguna sesión `tpv` autenticada dentro: puede haber un saludo a medias
	 * cuya lectura salió antes del cambio y todavía no ha vuelto. Esta lectura empieza después, así que
	 * su respuesta prevalece, y el saludo, que decide con la tabla, no entra (`fijarMain`). Por eso el
	 * negocio llega con el aviso (`tenantId`) y no se saca de las sesiones.
	 *
	 * Si la base central no contesta, la tabla se queda como está, queda registrado y la siguiente
	 * actividad vuelve a preguntar sin esperar al minuto.
	 */
	async releerMain(tenantId: string): Promise<void> {
		const ajeno = this.negocioAjeno(tenantId, "releerMain");
		if (ajeno) throw ajeno;
		olvidarComprobacion(this.state.storage);
		if (!tenantId) return;
		try {
			await this.leerMain(tenantId);
		} catch (e) {
			capturarError(e, "sync.main_vigente");
			olvidarComprobacion(this.state.storage);
		}
	}

	/**
	 * AUD-02 · Una ruta que llega de un `tpv` (`ejecutarRuta`): ¿sigue siendo ese equipo la Main?
	 * Devuelve el identificador con el que se rechaza, el mismo que da el veto de licencia del Worker
	 * (`lib/licenciaEnUso.ts`), o `null` si puede pasar.
	 *
	 * El Worker ya lo ha comprobado, pero guarda su respuesta un minuto por isolate: en ese minuto, el
	 * equipo al que se le ha trasladado o anulado la licencia todavía llega hasta aquí. La tabla del
	 * hub se pone al día en el acto con el aviso del cambio (`releerMain`), así que aquí se le para.
	 *
	 * - **Todas las rutas de un `tpv`, no una lista.** Es lo que rechaza el veto del Worker: una Main
	 *   que ha dejado de serlo no escribe ni tampoco lee el negocio. Y una ruta nueva queda cubierta
	 *   sin acordarse de nada.
	 * - **Una Handy no pasa por aquí**: nunca es la Main, y su licencia la mira el Worker.
	 * - **Si la tabla no se ha leído nunca, pasa**: no hay nada que contradiga al Worker, igual que
	 *   con las sesiones (`esLaMain`).
	 * - **Si la tabla dice que la Main es otro equipo, se pregunta a la base central antes de
	 *   rechazar.** El Worker acaba de dar por bueno a éste, y una de las dos cosas está atrasada: su
	 *   caché de un minuto, o la tabla, si el aviso del traslado no llegó (es best-effort). Sin esa
	 *   lectura, el equipo NUEVO de un traslado cuyo aviso se perdió se quedaría fuera hasta saludar
	 *   por el socket, y antes de eso tiene que traerse los datos por REST. La lectura es por índice y
	 *   con plazo, y sólo la paga la petición que no cuadra. Como toda lectura, echa de paso a la
	 *   sesión `tpv` que ya no sea la Main (`fijarMain`).
	 * - **Si la base central no contesta, no se ejecuta** (`sin_comprobar`): 503
	 *   `main_sin_comprobar`, que quien llama repite. Ni se deja pasar a quien la tabla dice que no
	 *   es la Main, ni se le dice que ha sido sustituido sin saberlo.
	 */
	private async vetoDeMain(
		identidad: IdentidadDelWorker,
	): Promise<"device_replaced" | "license_revoked" | "sin_comprobar" | null> {
		if (identidad.rol !== "tpv") return null;
		const esOtro = (v: MainVigente) => v.leida && v.deviceId !== identidad.deviceId;
		if (!esOtro(this.mainVigente())) return null;

		try {
			await this.leerMain(identidad.tenantId);
		} catch (e) {
			capturarError(e, "sync.main_vigente");
			return "sin_comprobar";
		}
		const vigente = this.mainVigente();
		if (!esOtro(vigente)) return null;

		const motivo = vigente.deviceId ? "device_replaced" : "license_revoked";
		this.emitSyncEvent("ruta_de_main_rechazada", { device_id: identidad.deviceId, motivo });
		return motivo;
	}

	/**
	 * AUD-02 · Lo que la Main manda por el socket y entra en el acto (`apply`, `apply_lote`), en fila:
	 * cada uno empieza cuando ha acabado el anterior. Si al primero le toca esperar la comprobación por
	 * actividad, los de detrás esperan con él y salen en el orden en que llegaron; si no, la fila no
	 * espera a nada. El outbox de la Main está ordenado (una línea necesita su comanda), y esperar
	 * cada uno por su cuenta dejaría que el segundo, que ya no tiene que preguntar, entrara antes.
	 *
	 * Como `enTurnoDelLog`, es una cadena de promesas de lo que está en vuelo, y un fallo no la rompe
	 * para el siguiente. No toca la base del negocio.
	 */
	private enTurnoDeEntrada(trabajo: () => Promise<void> | void): Promise<void> {
		const resultado = this.turnoDeEntrada.then(trabajo);
		this.turnoDeEntrada = resultado.then(
			() => undefined,
			() => undefined,
		);
		return resultado;
	}

	/**
	 * Todo cierre de una sesión pasa por aquí: los que inicia el DO y los que le llegan
	 * (`webSocketClose`, `webSocketError`).
	 *
	 * AUD-02: la sesión deja de estar autenticada y queda `fuera` en su attachment antes de nada.
	 * Mientras termina de cerrarse puede seguir en `getWebSockets()`, y si el cliente no contesta al
	 * cierre podrían seguir llegando sus mensajes: sin autenticar no se le atiende ninguno ni se le
	 * difunde nada, y no cuenta como Main (AUD-15). Y lo que tuviera a medias no sigue: ni un saludo
	 * que esperaba a la base central la autentica, ni entra lo que dejara esperando.
	 *
	 * Después contabiliza la salida (`sessionGone`), porque nada garantiza que el runtime llame a
	 * `webSocketClose` cuando el cierre lo provoca el propio DO. `a` es el attachment de ANTES del
	 * cierre: es el que dice si era la Main.
	 */
	private cerrar(ws: WebSocket, a: WsAttachment | null, code: number, motivo: string): void {
		// Una sesión que ya está fuera ya tiene su salida contabilizada: sólo queda cerrar el socket.
		const contabilizar = a && !a.fuera ? a : null;
		if (contabilizar) this.setAtt(ws, { ...contabilizar, authed: false, recovering: false, fuera: true });
		try {
			ws.close(code, motivo);
		} catch { }
		if (contabilizar) this.sessionGone(ws, contabilizar);
	}

	/**
	 * El comando con la hora fijada, o el rechazo de quien no la trae. Vale igual para una escritura
	 * suelta y para cada operación de un lote: es el MISMO motor, y una operación no puede valer o no
	 * según el camino por el que suba.
	 *
	 * El tiempo lo fija el dispositivo emisor (cabecera X-Client-Now); resolvemos los
	 * `datetime('now')` del comando a literal ANTES de ejecutar y de registrar el cambio, para que la
	 * fila sea idéntica en nube, Main y Handy (replicación determinista).
	 *
	 * SYNC-04 (guard duro): si el comando lleva una forma `datetime('now',...)` SIN resolver y el
	 * emisor NO mandó una X-Client-Now válida, RECHAZAMOS en vez de caer en silencio a UTC (lo que
	 * dejaba la fila con zona horaria distinta al resto). Todo escritor legítimo pasa por el proxy
	 * Rust `tpv_server_post_json`, que siempre fija la cabecera; este guard blinda contra cualquier
	 * caller futuro que la omitiera. Los comandos ya-literales (p. ej. de la Main) no la exigen.
	 *
	 * CFG-04: lo que no se ha podido fijar lo pondría la base, con su reloj y en UTC, y la fila de la
	 * nube diría otra hora que la del dispositivo. Se rechaza antes de ejecutar nada. Ningún comando
	 * lo hace hoy (lo vigila el scan de `*.commands.ts` en Rust): esto sólo salta con uno nuevo mal
	 * escrito, y es mejor que salte a que deje horas distintas.
	 */
	private conLaHoraFijada(
		cmd: InternalApplyCommand,
		clientNow: string | null | undefined,
	): InternalApplyCommand {
		const parsedNow = parseClientNow(clientNow);
		if (parsedNow === null && commandHasNowLiteral(cmd)) {
			throw new HubError("missing_client_now", 400);
		}
		const fijado = rewriteCmdNowLiterals(cmd, parsedNow ?? serverNowFixed());
		const sinFijar = horaSinFijar(fijado);
		if (sinFijar) {
			throw new HubError("hora_no_determinista", 400, { message: `hora_no_determinista: ${sinFijar}` });
		}
		return fijado;
	}

	private async applyInternalCommandIdempotent(params: {
		tenantId: string;
		cmd: InternalApplyCommand;
		opId: string;
		commandName: string;
		deviceId?: string | null;
		requestPayloadJson: string;
		clientNow?: string | null;
		/** Lo que sube la Main entra aunque todavía tenga congeladas a las Handy (AUD-15). */
		allowWhileRecovering?: boolean;
		/** AUD-02: el socket de la sesión que manda la escritura (el `apply` de la Main). */
		sesion?: WebSocket;
		/** AUD-02: se llama en cuanto la escritura tiene sitio en el turno del log. */
		alReservarTurno?: () => void;
	}): Promise<{ result: any; seq: number }> {
		const {
			tenantId,
			opId,
			commandName,
			deviceId,
			requestPayloadJson,
		} = params;

		const cmd = this.conLaHoraFijada(params.cmd, params.clientNow);

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
		// AUD-15: y si la Main todavía no se ha puesto al día (saluda con `recovering` y no lo
		// suelta hasta que su outbox está vacío), la nube está a medio construir. Dejar escribir a
		// una Handy sobre ese estado es pedir un choque (dos comandas abiertas para la misma mesa,
		// por ejemplo). Se congela igual que sin Main, con otro motivo.
		//
		// Solo afecta a las escrituras que NO son el propio atraso: lo que sube la Main entra
		// (`allowWhileRecovering`). Se mira aquí, para no esperar en balde, y otra vez dentro del
		// turno, que es lo que vale.
		const exigirQueSePuedaEscribir = () => {
			// AUD-02: la escritura de una Main lleva la sesión que la mandó, y esa sesión tiene que
			// seguir siendo la de la Main también cuando le llega el turno. Mientras esperaba pudo
			// trasladarse la licencia y echarse su socket; con la Main nueva ya conectada, las
			// guardias de abajo pasaban y la operación del equipo anterior entraba
			// (`allowWhileRecovering`). Lo mismo con la sesión que reemplaza una reconexión: la nueva
			// vuelve a mandarla. Va antes de aplicar nada, así que lo que se rechaza aquí no ha tocado
			// la base.
			// Con el socket ya cerrado tampoco: nadie recibiría la respuesta, y la Main la vuelve a
			// mandar al reconectar.
			if (params.sesion && (params.sesion.readyState !== 1 || !this.esLaMain(this.att(params.sesion)))) {
				throw new HubError("not_authenticated", 401);
			}
			if (!this.isMainConnected()) {
				throw new HubError("main_offline", 400);
			}
			if (!params.allowWhileRecovering && !this.isMainReady()) {
				throw new HubError("main_volcando", 400);
			}
		};
		// AUD-02: aquí, con la tabla tal como está. La comprobación por actividad se espera dentro del
		// turno, en el orden en que llegan las escrituras.
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
		};
		const { stmts: batchStmts, built, offsetTrabajo: MIDDLE_OFFSET } = loteDe(escritura, createdAtMs);

		// AUD-18: confirmar y difundir van dentro del turno del log (`enTurnoDelLog`).
		//
		// AUD-02: quien la manda se entera de cuándo ha cogido sitio (`alReservarTurno`): es la fila
		// de entrada de la Main, que no suelta al siguiente `apply` hasta entonces. La base es el
		// SQLite de este DO, así que no hay credenciales que renovar a mitad del turno: la escritura
		// entra o no entra, sin salir de él.
		const enElTurno = async (db: Client): Promise<{ result: any; seq: number }> => {
			// AUD-15: otra vez dentro del turno, el congelado de la Main: mientras se esperaba el
			// turno, la que estaba lista pudo irse, o reconectar y saludar congelando, y lo que la
			// Handy decidió con ella lista no puede entrar después.
			//
			// AUD-02: y quién es la Main, que pudo cambiar esperando el turno. Si entretanto se ha
			// cumplido el minuto, se pregunta a la base central; después de esa espera, que es la
			// última, se mira la tabla, y de ahí a aplicar la escritura no hay ninguna más.
			await this.comprobarMain();
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
							{ opId: op, seq: recovered.seq, statements: recovered.statements },
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

			// Tras confirmar, propagamos el cambio (sus sentencias ya resueltas y su `Seq`) al resto de
			// dispositivos autenticados. El originador queda excluido. La Main las aplica tal cual a
			// su SQLite local (no hay refetch). AUD-18: antes que nada más en el turno.
			this.broadcastChange({ opId: op, seq, statements: built.replicated }, deviceId || undefined);

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
		};
		const runApply = async () => {
			// La base del negocio, por donde la sacan también los tests (`withTenantDbRetry`). Abrirla
			// es una espera (al despertar el DO comprueba sus migraciones): el sitio en el turno se
			// coge después, y quien manda la escritura se entera entonces.
			const db = await this.withTenantDbRetry(tenantId, async (base) => base);
			return this.enTurnoDelLog(() => enElTurno(db), params.alReservarTurno);
		};

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
			if (esBaseLlena(e)) this.avisarBaseLlena(e);
			throw e;
		}
	}

	/**
	 * El lote de la Main (`apply_lote`): lo que sube de su outbox, en orden y de una vez.
	 *
	 * Cada operación se aplica como una escritura suelta de la Main (`applyInternalCommandIdempotent`)
	 * —su propio lote atómico (`loteDe` + `loteEnBruto`), su gate de idempotencia, su línea en el
	 * log y su difusión—, pero todas en un mismo turno del log y sin ceder el control entre una y
	 * otra:
	 *
	 * - **Fuera del turno** se prepara cada una (la hora, el hash, las sentencias) y se abre la base,
	 *   que son las esperas. Lo que falla aquí es de esa operación y sale como su veredicto.
	 * - **Dentro del turno**, tras la comprobación por actividad (la última espera), se vuelve a mirar
	 *   que la sesión siga siendo la de la Main (AUD-02) y se aplican en orden. El `Seq` lo da el log
	 *   al confirmar cada una y su `change` sale en el acto: la difusión va en orden de `Seq` (AUD-18).
	 * - **Una que ya estaba** (el mismo `Op_Id`, que viola el UNIQUE del gate) contesta con su `Seq` y
	 *   se difunde otra vez (SYNC-03): es el reenvío de un lote del que no llegó el acuse.
	 * - **Un rechazo permanente** se anota y el lote sigue: esa operación no va a entrar hoy ni dentro
	 *   de un mes, y la Main la aparta y repara por estado (SYNC-22). **Cualquier otro fallo para el
	 *   lote**: lo de detrás se apoya en ella, y sale `noIntentada`.
	 * - **Lo que no cabe en el trabajo de un turno** (`LOTE_MAX_*`) sale también `noIntentada`.
	 *
	 * El acuse sale dentro del turno (`alTerminar`). Lo escrito en un turno se confirma junto al
	 * acabar y lo que se manda por un socket no sale hasta que es duradero (comprobado en
	 * `test/sondaSqliteDo.test.ts`): la Main no puede recibir el acuse de algo que se pierda.
	 *
	 * No se calcula el resultado de cada operación ni se afina su `Result_Json`: sólo lo lee el
	 * reintento de una escritura por REST (`aplicar`), y de una operación de la Main sólo se usa el
	 * `Seq`.
	 *
	 * Lanza sólo lo que afecta al lote entero (la sesión ya no es la de la Main, la base no abre):
	 * no se ha aplicado nada.
	 */
	private async aplicarLote(params: {
		tenantId: string;
		deviceId: string;
		/** AUD-02: el socket de la sesión que manda el lote. */
		sesion: WebSocket;
		ops: OpDeLote[];
		/** AUD-02: se llama en cuanto el lote tiene sitio en el turno del log. */
		alReservarTurno?: () => void;
		/** El acuse, con el veredicto de cada operación en el orden en que llegaron. */
		alTerminar: (resultados: VeredictoDeLote[]) => void;
	}): Promise<void> {
		const { tenantId, deviceId, sesion, ops } = params;

		// AUD-02: como en una escritura suelta, la sesión que lo manda tiene que seguir abierta y ser
		// la de la Main. Se mira aquí, para no trabajar en balde, y otra vez dentro del turno, que es
		// lo que vale.
		const exigirQueSeaLaMain = () => {
			if (sesion.readyState !== 1 || !this.esLaMain(this.att(sesion))) {
				throw new HubError("not_authenticated", 401);
			}
		};
		exigirQueSeaLaMain();

		const createdAtMs = nowMs();
		const preparadas = await Promise.all(
			ops.map(async (o): Promise<LotePreparado | { fallo: unknown }> => {
				try {
					const escritura: EscrituraPreparada = {
						opId: o.opId,
						commandName: o.commandName,
						cmd: this.conLaHoraFijada(o.cmd, o.clientNow),
						deviceId,
						requestHash: await sha256Hex(o.requestPayloadJson),
					};
					return { escritura, lote: loteDe(escritura, createdAtMs) };
				} catch (fallo) {
					return { fallo };
				}
			}),
		);

		// Abrir la base es una espera (al despertar, el DO comprueba sus migraciones): el sitio en el
		// turno se coge después.
		await this.withTenantDbRetry(tenantId, async (base) => base);

		return this.enTurnoDelLog(async () => {
			await this.comprobarMain();
			// ⚠️ De aquí al final no hay ninguna espera.
			exigirQueSeaLaMain();
			const resultados = this.aplicarEnOrden(tenantId, deviceId, ops, preparadas);
			params.alTerminar(resultados);
			// SYNC-12: como una escritura suelta, lo confirmado aprovecha para purgar el log.
			if (resultados.some((r) => r.ok && !r.yaEstaba)) {
				this.state.waitUntil(this.maybePurgeSyncLog(tenantId));
			}
		}, params.alReservarTurno);
	}

	/** El cuerpo síncrono de `aplicarLote`: las operaciones, en orden, y el veredicto de cada una. */
	private aplicarEnOrden(
		tenantId: string,
		deviceId: string,
		ops: OpDeLote[],
		preparadas: (LotePreparado | { fallo: unknown })[],
	): VeredictoDeLote[] {
		const resultados: VeredictoDeLote[] = [];
		let bytes = 0;
		let aplazadas = 0;
		let parado = false;

		ops.forEach((o, i) => {
			// En bytes de UTF-8, como corta la Main: un carácter de fuera de ASCII ocupa hasta tres.
			const tamano = bytesUtf8(o.requestPayloadJson);
			// La primera se intenta siempre: un lote que no avanzara nada volvería igual.
			if (!parado && i > 0 && (i >= LOTE_MAX_OPS || bytes + tamano > LOTE_MAX_BYTES)) parado = true;
			if (parado) {
				resultados.push({ opId: o.opId, ok: false, noIntentada: true });
				return;
			}
			bytes += tamano;

			const preparada = preparadas[i];
			try {
				if ("fallo" in preparada) throw preparada.fallo;
				const { seq, yaEstaba } = this.aplicarPreparada(preparada, () => aplazadas++ < LOTE_MAX_APLAZADAS);
				resultados.push(yaEstaba ? { opId: o.opId, ok: true, seq, yaEstaba } : { opId: o.opId, ok: true, seq });
			} catch (e: any) {
				// No cabía aplazar otra más en este turno: ni ésta ni las de detrás se han tocado.
				if (e instanceof HaceFaltaAplazar) {
					parado = true;
					resultados.push({ opId: o.opId, ok: false, noIntentada: true });
					return;
				}
				// SYNC-20, REV-11: el veredicto lo da el DO, que tiene la excepción delante: definitivo
				// (apartar ya), pasajero (no cuenta) o ninguno de los dos (cuenta).
				const permanente = esRechazoPermanente(e);
				const error = String(e?.message || e).slice(0, 500);
				resultados.push({ opId: o.opId, ok: false, error, permanente, transitorio: esFalloPasajero(e) });
				capturarError(e, "sync.apply");
				this.emitSyncEvent("apply_error", {
					command_name: o.commandName,
					op_id: o.opId,
					device_id: deviceId,
					tenant_id: tenantId,
					error,
				});
				if (esBaseLlena(e)) this.avisarBaseLlena(e);
				// El outbox de la Main está ordenado y sus operaciones se apoyan unas en otras: sólo
				// se salta lo que no va a entrar nunca.
				if (!permanente) parado = true;
			}
		});
		return resultados;
	}

	/**
	 * Una operación del lote: su lote atómico y su difusión. Si ya estaba aplicada (el gate viola el
	 * UNIQUE de `Op_Id` y deshace el lote entero), su `Seq` de entonces y otra difusión (SYNC-03).
	 */
	private aplicarPreparada(
		{ escritura, lote }: LotePreparado,
		alAplazar: () => boolean,
	): { seq: number; yaEstaba?: true } {
		let filas: FilasEnBruto[];
		try {
			filas = this.loteLocal(lote.stmts, alAplazar);
		} catch (e) {
			if (!isUniqueOpIdViolation(e)) throw e;
			const previa = this.aplicadaAntes(escritura);
			if (previa.statements.length) {
				this.broadcastChange(
					{ opId: escritura.opId, seq: previa.seq, statements: previa.statements },
					escritura.deviceId || undefined,
				);
			}
			return { seq: previa.seq, yaEstaba: true };
		}
		// El `Seq` lo asigna el log al insertar, y el lote es local: siempre se puede leer.
		const seq = Number(filas[lote.idxLog]?.lastInsertRowid ?? 0);
		this.broadcastChange(
			{ opId: escritura.opId, seq, statements: lote.built.replicated },
			escritura.deviceId || undefined,
		);
		return { seq };
	}

	/**
	 * El lote atómico de una operación contra la base de este DO, en el acto y sin esperas. Método, y
	 * no una llamada directa, para que un test le ponga delante el fallo que quiera.
	 */
	private loteLocal(sentencias: ResolvedStmt[], alAplazar: () => boolean): FilasEnBruto[] {
		return loteEnBruto(this.state.storage, sentencias, { alAplazar });
	}

	/**
	 * Lo que consta de una operación ya aplicada, leído en el acto: `recoverAppliedOp` sin esperas,
	 * para el lote. Mismo criterio: el mismo `Op_Id` con otro comando o con otro contenido es un
	 * rechazo, y sin línea en el log (ya purgada, por debajo del checkpoint de las Main activas) el
	 * `Seq` es 0 y no hay nada que difundir.
	 */
	private aplicadaAntes(e: EscrituraPreparada): { seq: number; statements: ResolvedStmt[] } {
		const sql = this.state.storage.sql;
		const fila = sql
			.exec(
				"SELECT Command_Name AS command_name, Request_Hash AS request_hash FROM Applied_Operations WHERE Op_Id = ?1 LIMIT 1;",
				e.opId,
			)
			.toArray()[0] as { command_name?: unknown; request_hash?: unknown } | undefined;
		if (!fila) throw new HubError("idempotency_operation_processing", 409);
		if (String(fila.command_name || "") !== e.commandName) throw new HubError("idempotency_command_mismatch", 409);
		if (String(fila.request_hash || "") !== e.requestHash) throw new HubError("idempotency_payload_mismatch", 409);
		const cambio = sql
			.exec(
				"SELECT Seq AS seq, Statements_Json AS statements_json FROM Sync_Changes WHERE Op_Id = ?1 ORDER BY Seq DESC LIMIT 1;",
				e.opId,
			)
			.toArray()[0] as { seq?: unknown; statements_json?: unknown } | undefined;
		const parsed = safeJsonParse(String(cambio?.statements_json ?? "[]"));
		return { seq: Number(cambio?.seq ?? 0), statements: Array.isArray(parsed) ? parsed : [] };
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
				tenant_id: this.negocioParaTrazas(),
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

	/**
	 * Una avería de la base del negocio que no se arregla sola (está llena, no ha podido migrar) y que
	 * a partir de ahí ve cada petición: a Sentry y a Axiom, una vez por instancia y por motivo. Lo
	 * que se recuerda es una caché: al hibernar se pierde y la instancia siguiente vuelve a avisar.
	 */
	private avisarUnaVez(motivo: string, error: unknown, operacion: string): void {
		if (this.avisados.has(motivo)) return;
		this.avisados.add(motivo);
		capturarError(error, operacion);
		this.emitSyncEvent(motivo, { error: String((error as any)?.message || error).slice(0, 500) });
	}

	/**
	 * La base está llena o en sólo lectura (`esBaseLlena`). Ninguna operación tiene la culpa ni se
	 * aparta por ello; hay que hacerle sitio, y eso lo hace una persona.
	 */
	private avisarBaseLlena(error: unknown): void {
		this.avisarUnaVez("base_llena", error, "tenant_db.full");
	}

	private send(ws: WebSocket, obj: any) {
		try {
			ws.send(JSON.stringify(obj));
		} catch { }
	}

	/**
	 * A TODOS los sockets, también a los que aún no han saludado. Sólo para lo que no lleva datos
	 * del negocio: si hay Main (`main_online`, `main_offline`). Lo demás, por `broadcastAuthed` o
	 * `broadcastRol`.
	 */
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
	 * AUD-02 · ¿Puede recibir este socket lo que lleva datos del negocio? Sólo uno abierto y
	 * autenticado; y si es de un `tpv`, sólo el de la Main (`esLaMain`). Se mira al entregar, sin
	 * esperas: `vigente` es la tabla leída una vez para toda la difusión.
	 */
	private puedeRecibir(ws: WebSocket, a: WsAttachment | null, vigente: MainVigente): a is WsAttachment {
		if (ws.readyState !== 1 || !a?.authed || a.fuera) return false;
		return a.role !== "tpv" || this.esLaMain(a, vigente);
	}

	/**
	 * Manda un mensaje solo a los sockets autenticados con un rol concreto.
	 *
	 * El rol sale del attachment (que lo fijó la BD central al autenticar, no una cabecera del
	 * cliente), así que esto NO es cosmética: un aviso dirigido a la Main no puede acabar en las
	 * Handy del local. AUD-02: ni en un `tpv` que ya no es la Main (`puedeRecibir`).
	 */
	private broadcastRol(rol: Role, obj: any) {
		const msg = JSON.stringify(obj);
		const vigente = this.mainVigente();

		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!this.puedeRecibir(ws, a, vigente)) continue;
			if (a.role !== rol) continue;

			try {
				ws.send(msg);
			} catch { }
		}
	}

	private broadcastAuthed(obj: any, exceptDeviceId?: string) {
		const msg = JSON.stringify(obj);
		const vigente = this.mainVigente();

		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (!this.puedeRecibir(ws, a, vigente)) continue;
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
	 *
	 * AUD-02: y del dispositivo que es la Main ahora (`esLaMain`), no de cualquier `tpv`.
	 */
	private mainsAbiertas(except?: WebSocket): WsAttachment[] {
		const out: WsAttachment[] = [];
		const vigente = this.mainVigente();
		for (const ws of this.state.getWebSockets()) {
			if (except && ws === except) continue;
			if (ws.readyState !== 1) continue;
			const a = this.att(ws);
			if (a && this.esLaMain(a, vigente)) out.push(a);
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

	/**
	 * Propaga un cambio aplicado a los dispositivos autenticados, excluyendo al originador.
	 *
	 * El mensaje lleva lo que se lee, y nada más: la Main, la operación (`opId`, su anti-eco), su
	 * `seq` (su checkpoint) y las sentencias ya resueltas, que aplica a su SQLite; la Handy, sólo las
	 * sentencias, de las que saca qué pantallas refrescar (`replicacion.rs::cambio`,
	 * `presencia_handy.rs`). El comando, el dispositivo que lo mandó, su payload y su resultado
	 * viajaban en cada cambio a cada dispositivo sin que nadie los leyera.
	 */
	private broadcastChange(
		params: { opId: string; seq: number; statements: ResolvedStmt[] },
		exceptDeviceId?: string,
	) {
		// AUD-02: se entrega con lo que dice ahora la tabla (`broadcastAuthed`): de los `tpv`, sólo a la
		// Main. La comprobación por actividad ya se ha hecho, si tocaba, en el mismo turno del log y
		// antes de enviar lo que se difunde (`applyInternalCommandIdempotent`, `aplicarLote`).
		this.broadcastAuthed(
			{ type: "change", opId: params.opId, seq: params.seq, statements: params.statements },
			exceptDeviceId,
		);
	}

	/**
	 * ARQ-04: las reglas del handshake viven en `tenantHub.identidad.ts`; aquí sólo se les ata lo que
	 * se sabe del dispositivo: el rol y la clave que el Worker leyó de la base central al canjear el
	 * ticket y le pasó a este objeto al abrir el socket (`tenantHub.rutas.ts::abrirWebSocket`). Sin
	 * otro viaje a la base central: una baja entre el canje y el saludo cierra el socket por su lado
	 * (`revocarDispositivo`). Sigue siendo un método porque es la
	 * costura por la que un test sustituye la verificación de la firma cuando lo que prueba es
	 * otra cosa (`congeladoPorAtraso.test.ts`): sin ella habría que firmar de verdad para comprobar un
	 * mensaje de estado.
	 */
	private async verifyHelloSigned(params: {
		tenantId: string;
		deviceId: string;
		msg: HelloSignedMsg;
		challenge: { nonceB64: string; expiresAtMs: number } | null;
		rol: Role;
		pubkeyB64Hint?: string | null;
	}): Promise<{ roleFinal: Role; pubkeyB64: string }> {
		// `return await` y no `return` a secas: `verifyHelloSigned` rechaza ANTES de su primer
		// `await` cuando el saludo es inválido, y devolverla sin esperar engancha el manejador un
		// microtask tarde. workerd da la promesa por no manejada en ese hueco y cada saludo
		// rechazado dejaba además un «unhandled rejection» en los logs, aunque quien llama sí lo
		// captura. Mismo arreglo en `tenantHubHello.test.ts`, donde rompía el CI.
		const { rol, ...resto } = params;
		return await verifyHelloSigned({
			...resto,
			cargarDispositivo: async () => ({ role: rol, pubkeyB64: params.pubkeyB64Hint ?? null, revoked: false }),
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

		// DO-NEGOCIO: el negocio de la sesión se queda en su attachment, y de ahí sale el de todo lo
		// que mande después. Se comprueba aquí, antes de aceptar el socket.
		const tenantId = request.headers.get("x-tenant-id") || "";
		if (tenantId && this.negocioAjeno(tenantId, "ws")) {
			return new Response("negocio_ajeno", { status: 500 });
		}

		// El Worker canjeó el ticket con el dispositivo vivo, pero pudo darse de baja entre el canje y
		// este momento: su `revocarDispositivo` llegó antes que el socket y no tuvo nada que cerrar.
		const deviceId = request.headers.get("x-device-id") || "";
		if (await this.revocadoTrasElCanje(deviceId, Number(request.headers.get("x-ws-canje-ms")))) {
			return Response.json({ ok: false, code: "device_revoked", error: "device_revoked" }, { status: 401 });
		}

		return abrirWebSocket(ctx, request);
	}

	/**
	 * ¿Se dio de baja `deviceId` después de que el Worker canjeara el ticket de este socket?
	 *
	 * El Worker lee la fila del dispositivo al canjear el ticket y el saludo ya no vuelve a la base
	 * central. Una baja que llega entre el canje y el upgrade no encuentra socket que cerrar, así que
	 * `revocarDispositivo` deja anotado cuándo llegó (en el almacenamiento del objeto: sobrevive a la
	 * hibernación) y aquí se compara con la hora del canje. Las dos horas son de máquinas distintas: con
	 * `MARGEN_CANJE_MS` de holgura, un canje de justo antes de la baja no se cuela, y uno posterior a
	 * volver a dar de alta el mismo dispositivo entra (como mucho, unos segundos después).
	 */
	private async revocadoTrasElCanje(deviceId: string, canjeMs: number): Promise<boolean> {
		if (!deviceId) return false;
		const revocadoMs = await this.state.storage.get<number>(`${CLAVE_REVOCADO}${deviceId}`);
		if (revocadoMs === undefined) return false;
		return !(Number.isFinite(canjeMs) && canjeMs > revocadoMs + MARGEN_CANJE_MS);
	}

	async aplicar(params: ApplyParams): Promise<ResultadoAplicacion> {
		const ajeno = params.tenantId ? this.negocioAjeno(params.tenantId, "aplicar") : null;
		if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
		return aplicar(this.ctxRutas(), params);
	}

	/**
	 * Una ruta de negocio entera, ejecutada aquí (`lib/enElHub.ts`): la misma `app` que sirve el
	 * Worker, con la identidad que ya comprobó él. Sus lecturas van al SQLite de este DO y sus
	 * escrituras a `aplicar`, sin RPC: la petición cuesta un viaje, el que la ha traído.
	 */
	async ejecutarRuta(peticion: Request, identidad: IdentidadDelWorker): Promise<Response> {
		const ajeno = this.negocioAjeno(identidad.tenantId, "ejecutarRuta");
		if (ajeno) return serverError(peticion, ajeno.code);

		// AUD-02: de un `tpv`, sólo la Main. Lo último antes de ejecutar la ruta: de aquí a ella no
		// hay ninguna espera.
		const veto = await this.vetoDeMain(identidad);
		if (veto === "sin_comprobar") {
			return json({ ok: false, code: "external", error: "main_sin_comprobar" }, 503, peticion);
		}
		if (veto) return forbidden(peticion, veto);

		const ctxEjecucion = {
			waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p),
			passThroughOnException: () => undefined,
			props: {},
		} as unknown as ExecutionContext;
		return dentroDelHub(
			{
				identidad,
				base: () => this.getTenantDb(identidad.tenantId),
				sql: async () => {
					await this.getTenantDb(identidad.tenantId);
					return this.state.storage.sql;
				},
				aplicar: (params) => aplicar(this.ctxRutas(), params),
				estaAprovisionado: () => this.estaAprovisionado(),
				aprovisionar: () => this.aprovisionar(identidad.tenantId),
			},
			async () => app.fetch(peticion, this.env, ctxEjecucion),
		);
	}

	async revocarDispositivo(deviceId: string): Promise<void> {
		if (!deviceId) return;
		revocar(this.ctxRutas(), deviceId);
		// Y queda anotada, en el mismo turno: un socket cuyo ticket se canjeó antes de la baja y que todavía
		// no ha llegado lo rechaza el upgrade (`revocadoTrasElCanje`).
		await this.state.storage.put(`${CLAVE_REVOCADO}${deviceId}`, nowMs());
	}

	avisarEmparejamiento(): void {
		this.trasComprobarMain(() => avisoDePairing(this.ctxRutas()));
	}

	avisarReservasWeb(): void {
		this.trasComprobarMain(() => avisoDeReservasWeb(this.ctxRutas()));
	}

	/** ⚠️ Envoltorios que leen `this.X` AL LLAMAR, nunca `.bind(this)`. Ver `ctxMensajes`. */
	private ctxRutas(): ContextoDeRutas {
		return {
			att: (ws) => this.att(ws),
			setAtt: (ws, att) => this.setAtt(ws, att),
			send: (ws, obj) => this.send(ws, obj),
			broadcastRol: (rol, obj) => this.broadcastRol(rol, obj),
			liveSocketsFor: (deviceId, except) => this.liveSocketsFor(deviceId, except),
			cerrar: (ws, a, code, motivo) => this.cerrar(ws, a, code, motivo),
			aceptarWebSocket: (ws, tags) => this.state.acceptWebSocket(ws, tags),
			waitUntil: (p) => this.state.waitUntil(p),
			vistoAhora: (deviceId) => void this.lastSeenPushedAtMs.set(deviceId, nowMs()),
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
	 * ⚠️ Envoltorios que leen `this.X` AL LLAMAR, nunca `.bind(this)`: varios tests sustituyen un
	 * método de la instancia --la verificación de la firma, si hay Main conectada-- y con la
	 * referencia atada aquí esa sustitución dejaría de verse.
	 *
	 * Y no se guarda en un campo: no habría nada que ganar (esto no tiene estado) y sí un sitio
	 * donde alguien acabara metiéndolo.
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
			touchLastSeen: (tenantId, deviceId) => this.touchLastSeen(tenantId, deviceId),
			verifyHelloSigned: (params) => this.verifyHelloSigned(params),
			esLaMain: (a) => this.esLaMain(a),
			mainVigente: () => this.mainVigente().deviceId,
			leerMain: (tenantId) => this.leerMain(tenantId),
			comprobarMain: () => this.comprobarMain(),
			cerrar: (ws, a, code, motivo) => this.cerrar(ws, a, code, motivo),
			enTurnoDeEntrada: (trabajo) => this.enTurnoDeEntrada(trabajo),
			isMainConnected: (except) => this.isMainConnected(except),
			isMainRecovering: () => this.isMainRecovering(),
			applyInternalCommandIdempotent: (params) =>
				this.applyInternalCommandIdempotent(params),
			aplicarLote: (params) => this.aplicarLote(params),
		};
	}


	/**
	 * Contabilidad de una sesión que se va: el freeze de las Handy si era la Main. Se invoca desde `webSocketClose`
	 * (cierre del cliente / caída de red) y TAMBIÉN de forma explícita en los cierres que inicia el
	 * servidor, todos por `cerrar`, porque la documentación de Cloudflare no garantiza que
	 * `webSocketClose` se dispare cuando el cierre lo provoca el propio DO. Es **idempotente y
	 * auto-inhibida**: si queda otro socket vivo del mismo dispositivo no hace nada, y repetirla solo
	 * reemite una señal que el cliente ya trata como idempotente.
	 */
	private sessionGone(ws: WebSocket, a: WsAttachment): void {
		const { deviceId } = a;

		// Si ya nos reemplazó una reconexión bajo el mismo deviceId, no dispares `main_offline` en
		// falso: la sesión nueva sigue viva.
		if (this.liveSocketsFor(deviceId, ws).length > 0) return;

		const wasMain = a.role === "tpv";

		this.lastSeenPushedAtMs.delete(deviceId);

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
		// Si la cerró el DO (`cerrar`), ya está fuera y su salida ya se contabilizó entonces. Esto es
		// sólo el cierre que llega después, quizá con el negocio ya retirado (`borrarTodo`): no se
		// vuelve a contabilizar, que sería además volver a crear tablas en un objeto vacío.
		if (!a || a.fuera) return;
		// AUD-02: como en `cerrar`, la sesión queda fuera antes de nada: lo que tuviera a medias (un
		// saludo esperando a la base central, una escritura esperando turno) no sigue.
		this.setAtt(ws, { ...a, authed: false, recovering: false, fuera: true });
		this.sessionGone(ws, a);
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		// Cierre iniciado por el servidor → contabilizamos la salida nosotros (ver `sessionGone`).
		this.cerrar(ws, this.att(ws), 1011, "ws_error");
	}
}
