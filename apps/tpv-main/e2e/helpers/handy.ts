// La Handy de Android en los E2E: el emulador, el APK, Appium y la sesión en la WebView.
//
// La Main es la app de escritorio que mueve WDIO (`browser`, por `tauri-driver`). La Handy es la app
// de Android en un emulador, y la mueve una SEGUNDA sesión, de Appium, que abre el propio recorrido
// con `abrirHandy()`. No van juntas en un multiremote: `@wdio/tauri-service` está hecho para una sola
// app de escritorio, y mezclarlo con Android en la misma sesión es pelearse con él. Así cada una va
// por su driver y el recorrido las tiene a las dos a mano.
//
// Appium vive fuera del repo, en una carpeta por máquina (`appiumHome()`), como `tauri-driver` vive
// en `~/.cargo`: trae unos 190 paquetes que sólo hacen falta aquí, y en una ruta larga Windows no
// llega a extraer sus APK. Se prepara una vez con lo que dice el README.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { remote } from "webdriverio";

import { RAIZ } from "./entorno.js";
import { diferencias, huellaDelCodigo, type Huella } from "./huella.js";

/** El paquete de la app. Es el mismo que el de producción: el emulador es de pruebas. */
const PAQUETE = "com.altarialights.tpv";

/** El APK de depuración (sólo ése deja entrar a Appium en la WebView) y su huella. */
export const APK = path.join(RAIZ, "target", "e2e", "tpv-e2e-handy.apk");
export const HUELLA_APK = path.join(RAIZ, "target", "e2e", "tpv-e2e-handy.huella.json");

const PUERTO_APPIUM = 4723;

/** El SDK de Android: el de las variables de siempre o el que instala Android Studio. */
export function sdkAndroid(): string {
    return (
        process.env.ANDROID_HOME ??
        process.env.ANDROID_SDK_ROOT ??
        path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Android", "Sdk")
    );
}

/** El JDK de Android Studio, que es el que compila el proyecto Android. */
export function jdkAndroid(): string | undefined {
    if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
    const jbr = "C:/Program Files/Android/Android Studio/jbr";
    return fs.existsSync(jbr) ? jbr : undefined;
}

/** Dónde está Appium en esta máquina. */
function appiumHome(): string {
    return (
        process.env.TPV_E2E_APPIUM_HOME ??
        path.join(process.env.LOCALAPPDATA ?? os.homedir(), "tpv-e2e", "appium")
    );
}

function adb(...args: string[]): string {
    return execFileSync(path.join(sdkAndroid(), "platform-tools", "adb.exe"), args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/**
 * El dispositivo Android de la tanda: el de `TPV_E2E_HANDY_SERIAL` o el único conectado.
 *
 * Con dos conectados no se elige uno al azar: la tanda le borra los datos a la app, y hacérselo al
 * teléfono de alguien por haber dejado el cable puesto sería un disgusto.
 */
export function dispositivoAndroid(): string {
    const pedido = process.env.TPV_E2E_HANDY_SERIAL;
    const conectados = adb("devices")
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter(([serie, estado]) => serie && estado === "device")
        .map(([serie]) => serie);

    if (pedido) {
        if (!conectados.includes(pedido)) {
            throw new Error(`TPV_E2E_HANDY_SERIAL=${pedido}, pero no está conectado (adb devices: ${conectados.join(", ") || "ninguno"}).`);
        }
        return pedido;
    }
    if (conectados.length === 1) return conectados[0];
    if (conectados.length === 0) {
        throw new Error(
            "No hay ningún Android conectado. Arranca el emulador:\n" +
                `  "${path.join(sdkAndroid(), "emulator", "emulator.exe")}" -avd Pixel_7 -no-snapshot-save`,
        );
    }
    throw new Error(
        `Hay ${conectados.length} Android conectados (${conectados.join(", ")}). Di cuál con TPV_E2E_HANDY_SERIAL: ` +
            "la tanda le borra los datos a la app.",
    );
}

/** Se niega a arrancar si el APK no es el de ESTE código (lo mismo que `exigirBinarioAlDia`). */
export function exigirApkAlDia(): void {
    const consejo = "Recompílalo:  pnpm --filter @tpv/main build:e2e:android";
    if (!fs.existsSync(APK)) throw new Error(`No hay APK de la Handy (${APK}).\n${consejo}`);

    let guardada: Huella;
    try {
        guardada = JSON.parse(fs.readFileSync(HUELLA_APK, "utf8")) as Huella;
    } catch {
        throw new Error(`No hay huella del APK (${HUELLA_APK}).\n${consejo}`);
    }
    const actual = huellaDelCodigo();
    if (guardada.total === actual.total) return;

    const cambios = diferencias(guardada, actual);
    throw new Error(
        `El APK de la Handy no corresponde al código: ${cambios.length} ficheros han cambiado.\n` +
            `${cambios.slice(0, 12).map((c) => `    ${c}`).join("\n")}\n  ${consejo}`,
    );
}

/** Appium y su driver de Android, instalados en `appiumHome()`. */
export function exigirAppium(): string {
    const entrada = path.join(appiumHome(), "node_modules", "appium", "index.js");
    const driver = path.join(appiumHome(), "node_modules", "appium-uiautomator2-driver", "package.json");
    if (!fs.existsSync(entrada) || !fs.existsSync(driver)) {
        throw new Error(
            `No está Appium en ${appiumHome()}. Una vez por máquina:\n` +
                `  mkdir "${appiumHome()}" && cd "${appiumHome()}"\n` +
                '  echo {"private":true} > package.json\n' +
                "  pnpm add appium@3.9.0 appium-uiautomator2-driver@8.7.3",
        );
    }
    return entrada;
}

/** Instala el APK de la tanda encima del que haya (conserva nada: la sesión borra los datos). */
export function instalarApk(serie: string): void {
    adb("-s", serie, "install", "-r", APK);
}

/**
 * Arranca Appium y espera a que conteste. Su salida va a `target/e2e/appium.log`, que es lo primero
 * que hay que mirar si la Handy no abre.
 */
export async function arrancarAppium(): Promise<ChildProcess> {
    const entrada = exigirAppium();
    const log = fs.openSync(path.join(RAIZ, "target", "e2e", "appium.log"), "w");
    const jdk = jdkAndroid();
    // WDIO corre bajo el cargador de TypeScript (`tsx`, por NODE_OPTIONS), y Appium lo heredaría:
    // buscaría un tsconfig en su carpeta y se cerraría al arrancar. Appium es JavaScript, sin más.
    const entorno = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "NODE_OPTIONS" && !k.startsWith("TSX_")),
    );
    const proceso = spawn(
        process.execPath,
        [
            entrada,
            "--port",
            String(PUERTO_APPIUM),
            // El chromedriver tiene que ser el de la WebView del emulador, que se actualiza sola.
            "--allow-insecure",
            "uiautomator2:chromedriver_autodownload",
            "--log-level",
            "info",
        ],
        {
            cwd: appiumHome(),
            stdio: ["ignore", log, log],
            env: {
                ...entorno,
                APPIUM_HOME: appiumHome(),
                ANDROID_HOME: sdkAndroid(),
                ANDROID_SDK_ROOT: sdkAndroid(),
                ...(jdk ? { JAVA_HOME: jdk } : {}),
            },
        },
    );

    const hasta = Date.now() + 60_000;
    while (Date.now() < hasta) {
        if (proceso.exitCode !== null) {
            throw new Error(`Appium se cerró al arrancar (código ${proceso.exitCode}). Mira target/e2e/appium.log.`);
        }
        try {
            const r = await fetch(`http://127.0.0.1:${PUERTO_APPIUM}/status`);
            if (r.ok) return proceso;
        } catch {
            /* todavía no escucha */
        }
        await new Promise((ok) => setTimeout(ok, 500));
    }
    proceso.kill();
    throw new Error("Appium no contestó en un minuto. Mira target/e2e/appium.log.");
}

