// El informe de una tanda, en `informe.md`. Se construye sólo con lo que la tanda dejó en su carpeta
// (estado.json, peticiones.jsonl, turso-local.json, coste.json), así que `--medir` puede rehacerlo
// cuando los datos de Cloudflare terminan de asentarse.

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

const sumaTurso = (porEtapa, etapas, base) =>
  etapas.reduce(
    (t, e) => {
      const b = porEtapa?.[e]?.[base];
      if (b) for (const k of Object.keys(t)) t[k] += b[k];
      return t;
    },
    { http: 0, sentencias: 0, lecturas: 0, escrituras: 0 },
  );

const delta = (despues, antes, campo) => (despues?.[campo] != null && antes?.[campo] != null ? despues[campo] - antes[campo] : null);

function leerEntradas(carpeta) {
  const ruta = join(carpeta, "peticiones.jsonl");
  if (!existsSync(ruta)) return [];
  return readFileSync(ruta, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

export function escribirInforme(carpeta) {
  const estado = leer(carpeta, "estado.json") ?? {};
  const entradas = leerEntradas(carpeta);
  const tursoLocal = leer(carpeta, "turso-local.json");
  // Las bases que midió el proxy local: la central (la del negocio es el SQLite de su TenantHub).
  const basesTurso = [...new Set(Object.values(tursoLocal ?? {}).flatMap(e => Object.keys(e)))].sort();
  const sumaBases = etapas =>
    basesTurso.map(b => sumaTurso(tursoLocal, etapas, b)).reduce((s, x) => ({ lecturas: s.lecturas + x.lecturas, escrituras: s.escrituras + x.escrituras }), { lecturas: 0, escrituras: 0 });
  const coste = leer(carpeta, "coste.json");

  const carga = entradas.filter(e => e.fase === "carga");
  const preparacion = entradas.filter(e => e.fase === "preparacion");
  const etapasCarga = [...new Set(carga.map(e => e.etapa))];
  const etapasResto = Object.keys(tursoLocal ?? {}).filter(e => !etapasCarga.includes(e));
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
  l.push(`| Destino | ${estado.destino === "local" ? "worker en este equipo (wrangler dev) con la base central en sqld del WSL" : `worker desplegado (${estado.base})`} |`);
  l.push(`| Negocio de pruebas | \`${estado.tenantId ?? "—"}\` · licencia ${estado.claveCorta ?? "—"} |`);
  // Una operación de la Main viaja dentro de su lote: el mensaje es el lote.
  const mensajesWs = es => es.filter(e => e.metodo === "WS" && e.tipo !== "main-ws" && e.tipo !== "propagacion").length;
  l.push(`| Preparación | ${preparacion.filter(e => e.http).length} peticiones HTTP y ${mensajesWs(preparacion)} mensajes de socket · ${n(duracion(estado.ventanas?.preparacion), 1)} s |`);
  l.push(`| Carga | ${pasos} pasos a ${estado.ritmo}/s · ${n(duracion(estado.ventanas?.carga), 1)} s |`);
  if (estado.socket) {
    l.push(`| Sockets | ${estado.socket.enviados} mensajes enviados (sin contar ${estado.socket.pings} pings) · recibidos: ${lista(estado.socket.recibidos)} |`);
  }
  if (estado.destino === "nube") l.push(`| Limpieza | ${estado.retirado ? "negocio retirado (base de Turso borrada y licencia anulada)" : "**sin retirar del todo**: ver «Limpieza»"} |`);
  l.push("");

  if (pasos) {
    l.push("## Las peticiones de la carga", "");
    const conTurso = Boolean(tursoLocal);
    l.push(`| # | Paso | Tipo | Petición | Estado | ms |${conTurso ? basesTurso.map(b => ` Turso ${b} (leídas / escritas) |`).join("") : ""}`);
    l.push(`|---|---|---|---|---|---|${conTurso ? "---|".repeat(basesTurso.length) : ""}`);
    const vistas = new Set();
    for (const e of carga) {
      let turso = "";
      if (conTurso) {
        const primera = !vistas.has(e.etapa);
        vistas.add(e.etapa);
        const t = tursoLocal[e.etapa];
        turso = primera ? basesTurso.map(b => ` ${n(t?.[b]?.lecturas ?? 0)} / ${n(t?.[b]?.escrituras ?? 0)} |`).join("") : " |".repeat(basesTurso.length);
      }
      const estadoTexto = e.ok ? String(e.status) : `${e.status ?? "—"} ✗ ${e.error ?? ""}`;
      l.push(`| ${e.n} | ${e.etapa} | ${e.tipo} | ${e.metodo} ${e.ruta} | ${estadoTexto} | ${n(e.ms)} |${turso}`);
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

  // Lo que cuesta un paso medio de la carga, con su fuente.
  const porPaso = {};
  const fuente = {};
  const anotar = (clave, valor, de) => {
    if (pasos && valor != null && Number.isFinite(valor)) {
      porPaso[clave] = valor / pasos;
      fuente[clave] = de;
    }
  };
  // Las peticiones al worker las cuenta el generador: cada HTTP que manda es una petición facturable.
  anotar("workerPeticiones", httpCarga, "contadas por el generador");

  l.push("## Coste", "");
  if (tursoLocal) {
    l.push("### Turso (medido en local con sqld)", "");
    l.push("Filas que cuenta el propio motor de Turso, que es lo que factura. Sólo la base central: la del negocio es el SQLite de su TenantHub, que no pasa por Turso.", "");
    l.push("| Fase | Base | Llamadas | Sentencias | Filas leídas | Filas escritas |", "|---|---|---|---|---|---|");
    for (const [fase, etapas] of [["Preparación (alta, semilla, emparejamiento)", etapasResto], ["Carga", etapasCarga]]) {
      for (const base of basesTurso) {
        const t = sumaTurso(tursoLocal, etapas, base);
        l.push(`| ${fase} | ${base} | ${n(t.http)} | ${n(t.sentencias)} | ${n(t.lecturas)} | ${n(t.escrituras)} |`);
      }
    }
    if (pasos) {
      l.push("", `Por tipo de paso de la carga (media de filas por paso, ${basesTurso.join(" + ")}):`, "", "| Tipo | Pasos | Leídas por paso | Escritas por paso |", "|---|---|---|---|");
      for (const tipo of [...new Set(carga.map(e => e.tipo))]) {
        const etapas = [...new Set(carga.filter(e => e.tipo === tipo).map(e => e.etapa))];
        const s = sumaBases(etapas);
        l.push(`| ${tipo} | ${etapas.length} | ${n(s.lecturas / etapas.length, 1)} | ${n(s.escrituras / etapas.length, 1)} |`);
      }
      const s = sumaBases(etapasCarga);
      anotar("tursoFilasLeidas", s.lecturas, "medidas en local");
      anotar("tursoFilasEscritas", s.escrituras, "medidas en local");
    }
    l.push("", "En local hay un solo isolate, y sus cachés de 60 s hacen que la base central se lea mucho menos que en la nube.", "");
    l.push("### Cloudflare (estimado: en local no hay contadores)", "");
    l.push(`- Peticiones al worker en la carga: ${httpCarga} (las ${opsMainCarga} operaciones de la Main van en ${wsCarga} lotes por el socket abierto y no son peticiones).`);
    l.push(`- Peticiones al TenantHub: una por cada escritura de la Handy (${escriturasHandy}) más los lotes de la Main, mensajes de socket a razón de 20:1.`);
    anotar("doPeticiones", escriturasHandy + wsCarga / 20, "estimadas");
    l.push("");
  }

  const t = coste?.turso;
  if (t?.antes || t?.despuesPreparacion) {
    const base = `tpv-${estado.tenantId}`;
    const prep = t.despuesPreparacion;
    const fin = t.despuesCarga;
    const asentada = x => (x ? (x.asentado ? "sí" : "no") : "no se midió");
    l.push("### Turso (medido en la nube con `turso db inspect`)", "");
    l.push("| Base | Fase | Filas leídas | Filas escritas | Asentado |", "|---|---|---|---|---|");
    l.push(`| ${base} | alta y preparación | ${n(prep?.[base]?.filasLeidas)} | ${n(prep?.[base]?.filasEscritas)} | ${asentada(prep)} |`);
    l.push(`| ${base} | carga | ${n(delta(fin?.[base], prep?.[base], "filasLeidas"))} | ${n(delta(fin?.[base], prep?.[base], "filasEscritas"))} | ${asentada(fin)} |`);
    l.push(`| tpv-control | preparación | ${n(delta(prep?.["tpv-control"], t.antes?.["tpv-control"], "filasLeidas"))} | ${n(delta(prep?.["tpv-control"], t.antes?.["tpv-control"], "filasEscritas"))} | orientativo |`);
    l.push(`| tpv-control | carga | ${n(delta(fin?.["tpv-control"], prep?.["tpv-control"], "filasLeidas"))} | ${n(delta(fin?.["tpv-control"], prep?.["tpv-control"], "filasEscritas"))} | orientativo |`);
    l.push("", "`tpv-control` es compartida: sus cifras incluyen lo que hayan hecho a la vez otros equipos y las esperas entre lecturas, así que no entran en el coste por paso.", "");
    if (prep?.asentado && fin?.asentado) {
      anotar("tursoFilasLeidas", delta(fin[base], prep[base], "filasLeidas"), "medidas en la nube (base del negocio)");
      anotar("tursoFilasEscritas", delta(fin[base], prep[base], "filasEscritas"), "medidas en la nube (base del negocio)");
    } else if (prep || fin) {
      l.push("> El uso de Turso no se asentó a tiempo: las cifras de la carga no son fiables y no entran en el coste por paso.", "");
    }
    if (t.plan) l.push("Uso del mes de toda la organización al empezar:", "", "```", t.plan, "```", "");
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
    l.push(`| | ${columnas.map(([, t]) => t).join(" | ")} |`, `|---|${columnas.map(() => "---").join("|")}|`);
    l.push(fila("Invocaciones del script por tipo", v => lista(v.worker.porTipo)));
    l.push(fila("Peticiones `fetch` al worker", v => n(v.worker.fetch)));
    l.push(fila("CPU de esas peticiones (ms)", v => n(v.worker.cpuMsFetch)));
    l.push(fila("Subpeticiones por destino", v => lista(v.subpeticionesPorDestino)));
    l.push(fila("Invocaciones del DO del negocio por tipo", v => `${n(delDo(v).invocaciones)} (${lista(delDo(v).porTipo)})`));
    l.push(fila("DO activo (ms)", v => n(delDo(v).activoMs)));
    l.push(fila("Duración facturable del DO (GB·s)", v => n(delDo(v).gbs, 3)));
    l.push(fila("Filas del SQLite del DO (leídas / escritas)", v => `${n(delDo(v).filasLeidas)} / ${n(delDo(v).filasEscritas)}`));
    l.push("");
    l.push(`El generador mandó en la carga ${httpCarga} peticiones HTTP y ${wsCarga} mensajes de socket de la Main (sus lotes, con ${opsMainCarga} operaciones). La ventana «${cf.cierre ? "Cierre de los sockets" : "Carga"}» recoge las conexiones de la Main y la Handy, que Cloudflare apunta al cerrarse: es coste de la sesión, no de cada paso.`, "");
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
      anotar("doPeticiones", restoDo + wsCarga / 20, "medidas en la nube");
      // La duración del DO no va por paso: depende del tiempo que está despierto (ver la sesión abierta).
      anotar("doFilasEscritas", doCarga.filasEscritas, "medidas en la nube");
      anotar("workerCpuMs", cf.carga.worker.cpuMsFetch, "medida en la nube");
    }
  }

  const dimensiones = [
    ["Peticiones al worker", "workerPeticiones"],
    ["CPU del worker (ms)", "workerCpuMs"],
    ["Peticiones al Durable Object", "doPeticiones"],
    ["Filas escritas en el SQLite del DO", "doFilasEscritas"],
    ["Filas leídas en Turso", "tursoFilasLeidas"],
    ["Filas escritas en Turso", "tursoFilasEscritas"],
  ];
  const medidas = dimensiones.filter(([, clave]) => porPaso[clave] > 0);
  if (medidas.length) {
    l.push("### Lo que cabe en lo incluido cada mes", "");
    l.push("Con la mezcla de esta carga (un paso medio), cuántos pasos caben al mes en lo que ya se paga (Workers Paid) o en lo gratuito (Turso). La fila más baja es el primer límite.", "");
    l.push("| Dimensión | Por paso | Fuente | Incluido al mes | Pasos al mes | Al día |", "|---|---|---|---|---|---|");
    for (const [titulo, clave] of medidas) {
      const caben = INCLUIDO[clave] / porPaso[clave];
      l.push(`| ${titulo} | ${n(porPaso[clave], 3)} | ${fuente[clave]} | ${n(INCLUIDO[clave])} | ${n(caben)} | ${n(caben / 30)} |`);
    }
    const faltan = dimensiones.filter(([, clave]) => porPaso[clave] == null).map(([titulo]) => titulo.toLowerCase());
    if (faltan.length) l.push("", `Sin medir en esta tanda: ${faltan.join(", ")}.`);
    l.push("");
    const total = clave => (porPaso[clave] != null ? porPaso[clave] * pasos : null);
    l.push(`La carga gastó ${pct(total("workerPeticiones"), INCLUIDO.workerPeticiones)} de las peticiones del worker del mes y ${pct(total("tursoFilasEscritas"), INCLUIDO.tursoFilasEscritas)} de las filas escritas de Turso.`, "");
  }

  if (estado.avisos?.length) l.push("## Avisos", "", ...estado.avisos.map(a => `- ${a}`), "");

  if (estado.destino === "nube") {
    l.push("## Limpieza", "");
    if (!estado.licenseId) l.push("No se llegó a emitir la licencia: no hay nada que retirar.");
    else if (estado.retirado) {
      l.push("La base de Turso del negocio se borró y la licencia de pruebas quedó anulada con `/v1/admin/pruebas/retirar`. Queda, como en cada tanda de E2E: el almacenamiento del Durable Object del negocio (no hay ruta que lo borre), las filas de `devices` de la Main y la Handy sintéticas y la licencia anulada.");
    } else {
      l.push(`**Sin retirar del todo.** ${estado.motivoSinRetirar ?? ""}`);
      l.push("", "`pnpm carga --retirar` lista lo que hay; `pnpm carga --retirar --si` retira todos los negocios de pruebas.");
    }
    l.push("");
  }

  l.push("## Ficheros", "", "- `peticiones.jsonl`: cada petición con su tiempo y su resultado.", "- `estado.json`: identificadores del negocio, ventanas de tiempo y contadores.");
  if (tursoLocal) l.push("- `turso-local.json`: filas de Turso por paso.", "- `worker.log`: la salida de `wrangler dev`, con los logs del worker.");
  if (coste) l.push("- `coste.json`: lo medido en Cloudflare y Turso.");
  l.push("");

  const texto = l.join("\n");
  writeFileSync(join(carpeta, "informe.md"), texto);
  return { texto, porPaso };
}
