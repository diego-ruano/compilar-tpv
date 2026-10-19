import { readFileSync, writeFileSync, readdirSync, mkdirSync, appendFileSync, unlinkSync, cpSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { applicationVersion, sentryRequest, sentryPages } from "./sentry-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const worker = join(root, "apps/cloud-worker-licensing");
// El widget de reservas web va con el worker (Workers Static Assets): se compila aquí y viaja dentro
// del artefacto, en `assets/`, cubierto por el manifiesto como lo demás.
const widget = join(root, "apps/reservas-web");
const ASSETS = "assets";
const FICHEROS_DEL_WIDGET = ["reservas-web/index.html", "reservas-web/v1/embed.js"];

/** Los ficheros de un directorio, con su ruta relativa y `/` como separador. */
function listar(directory, base = "") {
  return readdirSync(join(directory, base), { withFileTypes: true }).flatMap(e => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? listar(directory, rel) : [rel];
  });
}

/** Sólo `assets/` puede tener subcarpetas, y ninguna ruta sale del artefacto. */
function rutaAceptable(file) {
  if (!file.includes("/")) return basename(file) === file;
  return file.startsWith(`${ASSETS}/`) && !file.split("/").some(p => p === ".." || p === "." || p === "");
}
const hash = data => createHash("sha256").update(data).digest("hex");
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export function workerVersion(tag, env = process.env) {
  if (tag?.startsWith("win7-")) throw new Error("Un tag de Windows 7 nunca despliega el worker");
  const version = applicationVersion({}, tag);
  const pkg = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error("La versión de tpv-api debe coincidir con la de la aplicación moderna");
  const release = `tpv-api@${version}`;
  if (env.SENTRY_RELEASE && env.SENTRY_RELEASE !== release) throw new Error("SENTRY_RELEASE no coincide con la versión del worker");
  return { version, release };
}

export function workerSentryConfig(env = process.env, tag) {
  const identity = workerVersion(tag, env);
  for (const key of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_WORKER_PROJECT"]) {
    if (!env[key]?.trim()) throw new Error(`Falta ${key} en Secrets/Variables de GitHub`);
  }
  if (![env.SENTRY_ORG, env.SENTRY_WORKER_PROJECT].every(v => /^[a-z0-9_-]+$/.test(v))) throw new Error("Usa los slugs de Sentry");
  return { ...identity, org: env.SENTRY_ORG, project: env.SENTRY_WORKER_PROJECT, authToken: env.SENTRY_AUTH_TOKEN, commit: env.GITHUB_SHA };
}

export async function validateWorkerTarget(config) {
  const project = await (await sentryRequest(config, `projects/${config.org}/${config.project}/`)).json();
  const keys = await (await sentryRequest(config, `projects/${config.org}/${config.project}/keys/`)).json();
  if (!keys.some(k => k.isActive && k.dsn?.public)) throw new Error("El proyecto del worker no tiene un DSN activo");
  return project;
}

