import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { workerVersion, workerSentryConfig, readWorkerArtifact, validateCloudflare } from "./worker.mjs";

test("Windows 7 nunca despliega el backend; tags y releases deben corresponder al producto", () => {
  const identity = workerVersion(undefined, {});
  assert.equal(identity.release, `tpv-api@${identity.version}`);
  assert.throws(() => workerVersion(`win7-v${identity.version}`, {}), /nunca/);
  assert.throws(() => workerVersion("v99.99.99", {}));
  assert.throws(() => workerSentryConfig({}), /SENTRY_AUTH_TOKEN/);
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

test("un token inválido o la ausencia del DSN del worker bloquean el despliegue", async t => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "token-prueba" };
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 403 }));
  await assert.rejects(validateCloudflare(env), /403/);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, result: { bindings: [] } })));
  await assert.rejects(validateCloudflare(env), /SENTRY_DSN/);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ success: true, result: { bindings: [{ name: "SENTRY_DSN", type: "secret_text" }] } })));
  await validateCloudflare(env);
});
