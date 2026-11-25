import type { Env } from "../env";
import { HubError } from "../lib/errorHttp";
import { forbidden, json, serverError } from "../server/utils/response";
import type { Base, Resultado } from "../lib/sql";
import { clienteCentral } from "../server/central/cliente";
import { registrarSinLaCentral } from "../server/central/sinLaCentral";
import { centralDe } from "../lib/objetosDelNegocio";
import { ingestToAxiom } from "../observability/axiom";
import { capturarError } from "../observability/errors";
import { scrub } from "../observability/scrub";
import { acotar, MAX_FILTRADO } from "../observability/tope";
import { bytesUtf8 } from "../lib/texto";
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
import type {
	ApplyParams,
	BaseDevuelta,
	CopiaRestaurada,
	EstadoDeLaBase,
	IdentidadDelWorker,
	ResultadoAplicacion,
	ResultadoDeAdministracion,
	VueltaAplicada,
	VueltaPreparada,
} from "./tenantHub.rpc";
import {
	volcarNegocio,
	subirCopia,
	siguienteCopiaMs,
	prefijoDeCopias,
	type CopiaHecha,
} from "./tenantHub.copia";
import { CopiaInservible, lineasDe } from "./cargaDeCopias";
import { cargarCopiaDelNegocio } from "./tenantHub.restaurar";
import { esSinVueltaAUnInstante, instantesDe, type Instantes } from "./instantes";
import { abrirLogTrasVolver, CLAVE_VUELTA_EN_CURSO, seqMasAlto, type ModoDeVuelta } from "./tenantHub.instante";
import { nuevoId } from "../lib/ids";
import {
	caducarSiToca,
	copiasProtegidasDesde,
	ejecutarPasoDeSubida,
	estadoParaSoporte,
	reabrirSubida,
	sinEmpezarParaAvisar,
	subidaParaElSaludo,
	type PasoDeSubida,
	type SubidaEnElSaludo,
} from "./tenantHub.subida";
import {
	leerConLaHoraDelNegocio,
	type LecturaWeb,
	type RespuestaDeLecturaWeb,
} from "../domains/reservas_web/lecturasDeLaWeb";
import { horaDelNegocio, horaLocalEn } from "../domains/reservas_web/horaDelNegocio";
import { app } from "../app";
import { dentroDelHub } from "../lib/hubLocal";
import {
	clienteLocal,
	GuardaIncumplida,
	HaceFaltaAplazar,
	loteEnBruto,
	migrarBaseLocal,
} from "./tenantHub.sqlite";
import { baseAprovisionada, type FilasEnBruto } from "./sqliteDelObjeto";
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
import { exigirOperacionDeLaMain } from "./tenantHub.replicable";
import {
	apuntarGasto,
	presupuestoAgotado,
	presupuestoAgotadoError,
	topeDeUnaOperacion,
	type TopeDeOperacion,
} from "./tenantHub.presupuesto";
import {
	commandHasNowLiteral,
	horaSinFijar,
	instanteDeClientNow,
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
	SentenciaDelLote,
	VeredictoDeLote,
	WsAttachment,
} from "./tenantHub.types";


// SYNC-08: ventana mínima entre escrituras de `last_seen_at_ms` por dispositivo en la BD central.
// Absorbe los pings (cada 30 s) sin perder utilidad de presencia (granularidad de minutos basta).
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

// AUD-46: `last_seen` va por `waitUntil`, y un DO no hiberna mientras le quede una promesa de
// `waitUntil` sin terminar: con el plazo, la suya termina aunque la base central no conteste. La
// llamada vencida no se cancela (es un RPC, CENTRAL-PLAZO en docs/pendientes.md): si la central la
// atiende después, el `last_seen` entra entonces, y si no, lo pone el siguiente.
const PLAZO_LAST_SEEN_MS = 10_000;

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
// Main espera el acuse de su lote 30 s, y una base central colgada no puede comerse esa espera.
// Vencido, es una lectura que no ha contestado: la tabla se queda como estaba.
const PLAZO_LEER_MAIN_MS = 5_000;

// SYN-INC-01: cuánto puede pasar una sesión de Main sin dar señales de vida antes de darla por ida.
// La Main manda el latido cada 30 s y corta ella misma si en 65 s no le llega el `pong`
// (`tpv-infra-http/src/websocket.rs`); con 90 s se le perdonan dos latidos perdidos.
const MAIN_SIN_LATIDO_MS = 90_000;

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


