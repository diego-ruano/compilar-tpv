// Un equipo sintético (Main o Handy) contra el worker: peticiones firmadas como las de la app y su
// WebSocket con el TenantHub. Copia lo que hacen `crates/tpv-infra-http/src/client.rs`,
// `crates/tpv-infra-licensing`, `websocket.rs` y, para la subida de la Main por lotes,
// `crates/tpv-application/src/use_cases/replicacion.rs`: si cambian, esto deja de funcionar a la
// primera (401, `unknown_type`), y el freno del registro corta la tanda.

import { performance } from "node:perf_hooks";
import { setTimeout as dormir } from "node:timers/promises";

import { horaLocal, mensajeDeviceProof, mensajeSaludo, nuevoId } from "./firma.mjs";
import { FrenoDeSeguridad } from "./registro.mjs";

/** `X-TPV-Version`: sólo etiqueta Sentry, y así lo que mande el generador se reconoce. */
const VERSION_CARGA = "0.0.0-carga";

/** El ping que contesta el edge sin despertar al DO: cualquier otro texto lo despierta y se paga. */
const PING = '{"type":"ping"}';

/**
 * Lo que la Main sube de una vez (`replicacion.rs::cortar`): hasta 200 operaciones y 256 KB de
 * sentencias, contados en bytes de UTF-8; una operación mayor va sola. El TenantHub aplica hasta 512 KB.
 */
export const LOTE_MAX_OPS = 200;
export const LOTE_MAX_BYTES = 256 * 1024;
/** Lo que la Main espera el acuse de un lote (`ESPERA_DEL_LOTE`). */
const ESPERA_DEL_LOTE_MS = 30_000;
/** Reenvíos seguidos sin aplicar nada (pasajeros o sin intentar) antes de dar la subida por atascada. */
const REENVIOS_SIN_AVANCE = 3;
/** Lo que se espera antes de reenviar tras un rechazo pasajero: la Main espera a su vuelta siguiente (3 s). */
const ESPERA_TRAS_PASAJERO_MS = 1000;

/** Una operación del lote tal como la manda la Main (`replicacion.rs::operacion`). */
export function operacionDeLote(op) {
  return {
    opId: op.opId,
    commandName: op.commandName,
    command: {
      type: "tenantDb.transaction",
      payload: { steps: op.sentencias.map(s => ({ kind: "execute", sql: s.sql, args: s.args })) },
    },
  };
}

/** Lo que pesan las sentencias de una operación, como las mide la Main: su JSON en bytes de UTF-8. */
export function bytesDeSentencias(op) {
  return Buffer.byteLength(JSON.stringify(op.sentencias.map(s => ({ sql: s.sql, args: s.args }))));
}

/**
 * El principio de lo pendiente que cabe en un lote, como `replicacion.rs::cortar`: hasta `maxOps`
 * operaciones y `maxBytes` de sentencias, y una al menos.
 *
 * @param {{ op: { opId: string, sentencias: { sql: string, args: unknown[] }[] } }[]} pendientes
 */
export function cortarLote(pendientes, { maxOps = LOTE_MAX_OPS, maxBytes = LOTE_MAX_BYTES } = {}) {
  const lote = [];
  let bytes = 0;
  for (const p of pendientes) {
    if (lote.length >= maxOps) break;
    const n = bytesDeSentencias(p.op);
    if (lote.length && bytes + n > maxBytes) break;
    bytes += n;
    lote.push(p);
  }
  return lote;
}

const cierto = (v, campo) => v?.[campo] === true;

/**
 * Lo que dice el acuse de un lote, leído como `replicacion.rs::tras_el_acuse`, en el orden del lote:
 *
 * - `entero`: la nube rechazó el lote entero (`ok: false`) y no aplicó nada.
 * - `aplicadas`: con su `Seq` (y `yaEstaba` si era el reenvío de algo ya confirmado).
 * - `rechazadas`: con su error y su clase. Tras una permanente se sigue leyendo (la nube siguió
 *   aplicando lo de detrás); tras cualquier otra, no.
 * - `parada`: por qué se dejó de leer antes del final (`noIntentada`, `transitorio`, `sinVeredicto`,
 *   `rechazo`), o `null`. Lo que no está en `aplicadas` ni en `rechazadas` no se ha aplicado y se
 *   vuelve a mandar.
 *
 * @param {{ opId: string }[]} opIds  las operaciones del lote, en orden
 */
