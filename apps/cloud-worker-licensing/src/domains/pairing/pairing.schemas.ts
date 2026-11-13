// src/domains/pairing/pairing.schemas.ts
//
// Lo que tiene que traer cada petición de emparejamiento.
//
// Antes esto eran `if`s encadenados dentro de cada handler, cada uno con su `readJsonSafe` y su
// `String(body.x ?? "").trim()`. Lo que NO cambia al pasarlos a zod es el identificador con el que
// se rechaza cada campo: la Handy no tiene sesión ni pantalla que consultar, así que lo único que
// puede enseñarle a quien está delante es la frase que `lib/errorCodes.ts` asocia a ese
// identificador (por eso estas rutas usan `cuerpoConIdentificador` y no `cuerpo`).
//
// ⚠️ **El orden de las claves importa.** zod recorre un objeto en el orden en que se declara y el
// gancho se queda con el PRIMER fallo, así que cada schema se escribe en el mismo orden en que el
// handler comprobaba los campos a mano.
//
// NOTA sobre tipos: el emparejamiento NO tiene DTOs generados desde Rust —el cliente no llama a
// estos endpoints con structs tipadas, sino por el passthrough genérico `tpv_server_post_json`—,
// así que aquí no hay drift-guard contra `@tpv/contracts` como en los dominios de negocio. No es
// un olvido: no hay contraparte que comparar.

import * as z from "zod";

import { textoObligatorio } from "../../lib/validacion";
import { sanitizeB64 } from "./pairing.firma";
import { b64ToBytes } from "../../server/utils/base64";
import { TOPE_CLAVE_B64, TOPE_FIRMA_B64 } from "../../server/utils/ed25519";

/** 32 bytes en base64, normalizados. Es lo que hacía `normalizeEd25519PubkeyB64`. */
function esClaveEd25519(b64: string): boolean {
	try {
		return b64ToBytes(b64).length === 32;
	} catch {
		return false;
	}
}

const codigoDeSeisCifras = z
	.string({ message: "invalid_pair_code" })
	.trim()
	.regex(/^\d{6}$/, { message: "invalid_pair_code" });

// AUD-33: la firma y la clave pública son `textoObligatorio` con su tope delante del recorte: el
// `.max()` mira la cadena tal como llega, así que un relleno de espacios no cuela una más larga. zod
// ejecuta las comprobaciones en el orden en que se escriben.

/** La prueba de posesión que acompaña a `fetch-token` y a `cancel`. */
const pruebaDelReclamante = {
	nonceB64: textoObligatorio("missing_proof"),
	// Una firma son 88 caracteres. Más larga no llega a `sanitizeB64` ni a la base.
	sigB64: z
		.string({ message: "missing_proof" })
		.max(TOPE_FIRMA_B64, { message: "missing_proof" })
		.trim()
		.min(1, { message: "missing_proof" }),
	ts: z.coerce.number({ message: "missing_proof" }).refine((n) => n > 0, { message: "missing_proof" }),
};

export const claimSchema = z.object({
	pairCode: codigoDeSeisCifras,
	// Opcional a propósito: por QR/URI llega y se verifica; por «sólo código» no lo hay y la
	// seguridad recae en la espera por fallos, en que el claim se adjudique al primero y en la
	// aprobación manual de la Main (ver `pairing.handy.ts`).
	pairSecret: z.string().trim().optional().default(""),
	deviceId: textoObligatorio("missing_deviceId"),
	// El tope va también DELANTE del `transform`. Con cualquier fallo antes, zod no lo llama: una clave
	// de 44 caracteres pasa, y un cuerpo de comillas o de espacios no llega a `sanitizeB64`.
	devicePubKey: z
		.string({ message: "missing_devicePubKey" })
		.max(TOPE_CLAVE_B64, { message: "invalid_devicePubKey" })
		.trim()
		.min(1, { message: "missing_devicePubKey" })
		.transform(sanitizeB64)
		.refine(esClaveEd25519, { message: "invalid_devicePubKey" }),
	deviceName: z.string().trim().optional().default(""),
});

export const fetchTokenSchema = z.object({
	pairCode: textoObligatorio("missing_pairCode"),
	deviceId: textoObligatorio("missing_deviceId"),
	...pruebaDelReclamante,
});

export const cancelSchema = z.object({
	pairCode: textoObligatorio("missing_pairCode"),
	deviceId: textoObligatorio("missing_deviceId"),
	...pruebaDelReclamante,
});

/** Aprobar y rechazar sólo necesitan el código; quién lo pide sale del token, nunca del cuerpo. */
export const pairCodeSchema = z.object({
	pairCode: textoObligatorio("missing_pairCode"),
});

export const revocarSchema = z.object({
	deviceId: textoObligatorio("missing_deviceId"),
});
