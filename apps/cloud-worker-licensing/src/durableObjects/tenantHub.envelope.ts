// src/durableObjects/tenantHub.envelope.ts
//
// El "sobre" de un comando: los metadatos que lo identifican (`opId`, `commandName`,
// `deviceId`) y la carga de dominio que se guarda en `Sync_Changes` para que la Main pueda
// reconstruir lo ocurrido.
//
// Casi todo aquí existe por una razón concreta: el sobre llega en **muchas formas**. La Main
// y la Handy han ido usando snake_case y camelCase, el payload a veces viene ya serializado y
// a veces como objeto, y el nombre del campo cambia según el dominio. En vez de repartir esa
// tolerancia por el motor, se concentra en estas funciones.
//
// La serialización es **estable** (claves ordenadas) porque el JSON resultante se usa para
// hashear e identificar operaciones: si el orden de las claves cambiara entre dos ejecuciones,
// la misma operación produciría hashes distintos y la idempotencia dejaría de funcionar.

import { bytesToB64 } from "../server/utils/base64";
import { toPlainValue } from "./tenantHub.sentencias";
import type { InternalApplyCommand } from "./tenantHub.types";

/** Su pareja tolerante: para lo que llega de fuera y cuyo fallo NO es una excepción. */
export function safeJsonParse(s: string): any | null {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

export function parseJsonStrict(s: string, fieldName: string): any {
	try {
		return JSON.parse(s);
	} catch {
		throw new Error(`invalid_${fieldName}`);
	}
}

/* =========================================================
   Serialización estable
========================================================= */

export function stableNormalize(v: any): any {
	if (v == null) return null;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Uint8Array) return bytesToB64(v);
	if (Array.isArray(v)) return v.map(stableNormalize);
	if (typeof v === "object") {
		const out: Record<string, any> = {};
		for (const k of Object.keys(v).sort()) {
			out[k] = stableNormalize(v[k]);
		}
		return out;
	}
	return v;
}

export function stableStringify(v: any): string {
	return JSON.stringify(stableNormalize(v ?? null));
}

export function stringifyJsonValue(v: any): string {
	const s = JSON.stringify(toPlainValue(v ?? null));
	return s === undefined ? "null" : s;
}

export function optionalJsonFieldToStableString(
	value: unknown,
	fieldName: string,
): string | null {
	if (value === undefined || value === null) return null;

	const raw = String(value).trim();
	if (!raw) return null;

	return stableStringify(parseJsonStrict(raw, fieldName));
}

/* =========================================================
   Lectura tolerante del sobre
========================================================= */

export function hasOwn(obj: any, key: string): boolean {
	return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

export function getFirstOwnValue(obj: any, keys: string[]): any {
	if (!obj || typeof obj !== "object") return undefined;

	for (const key of keys) {
		if (hasOwn(obj, key)) return obj[key];
	}

	return undefined;
}

export function buildInternalPayloadForHash(cmd: InternalApplyCommand): any {
	return {
		type: cmd.type,
		payload: (cmd as any).payload ?? null,
	};
}

export function buildCommandEnvelope(opId: string, commandName: string, args: any): any {
	return {
		op_id: opId,
		command_name: commandName,
		args: args ?? {},
	};
}

export function readRequestPayloadJson(
	body: any,
	fallbackPayloadForHash: any,
): string {
	const requestPayloadJson = optionalJsonFieldToStableString(
		getFirstOwnValue(body, ["request_payload_json", "requestPayloadJson"]),
		"request_payload_json",
	);

	if (requestPayloadJson) {
		return requestPayloadJson;
	}

	const requestPayload = getFirstOwnValue(body, [
		"request_payload",
		"requestPayload",
		"request_args",
		"requestArgs",
	]);

	if (requestPayload !== undefined) {
		return stableStringify(toPlainValue(requestPayload));
	}

	const cloudPayloadJson = optionalJsonFieldToStableString(
		getFirstOwnValue(body, ["cloud_payload_json", "cloudPayloadJson"]),
		"cloud_payload_json",
	);

	if (cloudPayloadJson) {
		return cloudPayloadJson;
	}

	const cloudPayload = getFirstOwnValue(body, [
		"cloud_payload",
		"cloudPayload",
		"sync_payload",
		"syncPayload",
		"domain_payload",
		"domainPayload",
	]);

	if (cloudPayload !== undefined) {
		return stableStringify(toPlainValue(cloudPayload));
	}

	return stableStringify(fallbackPayloadForHash);
}

export function readCloudPayloadJson(params: {
	body: any;
	opId: string;
	commandName: string;
	fallbackPayloadForHash: any;
}): string {
	const { body, opId, commandName, fallbackPayloadForHash } = params;

	const cloudPayloadJson = optionalJsonFieldToStableString(
		getFirstOwnValue(body, ["cloud_payload_json", "cloudPayloadJson"]),
		"cloud_payload_json",
	);

	if (cloudPayloadJson) {
		return cloudPayloadJson;
	}

	const cloudPayload = getFirstOwnValue(body, [
		"cloud_payload",
		"cloudPayload",
		"sync_payload",
		"syncPayload",
		"domain_payload",
		"domainPayload",
	]);

	if (cloudPayload !== undefined) {
		return stableStringify(toPlainValue(cloudPayload));
	}

	const domainArgs = getFirstOwnValue(body, ["args", "input", "params"]);

	if (domainArgs !== undefined) {
		return stableStringify(buildCommandEnvelope(opId, commandName, domainArgs));
	}

	return stableStringify(fallbackPayloadForHash);
}

export function readEnvelopeMetadata(body: any, req: Request) {
	const opId = String(
		body?.opId ??
		body?.op_id ??
		req.headers.get("x-idempotency-key") ??
		"",
	).trim();

	const commandName = String(
		body?.commandName ??
		body?.command_name ??
		req.headers.get("x-command-name") ??
		"",
	).trim();

	const deviceId = String(
		body?.deviceId ??
		body?.device_id ??
		req.headers.get("x-device-id") ??
		"",
	).trim();

	return {
		opId,
		commandName,
		deviceId: deviceId || null,
	};
}

/* =========================================================
   Hashing
========================================================= */

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function sha256Hex(raw: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(raw),
	);
	return toHex(new Uint8Array(digest));
}
