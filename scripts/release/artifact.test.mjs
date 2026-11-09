// Comprueba interoperabilidad con el firmante REAL de Tauri, no con un generador que replique
// nuestro verificador. La clave temporal nunca se utiliza para publicar una actualización.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// ── AUD-43 ───────────────────────────────────────────────────────────────────────────────────
// El instalador sin firmar viaja de build a sign, y el firmado de sign a publish. build ejecuta
// código de terceros, y otro job de la ejecución podía sustituir el artefacto por uno coherente
// consigo mismo: un installer.exe propio con su manifiesto recalculado (misma versión y nombre).
// sign lo habría firmado y el updater lo habría llevado a todas las Main. Sólo lo distingue el
// sha256 del manifiesto, que el job que produce el artefacto publica como salida.
const sha256 = datos => createHash("sha256").update(datos).digest("hex");

/** Escribe un artefacto del instalador como `artifact.mjs prepare`; devuelve el sha256 del manifiesto. */
function montarInstalador(dir, bytes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "installer.exe"), bytes);
  const manifiesto = JSON.stringify({ version: "1.2.3", name: "tpv_1.2.3_x64-setup.exe", sha256: sha256(bytes) }, null, 2);
  writeFileSync(join(dir, "manifest.json"), manifiesto);
  return sha256(manifiesto);
}

test("AUD-43 · un instalador sustituido no se firma ni se publica: su manifiesto no es el que publicó build", () => {
  const raiz = mkdtempSync(join(tmpdir(), "tpv-instalador-aud43-"));
  try {
    const bueno = join(raiz, "legitimo");
    const malo = join(raiz, "sustituido");
    const publicado = montarInstalador(bueno, Buffer.from("instalador legítimo"));
    montarInstalador(malo, Buffer.from("instalador ajeno"));
    // Coherente consigo mismo, el sustituido pasa la comprobación de siempre: por eso no bastaba.
    readArtifact(malo, "1.2.3");
    readArtifact(bueno, "1.2.3", undefined, publicado);
    assert.throws(() => readArtifact(malo, "1.2.3", undefined, publicado), /no es el que subió/);
    // Antes de leer nada más: ni se mira el instalador, aunque falte.
    rmSync(join(malo, "installer.exe"));
    assert.throws(() => readArtifact(malo, "1.2.3", undefined, publicado), /no es el que subió/);
    // Sin la salida del job, o mal formada, tampoco: falla cerrado.
    for (const sha of ["", "0".repeat(63), publicado.toUpperCase(), ` ${publicado}`]) {
      assert.throws(() => readArtifact(bueno, "1.2.3", undefined, sha), /Falta el sha256/);
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test("AUD-43 · artifact.mjs: prepare publica el sha256 del manifiesto; verify lo exige y lo vuelve a publicar", () => {
  const raiz = mkdtempSync(join(tmpdir(), "tpv-instalador-aud43-"));
  try {
    const nsis = join(raiz, "nsis");
    mkdirSync(nsis);
    writeFileSync(join(nsis, "TPV - Altaria Lights_1.2.3_x64-setup.exe"), "instalador de prueba");
    const artefacto = join(raiz, "artefacto");
    const salidasDelJob = join(raiz, "github-output");
    // Como en el workflow: las salidas van al fichero de GITHUB_OUTPUT.
    const ejecutar = (args, sha) => {
      writeFileSync(salidasDelJob, "");
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_OUTPUT: salidasDelJob, INSTALLER_MANIFEST_SHA256: sha };
      for (const [clave, valor] of Object.entries(env)) if (valor === undefined) delete env[clave];
      const r = spawnSync(process.execPath, [fileURLToPath(new URL("./artifact.mjs", import.meta.url)), ...args], { env, encoding: "utf8" });
      return { status: r.status, salida: `${r.stdout}${r.stderr}`, salidas: readFileSync(salidasDelJob, "utf8") };
    };
    const preparado = ejecutar(["prepare", nsis, "1.2.3", artefacto]);
    assert.equal(preparado.status, 0, preparado.salida);
    const publicado = sha256(readFileSync(join(artefacto, "manifest.json")));
    assert.equal(preparado.salidas, `manifest_sha256=${publicado}\n`);
    // verify: sin el sha256, vacío o con otro, falla y no publica nada.
    for (const sha of [undefined, "", "0".repeat(64)]) {
      const r = ejecutar(["verify", artefacto, "1.2.3"], sha);
      assert.notEqual(r.status, 0, `verify aceptó el artefacto con ${sha}`);
      assert.match(r.salida, /sha256/);
      assert.equal(r.salidas, "");
    }
    const verificado = ejecutar(["verify", artefacto, "1.2.3"], publicado);
    assert.equal(verificado.status, 0, verificado.salida);
    assert.equal(verificado.salidas, `manifest_sha256=${publicado}\n`);
    // El sustituido, coherente consigo mismo, no pasa con el sha256 que publicó build.
    montarInstalador(artefacto, Buffer.from("instalador ajeno"));
    const sustituido = ejecutar(["verify", artefacto, "1.2.3"], publicado);
    assert.notEqual(sustituido.status, 0);
    assert.match(sustituido.salida, /no es el que subió/);
    assert.equal(sustituido.salidas, "");
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});
