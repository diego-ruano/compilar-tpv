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
import { emitirLicencia, revocar } from "./helpers/licencias.js";

/**
 * Qué equipo necesita cada recorrido, y en qué orden corren.
 *
 * Cada uno prepara el suyo en `beforeSession` en vez de compartir una preparación única, porque no
 * quieren lo mismo: la venta quiere un equipo recién instalado y sin nube; las copias necesitan la
 * nube encendida (la reconciliación es lo que desbloquea el login) y un tenant limpio; y el segundo
 * tramo de copias necesita justo lo contrario de una limpieza — el equipo del tramo anterior, con
 * la base rota.
 *
 * `licencia` dice cuál de las emitidas para esta tanda le toca (ver `onPrepare`). Los dos tramos
 * de copias comparten la suya porque comparten equipo, y por tanto tienen que compartir tenant.
 */
type Receta = {
    equipo: "nuevo" | "el de antes" | "el de antes, roto";
    nube: boolean;
    licencia: Licencia;
};

/**
 * Cada recorrido usa una licencia recién emitida, no una fija guardada en el `.env`.
 *
 * Se intentó lo otro y no aguanta: activar provisiona el tenant y le graba el hash de
 * `0001_inicial.sql`, así que en cuanto esa migración cambia —cosa permitida mientras no haya
 * clientes en producción— el tenant viejo deja de migrar y la activación falla con
 * `migration_altered`. Una licencia por tanda hace el recorrido hermético y deja el `.env` con una
 * sola cosa dentro: el token de administración.
 */
type Licencia = "venta" | "copias" | "licencia";

const LICENCIAS: Licencia[] = ["venta", "copias", "licencia"];

const RECETAS: Record<string, Receta> = {
    "venta.e2e.ts": { equipo: "nuevo", nube: false, licencia: "venta" },
    "copias-1-copia.e2e.ts": { equipo: "nuevo", nube: true, licencia: "copias" },
    "copias-2-recuperar.e2e.ts": { equipo: "el de antes, roto", nube: true, licencia: "copias" },
    "licencia.e2e.ts": { equipo: "nuevo", nube: false, licencia: "licencia" },
};

/** Las licencias emitidas para esta tanda, para revocarlas al terminar. */
const emitidas: Array<{ nombre: string; licenseId: string }> = [];

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

    // En orden explícito y no por glob: `copias-2` recupera el equipo que deja `copias-1`.
    specs: [
        "./specs/venta.e2e.ts",
        "./specs/copias-1-copia.e2e.ts",
        "./specs/copias-2-recuperar.e2e.ts",
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

    // Un recorrido que falla no invalida los demás: cada uno prepara su equipo y prueba una cosa
    // distinta. Lo que sí se corta es el recorrido por dentro (`mochaOpts.bail`).
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

        // Las licencias de la tanda. Se emiten aquí, una vez, porque los dos tramos de copias
        // comparten equipo y por tanto tienen que compartir tenant. `process.env` lo heredan los
        // procesos de cada recorrido, que es como les llega.
        for (const nombre of LICENCIAS) {
            const lic = await emitirLicencia(`E2E ${nombre} ${new Date().toISOString()}`);
            process.env[`TPV_E2E_LICENCIA_${nombre.toUpperCase()}`] = lic.key;
            // El id, además de la clave: el recorrido de licencia necesita poder revocarla y
            // caducarla desde el API de administración.
            process.env[`TPV_E2E_LICENCIA_ID_${nombre.toUpperCase()}`] = lic.licenseId;
            emitidas.push({ nombre, licenseId: lic.licenseId });
            console.log(`[e2e] licencia ${nombre}: ${lic.licenseId}`);
        }
        void capabilities;
    },

    /** Prepara el equipo que pide este recorrido, antes de que la app arranque. */
    beforeSession(_config, _capabilities, specs) {
        const { nombre, receta: r } = receta(specs as string[]);

        if (r.equipo === "nuevo") {
            limpiarDatosE2E(r.nube);
        } else if (r.equipo === "el de antes, roto") {
            romperBaseDeDatos();
            // Y una copia inservible entre las buenas: el recorrido comprueba que la pantalla la
            // rechaza sin dejar el equipo peor y deja elegir otra.
            plantarCopiaCorrupta();
        }

        process.env.TPV_E2E_LICENCIA =
            process.env[`TPV_E2E_LICENCIA_${r.licencia.toUpperCase()}`] ?? "";

        console.log(
            `\n[e2e] ${nombre} · equipo ${r.equipo} · nube ${r.nube ? "encendida" : "apagada"}\n`,
        );
    },

    /**
     * Las licencias de la tanda se revocan al terminar: quedan marcadas y no se confunden con una
     * de verdad en el panel. Best-effort — que falle esto no puede tumbar una tanda que ha pasado.
     */
    async onComplete() {
        for (const { nombre, licenseId } of emitidas) {
            await revocar(licenseId).catch((e: unknown) => {
                console.log(`[e2e] no se pudo revocar la licencia ${nombre} (${licenseId}): ${e}`);
            });
        }
    },
};
