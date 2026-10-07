#!/usr/bin/env node
//
// Genera el par ed25519 con el que el worker FIRMA el estado de licencia (docs/arquitectura/licencias.md).
//
//   node scripts/generate-license-keypair.mjs
//
// Se ejecuta en local, una vez por cada par. El cliente pinea DOS públicas (RI-09):
//   · la EN USO: su privada es el secreto del worker (wrangler secret put LICENSE_SIGNING_PRIVATE_KEY)
//   · la DE RESERVA: su privada NO va a Cloudflare, sólo al gestor de contraseñas
// y las dos van en LICENSE_SIGNING_PUBLIC_KEYS_B64 (crates/tpv-infra-licensing/src/lib.rs).
//
// La pública no es secreta, pero es INTEGRIDAD CRÍTICA: el worker sólo puede firmar con una privada
// cuya pública esté en esa lista, o todos los TPVs instalados se bloquean. Cómo rotar:
// docs/arquitectura/licencias.md («Rotar la clave de firma»).
//
// La privada NO se guarda en el repo, ni en un fichero, ni en el historial del terminal:
// cópiala directamente al `wrangler secret put`, y guárdala también en el gestor de
// contraseñas (junto con el resto de secretos del worker): sin ella no se puede volver a
// pedir a Cloudflare, que sólo deja escribir secretos, no leerlos.

import { webcrypto } from "node:crypto";

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);

// pkcs8 lleva 16 bytes de cabecera ASN.1 antes de la semilla de 32 bytes. El worker
// (@noble/ed25519) espera la semilla cruda, así que se recorta.
const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", privateKey));
const seed = pkcs8.slice(pkcs8.length - 32);

const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", publicKey));

const b64 = (u8) => Buffer.from(u8).toString("base64");

console.log(`
  Par de firma de licencia (ed25519)
  ─────────────────────────────────────────────────────────────────────

  1) PRIVADA → al gestor de contraseñas. Si es la que va a estar EN USO, también al worker
     (pégala cuando te la pida el comando); si es la DE RESERVA, a Cloudflare no:

       cd apps/cloud-worker-licensing
       pnpm exec wrangler secret put LICENSE_SIGNING_PRIVATE_KEY

     ${b64(seed)}

  2) PÚBLICA → a la lista pineada del cliente Rust
     (LICENSE_SIGNING_PUBLIC_KEYS_B64 en crates/tpv-infra-licensing/src/lib.rs):

       "${b64(raw)}",

  ─────────────────────────────────────────────────────────────────────
`);