// DO-03: si la copia diaria falla, cuándo se vuelve a intentar.
const REINTENTO_COPIA_MS = 60 * 60 * 1000;

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
	// La alarma es sólo la de la copia diaria (DO-03, `alarma`): una vez al día, también en un negocio
	// parado. Nada más se deja para después.

	// SYNC-08: último `last_seen` empujado a la BD central por dispositivo (throttle en memoria).
	// Se pierde al hibernar: como mucho provoca un UPDATE extra tras despertar. Aceptable.
	private lastSeenPushedAtMs = new Map<string, number>();
	// SYNC-12: instante de la última purga del log de sync (throttle en memoria del DO).
	private lastPurgeAtMs = 0;

	// La base del negocio es el SQLite de este DO. El cliente se monta una vez por
	// instancia, tras comprobar que el negocio está aprovisionado y su esquema al día.
	private baseLocal: Base | null = null;
	// El negocio de este DO para las trazas de un objeto que todavía no lo tiene apuntado (sin base):
	// lo dice la primera petición que llega. Con base, manda el apuntado (`negocioParaTrazas`).
	private tenantIdVisto: string | null = null;
	// Lo que ya se ha avisado desde esta instancia (`avisarUnaVez`): una avería de la base del
	// negocio la ve cada petición, y con un aviso basta. Se pierde al hibernar: vuelve a avisar.
	private avisados = new Set<string>();

	// DO-03: la vuelta a un instante, detrás de algo que un test puede sustituir (en local no existe).
	private instantes: Instantes;
	// DO-03: caché de la marca de vuelta en curso (`CLAVE_VUELTA_EN_CURSO`, en el almacenamiento). La
	// pone esta misma instancia; al despertar se vuelve a leer del almacenamiento.
	private vueltaEnCurso = false;
	// DO-03: esta instancia ya ha visto armada la alarma de la copia diaria. Una caché: al despertar,
	// se vuelve a mirar.
	private copiaProgramada = false;
	// DO-PERDIDA: esta instancia le está dando base a un objeto vacío (`darBase`). Es lo que está en
	// vuelo; si la instancia se pierde a mitad, lo dice la marca del almacenamiento.
	private dandoBase = false;

	// AUD-18: la cola de lo que está confirmando y difundiendo ahora mismo (ver `enTurnoDelLog`). Es
	// lo que está en vuelo, no algo que recordar entre invocaciones: el DO sólo hiberna sin nada en
	// vuelo, así que al despertar vacía es lo correcto (SYNC-16, regla 4).
	private turnoDelLog: Promise<void> = Promise.resolve();

	// AUD-02: la cola de lo que la Main manda por el socket y entra en el acto (`apply_lote`, ver
	// `enTurnoDeEntrada`). Como el turno del log, es lo que está en vuelo y nada
	// más: lo que se pierda al descartar la instancia no tenía respuesta todavía, y la Main lo vuelve
	// a mandar.
	private turnoDeEntrada: Promise<void> = Promise.resolve();

	// SYN-INC-01: la hora a la que nació esta instancia (al crearse o al despertar). No es algo que
	// recordar: es de esta instancia, y que se pierda al hibernar es lo que se busca. Da a cada Main
	// un margen tras despertar, por si el sello del latido no sobrevive a la hibernación (`conLatido`).
	private readonly despiertaDesdeMs = Date.now();

	// SYN-INC-01: cuándo mandó cada socket su último mensaje, que también es señal de vida. Una caché:
	// si se pierde al hibernar, mientras tanto no llegó ningún mensaje (despertarían al objeto) y
	// cubre `despiertaDesdeMs`. No se escribe en el attachment, que sería escribir en cada mensaje.
	private ultimoMensajeMs = new WeakMap<WebSocket, number>();

	constructor(private state: DurableObjectState, private env: Env) {
		this.instantes = instantesDe(state);
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

	/**
	 * La base central, en su objeto (`durableObjects/baseCentral.ts`), con el plazo de quien la pide
	 * (AUD-02): una central que no contesta no puede retener el turno del log ni la espera de la Main.
	 * Vencido, sale como `CentralNoDisponible`, una lectura que no ha contestado. La llamada vencida no
	 * se cancela (es un RPC): hasta que la central la atiende, este objeto no puede hibernar
	 * (CENTRAL-PLAZO en docs/pendientes.md).
	 */
	private getCentralDb(plazoMs: number): Base {
		return clienteCentral(() => centralDe(this.env), { plazoMs });
	}

	/**
	 * Un fallo de lo que el hub le pide a la base central por su cuenta (`operacion`: quién es la Main,
	 * el `last_seen`). Si es que no ha podido atender, queda como en el Worker
	 * (`registrarSinLaCentral`): el evento `central_no_disponible` en Axiom, con `metodo: "hub"` y la
	 * operación como ruta, y Sentry sólo si no es carga ni un fallo pasajero de la plataforma: con la
	 * central saturada, cada hub con actividad no puede mandar un evento por minuto. Cualquier otro
	 * fallo (un error de SQL) va a Sentry, como siempre.
	 */
	private registrarFalloDeLaCentral(error: unknown, operacion: string, tenantId: string): void {
		const deLaCentral = registrarSinLaCentral(error, {
			env: this.env,
			enSegundoPlano: (promesa) => this.state.waitUntil(promesa),
			operacion,
			metodo: "hub",
			ruta: operacion,
			tenantId,
		});
		if (!deLaCentral) capturarError(error, operacion);
	}

	/**
	 * La base del negocio: el SQLite de este mismo DO.
	 *
	 * Sin aprovisionar contesta `tenant_db_not_provisioned`. Aprovisionado, migra lo pendiente una
	 * vez por instancia (al desplegar un esquema nuevo, el DO se reinicia y el primer acceso lo
	 * aplica). No hay credenciales, ni red, ni plazos: una escritura entra o no entra, y se sabe en
	 * el acto.
	 */
	private async getTenantDb(tenantId: string): Promise<Base> {
		this.tenantIdVisto ??= tenantId || null;
		// DO-03: mientras la base vuelve a un instante o se restaura de una copia, nadie la toca. Para
		// la Main es pasajero (`tenantHub.errores.ts`): su outbox espera.
		if (this.vueltaEnCurso) throw new HubError("tenant_db_restaurando", 503);
		if (this.baseLocal) return this.baseLocal;
		const storage = this.state.storage;
		if (await storage.get(CLAVE_VUELTA_EN_CURSO)) {
			this.vueltaEnCurso = true;
			throw new HubError("tenant_db_restaurando", 503);
		}
		if (!baseAprovisionada(storage.sql)) throw new HubError("tenant_db_not_provisioned", 404);
		try {
			await this.migrarEnExclusiva();
		} catch (causa) {
			throw this.migracionFallida(causa);
		}
		this.baseLocal = clienteLocal(storage);
		await this.programarCopia();
		return this.baseLocal;
	}

	/**
	 * DO-03 · Que la copia diaria esté armada: si el objeto no tiene alarma, la de la madrugada
	 * siguiente (`siguienteCopiaMs`). Se mira una vez por instancia, en el primer acceso a la base, así
	 * que un negocio con base y con actividad queda armado aunque su base sea de antes de que hubiera
	 * copias. Sin negocio apuntado no hay a nombre de quién guardarla: no se arma. Nunca hace fallar a
	 * quien accede a la base.
	 */
	private async programarCopia(): Promise<void> {
		if (this.copiaProgramada) return;
		try {
			const storage = this.state.storage;
			if ((await storage.getAlarm()) === null) {
				const negocio = negocioApuntado(storage);
				if (!negocio) return;
				await storage.setAlarm(siguienteCopiaMs(negocio, Date.now()));
			}
			this.copiaProgramada = true;
		} catch (e) {
			capturarError(e, "hub.programar_copia");
		}
	}

	/**
	 * DO-03 · La alarma del objeto: la copia diaria de su base a R2 (`tenantHub.copia.ts`).
	 *
	 * - Todo lo que hace lo espera aquí, y lo único que deja en `waitUntil` es la traza de Axiom, que
	 *   tiene su plazo: al acabar, el objeto puede volver a hibernar con los sockets abiertos (AUD-46).
	 * - No propaga: un fallo se avisa (Sentry y Axiom) y se vuelve a intentar en una hora. Si
	 *   lanzara, la plataforma lo repetiría por su cuenta unas cuantas veces y dejaría de hacerlo.
	 * - Sin base, o sin negocio apuntado, no hace nada ni se vuelve a armar: un negocio retirado no
	 *   despierta más.
	 */
	async alarma(): Promise<void> {
		const storage = this.state.storage;
		if (!baseAprovisionada(storage.sql)) return;
		const negocio = negocioApuntado(storage);
		if (!negocio) return;
		// DO-SUBIDA: una petición de subida completa que lleva un día sin ninguna página, o que caduca
		// ahora sin que la Main la empezara. Antes de la copia: si la copia falla, el aviso sale igual.
		try {
			if (caducarSiToca(storage.sql, Date.now())) this.emitSyncEvent("subida_caducada", {});
			const sinEmpezar = sinEmpezarParaAvisar(storage.sql, Date.now());
			if (sinEmpezar) {
				capturarError(new Error("subida_sin_empezar"), "hub.subida_sin_empezar");
				this.emitSyncEvent("subida_sin_empezar", { origen: sinEmpezar.origen, main_device_id: sinEmpezar.mainDeviceId });
			}
		} catch (e) {
			capturarError(e, "hub.subida_sin_empezar");
		}
		try {
			const r = await this.copiar(negocio);
			this.emitSyncEvent("copia_diaria", { clave: r.clave, tablas: r.tablas, filas: r.filas, bytes: r.bytes });
			await storage.setAlarm(siguienteCopiaMs(negocio, Date.now()));
		} catch (e) {
			capturarError(e, "hub.copia_diaria");
			// AUD-32: el mensaje, filtrado antes de recortarlo (un correo o un JWT partidos por el corte ya
			// no se reconocen).
			this.emitSyncEvent("copia_diaria_fallida", {
				error: acotar(String((e as Error)?.message ?? e), scrub, { bytes: 300, filtrado: MAX_FILTRADO }),
			});
			await storage.setAlarm(Date.now() + REINTENTO_COPIA_MS);
		}
	}

	/** DO-03 · Copia la base del negocio a R2 y poda las viejas. Lanza si algo falla. */
	private async copiar(negocio: string): Promise<CopiaHecha> {
		// Por `getTenantDb`: con el esquema al día, y nunca a mitad de una vuelta a un instante.
		await this.getTenantDb(negocio);
		const ahora = new Date();
		const volcado = volcarNegocio(this.state.storage.sql, { tenantId: negocio, ahora });
		// DO-SUBIDA: mientras la Main no ha subido su base, las copias de antes de la pérdida son las
		// buenas, y no se podan.
		return subirCopia(this.env.COPIAS_NEGOCIOS, negocio, volcado, ahora, copiasProtegidasDesde(this.state.storage.sql));
	}

	/** DO-03 · La copia de hoy, ahora (`/v1/admin/negocios/copiar`). Arma la diaria si no lo estaba. */
	async copiarAhora(tenantId: string): Promise<ResultadoDeAdministracion<CopiaHecha>> {
		const ajeno = this.negocioAjeno(tenantId, "copiarAhora");
		if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
		try {
			const r = await this.copiar(tenantId);
			this.emitSyncEvent("copia_diaria", { clave: r.clave, tablas: r.tablas, filas: r.filas, bytes: r.bytes, aMano: true });
			return { ok: true, ...r };
		} catch (e) {
			if (e instanceof HubError) return { ok: false, error: e.code, status: e.status };
			throw e;
		}
	}

	/** DO-03 · Cómo está la base, para soporte. Sólo lee. */
	async estadoDeLaBase(tenantId: string): Promise<ResultadoDeAdministracion<EstadoDeLaBase>> {
		const ajeno = this.negocioAjeno(tenantId, "estadoDeLaBase");
		if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
		const storage = this.state.storage;
		return {
			ok: true,
			aprovisionado: baseAprovisionada(storage.sql),
			negocio: negocioApuntado(storage),
			proximaCopiaMs: await storage.getAlarm(),
			vueltaEnCurso: Boolean(await storage.get(CLAVE_VUELTA_EN_CURSO)),
			seq: seqMasAlto(storage.sql),
			sesiones: this.authedCount(),
			// DO-SUBIDA: la subida completa que se le pidió a la Main, si hay.
			subida: estadoParaSoporte(storage.sql),
		};
	}

	/**
	 * DO-SUBIDA · Vuelve a abrir una subida completa `agotada`, `caducada` o `huerfana`
	 * (`/v1/admin/negocios/subida/reabrir`): otra vez esperando, sin dueño, con su plazo y su
	 * presupuesto a cero. Sin nada que reabrir, `subida_no_reabrible`.
	 *
	 * La petición sólo se entrega en el `hello_ok`, y la Main la concilia al empezar cada sesión: la
	 * que ya está conectada (con hibernación, un socket puede durar días) no se enteraría y sus pasos
	 * darían `subida_no_pedida`. Así que se echa a las sesiones `tpv`, por `cerrar` como todo cierre
	 * que inicia el DO: la Main vuelve a saludar y se la queda. Las Handy siguen.
	 */
	async reabrirSubida(tenantId: string): Promise<ResultadoDeAdministracion<{ antes: string }>> {
		const ajeno = this.negocioAjeno(tenantId, "reabrirSubida");
		if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
		const antes = reabrirSubida(this.state.storage.sql, Date.now());
		if (!antes) return { ok: false, error: "subida_no_reabrible", status: 409 };
		for (const ws of this.state.getWebSockets()) {
			const a = this.att(ws);
			if (a?.role === "tpv") this.cerrar(ws, a, 4003, "subida_reabierta");
		}
		this.emitSyncEvent("subida_reabierta", { antes });
		return { ok: true, antes };
	}

	/**
	 * DO-03 · Primera mitad de la vuelta a un instante (`tenantHub.instante.ts`): deja preparada la
	 * vuelta para el siguiente arranque, cierra la base a todo el mundo y echa a las sesiones.
	 *
	 * - Lo que la nube había numerado (`seqAntes`) se lee aquí, antes de volver: después ya no está, y
	 *   es lo que dice desde dónde abrir el log (`trasVolver`).
	 * - La marca de vuelta en curso (en el almacenamiento) cierra la base hasta el reinicio: lo que
	 *   entre entretanto se perdería al volver. La vuelta se la lleva, porque es de después.
	 * - Las sesiones se cierran por `cerrar`, como todo cierre que inicia el DO: la Main y las Handy
	 *   reconectan solas, y para entonces la nube ya ha vuelto.
	 */
	async prepararVuelta(params: {
		tenantId: string;
		instanteMs?: number;
		marcador?: string;
	}): Promise<ResultadoDeAdministracion<VueltaPreparada>> {
		const ajeno = this.negocioAjeno(params.tenantId, "prepararVuelta");
		if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
		const storage = this.state.storage;
		try {
			const destino = params.marcador ?? (await this.instantes.marcadorDe(Number(params.instanteMs)));
			const seqAntes = seqMasAlto(storage.sql);
			const aprovisionadoAntes = baseAprovisionada(storage.sql);
			const actual = await this.instantes.marcadorActual();
			const deshacer = await this.instantes.restaurarAlReiniciar(destino);
			await storage.put(CLAVE_VUELTA_EN_CURSO, { destino, desdeMs: Date.now() });
			this.vueltaEnCurso = true;
			this.baseLocal = null;
			for (const ws of this.state.getWebSockets()) this.cerrar(ws, this.att(ws), 4003, "nube_devuelta");
			return { ok: true, destino, actual, deshacer, seqAntes, aprovisionadoAntes };
		} catch (e) {
			if (esSinVueltaAUnInstante(e)) return { ok: false, error: "vuelta_no_disponible", status: 501 };
			throw e;
		}
	}

	/** DO-03 · Reinicia el objeto, que al arrancar vuelve al instante preparado. Lanza en quien llama. */
	reiniciar(): void {
		this.instantes.reiniciar("nube_devuelta");
	}

	/**
	 * DO-03 · Segunda mitad de la vuelta, ya en el objeto reiniciado: comprueba que ha vuelto (la
	 * marca de vuelta en curso es de después del instante, así que volver se la lleva), pone el esquema
	 * al día, abre el log por encima de todo lo numerado y, con `nube`, obliga a las Main a traerse la
	 * nube (`abrirLogTrasVolver`). Sin base tras volver (un instante de antes de que naciera), no toca
	 * nada.
	 */
	async trasVolver(params: {
		tenantId: string;
		seqAntes: number;
		modo: ModoDeVuelta;
	}): Promise<ResultadoDeAdministracion<VueltaAplicada>> {
		const storage = this.state.storage;
		if (await storage.get(CLAVE_VUELTA_EN_CURSO)) {
			return { ok: false, error: "vuelta_sin_aplicar", status: 503 };
		}
		this.vueltaEnCurso = false;
		const ajeno = this.negocioAjeno(params.tenantId, "trasVolver");
		if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
		if (!baseAprovisionada(storage.sql)) return { ok: true, aprovisionado: false, inicio: null, purgadoHasta: null };
		try {
			await this.getTenantDb(params.tenantId);
		} catch (e) {
			if (e instanceof HubError) return { ok: false, error: e.code, status: e.status };
			throw e;
		}
		const log = abrirLogTrasVolver(storage, {
			seqAntes: params.seqAntes,
			modo: params.modo,
			opId: `nube-devuelta-${nuevoId()}`,
			ahoraMs: Date.now(),
			origen: "instante",
			// Sin dueño: la tabla de la Main vigente (`_Main_Vigente`) acaba de volver al instante con
			// todo lo demás, y si la licencia cambió de equipo desde entonces nombraría al de antes (la
			// petición quedaría huérfana con la Main de ahora). La primera Main vigente que salude, que el
			// saludo comprueba contra la base central, se la queda.
			mainDeviceId: null,
		});
		// DO-SUBIDA: una sesión que entró entre el reinicio y esto saludó sin la petición de subida (y
		// escribió sobre la base vuelta sin el log abierto). Se echa a todas: vuelven a saludar, y la
		// Main recibe la petición en su `hello_ok`.
		for (const ws of this.state.getWebSockets()) this.cerrar(ws, this.att(ws), 4003, "nube_devuelta");
		this.emitSyncEvent("base_devuelta", { operacion: "instante", modo: params.modo, inicio: log.inicio });
		return { ok: true, aprovisionado: true, ...log };
	}

	/**
	 * DO-PERDIDA · Una base vacía para un negocio que ya nació y la ha perdido
	 * (`/v1/admin/negocios/base-vacia`). Es el alta (`aprovisionar`: el esquema, el sello y el
	 * administrador inicial), y además abre el log por encima de lo que la Main pueda haber visto,
	 * como tras una vuelta a un instante. Que el negocio nació lo mira la ruta en la base central, y
	 * hasta dónde numeró el log que se perdió (`seqConocido`), también: el objeto ya no lo sabe.
	 */
	async crearBaseVacia(params: {
		tenantId: string;
		modo: ModoDeVuelta;
		seqConocido?: number;
	}): Promise<ResultadoDeAdministracion<BaseDevuelta>> {
		return this.darBase(params.tenantId, "base_vacia", params.modo, params.seqConocido, async () => {
			await this.crearBase(params.tenantId);
			return {};
		});
	}

	/**
	 * DO-PERDIDA · Devuelve a un objeto vacío la base de una copia diaria de R2
	 * (`/v1/admin/negocios/restaurar-copia`, `tenantHub.restaurar.ts`), y abre el log como
	 * `crearBaseVacia`. La copia tiene que ser de este negocio. Si no vale (cortada, de un esquema
	 * que este worker no sabe poner, con una línea que no es una fila), el objeto se queda vacío y se
	 * dice por qué: el código y lo que dice el cargador (`detalle`), sin nada de la copia.
	 */
	async restaurarDesdeCopia(params: {
		tenantId: string;
		clave: string;
		modo: ModoDeVuelta;
		seqConocido?: number;
	}): Promise<ResultadoDeAdministracion<CopiaRestaurada>> {
		const { tenantId, clave } = params;
		if (!tenantId || !clave.startsWith(prefijoDeCopias(tenantId))) {
			return { ok: false, error: "copia_de_otro_negocio", status: 400 };
		}
		try {
			return await this.darBase(tenantId, "copia", params.modo, params.seqConocido, async () => {
				const objeto = await this.env.COPIAS_NEGOCIOS.get(clave);
				if (!objeto) throw new HubError("copia_no_encontrada", 404);
				const storage = this.state.storage;
				const cargada = await cargarCopiaDelNegocio(storage, lineasDe(objeto.body), async () => {
					await this.migrarEnExclusiva();
					apuntarNegocio(storage, tenantId);
				});
				return { clave, ...cargada };
			});
		} catch (e) {
			if (e instanceof CopiaInservible) return { ok: false, error: e.codigo, status: 422, detalle: e.message };
			throw e;
		}
	}

	/**
	 * DO-PERDIDA · Lo común a dar base a un objeto vacío desde la administración.
	 *
	 * - **Sólo a un objeto vacío**: con base, `tenant_db_already_provisioned`. Una base no se pisa.
	 * - **Con la base cerrada mientras tanto**: la marca de vuelta en curso (`CLAVE_VUELTA_EN_CURSO`,
	 *   la misma que la vuelta a un instante) hace que `getTenantDb` conteste `tenant_db_restaurando`,
	 *   porque `llenar` espera a la red (la copia llega de R2 por trozos) con la base a medias y, al
	 *   cargarla, con las claves foráneas apagadas. Las sesiones se cierran por `cerrar`.
	 * - **Todo o nada**: si `llenar` falla, el objeto se vacía otra vez (`vaciarObjeto`), y si la
	 *   instancia se pierde a mitad, la marca se queda puesta y la base cerrada; la siguiente llamada
	 *   a esto la ve sin nadie que la esté llenando y vacía lo que dejó antes de empezar.
	 * - **El log se abre por encima** (`abrirLogTrasVolver`). La Main tiene un checkpoint de la base
	 *   perdida; sin esto se quedaría sin los cambios que la nueva numere por debajo. Un objeto vacío no
	 *   recuerda hasta dónde numeró, así que lo dice quien llama (`seqConocido`: lo que sobrevive a la
	 *   pérdida, en la base central y en las copias de R2, `basesDeNegocios.ts`), y encima va
	 *   `SALTO_DE_SEQ`, que cubre lo que el log perdido numeró después. Sin `seqConocido` (0), sólo
	 *   vale para una base que nunca había vuelto: tras otra pérdida o una vuelta, el log perdido
	 *   ya numeraba por encima del salto.
	 * - **Al acabar se echa otra vez a las sesiones**: una que entró mientras se llenaba la base
	 *   saludó sin la petición de subida.
	 */
	private async darBase<T extends object>(
		tenantId: string,
		operacion: "base_vacia" | "copia",
		modo: ModoDeVuelta,
		seqConocido: number | undefined,
		llenar: () => Promise<T>,
	): Promise<ResultadoDeAdministracion<T & BaseDevuelta>> {
		if (this.dandoBase) return { ok: false, error: "tenant_db_restaurando", status: 503 };
		this.dandoBase = true;
		try {
			const ajeno = this.negocioAjeno(tenantId, operacion === "copia" ? "restaurarDesdeCopia" : "crearBaseVacia");
			if (ajeno) return { ok: false, error: ajeno.code, status: ajeno.status };
			this.tenantIdVisto ??= tenantId;
			const storage = this.state.storage;
			const marca = (await storage.get(CLAVE_VUELTA_EN_CURSO)) as { darBase?: string } | undefined;
			if (marca && !marca.darBase) return { ok: false, error: "tenant_db_restaurando", status: 503 };
			if (marca) {
				// Una de éstas que se quedó a medias en otra instancia.
				this.emitSyncEvent("base_a_medias", { operacion: marca.darBase });
				await this.vaciarObjeto();
			}
			if (baseAprovisionada(storage.sql)) return { ok: false, error: "tenant_db_already_provisioned", status: 409 };

			await storage.put(CLAVE_VUELTA_EN_CURSO, { darBase: operacion, desdeMs: Date.now() });
			this.vueltaEnCurso = true;
			this.baseLocal = null;
			for (const ws of this.state.getWebSockets()) this.cerrar(ws, this.att(ws), 4003, "nube_devuelta");
			let lleno: T;
			let log: BaseDevuelta;
			try {
				lleno = await llenar();
				log = abrirLogTrasVolver(storage, {
					seqAntes: seqConocido ?? 0,
					modo,
					opId: `nube-devuelta-${nuevoId()}`,
					ahoraMs: Date.now(),
					// DO-SUBIDA: un objeto vacío (o una copia, que no trae `_Main_Vigente`) no sabe quién es la
					// Main: la primera Main vigente que salude.
					origen: operacion,
					mainDeviceId: null,
				});
				await storage.delete(CLAVE_VUELTA_EN_CURSO);
			} catch (e) {
				await this.vaciarObjeto();
				if (e instanceof HubError) return { ok: false, error: e.code, status: e.status };
				throw e;
			}
			this.vueltaEnCurso = false;
			// DO-SUBIDA: `llenar` espera (la copia llega de R2, el PIN del administrador se deriva), y el
			// saludo no mira la marca: una sesión que entró entretanto saludó sin la petición de subida. Se
			// echa a todas, como en `trasVolver`: vuelven a saludar, y la Main recibe la petición en su
			// `hello_ok`.
			for (const ws of this.state.getWebSockets()) this.cerrar(ws, this.att(ws), 4003, "nube_devuelta");
			this.copiaProgramada = false;
			await this.programarCopia();
			this.emitSyncEvent("base_devuelta", { operacion, modo, inicio: log.inicio });
			return { ok: true, ...lleno, ...log };
		} finally {
			this.dandoBase = false;
		}
	}

	/**
	 * Deja el objeto como uno que nunca tuvo base: sin almacenamiento y sin alarma (antes que
	 * `deleteAll`, que según la fecha de compatibilidad puede dejarla). No toca las sesiones.
	 */
	private async vaciarObjeto(): Promise<void> {
		await this.state.storage.deleteAlarm();
		await this.state.storage.deleteAll();
		this.baseLocal = null;
		this.copiaProgramada = false;
		this.vueltaEnCurso = false;
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
		run: (db: Base) => Promise<T>,
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
		// DO-03: con una vuelta a un instante preparada no se crea nada: se perdería al volver.
		if (this.vueltaEnCurso || (await storage.get(CLAVE_VUELTA_EN_CURSO))) {
			throw new HubError("tenant_db_restaurando", 503);
		}
		const reused = baseAprovisionada(storage.sql);
		await this.crearBase(tenantId);
		this.baseLocal = clienteLocal(storage);
		// DO-03: desde que tiene base, su copia diaria.
		await this.programarCopia();
		return { reused };
	}

	/** El esquema al día, el negocio apuntado y, si la base nace vacía, su administrador inicial. */
	private async crearBase(tenantId: string): Promise<void> {
		const storage = this.state.storage;
		await this.migrarEnExclusiva();
		// DO-NEGOCIO: el objeto queda con su negocio apuntado desde que tiene base.
		apuntarNegocio(storage, tenantId);
		await sembrarAdminInicial(storage);
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
		// DO-03: y su copia diaria, que sin base no tendría qué copiar.
		await this.vaciarObjeto();
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
		// Va por `waitUntil`, sin nadie que espere su resultado: el fallo se recoge aquí (que la
		// central no conteste a tiempo, no esté aprovisionada o rechace la sentencia) y queda
		// registrado (`registrarFalloDeLaCentral`). El `last_seen` lo pone entonces la siguiente
		// actividad pasada la ventana.
		try {
			await this.getCentralDb(PLAZO_LAST_SEEN_MS).execute({
				sql: `UPDATE devices SET last_seen_at_ms=? WHERE tenant_id=? AND device_id=?`,
				args: [now, tenantId, deviceId],
			});
		} catch (e) {
			this.registrarFalloDeLaCentral(e, "sync.last_seen", tenantId);
		}
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
	 * siguiente `apply_lote`: a partir de ahí el orden en que se confirman ya está fijado.
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
	 * AUD-02 · Lo que dice ahora la base central: la Main de la licencia viva, o `null`.
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
			this.registrarFalloDeLaCentral(e, "sync.main_vigente", tenantId);
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
			this.registrarFalloDeLaCentral(e, "sync.main_vigente", tenantId);
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
			this.registrarFalloDeLaCentral(e, "sync.main_vigente", identidad.tenantId);
			return "sin_comprobar";
		}
		const vigente = this.mainVigente();
		if (!esOtro(vigente)) return null;

		const motivo = vigente.deviceId ? "device_replaced" : "license_revoked";
		this.emitSyncEvent("ruta_de_main_rechazada", { device_id: identidad.deviceId, motivo });
		return motivo;
	}

	/**
	 * AUD-02 · Lo que la Main manda por el socket y entra en el acto (`apply_lote`), en fila:
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

		// Freeze global: si no hay una Main (tpv) autenticada conectada, NO se aplica nada de lo que
		// escribe la Handy por REST (lo que sube la Main va por `aplicarLote`).
		//
		// AUD-15: y si la Main todavía no se ha puesto al día (saluda con `recovering` y no lo
		// suelta hasta que su outbox está vacío), la nube está a medio construir. Dejar escribir a
		// una Handy sobre ese estado es pedir un choque (dos comandas abiertas para la misma mesa,
		// por ejemplo). Se congela igual que sin Main, con otro motivo. Se mira aquí, para no esperar
		// en balde, y otra vez dentro del turno, que es lo que vale.
		const exigirQueSePuedaEscribir = () => {
			// SYN-INC-01: una Main que ya no da señales de vida no autoriza nada: se cierra, y las
			// Handy se enteran (`main_offline`).
			this.cerrarMainsSinLatido();
			if (!this.isMainConnected()) {
				throw new HubError("main_offline", 400);
			}
			if (!this.isMainReady()) {
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

		// AUD-18: confirmar y difundir van dentro del turno del log (`enTurnoDelLog`). La base es el
		// SQLite de este DO, así que no hay credenciales que renovar a mitad del turno: la escritura
		// entra o no entra, sin salir de él.
		const enElTurno = async (db: Base): Promise<{ result: any; seq: number }> => {
			// AUD-15: otra vez dentro del turno, el congelado de la Main: mientras se esperaba el
			// turno, la que estaba lista pudo irse, o reconectar y saludar congelando, y lo que la
			// Handy decidió con ella lista no puede entrar después.
			//
			// AUD-02: y quién es la Main, que pudo cambiar esperando el turno. Si entretanto se ha
			// cumplido el minuto, se pregunta a la base central; después de esa espera, que es la
			// última, se mira la tabla, y de ahí a aplicar la escritura no hay ninguna más.
			await this.comprobarMain();
			exigirQueSePuedaEscribir();
			// AUD-36: el presupuesto de escritura del negocio en esta hora, el mismo que gasta la Main.
			const ahora = nowMs();
			if (presupuestoAgotado(this.state.storage, ahora)) {
				this.avisarUnaVez("presupuesto_agotado", presupuestoAgotadoError(), "sync.presupuesto");
				throw presupuestoAgotadoError();
			}
			const tamanoAntes = this.state.storage.sql.databaseSize;

			let batchResults: Resultado[];
			try {
				batchResults = await db.batch(batchStmts as any);
				apuntarGasto(
					this.state.storage,
					ahora,
					batchResults.reduce((n, r) => n + r.rowsAffected, 0),
					this.state.storage.sql.databaseSize - tamanoAntes,
				);
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
			const seq = batchResults[batchResults.length - 1]?.lastInsertRowid ?? 0;
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
			// justo este evento por cada escritura; el detalle de una correcta no se necesita.
			return { result, seq };
		};
		const runApply = async () => {
			// La base del negocio, por donde la sacan también los tests (`withTenantDbRetry`). Abrirla
			// es una espera (al despertar el DO comprueba sus migraciones): el sitio en el turno se
			// coge después.
			const db = await this.withTenantDbRetry(tenantId, async (base) => base);
			return this.enTurnoDelLog(() => enElTurno(db));
		};

		try {
			return await runApply();
		} catch (e: any) {
			// SYNC-30: una guarda que no se cumple es la respuesta de negocio de la ruta, no un fallo.
			if (e instanceof GuardaIncumplida) throw e;
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
	 * Cada operación se aplica como una escritura suelta de la Handy (`applyInternalCommandIdempotent`)
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

		// AUD-02: la sesión que lo manda tiene que seguir abierta y ser la de la Main: mientras esperaba
		// pudo trasladarse la licencia y echarse su socket, o reemplazarlo una reconexión, que vuelve a
		// mandar el lote. Se mira aquí, para no trabajar en balde, y otra vez dentro del turno, que es
		// lo que vale; las dos, antes de aplicar nada.
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
					// AUD-36: sólo lo que puede haber escrito la Main (`tenantHub.replicable.ts`).
					exigirOperacionDeLaMain(o.cmd);
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
			// SYNC-12: como una escritura de la Handy, lo confirmado aprovecha para purgar el log.
			if (resultados.some((r) => r.ok && !r.yaEstaba)) {
				this.state.waitUntil(this.maybePurgeSyncLog(tenantId));
			}
		}, params.alReservarTurno);
	}

	/**
	 * DO-SUBIDA · Lo que lleva el `hello_ok` de un `tpv` que acaba de entrar como Main vigente
	 * (`tenantHub.subida.ts::subidaParaElSaludo`). Sin esperas: lo llama el saludo justo antes de
	 * contestar. Una petición que pasa a `huerfana` o `caducada` aquí se avisa.
	 */
	private subidaParaElSaludo(deviceId: string): SubidaEnElSaludo | null {
		const sql = this.state.storage.sql;
		if (!baseAprovisionada(sql)) return null;
		const r = subidaParaElSaludo(sql, deviceId, Date.now());
		if (r.caducada) this.emitSyncEvent("subida_caducada", {});
		if (r.huerfana) {
			capturarError(new Error("subida_huerfana"), "sync.subida");
			this.emitSyncEvent("subida_huerfana", { de: r.huerfana.mainDeviceId, saluda: deviceId });
		}
		return r.subida;
	}

	/**
	 * DO-SUBIDA · Un paso de la subida completa (`tenantHub.subida.ts`), como un lote de la Main: con
	 * la base abierta, en el turno del log, y después de la comprobación por actividad, que es la
	 * última espera. No escribe en el log ni difunde filas; al acabar una tabla avisa a las Handy
	 * (`datos_subidos`) para que relean.
	 */
	private async aplicarSubida(params: {
		tenantId: string;
		deviceId: string;
		sesion: WebSocket;
		paso: PasoDeSubida;
		alTerminar: (respuesta: Record<string, unknown>) => void;
	}): Promise<void> {
		const { tenantId, deviceId, sesion, paso } = params;
		const exigirQueSeaLaMain = () => {
			if (sesion.readyState !== 1 || !this.esLaMain(this.att(sesion))) throw new HubError("not_authenticated", 401);
		};
		exigirQueSeaLaMain();
		await this.withTenantDbRetry(tenantId, async (base) => base);
		return this.enTurnoDelLog(async () => {
			await this.comprobarMain();
			// ⚠️ De aquí al final no hay ninguna espera.
			exigirQueSeaLaMain();
			const tabla = "tabla" in paso ? paso.tabla : null;
			let r: ReturnType<typeof ejecutarPasoDeSubida>;
			try {
				r = ejecutarPasoDeSubida(this.state.storage, { deviceId, paso, ahoraMs: Date.now() });
			} catch (e: any) {
				const codigo = e instanceof HubError ? e.code : "";
				if (codigo === "subida_presupuesto_superado") {
					capturarError(e, "sync.subida");
					this.emitSyncEvent("subida_agotada", {});
				} else if (!codigo) {
					if (esBaseLlena(e)) this.avisarBaseLlena(e);
					else this.avisarUnaVez("subida_fallo", e, "sync.subida");
				}
				this.emitSyncEvent("subida_rechazo", { accion: paso.accion, tabla, error: codigo || "sqlite" });
				throw e;
			}
			params.alTerminar(r.respuesta);
			const efectos = r.efectos;
			if (efectos.empezada) this.emitSyncEvent("subida_empezada", {});
			if (efectos.aplazada) this.emitSyncEvent("subida_aplazada", { accion: paso.accion });
			if (efectos.rechazadas) this.emitSyncEvent("subida_rechazo", { accion: paso.accion, tabla, filas: efectos.rechazadas });
			if (efectos.tablaSubida) {
				this.emitSyncEvent("subida_tabla", { tabla: efectos.tablaSubida });
				this.broadcastRol("handy", { type: "datos_subidos", tablas: [efectos.tablaSubida] });
			}
			if (efectos.terminada) {
				const diferencias = Number((r.respuesta as { diferencias?: number }).diferencias ?? 0);
				this.emitSyncEvent("subida_terminada", { diferencias });
			}
		});
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

			// AUD-36: el presupuesto de escritura del negocio en esta hora. Agotado, ni ésta ni las de
			// detrás: la Main las conserva y las vuelve a mandar (`transitorio`), y sigue cobrando.
			const ahora = nowMs();
			if (presupuestoAgotado(this.state.storage, ahora)) {
				parado = true;
				resultados.push({ opId: o.opId, ok: false, error: "presupuesto_agotado", permanente: false, transitorio: true });
				this.avisarUnaVez("presupuesto_agotado", presupuestoAgotadoError(), "sync.presupuesto");
				return;
			}
			const tope = topeDeUnaOperacion();
			const tamanoAntes = this.state.storage.sql.databaseSize;

			const preparada = preparadas[i];
			try {
				if ("fallo" in preparada) throw preparada.fallo;
				const { seq, yaEstaba } = this.aplicarPreparada(preparada, () => aplazadas++ < LOTE_MAX_APLAZADAS, tope);
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
			} finally {
				// AUD-36: lo escrito, también lo de un intento que se deshizo; lo que ha crecido, sólo
				// lo confirmado.
				const crecido = this.state.storage.sql.databaseSize - tamanoAntes;
				apuntarGasto(this.state.storage, ahora, tope.medida.filas, crecido);
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
		tope?: TopeDeOperacion,
	): { seq: number; yaEstaba?: true } {
		let filas: FilasEnBruto[];
		try {
			filas = this.loteLocal(lote.stmts, alAplazar, tope);
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
		const seq = filas[lote.idxLog]?.lastInsertRowid ?? 0;
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
	private loteLocal(sentencias: SentenciaDelLote[], alAplazar: () => boolean, tope?: TopeDeOperacion): FilasEnBruto[] {
		return loteEnBruto(this.state.storage, sentencias, { alAplazar, tope });
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
	 *
	 * SYN-INC-01: y que dé señales de vida (`conLatido`). Un corte sin cierre deja el socket abierto
	 * hasta que vence el TCP, varios minutos en los que una sesión sin nadie detrás autorizaría a las
	 * Handy a escribir.
	 */
	private mainsAbiertas(except?: WebSocket): WsAttachment[] {
		const out: WsAttachment[] = [];
		const vigente = this.mainVigente();
		const ahora = Date.now();
		for (const ws of this.state.getWebSockets()) {
			if (except && ws === except) continue;
			if (ws.readyState !== 1) continue;
			const a = this.att(ws);
			if (a && this.esLaMain(a, vigente) && this.conLatido(ws, a, ahora)) out.push(a);
		}
		return out;
	}

	/**
	 * SYN-INC-01 · ¿Ha dado señales de vida esta sesión hace poco? Su último latido, que contesta el
	 * borde sin despertar al DO pero deja apuntada la hora (`getWebSocketAutoResponseTimestamp`), o,
	 * si todavía no ha mandado ninguno, la hora a la que se autenticó (`autenticadaMs`, en su
	 * attachment: sobrevive a la hibernación).
	 *
	 * Cuentan también el último mensaje que mandó (`ultimoMensajeMs`) y la hora a la que despertó esta
	 * instancia (`despiertaDesdeMs`): la documentación de Cloudflare no dice que el sello del latido
	 * sobreviva a la hibernación, y sin ese margen un sello perdido al despertar vetaría a toda Main
	 * ociosa en la primera escritura de una Handy. Tras despertar, una Main tiene 90 s para dar su
	 * siguiente latido (cada 30 s), y una muerta se cierra entonces.
	 */
	private conLatido(ws: WebSocket, a: WsAttachment, ahora: number): boolean {
		let latido = 0;
		try {
			latido = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
		} catch { }
		const senal = Math.max(latido, a.autenticadaMs ?? 0, this.ultimoMensajeMs.get(ws) ?? 0, this.despiertaDesdeMs);
		return ahora - senal <= MAIN_SIN_LATIDO_MS;
	}

	/**
	 * SYN-INC-01 · Cierra las sesiones de Main que han dejado de dar señales de vida. Por `cerrar`,
	 * como todo cierre que inicia el DO: queda fuera, y `sessionGone` les dice a las Handy que se han
	 * quedado sin Main (`main_offline`). Se mira cuando hace falta saberlo (una escritura de una Handy
	 * o un saludo), sin alarma ni temporizador: un negocio sin actividad no se despierta por esto. No
	 * espera nada.
	 */
	private cerrarMainsSinLatido(): void {
		const ahora = Date.now();
		for (const ws of this.state.getWebSockets()) {
			if (ws.readyState !== 1) continue;
			const a = this.att(ws);
			if (!a?.authed || a.fuera || a.role !== "tpv") continue;
			if (this.conLatido(ws, a, ahora)) continue;
			this.emitSyncEvent("main_sin_latido", { device_id: a.deviceId });
			this.cerrar(ws, a, 4002, "main_sin_latido");
		}
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

		// MES-INC-03: antes del veto, que es lo último que espera.
		peticion = await this.conLaHoraDelNegocio(peticion, identidad.tenantId);

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

	/**
	 * MES-INC-03: la petición con su `X-Client-Now` en la hora del negocio. La Handy la manda con su
	 * desfase (`instanteDeClientNow`) y su hora de pared puede ser la de otra zona: un Android en GMT
	 * en un bar de Madrid iba una hora por detrás en todo lo que escribía y leía (la reserva próxima no
	 * salía, «hoy» cambiaba antes). Se pasa aquí, por donde entran todas las rutas de negocio, a la
	 * zona que deja la Main (`Zona_Horaria`), y las rutas siguen leyendo una hora sin desfase. Sin
	 * desfase (la Main, una Handy de antes) la petición sigue tal cual. Sin base todavía, la zona de
	 * por defecto: la ruta contestará lo suyo.
	 */
	private async conLaHoraDelNegocio(peticion: Request, tenantId: string): Promise<Request> {
		const instante = instanteDeClientNow(peticion.headers.get("x-client-now"));
		if (instante === null) return peticion;
		let hora: string;
		try {
			hora = await horaDelNegocio(await this.getTenantDb(tenantId), instante);
		} catch {
			hora = horaLocalEn("", instante);
		}
		const cabeceras = new Headers(peticion.headers);
		cabeceras.set("x-client-now", hora);
		return new Request(peticion, { headers: cabeceras });
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
		// SYN-INC-01: lo que manda una sesión es señal de vida, como su latido (`conLatido`).
		this.ultimoMensajeMs.set(ws, Date.now());
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
			registrarFalloDeLaCentral: (error, operacion, tenantId) =>
				this.registrarFalloDeLaCentral(error, operacion, tenantId),
			cerrar: (ws, a, code, motivo) => this.cerrar(ws, a, code, motivo),
			enTurnoDeEntrada: (trabajo) => this.enTurnoDeEntrada(trabajo),
			isMainConnected: (except) => this.isMainConnected(except),
			isMainRecovering: () => this.isMainRecovering(),
			cerrarMainsSinLatido: () => this.cerrarMainsSinLatido(),
			aplicarLote: (params) => this.aplicarLote(params),
			subidaParaElSaludo: (deviceId) => this.subidaParaElSaludo(deviceId),
			aplicarSubida: (params) => this.aplicarSubida(params),
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
