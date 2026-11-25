// Cuánto ha gastado una tanda contra la nube, por la API GraphQL de analítica de Cloudflare con la
// sesión de wrangler de este equipo (no se crea ningún token, y el de la sesión no se imprime ni se
// guarda): el worker y los dos Durable Objects por los que pasa la tanda, el TenantHub del negocio y
// la base central (`BaseCentral`), cada uno con su duración y las filas que lee y escribe su SQLite.
//
// Las cuotas incluidas son las publicadas el 2026-11-10. Las de los Durable Objects son de toda la
// cuenta: las gastan juntos los TenantHub, la base central y las agendas de las reservas web.
// - Workers Paid: https://developers.cloudflare.com/workers/platform/pricing/
// - Durable Objects: https://developers.cloudflare.com/durable-objects/platform/pricing/

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const WORKER = join(RAIZ, "apps/cloud-worker-licensing");
const WRANGLER = join(WORKER, "node_modules/wrangler/bin/wrangler.js");

export const INCLUIDO = {
  workerPeticiones: 10_000_000,
  workerCpuMs: 30_000_000,
  doPeticiones: 1_000_000,
  doGbs: 400_000,
  doFilasLeidas: 25_000_000_000,
  doFilasEscritas: 50_000_000,
};

/** Duerme a trozos de un segundo para que Ctrl+C no tenga que esperar a que acabe. */
export async function esperarSalvoCancelacion(ms, cancelado = () => false) {
  const fin = Date.now() + ms;
  while (Date.now() < fin && !cancelado()) await dormir(Math.min(1000, fin - Date.now()));
}

/* ===== Cloudflare ===== */

/**
 * El token OAuth de la sesión de wrangler (`wrangler auth token --json`), o null si no hay sesión.
 * `WRANGLER_WRITE_LOGS=false`: si no, wrangler copia su salida, con el token, a su fichero de log.
 */
function tokenDeWrangler() {
  const r = spawnSync(process.execPath, [WRANGLER, "auth", "token", "--json"], {
    cwd: WORKER,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" },
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const json = r.stdout.match(/\{[\s\S]*\}/)?.[0];
  try {
    return JSON.parse(json).token ?? null;
  } catch {
    return null;
  }
}

async function api(token, ruta) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${ruta}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) throw new Error(`Cloudflare ${ruta}: HTTP ${r.status} ${j?.errors?.map(e => e.message).join("; ") ?? ""}`);
  return j.result;
}

async function graphql(token, query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.errors?.length) throw new Error(`GraphQL de Cloudflare: HTTP ${r.status} ${(j?.errors ?? []).map(e => e.message).join("; ")}`);
  return j.data.viewer.accounts[0];
}

/** La cuenta y los namespaces de `TenantHub` y `BaseCentral`. Devuelve `{ error }` si no se puede medir. */
export async function prepararCloudflare() {
  const token = tokenDeWrangler();
  if (!token) return { error: "No hay sesión de wrangler en este equipo (`pnpm exec wrangler login`)." };
  try {
    const cuentas = await api(token, "/accounts?per_page=50");
    const cuenta = process.env.CLOUDFLARE_ACCOUNT_ID ?? (cuentas.length === 1 ? cuentas[0].id : null);
    if (!cuenta) return { error: "La sesión ve varias cuentas: indica cuál con CLOUDFLARE_ACCOUNT_ID." };
    const namespaces = await api(token, `/accounts/${cuenta}/workers/durable_objects/namespaces?per_page=1000`);
    const delWorker = clase => namespaces.find(n => n.class === clase && n.script === "tpv-api")?.id;
    const hub = delWorker("TenantHub");
    const central = delWorker("BaseCentral");
    if (!hub) return { error: "No se encuentra el namespace de TenantHub del worker tpv-api." };
    if (!central) return { error: "No se encuentra el namespace de BaseCentral del worker tpv-api." };
    return { token, cuenta, namespace: hub, namespaceCentral: central };
  } catch (e) {
    return { error: e.message };
  }
}

