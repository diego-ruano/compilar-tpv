// src/durableObjects/tenantHub.types.ts
//
// Tipos del Durable Object `TenantHub`, extraídos de `tenantHub.ts` para que ese fichero se
// quede sólo con la lógica. Aquí no hay comportamiento: son la **forma de los mensajes** que
// entran por el WebSocket y la del comando interno que aplica el motor idempotente.
//
// Se agrupan en tres bloques:
//   1. Sesión           — lo que describe a un socket conectado (`WsAttachment`).
//   2. Mensajes del WS  — lo que un dispositivo puede mandar (`AnyMsg` y sus variantes).
//   3. Comando interno  — el SQL replicable que llega por el RPC `aplicar` o por `apply_lote`.

export type Role = "tpv" | "handy" | "unknown";

/* =========================================================
   1. Sesión
========================================================= */

// SYNC-16 (hibernación): TODO el estado de una sesión WS vive aquí, adosado al propio socket
// (`serializeAttachment`), no en campos de la instancia del DO. Con la WebSocket Hibernation API el
// DO se evacúa de memoria mientras las conexiones están ociosas y vuelve con los campos vacíos, así
// que cualquier `Map` por dispositivo se perdería. El attachment sobrevive a la hibernación.
// Límite: 16 KB serializados (aquí ocupamos ~200 bytes).
export type WsAttachment = {
	tenantId: string;
	deviceId: string;
	/** Rol vigente: el de la cabecera `x-role` al conectar; lo pisa el rol real (BD central) al autenticar. */
	role: Role;
	authed: boolean;
	/** Clave pública conocida del dispositivo (pista de cabecera o la confirmada en el hello). */
	pubkeyB64: string | null;
	/** Challenge pendiente. SYNC-07: se consume (a `null`) en el primer intento de verificación. */
	challenge: { nonceB64: string; expiresAtMs: number } | null;
	/** La Main ha restaurado una copia y todavía está reconciliándola. Bloquea las Handy. */
	recovering?: boolean;
	/**
	 * AUD-02: la sesión se ha cerrado (`cerrar`, `webSocketClose`): ya no es la Main, la han dado de
	 * baja, la ha reemplazado una reconexión o se ha ido. No vuelve a autenticarse aunque tuviera un
	 * saludo a medias, ni entra lo que dejara esperando. Quién es la Main no va aquí: está en el SQL del DO
	 * (`tenantHub.main.ts`), que es uno para todas las sesiones.
	 */
	fuera?: boolean;
};

/* =========================================================
   2. Mensajes que entran por el WebSocket
========================================================= */

export type PingMsg = { type: "ping" };

export type HelloSignedMsg = {
	type: "helloSigned";
	ts: number;
	nonceB64: string;
	sigB64: string;
	role?: Role;
	recovering?: boolean;
};

export type RecoveryReadyMsg = { type: "recovery_ready" };

/** Una operación de un `apply_lote`, tal como llega: el comando interno, para el motor idempotente. */
type OpDeLoteMsg = {
	opId?: string;
	op_id?: string;
	commandName?: string;
	command_name?: string;
	command?: { type: string; payload?: any };
	cloud_payload?: any;
	cloudPayload?: any;
	cloud_payload_json?: string;
	cloudPayloadJson?: string;
	request_payload?: any;
	requestPayload?: any;
};

/**
 * Lo que la Main sube de su outbox, en orden y de una vez: hasta 200 operaciones por mensaje. El DO
 * las aplica una detrás de otra y contesta con un `apply_lote_ack` que lleva el veredicto de cada
 * una (`VeredictoDeLote`).
 */
export type ApplyLoteMsg = {
	type: "apply_lote";
	loteId?: string;
	ops?: OpDeLoteMsg[];
	client_now?: string;
	clientNow?: string;
};

/**
 * Lo que fue de cada operación de un `apply_lote`, en el orden en que llegaron:
 *
 * - aplicada, con el `Seq` que le dio el log; `yaEstaba` si es un reenvío de algo ya confirmado;
 * - rechazada, con su clase: `permanente` (la Main la aparta y repara por estado), `transitorio`
 *   (no le cuenta el intento) o ninguna de las dos (se lo cuenta). Tras una rechazada que no es
 *   permanente no se aplica nada más del lote;
 * - `noIntentada`: iba detrás de una que paró el lote, o no cabía en el trabajo de un turno. No se
 *   ha tocado y se vuelve a mandar tal cual.
 */
export type VeredictoDeLote =
	| { opId: string; ok: true; seq: number; yaEstaba?: true }
	| { opId: string; ok: false; error: string; permanente: boolean; transitorio: boolean }
	| { opId: string; ok: false; noIntentada: true };

/** Una operación de un `apply_lote`, con la forma ya comprobada. */
export type OpDeLote = {
	opId: string;
	commandName: string;
	cmd: InternalApplyCommand;
	/** Cuerpo canónico que se hashea (`Request_Hash` del gate de idempotencia). */
	requestPayloadJson: string;
	clientNow?: string | null;
};

export type AnyMsg =
	| PingMsg
	| HelloSignedMsg
	| RecoveryReadyMsg
	| ApplyLoteMsg;

/* =========================================================
   3. Comando interno (SQL replicable)
========================================================= */

export type SqlScalar = string | number | boolean | null;
export type SqlRef = { $ref: string };
export type SqlArg = SqlScalar | SqlRef;

// Sentencia de escritura ya resuelta (sin $ref): lo que se reenvía/persiste para la Main.
export type ResolvedStmt = { sql: string; args: SqlScalar[] };

export type ExecPayload = {
	sql: string;
	args?: SqlArg[];
};

export type QueryPayload = {
	sql: string;
	args?: SqlArg[];
};

export type TxStep =
	| {
		kind: "execute";
		sql: string;
		args?: SqlArg[];
		saveAs?: string;
	}
	| {
		kind: "value";
		sql: string;
		args?: SqlArg[];
		saveAs: string;
	}
	| {
		kind: "row";
		sql: string;
		args?: SqlArg[];
		saveAs: string;
	}
	| {
		kind: "rows";
		sql: string;
		args?: SqlArg[];
		saveAs: string;
	};

export type TransactionPayload = {
	steps: TxStep[];
	resultKey?: string;
	beginMode?: "deferred" | "immediate" | "exclusive";
};

export type InternalApplyCommand =
	| { type: "tenantDb.exec"; payload: ExecPayload }
	| { type: "tenantDb.value"; payload: QueryPayload }
	| { type: "tenantDb.row"; payload: QueryPayload }
	| { type: "tenantDb.rows"; payload: QueryPayload }
	| { type: "tenantDb.transaction"; payload: TransactionPayload };
