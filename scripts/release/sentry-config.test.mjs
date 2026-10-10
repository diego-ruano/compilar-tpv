import { test } from "node:test";
import assert from "node:assert/strict";
import { applicationVersion, sentryBuildConfig, validateSentryTarget, verifyUploadedMaps } from "./sentry-config.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = applicationVersion({});
const env = { TPV_RELEASE_BUILD: "1", SENTRY_AUTH_TOKEN: "token-de-prueba", SENTRY_ORG: "altaria-lights",
  SENTRY_PROJECT: "tpv-desktop", TPV_SENTRY_DSN: "https://public@ingest.de.sentry.io/123", SENTRY_RELEASE: version };

test("un build local sin token funciona; una release sin cualquier dato requerido se bloquea", () => {
  assert.equal(sentryBuildConfig({}).enabled, false);
  for (const name of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "TPV_SENTRY_DSN"]) {
    assert.throws(() => sentryBuildConfig({ ...env, [name]: "" }), new RegExp(name));
  }
  assert.equal(sentryBuildConfig(env, `v${version}`).release, version);
});

test("la verificación lee artifact bundles paginados y rechaza mapas ausentes o Debug IDs", async t => {
  const directory = mkdtempSync(join(tmpdir(), "tpv-sentry-maps-"));
  try {
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "assets/app.js"), "const ids = window._sentryDebugIds;");
    t.mock.method(globalThis, "fetch", async url => {
      if (url.includes("artifact-bundles/?")) return new Response(JSON.stringify([
        { bundleId: "bundle", associations: [{ release: version }] },
      ]));
      if (url.includes("/bundle/files/")) {
        return new Response(JSON.stringify({ files: [{ filePath: url.includes("cursor") ? "~/assets/app.js.map" : "~/assets/app.js" }] }), {
          headers: url.includes("cursor") ? {} : { link: `<${url}&cursor=next>; rel="next"; results="true"` },
        });
      }
      return new Response("[]");
    });
    assert.equal(await verifyUploadedMaps(sentryBuildConfig(env), directory), 1);
    writeFileSync(join(directory, "assets/app.js"), "window._sentryDebugIds = {};");
    await assert.rejects(verifyUploadedMaps(sentryBuildConfig(env), directory), /Debug IDs/);
    writeFileSync(join(directory, "assets/app.js"), "console.log('prueba');");
    t.mock.method(globalThis, "fetch", async () => new Response("[]"));
    await assert.rejects(verifyUploadedMaps(sentryBuildConfig(env), directory, { attempts: 2, delayMs: 1 }), /Falta en Sentry/);
    let checks = 0;
    t.mock.method(globalThis, "fetch", async url => {
      if (url.includes("/releases/")) {
        checks++;
        return new Response(JSON.stringify(checks === 1 ? [] : [{ name: "~/assets/app.js" }, { name: "~/assets/app.js.map" }]));
      }
      return new Response("[]");
    });
    assert.equal(await verifyUploadedMaps(sentryBuildConfig(env), directory, { attempts: 2, delayMs: 1 }), 1);
    assert.equal(checks, 2, "se espera al procesamiento del bundle antes de bloquear la release");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("se rechazan una release o tag de otra versión y DSN/slugs inválidos", () => {
  assert.throws(() => sentryBuildConfig({ ...env, SENTRY_RELEASE: "99.99.99" }));
  assert.throws(() => sentryBuildConfig(env, "v99.99.99"));
  for (const dsn of ["http://public@ingest.de.sentry.io/123", "https://ingest.de.sentry.io/123", "https://public@ingest.de.sentry.io/worker"]) {
    assert.throws(() => sentryBuildConfig({ ...env, TPV_SENTRY_DSN: dsn }));
  }
  assert.throws(() => sentryBuildConfig({ ...env, SENTRY_ORG: "Altaria Lights" }));
});

test("el DSN debe pertenecer al proyecto y a una Client Key activa", async t => {
  const config = sentryBuildConfig(env);
  t.mock.method(globalThis, "fetch", async url => new Response(JSON.stringify(
    url.endsWith("/keys/") ? [{ isActive: true, dsn: { public: env.TPV_SENTRY_DSN } }] : { id: "123" },
  )));
  await validateSentryTarget(config);
  await assert.rejects(validateSentryTarget({ ...config, dsn: new URL("https://public@ingest.de.sentry.io/456") }));
  t.mock.method(globalThis, "fetch", async url => new Response(JSON.stringify(
    url.endsWith("/keys/") ? [{ isActive: false, dsn: { public: env.TPV_SENTRY_DSN } }] : { id: "123" },
  )));
  await assert.rejects(validateSentryTarget(config), /activa/);
});