export function leerAcuse(opIds, acuse) {
  const lectura = { entero: null, aplicadas: [], rechazadas: [], noIntentadas: 0, sinVeredicto: 0, parada: null };
  if (!cierto(acuse, "ok")) {
    lectura.entero = { error: String(acuse?.error ?? "sin_error"), transitorio: cierto(acuse, "transitorio"), permanente: cierto(acuse, "permanente") };
    return lectura;
  }
  if (!Array.isArray(acuse.resultados)) {
    lectura.entero = { error: "Acuse de lote sin veredictos", transitorio: false, permanente: false };
    return lectura;
  }
  const veredictos = new Map(acuse.resultados.filter(r => typeof r?.opId === "string").map(r => [r.opId, r]));
  // Los que vienen sin intentar o sin veredicto, aunque no se lean: para el registro.
  for (const { opId } of opIds) {
    const v = veredictos.get(opId);
    if (!v) lectura.sinVeredicto += 1;
    else if (cierto(v, "noIntentada")) lectura.noIntentadas += 1;
  }
  for (const { opId } of opIds) {
    const v = veredictos.get(opId);
    if (!v) {
      lectura.parada = "sinVeredicto";
      break;
    }
    if (cierto(v, "ok")) {
      lectura.aplicadas.push({ opId, seq: Number(v.seq ?? 0), yaEstaba: cierto(v, "yaEstaba") });
      continue;
    }
    if (cierto(v, "noIntentada")) {
      lectura.parada = "noIntentada";
      break;
    }
    if (cierto(v, "transitorio")) {
      lectura.parada = "transitorio";
      break;
    }
    const permanente = cierto(v, "permanente");
    lectura.rechazadas.push({ opId, error: String(v.error ?? "sin_error"), permanente });
    if (!permanente) {
      lectura.parada = "rechazo";
      break;
    }
  }
  return lectura;
}

export class Equipo {
  /**
   * @param {object} o
   * @param {string} o.nombre     "main", "handy" o "anonimo" en el registro
   * @param {"main"|"handy"} o.rol
   * @param {string} o.base       URL del worker
   * @param {ReturnType<import("./firma.mjs").nuevaIdentidad>} o.identidad
   * @param {import("./registro.mjs").Registro} o.registro
   */
  constructor({ nombre, rol, base, identidad, registro }) {
    this.nombre = nombre;
    this.rol = rol;
    this.base = base;
    this.identidad = identidad;
    this.registro = registro;
    this.variante = rol === "handy" ? "android" : "windows-modern";
    this.token = null;
    this.tenantId = null;
    this.desfaseMs = 0;
  }

  /** Un sello de tiempo con el desfase ya corregido, como `reloj.rs`. */
  ahoraMs() {
    return Date.now() + this.desfaseMs;
  }

  /**
   * Una petición como las de la app.
   *
   * @param {string} metodo
   * @param {string} ruta              con la query ya codificada
   * @param {object} [o]
   * @param {unknown} [o.cuerpo]       se serializa UNA vez: lo firmado es lo enviado
   * @param {boolean} [o.firmada]      Bearer + device-proof (las de alta y emparejamiento no lo llevan)
   * @param {boolean} [o.escritura]    lleva `x-idempotency-key`, como las escrituras de la Handy
   * @param {boolean} [o.horaCliente]  `x-client-now`; la app la manda en todo salvo licencia y telemetría
   * @param {string} [o.tipo]          para el informe: lectura, escritura, main-rest…
   * @param {string} [o.plantilla]     la ruta sin ids, para agrupar
   * @param {number} [o.timeoutMs]
   */
  async pedir(metodo, ruta, o = {}) {
    const opciones = { firmada: true, escritura: false, horaCliente: true, tipo: "otro", plantilla: ruta, timeoutMs: 30_000, ...o };
    // Una sola clave por escritura: si hay que repetirla, se repite con la misma (RI-64).
    opciones.clave = opciones.escritura ? nuevoId() : null;
    const r = await this.#enviar(metodo, ruta, { ...opciones, puedeRepetir: opciones.firmada });
    if (r.status === 401 && r.error === "device_ts_out_of_range" && r.fechaServidor) {
      this.desfaseMs = r.fechaServidor - Date.now();
      this.registro.avisar(`El reloj de este equipo difiere ${Math.round(this.desfaseMs / 1000)} s del worker: se corrige y se repite.`);
      return this.#enviar(metodo, ruta, { ...opciones, puedeRepetir: false });
    }
    return r;
  }

