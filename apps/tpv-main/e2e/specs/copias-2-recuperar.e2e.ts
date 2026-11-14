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
//   · lo que no se deja leer se aparta y no se ofrece (AUD-06), y la copia buena sigue ahí;
//   · restaurar deja el login BLOQUEADO hasta que la nube confirme que los dos lados coinciden.
//     Restaurado no es utilizable: trabajar sobre una copia sin reconciliar crearía dos historiales
//     divergentes;
//   · y la reconciliación tiene que converger de verdad y abrir el login, porque si no el producto
//     no tiene salida: sin internet, una Main que perdió su `data.db` no vende.

import { browser, expect } from "@wdio/globals";

import { ficharYEntrar } from "../helpers/arranque.js";
import { cargarDotEnv, copiasCorruptasApartadas } from "../helpers/entorno.js";
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
        const copias = await leerDeLaApp(
            "recovery_list_backups",
        );
        expect(copias.length).toBeGreaterThan(0);

        // Y la pantalla la ofrece: es un botón por copia, con su fecha.
        await conTexto("button", "Última copia").waitForDisplayed({ timeout: 30_000 });
    });

    it("3 · una copia ilegible no se ofrece: se aparta con la base rota", async () => {
        // `beforeSession` dejó, más reciente que la buena, una copia que no es una base de datos. Al
        // arrancar, la base rota no dice de qué negocio es, y AUD-06 la aparta entera con lo que
        // tampoco lo dice (`recovery::resolver_al_abrir`): esa copia se va con ella y no llega a la
        // pantalla. Que una copia mala que sí llegue se rechace diciendo por qué, y deje elegir
        // otra, lo prueban Rust (`prepare_restore`) y la pantalla (`test/react/recuperarDatos.test.tsx`).
        const apartadas = copiasCorruptasApartadas();
        expect(apartadas.length).toBeGreaterThan(0);

        const ofrecidas = await leerDeLaApp("recovery_list_backups");
        const fechas = ofrecidas.map((c) => c.created_at_ms);
        for (const ms of apartadas) expect(fechas).not.toContain(ms);
    });

    it("4 · restaura la copia buena y reconcilia contra la nube", async () => {
        // Apartada la ilegible, la buena es la más reciente: la "Última copia".
        await pulsarXPath(
            '//button[contains(normalize-space(.), "Última copia")]',
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
        const categorias = await leerDeLaApp(
            "list_categorias_vendibles",
        );
        const nombres = categorias.map((c) => c.Nombre);
        expect(nombres).toContain(CATEGORIA);
    });
});
