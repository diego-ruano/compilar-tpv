// AUD-44: lo que este test vigila en los workflows tal como están en el repositorio.
//
// - Ningún job con credenciales (`secrets.*`), ni ninguno de los que dependa (`needs`) uno con
//   credenciales o que firma o despliega, restaura ni guarda una caché (`cache:`, `actions/cache`,
//   `Swatinem/rust-cache`…). La de pnpm la guardan también los jobs de CI, que ejecutan código de
//   terceros sin secretos, y pnpm usa lo que encuentra en su almacén sin revalidarlo contra el
//   lockfile: un Wrangler cambiado ahí correría con el token de Cloudflare.
// - Quien sube el worker a Cloudflare instala sólo Wrangler, desde su lockfile aislado y sin
//   scripts, y ese Wrangler es el mismo con el que se compila el worker.
// - AUD-43: todo artefacto que baja un job con credenciales, o que firma o despliega (el worker y el
//   instalador, sin firmar y firmado), se baja por el id que publica el job que lo produjo y se
//   comprueba, antes de nada, contra el sha256 de su manifiesto que ese job publica como salida;
//   y las salidas que se pasan de un job a otro existen.
//
// Sin dependencias, como el resto de scripts/release: ci.yml lo ejecuta sin instalar el workspace.
// Los workflows se leen por sangría, que es como están escritos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS = join(raiz, ".github/workflows");
const DESPLEGADOR = ".github/tools/worker-deployer";
// Los que firman, publican o despliegan, aunque algún día dejaran de nombrar un secreto.
const FIRMAN_O_DESPLIEGAN = ["sign", "publish", "deploy-worker", "preview-worker"];

const sangria = linea => linea.length - linea.trimStart().length;