  async #enviar(metodo, ruta, o) {
    this.registro.comprobarTope();
    const url = new URL(ruta, this.base);
    const texto = o.cuerpo === undefined ? "" : JSON.stringify(o.cuerpo);
    const cabeceras = { "x-tpv-version": VERSION_CARGA, "x-tpv-variant": this.variante };
    if (o.firmada || o.firmaSinToken) {
      // AUD-01: activar se firma antes de tener token; su tramo es el hash de la cadena vacía.
      const ts = this.ahoraMs();
      const token = o.firmaSinToken ? "" : this.token;
      if (!o.firmaSinToken) cabeceras.authorization = `Bearer ${this.token}`;
      cabeceras["x-device-ts"] = String(ts);
      cabeceras["x-device-sig"] = this.identidad.firmar(mensajeDeviceProof(ts, metodo, url.pathname + url.search, token, texto));
    }
    if (o.horaCliente) cabeceras["x-client-now"] = horaLocal();
    if (o.clave) cabeceras["x-idempotency-key"] = o.clave;
    if (o.cuerpo !== undefined) cabeceras["content-type"] = "application/json";

    const inicio = new Date();
    const t0 = performance.now();
    let status = 0;
    let datos = null;
    let recibidos = 0;
    let error = null;
    let fechaServidor = null;
    let tiempos = null;
    // El centro de Cloudflare que atendió (el final de `cf-ray`): lo decide la ruta del proveedor y
    // cambia entre tandas, e incluso dentro de una. Sin él no se pueden comparar dos tandas.
    let atendio = null;
    try {
      const res = await fetch(url, {
        method: metodo,
        headers: cabeceras,
        body: o.cuerpo === undefined ? undefined : texto,
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      status = res.status;
      const textoRespuesta = await res.text();
      recibidos = Buffer.byteLength(textoRespuesta);
      try {
        datos = JSON.parse(textoRespuesta);
      } catch {
        datos = null;
      }
      const fecha = Date.parse(res.headers.get("date") ?? "");
      if (Number.isFinite(fecha)) fechaServidor = fecha;
      tiempos = leerServerTiming(res.headers.get("server-timing"));
      atendio = res.headers.get("cf-ray")?.split("-").pop() ?? null;
      if (!res.ok || datos?.ok === false) error = String(datos?.error ?? datos?.code ?? `http_${status}`);
    } catch (e) {
      error = e?.name === "TimeoutError" ? "timeout" : `red: ${e?.cause?.code ?? e?.message ?? e}`;
    }
    const ms = performance.now() - t0;
    const ok = status >= 200 && status < 300 && datos?.ok !== false;
    this.registro.anotar({
      http: true,
      actor: this.nombre,
      tipo: o.tipo,
      metodo,
      ruta: o.plantilla,
      status,
      ok,
      error,
      ms: Math.round(ms),
      enviados: Buffer.byteLength(texto),
      recibidos,
      inicio: inicio.toISOString(),
      seReintenta: o.puedeRepetir && status === 401 && error === "device_ts_out_of_range",
      ...(tiempos ? { tiempos } : {}),
      ...(atendio ? { atendio } : {}),
    });
    return { status, ok, datos, error, ms, fechaServidor };
  }
}

/**
 * El desglose que manda el worker (`observability/tiempos.ts`), sólo a un dispositivo autenticado
 * (las de alta y emparejamiento salen sin él):
 * `central;dur=12;desc="2", hub-lee;dur=8;desc="1", total;dur=25, colo;desc="CDG"` →
 * `{ central: { ms: 12, n: 2 }, "hub-lee": { ms: 8, n: 1 }, total: { ms: 25 }, colo: "CDG" }`.
 */
export function leerServerTiming(cabecera) {
  if (!cabecera) return null;
  const salida = {};
  for (const parte of cabecera.split(",")) {
    const [nombre, ...atributos] = parte.trim().split(";");
    const attrs = Object.fromEntries(atributos.map(a => a.split("=")).map(([k, v]) => [k.trim(), (v ?? "").trim().replace(/^"|"$/g, "")]));
    if (nombre === "colo") salida.colo = attrs.desc;
    else salida[nombre] = { ms: Number(attrs.dur), ...(attrs.desc ? { n: Number(attrs.desc) } : {}) };
  }
  return salida;
}

/** Una petición de administración (`/v1/admin/*`). El token nunca sale del proceso. */
export async function pedirAdmin({ base, token, registro }, metodo, ruta, cuerpo) {
  registro.comprobarTope();
  const texto = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
  const t0 = performance.now();
  const inicio = new Date();
  let status = 0;
  let datos = null;
  let error = null;
  try {
    const res = await fetch(new URL(ruta, base), {
      method: metodo,
      headers: { authorization: `Bearer ${token}`, ...(texto ? { "content-type": "application/json" } : {}) },
      body: texto,
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    datos = await res.json().catch(() => null);
    if (!res.ok || datos?.ok === false) error = String(datos?.error ?? `http_${status}`);
  } catch (e) {
    error = e?.name === "TimeoutError" ? "timeout" : `red: ${e?.cause?.code ?? e?.message ?? e}`;
  }
  registro.anotar({
    http: true,
    actor: "admin",
    tipo: "admin",
    metodo,
    ruta: ruta.split("?")[0],
    status,
    ok: status >= 200 && status < 300 && datos?.ok !== false,
    error,
    ms: Math.round(performance.now() - t0),
    enviados: texto ? Buffer.byteLength(texto) : 0,
    recibidos: 0,
    inicio: inicio.toISOString(),
  });
  return { status, ok: status >= 200 && status < 300 && datos?.ok !== false, datos, error };
}

/**
 * El WebSocket de un equipo con el TenantHub de su negocio (`/v1/ws/ticket` + `/ws`), con el saludo
 * firmado y el latido de la app. La Main lo usa además para subir sus operaciones (`apply_lote`).
 */
export class Socket {
  constructor(equipo) {
    this.equipo = equipo;
    this.registro = equipo.registro;
    this.esperas = [];
    this.cierre = null;
    this.maxSeq = 0;
    this.volcando = false;
    this.cerrando = false;
    /** Los lotes que ha mandado esta sesión: con él se nombra cada uno, como `Sesion::lotes`. */
    this.lotes = 0;
    /** Lo que la nube ha confirmado de lo que subió este equipo: opId → { seq, plantilla }. */
    this.confirmadas = new Map();
    /** Los `change` recibidos, por opId: para comprobar que cada cambio llega una vez. */
    this.cambios = new Map();
  }

  async abrir() {
    const { equipo, registro } = this;
    const ticket = await equipo.pedir("POST", "/v1/ws/ticket", { cuerpo: {}, tipo: "socket" });
    if (!ticket.ok) throw new Error(`No se pudo pedir el ticket del socket de la ${equipo.rol}: ${ticket.status} ${ticket.error}`);

    registro.comprobarTope();
    const url = `${equipo.base.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket.datos.ticket)}`;
    const inicio = new Date();
    const t0 = performance.now();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("message", ev => this.#recibir(ev.data));
    this.cerrado = new Promise(resolver => {
      ws.addEventListener(
        "close",
        ev => {
          this.cierre = { code: ev.code, reason: ev.reason };
          clearInterval(this.latido);
          for (const e of this.esperas.splice(0)) e.rechazar(new Error(`El socket de la ${equipo.rol} se cerró (${ev.code} ${ev.reason || "sin motivo"})`));
          if (!this.cerrando) registro.avisar(`El socket de la ${equipo.rol} se cerró sin pedirlo (${ev.code} ${ev.reason || "sin motivo"}).`);
          resolver(this.cierre);
        },
        { once: true },
      );
    });
    // El reto llega nada más abrir: la espera se apunta antes.
    const reto = this.esperar(m => m.type === "challenge" || m.type === "error", 20_000);
    // Un upgrade que no contesta esperaría los 300 s de undici: a los 20 s se da por rechazado.
    const abierto = await Promise.race([
      new Promise(resolver => {
        ws.addEventListener("open", () => resolver(true), { once: true });
        ws.addEventListener("error", () => resolver(false), { once: true });
      }),
      dormir(20_000, false, { ref: false }),
    ]);
    if (!abierto) {
      this.cerrando = true;
      ws.close();
    }
    registro.anotar({
      http: true,
      actor: equipo.nombre,
      tipo: "socket",
      metodo: "GET",
      ruta: "/ws",
      status: abierto ? 101 : 0,
      ok: abierto,
      error: abierto ? null : "upgrade_rechazado",
      ms: Math.round(performance.now() - t0),
      enviados: 0,
      recibidos: 0,
      inicio: inicio.toISOString(),
    });
    if (!abierto) throw new Error(`El worker rechazó el socket de la ${equipo.rol}.`);

    const desafio = await reto;
    if (desafio.type !== "challenge") throw new Error(`El socket de la ${equipo.rol} no mandó el reto: ${desafio.error}`);

    const ts = equipo.ahoraMs();
    const t1 = performance.now();
    const hola = this.esperar(m => m.type === "hello_ok" || m.type === "error", 20_000);
    const estado = this.esperar(m => m.type === "main_status", 20_000);
    const firma = equipo.identidad.firmar(mensajeSaludo(equipo.rol, ts, equipo.tenantId, equipo.identidad.deviceId, desafio.nonceB64));
    // AUD-15: la Main saluda siempre en recuperación —congela a las Handy— y las suelta con
    // `recovery_ready` (ver `listo()`) cuando ha subido lo pendiente, como `replicacion::saludar`.
    const esMain = equipo.rol === "main";
    this.enviar({ type: "helloSigned", ts, sigB64: firma, nonceB64: desafio.nonceB64, recovering: esMain });
    const respuesta = await hola;
    const saludado = respuesta.type === "hello_ok" && respuesta.authed === true;
    registro.anotar({
      http: false,
      actor: equipo.nombre,
      tipo: "socket",
      metodo: "WS",
      ruta: "helloSigned",
      status: saludado ? 200 : 401,
      ok: saludado,
      error: saludado ? null : String(respuesta.details ?? respuesta.error ?? "hello_failed"),
      ms: Math.round(performance.now() - t1),
      enviados: 0,
      recibidos: 0,
      inicio: new Date().toISOString(),
    });
    const s = await estado;
    this.volcando = s.volcando === true;
    // La Main se ve a sí misma volcando hasta su `recovery_ready`; la Handy tiene que encontrarla lista.
    if (s.online !== true || (!esMain && s.volcando === true)) {
      throw new Error(`El TenantHub dice que la Main no está lista (online=${s.online}, volcando=${s.volcando}).`);
    }
    this.latido = setInterval(() => this.#latir(), 30_000);
  }

  /** La Main se da por puesta al día y suelta a las Handy (AUD-15), como hace `replicacion::ejecutar`. */
  async listo() {
    const t0 = performance.now();
    const ack = this.esperar(m => m.type === "recovery_ready_ack" || m.type === "error", 20_000);
    const texto = this.enviar({ type: "recovery_ready" });
    const respuesta = await ack;
    const ok = respuesta.type === "recovery_ready_ack";
    this.registro.anotar({
      http: false,
      actor: this.equipo.nombre,
      tipo: "socket",
      metodo: "WS",
      ruta: "recovery_ready",
      status: ok ? 200 : 400,
      ok,
      error: ok ? null : String(respuesta.error),
      ms: Math.round(performance.now() - t0),
      enviados: Buffer.byteLength(texto),
      recibidos: 0,
      inicio: new Date().toISOString(),
    });
    if (!ok) throw new Error(`El TenantHub no aceptó recovery_ready: ${respuesta.error}`);
    this.volcando = false;
  }

  /**
   * Espera un mensaje que cumpla `filtro`. Las esperas se apuntan ANTES de mandar lo que las provoca,
   * así que alguna puede quedar sin nadie que la espere (el socket no llegó a abrir, el envío lanzó).
   * Se marca como atendida: quien hace `await` sigue recibiendo el rechazo, pero una espera abandonada
   * no tumba el proceso de Node antes de que la tanda retire su negocio.
   */
  esperar(filtro, ms) {
    const promesa = new Promise((resolver, rechazar) => {
      const espera = {
        filtro,
        resolver: m => {
          clearTimeout(t);
          resolver(m);
        },
        rechazar: e => {
          clearTimeout(t);
          rechazar(e);
        },
      };
      const t = setTimeout(() => {
        const i = this.esperas.indexOf(espera);
        if (i >= 0) this.esperas.splice(i, 1);
        rechazar(new Error(`El socket de la ${this.equipo.rol} no contestó en ${ms / 1000} s`));
      }, ms);
      this.esperas.push(espera);
    });
    promesa.catch(() => {});
    return promesa;
  }

  enviar(mensaje) {
    const texto = JSON.stringify(mensaje);
    this.registro.mensajeEnviado(false);
    this.ws.send(texto);
    return texto;
  }

  #latir() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.registro.mensajeEnviado(true);
    this.ws.send(PING);
  }

  #recibir(datos) {
    if (typeof datos !== "string") return;
    let m;
    try {
      m = JSON.parse(datos);
    } catch {
      return;
    }
    // Cuándo llegó: para medir lo que tarda un cambio de un equipo en verse en el otro.
    m.__t = performance.now();
    this.registro.mensajeRecibido(m.type ?? "?");
    if (m.type === "change" && Number.isFinite(m.seq)) this.maxSeq = Math.max(this.maxSeq, m.seq);
    if (m.type === "change" && typeof m.opId === "string") this.cambios.set(m.opId, (this.cambios.get(m.opId) ?? 0) + 1);
    if (m.type === "main_volcando") {
      this.volcando = m.volcando === true;
      if (this.volcando) this.registro.avisar("El TenantHub avisa de que la Main está volcando: las escrituras de la Handy se congelan.");
    }
    const i = this.esperas.findIndex(e => e.filtro(m));
    if (i >= 0) this.esperas.splice(i, 1)[0].resolver(m);
  }

  /**
   * Sube operaciones de la Main como `replicacion.rs::subir_pendientes`: en orden, por lotes
   * (`apply_lote`, hasta 200 operaciones y 256 KB de sentencias) y con un solo lote en vuelo. Lo que
   * la nube no llegó a aplicar (`noIntentada`, un rechazo pasajero, una operación de la que el acuse no
   * dice nada) se vuelve a mandar desde la primera sin aplicar.
   *
   * Un rechazo para la tanda: cada operación rechazada manda un evento a Sentry y otro a Axiom, y en
   * una carga no tiene que haber ninguno. Lo mismo un lote sin acuse o rechazado entero.
   *
   * Cada lote se anota (`main-lote`, con sus veredictos) y cada operación también (`main-ws`, con
   * su `Seq`, los lotes en que viajó y lo que tardó desde que salió la primera vez).
   *
   * @param {{ op: { opId: string, commandName: string, sentencias: { sql: string, args: unknown[] }[] }, plantilla: string }[]} entradas
   * @param {{ maxOps?: number, maxBytes?: number }} [limites]  para probar los topes del TenantHub
   * @returns {Promise<Map<string, { seq: number, yaEstaba: boolean }>>}
   */
  async subir(entradas, limites = {}) {
    const resueltas = new Map();
    const viaje = new Map(entradas.map(e => [e.op.opId, { t0: null, inicio: null, lotes: 0, ultimoLote: null }]));
    let pendientes = [...entradas];
    let sinAvance = 0;
    while (pendientes.length) {
      const lote = cortarLote(pendientes, limites);
      const r = await this.#mandarLote(lote);
      for (const e of lote) {
        const v = viaje.get(e.op.opId);
        v.t0 ??= r.t0;
        v.inicio ??= r.inicio;
        v.lotes += 1;
        v.ultimoLote = r.loteId;
      }
      const anotarOp = (e, campos) =>
        this.registro.anotar({
          http: false,
          actor: this.equipo.nombre,
          tipo: "main-ws",
          metodo: "WS",
          ruta: e.plantilla,
          enviados: Buffer.byteLength(JSON.stringify(operacionDeLote(e.op))),
          recibidos: 0,
          sentencias: e.op.sentencias.length,
          opId: e.op.opId,
          lotes: viaje.get(e.op.opId).lotes,
          loteId: viaje.get(e.op.opId).ultimoLote,
          ms: Math.round(performance.now() - viaje.get(e.op.opId).t0),
          inicio: viaje.get(e.op.opId).inicio,
          ...campos,
        });

      const { lectura } = r;
      const pasajero = lectura?.entero?.transitorio === true;
      if (!lectura || (lectura.entero && !pasajero)) {
        const motivo = r.error ?? lectura.entero.error;
        for (const e of lote) anotarOp(e, { status: r.acuse ? 400 : 0, ok: false, error: `lote: ${motivo}` });
        throw new FrenoDeSeguridad(`El TenantHub no aplicó el lote ${r.loteId} (${lote.length} operaciones): ${motivo}`);
      }

      const porId = new Map(lote.map(e => [e.op.opId, e]));
      for (const a of lectura.aplicadas) {
        resueltas.set(a.opId, { seq: a.seq, yaEstaba: a.yaEstaba });
        this.confirmadas.set(a.opId, { seq: a.seq, plantilla: porId.get(a.opId).plantilla });
        this.maxSeq = Math.max(this.maxSeq, a.seq);
        anotarOp(porId.get(a.opId), { status: 200, ok: true, error: null, seq: a.seq, ...(a.yaEstaba ? { yaEstaba: true } : {}) });
      }
      for (const x of lectura.rechazadas) {
        anotarOp(porId.get(x.opId), { status: 400, ok: false, error: x.error, permanente: x.permanente });
      }
      if (lectura.rechazadas.length) {
        const x = lectura.rechazadas[0];
        throw new FrenoDeSeguridad(`El TenantHub rechazó «${porId.get(x.opId).plantilla}»${x.permanente ? " (permanente)" : ""}: ${x.error}`);
      }

      pendientes = pendientes.filter(e => !resueltas.has(e.op.opId));
      if (lectura.aplicadas.length) {
        sinAvance = 0;
      } else if (++sinAvance > REENVIOS_SIN_AVANCE) {
        throw new FrenoDeSeguridad(`La subida no avanza: ${sinAvance} lotes seguidos sin aplicar nada (${lectura.entero?.error ?? lectura.parada}).`);
      }
      if (pendientes.length && (pasajero || lectura.parada === "transitorio")) await dormir(ESPERA_TRAS_PASAJERO_MS);
    }
    return resueltas;
  }

  /** Un `apply_lote` y su acuse. Lo que no sea el acuse de este lote o un `error` suelto no le responde. */
  async #mandarLote(lote) {
    this.lotes += 1;
    const loteId = `${this.lotes}-${lote[0].op.opId}`;
    const inicio = new Date().toISOString();
    const t0 = performance.now();
    const espera = this.esperar(m => (m.type === "apply_lote_ack" && m.loteId === loteId) || m.type === "error", ESPERA_DEL_LOTE_MS);
    const texto = this.enviar({ type: "apply_lote", loteId, ops: lote.map(e => operacionDeLote(e.op)) });
    let acuse = null;
    let error = null;
    try {
      const m = await espera;
      if (m.type === "apply_lote_ack") acuse = m;
      else error = String(m.error ?? "error");
    } catch (e) {
      error = e.message;
    }
    const ms = performance.now() - t0;
    const lectura = acuse ? leerAcuse(lote.map(e => e.op), acuse) : null;
    const ok = Boolean(lectura && !lectura.entero && !lectura.rechazadas.length);
    this.registro.anotar({
      http: false,
      actor: this.equipo.nombre,
      tipo: "main-lote",
      metodo: "WS",
      ruta: "apply_lote",
      status: ok ? 200 : acuse ? 400 : 0,
      ok,
      error: ok ? null : String(error ?? lectura?.entero?.error ?? lectura?.rechazadas[0]?.error ?? "sin_acuse"),
      ms: Math.round(ms),
      enviados: Buffer.byteLength(texto),
      recibidos: acuse ? Buffer.byteLength(JSON.stringify(acuse)) : 0,
      loteId,
      ops: lote.length,
      bytesSentencias: lote.reduce((n, e) => n + bytesDeSentencias(e.op), 0),
      aplicadas: lectura?.aplicadas.length ?? 0,
      yaEstaban: lectura?.aplicadas.filter(a => a.yaEstaba).length ?? 0,
      noIntentadas: lectura?.noIntentadas ?? 0,
      sinVeredicto: lectura?.sinVeredicto ?? 0,
      rechazadas: lectura?.rechazadas.length ?? 0,
      ...(lectura?.entero?.transitorio ? { pasajero: true } : {}),
      inicio,
    });
    return { loteId, acuse, lectura, error, t0, inicio };
  }

  async cerrar() {
    clearInterval(this.latido);
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) return this.cierre;
    this.cerrando = true;
    this.ws.close(1000, "fin");
    await Promise.race([this.cerrado, dormir(5000, undefined, { ref: false })]);
    return this.cierre;
  }
}
