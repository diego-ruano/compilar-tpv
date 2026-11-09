// RI-25: el intercambio entre runners contiene datos, nunca programas que ejecute el firmante.
import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = datos => createHash("sha256").update(datos).digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;

export function verifySignature(bytes, signature, publicKey) {
  const keyLines = Buffer.from(publicKey.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const signatureLines = Buffer.from(signature.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? "", "base64");
  const signed = Buffer.from(signatureLines[1] ?? "", "base64");
  const global = Buffer.from(signatureLines[3] ?? "", "base64");
  if (key.length !== 42 || signed.length !== 74 || global.length !== 64 ||
      !key.subarray(2, 10).equals(signed.subarray(2, 10)) ||
      !signatureLines[2]?.startsWith("trusted comment: ")) {
    throw new Error("Firma del updater mal formada o de otra clave");
  }
  const algorithm = signed.subarray(0, 2).toString();
  if (!['Ed', 'ED'].includes(algorithm)) throw new Error("Algoritmo de firma desconocido");
  const ed25519 = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der", type: "spki",
  });
  const payload = algorithm === 'ED' ? createHash("blake2b512").update(bytes).digest() : bytes;
  const comment = Buffer.from(signatureLines[2].slice("trusted comment: ".length));
  if (!verify(null, payload, ed25519, signed.subarray(10)) ||
      !verify(null, Buffer.concat([signed.subarray(10), comment]), ed25519, global)) {
    throw new Error("La firma no corresponde al instalador y a la clave pública de Tauri");
  }
}

// El instalador se llama como el `productName` («TPV - Altaria Lights_1.2.0_x64-setup.exe»). Se
// publica sin espacios: el nombre acaba en la clave de R2 y en la URL del feed tal cual.
export function publishedName(name) {
  return name.replace(/\s*-\s*/g, "-").replace(/\s+/g, "-");
}

export function readArtifact(directory, version, publicKey, manifestSha256) {
  const crudo = readFileSync(join(directory, "manifest.json"));
  // AUD-43: un artefacto coherente consigo mismo no prueba quién lo subió: otro job de la ejecución
  // podría sustituirlo por un instalador propio con su manifiesto recalculado, y se firmaría. Quien
  // lo consume exige, antes de leer nada más, el sha256 que publicó como salida el job que lo produjo.
  if (manifestSha256 !== undefined) {
    if (!SHA256.test(manifestSha256)) throw new Error("Falta el sha256 del manifiesto que publicó el job que produjo el instalador: sin él no se firma ni se publica");
    if (sha256(crudo) !== manifestSha256) throw new Error("El instalador no es el que subió el job que lo produjo: su manifiesto tiene otro sha256");
  }
  const manifest = JSON.parse(crudo.toString("utf8"));
  if (manifest.version !== version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      !/^[0-9A-Za-z._+-]+-setup\.exe$/.test(manifest.name) ||
      !SHA256.test(manifest.sha256)) throw new Error("Metadatos de release inválidos");
  const bytes = readFileSync(join(directory, "installer.exe"));
  if (sha256(bytes) !== manifest.sha256) {
    throw new Error("El instalador no coincide con el hash del build");
  }
  if (publicKey) verifySignature(bytes, readFileSync(join(directory, "installer.exe.sig"), "utf8"), publicKey);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, version, extra] = process.argv.slice(2);
  // AUD-43: `prepare` publica el sha256 del manifiesto que escribe; `verify` exige el que publicó el
  // job que produjo el artefacto (INSTALLER_MANIFEST_SHA256, vacío si falta) y lo vuelve a publicar,
  // para que quien firma se lo pase a quien publica.
  let manifestSha256;
  if (mode === "prepare") {
    const installers = readdirSync(directory).filter(name => name.endsWith("-setup.exe"));
    if (installers.length !== 1) throw new Error(`Se esperaba un instalador, encontrados ${installers.length}`);
    const file = join(directory, installers[0]);
    mkdirSync(extra, { recursive: true });
    copyFileSync(file, join(extra, "installer.exe"));
    const texto = JSON.stringify({ version, name: publishedName(basename(file)), sha256: sha256(readFileSync(file)) }, null, 2);
    writeFileSync(join(extra, "manifest.json"), texto);
    manifestSha256 = sha256(texto);
    readArtifact(extra, version, undefined, manifestSha256);
  } else if (mode === "verify") {
    const publicKey = extra ? JSON.parse(readFileSync(extra, "utf8")).plugins.updater.pubkey : undefined;
    manifestSha256 = process.env.INSTALLER_MANIFEST_SHA256 ?? "";
    console.log(JSON.stringify(readArtifact(directory, version, publicKey, manifestSha256)));
  } else throw new Error("Uso: artifact.mjs prepare <nsis> <versión> <salida> | verify <artefacto> <versión> [tauri.conf.json]");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `manifest_sha256=${manifestSha256}\n`);
}
