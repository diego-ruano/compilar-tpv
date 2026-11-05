// La Main y la Handy, a la vez.
//
// La Main es el equipo que deja la venta (con su carta, su mesa y su licencia). La Handy es la app
// de Android en un emulador, recién instalada, y la mueve una sesión de Appium que abre este
// recorrido (`helpers/handy.ts`). Es la forma en que se va a usar: la Main en Windows y las Handy
// en teléfonos.
//
// Prueba lo que sólo se ve con las dos encendidas: que una Handy se vincula con el código de la
// Main, que lo que apunta en una mesa le llega a la Main por la nube y se cobra allí, que la Handy
// ve el resultado, y que un trabajador que entra sin PIN lo hace también desde el teléfono.

import fs from "node:fs";
import path from "node:path";

import { $, browser } from "@wdio/globals";

import { entrar, ficharYEntrar } from "../helpers/arranque.js";
import { DIR_E2E, cargarDotEnv } from "../helpers/entorno.js";
import { MESA, PIN, PRODUCTO } from "../helpers/equipo.js";
import { abrirHandy, capturaHandy, cerrarHandy } from "../helpers/handy.js";
import { esperarNubeAlDia } from "../helpers/nube.js";
import { gestosEn, irA, leerDeLaApp, pulsar, pulsarXPath } from "../helpers/ui.js";
import {
    abrirMesa,
    anadirLineas,
    cerrarElModalDeLaMesa,
    cobrarTodoEnEfectivo,
    esperarMesa,
    esperarMesaLibre,
    esperarTotalPendiente,
} from "../helpers/vender.js";

cargarDotEnv();

/** Una camarera que entra sin PIN (`Usuarios.Sin_PIN`): la da de alta la Main y entra en la Handy. */
const CAMARERA = { nombre: "Carla", apellido: "E2E", email: "carla.e2e@bar.test" };

/** Una caña, que la Handy apunta y la Main cobra con un billete de 5. */
const IMPORTE = "5,00";
const BILLETE = "5€";

let handy: WebdriverIO.Browser | null = null;
let codigo = "";
let idMesa = "";

/** Los gestos sobre la Handy. Falla claro si un paso anterior no llegó a abrirla. */
function enLaHandy(): { b: WebdriverIO.Browser } & ReturnType<typeof gestosEn> {
    if (!handy) throw new Error("La Handy no está abierta: falló un paso anterior.");
    return { b: handy, ...gestosEn(handy) };
}

/** Un campo de la ficha del trabajador, por su etiqueta (la ficha no lleva `id`). */
function campoDeLaFicha(etiqueta: string, tipo: "input" | "select" = "input") {
    return $(`//label[normalize-space(.)="${etiqueta}"]/following-sibling::${tipo}`);
}

