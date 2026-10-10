import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = new URL("../../", import.meta.url);

export function applicationVersion(env = process.env, tag) {
  const conf = JSON.parse(readFileSync(new URL("apps/tpv-main/src-tauri/tauri.conf.json", root), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("apps/tpv-main/package.json", root), "utf8"));
  const cargo = readFileSync(new URL("apps/tpv-main/src-tauri/Cargo.toml", root), "utf8")
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (conf.version !== cargo || conf.version !== pkg.version ||
      (tag && tag.replace(/^(?:win7-)?v/, "") !== conf.version)) {
    throw new Error("La versión de Tauri, Cargo, package.json y el tag deben coincidir");
  }
  return conf.version;
}

export function sentryBuildConfig(env = process.env, tag) {
  const version = applicationVersion(env, tag);
  const variant = env.TPV_BUILD_VARIANT ?? (tag?.startsWith("win7-") ? "win7" : "windows-modern");
  if (!["windows-modern", "win7"].includes(variant)) throw new Error("Variante de escritorio inválida");
  const release = `${variant === "win7" ? "tpv-desktop-win7" : "tpv-desktop"}@${version}`;
  if (env.SENTRY_RELEASE && env.SENTRY_RELEASE !== release) throw new Error("SENTRY_RELEASE debe coincidir con la versión y variante compiladas");
  const required = env.TPV_RELEASE_BUILD === "1" || Boolean(env.SENTRY_AUTH_TOKEN);
  if (!required) return { enabled: false, release, version, variant };
  for (const name of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "TPV_SENTRY_DSN"]) {
    if (!env[name]?.trim()) throw new Error(`Falta ${name}: configúralo en Secrets/Variables de GitHub Actions`);
  }
  if (![env.SENTRY_ORG, env.SENTRY_PROJECT].every(value => /^[a-z0-9_-]+$/.test(value))) {
    throw new Error("SENTRY_ORG y SENTRY_PROJECT deben ser los slugs, no los nombres visibles");
  }
  const dsn = new URL(env.TPV_SENTRY_DSN);
  if (dsn.protocol !== "https:" || !dsn.username || dsn.password || !/^\/\d+$/.test(dsn.pathname) || dsn.search || dsn.hash) {
    throw new Error("TPV_SENTRY_DSN no es un DSN HTTPS válido");
  }
  return { enabled: true, release, version, variant, org: env.SENTRY_ORG, project: env.SENTRY_PROJECT,
    authToken: env.SENTRY_AUTH_TOKEN, dsn };
}

export async function sentryRequest(config, path) {
  const response = await fetch(`https://sentry.io/api/0/${path}`, {
    headers: { Authorization: `Bearer ${config.authToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Sentry HTTP ${response.status} en ${path}: revisa token, permisos y slugs`);
  return response;
}

export async function validateSentryTarget(config) {
  const project = await (await sentryRequest(config, `projects/${config.org}/${config.project}/`)).json();
  if (String(project.id) !== config.dsn.pathname.slice(1)) throw new Error("TPV_SENTRY_DSN corresponde a otro proyecto de Sentry");
  const keys = await (await sentryRequest(config, `projects/${config.org}/${config.project}/keys/`)).json();
  if (!keys.some(key => key.isActive && key.dsn?.public === config.dsn.href)) {
    throw new Error("TPV_SENTRY_DSN no coincide con una Client Key activa del proyecto");
  }
  return project;
}

export async function verifyUploadedMaps(config, directory, { attempts = 24, delayMs = 5000 } = {}) {
  const assets = join(directory, "assets");
  const localFiles = readdirSync(assets);
  if (localFiles.some(file => file.endsWith(".map"))) throw new Error("Quedan source maps en el instalador");
  const scripts = localFiles.filter(file => file.endsWith(".js"));
  if (!scripts.length) throw new Error("El build no contiene JavaScript");
  for (const file of scripts) {
    // El SDK contiene lecturas de _sentryDebugIds sin haber inyectado IDs.
    if (/\._sentryDebugIds\s*=(?!=)|\._sentryDebugIdIdentifier\s*=(?!=)/.test(readFileSync(join(assets, file), "utf8"))) {
      throw new Error("El build contiene Debug IDs incompatibles con tauri-plugin-sentry 0.5");
    }
  }
  let missing;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const names = await uploadedMapNames(config);
    missing = scripts.map(file => `~/assets/${file}`).filter(js => !names.has(js) || !names.has(`${js}.map`));
    if (!missing.length) return scripts.length;
    // La subida termina antes de que Sentry procese e indexe el artifact bundle.
    // Reintentar sólo los mapas pendientes; permisos o respuestas inválidas fallan inmediatamente.
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  throw new Error(`Falta en Sentry el JS o su mapa tras esperar su procesamiento: ${missing.join(", ")}`);
}

async function uploadedMapNames(config) {
  const base = `projects/${config.org}/${config.project}`;
  const files = await sentryPages(config, `${base}/releases/${encodeURIComponent(config.release)}/files/?per_page=100`);
  // sentry-cli 2.58 agrupa también la subida por release/ruta en artifact bundles. La lista
  // histórica de release files no los incluye. Este es el endpoint que usa la pantalla de
  // Source Maps de Sentry; si cambia o deja de responder, la comprobación bloquea la release.
  const bundles = await sentryPages(config, `${base}/files/artifact-bundles/?query=${encodeURIComponent(config.release)}&per_page=100`);
  for (const bundle of bundles) {
    if (!bundle.associations?.some(association => association.release === config.release)) continue;
    files.push(...await sentryPages(config, `${base}/artifact-bundles/${bundle.bundleId}/files/?per_page=100`, "files"));
  }
  return new Set(files.map(file => file.name ?? file.filePath));
}

export async function sentryPages(config, initialPath, field) {
  const files = [];
  let path = initialPath;
  while (path) {
    const response = await sentryRequest(config, path);
    const body = await response.json();
    files.push(...(field ? body[field] : body));
    const next = response.headers.get("link")?.split(",").find(link => link.includes('rel="next"') && link.includes('results="true"'));
    path = next ? new URL(next.match(/<([^>]+)>/)[1]).pathname.replace(/^\/api\/0\//, "") + new URL(next.match(/<([^>]+)>/)[1]).search : null;
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, arg] = process.argv.slice(2);
  const config = sentryBuildConfig({ ...process.env, TPV_RELEASE_BUILD: "1" }, mode === "validate" ? arg : undefined);
  if (mode === "validate") {
    await validateSentryTarget(config);
    console.log(`Sentry: DSN activo de ${config.org}/${config.project}; versión ${config.release}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${config.version}\nsentry_release=${config.release}\n`);
  } else if (mode === "maps") {
    console.log(`Sentry: ${await verifyUploadedMaps(config, arg)} scripts con sus mapas subidos; no se distribuyen .map ni Debug IDs`);
  } else throw new Error("Uso: sentry-config.mjs validate [tag] | maps <dist>");
}