// La base central es un solo objeto: su namespace entero es ella.
const CONSULTA = `
query Carga($cuenta: string!, $desde: Time!, $hasta: Time!, $ns: string!, $nsCentral: string!, $negocio: string!) {
  viewer { accounts(filter: { accountTag: $cuenta }) {
    worker: workersInvocationsAdaptive(limit: 100, filter: { scriptName: "tpv-api", datetime_geq: $desde, datetime_lt: $hasta }) {
      dimensions { eventType }
      sum { requests errors subrequests cpuTimeUs }
    }
    subpeticiones: workersSubrequestsAdaptiveGroups(limit: 100, filter: { scriptName: "tpv-api", datetime_geq: $desde, datetime_lt: $hasta }) {
      dimensions { hostname }
      sum { subrequests }
    }
    doNegocio: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: "tpv-api", namespaceId: $ns, name: $negocio, datetime_geq: $desde, datetime_lt: $hasta }) {
      dimensions { type }
      sum { requests errors }
    }
    doTodos: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: "tpv-api", namespaceId: $ns, datetime_geq: $desde, datetime_lt: $hasta }) {
      dimensions { type }
      sum { requests errors }
    }
    doPeriodicoNegocio: durableObjectsPeriodicGroups(limit: 100, filter: { namespaceId: $ns, name: $negocio, datetime_geq: $desde, datetime_lt: $hasta }) {
      sum { activeTime cpuTime duration rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount subrequests }
    }
    doPeriodicoTodos: durableObjectsPeriodicGroups(limit: 100, filter: { namespaceId: $ns, datetime_geq: $desde, datetime_lt: $hasta }) {
      sum { activeTime cpuTime duration rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount subrequests }
    }
    central: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: "tpv-api", namespaceId: $nsCentral, datetime_geq: $desde, datetime_lt: $hasta }) {
      dimensions { type }
      sum { requests errors }
    }
    centralPeriodico: durableObjectsPeriodicGroups(limit: 100, filter: { namespaceId: $nsCentral, datetime_geq: $desde, datetime_lt: $hasta }) {
      sum { activeTime cpuTime duration rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount subrequests }
    }
  } }
}`;

const sumar = (filas, campo) => filas.reduce((n, f) => n + (f.sum?.[campo] ?? 0), 0);
/** Por dimensión y con las claves ordenadas: dos lecturas iguales tienen que dar el mismo JSON. */
const porDimension = (filas, dimension, campo) =>
  Object.fromEntries(
    filas
      .map(f => [f.dimensions?.[dimension] ?? "?", f.sum?.[campo] ?? 0])
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );

function durableObject(invocaciones, periodicas) {
  return {
    invocaciones: sumar(invocaciones, "requests"),
    porTipo: porDimension(invocaciones, "type", "requests"),
    activoMs: Math.round(sumar(periodicas, "activeTime") / 1000),
    cpuMs: Math.round(sumar(periodicas, "cpuTime") / 1000),
    gbs: Number(sumar(periodicas, "duration").toFixed(3)),
    filasLeidas: sumar(periodicas, "rowsRead"),
    filasEscritas: sumar(periodicas, "rowsWritten"),
  };
}

async function medirVentana(cf, { desde, hasta }, tenantId) {
  const d = await graphql(cf.token, CONSULTA, {
    cuenta: cf.cuenta,
    desde,
    hasta,
    ns: cf.namespace,
    nsCentral: cf.namespaceCentral,
    negocio: tenantId ?? "-",
  });
  // El dataset del worker recoge todo lo que ejecuta el script, también las invocaciones de los
  // Durable Objects (rpc, websocket, alarm). Lo que se factura como petición del worker es `fetch`.
  const fetch = d.worker.filter(f => f.dimensions?.eventType === "fetch");
  return {
    desde,
    hasta,
    worker: {
      porTipo: porDimension(d.worker, "eventType", "requests"),
      cpuMsPorTipo: Object.fromEntries(Object.entries(porDimension(d.worker, "eventType", "cpuTimeUs")).map(([k, us]) => [k, Math.round(us / 1000)])),
      fetch: sumar(fetch, "requests"),
      cpuMsFetch: Math.round(sumar(fetch, "cpuTimeUs") / 1000),
      errores: sumar(d.worker, "errors"),
    },
    subpeticionesPorDestino: porDimension(d.subpeticiones, "hostname", "subrequests"),
    doNegocio: durableObject(d.doNegocio, d.doPeriodicoNegocio),
    doTodos: durableObject(d.doTodos, d.doPeriodicoTodos),
    // Compartida con los equipos de verdad: lo de la ventana lleva lo que hicieran ellos.
    central: durableObject(d.central, d.centralPeriodico),
  };
}

