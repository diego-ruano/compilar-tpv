// El estreno de un equipo: elegir modo, activar la licencia, elegir PIN y entrar.
//
// Lo comparten tres recorridos porque es literalmente el mismo camino —el de un cliente que abre
// la caja por primera vez— y tenerlo escrito tres veces garantizaba que las tres copias acabaran
// divergiendo en cuanto alguien tocara una pantalla del arranque.

import { $, $$, browser } from "@wdio/globals";

import { licenciaDelRecorrido } from "./entorno.js";
import { conTexto, escribir, pulsar, pulsarXPath } from "./ui.js";

/** El correo que se usa en todo el E2E. No recibe nada: la activación no manda correos. */
export const EMAIL = "e2e@altarialights.test";

/**
 * Teclea el PIN en el teclado numérico del login, comprobando cada tecla.
 *
 * Se comprueba porque no hacerlo salía carísimo: una pulsación que no entra deja el PIN a medias y
 * lo que falla después es otra cosa —el botón de fichar sigue apagado, o el fichaje contesta que
 * el PIN no es—, así que el informe habla de cualquier cosa menos de la tecla que se perdió. El
 * display se pone en modo visible para poder leer lo tecleado, que es la única forma de saberlo.
 */
export async function tecleaPin(pin: string): Promise<void> {
    const ojo = $('//button[@aria-label="Mostrar PIN"]');
    if (await ojo.isExisting()) await ojo.click();

    const leerPin = async () =>
        (await $$('//span[contains(@class,"tabular-nums")]').map((s) => s.getText())).join("");

    for (const digito of pin) {
        const antes = await leerPin();
        await pulsarXPath(
            `//button[normalize-space(text())="${digito}"]`,
            `tecla ${digito} del PIN`,
        );
        await browser.waitUntil(async () => (await leerPin()) === antes + digito, {
            timeout: 10_000,
            timeoutMsg: `La tecla ${digito} no entró: el PIN sigue en "${antes}"`,
        });
    }
}

/** Elige "TPV principal" en la pantalla de primer inicio. Es lo que abre la base local. */
export async function elegirModoTpv(): Promise<void> {
    await conTexto("h1", "¿Cómo vas a usar este dispositivo?").waitForDisplayed({ timeout: 60_000 });
    await pulsar("Configurar como TPV");
}

/**
 * Rellena y envía el formulario de activación con la licencia que le toca a este recorrido.
 *
 * Devuelve dónde ha ido a parar la app, porque no siempre es al mismo sitio: un equipo recién
 * instalado cae en la pantalla de elegir PIN, y uno que YA tenía usuarios —por ejemplo el que
 * reactiva su licencia después de que se la anularan por error— va directo al login. Activar no
 * toca los datos locales, que es justo lo que hace que ese caso se recupere solo.
 */
export async function activarLicencia(negocio: string): Promise<"setup" | "login"> {
    await $("#activation-license-key").waitForDisplayed({ timeout: 30_000 });
    await escribir("#activation-license-key", licenciaDelRecorrido());
    await escribir("#activation-legal-name", "E2E TEST-01 S.L.");
    await escribir("#activation-business-name", negocio);
    await escribir("#activation-email", EMAIL);
    await escribir("#activation-phone", "+34600000000");
    await escribir("#activation-country", "España");

    await pulsar("Activar TPV");

    // Activar sale a internet. Si falla, el mensaje de la propia pantalla es lo que distingue
    // "no hay red" de "la app está mal", así que se rescata para el informe.
    const destino = await browser
        .waitUntil(
            async () => {
                if (await conTexto("h1", "Termina de preparar tu cuenta").isExisting()) {
                    return "setup" as const;
                }
                if (await conTexto("h2", "PIN de acceso").isExisting()) return "login" as const;
                return false;
            },
            { timeout: 120_000 },
        )
        .catch(async (e: unknown) => {
            const error = await $("pre[role='alert']");
            const detalle = (await error.isExisting()) ? await error.getText() : "(sin mensaje)";
            throw new Error(`La activación no llegó a ninguna parte.\nLa app dijo: ${detalle}`, {
                cause: e,
            });
        });

    return destino as "setup" | "login";
}

/** Elige el PIN del primer arranque y espera a caer en el login. */
export async function elegirPin(pin: string): Promise<void> {
    await escribir("#setup-pin-nuevo", pin);
    await escribir("#setup-pin-confirmacion", pin);
    await escribir("#setup-email", EMAIL);

    await pulsar("Guardar y continuar");

    // Guardar el PIN sube también el setup a la nube (para que la Handy pueda entrar con datos
    // reales), y con un tenant recién aprovisionado eso tarda. Lo que se espera aquí es a que la
    // pantalla pase al login.
    await conTexto("h2", "PIN de acceso").waitForDisplayed({ timeout: 180_000 });
}

/**
 * Ficha entrada e inicia sesión. Fichar es obligatorio para poder entrar, y consume el PIN, que
 * hay que volver a teclear.
 */
export async function ficharYEntrar(pin: string): Promise<void> {
    await conTexto("h2", "PIN de acceso").waitForDisplayed({ timeout: 60_000 });
    await pulsar("Admin TPV");

    // Si el equipo ya tenía la entrada fichada de antes (un recorrido que continúa a otro), no hay
    // nada que fichar: se entra directamente.
    const yaFichado = await conTexto("button", "Fichar salida").isExisting();

    if (!yaFichado) {
        await tecleaPin(pin);
        await pulsar("Fichar entrada");

        // Hay que esperar a que el fichaje responda: al terminar borra el PIN, y teclear antes deja
        // los dígitos escritos a medias sin que nada lo diga. Que la entrada quedó registrada se ve
        // en que el botón pasa a ofrecer la salida. Si en vez de eso sale un aviso, se recoge: el
        // aviso desaparece solo a los pocos segundos, y sin él el fallo sólo dice "no apareció un
        // botón", que es la consecuencia y no el motivo.
        const fichaje = await browser.waitUntil(
            async () => {
                if (await conTexto("button", "Fichar salida").isExisting()) return "ok";
                const avisos = await $$('//div[@role="status"]').map((t) => t.getText());
                const malo = avisos.find((t) => /error|no se pudo|pin/i.test(t));
                return malo ?? false;
            },
            { timeout: 30_000, timeoutMsg: "El fichaje de entrada no quedó registrado" },
        );
        if (fichaje !== "ok") throw new Error(`El fichaje de entrada falló: ${fichaje}`);
    }

    await tecleaPin(pin);
    await pulsar("Entrar");

    // Dentro: el menú lateral sólo existe con sesión.
    await $('a[href="/Inventario"]').waitForDisplayed({ timeout: 60_000 });
}

/** El estreno completo, de la primera pantalla al menú. */
export async function estrenarEquipo(negocio: string, pin: string): Promise<void> {
    await elegirModoTpv();

    const destino = await activarLicencia(negocio);
    if (destino !== "setup") {
        throw new Error(
            `Un equipo recién instalado tiene que pedir el PIN tras activar, y ha ido a "${destino}".`,
        );
    }

    await elegirPin(pin);
    await ficharYEntrar(pin);
}
