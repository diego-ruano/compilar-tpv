// src/server/endpoints/rest/queries/login/pinKdf.ts
// ✅ SIN WASM: PBKDF2 (WebCrypto)
// Formato: $pbkdf2-sha256$i=<iter>$<salt_b64>$<dk_b64>

const ENC = new TextEncoder();

export const PBKDF2_PREFIX = "$pbkdf2-sha256$";
export const DEFAULT_ITERS = 100_000;

const SALT_LEN = 16;
const DK_LEN = 32;

// --- base64 helpers (Workers: btoa/atob existen)
function b64encode(u8: Uint8Array): string {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
}

function b64decode(b64: string): Uint8Array {
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length); // ✅ ArrayBuffer REAL
    const out = new Uint8Array(ab);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// Uint8Array -> ArrayBuffer REAL (copia)
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
}

async function pbkdf2Derive(
    pin: string,
    salt: Uint8Array,
    iterations: number,
    dkLen: number
): Promise<Uint8Array> {
    const pwU8 = ENC.encode(pin);
    const pwBuf = toArrayBuffer(pwU8);
    const saltBuf = toArrayBuffer(salt);

    const key = await crypto.subtle.importKey(
        "raw",
        pwBuf,
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: saltBuf, iterations, hash: "SHA-256" },
        key,
        dkLen * 8
    );

    return new Uint8Array(bits);
}

function parsePbkdf2Phc(phc: string): {
    iterations: number;
    salt: Uint8Array;
    dk: Uint8Array;
} {
    const h = String(phc || "").trim();

    // Argon2 ya no se soporta en Worker (WASM bloqueado).
    if (h.startsWith("$argon2") || h.startsWith("argon2")) {
        throw new Error(
            "HASH_ARGON2_NO_SOPORTADO: rehash Password_Hash a pbkdf2-sha256"
        );
    }

    if (!h.startsWith(PBKDF2_PREFIX)) {
        throw new Error("HASH_DESCONOCIDO: Password_Hash no es pbkdf2-sha256");
    }

    // $pbkdf2-sha256$i=210000$<salt_b64>$<dk_b64>
    const parts = h.split("$");
    // ["", "pbkdf2-sha256", "i=210000", "<salt>", "<dk>"]
    if (parts.length < 5) throw new Error("Hash almacenado mal formado");

    const iterPart = String(parts[2] || "");
    const saltB64 = String(parts[3] || "");
    const dkB64 = String(parts[4] || "");

    const m = iterPart.match(/i=(\d+)/);
    const iterations = m ? (parseInt(m[1], 10) | 0) : DEFAULT_ITERS;
    if (!Number.isFinite(iterations) || iterations <= 0) {
        throw new Error("Hash params i inválido");
    }

    const salt = b64decode(saltB64);
    const dk = b64decode(dkB64);
    if (!salt.length || !dk.length) throw new Error("Hash almacenado mal formado");

    return { iterations, salt, dk };
}

export async function verifyPinPbkdf2(pin: string, storedPhc: string): Promise<void> {
    const p = String(pin ?? "").trim();
    if (p.length < 4) throw new Error("PIN incorrecto");

    const parsed = parsePbkdf2Phc(storedPhc);
    const actual = await pbkdf2Derive(p, parsed.salt, parsed.iterations, parsed.dk.length);

    if (!timingSafeEqual(actual, parsed.dk)) {
        throw new Error("PIN incorrecto");
    }
}

export async function hashPinPbkdf2(pin: string, iterations = DEFAULT_ITERS): Promise<string> {
    const p = String(pin ?? "").trim();
    if (p.length < 4) throw new Error("PIN demasiado corto");

    const ab = new ArrayBuffer(SALT_LEN);
    const salt = new Uint8Array(ab);
    crypto.getRandomValues(salt);

    const dk = await pbkdf2Derive(p, salt, iterations, DK_LEN);
    return `${PBKDF2_PREFIX}i=${iterations}$${b64encode(salt)}$${b64encode(dk)}`;
}

export function validateEmailBasic(email: string): boolean {
    const e = String(email || "").trim();
    return e.length >= 6 && e.includes("@") && e.includes(".") && !e.includes(" ");
}