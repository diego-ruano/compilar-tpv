// Generador de carga del TPV: monta un negocio de pruebas con una Main y una Handy sintéticas, lanza un
// plan de peticiones variadas y mide lo que cuesta. Guía: docs/guias/pruebas-de-carga.md.
//
//   pnpm carga --local                todo en este equipo (wrangler dev + sqld del WSL): no gasta nada
//   node scripts/carga/carga.mjs --nube    contra el worker desplegado, con una licencia de pruebas
//   pnpm carga --medir <carpeta>      vuelve a medir Cloudflare de una tanda en la nube
//   pnpm carga --retirar [--si]       lista (y con --si retira) los negocios de pruebas

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { pedirAdmin } from "./cliente.mjs";
import { esperarSalvoCancelacion, medirCloudflare, planDeTurso, prepararCloudflare, usoAsentado, usoDeBase } from "./coste.mjs";
import { cerrarSockets, comprobarSubida, ejecutarPlan, planDeCarga, prepararNegocio } from "./escenario.mjs";
import { escribirInforme } from "./informe.mjs";
import { levantarLocal } from "./local.mjs";
import { Cancelado, FrenoDeSeguridad, Registro } from "./registro.mjs";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const BASE_NUBE = "https://tpv-api.altarialights.workers.dev";
/** Lo que gasta una tanda antes de limpiar: unas 60 peticiones, con margen. */
const TOPE_MINIMO = 70;

const AYUDA = `
Generador de carga del TPV (docs/guias/pruebas-de-carga.md)

  pnpm carga --local                     el worker en este equipo, con Turso en sqld del WSL
  node scripts/carga/carga.mjs --nube    el worker desplegado, con un negocio de pruebas que se retira al final
  pnpm carga --medir <carpeta>           vuelve a medir Cloudflare de una tanda en la nube
  pnpm carga --retirar                   lista los negocios de pruebas; con --si, los retira todos

Opciones:
  --ritmo <n>        peticiones por segundo de la carga (por defecto 1, máximo 5)
  --vueltas <n>      repite el servicio n veces sobre el mismo negocio (por defecto 1, máximo 20)
  --tope <n>         peticiones como mucho antes de limpiar (por defecto 150, mínimo ${TOPE_MINIMO})
  --sin-retirar      en la nube, deja vivo el negocio de pruebas
  --sin-medir        en la nube, no espera a medir Turso ni Cloudflare

En la nube, mejor con node que con pnpm: en Windows, Ctrl+C sobre pnpm devuelve el prompt
mientras la tanda sigue detrás limpiando.
`;

