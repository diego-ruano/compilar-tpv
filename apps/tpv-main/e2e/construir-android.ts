#!/usr/bin/env node
//
// Compila el APK de la Handy para los E2E y lo deja en `target/e2e/` con su huella, como
// `construir.ts` hace con el binario de la Main.
//
// Es el APK de DEPURACIÓN porque sólo ése deja a Appium entrar en la WebView (en uno de release la
// depuración remota está cerrada, y así debe seguir). Va sin la información de depuración de Rust:
// con ella pesa más de 500 MB y no cabe en el emulador; sin ella, unos 130.
//
// Por defecto para el emulador (x86_64). Para un teléfono de verdad:
//   TPV_E2E_ANDROID_TARGET=aarch64 pnpm --filter @tpv/main build:e2e:android

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { DIR_APP } from "./helpers/entorno.js";
import { APK, HUELLA_APK, jdkAndroid, sdkAndroid } from "./helpers/handy.js";
import { huellaDelCodigo } from "./helpers/huella.js";

const objetivo = process.env.TPV_E2E_ANDROID_TARGET ?? "x86_64";
const RECIEN_COMPILADO = path.join(
    DIR_APP,
    "src-tauri",
    "gen",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "universal",
    "debug",
    "app-universal-debug.apk",
);

const sdk = sdkAndroid();
const ndks = fs.existsSync(path.join(sdk, "ndk")) ? fs.readdirSync(path.join(sdk, "ndk")).sort() : [];
const ndk = process.env.NDK_HOME ?? process.env.ANDROID_NDK_HOME ?? (ndks.length ? path.join(sdk, "ndk", ndks[ndks.length - 1]) : undefined);
const jdk = jdkAndroid();
if (!ndk || !jdk) {
    console.error(
        `\n  ✖ Falta ${!ndk ? "el NDK de Android" : "el JDK de Android Studio"}: ver docs/guias/compilar-android.md\n`,
    );
    process.exit(1);
}

// Igual que en `construir.ts`: el CLI de Tauri por su entrada JS y con este mismo node.
const require_ = createRequire(import.meta.url);
const tauriCli = require_.resolve("@tauri-apps/cli/tauri.js", { paths: [DIR_APP] });

// La huella ANTES de compilar: lo que se guarda es lo que de verdad entró en el APK.
const huella = huellaDelCodigo();

// Si quedó un APK de otra compilación, que no se confunda con éste.
fs.rmSync(RECIEN_COMPILADO, { force: true });

console.log(`→ tauri android build --debug --apk --target ${objetivo}`);
execFileSync(process.execPath, [tauriCli, "android", "build", "--debug", "--apk", "--target", objetivo], {
    cwd: DIR_APP,
    stdio: "inherit",
    env: {
        ...process.env,
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: sdk,
        NDK_HOME: ndk,
        ANDROID_NDK_HOME: ndk,
        JAVA_HOME: jdk,
        PATH: `${path.join(jdk, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        // Sin la información de depuración de Rust: el APK baja de ~520 MB a ~130.
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_DEV_STRIP: "debuginfo",
    },
});

if (!fs.existsSync(RECIEN_COMPILADO)) {
    console.error(`\n  ✖ El build terminó pero no hay APK en ${RECIEN_COMPILADO}\n`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(APK), { recursive: true });
fs.copyFileSync(RECIEN_COMPILADO, APK);
fs.writeFileSync(HUELLA_APK, JSON.stringify(huella), "utf8");

const mb = (fs.statSync(APK).size / 1024 / 1024).toFixed(0);
console.log(`\n  ✔ APK de la Handy listo: ${APK} (${mb} MB, ${objetivo})`);
console.log(`    huella: ${huella.total.slice(0, 12)}… (${Object.keys(huella.ficheros).length} ficheros)\n`);
