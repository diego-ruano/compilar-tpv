// El estreno de un equipo: elegir modo, activar la licencia, elegir PIN y entrar.
//
// Es literalmente el camino de un cliente que abre la caja por primera vez. Lo recorre entero la
// venta, que estrena el equipo de la tanda, pero sus piezas las reutilizan los demás: todos vuelven
// a entrar con `ficharYEntrar`, y el de la licencia reactiva con `activarLicencia`. Tenerlo escrito
// una sola vez es lo que evita que las copias diverjan en cuanto alguien toque una pantalla del
// arranque.

import { $, $$, browser } from "@wdio/globals";

import { licenciaDelRecorrido } from "./entorno.js";
import { conTexto, escribir, gestosEn, pulsar } from "./ui.js";

/**
 * Teclea el PIN en el teclado numérico del login, comprobando cada tecla.
 *
 * Se comprueba porque no hacerlo salía carísimo: una pulsación que no entra deja el PIN a medias y
 * lo que falla después es otra cosa —el botón de fichar sigue apagado, o el fichaje contesta que
 * el PIN no es—, así que el informe habla de cualquier cosa menos de la tecla que se perdió. El
 * display se pone en modo visible para poder leer lo tecleado, que es la única forma de saberlo.
 *
 * `b` es la pantalla donde se teclea: la Main por defecto, o la Handy.
 */
export async function tecleaPin(pin: string, b: WebdriverIO.Browser = browser): Promise<void> {
    const { pulsarXPath } = gestosEn(b);
    const ojo = b.$('//button[@aria-label="Mostrar PIN"]');
    if (await ojo.isExisting()) await ojo.click();

    const leerPin = async () =>
        (await b.$$('//span[contains(@class,"tabular-nums")]').map((s) => s.getText())).join("");

    for (const digito of pin) {
        const antes = await leerPin();
        await pulsarXPath(
            `//button[normalize-space(text())="${digito}"]`,
            `tecla ${digito} del PIN`,
        );
        await b.waitUntil(async () => (await leerPin()) === antes + digito, {
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

    await pulsar("Guardar y continuar");

    // Guardar el PIN sube también el setup a la nube (para que la Handy pueda entrar con datos
    // reales), y con un tenant recién aprovisionado eso tarda. Lo que se espera aquí es a que la
    // pantalla pase al login.
    await conTexto("h2", "PIN de acceso").waitForDisplayed({ timeout: 180_000 });
}

/** Quién entra, y en qué pantalla. Por defecto, el administrador de la tanda en la Main. */
export type Acceso = {
    /** La Main (el `browser` de WDIO) o la Handy. */
    b?: WebdriverIO.Browser;
    /** El nombre que sale en la rejilla de usuarios del login. */
    usuario?: string;
    /** El PIN, o `null` para quien entra sin PIN (`Usuarios.Sin_PIN`). */
    pin: string | null;
};

/**
 * Ficha entrada e inicia sesión. Fichar es obligatorio para poder entrar, y consume el PIN, que
 * hay que volver a teclear. Quien entra sin PIN pulsa los mismos botones sin teclear nada.
 *
 * Termina cuando el login se ha ido: la Main y la Handy no aterrizan en el mismo sitio (en un
 * teléfono el menú lateral está plegado), así que se espera a que desaparezca el panel del PIN.
 */
export async function entrar({ b = browser, usuario = "Admin TPV", pin }: Acceso): Promise<void> {
    const { conTexto: texto, pulsar: tocar } = gestosEn(b);
    await texto("h2", "PIN de acceso").waitForDisplayed({ timeout: 60_000 });
    await tocar(usuario);

    // Si el equipo ya tenía la entrada fichada de antes (un recorrido que continúa a otro), no hay
    // nada que fichar: se entra directamente. Pero hay que esperar a que el fichaje cargue: mientras
    // tanto el botón dice «Cargando...», y en la Handy, que lo pregunta a la nube, eso tarda lo
    // bastante como para decidir mal y ponerse a fichar una entrada que ya está hecha.
    const fichajeDelDia = await b.waitUntil(
        async () => {
            if (await texto("button", "Fichar salida").isExisting()) return "hecho";
            if (await texto("button", "Fichaje completado").isExisting()) return "hecho";
            if (await texto("button", "Fichar entrada").isExisting()) return "pendiente";
            return false;
        },
        { timeout: 30_000, timeoutMsg: `El fichaje de ${usuario} no llegó a cargarse` },
    );
    const yaFichado = fichajeDelDia === "hecho";

    if (!yaFichado) {
        if (pin !== null) await tecleaPin(pin, b);
        await tocar("Fichar entrada");

        // Hay que esperar a que el fichaje responda: al terminar borra el PIN, y teclear antes deja
        // los dígitos escritos a medias sin que nada lo diga. Que la entrada quedó registrada se ve
        // en que el botón pasa a ofrecer la salida. Si en vez de eso sale un aviso, se recoge: el
        // aviso desaparece solo a los pocos segundos, y sin él el fallo sólo dice "no apareció un
        // botón", que es la consecuencia y no el motivo.
        const fichaje = await b.waitUntil(
            async () => {
                if (await texto("button", "Fichar salida").isExisting()) return "ok";
                const avisos = await b.$$('//div[@role="status"]').map((t) => t.getText());
                const malo = avisos.find((t) => /error|no se pudo|pin/i.test(t));
                return malo ?? false;
            },
            { timeout: 30_000, timeoutMsg: "El fichaje de entrada no quedó registrado" },
        );
        if (fichaje !== "ok") throw new Error(`El fichaje de entrada falló: ${fichaje}`);
    }

    if (pin !== null) await tecleaPin(pin, b);
    await tocar("Entrar");

    await b.waitUntil(async () => !(await texto("h2", "PIN de acceso").isExisting()), {
        timeout: 60_000,
        timeoutMsg: `${usuario} no pasó del login`,
    });
}

/** El administrador de la tanda entra en la Main. Lo usan todos los recorridos de un equipo. */
export async function ficharYEntrar(pin: string): Promise<void> {
    await entrar({ pin });
    // Dentro: el menú lateral sólo existe con sesión.
    await $('a[href="/Inventario"]').waitForDisplayed({ timeout: 60_000 });
}
