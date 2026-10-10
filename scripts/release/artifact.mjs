// RI-25: el intercambio entre runners contiene datos, nunca programas que ejecute el firmante.
import { createHash, createPublicKey, verify } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

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

export function readArtifact(directory, version, publicKey) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      !/^[0-9A-Za-z._+-]+-setup\.exe$/.test(manifest.name) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Metadatos de release inválidos");
  const bytes = readFileSync(join(directory, "installer.exe"));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new Error("El instalador no coincide con el hash del build");
  }
  if (publicKey) verifySignature(bytes, readFileSync(join(directory, "installer.exe.sig"), "utf8"), publicKey);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, version, extra] = process.argv.slice(2);
  if (mode === "prepare") {
    const installers = readdirSync(directory).filter(name => name.endsWith("-setup.exe"));
    if (installers.length !== 1) throw new Error(`Se esperaba un instalador, encontrados ${installers.length}`);
    const file = join(directory, installers[0]);
    mkdirSync(extra, { recursive: true });
    copyFileSync(file, join(extra, "installer.exe"));
    writeFileSync(join(extra, "manifest.json"), JSON.stringify({ version, name: basename(file),
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }, null, 2));
    readArtifact(extra, version);
  } else if (mode === "verify") {
    const publicKey = extra ? JSON.parse(readFileSync(extra, "utf8")).plugins.updater.pubkey : undefined;
    console.log(JSON.stringify(readArtifact(directory, version, publicKey)));
  } else throw new Error("Uso: artifact.mjs prepare <nsis> <versión> <salida> | verify <artefacto> <versión> [tauri.conf.json]");
}
