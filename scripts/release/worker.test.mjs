import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workerVersion, workerSentryConfig, readWorkerArtifact, validateCloudflare, configuracionLocal, configuracionDelModo } from "./worker.mjs";

test("Windows 7 nunca despliega el backend; tags y releases deben corresponder al producto", () => {
  const identity = workerVersion(undefined, {});
  assert.equal(identity.release, `tpv-api@${identity.version}`);
  assert.throws(() => workerVersion(`win7-v${identity.version}`, {}), /nunca/);
  assert.throws(() => workerVersion("v99.99.99", {}));
  assert.throws(() => workerSentryConfig({}), /SENTRY_AUTH_TOKEN/);
});

// AUD-44: el paso que ejecuta Wrangler con el token de Cloudflare no necesita el de Sentry.
test("desplegar sólo pide la identidad del artefacto; compilar y comprobar mapas, Sentry", () => {
  const identity = workerVersion(undefined, {});
  const commit = "c".repeat(40);
  assert.deepEqual(configuracionDelModo("cloudflare", { GITHUB_SHA: commit }), { ...identity, commit, manifestSha256: "" });
  assert.deepEqual(configuracionDelModo("cloudflare", { GITHUB_SHA: commit }, `v${identity.version}`), { ...identity, commit, manifestSha256: "" });
  assert.throws(() => configuracionDelModo("cloudflare", {}, "v99.99.99"));
  assert.throws(() => configuracionDelModo("cloudflare", {}, `win7-v${identity.version}`), /nunca/);
  for (const mode of ["prepare", "verify"]) assert.throws(() => configuracionDelModo(mode, { GITHUB_SHA: commit }), /SENTRY_AUTH_TOKEN/);
  assert.throws(() => configuracionDelModo("desplegar", {}), /Uso/);
});

test("se rechaza cualquier cambio o archivo añadido después de subir los mapas", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpv-worker-"));
  const identity = workerVersion(undefined, {});
  const id = "aabbccdd-1234-1234-1234-aabbccddeeff";
  try {
    const contents = {
      "index.js": `// debugId=${id}`,
      "index.js.map": JSON.stringify({ debug_id: id }),
      "wrangler.json": JSON.stringify({ name: "tpv-api", main: "index.js", no_bundle: true, assets: { directory: "assets" }, vars: { SENTRY_RELEASE: identity.release, BUILD_COMMIT: "commit" } }),
      // El widget de reservas web viaja dentro, en `assets/`.
      "assets/reservas-web/index.html": "<!doctype html>",
      "assets/reservas-web/v1/embed.js": "(function(){})();",
    };
    const files = {};
    for (const [name, data] of Object.entries(contents)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), data);
      files[name] = createHash("sha256").update(data).digest("hex");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ worker: "tpv-api", ...identity, commit: "commit", files }));
    readWorkerArtifact(dir, identity);
    assert.throws(() => readWorkerArtifact(dir, { ...identity, commit: "otro-commit" }), /commit/);
    writeFileSync(join(dir, "index.js"), "cambio");
    assert.throws(() => readWorkerArtifact(dir, identity), /Hash/);
    writeFileSync(join(dir, "index.js"), contents["index.js"]);
    writeFileSync(join(dir, "extra.sql"), "SELECT 1");
    assert.throws(() => readWorkerArtifact(dir, identity), /archivos/);
    rmSync(join(dir, "extra.sql"));
    // También dentro del widget: lo que no está en el manifiesto no se despliega.
    writeFileSync(join(dir, "assets/reservas-web/otro.js"), "x");
    assert.throws(() => readWorkerArtifact(dir, identity), /archivos/);
    rmSync(join(dir, "assets/reservas-web/otro.js"));
    readWorkerArtifact(dir, identity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sin el widget de reservas web dentro, el artefacto no vale; y nada sale de `assets/`", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpv-worker-"));
  const identity = workerVersion(undefined, {});
  const id = "aabbccdd-1234-1234-1234-aabbccddeeff";
  const montar = (extra, assets = { directory: "assets" }) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const contents = {
      "index.js": `// debugId=${id}`,
      "index.js.map": JSON.stringify({ debug_id: id }),
      "wrangler.json": JSON.stringify({ name: "tpv-api", main: "index.js", no_bundle: true, assets, vars: { SENTRY_RELEASE: identity.release, BUILD_COMMIT: "commit" } }),
      ...extra,
    };
    const files = {};
    for (const [name, data] of Object.entries(contents)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), data);
      files[name] = createHash("sha256").update(data).digest("hex");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ worker: "tpv-api", ...identity, commit: "commit", files }));
  };
  const widget = { "assets/reservas-web/index.html": "<!doctype html>", "assets/reservas-web/v1/embed.js": "x" };
  try {
    montar({});
    assert.throws(() => readWorkerArtifact(dir, identity), /widget/);
    montar(widget, { directory: "../reservas-web/dist" });
    assert.throws(() => readWorkerArtifact(dir, identity), /widget/);
    montar({ ...widget, "otra/carpeta.js": "x" });
    assert.throws(() => readWorkerArtifact(dir, identity), /Hash/);
    montar(widget);
    readWorkerArtifact(dir, identity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("arrancado desde otra carpeta, el artefacto sigue encontrando su JavaScript y el widget", () => {
  const artefacto = resolve("target/worker-release");
  const local = configuracionLocal({ main: "index.js", base_dir: ".", assets: { directory: "assets", binding: "ASSETS" }, triggers: { crons: ["0 7 * * *"] }, vars: { A: "1" } }, artefacto);
  assert.equal(local.main, join(artefacto, "index.js"));
  assert.equal(local.base_dir, artefacto);
  assert.equal(local.assets.directory, join(artefacto, "assets"));
  assert.equal(local.assets.binding, "ASSETS");
  assert.equal(local.triggers, undefined);
  assert.equal(local.vars.ENVIRONMENT, "sentry-verification");
});

test("un token inválido o la ausencia del DSN del worker bloquean el despliegue", async t => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "token-prueba" };
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 403 }));
  await assert.rejects(validateCloudflare(env), /403/);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, result: { bindings: [] } })));
  await assert.rejects(validateCloudflare(env), /SENTRY_DSN/);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, result: { bindings: [{ name: "SENTRY_DSN", type: "secret_text" }] } })));
  await validateCloudflare(env);
});

