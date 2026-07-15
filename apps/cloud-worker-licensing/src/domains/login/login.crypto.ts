// src/domains/login/login.crypto.ts

import { b64ToBytes, bytesToB64 } from "../../server/utils/base64";

const PREFIX = "$pbkdf2-sha256$";
// Iteraciones para hashes NUEVOS. Espejo de `PBKDF2_ITERS` en crates/tpv-domain/src/login.rs.
// TOPE de Cloudflare Workers: `crypto.subtle` PBKDF2 no admite más de 100.000 iteraciones (límite
// del runtime, NO del plan). Como este mismo módulo también VERIFICA (`verify` usa las iteraciones
// de cada hash), un hash con >100k tampoco se podría comprobar aquí. 100k es el máximo posible.
const DEFAULT_ITERS = 100000;
const SALT_LEN = 16;
const DK_LEN = 32;

function timingSafeEq(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

async function derive(pin: string, salt: Uint8Array, iters: number, len: number) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pin),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			salt: salt as unknown as BufferSource,
			iterations: iters,
		},
		key,
		len * 8,
	);
	return new Uint8Array(bits);
}

function parse(hash: string): { iters: number; salt: Uint8Array; dk: Uint8Array } {
	const h = hash.trim();
	if (h.startsWith("$argon2") || h.startsWith("argon2")) {
		throw new Error("HASH_ARGON2_NO_SOPORTADO: rehash Password_Hash a pbkdf2-sha256");
	}
	if (!h.startsWith(PREFIX)) throw new Error("HASH_DESCONOCIDO: Password_Hash no es pbkdf2-sha256");
	const parts = h.split("$");
	if (parts.length < 5) throw new Error("Hash almacenado mal formado");
	const iters = Number(parts[2]?.replace(/^i=/, ""));
	if (!Number.isInteger(iters) || iters <= 0) throw new Error("Hash params i invalido");
	const salt = b64ToBytes(parts[3]);
	const dk = b64ToBytes(parts[4]);
	if (!salt.length || !dk.length) throw new Error("Hash almacenado mal formado");
	return { iters, salt, dk };
}

export async function verifyPin(pin: string, storedHash: string): Promise<void> {
	const p = pin.trim();
	if (p.length < 4) throw new Error("PIN incorrecto");
	const parsed = parse(storedHash);
	const actual = await derive(p, parsed.salt, parsed.iters, parsed.dk.length);
	if (!timingSafeEq(actual, parsed.dk)) throw new Error("PIN incorrecto");
}

export async function hashPin(pin: string): Promise<string> {
	const p = pin.trim();
	if (p.length < 4) throw new Error("PIN demasiado corto");
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const dk = await derive(p, salt, DEFAULT_ITERS, DK_LEN);
	return `${PREFIX}i=${DEFAULT_ITERS}$${bytesToB64(salt)}$${bytesToB64(dk)}`;
}
