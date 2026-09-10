#!/usr/bin/env node
//
// Genera el par ed25519 con el que el worker FIRMA el estado de licencia (§5.1 del plan).
//
//   node scripts/generate-license-keypair.mjs
//
// Se ejecuta UNA vez, en local, y se reparte así:
//   · la PRIVADA → secreto del worker:  wrangler secret put LICENSE_SIGNING_PRIVATE_KEY
//   · la PÚBLICA → constante PINEADA en el binario Rust (crates/tpv-infra-licensing/src/lib.rs)
//
// La pública no es secreta, pero es INTEGRIDAD CRÍTICA: si se cambia, todos los TPVs ya
// instalados dejan de validar la firma y se bloquean. Rotarla exige pinear dos claves a la vez
// durante una ventana (ver §5.7 del plan).
//
// La privada NO se guarda en el repo, ni en un fichero, ni en el historial del terminal:
// cópiala directamente al `wrangler secret put` y olvídala.

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

  1) PRIVADA → secreto del worker. Pégala cuando te la pida el comando:

       cd apps/cloud-worker-licensing
       pnpm exec wrangler secret put LICENSE_SIGNING_PRIVATE_KEY

     ${b64(seed)}

  2) PÚBLICA → constante pineada en el cliente Rust
     (crates/tpv-infra-licensing/src/lib.rs):

       pub const LICENSE_SIGNING_PUBLIC_KEY_B64: &str =
           "${b64(raw)}";

  ─────────────────────────────────────────────────────────────────────
  No guardes la privada en ningún fichero. Si la pierdes, genera otro par
  y despliega a la vez worker y app (los TPV viejos dejarían de validar).
`);
