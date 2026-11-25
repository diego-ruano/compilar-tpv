// El informe de una tanda, en `informe.md`. Se construye sólo con lo que la tanda dejó en su carpeta
// (estado.json, peticiones.jsonl, coste.json), así que `--medir` puede rehacerlo cuando los datos de
// Cloudflare terminan de asentarse.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { INCLUIDO } from "./coste.mjs";

const leer = (carpeta, fichero) => (existsSync(join(carpeta, fichero)) ? JSON.parse(readFileSync(join(carpeta, fichero), "utf8")) : null);
const n = (x, decimales = 0) => (x == null || Number.isNaN(x) ? "—" : Number(x).toLocaleString("es-ES", { maximumFractionDigits: decimales }));
const pct = (x, total) => (x == null || Number.isNaN(x) ? "sin medir" : `${(x / total * 100).toLocaleString("es-ES", { maximumFractionDigits: 4 })} %`);
const lista = objeto => Object.entries(objeto ?? {}).map(([k, c]) => `${k || "(sin nombre)"} ${c}`).join(", ") || "—";

function percentil(valores, q) {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.ceil(q * orden.length) - 1)];
}

function leerEntradas(carpeta) {
  const ruta = join(carpeta, "peticiones.jsonl");
  if (!existsSync(ruta)) return [];
  return readFileSync(ruta, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Los viajes a los Durable Objects que cuenta el propio worker en el `Server-Timing` de cada
 * respuesta a un dispositivo autenticado (`observability/tiempos.ts`): a la base central (`central`,
 * y `en-hub-central` los del TenantHub mientras atiende la ruta) y al TenantHub (`hub-*`). Cada
 * llamada a un Durable Object es una petición facturable.
 */
function viajesDe(entradas) {
  const v = { conDesglose: 0, central: 0, hub: 0 };
  for (const e of entradas) {
    if (!e.tiempos) continue;
    v.conDesglose += 1;
    for (const [nombre, tramo] of Object.entries(e.tiempos)) {
      const veces = Number(tramo?.n ?? 0);
      if (nombre === "central" || nombre === "en-hub-central") v.central += veces;
      else if (nombre.startsWith("hub-")) v.hub += veces;
    }
  }
  return v;
}

/**
 * Lo de la base central que es de la carga: lo de la ventana de la carga menos lo de la de control,
 * que es del mismo largo y acaba justo antes de la tanda. La central es una para todos los negocios,
 * y en esos minutos también la usan los equipos de verdad.
 */
function centralDeLaCarga(cf) {
  const carga = cf.carga?.central;
  const control = cf.control?.central;
  if (!carga || !control) return null;
  const menos = campo => Math.max(0, carga[campo] - control[campo]);
  return { invocaciones: menos("invocaciones"), filasLeidas: menos("filasLeidas"), filasEscritas: menos("filasEscritas") };
}

export function escribirInforme(carpeta) {
  const estado = leer(carpeta, "estado.json") ?? {};
  const entradas = leerEntradas(carpeta);
  const coste = leer(carpeta, "coste.json");
  const local = estado.destino === "local";

  const carga = entradas.filter(e => e.fase === "carga");
  const preparacion = entradas.filter(e => e.fase === "preparacion");
  const etapasCarga = [...new Set(carga.map(e => e.etapa))];
  const pasos = etapasCarga.length;
  const duracion = v => (v?.desde && v?.hasta ? (Date.parse(v.hasta) - Date.parse(v.desde)) / 1000 : null);
  const httpCarga = carga.filter(e => e.http && e.actor !== "admin").length;
  // Los mensajes que la Main manda por el socket y despiertan al DO: un `apply_lote` por lote. Las
  // operaciones y las propagaciones van anotadas aparte y no son mensajes.
  const wsCarga = carga.filter(e => e.tipo === "main-lote").length;
  const opsMainCarga = carga.filter(e => e.tipo === "main-ws").length;
  const escriturasHandy = carga.filter(e => e.tipo === "escritura" && e.ok).length;

  const l = [];
  l.push(`# Tanda de carga ${estado.tanda} · ${estado.destino}`, "");
  const bien = carga.filter(e => e.ok).length;
  l.push(estado.error ? `**Se paró:** ${estado.error}` : `**${bien} de ${carga.length} peticiones de la carga respondieron bien.**`, "");

  l.push("## Resumen", "", "| | |", "|---|---|");
  l.push(`| Destino | ${local ? "worker en este equipo (`wrangler dev`), con la base central y la del negocio en sus Durable Objects" : `worker desplegado (${estado.base})`} |`);
  l.push(`| Negocio de pruebas | \`${estado.tenantId ?? "—"}\` · licencia ${estado.claveCorta ?? "—"} |`);
  // Una operación de la Main viaja dentro de su lote: el mensaje es el lote.
  const mensajesWs = es => es.filter(e => e.metodo === "WS" && e.tipo !== "main-ws" && e.tipo !== "propagacion").length;
  l.push(`| Preparación | ${preparacion.filter(e => e.http).length} peticiones HTTP y ${mensajesWs(preparacion)} mensajes de socket · ${n(duracion(estado.ventanas?.preparacion), 1)} s |`);
  l.push(`| Carga | ${pasos} pasos a ${estado.ritmo}/s · ${n(duracion(estado.ventanas?.carga), 1)} s |`);
  if (estado.socket) {
    l.push(`| Sockets | ${estado.socket.enviados} mensajes enviados (sin contar ${estado.socket.pings} pings) · recibidos: ${lista(estado.socket.recibidos)} |`);
  }
  if (estado.destino === "nube") l.push(`| Limpieza | ${estado.retirado ? "negocio retirado (su base, su agenda y sus imágenes borradas, y la licencia anulada)" : "**sin retirar del todo**: ver «Limpieza»"} |`);
  l.push("");

  if (pasos) {
    l.push("## Las peticiones de la carga", "");
    l.push("| # | Paso | Tipo | Petición | Estado | ms | Viajes a la base central / al TenantHub |", "|---|---|---|---|---|---|---|");
    for (const e of carga) {
      const estadoTexto = e.ok ? String(e.status) : `${e.status ?? "—"} ✗ ${e.error ?? ""}`;
      const v = e.tiempos ? viajesDe([e]) : null;
      l.push(`| ${e.n} | ${e.etapa} | ${e.tipo} | ${e.metodo} ${e.ruta} | ${estadoTexto} | ${n(e.ms)} | ${v ? `${v.central} / ${v.hub}` : ""} |`);
    }
    l.push("");

    l.push("## Tiempos por tipo (carga)", "", "| Tipo | Peticiones | p50 ms | p95 ms | máx. ms |", "|---|---|---|---|---|");
    for (const tipo of [...new Set(carga.map(e => e.tipo))]) {
      const ms = carga.filter(e => e.tipo === tipo && e.ok).map(e => e.ms);
      l.push(`| ${tipo} | ${carga.filter(e => e.tipo === tipo).length} | ${n(percentil(ms, 0.5))} | ${n(percentil(ms, 0.95))} | ${n(ms.length ? Math.max(...ms) : null)} |`);
    }
    l.push("");
  } else {
    l.push("La carga no llegó a dar ningún paso: no hay coste por paso que calcular.", "");
  }

  // La subida de la Main: cada `apply_lote` con sus veredictos, y lo que dijo el log de la nube.
  const lotes = entradas.filter(e => e.tipo === "main-lote");
  if (lotes.length) {
    l.push("## La subida de la Main (`apply_lote`)", "");
    l.push("Un lote es un mensaje del socket con hasta 200 operaciones y 256 KB de sentencias; el TenantHub contesta con el veredicto de cada una. Lo que sale sin intentar se reenvía desde la primera sin aplicar.", "");
    l.push("| Fase | Lotes | Operaciones | Aplicadas | Ya estaban | Sin intentar | Rechazadas | Ops/lote máx. | KB de sentencias máx. | ms por lote p50 / p95 / máx. | ms por operación p50 / p95 |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const fase of [...new Set(lotes.map(e => e.fase))]) {
      const ls = lotes.filter(e => e.fase === fase);
      const ops = entradas.filter(e => e.fase === fase && e.tipo === "main-ws");
      const suma = campo => ls.reduce((t, e) => t + (e[campo] ?? 0), 0);
      const msLote = ls.map(e => e.ms);
      const msOp = ops.filter(e => e.ok).map(e => e.ms);
      l.push(
        `| ${fase} | ${ls.length} | ${ops.length} | ${suma("aplicadas")} | ${suma("yaEstaban")} | ${suma("noIntentadas")} | ${suma("rechazadas")} | ${Math.max(...ls.map(e => e.ops ?? 0))} | ${n(Math.max(...ls.map(e => e.bytesSentencias ?? 0)) / 1024, 1)} | ${n(percentil(msLote, 0.5))} / ${n(percentil(msLote, 0.95))} / ${n(Math.max(...msLote))} | ${n(percentil(msOp, 0.5))} / ${n(percentil(msOp, 0.95))} |`,
      );
    }
    l.push("");
    const s = estado.subida;
    if (s) {
      l.push(
        s.cuadra
          ? `Contrastado con el log de la nube (\`/v1/sync/changes\` desde 0): las ${s.operaciones} operaciones confirmadas están una vez cada una, con el \`Seq\` de su acuse; a la Handy le llegó el \`change\` de las ${s.handy.esperados} que subieron con ella conectada, una vez cada uno, y a la Main ninguno de los suyos.`
          : `**La subida no cuadra con el log de la nube:** ${JSON.stringify(s)}`,
        "",
      );
    } else {
      l.push("Sin contrastar con el log de la nube (la tanda se paró antes, o medía Cloudflare).", "");
    }
  }

  // Lo que cuesta un paso medio de la carga, con su fuente. De lo que gastan los Durable Objects se
  // guarda además cuánto es del negocio y cuánto de la base central.
  const porPaso = {};
  const fuente = {};
  const partes = {};
  const anotar = (clave, valor, de, desglose) => {
    if (pasos && valor != null && Number.isFinite(valor)) {
      porPaso[clave] = valor / pasos;
      fuente[clave] = de;
      if (desglose) partes[clave] = { negocio: desglose.negocio / pasos, central: desglose.central / pasos };
      else delete partes[clave];
    }
  };
  // Las peticiones al worker las cuenta el generador: cada HTTP que manda es una petición facturable.
  anotar("workerPeticiones", httpCarga, "contadas por el generador");

  l.push("## Coste", "");
  const viajesPrep = viajesDe(preparacion);
  const viajesCarga = viajesDe(carga);
  l.push("### Viajes a los Durable Objects (los cuenta el worker)", "");
  l.push(
    "El worker dice en el `Server-Timing` de cada respuesta a un dispositivo autenticado cuántas llamadas ha hecho a la base central (también las del TenantHub mientras atendía la ruta) y al TenantHub. Cada llamada a un Durable Object es una petición facturable. No salen aquí las peticiones sin autenticar (el alta y el emparejamiento) ni lo que llega por el socket (los lotes de la Main), que no lleva cabecera.",
    "",
  );
  l.push("| Fase | Peticiones con desglose | Viajes a la base central | Viajes al TenantHub |", "|---|---|---|---|");
  l.push(`| Preparación (alta, semilla, emparejamiento) | ${n(viajesPrep.conDesglose)} | ${n(viajesPrep.central)} | ${n(viajesPrep.hub)} |`);
  l.push(`| Carga | ${n(viajesCarga.conDesglose)} | ${n(viajesCarga.central)} | ${n(viajesCarga.hub)} |`);
  if (pasos) {
    // El tipo de un paso es el de su petición o su operación, no el del lote en que viajó ni el de la
    // propagación que se anota con él (como en la consola, `ejecutarPlan`).
    const tipoDelPaso = new Map();
    for (const e of carga) {
      const propio = e.tipo !== "main-lote" && e.tipo !== "propagacion";
      if (!tipoDelPaso.has(e.etapa) || (propio && !tipoDelPaso.get(e.etapa).propio)) tipoDelPaso.set(e.etapa, { tipo: e.tipo, propio });
    }
    l.push("", "Por tipo de paso de la carga (media de viajes por paso):", "", "| Tipo | Pasos | A la base central | Al TenantHub |", "|---|---|---|---|");
    for (const tipo of [...new Set([...tipoDelPaso.values()].map(t => t.tipo))]) {
      const etapas = new Set([...tipoDelPaso].filter(([, t]) => t.tipo === tipo).map(([etapa]) => etapa));
      const v = viajesDe(carga.filter(e => etapas.has(e.etapa)));
      l.push(`| ${tipo} | ${etapas.size} | ${n(v.central / etapas.size, 2)} | ${n(v.hub / etapas.size, 2)} |`);
    }
    // Lo que el TenantHub atiende de la carga: estos viajes y los lotes de la Main, que como mensajes
    // de socket se facturan a razón de 20:1.
    anotar("doPeticiones", viajesCarga.central + viajesCarga.hub + wsCarga / 20, "contadas por el worker (`Server-Timing`); los lotes de la Main, a 20:1", {
      negocio: viajesCarga.hub + wsCarga / 20,
      central: viajesCarga.central,
    });
  }
  l.push("");
  if (local) {
    l.push("En local hay un solo isolate, y sus cachés de 60 s hacen que la base central se lea mucho menos que en la nube. La duración de los Durable Objects y las filas que leen y escriben no tienen contadores en local: salen de una tanda en la nube.", "");
    l.push(`Las peticiones al worker de la carga son ${httpCarga}: las ${opsMainCarga} operaciones de la Main van en ${wsCarga} lotes por el socket abierto y no son peticiones.`, "");
  }

  const cf = coste?.cloudflare;
  if (cf?.error) l.push("### Cloudflare", "", `No se pudo medir: ${cf.error}`, "");
  else if (cf) {
    l.push("### Cloudflare (GraphQL de analítica)", "");
    if (!cf.asentado) l.push(`> Los datos aún no se habían asentado tras ${cf.lecturas} lecturas: no entran en el coste por paso. Repite la medida con \`pnpm carga --medir ${carpeta}\`.`, "");
    if (cf.filtroPorNegocio === false) l.push("> El filtro por el nombre del Durable Object no devolvió nada: las cifras del DO son de todos los TenantHub en esa ventana.", "");
    const columnas = [
      ["preparacion", "Preparación"],
      ["ociosa", "Sesión abierta sin tráfico"],
      ["carga", "Carga"],
      ["cierre", "Cierre de los sockets"],
      ["control", "Control (sin prueba)"],
    ].filter(([c]) => cf[c]);
    const fila = (titulo, f) => `| ${titulo} | ${columnas.map(([c]) => f(cf[c])).join(" | ")} |`;
    const delDo = v => (cf.filtroPorNegocio === false ? v.doTodos : v.doNegocio);
    const deLaCentral = (v, f) => (v.central ? f(v.central) : "—");
    l.push(`| | ${columnas.map(([, t]) => t).join(" | ")} |`, `|---|${columnas.map(() => "---").join("|")}|`);
    l.push(fila("Invocaciones del script por tipo", v => lista(v.worker.porTipo)));
    l.push(fila("Peticiones `fetch` al worker", v => n(v.worker.fetch)));
    l.push(fila("CPU de esas peticiones (ms)", v => n(v.worker.cpuMsFetch)));
    l.push(fila("Subpeticiones por destino", v => lista(v.subpeticionesPorDestino)));
    l.push(fila("Invocaciones del DO del negocio por tipo", v => `${n(delDo(v).invocaciones)} (${lista(delDo(v).porTipo)})`));
    l.push(fila("DO del negocio activo (ms)", v => n(delDo(v).activoMs)));
    l.push(fila("Duración facturable del DO del negocio (GB·s)", v => n(delDo(v).gbs, 3)));
    l.push(fila("Filas del SQLite del DO del negocio (leídas / escritas)", v => `${n(delDo(v).filasLeidas)} / ${n(delDo(v).filasEscritas)}`));
    l.push(fila("Invocaciones de la base central por tipo", v => deLaCentral(v, c => `${n(c.invocaciones)} (${lista(c.porTipo)})`)));
    l.push(fila("Base central activa (ms)", v => deLaCentral(v, c => n(c.activoMs))));
    l.push(fila("Duración facturable de la base central (GB·s)", v => deLaCentral(v, c => n(c.gbs, 3))));
    l.push(fila("Filas del SQLite de la base central (leídas / escritas)", v => deLaCentral(v, c => `${n(c.filasLeidas)} / ${n(c.filasEscritas)}`)));
    l.push("");
    l.push(`El generador mandó en la carga ${httpCarga} peticiones HTTP y ${wsCarga} mensajes de socket de la Main (sus lotes, con ${opsMainCarga} operaciones). La ventana «${cf.cierre ? "Cierre de los sockets" : "Carga"}» recoge las conexiones de la Main y la Handy, que Cloudflare apunta al cerrarse: es coste de la sesión, no de cada paso.`, "");
    l.push("La base central es una para todos los negocios, también los de verdad: lo suyo en cada ventana lleva lo que hicieran los demás equipos en esos minutos. Lo que gasta la carga en ella es lo de su ventana menos lo de la de control, que es del mismo largo.", "");
    if (cf.ociosa) {
      const minutos = (Date.parse(cf.ociosa.hasta) - Date.parse(cf.ociosa.desde)) / 60_000;
      const sesion = delDo(cf.ociosa);
      const gbsHora = (sesion.gbs / minutos) * 60;
      l.push("#### El Durable Object con la sesión abierta y sin tráfico", "");
      l.push(
        `Durante ${n(minutos)} minutos, con la Main y la Handy conectadas y sin mandar nada (los pings los contesta el edge sin despertarlo), el DO del negocio estuvo activo ${n(sesion.activoMs / 1000 / minutos)} s de cada minuto y facturó ${n(gbsHora)} GB·s por hora.`,
      );
      if (gbsHora > 0) {
        l.push(
          "",
          `A ese ritmo, los ${n(INCLUIDO.doGbs)} GB·s incluidos al mes dan para ${n(INCLUIDO.doGbs / gbsHora)} horas de Main conectada, sumando todos los negocios (${n(INCLUIDO.doGbs / gbsHora / 30, 1)} horas al día). ` +
            "Según Cloudflare, un DO con sockets hibernables no factura duración mientras no recibe nada: si sale activo en estos minutos, algo le impide hibernar.",
        );
      }
      l.push("");
    }
    if (cf.asentado && cf.carga) {
      const doCarga = delDo(cf.carga);
      // Los mensajes de socket entrantes se facturan a razón de 20:1; el resto de invocaciones, 1:1.
      const restoDo = Math.max(0, doCarga.invocaciones - wsCarga);
      if (restoDo < escriturasHandy) l.push(`> Cloudflare cuenta ${restoDo} invocaciones del DO además de los mensajes de socket, menos que las ${escriturasHandy} escrituras de la Handy: revisa la medida.`, "");
      // Una medida sin la base central (de antes de que fuera un objeto) se queda en el negocio.
      const central = centralDeLaCarga(cf);
      const de = central ? "medidas en la nube (la base central, menos la ventana de control)" : "medidas en la nube (sólo el negocio)";
      const conLaCentral = (negocio, campo) => [negocio + (central?.[campo] ?? 0), de, central ? { negocio, central: central[campo] } : undefined];
      anotar("doPeticiones", ...conLaCentral(restoDo + wsCarga / 20, "invocaciones"));
      // La duración de los DO no va por paso: depende del tiempo que están despiertos (ver la sesión abierta).
      anotar("doFilasLeidas", ...conLaCentral(doCarga.filasLeidas, "filasLeidas"));
      anotar("doFilasEscritas", ...conLaCentral(doCarga.filasEscritas, "filasEscritas"));
      anotar("workerCpuMs", cf.carga.worker.cpuMsFetch, "medida en la nube");
    }
  }

  const dimensiones = [
    ["Peticiones al worker", "workerPeticiones"],
    ["CPU del worker (ms)", "workerCpuMs"],
    ["Peticiones a los Durable Objects (negocio y base central)", "doPeticiones"],
    ["Filas leídas en el SQLite de los Durable Objects (negocio y base central)", "doFilasLeidas"],
    ["Filas escritas en el SQLite de los Durable Objects (negocio y base central)", "doFilasEscritas"],
  ];
  const medidas = dimensiones.filter(([, clave]) => porPaso[clave] > 0);
  if (medidas.length) {
    l.push("### Lo que cabe en lo incluido cada mes", "");
    l.push("Con la mezcla de esta carga (un paso medio), cuántos pasos caben al mes en lo que ya se paga (Workers Paid). Lo incluido de los Durable Objects es de toda la cuenta: lo gastan juntos los TenantHub, la base central y las agendas de las reservas web. La fila más baja es el primer límite.", "");
    l.push("| Dimensión | Por paso | De ello, base central | Fuente | Incluido al mes | Pasos al mes | Al día |", "|---|---|---|---|---|---|---|");
    for (const [titulo, clave] of medidas) {
      const caben = INCLUIDO[clave] / porPaso[clave];
      l.push(`| ${titulo} | ${n(porPaso[clave], 3)} | ${partes[clave] ? n(partes[clave].central, 3) : ""} | ${fuente[clave]} | ${n(INCLUIDO[clave])} | ${n(caben)} | ${n(caben / 30)} |`);
    }
    const faltan = dimensiones.filter(([, clave]) => porPaso[clave] == null).map(([titulo]) => (/^[A-Z][a-z]/.test(titulo) ? titulo[0].toLowerCase() + titulo.slice(1) : titulo));
    if (faltan.length) l.push("", `Sin medir en esta tanda: ${faltan.join(", ")}.`);
    l.push("");
    const total = clave => (porPaso[clave] != null ? porPaso[clave] * pasos : null);
    const gastado = [`${pct(total("workerPeticiones"), INCLUIDO.workerPeticiones)} de las peticiones del worker del mes`];
    if (porPaso.doFilasEscritas != null) gastado.push(`${pct(total("doFilasEscritas"), INCLUIDO.doFilasEscritas)} de las filas escritas del SQLite de los Durable Objects`);
    else if (porPaso.doPeticiones != null) gastado.push(`${pct(total("doPeticiones"), INCLUIDO.doPeticiones)} de las peticiones a los Durable Objects`);
    l.push(`La carga gastó ${gastado.join(" y ")}.`, "");
  }

  if (estado.avisos?.length) l.push("## Avisos", "", ...estado.avisos.map(a => `- ${a}`), "");

  if (estado.destino === "nube") {
    l.push("## Limpieza", "");
    if (!estado.licenseId) l.push("No se llegó a emitir la licencia: no hay nada que retirar.");
    else if (estado.retirado) {
      l.push("`/v1/admin/pruebas/retirar` anuló la licencia de pruebas y borró lo que el negocio guardaba en la nube: su base en el TenantHub, su agenda de reservas web y sus imágenes. Queda, como en cada tanda de E2E: las filas de `devices` de la Main y la Handy sintéticas, la del negocio en `tenants` (dada por borrada) y la licencia anulada.");
    } else {
      l.push(`**Sin retirar del todo.** ${estado.motivoSinRetirar ?? ""}`);
      l.push("", "`pnpm carga --retirar` lista lo que hay; `pnpm carga --retirar --si` retira todos los negocios de pruebas.");
    }
    l.push("");
  }

  l.push("## Ficheros", "", "- `peticiones.jsonl`: cada petición con su tiempo, su resultado y su `Server-Timing`.", "- `estado.json`: identificadores del negocio, ventanas de tiempo y contadores.");
  if (local) {
    l.push(
      "- `worker.log`: la salida de `wrangler dev`, con los logs del worker; `worker-compilacion.log`, la del empaquetado.",
      "- `worker/estado/`: lo que guardó `wrangler dev`, con la base central y la del negocio en el SQLite de sus objetos.",
    );
  }
  if (coste) l.push("- `coste.json`: lo medido en Cloudflare.");
  l.push("");

  const texto = l.join("\n");
  writeFileSync(join(carpeta, "informe.md"), texto);
  return { texto, porPaso, partes };
}
