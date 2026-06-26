// src/lib/internalAuth.ts
//
// Autenticación HMAC entre el worker `tpv-api` y sus endpoints internos —
// incluido el `/internal/apply` del Durable Object TenantHub.
//
// El secreto compartido es `LICENSE_JWT_SECRET` (presente sólo en el entorno del
// worker y del DO, nunca en clientes). La firma cubre `ts + método + path + body`
// y lleva una ventana de 60s para mitigar replays. Es la ÚNICA fuente del esquema:
// tanto el firmante (`lib/hub.ts`) como los verificadores (`server/index.ts` y el
// DO) la consumen desde aquí para evitar divergencias.

const MAX_SKEW_MS = 60 * 1000;

export async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(raw),
	);

	return [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

function buildInternalPayload(
	ts: number,
	method: string,
	pathname: string,
	rawBody: string,
): string {
	return `${ts}\n${method.toUpperCase()}\n${pathname}\n${rawBody}`;
}

/**
 * Firma una request interna. Devuelve los headers que el llamante debe adjuntar
 * (`x-internal-ts` / `x-internal-sig`). `pathname` y `rawBody` deben coincidir
 * exactamente con los que verá el verificador.
 */
export async function signInternalWorkerRequest(
	secret: string,
	method: string,
	pathname: string,
	rawBody: string,
): Promise<{ "x-internal-ts": string; "x-internal-sig": string }> {
	const ts = Date.now();
	const sig = await hmacSha256Hex(
		String(secret || ""),
		buildInternalPayload(ts, method, pathname, rawBody),
	);
	return { "x-internal-ts": String(ts), "x-internal-sig": sig };
}

/**
 * Verifica una request interna firmada con el shared secret. Lanza un `Error`
 * con código de negocio (`missing_internal_auth`, `bad_internal_ts`,
 * `internal_ts_out_of_range`, `bad_internal_signature`) si no es válida.
 */
export async function verifyInternalWorkerRequest(
	req: Request,
	secret: string,
	rawBody: string,
): Promise<void> {
	const tsStr = (req.headers.get("x-internal-ts") || "").trim();
	const sigHex = (req.headers.get("x-internal-sig") || "").trim().toLowerCase();

	if (!tsStr || !sigHex) throw new Error("missing_internal_auth");

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) throw new Error("bad_internal_ts");

	if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
		throw new Error("internal_ts_out_of_range");
	}

	const expected = await hmacSha256Hex(
		String(secret || ""),
		buildInternalPayload(ts, req.method, new URL(req.url).pathname, rawBody),
	);

	if (!timingSafeEqualHex(expected, sigHex)) {
		throw new Error("bad_internal_signature");
	}
}
