// Configuración de WebdriverIO para los E2E del TPV (TEST-01).
//
// NO entra en `turbo run test`: necesita un binario compilado y licencias reales, así que no puede
// romperle la tanda a quien sólo quiere correr los tests normales. Se lanza a mano:
//
//   pnpm --filter @tpv/main build:e2e     (una vez por cambio de código)
//   pnpm --filter @tpv/main test:e2e
//
// El aislamiento del AppData depende ENTERO de que el binario sea el compilado con
// `tauri.e2e.conf.json`, y de que ese binario sea el de ESTE código. Las dos cosas se comprueban en
// `onPrepare` antes de que arranque nada, y sólo después se toca la carpeta de datos.

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { browser } from "@wdio/globals";

import {
    APP_ID_E2E,
    BINARIO,
    DIR_E2E,
    cargarDotEnv,
    exigirBinarioAlDia,
    exigirBinarioE2E,
    limpiarDatosE2E,
    plantarCopiaCorrupta,
    romperBaseDeDatos,
} from "./helpers/entorno.js";
import {
    arrancarAppium,
    dispositivoAndroid,
    exigirApkAlDia,
    exigirAppium,
    instalarApk,
} from "./helpers/handy.js";
import { emitirLicencia, revocar } from "./helpers/licencias.js";

/**
 * La Handy de Android entra en la tanda salvo que se pida lo contrario: hace falta un emulador (o
 * un teléfono) conectado, su APK y Appium (ver el README). `TPV_E2E_SIN_HANDY=1` corre sólo los
 * recorridos de la Main.
 */
const CON_HANDY = process.env.TPV_E2E_SIN_HANDY !== "1";

/** El servidor de Appium de la tanda, para pararlo al terminar. */
let appium: ChildProcess | null = null;

/**
 * Qué hay que hacerle al equipo antes de arrancar cada recorrido.
 *
 * La tanda estrena UN equipo y lo va pasando de recorrido en recorrido, en el orden de `specs`: la
 * venta lo estrena, los tres tramos de copias le rompen la base y lo recuperan, y el de la licencia
 * se la anula y la caduca al final. Antes cada recorrido estrenaba el suyo, con su licencia y por
 * tanto con su base de Turso: eran cuatro bases por tanda, que no se borran solas, para probar
 * cosas que podían compartir equipo (TEST-03).
 *
 * Lo que sigue siendo de cada recorrido es lo que hay que hacerle al equipo con la app CERRADA
 * —estrenarlo o romperle la base—, porque con la app abierta no se puede: en Windows SQLite tiene
 * la base cogida. Por eso vive aquí, en `beforeSession`, y no dentro de los recorridos.
 */
type Receta = {
    equipo: "nuevo" | "el de antes" | "el de antes, roto";
    /** Deja además una copia inservible entre las buenas. Sólo la quiere el tramo que la prueba. */
    copiaMala?: boolean;
};

const RECETAS: Record<string, Receta> = {
    "venta.e2e.ts": { equipo: "nuevo" },
    // Justo detrás de la venta: vende en su mesa y con su carta, antes de que las copias rompan nada.
    "handy.e2e.ts": { equipo: "el de antes" },
    "copias-1-copia.e2e.ts": { equipo: "el de antes" },
    "copias-2-recuperar.e2e.ts": { equipo: "el de antes, roto", copiaMala: true },
    "copias-3-nube.e2e.ts": { equipo: "el de antes, roto" },
    // El último, y tiene que serlo: anula y caduca la licencia con la que funciona todo el equipo.
    "licencia.e2e.ts": { equipo: "el de antes" },
};

/** La licencia emitida para esta tanda, para revocarla al terminar. */
let emitida: { licenseId: string } | null = null;

function receta(specs: string[]): { nombre: string; receta: Receta } {
    const nombre = path.basename(specs[0] ?? "");
    const r = RECETAS[nombre];
    if (!r) {
        throw new Error(
            `El recorrido "${nombre}" no tiene receta en wdio.conf.ts.\n` +
                "Cada uno declara ahí qué equipo necesita: sin eso no se sabe si hay que borrar la\n" +
                "carpeta de datos, y borrarla por defecto se llevaría por delante el equipo que el\n" +
                "recorrido anterior dejó preparado.",
        );
    }
    return { nombre, receta: r };
}