function cli(tool, args, env = process.env) {
  const entry = tool === "wrangler" ? "wrangler/bin/wrangler.js" : "@sentry/cli/bin/sentry-cli";
  const result = spawnSync(process.execPath, [join(worker, "node_modules", entry), ...args], { cwd: worker, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${tool} falló (${result.status ?? result.error?.code})`);
}

export function readWorkerArtifact(directory, expected = workerVersion()) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== expected.version || manifest.release !== expected.release || manifest.worker !== "tpv-api") throw new Error("El artefacto no corresponde a esta release");
  if (expected.commit && manifest.commit !== expected.commit) throw new Error("El artefacto no corresponde al commit de este workflow");
  const actual = listar(directory).filter(f => f !== "manifest.json").sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error("Faltan archivos o hay archivos ajenos en el artefacto");
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (!rutaAceptable(file) || hash(readFileSync(join(directory, file))) !== digest) throw new Error(`Hash incorrecto: ${file}`);
  }
  const config = JSON.parse(readFileSync(join(directory, "wrangler.json"), "utf8"));
  if (config.name !== "tpv-api" || config.main !== "index.js" || config.no_bundle !== true || config.vars.SENTRY_RELEASE !== expected.release || config.vars.BUILD_COMMIT !== manifest.commit) throw new Error("Configuración de despliegue incorrecta");
  // Sin el widget dentro, el worker se desplegaría sin poder servirlo.
  if (config.assets?.directory !== ASSETS || FICHEROS_DEL_WIDGET.some(f => !manifest.files[`${ASSETS}/${f}`])) throw new Error("Falta el widget de reservas web en el artefacto");
  const map = JSON.parse(readFileSync(join(directory, "index.js.map"), "utf8"));
  if (!UUID.test(map.debug_id ?? "") || !readFileSync(join(directory, "index.js"), "utf8").includes(map.debug_id)) throw new Error("El JavaScript y el mapa no comparten Debug ID");
  return manifest;
}

export async function prepareWorker(directory, config, env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) throw new Error("Falta el commit exacto del build");
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error("Usa un directorio de build vacío");
  await validateWorkerTarget(config);
  // El widget primero: la configuración del worker lo declara (`assets`) y el despliegue lo lleva.
  const vite = spawnSync(process.execPath, [join(widget, "node_modules/vite/bin/vite.js"), "build"], { cwd: widget, stdio: "inherit" });
  if (vite.status !== 0) throw new Error(`El widget de reservas web no compila (${vite.status ?? vite.error?.code})`);
  const compilado = join(widget, "dist");
  if (FICHEROS_DEL_WIDGET.some(f => !existsSync(join(compilado, f)))) throw new Error("El widget compilado está incompleto");
  cli("wrangler", ["deploy", "--dry-run", "--outdir", directory]);
  // El README de Wrangler lleva la hora del build y no forma parte del programa.
  unlinkSync(join(directory, "README.md"));
  cli("sentry-cli", ["sourcemaps", "inject", directory]);
  cli("sentry-cli", ["sourcemaps", "upload", "--release", config.release, "--wait", directory], { ...env, SENTRY_PROJECT: config.project });
  const source = JSON.parse(readFileSync(join(worker, "wrangler.json"), "utf8"));
  // Nunca se vuelve a compilar después de subir los mapas: se despliegan estos mismos bytes.
  cpSync(compilado, join(directory, ASSETS), { recursive: true });
  const deploy = { ...source, main: "index.js", no_bundle: true, find_additional_modules: true, base_dir: ".", assets: { ...source.assets, directory: ASSETS }, vars: { ...source.vars, ENVIRONMENT: "prod", SENTRY_RELEASE: config.release, BUILD_COMMIT: env.GITHUB_SHA } };
  writeFileSync(join(directory, "wrangler.json"), JSON.stringify(deploy, null, 2));
  const files = Object.fromEntries(listar(directory).filter(f => f !== "manifest.json").map(f => [f, hash(readFileSync(join(directory, f)))]));
  const manifest = { worker: "tpv-api", version: config.version, release: config.release, commit: env.GITHUB_SHA, files };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  readWorkerArtifact(directory, config);
  await verifyWorkerMaps(directory, config);
  return manifest;
}

/**
 * La configuración del artefacto para arrancarlo con `wrangler dev` desde otra carpeta (la
 * verificación de Sentry): todo lo que apunta al artefacto, en absoluto. El widget de reservas web va
 * en `assets/`; con la ruta relativa, Wrangler lo buscaría en la carpeta temporal y no arrancaría.
 */
export function configuracionLocal(desplegada, artifact) {
  const local = { ...desplegada, vars: { ...desplegada.vars } };
  local.main = join(artifact, "index.js");
  local.base_dir = artifact;
  if (local.assets?.directory) local.assets = { ...local.assets, directory: resolve(artifact, local.assets.directory) };
  local.vars.ENVIRONMENT = "sentry-verification";
  local.logpush = false;
  delete local.triggers;
  return local;
}

export async function verifyWorkerMaps(directory, config) {
  readWorkerArtifact(directory, config);
  const debugId = JSON.parse(readFileSync(join(directory, "index.js.map"), "utf8")).debug_id;
  for (let attempt = 0; attempt < 24; attempt++) {
    const bundles = await sentryPages(config, `projects/${config.org}/${config.project}/files/artifact-bundles/?query=${encodeURIComponent(config.release)}&per_page=100`);
    for (const bundle of bundles.filter(b => b.associations?.some(a => a.release === config.release))) {
      const files = await sentryPages(config, `projects/${config.org}/${config.project}/artifact-bundles/${bundle.bundleId}/files/?per_page=100`, "files");
      if (["/index.js", "/index.js.map"].every(suffix => files.some(f => (f.filePath ?? f.name)?.endsWith(suffix) && (f.debugId === debugId || f.debug_id === debugId)))) return;
    }
    if (attempt < 23) await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error("Sentry no confirma el mapa del worker: se bloquea el despliegue");
}

export async function validateCloudflare(env = process.env) {
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") || !env.CLOUDFLARE_API_TOKEN) throw new Error("Faltan las credenciales de Cloudflare en GitHub");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/tpv-api/settings`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}: revisa el token Workers Editor y la cuenta`);
  const settings = await response.json();
  if (!settings.success || !settings.result.bindings.some(b => b.name === "SENTRY_DSN" && b.type === "secret_text")) throw new Error("Falta SENTRY_DSN como secreto del worker en Cloudflare");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory = "target/worker-release", tag] = process.argv.slice(2);
  const config = workerSentryConfig(process.env, tag);
  const output = resolve(directory);
  if (mode === "prepare") await prepareWorker(output, config);
  else if (mode === "verify") { await validateWorkerTarget(config); await verifyWorkerMaps(output, config); }
  else if (mode === "cloudflare") { readWorkerArtifact(output, config); await validateCloudflare(); }
  else throw new Error("Uso: worker.mjs prepare|verify|cloudflare <directorio> [tag]");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${config.version}\nsentry_release=${config.release}\n`);
  console.log(`Worker ${config.release}: comprobación ${mode} correcta`);
}