/**
 * Abre la app en la Handy, recién instalada (Appium le borra los datos al empezar), y devuelve la
 * sesión ya dentro de su WebView, que es donde están los mismos botones que en la Main.
 */
export async function abrirHandy(): Promise<WebdriverIO.Browser> {
    const serie = process.env.TPV_E2E_HANDY_SERIAL ?? dispositivoAndroid();
    const handy = await remote({
        hostname: "127.0.0.1",
        port: PUERTO_APPIUM,
        logLevel: "error",
        waitforTimeout: 20_000,
        connectionRetryTimeout: 180_000,
        capabilities: {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:udid": serie,
            "appium:appPackage": PAQUETE,
            "appium:appActivity": ".MainActivity",
            // Una Handy nueva en cada sesión: se borran los datos de la app (y con ellos su
            // identidad y su emparejamiento). Es lo que pide la tanda, que estrena negocio.
            "appium:noReset": false,
            "appium:chromedriverAutodownload": true,
            "appium:newCommandTimeout": 600,
        } as WebdriverIO.Capabilities,
    });

    // La WebView tarda en aparecer como contexto: primero arranca la actividad.
    const web = await handy.waitUntil(
        async () => {
            const contextos = (await handy.getContexts()).map(String);
            return contextos.find((c) => c.startsWith("WEBVIEW")) ?? false;
        },
        { timeout: 90_000, timeoutMsg: "La app de la Handy no llegó a abrir su WebView" },
    );
    await handy.switchContext(web);
    await handy.waitUntil(
        async () => (await handy.execute(() => document.body?.innerText.trim().length ?? 0)) > 0,
        { timeout: 60_000, timeoutMsg: "La WebView de la Handy no pintó nada" },
    );
    return handy;
}

/**
 * Cierra la app de la Handy y su sesión, sin tumbar el recorrido si ya estaban cerradas.
 *
 * La app se cierra de verdad, no sólo la sesión de Appium: si se queda abierta sigue conectada al
 * negocio, y los recorridos de detrás (el de la licencia la anula y la reactiva) dejan de probar
 * lo que dicen con una Handy por medio que nadie mira.
 */
export async function cerrarHandy(handy: WebdriverIO.Browser | null): Promise<void> {
    if (!handy) return;
    await handy.switchContext("NATIVE_APP").catch(() => {});
    await handy.terminateApp(PAQUETE).catch(() => {});
    await handy.deleteSession().catch(() => {
        /* ya cerrada */
    });
}

/** Captura de la Handy para el informe de un fallo. */
export async function capturaHandy(handy: WebdriverIO.Browser | null, destino: string): Promise<void> {
    if (!handy) return;
    await handy.saveScreenshot(destino).catch(() => {
        /* si ni la captura sale, el error del paso ya es lo importante */
    });
}
