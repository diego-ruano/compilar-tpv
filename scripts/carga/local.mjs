// El worker en este equipo, sin tocar producción ni gastar nada: `wrangler dev` sobre el mismo código
// que se despliega, con la base central en un `sqld` (el servidor de Turso) del WSL y un proxy delante
// que cuenta las filas leídas y escritas de cada paso. Las filas son lo que factura Turso, y `sqld`
// las cuenta con el mismo motor.
//
// La base del negocio es el SQLite de su TenantHub, que `wrangler dev` guarda en la carpeta de la
// tanda: el alta la crea igual que en la nube (`provisionTenantDatabase`), sin sembrar nada antes.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as servidorTcp } from "node:net";
import { join } from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const WORKER = join(RAIZ, "apps/cloud-worker-licensing");
const WRANGLER = join(WORKER, "node_modules/wrangler/bin/wrangler.js");
const WIDGET = join(RAIZ, "apps/reservas-web/dist");
const ESQUEMA_CENTRAL = join(RAIZ, "docs/sql/control-plane/esquema-actual.sql");
const SQLD = "$HOME/.turso/sqld";

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

/** Una orden de bash en el WSL. */
function wsl(orden, timeout = 60_000) {
  return spawnSync("wsl.exe", ["-e", "bash", "-lc", orden], { encoding: "utf8", timeout, windowsHide: true });
}

async function esperarHttp(url, ms) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await dormir(500);
    }
  }
  return false;
}

/* ===== Hrana (el protocolo HTTP de libSQL) ===== */

async function hrana(url, peticiones) {
  const r = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests: [...peticiones, { type: "close" }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => null);
  const fallo = j?.results?.find(x => x.type !== "ok");
  if (!r.ok || !j || fallo) throw new Error(`sqld: ${fallo?.error?.message ?? `HTTP ${r.status}`}`);
  return j.results.map(x => x.response?.result);
}

/** Las filas leídas y escritas de una respuesta: por sentencia en `execute` y por paso en `batch`. */
function filasDe(respuesta) {
  let lecturas = 0;
  let escrituras = 0;
  for (const r of respuesta?.results ?? []) {
    if (r?.type !== "ok") continue;
    const resp = r.response;
    const resultados = resp?.type === "execute" ? [resp.result] : resp?.type === "batch" ? (resp.result?.step_results ?? []) : [];
    for (const x of resultados) {
      if (!x) continue;
      lecturas += x.rows_read ?? 0;
      escrituras += x.rows_written ?? 0;
    }
  }
  return { lecturas, escrituras };
}

function sentenciasDe(peticion) {
  let n = 0;
  for (const r of peticion?.requests ?? []) {
    if (r.type === "execute" || r.type === "sequence") n += 1;
    else if (r.type === "batch") n += r.batch?.steps?.length ?? 0;
  }
  return n;
}

/** Filas de Turso por paso de la tanda y por base (central / negocio). */
class MedidaTurso {
  constructor() {
    this.porEtapa = {};
  }

  sumar(etapa, base, d) {
    const e = (this.porEtapa[etapa] ??= {});
    const b = (e[base] ??= { http: 0, sentencias: 0, lecturas: 0, escrituras: 0 });
    for (const k of Object.keys(d)) b[k] += d[k];
  }

  /** Cuántas llamadas ha recibido una base en total: prueba de que el worker habla con ella. */
  llamadas(base) {
    return Object.values(this.porEtapa).reduce((n, e) => n + (e[base]?.http ?? 0), 0);
  }
}

