// RI-24: ejecuta los bytes que se desplegarán y exige una traza TypeScript real en Sentry.
// El runtime local no recibe credenciales de Turso: falla antes de abrir una conexión o escribir.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { workerSentryConfig, readWorkerArtifact } from "./worker.mjs";
import { sentryRequest, sentryPages } from "./sentry-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = resolve(process.argv[2] ?? "target/worker-release");
const config = workerSentryConfig();
const manifest = readWorkerArtifact(artifact, config);
const keys = await (await sentryRequest(config, `projects/${config.org}/${config.project}/keys/`)).json();
const dsn = keys.find(k => k.isActive)?.dsn?.public;
if (!dsn) throw new Error("Falta una Client Key activa del worker");
const taskRoot = resolve(root, "target");
mkdirSync(taskRoot, { recursive: true });
const temporary = mkdtempSync(join(taskRoot, "sentry-local-"));
const local = JSON.parse(readFileSync(join(artifact, "wrangler.json"), "utf8"));
local.main = join(artifact, "index.js");
local.base_dir = artifact;
local.vars.ENVIRONMENT = "sentry-verification";
local.logpush = false;
delete local.triggers;
writeFileSync(join(temporary, "wrangler.json"), JSON.stringify(local));
writeFileSync(join(temporary, ".dev.vars"), `SENTRY_DSN=${dsn}\nSENTRY_DEBUG=true\nTURSO_AUTH_TOKEN=\n`);
const server = createServer();
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise(r => server.close(r));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
delete env.SENTRY_AUTH_TOKEN;
delete env.CLOUDFLARE_API_TOKEN;
const child = spawn(process.execPath, [join(root, "apps/cloud-worker-licensing/node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", join(temporary, "wrangler.json"), "--port", String(port)], { cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let spawnError;
child.on("error", error => { spawnError = error; });
const stopped = new Promise(r => child.once("exit", r));
child.stdout.on("data", d => { output = (output + d).slice(-3000); });
child.stderr.on("data", d => { output = (output + d).slice(-3000); });
const probeVersion = `${config.version}-verification.${randomUUID().slice(0, 8)}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) break;
    try { await fetch(`http://127.0.0.1:${port}/__ready`, { signal: AbortSignal.timeout(1000) }); ready = true; break; } catch { await delay(1000); }
  }
  if (!ready) throw new Error(`No arrancó workerd: ${output}`);
  const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "X-TPV-Version": probeVersion, "X-TPV-Variant": "windows-modern" }, signal: AbortSignal.timeout(15_000) });
  if (response.status !== 503) throw new Error("La sonda debe fallar por falta de credenciales locales de Turso");
  let event;
  for (let attempt = 0; attempt < 30; attempt++) {
    // Este endpoint documentado no admite la búsqueda estructurada de la UI (`query`).
    // Se acota el periodo y se identifica la sonda por su etiqueta única, con paginación.
    const events = await sentryPages(config, `projects/${config.org}/${config.project}/events/?statsPeriod=5m&per_page=100`);
    const candidate = events.find(e => e.tags?.some(t => t.key === "client_version" && t.value === probeVersion));
    if (candidate) {
      event = await (await sentryRequest(config, `projects/${config.org}/${config.project}/events/${candidate.eventID ?? candidate.id}/`)).json();
      const frames = event.entries?.find(e => e.type === "exception")?.data?.values?.flatMap(e => e.stacktrace?.frames ?? []) ?? [];
      const original = frames.find(f => f.filename?.replaceAll("\\", "/").endsWith("src/server/db.ts") && f.lineNo > 0 && f.context?.length);
      if (original) {
        if (event.release?.version !== config.release && event.release !== config.release) throw new Error("La release recibida no corresponde al artefacto");
        if (!event.tags?.some(t => t.key === "client_version" && t.value === probeVersion) || !event.tags?.some(t => t.key === "environment" && t.value === "sentry-verification")) throw new Error("Faltan los metadatos de versión/entorno en el evento recibido");
        const report = { eventId: event.eventID ?? event.id, project: `${config.org}/${config.project}`, release: config.release, commit: manifest.commit, environment: "sentry-verification", file: original.filename, line: original.lineNo, debugId: JSON.parse(readFileSync(join(artifact, "index.js.map"), "utf8")).debug_id };
        writeFileSync(join(taskRoot, "worker-sentry-verification.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        break;
      }
    }
    if (attempt === 29) throw new Error(`Sentry no recuperó el fuente TypeScript: ${event?.errors?.map(e => e.type).join(", ") ?? "evento no recibido"}\n${output}`);
    await delay(5000);
  }
} finally {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
  await Promise.race([stopped, delay(5000)]);
  if (!resolve(temporary).startsWith(taskRoot + sep)) throw new Error("Ruta temporal fuera de target");
  rmSync(temporary, { recursive: true, force: true });
}
