// El worker en este equipo, sin tocar producción ni gastar nada: `wrangler dev` sobre el mismo código
// que se despliega, con sus Durable Objects en la carpeta de la tanda.
//
// La base central es su objeto `BaseCentral`, que nace sin aprovisionar: se le da esquema con la ruta
// de administración (`/v1/admin/central/aprovisionar`), como a la de producción. La base del negocio
// es el SQLite de su TenantHub: el alta la crea igual que en la nube (`provisionTenantDatabase`), sin
// sembrar nada antes.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as servidorTcp } from "node:net";
import { join } from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const WORKER = join(RAIZ, "apps/cloud-worker-licensing");
const WRANGLER = join(WORKER, "node_modules/wrangler/bin/wrangler.js");
const WIDGET = join(RAIZ, "apps/reservas-web/dist");

/** Lo que no debe llegar a wrangler: con esto podría hablar con la cuenta de Cloudflare de verdad. */
const VARIABLES_FUERA = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "ADMIN_API_TOKEN", "SENTRY_AUTH_TOKEN", "TPV_API_BASE"];

function entornoLimpio() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  for (const clave of Object.keys(env)) if (VARIABLES_FUERA.includes(clave.toUpperCase())) delete env[clave];
  return env;
}

function puertoLibre() {
  return new Promise((ok, ko) => {
    const s = servidorTcp();
    s.on("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/**
 * La salida de un proceso a su fichero de log, sin los códigos de color. Las dos salidas comparten
 * fichero: ninguna lo cierra al acabar, o la otra escribiría en un fichero cerrado.
 */
function volcar(proceso, log) {
  for (const salida of [proceso.stdout, proceso.stderr]) {
    salida.on("data", trozo => log.write(stripVTControlCharacters(trozo.toString("utf8"))));
  }
  proceso.on("close", () => log.end());
}

/**
 * Espera a que el worker conteste. Con un `OPTIONS`, que contesta sin tocar ninguna base: un `GET` de
 * `/health` con la central aún sin aprovisionar dejaría su 503 en la caché del veredicto (30 s).
 */
async function esperarAlWorker(base, ms) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    try {
      await fetch(`${base}/health`, { method: "OPTIONS", signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await dormir(500);
    }
  }
  return false;
}

/** Una petición de administración al worker local. Lo que contesta, o `null` si no es JSON. */
async function administrar(base, token, metodo, ruta, cuerpo) {
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { authorization: `Bearer ${token}`, ...(cuerpo === undefined ? {} : { "content-type": "application/json" }) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, datos: await r.json().catch(() => null) };
}

/**
 * La base central del worker local, con esquema. Tiene que nacer sin aprovisionar: es la prueba de
 * que es la de esta tanda (la de producción lo está, y una de otra tanda no se reutiliza).
 */
async function aprovisionarLaCentral(base, token) {
  const antes = await administrar(base, token, "GET", "/v1/admin/central/estado");
  if (antes.status !== 200 || antes.datos?.aprovisionada !== false) {
    throw new Error(`La base central del worker local no nace vacía (${antes.status} ${JSON.stringify(antes.datos)}): no se sigue.`);
  }
  const r = await administrar(base, token, "POST", "/v1/admin/central/aprovisionar", {});
  if (r.status !== 200 || r.datos?.aprovisionada !== true) {
    throw new Error(`No se pudo aprovisionar la base central local: ${r.status} ${r.datos?.error ?? ""} ${r.datos?.detalle ?? ""}`.trim());
  }
}

/**
 * Levanta el worker y devuelve su URL, el token de administración local (aleatorio, nada que ver con
 * el de producción) y la parada.
 */
export async function levantarLocal({ carpeta }) {
  if (!existsSync(WRANGLER)) throw new Error("Falta wrangler: ejecuta `pnpm install` en la raíz.");
  if (!existsSync(join(WIDGET, "reservas-web"))) throw new Error("Falta el widget compilado: ejecuta `pnpm --filter @tpv/reservas-web build`.");

  const parada = [];
  const parar = async () => {
    for (const p of parada.splice(0).reverse()) {
      try {
        await p();
      } catch {
        // Se sigue parando lo demás.
      }
    }
  };

  try {
    console.log("  · Empaquetar el worker (wrangler deploy --dry-run)");
    const dirWorker = join(carpeta, "worker");
    const build = join(dirWorker, "build");
    mkdirSync(dirWorker, { recursive: true });
    const compilacion = spawnSync(process.execPath, [WRANGLER, "deploy", "--dry-run", "--outdir", build], {
      cwd: WORKER,
      env: entornoLimpio(),
      encoding: "utf8",
      timeout: 300_000,
      windowsHide: true,
    });
    writeFileSync(join(carpeta, "worker-compilacion.log"), `${compilacion.stdout ?? ""}\n${compilacion.stderr ?? ""}`);
    if (compilacion.status !== 0) throw new Error("wrangler no pudo empaquetar el worker (mira worker-compilacion.log).");

    // La configuración desplegada, con lo que apunta fuera cambiado por lo local. Sin `triggers`: el
    // cron no corre solo en medio de la medida.
    const fuente = JSON.parse(readFileSync(join(WORKER, "wrangler.json"), "utf8"));
    const configuracion = {
      ...fuente,
      main: join(build, "index.js"),
      no_bundle: true,
      find_additional_modules: true,
      base_dir: build,
      assets: { ...fuente.assets, directory: WIDGET },
      logpush: false,
      // JURISDICCION_DO vacía: workerd no implementa jurisdicciones.
      vars: { ...fuente.vars, ENVIRONMENT: "carga-local", RESERVAS_WEB_ORIGEN: "", JURISDICCION_DO: "" },
    };
    delete configuracion.triggers;
    delete configuracion.build;
    const rutaConfiguracion = join(dirWorker, "wrangler.json");
    writeFileSync(rutaConfiguracion, JSON.stringify(configuracion, null, 2));
    // Secretos de usar y tirar.
    const secretos = {
      LICENSE_JWT_SECRET: randomBytes(32).toString("base64"),
      LICENSE_STORE_KEY: randomBytes(32).toString("base64"),
      LICENSE_SIGNING_PRIVATE_KEY: randomBytes(32).toString("base64"),
      ADMIN_API_TOKEN: randomBytes(32).toString("hex"),
      PAIR_PEPPER: randomBytes(16).toString("hex"),
    };
    writeFileSync(join(dirWorker, ".dev.vars"), Object.entries(secretos).map(([k, v]) => `${k}=${v}\n`).join(""));

    console.log("  · Arrancar el worker (wrangler dev --local)");
    const puerto = await puertoLibre();
    const inspector = await puertoLibre();
    const log = createWriteStream(join(carpeta, "worker.log"));
    const wrangler = spawn(
      process.execPath,
      [WRANGLER, "dev", "--local", "--config", rutaConfiguracion, "--ip", "127.0.0.1", "--port", String(puerto), "--inspector-port", String(inspector), "--persist-to", join(dirWorker, "estado"), "--log-level", "info"],
      { cwd: dirWorker, env: entornoLimpio(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    volcar(wrangler, log);
    parada.push(() => {
      if (wrangler.exitCode === null) spawnSync("taskkill", ["/PID", String(wrangler.pid), "/T", "/F"], { windowsHide: true });
    });
    const base = `http://127.0.0.1:${puerto}`;
    if (!(await esperarAlWorker(base, 180_000))) throw new Error("El worker local no arrancó (mira worker.log).");

    console.log("  · Aprovisionar la base central local (/v1/admin/central/aprovisionar)");
    await aprovisionarLaCentral(base, secretos.ADMIN_API_TOKEN);

    // Y que el worker llega a ella: `/health` toca la base central.
    const salud = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) })
      .then(r => r.json())
      .catch(() => null);
    if (salud?.db !== "ok") throw new Error(`El /health del worker local no llega a su base central (${JSON.stringify(salud)}): no se sigue.`);

    return { base, adminToken: secretos.ADMIN_API_TOKEN, parar };
  } catch (e) {
    await parar();
    throw e;
  }
}
