// Rutas, identidad y estado limpio del build de E2E.
//
// Todo lo delicado de este fichero sale de un único hecho: el AppData de Tauri es
// `dirs::data_dir().join(identifier)` y el identifier se fija AL COMPILAR. O sea que lo único que
// separa los datos de este test de los datos de trabajo del equipo es que el binario que se lanza
// sea el compilado con `tauri.e2e.conf.json`. Por eso aquí no se confía en la ruta: se abre el
// ejecutable y se comprueba qué identificador lleva dentro antes de dejar que nadie lo arranque
// o borre una carpeta.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { diferencias, huellaDelCodigo, type Huella } from "./huella.js";

/** El identificador del build de E2E (`src-tauri/tauri.e2e.conf.json`). */
export const APP_ID_E2E = "com.altarialights.tpv.e2e";

/** El de producción. Que aparezca en el binario significa que ese binario NO es el de E2E. */
const APP_ID_PROD = "com.altarialights.tpv";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** `apps/tpv-main/e2e` */
export const DIR_E2E = path.resolve(AQUI, "..");

/** `apps/tpv-main` */
export const DIR_APP = path.resolve(DIR_E2E, "..");

/** Raíz del monorepo. */
export const RAIZ = path.resolve(DIR_APP, "..", "..");

/**
 * El ejecutable que arranca el test.
 *
 * NO es `target/release/tpv.exe`: `tauri build --no-bundle` no renombra el binario, así que el
 * build de E2E y el de producción escriben en esa misma ruta y el último gana. Sería cuestión de
 * tiempo que alguien compilase la app de verdad y luego lanzara el test contra sus propios datos.
 * `construir.ts` deja aquí una copia verificada.
 */
export const BINARIO = path.join(RAIZ, "target", "e2e", "tpv-e2e.exe");

/** La huella del código con el que se compiló `BINARIO` (ver `huella.ts`). */
export const HUELLA = path.join(RAIZ, "target", "e2e", "tpv-e2e.huella.json");

/**
 * Carpeta de datos del build de E2E.
 *
 * ⚠️ Se deriva de `%APPDATA%`, pero Tauri la resuelve por `SHGetKnownFolderPath`, que no mira esa
 * variable. En un equipo normal coinciden; que coincidan de verdad lo demuestra el propio test,
 * que exige ver aparecer aquí la `data.db` tras el primer arranque.
 */
export function dirDatosE2E(): string {
    const roaming = process.env.APPDATA;
    if (!roaming) {
        throw new Error("Sin %APPDATA%: este test sólo corre en Windows.");
    }
    return path.join(roaming, APP_ID_E2E);
}

/**
 * Comprueba que un ejecutable es el build de E2E leyendo el identificador que lleva embebido.
 * Lanza si no lo es. Es la única barrera real entre el test y la `data.db` del equipo.
 */
export function exigirBinarioE2E(exe: string): void {
    if (!fs.existsSync(exe)) {
        throw new Error(
            `No existe el binario de E2E (${exe}).\n` +
                "Compílalo antes:  pnpm --filter @tpv/main build:e2e",
        );
    }

    // El identificador va dentro del binario sin terminador, pegado a lo que venga detrás
    // (`…tpv.e2emaindefault-src…`), así que no se puede recortar como si fuera una cadena suelta.
    // Se pregunta por presencia; el de producción es este mismo prefijo SIN `.e2e` detrás.
    const texto = fs.readFileSync(exe).toString("latin1");

    if (!texto.includes(APP_ID_E2E)) {
        throw new Error(
            `${exe} no lleva dentro el identificador de E2E (${APP_ID_E2E}).\n` +
                "Ese binario escribiría en el AppData de producción. Recompila con:\n" +
                "  pnpm --filter @tpv/main build:e2e",
        );
    }

    if (new RegExp(`${APP_ID_PROD.replace(/\./g, "\\.")}(?!\\.e2e)`).test(texto)) {
        throw new Error(
            `${exe} lleva dentro el identificador de PRODUCCIÓN (${APP_ID_PROD}).\n` +
                "Es el binario real, no el de E2E: arrancarlo machacaría los datos del equipo.",
        );
    }
}

/**
 * Se niega a arrancar si el binario no es el de ESTE código.
 *
 * Es la otra mitad de la comprobación anterior, y tapa un fallo peor: un binario viejo no rompe
 * nada, **pasa**. Alguien toca una pantalla, se olvida de `build:e2e`, lanza el test, sale verde y
 * tagea. Un test que miente en verde es peor que no tener test, porque se usa para decidir.
 *
 * No mira fechas sino contenido: cambiar de rama reescribe las fechas de medio repo y obligaría a
 * recompilar sin motivo. Lo que se compara está en `huella.ts`, con `e2e/` y `test/` fuera a
 * propósito — retocar un selector del propio recorrido no puede exigir recompilar la aplicación.
 */
export function exigirBinarioAlDia(): void {
    const consejo = "Recompílalo:  pnpm --filter @tpv/main build:e2e";

    let guardada: Huella;
    try {
        guardada = JSON.parse(fs.readFileSync(HUELLA, "utf8")) as Huella;
    } catch {
        throw new Error(
            `No hay huella del binario (${HUELLA}), así que no se puede saber de qué código sale.\n${consejo}`,
        );
    }

    const actual = huellaDelCodigo();
    if (guardada.total === actual.total) return;

    const cambios = diferencias(guardada, actual);
    const muestra = cambios.slice(0, 12).map((c) => `    ${c}`);
    const resto = cambios.length - muestra.length;

    throw new Error(
        `El binario de E2E no corresponde al código: ${cambios.length} ` +
            `${cambios.length === 1 ? "fichero ha cambiado" : "ficheros han cambiado"} desde que se compiló.\n` +
            `${muestra.join("\n")}${resto > 0 ? `\n    …y ${resto} más` : ""}\n` +
            `  ${consejo}`,
    );
}