/** La línea sin su comentario de YAML: entera si empieza por `#`, o lo que va tras « #». */
const sinComentario = linea => (linea.trimStart().startsWith("#") ? "" : linea.replace(/\s+#.*$/, ""));

/** Los jobs de un workflow, `{ id: { lineas, needs } }`, partidos por sangría. */
function partirJobs(texto) {
  const lineas = texto.split(/\r?\n/).map(sinComentario);
  const inicio = lineas.findIndex(l => /^jobs:\s*$/.test(l));
  assert.notEqual(inicio, -1, "el workflow no tiene jobs:");
  const jobs = {};
  let actual;
  for (const linea of lineas.slice(inicio + 1)) {
    if (linea.trim() === "") continue;
    if (sangria(linea) === 0) break;
    const cabecera = /^ {2}([\w-]+):\s*$/.exec(linea);
    if (cabecera) jobs[cabecera[1]] = actual = { lineas: [] };
    else actual?.lineas.push(linea);
  }
  for (const job of Object.values(jobs)) job.needs = leerNeeds(job.lineas);
  return jobs;
}

/** `needs: x`, `needs: [a, b]` o una lista en varias líneas. */
function leerNeeds(lineas) {
  const i = lineas.findIndex(l => /^ {4}needs:/.test(l));
  if (i === -1) return [];
  const limpiar = s => s.trim().replace(/^["']|["']$/g, "");
  const resto = lineas[i].replace(/^ {4}needs:/, "").trim();
  if (resto.startsWith("[")) return resto.replace(/[[\]]/g, "").split(",").map(limpiar).filter(Boolean);
  if (resto) return [limpiar(resto)];
  const lista = [];
  for (let j = i + 1; j < lineas.length && sangria(lineas[j]) > 4 && /^\s*-\s/.test(lineas[j]); j++) {
    lista.push(limpiar(lineas[j].replace(/^\s*-\s/, "")));
  }
  return lista;
}

function leerWorkflows() {
  return Object.fromEntries(readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f))
    .map(f => [f, partirJobs(readFileSync(join(WORKFLOWS, f), "utf8"))]));
}

/** Los jobs de `origen` y todos aquellos de los que dependen, directa o indirectamente. */
function conSusDependencias(jobs, origen) {
  const vistos = new Set();
  const pendientes = [...origen];
  while (pendientes.length) {
    const id = pendientes.pop();
    if (vistos.has(id) || !jobs[id]) continue;
    vistos.add(id);
    pendientes.push(...jobs[id].needs);
  }
  return vistos;
}

const usaSecretos = job => job.lineas.some(l => /\bsecrets\.\w/.test(l));

/** Las líneas de un job que restauran o guardan una caché. */
function cachesDe(job) {
  return job.lineas.filter(l =>
    // `cache:` de setup-node y pnpm/action-setup, `package-manager-cache:`…, salvo un `false`.
    /^\s*(?:-\s+)?(?:[a-z0-9]+[-_])*cache:\s*(?!false\s*$)\S/.test(l) ||
    // actions/cache (también /restore y /save), Swatinem/rust-cache, sccache…
    /\buses:\s*[^\s@]*cache[^\s@]*@/i.test(l)).map(l => l.trim());
}

/** Los jobs que suben el worker a Cloudflare (un `--dry-run` no sube nada). */
const subeElWorker = job => job.lineas.some(l => /\bwrangler\s+(?:deploy|versions\s+upload)\b/.test(l) && !l.includes("--dry-run"));

/** Los pasos de un job, cada uno como un texto. */
function pasosDe(job) {
  const pasos = [];
  for (const l of job.lineas) {
    if (/^ {6}- /.test(l)) pasos.push(l);
    else if (pasos.length && sangria(l) > 6) pasos[pasos.length - 1] += `\n${l}`;
  }
  return pasos;
}

/** Las salidas que declara un job (`outputs:`), `{ nombre: expresión }`. */
function salidasDe(job) {
  const i = job.lineas.findIndex(l => /^ {4}outputs:\s*$/.test(l));
  const salidas = {};
  for (let j = i + 1; i !== -1 && j < job.lineas.length && sangria(job.lineas[j]) > 4; j++) {
    const salida = /^ {6}([\w-]+):\s*(.+)$/.exec(job.lineas[j]);
    if (salida) salidas[salida[1]] = salida[2].trim();
  }
  return salidas;
}

/** El `id:` de un paso. */
const idDelPaso = paso => /^ {6}(?:- | {2})id:\s*([\w-]+)\s*$/m.exec(paso)?.[1];

/** Los `id:` de los pasos de un job. */
const idsDePasos = job => pasosDe(job).map(idDelPaso).filter(Boolean);

/** El valor de una clave de `with:` o `env:` dentro de un paso. */
const valorEnPaso = (paso, clave) => new RegExp(`^ {8,}${clave}:\\s*(.+)$`, "m").exec(paso)?.[1].trim();

/** Los pasos que comprueban un artefacto descargado contra su manifiesto. */
const COMPROBADOR = /\b(?:worker\.mjs (?:verify|cloudflare)|artifact\.mjs verify)\b/;

/** `{ specifier, version }` con que un pnpm-lock.yaml resuelve `dependencia` en `importador`. */
function resolucion(lockfile, importador, dependencia) {
  const lineas = readFileSync(lockfile, "utf8").split(/\r?\n/);
  const desde = lineas.indexOf("importers:");
  const cabecera = desde === -1 ? -1 : lineas.indexOf(`  ${importador}:`, desde);
  assert.notEqual(cabecera, -1, `${lockfile} no tiene el importador ${importador}`);
  for (let i = cabecera + 1; i < lineas.length && (lineas[i] === "" || sangria(lineas[i]) > 2); i++) {
    if (/^ {6}'?([^':]+)'?:$/.exec(lineas[i])?.[1] !== dependencia) continue;
    const campos = {};
    for (let j = i + 1; j < lineas.length && sangria(lineas[j]) > 6; j++) {
      const campo = /^ {8}(specifier|version): '?([^']+)'?$/.exec(lineas[j]);
      if (campo) campos[campo[1]] = campo[2];
    }
    // La versión puede llevar detrás sus peers resueltos: `4.96.0(@cloudflare/…)`.
    return { specifier: campos.specifier, version: campos.version?.replace(/\(.*$/, "") };
  }
  assert.fail(`${lockfile} no resuelve ${dependencia} en ${importador}`);
}

