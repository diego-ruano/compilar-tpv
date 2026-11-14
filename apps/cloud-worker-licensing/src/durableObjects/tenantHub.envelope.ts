// src/durableObjects/tenantHub.envelope.ts
//
// El cuerpo canónico de una operación, el que se hashea para el gate de idempotencia
// (`Request_Hash`), y el JSON de lo que llega de fuera.
//
// La serialización es **estable** (claves ordenadas) porque el JSON resultante se usa para
// hashear e identificar operaciones: si el orden de las claves cambiara entre dos ejecuciones,
// la misma operación produciría hashes distintos y la idempotencia dejaría de funcionar.

import { bytesToB64 } from "../server/utils/base64";
import { toPlainValue } from "./tenantHub.sentencias";
import type { InternalApplyCommand } from "./tenantHub.types";

/** Para lo que llega de fuera y cuyo fallo NO es una excepción. */
export function safeJsonParse(s: string): any | null {
	try {
		return JSON.parse(s);
	} catch {
		return null;
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

/* =========================================================
   El cuerpo que se hashea
========================================================= */

/**
 * El `Request_Hash` de una operación es su cuerpo canónico (`stableStringify`): el de una escritura
 * de la Handy, el cuerpo del dominio (`cloudPayload`, `lib/rutas.ts`); el de una operación de la
 * Main (`apply_lote`), su comando interno, que es esto.
 */
export function buildInternalPayloadForHash(cmd: InternalApplyCommand): any {
	return {
		type: cmd.type,
		payload: (cmd as any).payload ?? null,
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