export const config: WebdriverIO.Config = {
    runner: "local",

    tsConfigPath: "./tsconfig.json",

    // En orden explícito y no por glob: cada recorrido recibe el equipo que deja el anterior.
    specs: [
        "./specs/venta.e2e.ts",
        ...(CON_HANDY ? ["./specs/handy.e2e.ts"] : []),
        "./specs/copias-1-copia.e2e.ts",
        "./specs/copias-2-recuperar.e2e.ts",
        "./specs/copias-3-nube.e2e.ts",
        "./specs/licencia.e2e.ts",
    ],

    // Una sola instancia: la app es de escritorio y hay un único AppData.
    maxInstances: 1,

    capabilities: [
        {
            browserName: "tauri",
            "tauri:options": {
                application: BINARIO,
            },
        } as WebdriverIO.Capabilities,
    ],

    services: [
        [
            "@wdio/tauri-service",
            {
                // `embedded` metería un servidor WebDriver DENTRO de la app (tauri-plugin-wdio):
                // una puerta de depuración en el binario que se distribuye. `external` usa
                // `tauri-driver` como proceso aparte y no toca el código de la app.
                driverProvider: "external",
                autoInstallTauriDriver: true,
                autoDownloadEdgeDriver: true,
                // Los dos capturadores de logs van por el mismo puente que no existe (ver
                // `beforeSuite`): activarlos sólo añade intentos que fallan. Los logs de la app
                // están en %APPDATA%\com.altarialights.tpv.e2e\logs.
                captureBackendLogs: false,
                captureFrontendLogs: false,
                // El primer arranque migra la base y comprueba la licencia contra la red.
                startTimeout: 120_000,
            },
        ],
    ],

    // "error" y no "warn": el servicio avisa por cada comando de que no encuentra el puente de
    // depuración (ver `beforeSuite`), y son cientos de líneas que dicen algo que ya sabemos.
    logLevel: "error",

    // La tanda no se para en el primer recorrido rojo: los tramos de copias rompen y recuperan el
    // equipo por su cuenta, así que uno puede fallar y el siguiente seguir diciendo algo. Pero van
    // encadenados, y un fallo suele arrastrar a los de detrás: en un informe rojo, lee el PRIMERO.
    // Lo que sí se corta es el recorrido por dentro (`mochaOpts.bail`).
    bail: 0,

    waitforTimeout: 20_000,
    connectionRetryTimeout: 120_000,
    connectionRetryCount: 3,

    framework: "mocha",
    reporters: ["spec"],

    mochaOpts: {
        ui: "bdd",
        // Cada recorrido es una secuencia: sin esto, un fallo en el paso 3 deja diez minutos de
        // errores que sólo dicen que el paso 3 falló.
        bail: true,
        // Activar la licencia sale a internet; el primer arranque migra la base; la reconciliación
        // espera a la nube. Un timeout corto aquí no detecta un fallo antes: lo vuelve intermitente.
        timeout: 300_000,
    },

    /**
     * Le dice al servicio, de una vez, que esta app no lleva `tauri-plugin-wdio`.
     *
     * Sin esto el E2E tarda ocho minutos en llegar al paso 3. El servicio intenta "enfocar la
     * ventana activa" antes de cada `$`, `$$` y `click`, y para eso pregunta por el puente
     * `window.wdioTauri` que instala ese plugin. La app no lo lleva —y no debe llevarlo: es un
     * servidor de depuración dentro del binario que se distribuye—, así que la pregunta falla…
     * tras 100 reintentos de 50 ms. Son 6,5 segundos por comando, y el servicio no recuerda la
     * respuesta de una vez para la siguiente.
     *
     * Al hacer que el puente falle en el acto, `getWindowStates` devuelve una lista vacía y el
     * enfoque automático se salta solo. No se pierde nada: esta app tiene UNA ventana.
     */
    beforeSuite() {
        const conPuente = browser as unknown as {
            tauri?: { execute?: unknown; __sinPuente?: boolean };
        };
        if (conPuente.tauri && !conPuente.tauri.__sinPuente) {
            conPuente.tauri.__sinPuente = true;
            conPuente.tauri.execute = async () => {
                throw new Error("Esta app no lleva tauri-plugin-wdio (a propósito).");
            };
        }
    },

    /**
     * Un E2E que falla y no deja una imagen obliga a reproducirlo para saber qué pasaba. La
     * captura se guarda con el nombre del paso, en una carpeta que no se versiona.
     */
    async afterTest(test, _context, { passed }) {
        if (passed) return;

        const dir = path.join(DIR_E2E, "fallos");
        fs.mkdirSync(dir, { recursive: true });
        const nombre = test.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
        const destino = path.join(dir, `${nombre}.png`);

        await browser.saveScreenshot(destino).catch(() => {
            /* si ni la captura sale, el error del test ya es lo importante */
        });
        console.log(`[e2e] captura del fallo: ${destino}`);
    },

    async onPrepare(_config, capabilities) {
        cargarDotEnv();

        try {
            // Este orden importa: primero se comprueba que el binario es el de E2E y que es el de
            // este código, y sólo entonces se toca la carpeta de datos. Verificar después sería
            // borrar antes de saber qué se lanza.
            exigirBinarioE2E(BINARIO);
            exigirBinarioAlDia();
            // La Handy, antes de emitir la licencia: si falta el emulador o el APK no gasta una.
            if (CON_HANDY) {
                exigirApkAlDia();
                exigirAppium();
                // Los recorridos lo heredan por el entorno, como la licencia.
                process.env.TPV_E2E_HANDY_SERIAL = dispositivoAndroid();
            }
        } catch (e) {
            // Salir aquí, y no dejar que la excepción salga del hook: WDIO se limita a registrar el
            // error de un hook y CONTINÚA, así que arrancaba la app igual y el motivo real acababa
            // disfrazado del fallo de un paso, un minuto más tarde. Estas comprobaciones dicen que
            // el test no se puede ejecutar; no son un test que falla.
            console.error(`\n[e2e] NO SE PUEDE EJECUTAR\n\n${(e as Error).message}\n`);
            process.exit(1);
        }

        console.log(`\n[e2e] binario   ${BINARIO}`);
        console.log(`[e2e] identidad ${APP_ID_E2E}\n`);

        // La licencia de la tanda: UNA, recién emitida, y la misma para todos los recorridos porque
        // comparten equipo. No sirve una fija guardada en el `.env`: activar provisiona el tenant y
        // le graba el hash de `0001_inicial.sql`, así que en cuanto esa migración cambia —cosa
        // permitida mientras no haya clientes en producción— el tenant viejo deja de migrar y la
        // activación falla con `migration_altered`. Y un tenant que ya tiene historia arrastraría
        // por catch-up lo que dejó la tanda anterior. `process.env` lo heredan los procesos de cada
        // recorrido, que es como les llega.
        const lic = await emitirLicencia(`E2E ${new Date().toISOString()}`);
        process.env.TPV_E2E_LICENCIA = lic.key;
        // El id, además de la clave: el recorrido de licencia necesita poder revocarla y caducarla
        // desde el API de administración.
        process.env.TPV_E2E_LICENCIA_ID = lic.licenseId;
        emitida = { licenseId: lic.licenseId };
        console.log(`[e2e] licencia  ${lic.licenseId}`);

        if (CON_HANDY) {
            const serie = process.env.TPV_E2E_HANDY_SERIAL!;
            try {
                instalarApk(serie);
                appium = await arrancarAppium();
            } catch (e) {
                // Como arriba: un hook que lanza no para WDIO. Y la licencia ya emitida se revoca, que
                // `onComplete` no llega a correr tras un `exit`.
                console.error(`\n[e2e] NO SE PUEDE EJECUTAR (Handy)\n\n${(e as Error).message}\n`);
                await revocar(lic.licenseId).catch(() => {});
                process.exit(1);
            }
            console.log(`[e2e] handy     ${serie} (Appium en marcha)`);
        }

        void capabilities;
    },

    /** Prepara el equipo que pide este recorrido, antes de que la app arranque. */
    beforeSession(_config, _capabilities, specs) {
        const { nombre, receta: r } = receta(specs as string[]);

        if (r.equipo === "nuevo") {
            limpiarDatosE2E();
        } else if (r.equipo === "el de antes, roto") {
            romperBaseDeDatos();
            if (r.copiaMala) plantarCopiaCorrupta();
        }

        console.log(`\n[e2e] ${nombre} · equipo ${r.equipo}\n`);
    },

    /**
     * La licencia de la tanda se revoca al terminar: queda marcada y no se confunde con una de
     * verdad en el panel. Best-effort — que falle esto no puede tumbar una tanda que ha pasado.
     */
    async onComplete() {
        appium?.kill();
        if (!emitida) return;
        const { licenseId } = emitida;
        await revocar(licenseId).catch((e: unknown) => {
            console.log(`[e2e] no se pudo revocar la licencia de la tanda (${licenseId}): ${e}`);
        });
    },
};
