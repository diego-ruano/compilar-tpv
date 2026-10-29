// Comprueba interoperabilidad con el firmante REAL de Tauri, no con un generador que replique
// nuestro verificador. La clave temporal nunca se utiliza para publicar una actualización.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { publishedName, readArtifact, verifySignature } from "./artifact.mjs";
import { createHash } from "node:crypto";

test("el instalador se publica sin espacios en el nombre", () => {
  assert.equal(publishedName("TPV - Altaria Lights_1.2.3_x64-setup.exe"), "TPV-Altaria-Lights_1.2.3_x64-setup.exe");
  assert.equal(publishedName("tpv_1.2.3_x64-setup.exe"), "tpv_1.2.3_x64-setup.exe");
});

test("Tauri firma; el verificador rechaza bytes, comentario, clave y manifiesto alterados", () => {
  const directory = mkdtempSync(join(tmpdir(), "tpv-updater-test-"));
  try {
    const cli = resolve(".github/tools/updater-signer/node_modules/@tauri-apps/cli/tauri.js");
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, "signer", ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    };
    const key = join(directory, "test.key");
    run("generate", "--ci", "--password", "", "--write-keys", key);
    const bytes = Buffer.from("Instalador de prueba RI-25\n");
    const exe = join(directory, "installer.exe");
    writeFileSync(exe, bytes);
    run("sign", "--private-key-path", key, "--password", "", exe);
    const publicKey = readFileSync(`${key}.pub`, "utf8");
    const signature = readFileSync(`${exe}.sig`, "utf8");
    verifySignature(bytes, signature, publicKey);
    assert.throws(() => verifySignature(Buffer.from("alterado"), signature, publicKey));
    const altered = Buffer.from(signature.trim(), "base64").toString().replace(/^trusted comment: /m, "trusted comment: alterado ");
    assert.throws(() => verifySignature(bytes, Buffer.from(altered).toString("base64"), publicKey));
    run("generate", "--ci", "--password", "", "--write-keys", join(directory, "other.key"));
    assert.throws(() => verifySignature(bytes, signature, readFileSync(join(directory, "other.key.pub"), "utf8")));
    const manifest = { version: "1.2.3", name: "tpv_1.2.3_x64-setup.exe",
      sha256: createHash("sha256").update(bytes).digest("hex") };
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    assert.equal(readArtifact(directory, "1.2.3", publicKey).name, manifest.name);
    assert.throws(() => readArtifact(directory, "1.2.4", publicKey));
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...manifest, name: "../malicioso-setup.exe" }));
    assert.throws(() => readArtifact(directory, "1.2.3", publicKey));
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(exe, "alterado");
    assert.throws(() => readArtifact(directory, "1.2.3", publicKey));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
