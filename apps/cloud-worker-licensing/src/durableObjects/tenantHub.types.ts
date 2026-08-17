// src/durableObjects/tenantHub.types.ts
//
// Tipos del Durable Object `TenantHub`, extraídos de `tenantHub.ts` para que ese fichero se
// quede sólo con la lógica. Aquí no hay comportamiento: son la **forma de los mensajes** que
// entran por el WebSocket y la del comando interno que aplica el motor idempotente.
//
// Se agrupan en tres bloques:
//   1. Sesión           — lo que describe a un socket conectado (`WsAttachment`).
//   2. Mensajes del WS  — lo que un dispositivo puede mandar (`AnyMsg` y sus variantes).
//   3. Comando interno  — el SQL replicable que llega por `/internal/apply` o por `apply`.

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
};

export type EventMsg = { type: "event"; name: string; payload?: any };

// Escritura de la Main por WS: lleva el comando interno (mismo envelope que
// `/internal/apply`) para aplicarse en el motor idempotente del DO.
export type ApplyMsg = {
	type: "apply";
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

export type AnyMsg = PingMsg | HelloSignedMsg | EventMsg | ApplyMsg;

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
	| { type: "tenantDb.ping" }
	| { type: "tenantDb.exec"; payload: ExecPayload }
	| { type: "tenantDb.value"; payload: QueryPayload }
	| { type: "tenantDb.row"; payload: QueryPayload }
	| { type: "tenantDb.rows"; payload: QueryPayload }
	| { type: "tenantDb.transaction"; payload: TransactionPayload };