function argumentos(lista) {
  const a = {};
  for (let i = 0; i < lista.length; i++) {
    const clave = lista[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const siguiente = lista[i + 1];
    if (siguiente !== undefined && !siguiente.startsWith("--")) {
      a[clave] = siguiente;
      i++;
    } else {
      a[clave] = true;
    }
  }
  return a;
}

/** El `.env` de la raíz, como `scripts/tpv-license.mjs`: lo que ya está en el entorno manda. */
function cargarDotEnv() {
  let texto;
  try {
    texto = readFileSync(join(RAIZ, ".env"), "utf8");
  } catch {
    return;
  }
  for (const bruta of texto.split(/\r?\n/)) {
    const linea = bruta.trim();
    if (!linea || linea.startsWith("#")) continue;
    const igual = linea.indexOf("=");
    if (igual === -1) continue;
    const clave = linea.slice(0, igual).trim();
    const valor = linea.slice(igual + 1).trim().replace(/^["']|["']$/g, "");
    if (clave && process.env[clave] === undefined) process.env[clave] = valor;
  }
}

function sello(d = new Date()) {
  const dos = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}-${dos(d.getHours())}${dos(d.getMinutes())}${dos(d.getSeconds())}`;
}

/** Escribir en disco no puede impedir limpiar: si falla, se avisa y se sigue. */
function sinFallar(registro, que, fn) {
  try {
    return fn();
  } catch (e) {
    registro.avisar(`No se pudo ${que}: ${e.message}`);
    return null;
  }
}

/** Para la limpieza: la retirada es idempotente, así que un fallo pasajero se repite. */
async function conReintentos(registro, que, fn) {
  const esperas = [2000, 5000, 10_000];
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      if (intento >= esperas.length) throw e;
      registro.avisar(`${que} falló (${e.message}): se repite en ${esperas[intento] / 1000} s.`);
      await dormir(esperas[intento]);
    }
  }
}

const esLicenciaDePruebas = l => l.origin === "pruebas" || (l.origin === "manual" && l.customerEmail === "e2e@altarialights.test");

/** Las licencias de pruebas sin anular, todas las páginas: `/v1/admin/pruebas/retirar` se las lleva TODAS. */
async function licenciasDePruebasVivas(admin) {
  const vivas = [];
  for (let offset = 0; offset <= 20_000; offset += 200) {
    const r = await pedirAdmin(admin, "GET", `/v1/admin/licenses?limit=200&offset=${offset}`);
    if (!r.ok) throw new Error(`No se pudo listar las licencias: ${r.status} ${r.error}`);
    const pagina = r.datos?.licenses;
    if (!Array.isArray(pagina)) throw new Error("La lista de licencias no tiene la forma esperada.");
    vivas.push(...pagina.filter(l => esLicenciaDePruebas(l) && l.status !== "revoked"));
    if (pagina.length < 200) break;
  }
  return vivas;
}

/**
 * `/v1/admin/pruebas/retirar` hasta que no quede nada: borra la base de Turso de cada negocio de
 * pruebas (10 por llamada) y anula las licencias. Lo que Turso no pudo borrar vuelve a salir en la
 * llamada siguiente, así que se reintenta un par de veces; los fallos que valen son los de la última.
 */
async function retirarPruebas(admin) {
  let negocios = 0;
  let fallos = [];
  for (let vuelta = 0, reintentos = 0; vuelta < 20; vuelta++) {
    const r = await pedirAdmin(admin, "POST", "/v1/admin/pruebas/retirar");
    if (!r.ok) throw new Error(`La retirada falló: ${r.status} ${r.error}`);
    negocios += r.datos.negocios ?? 0;
    fallos = r.datos.fallos ?? [];
    if (r.datos.quedan && r.datos.negocios) continue;
    if (fallos.length && reintentos++ < 2) {
      await dormir(3000);
      continue;
    }
    break;
  }
  return { negocios, fallos };
}

async function comprobacionesPrevias(ctx, a) {
  // Una tanda en la nube puede durar media hora con las medidas: no se arranca si puede pisar el cron.
  const minutoUtc = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (minutoUtc >= 6 * 60 + 20 && minutoUtc < 7 * 60 + 30) {
    throw new Error("Entre las 06:20 y las 07:30 UTC la tanda pisaría el cron diario del worker (07:00): prueba fuera de esa franja.");
  }
  if (!a.sinRetirar) {
    const vivas = await licenciasDePruebasVivas(ctx.admin);
    if (vivas.length) {
      throw new Error(
        `Hay ${vivas.length} licencias de pruebas sin anular (${vivas.map(l => `${l.keyShort} ${l.customerEmail ?? ""} ${l.status}`.trim()).join("; ")}). ` +
          "Al terminar se retiran TODAS las de pruebas: revísalas con «pnpm carga --retirar» o lanza la tanda con --sin-retirar.",
      );
    }
  }
  // La cuota de Turso se mira siempre: en el plan gratuito, pasarse bloquea todas las bases.
  const plan = planDeTurso();
  if (!plan) throw new Error("No se pudo leer el plan de Turso con la CLI del WSL (¿sesión caducada? «turso auth login» en el WSL): sin él no se sabe si la tanda cabe en la cuota.");
  const sinLeer = Object.entries(plan.porcentajes).filter(([, p]) => p !== null && !Number.isFinite(p));
  if (sinLeer.length) throw new Error(`No se entiende la salida de «turso plan show» (${sinLeer.map(([k]) => k).join(", ")}).`);
  const altos = Object.entries(plan.porcentajes).filter(([, p]) => p >= 80);
  if (altos.length) {
    throw new Error(`Turso va al ${altos.map(([k, p]) => `${p} % en ${k}`).join(", ")}: en el plan gratuito pasarse bloquea TODAS las bases, también la de producción.`);
  }
  // Que la CLI mire la organización de producción: si no ve tpv-control, sus cifras serían de otra.
  const control = usoDeBase("tpv-control");
  if (!control) throw new Error("La CLI de Turso del WSL no ve la base tpv-control: está en otra organización o la sesión no sirve.");
  ctx.coste.turso = { plan: plan.texto, antes: { "tpv-control": control } };
}

/** Hasta el minuto siguiente y un segundo: Cloudflare agrega los Durable Objects por minuto. */
async function alMinutoSiguiente(cancelado) {
  const ms = 60_000 - (Date.now() % 60_000) + 1000;
  console.log(`  · Esperando ${Math.round(ms / 1000)} s al minuto siguiente para separar la medida`);
  await esperarSalvoCancelacion(ms, cancelado);
}

/** Retira el negocio de la tanda y deja dicho, en `estado`, si de verdad quedó todo borrado. */
async function retirarLaTanda(ctx) {
  const { registro, estado } = ctx;
  try {
    const vivas = await conReintentos(registro, "Listar las licencias", () => licenciasDePruebasVivas(ctx.admin));
    const ajenas = vivas.filter(l => l.licenseId !== estado.licenseId);
    if (ajenas.length) {
      estado.motivoSinRetirar = `Han aparecido otras licencias de pruebas sin anular (${ajenas.map(l => l.keyShort).join(", ")}) y retirar se las llevaría también.`;
      return;
    }
    console.log("  · Retirar el negocio de pruebas");
    const r = await conReintentos(registro, "La retirada", () => retirarPruebas(ctx.admin));
    estado.fallosRetirada = r.fallos;
    const fallo = r.fallos.find(f => f.tenantId === estado.tenantId);
    const sigue = (await conReintentos(registro, "Listar las licencias", () => licenciasDePruebasVivas(ctx.admin))).some(l => l.licenseId === estado.licenseId);
    if (sigue) {
      estado.motivoSinRetirar = "La licencia sigue sin anular después de retirar.";
    } else if (fallo) {
      estado.motivoSinRetirar = `La licencia quedó anulada, pero Turso no borró la base tpv-${estado.tenantId} (${fallo.error}). «pnpm carga --retirar --si» lo reintenta.`;
    } else if (!estado.tenantId && estado.activacion === "en curso") {
      // AUD-09: el worker crea la base antes de apuntar el negocio en la licencia; si la activación
      // no contestó, la retirada no la ve.
      estado.motivoSinRetirar =
        "La licencia quedó anulada, pero la activación no llegó a contestar: si alcanzó a crear la base, queda una tpv-<negocio> en el grupo tpv que la retirada no ve. " +
        `El negocio sale de tpv-control con SELECT tenant_id FROM devices WHERE device_id = '${estado.mainDeviceId}', y la base se borra a mano con «turso db destroy».`;
    } else {
      estado.retirado = true;
    }
  } catch (e) {
    estado.motivoSinRetirar = `La retirada falló: ${e.message}`;
  }
}

async function tanda(a) {
  const destino = a.local ? "local" : "nube";
  const ritmo = Number(a.ritmo ?? 1);
  if (!(ritmo > 0 && ritmo <= 5)) throw new Error("--ritmo va de 0,1 a 5 peticiones por segundo.");
  const tope = Number(a.tope ?? 150);
  if (!Number.isInteger(tope) || tope < TOPE_MINIMO) throw new Error(`--tope tiene que ser un entero de ${TOPE_MINIMO} o más.`);
  const medir = destino === "nube" && !a.sinMedir;
  const vueltas = Number(a.vueltas ?? 1);
  if (!Number.isInteger(vueltas) || vueltas < 1 || vueltas > 20) throw new Error("--vueltas va de 1 a 20.");
  const nombre = sello();
  const carpeta = join(RAIZ, "target", "carga", `${nombre}-${destino}`);
  mkdirSync(carpeta, { recursive: true });

  const registro = new Registro({ carpeta, tope });
  const ctx = {
    tanda: nombre,
    destino,
    base: null,
    registro,
    ids: {},
    vueltas,
    ventanas: { inicio: new Date().toISOString() },
    cancelado: false,
    coste: {},
    estado: { destino, tanda: nombre, ritmo },
  };
  const cancelado = () => ctx.cancelado;
  const guardarEstado = () =>
    sinFallar(registro, "guardar estado.json", () =>
      writeFileSync(
        join(carpeta, "estado.json"),
        JSON.stringify({ ...ctx.estado, base: ctx.base, ventanas: ctx.ventanas, socket: registro.socket, avisos: registro.avisos }, null, 2),
      ),
    );
  ctx.guardarEstado = guardarEstado;
  const guardarCoste = () => sinFallar(registro, "guardar coste.json", () => writeFileSync(join(carpeta, "coste.json"), JSON.stringify(ctx.coste, null, 2)));

  // Una promesa rechazada sin atender tumbaría el proceso antes de retirar el negocio.
  process.on("unhandledRejection", e => registro.avisar(`Promesa rechazada sin atender: ${e?.message ?? e}`));
  let interrupciones = 0;
  process.on("SIGINT", () => {
    if (registro.enLimpieza) {
      ctx.cancelado = true;
      console.log("\n  Ya se está limpiando: se salta lo que queda de medida y se retira. No cierres la ventana.");
      return;
    }
    interrupciones += 1;
    if (interrupciones === 1) {
      ctx.cancelado = true;
      console.log("\n  Cancelando: termina el paso en curso, se cierra todo y se retira el negocio. No cierres la ventana.");
    } else {
      console.log(`\n  Saliendo sin limpiar. Lo que hay que retirar está en ${join(carpeta, "estado.json")}`);
      process.exit(130);
    }
  });

  console.log(`\nGenerador de carga · tanda ${nombre} · ${destino}`);
  console.log(`Carpeta: ${relative(RAIZ, carpeta)}`);
  if (destino === "nube" && process.platform === "win32" && process.env.npm_lifecycle_event) {
    console.log("Nota: con pnpm en Windows, Ctrl+C devuelve el prompt aunque la tanda siga detrás. Para poder pararla, «node scripts/carga/carga.mjs --nube».");
  }
  console.log("");

  try {
    registro.fase = "comprobaciones";
    if (destino === "local") {
      console.log("Entorno local");
      ctx.local = await levantarLocal({ carpeta, tanda: nombre, registro });
      ctx.base = ctx.local.base;
      ctx.admin = { base: ctx.base, token: ctx.local.adminToken, registro };
    } else {
      cargarDotEnv();
      ctx.base = String(a.base ?? process.env.TPV_API_BASE ?? BASE_NUBE).replace(/\/$/, "");
      if (!process.env.ADMIN_API_TOKEN) throw new Error("Falta ADMIN_API_TOKEN en el .env de la raíz.");
      ctx.admin = { base: ctx.base, token: process.env.ADMIN_API_TOKEN, registro };
      console.log(`Comprobaciones previas contra ${ctx.base}`);
      await comprobacionesPrevias(ctx, a);
      guardarCoste();
    }
    guardarEstado();

    console.log("\nPreparación");
    await prepararNegocio(ctx);

    if (destino === "nube") {
      if (medir) {
        console.log("  · Turso: uso de la base del negocio tras el alta (se espera a que se asiente)");
        ctx.coste.turso.despuesPreparacion = await usoAsentado(`tpv-${ctx.estado.tenantId}`, { otras: ["tpv-control"], exigirEscrituras: true, cancelado });
        guardarCoste();
      }
      if (ctx.cancelado) throw new Cancelado();
      await alMinutoSiguiente(cancelado);
    }
    if (ctx.cancelado) throw new Cancelado();

    console.log(`\nCarga: ${planDeCarga().length * vueltas} pasos (${vueltas} vueltas) a ${ritmo} por segundo`);
    await ejecutarPlan(ctx, { ritmo, vueltas });
    if (ctx.cancelado) throw new Cancelado();

    // Con la medida de Cloudflare no: sus peticiones caerían en el minuto de la carga.
    if (!medir) {
      registro.fase = "comprobacion";
      console.log("\nComprobación de la subida de la Main contra el log de la nube");
      const cuadra = await comprobarSubida(ctx);
      const s = ctx.estado.subida;
      console.log(
        `  ${cuadra ? "✓" : "✗"} ${s.operaciones} operaciones en ${s.lotes} lotes · en el log una vez cada una: ${s.operaciones - s.enElLog.fuera - s.enElLog.repetidas - s.enElLog.otroSeq} · ` +
          `reenviadas ${s.reenviadas} (sin intentar ${s.noIntentadas}, ya estaban ${s.yaEstaban}) · rechazadas ${s.rechazadas} · ` +
          `change en la Handy ${s.handy.esperados - s.handy.faltan}/${s.handy.esperados}${s.handy.repetidos ? ` (${s.handy.repetidos} repetidos)` : ""}`,
      );
      if (!cuadra) throw new Error("La subida de la Main no cuadra con el log de la nube (ver avisos).");
    }
  } catch (e) {
    ctx.estado.error = e instanceof Cancelado ? e.message : e instanceof FrenoDeSeguridad ? `freno de seguridad: ${e.message}` : e.message;
    console.error(`\n  ✖ ${ctx.estado.error}`);
  } finally {
    registro.fase = "limpieza";
    registro.etapa = "cierre";
    const limpia = !ctx.estado.error;
    if (ctx.ventanas.carga && !ctx.ventanas.carga.hasta) ctx.ventanas.carga.hasta = new Date().toISOString();
    console.log("\nCierre");

    // El cierre de los sockets en sus propios minutos: Cloudflare apunta cada conexión al cerrarse,
    // y es coste de la sesión, no de los pasos de la carga.
    if (medir && limpia && ctx.ventanas.carga) await alMinutoSiguiente(cancelado);
    ctx.ventanas.cierre = { desde: new Date().toISOString() };
    await cerrarSockets(ctx);
    ctx.ventanas.cierre.hasta = new Date().toISOString();
    guardarEstado();

    if (destino === "local") {
      sinFallar(registro, "guardar turso-local.json", () =>
        writeFileSync(join(carpeta, "turso-local.json"), JSON.stringify(ctx.local?.medida.porEtapa ?? {}, null, 2)),
      );
      await ctx.local?.parar();
    } else {
      registro.etapa = "limpieza";
      const negocio = ctx.estado.tenantId ? `tpv-${ctx.estado.tenantId}` : null;
      const antes = ctx.coste.turso?.despuesPreparacion;
      if (medir && limpia && negocio && antes?.asentado) {
        try {
          console.log("  · Turso: uso tras la carga, antes de borrar la base (se espera a que se asiente)");
          ctx.coste.turso.despuesCarga = await usoAsentado(negocio, { otras: ["tpv-control"], distintoDe: antes[negocio], cancelado });
          guardarCoste();
        } catch (e) {
          registro.avisar(`No se pudo medir Turso tras la carga: ${e.message}`);
        }
      }
      if (ctx.estado.licenseId && !a.sinRetirar) {
        await retirarLaTanda(ctx);
        if (!ctx.estado.retirado) registro.avisar(`El negocio de pruebas no quedó retirado del todo: ${ctx.estado.motivoSinRetirar}`);
      } else if (a.sinRetirar) {
        ctx.estado.motivoSinRetirar = "Se lanzó con --sin-retirar.";
      }
      guardarEstado();

      if (medir && limpia && ctx.estado.tenantId && !ctx.cancelado) {
        const carga = registro.entradas.filter(e => e.fase === "carga");
        const minimos = {
          http: carga.filter(e => e.http && e.actor !== "admin").length,
          escriturasHandy: carga.filter(e => e.tipo === "escritura" && e.ok).length,
        };
        // Los datos de Cloudflare tardan en llegar: no se lee hasta 5 minutos después de la carga.
        const esperaInicialMs = Math.max(0, Date.parse(ctx.ventanas.carga.hasta) + 5 * 60_000 - Date.now());
        try {
          const cf = await prepararCloudflare();
          ctx.coste.cloudflare = cf.error ? { error: cf.error } : await medirCloudflare(cf, ctx.ventanas, ctx.estado.tenantId, { minimos, esperaInicialMs, cancelado });
        } catch (e) {
          ctx.coste.cloudflare = { error: e.message };
        }
        guardarCoste();
      }
    }
    guardarEstado();
    const resumen = sinFallar(registro, "escribir el informe", () => escribirInforme(carpeta));
    const carga = registro.entradas.filter(e => e.fase === "carga");
    console.log(`\nResultado: ${carga.filter(e => e.ok).length} de ${carga.length} peticiones de la carga bien${ctx.estado.error ? ` · se paró: ${ctx.estado.error}` : ""}`);
    const porPaso = resumen?.porPaso ?? {};
    if (porPaso.tursoFilasEscritas != null) console.log(`Turso: ${porPaso.tursoFilasLeidas.toFixed(1)} filas leídas y ${porPaso.tursoFilasEscritas.toFixed(1)} escritas por paso de la carga`);
    if (destino === "nube") console.log(ctx.estado.retirado ? "Limpieza: negocio retirado." : `Limpieza: ${ctx.estado.motivoSinRetirar ?? "sin retirar."}`);
    console.log(`Informe: ${relative(RAIZ, join(carpeta, "informe.md"))}\n`);
    const sinLimpiar = destino === "nube" && ctx.estado.licenseId && !a.sinRetirar && !ctx.estado.retirado;
    process.exitCode = ctx.estado.error || sinLimpiar ? 1 : 0;
  }
}

async function remedir(directorio) {
  if (typeof directorio !== "string" || !directorio) throw new Error("Uso: pnpm carga --medir <carpeta de la tanda>");
  cargarDotEnv();
  const carpeta = resolve(directorio);
  const estado = JSON.parse(readFileSync(join(carpeta, "estado.json"), "utf8"));
  if (estado.destino !== "nube") throw new Error("Sólo se vuelve a medir una tanda en la nube.");
  if (!estado.tenantId || !estado.ventanas?.preparacion?.hasta) throw new Error("Esa tanda no llegó a montar el negocio: no hay nada que medir.");
  const entradas = readFileSync(join(carpeta, "peticiones.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const carga = entradas.filter(e => e.fase === "carga");
  const minimos = { http: carga.filter(e => e.http && e.actor !== "admin").length, escriturasHandy: carga.filter(e => e.tipo === "escritura" && e.ok).length };
  const rutaCoste = join(carpeta, "coste.json");
  const coste = existsSync(rutaCoste) ? JSON.parse(readFileSync(rutaCoste, "utf8")) : {};
  const cf = await prepararCloudflare();
  coste.cloudflare = cf.error ? { error: cf.error } : await medirCloudflare(cf, estado.ventanas, estado.tenantId, { minimos, maxMinutos: 3 });
  writeFileSync(rutaCoste, JSON.stringify(coste, null, 2));
  escribirInforme(carpeta);
  console.log(`Informe rehecho: ${relative(RAIZ, join(carpeta, "informe.md"))}`);
}

async function retirarSolo(a) {
  cargarDotEnv();
  const base = String(a.base ?? process.env.TPV_API_BASE ?? BASE_NUBE).replace(/\/$/, "");
  if (!process.env.ADMIN_API_TOKEN) throw new Error("Falta ADMIN_API_TOKEN en el .env de la raíz.");
  const carpeta = join(RAIZ, "target", "carga", `${sello()}-retirar`);
  mkdirSync(carpeta, { recursive: true });
  const registro = new Registro({ carpeta, tope: 100 });
  registro.fase = "limpieza";
  const admin = { base, token: process.env.ADMIN_API_TOKEN, registro };
  const vivas = await licenciasDePruebasVivas(admin);
  console.log(vivas.length ? `Licencias de pruebas sin anular en ${base}:` : `No hay licencias de pruebas sin anular en ${base}.`);
  for (const l of vivas) console.log(`  ${l.keyShort} · ${l.customerEmail ?? ""} · ${l.status} · negocio ${l.tenantId ?? "—"}`);
  if (!a.si) {
    console.log("\nLa retirada se lleva TODOS los negocios de pruebas, de quien sean. Para hacerla: pnpm carga --retirar --si");
    console.log("(Sin licencias vivas también sirve: reintenta las bases que una retirada anterior no pudo borrar.)");
    return;
  }
  const r = await retirarPruebas(admin);
  console.log(`Retirados ${r.negocios} negocios${r.fallos.length ? `; quedan fallos: ${JSON.stringify(r.fallos)}` : "."}`);
  if (r.fallos.length) process.exitCode = 1;
}

const a = argumentos(process.argv.slice(2));
try {
  if (a.local && a.nube) throw new Error("Elige --local o --nube, no los dos.");
  if (a.medir) await remedir(a.medir);
  else if (a.retirar) await retirarSolo(a);
  else if (a.local || a.nube) await tanda(a);
  else console.log(AYUDA);
} catch (e) {
  console.error(`\n  ✖ ${e.message}\n`);
  process.exitCode = 1;
}
// Se sale a propósito: un socket cuyo cierre no contesta el TenantHub se queda «cerrándose» y
// mantendría vivo el proceso, y con él la conexión y el Durable Object despierto, facturando.
process.exit(process.exitCode ?? 0);