/** Redondea al minuto: los datos periódicos de los Durable Objects van por minuto. */
const aMinuto = (iso, arriba) => {
  const t = Date.parse(iso);
  return new Date((arriba ? Math.ceil(t / 60_000) : Math.floor(t / 60_000)) * 60_000).toISOString();
};

/**
 * Mide las ventanas de la tanda —preparación, carga y cierre de los sockets, cada una en sus propios
 * minutos— y una de control del mismo tamaño justo antes de empezar (lo que hace el worker sin la
 * prueba: la sonda de `/health`, los equipos de verdad). Los datos de Cloudflare tardan en asentarse
 * y cada dataset a su ritmo: se espera un rato, y se da por bueno cuando dos lecturas seguidas
 * coinciden Y la carga ya recoge al menos lo que el generador sabe que mandó (`minimos`).
 */
export async function medirCloudflare(cf, ventanas, tenantId, { minimos = {}, esperaInicialMs = 0, maxMinutos = 10, cancelado = () => false } = {}) {
  const ventana = v => (v?.desde && v?.hasta ? { desde: aMinuto(v.desde, false), hasta: aMinuto(v.hasta, true) } : null);
  const prep = ventana(ventanas.preparacion);
  const carga = ventana(ventanas.carga);
  const cierre = ventana(ventanas.cierre);
  // Los minutos enteros entre la preparación y la carga: la sesión abierta y sin tráfico (los pings
  // los contesta el edge). Es lo que cuesta un bar con la Main conectada y nadie tocando nada.
  const ociosa = prep && carga && Date.parse(carga.desde) - Date.parse(prep.hasta) >= 60_000 ? { desde: prep.hasta, hasta: carga.desde } : null;
  const largo = carga ? Date.parse(carga.hasta) - Date.parse(carga.desde) : 60_000;
  // El control acaba antes de la primera petición de la tanda, comprobaciones previas incluidas.
  const inicio = aMinuto(ventanas.inicio ?? ventanas.preparacion.desde, false);
  const control = { desde: new Date(Date.parse(inicio) - largo).toISOString(), hasta: inicio };

  if (esperaInicialMs > 0) {
    console.log(`  · Cloudflare: se espera ${Math.round(esperaInicialMs / 1000)} s a que lleguen los datos`);
    await esperarSalvoCancelacion(esperaInicialMs, cancelado);
  }
  let anterior = null;
  let medida = null;
  for (let lectura = 1; lectura <= maxMinutos && !cancelado(); lectura++) {
    medida = {
      preparacion: prep ? await medirVentana(cf, prep, tenantId) : null,
      ociosa: ociosa ? await medirVentana(cf, ociosa, tenantId) : null,
      carga: carga ? await medirVentana(cf, carga, tenantId) : null,
      cierre: cierre ? await medirVentana(cf, cierre, tenantId) : null,
      control: await medirVentana(cf, control, tenantId),
    };
    // Si el filtro por nombre del DO no casa (no rellena `name`), se usa el de todos los TenantHub.
    medida.filtroPorNegocio = (medida.carga?.doNegocio.invocaciones ?? 0) > 0;
    const doCarga = medida.filtroPorNegocio ? medida.carga?.doNegocio : medida.carga?.doTodos;
    // El GraphQL no cuadra al uno con lo que manda el generador (en la primera tanda contó 26 de 27
    // peticiones): basta con que recoja casi todas.
    const completa =
      !carga ||
      (medida.carga.worker.fetch >= Math.floor((minimos.http ?? 0) * 0.9) &&
        (doCarga?.invocaciones ?? 0) >= (minimos.escriturasHandy ?? 0) &&
        (doCarga?.activoMs ?? 0) > 0);
    const huella = JSON.stringify(medida);
    if (completa && huella === anterior) return { ...medida, asentado: true, lecturas: lectura };
    anterior = huella;
    if (lectura < maxMinutos) {
      console.log(`  · Cloudflare: lectura ${lectura}${completa ? "" : " (aún incompleta)"}; se repite en 60 s`);
      await esperarSalvoCancelacion(60_000, cancelado);
    }
  }
  return medida ? { ...medida, asentado: false, lecturas: maxMinutos } : null;
}
