// Copias de seguridad · segundo tramo: la avería y la vuelta.
//
// Arranca sobre el equipo que dejó `copias-1`, con la `data.db` machacada por `beforeSession` (ver
// `romperBaseDeDatos`). O sea: el TPV enciende y su base no abre.
//
// Es el recorrido que más reglas cruza de una vez, y todas son de las que fallan en silencio:
//
//   · una `data.db` ilegible NO puede impedir el arranque — si el `setup()` reventara, no habría
//     ventana, y entonces la pantalla de recuperación (donde están las copias) sería inalcanzable
//     justo en el caso para el que se guardan;
//   · restaurar deja el login BLOQUEADO hasta que la nube confirme que los dos lados coinciden.
//     Restaurado no es utilizable: trabajar sobre una copia sin reconciliar crearía dos historiales
//     divergentes;
//   · y la reconciliación tiene que converger de verdad y abrir el login, porque si no el producto
//     no tiene salida: sin internet, una Main que perdió su `data.db` no vende.

import { $, browser, expect } from "@wdio/globals";

import { ficharYEntrar } from "../helpers/arranque.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { CATEGORIA } from "../helpers/copias.js";
import { PIN } from "../helpers/equipo.js";
import { conTexto, leerDeLaApp, pulsar, pulsarXPath } from "../helpers/ui.js";

cargarDotEnv();

describe("Copias de seguridad · la avería y la vuelta", () => {
    it("1 · con la base rota, la app abre igual y ofrece recuperar", async () => {
        // Lo que se comprueba es que hay ventana: un `setup()` que se cae aquí deja el equipo
        // inservible sin decir nada, y las copias quedan fuera de alcance.
        await conTexto("h1", "Recuperar los datos de este TPV").waitForDisplayed({
            timeout: 120_000,
        });
    });

    it("2 · la copia de antes de la avería sigue estando", async () => {
        const copias = await leerDeLaApp<Array<{ id: string; importada: boolean }>>(
            "recovery_list_backups",
        );
        expect(copias.length).toBeGreaterThan(0);

        // Y la pantalla la ofrece: es un botón por copia, con su fecha.
        await conTexto("button", "Última copia").waitForDisplayed({ timeout: 30_000 });
    });

    it("3 · una copia inservible se rechaza, se dice, y deja elegir otra", async () => {
        // `beforeSession` dejó una copia que no es una base de datos, con fecha más reciente que la
        // buena: por eso es la que la pantalla ofrece primero como "Última copia".
        //
        // Lo que se comprueba no es la validación —eso ya lo prueba Rust— sino que la PANTALLA
        // cuente lo que ha pasado. Si se lo tragara y se quedara en "Recuperación en curso", el
        // dueño se quedaría mirando un reloj el día de la avería, con la copia buena justo debajo.
        await pulsarXPath(
            '//button[contains(normalize-space(.), "Última copia")]',
            "botón de la copia corrupta",
        );

        const aviso = $('//div[contains(@class,"bg-danger-soft")]');
        await aviso.waitForDisplayed({ timeout: 60_000 });
        expect((await aviso.getText()).trim().length).toBeGreaterThan(0);

        // Y el intento no ha dejado el equipo peor: la copia buena sigue ofreciéndose. La
        // validación ocurre sobre un fichero aparte, ANTES de tocar la `data.db`.
        await conTexto("button", "Copia:").waitForDisplayed({ timeout: 20_000 });
    });

    it("4 · restaura la copia buena y reconcilia contra la nube", async () => {
        // La buena ya no es "Última copia" —ese sitio lo ocupa la corrupta— sino la siguiente, que
        // la pantalla etiqueta simplemente "Copia".
        await pulsarXPath(
            '//button[starts-with(normalize-space(.), "Copia:")]',
            "botón de la copia buena",
        );

        // Restaurar es inmediato; lo que tarda es la reconciliación, que es justo lo que hace falta
        // para poder volver a trabajar. Mientras, la pantalla dice "Recuperación en curso".
        const resultado = await browser.waitUntil(
            async () => {
                if (await conTexto("p", "Datos recuperados y sincronizados").isExisting()) {
                    return "ok";
                }
                if (await conTexto("p", "La recuperación no ha podido completarse").isExisting()) {
                    const detalle = await conTexto(
                        "div",
                        "La recuperación no ha podido completarse",
                    ).getText();
                    return detalle;
                }
                return false;
            },
            { timeout: 240_000, timeoutMsg: "La recuperación no terminó ni bien ni mal" },
        );

        if (resultado !== "ok") throw new Error(`La recuperación falló:\n${resultado}`);
    });

    it("5 · el login vuelve a abrirse y los datos están", async () => {
        await pulsar("Ir al inicio de sesión");

        await ficharYEntrar(PIN);

        // La categoría creada antes de la avería tiene que seguir ahí: es lo que demuestra que se
        // recuperó el contenido y no sólo que la app arranca.
        const categorias = await leerDeLaApp<Array<{ Nombre?: string; nombre?: string }>>(
            "list_categorias_vendibles",
        );
        const nombres = categorias.map((c) => c.Nombre ?? c.nombre ?? "");
        expect(nombres).toContain(CATEGORIA);
    });
});