/** Un proxy HTTP delante de un `sqld` que suma las filas de cada respuesta al paso en curso. */
function proxyContador(nombre, puertoSqld, medida, etapaEnCurso) {
  // Todo dentro del `try`: `createServer` no atiende la promesa del manejador, y una petición cortada
  // al parar workerd no puede tumbar el proceso.
  const servidor = createServer(async (req, res) => {
    try {
      const trozos = [];
      for await (const t of req) trozos.push(t);
      const cuerpo = Buffer.concat(trozos);
      const cabeceras = {};
      if (req.headers["content-type"]) cabeceras["content-type"] = req.headers["content-type"];
      if (req.headers.authorization) cabeceras.authorization = req.headers.authorization;
      const r = await fetch(`http://127.0.0.1:${puertoSqld}${req.url}`, {
        method: req.method,
        headers: cabeceras,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : cuerpo,
        signal: AbortSignal.timeout(30_000),
      });
      const respuesta = Buffer.from(await r.arrayBuffer());
      if (req.url.endsWith("/pipeline")) {
        let peticion = null;
        let contenido = null;
        try {
          peticion = JSON.parse(cuerpo.toString("utf8"));
          contenido = JSON.parse(respuesta.toString("utf8"));
        } catch {
          // Una respuesta que no es JSON no tiene filas que contar.
        }
        medida.sumar(etapaEnCurso(), nombre, { http: 1, sentencias: sentenciasDe(peticion), ...filasDe(contenido) });
      }
      // El cliente de libsql compara el content-type literal: se devuelve tal cual.
      const tipo = r.headers.get("content-type");
      res.writeHead(r.status, tipo ? { "content-type": tipo } : {});
      res.end(respuesta);
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy de ${nombre}: ${e.message}`);
    }
  });
  return new Promise(ok => servidor.listen(0, "127.0.0.1", () => ok(servidor)));
}

/**
 * El patrón de `pkill -f` para los procesos de una tanda. La `[a]` evita que case con la línea de
 * órdenes del propio bash que ejecuta el `pkill`, que lo contiene literal.
 */
const patronDeTanda = (tanda, resto = "") => `tpv-carg[a]/${tanda}/${resto}`;

/** Un `sqld` en el WSL. Si el reenvío de localhost no llega a 127.0.0.1, se prueba en todas. */
async function arrancarSqld(nombre, tanda, dirWsl, carpeta) {
  const puerto = await puertoLibre();
  for (const ip of ["127.0.0.1", "0.0.0.0"]) {
    const log = createWriteStream(join(carpeta, `sqld-${nombre}.log`), { flags: "a" });
    const proceso = spawn(
      "wsl.exe",
      [
        "-e",
        "bash",
        "-lc",
        `mkdir -p ${dirWsl} && exec ${SQLD} --no-welcome --db-path ${dirWsl}/${nombre}.sqld --http-listen-addr ${ip}:${puerto} --idle-shutdown-timeout-s 1800`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    volcar(proceso, log);
    if (await esperarHttp(`http://127.0.0.1:${puerto}/health`, 20_000)) return puerto;
    wsl(`pkill -f '${patronDeTanda(tanda, `${nombre}.sqld`)}' || true`);
    proceso.kill();
  }
  throw new Error(`El sqld de la base ${nombre} no contesta desde Windows (mira sqld-${nombre}.log).`);
}

/**
 * Levanta todo y devuelve la URL del worker local, el token de administración local (aleatorio, nada
 * que ver con el de producción), la medida de la base central y la parada.
 */
export async function levantarLocal({ carpeta, tanda, registro }) {
  if (!existsSync(WRANGLER)) throw new Error("Falta wrangler: ejecuta `pnpm install` en la raíz.");
  if (!existsSync(join(WIDGET, "reservas-web"))) throw new Error("Falta el widget compilado: ejecuta `pnpm --filter @tpv/reservas-web build`.");
  if (!/si/.test(wsl(`test -x ${SQLD} && echo si`).stdout ?? "")) throw new Error("No está sqld en el WSL (~/.turso/sqld): instala la CLI de Turso en el WSL.");

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
    if (!/^[0-9-]+$/.test(tanda)) throw new Error(`Nombre de tanda inesperado: ${tanda}`);
    const dirWsl = `$HOME/tpv-carga/${tanda}`;
    parada.push(() => wsl(`pkill -f '${patronDeTanda(tanda)}' ; rm -rf ${dirWsl}`));

    console.log("  · Base central local (sqld en el WSL)");
    const sqldCentral = await arrancarSqld("central", tanda, dirWsl, carpeta);
    const centralDirecta = `http://127.0.0.1:${sqldCentral}`;
    await hrana(centralDirecta, [{ type: "sequence", sql: readFileSync(ESQUEMA_CENTRAL, "utf8") }]);

    const medida = new MedidaTurso();
    const etapa = () => registro.etapa;
    const proxyCentral = await proxyContador("central", sqldCentral, medida, etapa);
    parada.push(() => proxyCentral.close());
    const urlCentral = `http://127.0.0.1:${proxyCentral.address().port}`;

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
      vars: { ...fuente.vars, TURSO_DATABASE_URL: urlCentral, ENVIRONMENT: "carga-local", RESERVAS_WEB_ORIGEN: "", JURISDICCION_DO: "" },
    };
    delete configuracion.triggers;
    delete configuracion.build;
    const rutaConfiguracion = join(dirWorker, "wrangler.json");
    writeFileSync(rutaConfiguracion, JSON.stringify(configuracion, null, 2));
    // Secretos de usar y tirar. El de Turso no vale para nada: el sqld local no pide token.
    const secretos = {
      TURSO_AUTH_TOKEN: "local-no-usar",
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
    if (!(await esperarHttp(`${base}/health`, 180_000))) throw new Error("El worker local no arrancó (mira worker.log).");

    // Prueba de que habla con la base central local y no con la de producción.
    registro.etapa = "salud";
    const salud = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) })
      .then(r => r.json())
      .catch(() => null);
    if (salud?.db !== "ok" || medida.llamadas("central") === 0) {
      throw new Error(`El /health del worker local no pasó por la base central local (${JSON.stringify(salud)}): no se sigue.`);
    }

    return { base, adminToken: secretos.ADMIN_API_TOKEN, medida, parar };
  } catch (e) {
    await parar();
    throw e;
  }
}
