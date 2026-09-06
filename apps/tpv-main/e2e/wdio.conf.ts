// Configuración de WebdriverIO para el E2E del camino del dinero (TEST-01).
//
// NO entra en `turbo run test`: necesita un binario compilado y una licencia real, así que no
// puede romperle la tanda a quien sólo quiere correr los tests normales. Se lanza a mano:
//
//   pnpm --filter @tpv/main build:e2e     (una vez por cambio de código)
//   pnpm --filter @tpv/main test:e2e
//
// El aislamiento del AppData depende ENTERO de que el binario sea el compilado con
// `tauri.e2e.conf.json`. Por eso `onPrepare` lo verifica antes de que arranque nada, y sólo
// después borra la carpeta de datos: si el orden fuera el contrario y el binario estuviera mal,
// habríamos borrado lo que el test iba a machacar de todas formas.


import fs from "node:fs";
import path from "node:path";

import { browser } from "@wdio/globals";

import {
    APP_ID_E2E,
    BINARIO,
    DIR_E2E,
    cargarDotEnv,
    exigirBinarioE2E,
    licenciaDePruebas,
    limpiarDatosE2E,
} from "./helpers/entorno.js";

export const config: WebdriverIO.Config = {
    runner: "local",

    tsConfigPath: "./tsconfig.json",

    specs: ["./specs/**/*.e2e.ts"],

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
                // Los dos capturadores de logs van por el mismo puente que no existe (ver el hook
                // `before`): activarlos sólo añade intentos que fallan. Los logs de la app están
                // en %APPDATA%\com.altarialights.tpv.e2e\logs.
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

    // El recorrido es uno solo y en orden: a partir del primer fallo, lo que venga detrás son
    // consecuencias, no hallazgos.
    bail: 1,

    waitforTimeout: 20_000,
    connectionRetryTimeout: 120_000,
    connectionRetryCount: 3,

    framework: "mocha",
    reporters: ["spec"],

    mochaOpts: {
        ui: "bdd",
        // El recorrido es una secuencia: sin esto, un fallo en el paso 3 deja diez minutos de
        // errores que sólo dicen que el paso 3 falló. (`bail` de la raíz cuenta ficheros, no tests.)
        bail: true,
        // Activar la licencia sale a internet; el primer arranque migra la base. Un timeout corto
        // aquí no detecta un fallo antes: lo convierte en intermitente.
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
            console.log("[e2e] puente de depuración desactivado (la app no lleva el plugin)");
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

    onPrepare() {
        cargarDotEnv();

        // Este orden importa: primero se comprueba que el binario es el de E2E, y sólo entonces se
        // borra la carpeta de datos. Verificar después sería borrar antes de saber qué se lanza.
        exigirBinarioE2E(BINARIO);
        licenciaDePruebas();

        const dir = limpiarDatosE2E();
        console.log(`\n[e2e] binario   ${BINARIO}`);
        console.log(`[e2e] identidad ${APP_ID_E2E}`);
        console.log(`[e2e] datos     ${dir} (borrado: el test estrena equipo)\n`);
    },
};