// ── AUD-43 ───────────────────────────────────────────────────────────────────────────────────
// El artefacto recompuesto de la investigación. `build` corre a la vez que build-worker, ejecuta
// código de terceros y podía sustituir `worker-<intento>` por otro coherente consigo mismo: su
// index.js con el Debug ID legítimo dentro, el mapa y el widget legítimos, un `build.command` en
// wrangler.json y el manifiesto recalculado. Pasaba todas las comprobaciones de deploy-worker; lo
// único que lo distingue es el sha256 del manifiesto, que build-worker publica como salida del job.
const COMMIT = "c".repeat(40);
const DEBUG_ID = "aabbccdd-1234-1234-1234-aabbccddeeff";
const sha256 = datos => createHash("sha256").update(datos).digest("hex");

/** Escribe los ficheros y su manifiesto como prepareWorker; devuelve el sha256 del manifiesto. */
function montarArtefacto(dir, contenidos, identity) {
  const files = {};
  for (const [nombre, datos] of Object.entries(contenidos)) {
    mkdirSync(join(dir, nombre, ".."), { recursive: true });
    writeFileSync(join(dir, nombre), datos);
    files[nombre] = sha256(datos);
  }
  const manifiesto = JSON.stringify({ worker: "tpv-api", ...identity, commit: COMMIT, files }, null, 2);
  writeFileSync(join(dir, "manifest.json"), manifiesto);
  return sha256(manifiesto);
}

/** La forma de lo que deja prepareWorker, con datos ficticios. */
function legitimo(identity) {
  const wrangler = {
    name: "tpv-api", main: "index.js", compatibility_date: "2026-05-29", no_bundle: true, find_additional_modules: true,
    base_dir: ".", assets: { directory: "assets", binding: "ASSETS" },
    vars: { ENVIRONMENT: "prod", SENTRY_RELEASE: identity.release, BUILD_COMMIT: COMMIT },
  };
  return {
    "index.js": `export default { fetch: () => new Response("LEGITIMO") };\n//# debugId=${DEBUG_ID}\n//# sourceMappingURL=index.js.map\n`,
    "index.js.map": JSON.stringify({ version: 3, sources: ["src/index.ts"], mappings: "", debug_id: DEBUG_ID }),
    "wrangler.json": JSON.stringify(wrangler, null, 2),
    "assets/reservas-web/index.html": "<!doctype html><title>Reservas</title>",
    "assets/reservas-web/v1/embed.js": "(function(){})();",
  };
}

/** El recompuesto: mapa y widget del legítimo; index.js y, si se pide, `build.command` propios. */
function recompuesto(original, dir, { conBuild = true } = {}) {
  const wrangler = JSON.parse(original["wrangler.json"]);
  const propio = { "index.js": `export default { fetch: () => new Response("AJENO") };\n//# debugId=${DEBUG_ID}\n` };
  if (conBuild) {
    propio["marcador.cjs"] = "require('fs').writeFileSync('marcador', String(Boolean(process.env.CLOUDFLARE_API_TOKEN)))";
    propio["wrangler.json"] = JSON.stringify({ ...wrangler, build: { command: "node marcador.cjs", cwd: dir } }, null, 2);
  }
  return { ...original, ...propio };
}

