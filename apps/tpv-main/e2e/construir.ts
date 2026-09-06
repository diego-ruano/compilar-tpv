#!/usr/bin/env node
//
// Compila el build de E2E, lo verifica y lo deja en `target/e2e/` con su huella.
//
// El paso de copiar no es cosmético. `tauri build --no-bundle` NO renombra el binario (el rename a
// `productName` ocurre al empaquetar), así que el build de E2E y el de producción escriben los dos
// en `target/release/tpv.exe`. Dejarlo ahí significaría que un `pnpm tauri build` posterior deja
// una trampa: el test arrancaría la app de verdad, contra la `data.db` del equipo. La copia da una
// ruta que sólo puede contener el binario de E2E, y aun así se verifica el identificador que lleva
// dentro antes de aceptarla.
//
// Y junto a la copia se deja la huella del código que la ha producido, para que el test pueda
// negarse a arrancar si alguien toca el código y se olvida de recompilar (ver `huella.ts`).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { APP_ID_E2E, BINARIO, DIR_APP, HUELLA, RAIZ } from "./helpers/entorno.js";
import { huellaDelCodigo } from "./helpers/huella.js";

const APP_ID_PROD = "com.altarialights.tpv";
const RECIEN_COMPILADO = path.join(RAIZ, "target", "release", "tpv.exe");

// El identificador va dentro del binario sin terminador, pegado a lo que venga detrás
// (`…tpv.e2emaindefault-src…`), así que no se puede recortar como si fuera una cadena suelta. Se
// pregunta por presencia; el de producción es este mismo prefijo SIN `.e2e` detrás.
function comprobarIdentificador(exe: string) {
    const texto = fs.readFileSync(exe).toString("latin1");
    return {
        tieneE2E: texto.includes(APP_ID_E2E),
        tieneProd: new RegExp(`${APP_ID_PROD.replace(/\./g, "\\.")}(?!\\.e2e)`).test(texto),
    };
}

// Se llama al CLI de Tauri por su entrada JS y con este mismo node, no por `pnpm exec`: desde
// Node 22, `spawnSync` se niega a lanzar un `.cmd` sin shell (EINVAL), y meter un shell por medio
// sólo añade una capa que citar mal.
const require_ = createRequire(import.meta.url);
const tauriCli = require_.resolve("@tauri-apps/cli/tauri.js", { paths: [DIR_APP] });

// La huella se toma ANTES de compilar: si alguien edita a mitad del build, lo que se guarda es lo
// que de verdad entró en el binario, y la próxima ejecución del test lo detectará.
const huella = huellaDelCodigo();

console.log("→ tauri build --config src-tauri/tauri.e2e.conf.json --no-bundle");
execFileSync(
    process.execPath,
    [tauriCli, "build", "--config", "src-tauri/tauri.e2e.conf.json", "--no-bundle"],
    { cwd: DIR_APP, stdio: "inherit" },
);

if (!fs.existsSync(RECIEN_COMPILADO)) {
    console.error(`\n  ✖ El build terminó pero no hay binario en ${RECIEN_COMPILADO}\n`);
    process.exit(1);
}

const { tieneE2E, tieneProd } = comprobarIdentificador(RECIEN_COMPILADO);
if (!tieneE2E || tieneProd) {
    console.error(
        `\n  ✖ ${RECIEN_COMPILADO} no es el build de E2E.\n` +
            `    ${APP_ID_E2E}: ${tieneE2E ? "sí" : "NO"} · ${APP_ID_PROD}: ${tieneProd ? "SÍ" : "no"}\n` +
            "    Copiarlo dejaría un binario que escribe en el AppData de producción.\n",
    );
    process.exit(1);
}

fs.mkdirSync(path.dirname(BINARIO), { recursive: true });
fs.copyFileSync(RECIEN_COMPILADO, BINARIO);
fs.writeFileSync(HUELLA, JSON.stringify(huella), "utf8");

console.log(`\n  ✔ Binario de E2E listo: ${BINARIO}`);
console.log(`    identificador: ${APP_ID_E2E}  →  %APPDATA%\\${APP_ID_E2E}\\`);
console.log(
    `    huella: ${huella.total.slice(0, 12)}… (${Object.keys(huella.ficheros).length} ficheros)\n`,
);
