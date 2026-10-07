// src/server/crypto.ts
//
// El cifrado en reposo de la base central con `LICENSE_STORE_KEY`: las claves de licencia
// (`licenses.license_key_enc`), la DEK de cada negocio (`tenants.field_dek`) y el token de Turso de
// cada negocio (`tenant_databases.turso_auth_token_enc`). Es el ÚNICO sitio que cifra o descifra con
// esa clave: había tres implementaciones del mismo AES-GCM, y versionar el formato en una sola
// habría dejado a las otras dos leyendo a ciegas.
//
// RI-73 · El formato lleva la versión de la clave: `k<id>:` + base64(iv‖ct). Antes era sólo el
// base64, sin decir con qué clave, así que cambiarla dejaba ilegible todo lo anterior —y pasó: el
// 27/09 se regeneraron los secretos del worker y las activaciones empezaron a fallar con
// «Decryption failed»—. Ahora:
//   · `LICENSE_STORE_KEY` + `LICENSE_STORE_KEY_ID` (por defecto "1") es la clave con la que se
//     escribe;
//   · `LICENSE_STORE_KEY_ANTERIOR` + `LICENSE_STORE_KEY_ANTERIOR_ID` (opcionales) es la de antes,
//     que sólo se usa para leer mientras dura una rotación;
//   · un valor sin prefijo es de antes de esto, y se lee con la clave "1".
// Lo que se lee con la anterior sale también recifrado con la actual (`recifrado`), para que quien
// lo leyó lo guarde: así la rotación se completa sola, y `/v1/admin/store-key/recifrar` la termina
// de una vez. Procedimiento: docs/arquitectura/licencias.md («Rotar LICENSE_STORE_KEY»).

/** Las claves de cifrado en reposo. `Env` lo cumple tal cual. */
export type ClavesDeAlmacen = {
	LICENSE_STORE_KEY: string;
	LICENSE_STORE_KEY_ID?: string;
	LICENSE_STORE_KEY_ANTERIOR?: string;
	LICENSE_STORE_KEY_ANTERIOR_ID?: string;
};

/** Una clave suelta vale como «sólo la actual, versión 1»: es lo que pasan los tests. */
export type ClavesOClave = ClavesDeAlmacen | string;

/** La versión que se le supone a un valor sin prefijo: lo cifrado antes de existir las versiones. */
const VERSION_SIN_PREFIJO = "1";

const PREFIJO = /^k([0-9a-z]+):/;

type Clave = { id: string; b64: string };

function normalizar(claves: ClavesOClave): { actual: Clave; anterior: Clave | null } {
	if (typeof claves === "string") {
		return { actual: { id: VERSION_SIN_PREFIJO, b64: claves }, anterior: null };
	}
	const actual = {
		id: String(claves.LICENSE_STORE_KEY_ID || VERSION_SIN_PREFIJO).trim(),
		b64: claves.LICENSE_STORE_KEY,
	};
	const anteriorB64 = String(claves.LICENSE_STORE_KEY_ANTERIOR || "").trim();
	const anterior = anteriorB64
		? { id: String(claves.LICENSE_STORE_KEY_ANTERIOR_ID || VERSION_SIN_PREFIJO).trim(), b64: anteriorB64 }
		: null;
	if (anterior && anterior.id === actual.id) {
		// Dos claves con la misma versión: no se podría saber cuál cifró qué. Es un error de
		// configuración, y es mejor verlo en el primer uso que con datos mezclados.
		throw new Error("LICENSE_STORE_KEY_ANTERIOR_ID no puede ser igual que LICENSE_STORE_KEY_ID");
	}
	return { actual, anterior };
}

/** La versión con la que está cifrado un valor guardado. */
export function versionDe(cifrado: string): string {
	return PREFIJO.exec(cifrado)?.[1] ?? VERSION_SIN_PREFIJO;
}

/** La versión de la clave con la que se escribe. */
export function versionActual(claves: ClavesOClave): string {
	return normalizar(claves).actual.id;
}

/** Cifra con la clave actual. */
export async function cifrar(claves: ClavesOClave, texto: string): Promise<string> {
	const { actual } = normalizar(claves);
	return `k${actual.id}:${await cifrarCon(actual.b64, texto)}`;
}

/**
 * Descifra con la clave de la versión que lleve el valor. Si no fue la actual, `recifrado` trae el
 * mismo texto cifrado con ella, para guardarlo en lugar del viejo.
 */
export async function descifrar(
	claves: ClavesOClave,
	cifrado: string,
): Promise<{ texto: string; recifrado: string | null }> {
	const { actual, anterior } = normalizar(claves);
	const version = versionDe(cifrado);
	const cuerpo = cifrado.replace(PREFIJO, "");

	if (version === actual.id) {
		return { texto: await descifrarCon(actual.b64, cuerpo), recifrado: null };
	}
	if (anterior && version === anterior.id) {
		const texto = await descifrarCon(anterior.b64, cuerpo);
		return { texto, recifrado: await cifrar(claves, texto) };
	}
	throw new Error(`clave_de_almacen_desconocida: el valor está cifrado con la versión ${version}`);
}

async function importar(keyB64: string, uso: "encrypt" | "decrypt"): Promise<CryptoKey> {
	const bytes = b64ToBytes(keyB64);
	if (bytes.length !== 32) throw new Error("LICENSE_STORE_KEY must decode to 32 bytes");
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [uso]);
}

async function cifrarCon(keyB64: string, texto: string): Promise<string> {
	const key = await importar(keyB64, "encrypt");
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(texto));
	const out = new Uint8Array(iv.length + enc.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(enc), iv.length);
	return bytesToB64(out);
}

async function descifrarCon(keyB64: string, b64: string): Promise<string> {
	const key = await importar(keyB64, "decrypt");
	const raw = b64ToBytes(b64);
	const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
	return new TextDecoder().decode(dec);
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