describe("La Main y la Handy a la vez", () => {
    afterEach(async function () {
        if (this.currentTest?.state !== "failed") return;
        // `afterTest` de wdio.conf.ts ya guarda la pantalla de la Main; ésta es la del teléfono.
        const dir = path.join(DIR_E2E, "fallos");
        fs.mkdirSync(dir, { recursive: true });
        const nombre = (this.currentTest.title ?? "paso").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
        const destino = path.join(dir, `handy-${nombre}.png`);
        await capturaHandy(handy, destino);
        console.log(`[e2e] captura de la Handy: ${destino}`);
    });

    after(async () => {
        await cerrarHandy(handy);
    });

    it("1 · la Main entra y enseña el código para vincular una Handy", async () => {
        await ficharYEntrar(PIN);
        await irA("/Configuracion");
        await pulsar("Vincular Handy");

        // El primero es el código que se enseña; la lista de solicitudes repite "Código:" más abajo.
        const cifras = $('//div[starts-with(normalize-space(.), "Código:")]/span[contains(@class,"font-mono")]');
        await browser.waitUntil(async () => /^\d{6}$/.test((await cifras.getText()).trim()), {
            timeout: 60_000,
            timeoutMsg: "La Main no llegó a enseñar un código de 6 cifras",
        });
        codigo = (await cifras.getText()).trim();
    });

    it("2 · una Handy recién instalada se configura como Handy y pide vincularse con ese código", async () => {
        handy = await abrirHandy();
        const h = enLaHandy();

        await h.conTexto("h1", "¿Cómo vas a usar este dispositivo?").waitForDisplayed({ timeout: 60_000 });
        await h.pulsar("Configurar como Handy");

        await h.escribir("#handy-pair-code", codigo);
        await h.pulsar("Vincular dispositivo");
    });

    it("3 · la Main ve la solicitud y la acepta", async () => {
        // La lista de solicitudes se refresca sola: puede tardar unos segundos en salir.
        await pulsar("Aceptar", 90_000);
    });

    it("4 · la Handy queda vinculada y el administrador entra con su PIN", async () => {
        const h = enLaHandy();
        await h.conTexto("h2", "PIN de acceso").waitForDisplayed({ timeout: 180_000 });
        // Ya fichó la entrada en la Main al empezar, así que aquí entra sin volver a fichar.
        await entrar({ b: h.b, pin: PIN });
    });

    it("5 · la Handy apunta una caña en la mesa", async () => {
        const salones = await leerDeLaApp("load_layout");
        const mesa = salones[0]?.tables.find((t) => t.name === MESA);
        if (!mesa) throw new Error(`La Main no tiene la mesa ${MESA}: ¿corrió antes la venta?`);
        idMesa = mesa.id.replace(/^db-mesa-/, "");

        const h = enLaHandy();
        await abrirMesa(MESA, h.b);
        await anadirLineas(PRODUCTO, 1, h.b);
        await esperarTotalPendiente(IMPORTE, h.b);
    });

    it("6 · a la Main le llega lo que apuntó la Handy, y la cobra", async () => {
        // Lo apuntado viaja Handy → nube → Main: se espera a verlo en la base de la Main.
        await esperarMesa(idMesa, (e) => e !== "LIBRE" && !e.startsWith("el comando"), "ocupada", browser, 60_000);

        await abrirMesa(MESA);
        await esperarTotalPendiente(IMPORTE);
        await cobrarTodoEnEfectivo(BILLETE);
        // El modal de la mesa se queda abierto tras cobrar, y tapa el menú.
        await cerrarElModalDeLaMesa(MESA);
    });

    it("7 · la Handy ve la mesa libre después del cobro", async () => {
        await esperarMesaLibre(idMesa, enLaHandy().b, 60_000);
    });

    it("8 · la Main da de alta una camarera que entra sin PIN", async () => {
        await irA("/Trabajadores");
        // «Nuevo trabajador» es un enlace de la propia pantalla, no del menú.
        await irA("/Trabajadores/nuevo-trabajador");

        await campoDeLaFicha("Rol *", "select").waitForDisplayed({ timeout: 30_000 });
        await campoDeLaFicha("Rol *", "select").selectByVisibleText("Camarero");
        await campoDeLaFicha("Email *").setValue(CAMARERA.email);
        await pulsarXPath('//label[contains(normalize-space(.), "Entra sin PIN")]/input', "casilla «Entra sin PIN»");
        await campoDeLaFicha("Nombre *").setValue(CAMARERA.nombre);
        await campoDeLaFicha("Apellido").setValue(CAMARERA.apellido);

        await pulsar("Guardar trabajador");
        // Guardar vuelve a la lista de Trabajadores, que la nombra.
        await $(`//*[normalize-space(.)="${CAMARERA.nombre} ${CAMARERA.apellido}"]`).waitForExist({
            timeout: 30_000,
        });

        // La Handy lee la lista de usuarios de la nube: hasta que la Main no la ha subido, no sale.
        await esperarNubeAlDia();
    });

    it("9 · en la Handy, la camarera ficha y entra sin teclear nada", async () => {
        const h = enLaHandy();
        // Cerrar sesión vive en el menú lateral, que en el teléfono está plegado.
        await h.pulsarDelMenu(
            '//button[@title="Cerrar Sesión" or contains(normalize-space(.), "Cerrar Sesión")]',
            "botón de cerrar sesión",
        );
        await entrar({ b: h.b, usuario: `${CAMARERA.nombre} ${CAMARERA.apellido}`, pin: null });
    });
});
