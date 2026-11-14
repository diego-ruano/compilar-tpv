// Lo que necesita el generador de carga para hablar con el worker como un equipo de verdad: la
// identidad Ed25519, los tres mensajes que se firman, los UUIDv7, la hora local y el hash del PIN.
// Sólo `node:crypto`: el generador no añade dependencias.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  getRandomValues,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";

/** sha256 en hex minúsculas: lo mismo que `sha256HexStr`/`sha256HexBytes` del worker. */
export const sha256Hex = datos => createHash("sha256").update(datos).digest("hex");

// Cabecera DER PKCS#8 de una clave privada Ed25519; la semilla de 32 bytes va detrás.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Un equipo sintético nuevo: `deviceId` UUIDv4 en minúsculas, como `device.rs`, y su par Ed25519.
 * La clave pública va cruda (32 bytes) en base64 estándar con relleno, que es lo que exige
 * `/v1/license/activate` y `/v1/pair/claim`. Con `semilla` la clave es fija: sólo la usan los tests.
 */
export function nuevaIdentidad(semilla) {
  const privada = semilla
    ? createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, semilla]), format: "der", type: "pkcs8" })
    : generateKeyPairSync("ed25519").privateKey;
  const x = createPublicKey(privada).export({ format: "jwk" }).x;
  return {
    deviceId: randomUUID(),
    clavePublica: Buffer.from(x, "base64url").toString("base64"),
    firmar: texto => sign(null, Buffer.from(texto, "utf8"), privada).toString("base64"),
  };
}

/**
 * El device-proof de toda ruta con `tenantAuth` (`server/middleware/auth.ts` ≡ `device.rs`). La ruta
 * es `pathname + search` tal como llega al worker, y el cuerpo, los bytes exactos que se envían.
 */
export function mensajeDeviceProof(ts, metodo, ruta, token, cuerpo) {
  return `DEVICE_PROOF\n${ts}\n${metodo.toUpperCase()}\n${ruta}\n${sha256Hex(token)}\n${sha256Hex(cuerpo)}`;
}

/** El saludo del WebSocket (`tenantHub.identidad.ts`): la Main firma `WS_HELLO` y la Handy `WS_HANDY_HELLO`. */
export function mensajeSaludo(rol, ts, tenantId, deviceId, nonce) {
  return `${rol === "handy" ? "WS_HANDY_HELLO" : "WS_HELLO"}\n${ts}\n${tenantId}\n${deviceId}\n${nonce}`;
}

/** Lo que firma la Handy al recoger su token de emparejamiento (`pairing.firma.ts`). */
export const mensajeRecogida = (ts, codigo, nonce, deviceId) => `PAIR_FETCH\n${ts}\n${codigo}\n${nonce}\n${deviceId}`;

// UUIDv7 con contador, copiado de `apps/cloud-worker-licensing/src/lib/ids.ts` (RI-59): las
// consultas que ordenan por la clave, como «quitar una unidad», necesitan ids crecientes.
let ultimoMs = 0;
let contador = 0;
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function nuevoId() {
  const ahora = Date.now();
  if (ahora > ultimoMs) {
    ultimoMs = ahora;
    contador = Math.floor(Math.random() * 0x800);
  } else if (contador < 0xfff) {
    contador += 1;
  } else {
    ultimoMs += 1;
    contador = 0;
  }
  const b = new Uint8Array(16);
  getRandomValues(b.subarray(8));
  const alto = Math.floor(ultimoMs / 0x1_0000_0000);
  const bajo = ultimoMs >>> 0;
  b[0] = (alto >>> 8) & 0xff;
  b[1] = alto & 0xff;
  b[2] = (bajo >>> 24) & 0xff;
  b[3] = (bajo >>> 16) & 0xff;
  b[4] = (bajo >>> 8) & 0xff;
  b[5] = bajo & 0xff;
  b[6] = 0x70 | (contador >>> 8);
  b[7] = contador & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[b[i]];
  }
  return s;
}

const dos = n => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM:SS` en hora del equipo: la `x-client-now` y las horas literales de la Main. */
export function horaLocal(d = new Date()) {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

/** `YYYY-MM-DD` en hora del equipo. */
export const fechaLocal = (d = new Date()) => horaLocal(d).slice(0, 10);

/** `YYYY-MM-DDTHH:MM:SS+01:00`: la hora con su huso, como el registro de facturación. */
export function horaConHuso(d = new Date()) {
  const minutos = -d.getTimezoneOffset();
  const signo = minutos >= 0 ? "+" : "-";
  const abs = Math.abs(minutos);
  return `${horaLocal(d).replace(" ", "T")}${signo}${dos(Math.floor(abs / 60))}:${dos(abs % 60)}`;
}

/** El hash de un PIN tal como lo guarda la Main (`tpv-domain/src/login.rs`) y lo verifica el worker. */
export function hashPin(pin) {
  const sal = randomBytes(16);
  const dk = pbkdf2Sync(pin.trim(), sal, 100_000, 32, "sha256");
  return `$pbkdf2-sha256$i=100000$${sal.toString("base64")}$${dk.toString("base64")}`;
}