test("el lector de workflows ve los jobs, sus dependencias, los secretos y las cachés", () => {
  const wf = leerWorkflows();
  assert.deepEqual(wf["release.yml"].build.needs, ["ci"]);
  assert.deepEqual(wf["release.yml"]["deploy-worker"].needs, ["build-worker", "build", "sign"]);
  assert.deepEqual(wf["release.yml"].publish.needs, ["build", "sign", "deploy-worker"]);
  assert.deepEqual(wf["verify-sentry.yml"]["preview-worker"].needs, ["worker"]);
  assert.ok(usaSecretos(wf["release.yml"].sign) && !usaSecretos(wf["ci.yml"].lint));
  // CI usa caché, sin credenciales: así se ve que el detector no está ciego.
  assert.ok(cachesDe(wf["ci.yml"].lint).some(l => /^cache:\s*pnpm$/.test(l)));
  assert.ok(cachesDe(wf["ci.yml"]["contratos-tauri"]).some(l => /Swatinem\/rust-cache@/.test(l)));
  const job = (...lineas) => ({ lineas });
  assert.equal(cachesDe(job("      - uses: actions/cache/restore@0123")).length, 1);
  assert.equal(cachesDe(job("          package-manager-cache: true")).length, 1);
  assert.equal(cachesDe(job("          cache: false", "      - uses: actions/checkout@0123")).length, 0);
  // Un comentario que nombra una caché no es una caché.
  assert.equal(partirJobs("jobs:\n  a:\n    steps:\n      # cache: pnpm\n      - run: x # uses: actions/cache@1\n").a.lineas.flatMap(l => cachesDe(job(l))).length, 0);
  // ci.yml ejecuta este fichero.
  assert.match(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8"), /node --test scripts\/release\/\*\.test\.mjs/);
});

test("AUD-44 · ningún job con credenciales, ni del que dependa uno que las tenga o que firme o despliegue, usa caché", () => {
  const fuera = [];
  for (const [fichero, jobs] of Object.entries(leerWorkflows())) {
    const sensibles = Object.keys(jobs).filter(id => usaSecretos(jobs[id]) || FIRMAN_O_DESPLIEGAN.includes(id));
    // Un job que sólo llama a otro workflow (`uses:` del job, como `ci` en release.yml) cuenta por
    // sus propias líneas: los jobs de ese workflow se miran en su fichero.
    for (const id of conSusDependencias(jobs, sensibles)) {
      const caches = cachesDe(jobs[id]);
      if (caches.length) fuera.push(`${fichero} · ${id}: ${caches.join(" | ")}`);
    }
  }
  assert.deepEqual(fuera, [], `Jobs con credenciales, o de los que depende uno que firma o despliega, con una caché que también escribe CI:\n${fuera.join("\n")}`);
});

test("AUD-44 · quien sube el worker a Cloudflare instala sólo Wrangler, desde su lockfile y sin scripts", () => {
  const desplegadores = [];
  for (const [fichero, jobs] of Object.entries(leerWorkflows())) {
    for (const [id, job] of Object.entries(jobs)) {
      if (!subeElWorker(job)) continue;
      desplegadores.push(`${fichero} · ${id}`);
      const instalaciones = job.lineas.filter(l => /\bpnpm\b.*\binstall\b|\b(?:npm|npx|yarn)\b/.test(l));
      assert.ok(instalaciones.length, `${fichero} · ${id} no instala el desplegador`);
      for (const l of instalaciones) {
        const aislada = l.includes(`pnpm --dir ${DESPLEGADOR} install `) &&
          ["--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"].every(opcion => l.includes(opcion));
        assert.ok(aislada, `${fichero} · ${id} instala algo más que el desplegador aislado: ${l.trim()}`);
      }
      // Wrangler como orden (`wrangler`, `…/wrangler.js`), no el nombre de `wrangler.json`.
      for (const l of job.lineas.filter(l => /(?:^|[\s"'/])wrangler(?:\.js)?(?=\s|$)/.test(l))) {
        assert.ok(l.includes(`pnpm --dir ${DESPLEGADOR} exec wrangler `), `${fichero} · ${id} ejecuta otro Wrangler: ${l.trim()}`);
      }
    }
  }
  assert.deepEqual(desplegadores.sort(), ["release.yml · deploy-worker", "verify-sentry.yml · preview-worker"]);
});

test("AUD-44 · el Wrangler que despliega es el del worker, fijado y bloqueado en su lockfile", () => {
  const pkg = JSON.parse(readFileSync(join(raiz, DESPLEGADOR, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg).filter(k => /dependencies$/i.test(k)), ["dependencies"], "el desplegador sólo instala Wrangler");
  assert.deepEqual(Object.keys(pkg.dependencies), ["wrangler"], "el desplegador sólo instala Wrangler");
  const fijada = pkg.dependencies.wrangler;
  assert.match(fijada, /^\d+\.\d+\.\d+$/, "el desplegador fija una versión exacta de Wrangler");
  const delWorker = resolucion(join(raiz, "pnpm-lock.yaml"), "apps/cloud-worker-licensing", "wrangler").version;
  assert.equal(fijada, delWorker, `El worker se compila con Wrangler ${delWorker} y se desplegaría con ${fijada}: ` +
    `iguala ${DESPLEGADOR}/package.json y regenera su lock con \`pnpm --dir ${DESPLEGADOR} install --ignore-workspace\``);
  assert.deepEqual(resolucion(join(raiz, DESPLEGADOR, "pnpm-lock.yaml"), ".", "wrangler"), { specifier: fijada, version: fijada },
    `Regenera ${DESPLEGADOR}/pnpm-lock.yaml: con --frozen-lockfile, el job que despliega no podría instalar`);
});

test("AUD-43 · las salidas que pasan de un job a otro existen", () => {
  // Una errata dejaría vacío un sha256 o un id, y la release se pararía después de compilar.
  for (const [fichero, jobs] of Object.entries(leerWorkflows())) {
    for (const [id, job] of Object.entries(jobs)) {
      for (const [, origen, salida] of job.lineas.join("\n").matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
        assert.ok(job.needs.includes(origen), `${fichero} · ${id} usa una salida de ${origen} sin esperarlo en needs`);
        assert.ok(salidasDe(jobs[origen] ?? { lineas: [] })[salida], `${fichero} · ${origen} no declara la salida ${salida}`);
      }
      for (const [salida, expresion] of Object.entries(salidasDe(job))) {
        for (const [, paso] of expresion.matchAll(/steps\.([\w-]+)\.outputs\./g)) {
          assert.ok(idsDePasos(job).includes(paso), `${fichero} · ${id}: la salida ${salida} sale de un paso «${paso}» que no existe`);
        }
      }
    }
  }
});

test("AUD-43 · todo artefacto que baja un job con credenciales, o que firma o despliega, viaja por su id y con el sha256 que publica quien lo produjo", () => {
  const parejas = [];
  for (const [fichero, jobs] of Object.entries(leerWorkflows())) {
    for (const [id, job] of Object.entries(jobs)) {
      if (!usaSecretos(job) && !FIRMAN_O_DESPLIEGAN.includes(id)) continue;
      const pasos = pasosDe(job);
      pasos.forEach((paso, i) => {
        if (!/uses:\s*actions\/download-artifact@/.test(paso)) return;
        const aqui = `${fichero} · ${id}`;
        // Por el id que publica el job que lo produjo; nunca por nombre ni por patrón.
        const productor = /^\$\{\{ needs\.([\w-]+)\.outputs\.artifact_id \}\}$/.exec(valorEnPaso(paso, "artifact-ids") ?? "")?.[1];
        assert.ok(productor, `${aqui} baja un artefacto sin el id que publica quien lo produjo:\n${paso}`);
        assert.doesNotMatch(paso, /^\s+(?:name|pattern):/m, `${aqui} baja un artefacto por su nombre`);
        assert.equal(valorEnPaso(paso, "merge-multiple"), "true", `${aqui}: sin merge-multiple, el artefacto acaba en una subcarpeta`);
        assert.ok(job.needs.includes(productor), `${aqui} no espera a ${productor}`);
        // Quien lo produjo publica, sacados de sus pasos, el id de lo que sube y el sha256 de su manifiesto.
        const origen = jobs[productor];
        const salidas = salidasDe(origen);
        const subida = /^\$\{\{ steps\.([\w-]+)\.outputs\.artifact-id \}\}$/.exec(salidas.artifact_id ?? "")?.[1];
        assert.ok(subida && pasosDe(origen).some(p => /uses:\s*actions\/upload-artifact@/.test(p) && idDelPaso(p) === subida),
          `${fichero} · ${productor} no publica como salida el id del artefacto que sube`);
        assert.match(salidas.manifest_sha256 ?? "", /^\$\{\{ steps\.[\w-]+\.outputs\.manifest_sha256 \}\}$/, `${fichero} · ${productor} no publica el sha256 del manifiesto`);
        // El primer paso que usa lo bajado lo comprueba, y todo paso que lo comprueba lleva ese sha256.
        const ruta = valorEnPaso(paso, "path");
        const usan = pasos.slice(i + 1).filter(p => /^\s+(?:- )?run:/m.test(p) && p.includes(ruta));
        assert.ok(usan.length && COMPROBADOR.test(usan[0]), `${aqui}: el primer paso que usa ${ruta} no lo comprueba`);
        const sha = new RegExp(`^ +\\w+_MANIFEST_SHA256: \\$\\{\\{ needs\\.${productor}\\.outputs\\.manifest_sha256 \\}\\}$`, "m");
        for (const p of usan.filter(p => COMPROBADOR.test(p))) {
          assert.match(p, sha, `${aqui}: un paso comprueba ${ruta} sin el sha256 que publicó ${productor}:\n${p}`);
        }
        // Wrangler sólo corre detrás de la comprobación, en el mismo paso.
        for (const p of usan.filter(p => /exec wrangler\s/.test(p))) {
          const comprobacion = p.search(/worker\.mjs cloudflare\b/);
          assert.ok(comprobacion !== -1 && comprobacion < p.search(/exec wrangler\s/), `${aqui}: Wrangler corre sin la comprobación delante`);
        }
        parejas.push(`${fichero} · ${productor} → ${id}`);
      });
    }
  }
  assert.deepEqual(parejas.sort(), [
    "release.yml · build → sign",
    "release.yml · build-worker → deploy-worker",
    "release.yml · sign → publish",
    "verify-sentry.yml · worker → preview-worker",
  ]);
});