test("AUD-43 · el artefacto recompuesto no se despliega: su manifiesto no es el que publicó build-worker", () => {
  const identity = workerVersion(undefined, {});
  const esperado = { ...identity, commit: COMMIT };
  const raiz = mkdtempSync(join(tmpdir(), "tpv-worker-aud43-"));
  try {
    const bueno = join(raiz, "legitimo");
    const malo = join(raiz, "recompuesto");
    const original = legitimo(identity);
    const publicado = montarArtefacto(bueno, original, identity);
    montarArtefacto(malo, recompuesto(original, malo), identity);
    // Con el sha256 que publica build-worker, el legítimo pasa y el recompuesto no.
    readWorkerArtifact(bueno, { ...esperado, manifestSha256: publicado });
    assert.throws(() => readWorkerArtifact(malo, { ...esperado, manifestSha256: publicado }), /no es el que subió build-worker/);
    // Antes de leer nada más: con otro sha256 ni se mira el resto, aunque falte.
    rmSync(join(malo, "wrangler.json"));
    assert.throws(() => readWorkerArtifact(malo, { ...esperado, manifestSha256: publicado }), /no es el que subió build-worker/);
    // Sin la salida de build-worker, o mal formada, tampoco se despliega el legítimo: falla cerrado.
    for (const manifestSha256 of ["", "0".repeat(63), publicado.toUpperCase(), ` ${publicado}`]) {
      assert.throws(() => readWorkerArtifact(bueno, { ...esperado, manifestSha256 }), /Falta el sha256/);
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test("AUD-43 · coherente consigo mismo no basta; y un `build` en wrangler.json no se despliega nunca", () => {
  const identity = workerVersion(undefined, {});
  const esperado = { ...identity, commit: COMMIT };
  const raiz = mkdtempSync(join(tmpdir(), "tpv-worker-aud43-"));
  try {
    const original = legitimo(identity);
    const publicado = montarArtefacto(join(raiz, "legitimo"), original, identity);
    // Sólo con su index.js, el recompuesto supera todas las comprobaciones de coherencia: lo para
    // el sha256 del manifiesto.
    const soloIndex = join(raiz, "solo-index");
    montarArtefacto(soloIndex, recompuesto(original, soloIndex, { conBuild: false }), identity);
    readWorkerArtifact(soloIndex, esperado);
    assert.throws(() => readWorkerArtifact(soloIndex, { ...esperado, manifestSha256: publicado }), /build-worker/);
    // Con `build.command`, Wrangler lo ejecutaría con las credenciales al desplegar: se rechaza
    // aunque el manifiesto sea coherente, y prepareWorker no lo deja pasar al artefacto.
    const conBuild = join(raiz, "con-build");
    montarArtefacto(conBuild, recompuesto(original, conBuild), identity);
    assert.throws(() => readWorkerArtifact(conBuild, esperado), /`build`/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test("AUD-43 · worker.mjs verify y cloudflare rechazan el recompuesto antes de hablar con Sentry o Cloudflare", () => {
  const identity = workerVersion(undefined, {});
  const raiz = mkdtempSync(join(tmpdir(), "tpv-worker-aud43-"));
  try {
    const bueno = join(raiz, "legitimo");
    const malo = join(raiz, "recompuesto");
    const original = legitimo(identity);
    const publicado = montarArtefacto(bueno, original, identity);
    montarArtefacto(malo, recompuesto(original, malo), identity);
    // Como en el workflow, pero sin red: cualquier `fetch` lanza «SIN RED» con su URL.
    const sinRed = join(raiz, "sin-red.mjs");
    writeFileSync(sinRed, "globalThis.fetch = async url => { throw new Error(`SIN RED: ${url}`); };\n");
    const ejecutar = (modo, dir, sha) => {
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_SHA: COMMIT, WORKER_MANIFEST_SHA256: sha };
      // El paso que despliega no recibe el token de Sentry (AUD-44); el que comprueba los mapas, sí.
      if (modo === "verify") Object.assign(env, { SENTRY_AUTH_TOKEN: "token-ficticio", SENTRY_ORG: "org", SENTRY_WORKER_PROJECT: "proyecto" });
      else Object.assign(env, { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "token-ficticio" });
      for (const [clave, valor] of Object.entries(env)) if (valor === undefined) delete env[clave];
      const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(sinRed).href, worker, modo, dir], { env, encoding: "utf8" });
      return { status: r.status, salida: `${r.stdout}${r.stderr}` };
    };
    for (const modo of ["verify", "cloudflare"]) {
      for (const [dir, sha] of [[malo, publicado], [malo, undefined], [bueno, undefined], [bueno, ""]]) {
        const { status, salida } = ejecutar(modo, dir, sha);
        assert.notEqual(status, 0, `${modo} aceptó ${dir} con ${sha}`);
        assert.match(salida, /build-worker/);
        assert.doesNotMatch(salida, /SIN RED/, `${modo} habló con la red antes de comprobar el manifiesto`);
      }
    }
    // Con el legítimo y su sha256, pasa la comprobación y llega a la red (aquí cortada).
    assert.match(ejecutar("verify", bueno, publicado).salida, /SIN RED: https:\/\/sentry\.io\//);
    assert.match(ejecutar("cloudflare", bueno, publicado).salida, /SIN RED: https:\/\/api\.cloudflare\.com\//);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});
