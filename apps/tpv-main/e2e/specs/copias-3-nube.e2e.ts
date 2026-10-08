// Copias de seguridad · tercer tramo: volver sin copia local, sólo con la nube.
//
// El tramo anterior recupera desde una copia de este ordenador. Éste prueba **el otro botón de la
// misma pantalla**, y es el que de verdad importa: la copia local sólo existe si el disco sigue
// vivo. El día del robo, del disco muerto o del ordenador nuevo, «Recuperar el estado actual de la
// nube» es lo único que hay — y docs/arquitectura/recuperacion.md lo dice sin rodeos: *sin internet, una Main que perdió
// su `data.db` no vende*.
//
// Hasta ahora estaba probado por piezas —`syncBootstrap.test.ts` y `syncHistorico.test.ts` en el
// worker, `bootstrap_restaurar` en Rust— pero nadie había recorrido el camino entero: botón → nube
// → base local → reconciliación → login.
//
// Arranca sobre el equipo que dejó `copias-2` (ya recuperado y al día) con la `data.db` machacada
// otra vez. Hay copias locales en el disco, y se ignoran a propósito: aquí se prueba la otra
// salida.

import { $, browser, expect } from "@wdio/globals";

import { ficharYEntrar } from "../helpers/arranque.js";
import { CATEGORIA } from "../helpers/copias.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { PIN } from "../helpers/equipo.js";
import { conTexto, leerDeLaApp, pulsar } from "../helpers/ui.js";

cargarDotEnv();

describe("Copias de seguridad · volver sólo con la nube", () => {
    it("1 · con la base rota otra vez, la pantalla ofrece también la nube", async () => {
        await conTexto("h1", "Recuperar los datos de este TPV").waitForDisplayed({
            timeout: 120_000,
        });

        // El botón existe y está disponible aunque haya copias locales: son dos salidas, no una con
        // repuesto. Quien no tiene disco no puede depender de la lista de arriba.
        await conTexto("button", "Recuperar el estado actual de la nube").waitForDisplayed({
            timeout: 30_000,
        });
    });

    it("2 · se trae el estado de la nube y reconcilia", async () => {
        await pulsar("Recuperar el estado actual de la nube");

        const resultado = await browser.waitUntil(
            async () => {
                if (await conTexto("p", "Datos recuperados y sincronizados").isExisting()) {
                    return "ok";
                }
                if (await conTexto("p", "La recuperación no ha podido completarse").isExisting()) {
                    return await conTexto(
                        "div",
                        "La recuperación no ha podido completarse",
                    ).getText();
                }
                // El volcado tiene su propio modo de fallar —el tope de filas de SYNC-19— y ahí la
                // pantalla enseña un aviso en vez de la reconciliación. Se recoge porque es
                // justamente el caso que motivó partir la recuperación en dos fases.
                const error = await $('//div[contains(@class,"bg-danger-soft")]');
                if (await error.isDisplayed().catch(() => false)) return await error.getText();
                return false;
            },
            { timeout: 300_000, timeoutMsg: "La recuperación desde la nube no terminó ni bien ni mal" },
        );

        if (resultado !== "ok") throw new Error(`La recuperación desde la nube falló:\n${resultado}`);
    });

    it("3 · el login se abre y los datos del negocio están, sin haber tocado una copia local", async () => {
        await pulsar("Ir al inicio de sesión");
        await ficharYEntrar(PIN);

        // Lo que se comprueba no es que la app arranque, sino que ha vuelto el CONTENIDO: la
        // categoría se creó antes de la primera avería y no ha vuelto a tocarse desde entonces, así
        // que si está aquí es porque la nube la ha devuelto.
        const categorias = await leerDeLaApp(
            "list_categorias_vendibles",
        );
        const nombres = categorias.map((c) => c.Nombre);
        expect(nombres).toContain(CATEGORIA);

        // Y el equipo queda operativo de verdad, no sólo desbloqueado: sin cuarentenas y sin nada
        // pendiente de subir. Un login abierto sobre una base a medias sería peor que el bloqueo.
        const salud = await leerDeLaApp("sync_health");
        expect(salud.quarantined).toBe(0);
        expect(salud.failing).toBe(0);
    });
});