/**
 * Deja el equipo del test como recién instalado: sin carpeta de datos, que es como llega a un bar.
 *
 * Se niega a borrar si la ruta no termina en `.e2e`: sin esa comprobación, un identificador mal
 * escrito convierte esta función en un borrado de los datos de trabajo.
 *
 * Y con la nube encendida, que es lo que hace la app cuando nadie le dice otra cosa. Hubo un tiempo
 * en que la venta nacía con `connectivity: "off"`, y no era un atajo: la licencia era fija, y un
 * AppData borrado sobre un tenant que ya tiene historia NO es un equipo nuevo — al conectar, la
 * Main se traía por catch-up lo que dejaron las tandas anteriores, y se vio como un fichaje que la
 * app rechazaba con "tienes un fichaje abierto" unas veces sí y otras no. Con una licencia recién
 * emitida por tanda el tenant también es nuevo, y apagar la nube ya sólo servía para probar un
 * equipo distinto del que se vende.
 */
export function limpiarDatosE2E(): string {
    const dir = dirDatosE2E();

    if (!dir.endsWith(".e2e")) {
        throw new Error(
            `Me niego a borrar ${dir}: no termina en ".e2e", así que no es la carpeta del test.`,
        );
    }

    fs.rmSync(dir, { recursive: true, force: true });

    return dir;
}

/**
 * Deja la base local ilegible, que es la avería que la pantalla de recuperación existe para
 * resolver: un fichero corrupto, no un fichero borrado. Se llama con la app cerrada (entre dos
 * recorridos), porque en Windows no se puede reemplazar mientras SQLite lo tiene abierto.
 *
 * Los `-wal` y `-shm` se van con ella: dejarlos sería dejar pistas de una base que ya no existe,
 * y SQLite intentaría reproducir un diario que no le corresponde.
 */
export function romperBaseDeDatos(): void {
    const dir = dirDatosE2E();
    if (!dir.endsWith(".e2e")) {
        throw new Error(`Me niego a tocar ${dir}: no es la carpeta del test.`);
    }

    const db = path.join(dir, "data.db");
    if (!fs.existsSync(db)) {
        throw new Error(`No hay ${db} que romper: el recorrido anterior no dejó equipo.`);
    }

    for (const extra of ["data.db-wal", "data.db-shm"]) {
        fs.rmSync(path.join(dir, extra), { force: true });
    }
    // La cabecera de un SQLite son 16 bytes fijos; con esto deja de serlo.
    fs.writeFileSync(db, "esto no es una base de datos\n".repeat(64), "utf8");
}


/**
 * Deja en la carpeta de copias una que NO es una base de datos, con fecha más reciente que las
 * buenas para que la pantalla la ofrezca la primera ("Última copia").
 *
 * Una copia se corrompe en el disco como cualquier otro fichero, y el daño de no detectarlo es
 * grande: si `prepare_restore` no validara ANTES de tocar la `data.db`, un intento con una copia
 * mala dejaría al equipo peor de lo que estaba, justo el día de la avería. Que la validación
 * existe lo prueba Rust; lo que no prueba nadie es que la PANTALLA lo diga y deje elegir otra.
 */
export function plantarCopiaCorrupta(): void {
    const dir = dirDatosE2E();
    if (!dir.endsWith(".e2e")) {
        throw new Error(`Me niego a tocar ${dir}: no es la carpeta del test.`);
    }

    const copias = path.join(dir, "backups");
    fs.mkdirSync(copias, { recursive: true });
    // El nombre es el que reconoce `list_backups`: `data-<epoch ms>.db.gz`. El contenido no es
    // gzip ni SQLite: el formato se reconoce por el contenido, así que llega a la validación.
    fs.writeFileSync(
        path.join(copias, `data-${Date.now()}.db.gz`),
        "esto tampoco es una base de datos\n".repeat(64),
        "utf8",
    );
}

/**
 * La clave de la licencia de la tanda. La emite `onPrepare` y la comparten todos los recorridos,
 * porque comparten equipo (ver las recetas de `wdio.conf.ts`).
 */
export function licenciaDelRecorrido(): string {
    const clave = (process.env.TPV_E2E_LICENCIA ?? "").trim();
    if (!clave) {
        throw new Error(
            "No hay licencia para este recorrido. La emite `onPrepare` al empezar la tanda: si falta,\n" +
                "es que no llegó a emitirse (el motivo sale al principio del informe).",
        );
    }
    return clave;
}

/** Carga el `.env` de la raíz sin dependencias (mismo formato que `scripts/tpv-license.mjs`). */
export function cargarDotEnv(): void {
    let txt: string;
    try {
        txt = fs.readFileSync(path.join(RAIZ, ".env"), "utf8");
    } catch {
        return;
    }
    for (const linea of txt.split(/\r?\n/)) {
        const l = linea.trim();
        if (!l || l.startsWith("#")) continue;
        const eq = l.indexOf("=");
        if (eq === -1) continue;
        const clave = l.slice(0, eq).trim();
        const valor = l.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (clave && process.env[clave] === undefined) process.env[clave] = valor;
    }
}
