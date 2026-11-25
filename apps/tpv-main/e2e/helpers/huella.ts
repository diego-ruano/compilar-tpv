// La huella del código que va dentro del binario de E2E.
//
// Existe para tapar el agujero más peligroso del montaje: `test:e2e` comprobaba que el binario es
// el de E2E, pero no que fuera el de ESTE código. Alguien toca el frontend, se olvida de
// `build:e2e`, lanza el test y sale verde — sobre la versión anterior. Un test que miente en verde
// es peor que no tenerlo, porque se usa para decidir si se tagea.
//
// `construir.ts` deja aquí la huella junto al binario; `entorno.ts` la recalcula antes de arrancar
// y se niega si no coincide, diciendo qué ficheros han cambiado.
//
// Se compara CONTENIDO y no fechas: cambiar de rama reescribe las fechas de medio repo y obligaría
// a recompilar por nada. El coste de leer ~400 ficheros es una décima de segundo.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { RAIZ } from "./entorno.js";

/**
 * Lo que acaba dentro del `.exe`, y sólo eso.
 *
 * Ojo con lo que NO está: `e2e/` y `test/` no entran, a propósito. Si entraran, retocar un selector
 * del propio recorrido exigiría recompilar la aplicación, y a la tercera vez alguien quitaría la
 * comprobación entera.
 */
const RAICES = [
    "apps/tpv-main/src",
    "apps/tpv-main/index.html",
    "apps/tpv-main/vite.config.ts",
    "apps/tpv-main/src-tauri/src",
    "apps/tpv-main/src-tauri/build.rs",
    "apps/tpv-main/src-tauri/Cargo.toml",
    "apps/tpv-main/src-tauri/tauri.conf.json",
    "apps/tpv-main/src-tauri/tauri.e2e.conf.json",
    "apps/tpv-main/src-tauri/capabilities",
    "crates",
    "packages/database/migrations",
    "packages/contracts/src",
    "packages/client/src",
    "Cargo.toml",
    "Cargo.lock",
];

/** Carpetas generadas: ni son fuente ni caben en una huella. */
const IGNORADAS = new Set(["node_modules", "target", "dist", ".turbo"]);

export type Huella = {
    /** sha256 del conjunto. Es lo que se compara. */
    total: string;
    /** sha256 por fichero, para poder decir QUÉ cambió y no sólo que algo cambió. */
    ficheros: Record<string, string>;
};

function recorrer(absoluto: string, relativo: string, salida: string[]): void {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(absoluto);
    } catch {
        return; // una raíz que no existe no invalida la huella: la ausencia también es estado
    }

    if (stat.isFile()) {
        salida.push(relativo);
        return;
    }
    if (!stat.isDirectory()) return;

    for (const entrada of fs.readdirSync(absoluto).sort()) {
        if (IGNORADAS.has(entrada)) continue;
        recorrer(path.join(absoluto, entrada), `${relativo}/${entrada}`, salida);
    }
}

/** Calcula la huella del código fuente que se compila dentro del binario. */
export function huellaDelCodigo(): Huella {
    const relativos: string[] = [];
    for (const raiz of RAICES) {
        recorrer(path.join(RAIZ, raiz), raiz, relativos);
    }
    relativos.sort();

    const ficheros: Record<string, string> = {};
    const total = createHash("sha256");

    for (const rel of relativos) {
        const sha = createHash("sha256")
            .update(fs.readFileSync(path.join(RAIZ, rel)))
            .digest("hex");
        ficheros[rel] = sha;
        // La ruta entra en el hash total: renombrar un fichero también es un cambio.
        total.update(rel).update("\0").update(sha).update("\n");
    }

    return { total: total.digest("hex"), ficheros };
}

/** Qué ha cambiado entre la huella guardada y la de ahora, en lenguaje de ficheros. */
export function diferencias(guardada: Huella, actual: Huella): string[] {
    const cambios: string[] = [];
    for (const [rel, sha] of Object.entries(actual.ficheros)) {
        if (!(rel in guardada.ficheros)) cambios.push(`nuevo      ${rel}`);
        else if (guardada.ficheros[rel] !== sha) cambios.push(`modificado ${rel}`);
    }
    for (const rel of Object.keys(guardada.ficheros)) {
        if (!(rel in actual.ficheros)) cambios.push(`borrado    ${rel}`);
    }
    return cambios.sort();
}
