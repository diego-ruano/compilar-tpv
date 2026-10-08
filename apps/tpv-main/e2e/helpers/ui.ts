import { nombresComandos } from "@tpv/client/metadata";
import type { NombreComando, ArgsComando, RetornoComando } from "@tpv/client/metadata";
// Utilidades de selección para el E2E.
//
// La app no tiene `data-testid` en ninguna parte y no se los añade este test: los elementos que
// hacen falta ya tienen `id` (los formularios de activación, setup y producto) o un texto que es
// parte del producto, no del test —"Cobrar todo", "Confirmar cobro", "Cerrar caja"—. Colgar
// atributos de test de media docena de ficheros por comodidad de aquí sería empeorar el código de
// producción para que el test se lea mejor.

import { $, $$, browser } from "@wdio/globals";
import type { ChainablePromiseElement } from "webdriverio";

/** Escapa un texto para meterlo dentro de un literal XPath (los apóstrofos son el caso feo). */
export function literalXPath(texto: string): string {
    if (!texto.includes('"')) return `"${texto}"`;
    if (!texto.includes("'")) return `'${texto}'`;
    return `concat("${texto.split('"').join('", \'"\', "')}")`;
}

/** Un elemento de tipo `etiqueta` cuyo texto (el suyo o el de sus hijos) contiene `texto`. */
export function conTexto(etiqueta: string, texto: string): ChainablePromiseElement {
    return $(`//${etiqueta}[contains(normalize-space(.), ${literalXPath(texto)})]`);
}

/**
 * Pulsa el primer elemento del XPath que esté VISIBLE y activo.
 *
 * Lo de "visible" no es una precaución de más: la app duplica bloques enteros para móvil y
 * escritorio (la rejilla de usuarios del login, el botón de fichar), así que el primero del
 * documento suele ser el que está oculto por CSS. Un `click()` sobre ése falla de una forma que no
 * se parece en nada al problema.
 */
export async function pulsarXPath(
    xpath: string,
    descripcion: string,
    timeout = 20_000,
): Promise<void> {
    const elegido = await browser.waitUntil(
        async () => {
            for (const candidato of await $$(xpath)) {
                if ((await candidato.isDisplayed()) && (await candidato.isEnabled())) {
                    return candidato;
                }
            }
            return false;
        },
        { timeout, timeoutMsg: `No apareció ningún ${descripcion} visible y activo` },
    );
    // Media app vive dentro de paneles con scroll propio (el contador de billetes del cobro, las
    // denominaciones del arqueo). Sin acercarlo, el elemento existe y se ve, pero queda fuera de la
    // ventana y el clic se queda esperando a algo que nunca va a pasar.
    //
    // Sólo si hace falta: desplazar lo que ya está a la vista mueve el resto de la pantalla, y en
    // un teclado numérico eso significa pulsar la tecla de al lado.
    if (!(await elegido.isDisplayed({ withinViewport: true }))) {
        await elegido.scrollIntoView({ block: "center", inline: "center" });
    }

    try {
        await elegido.click();
        return;
    } catch (e) {
        if (!/click intercepted|not clickable/i.test(String(e))) throw e;
        await elegido.scrollIntoView({ block: "center", inline: "center" });
        try {
            await elegido.click();
            return;
        } catch (e2) {
            if (!/click intercepted|not clickable/i.test(String(e2))) throw e2;
            await pulsarPeseAlEstorbo(elegido, descripcion, e2);
        }
    }
}

/**
 * Último recurso cuando el navegador dice que algo tapa al elemento.
 *
 * Distingue los dos casos, porque no son el mismo problema: si quien "recibiría el clic" es un
 * **antecesor** del propio elemento, no hay nada tapando nada — es cómo Chrome calcula el punto de
 * un elemento recortado por un contenedor con scroll, y ahí el clic por DOM hace exactamente lo
 * que haría el dedo. Si es otro subárbol, entonces sí hay algo encima (un modal, un toast) y eso
 * es un hallazgo del test: se falla diciendo qué es, en vez de atravesarlo en silencio.
 */
async function pulsarPeseAlEstorbo(
    elemento: WebdriverIO.Element,
    descripcion: string,
    original: unknown,
): Promise<void> {
    const estado = await browser.execute((el: HTMLElement) => {
        // `scrollIntoView` del propio DOM: el del driver no siempre alcanza a los contenedores
        // internos con scroll, que es donde vive medio TPV.
        el.scrollIntoView({ block: "center", inline: "center" });

        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const encima = document.elementFromPoint(x, y);

        const describir = (n: Element | null) =>
            n ? `<${n.tagName.toLowerCase()} class="${n.className}">` : "nada";

        // El contenedor con scroll más cercano: si el elemento se ha quedado fuera de ÉL (no de la
        // ventana), el navegador calcula un punto que en pantalla ocupa otra cosa.
        let caja: Element | null = el.parentElement;
        while (caja && caja !== document.body) {
            const ov = getComputedStyle(caja).overflowY;
            if ((ov === "auto" || ov === "scroll") && caja.scrollHeight > caja.clientHeight) break;
            caja = caja.parentElement;
        }
        const rc = caja && caja !== document.body ? caja.getBoundingClientRect() : null;

        return {
            alcanzable: !!encima && (encima === el || el.contains(encima) || encima.contains(el)),
            objetivo: describir(el),
            encima: describir(encima),
            punto: `${Math.round(x)},${Math.round(y)}`,
            vista: `${window.innerWidth}x${window.innerHeight} css`,
            caja: describir(caja),
            cajaRect: rc ? `${Math.round(rc.top)}..${Math.round(rc.bottom)}` : "sin panel con scroll",
            elemRect: `${Math.round(r.top)}..${Math.round(r.bottom)} x ${Math.round(r.left)}..${Math.round(r.right)}`,
        };
    }, elemento as unknown as HTMLElement);

    if (!estado.alcanzable) {
        throw new Error(
            `Algo tapa el ${descripcion} en (${estado.punto}):\n` +
                `  objetivo: ${estado.objetivo}  [${estado.elemRect}]\n` +
                `  encima:   ${estado.encima}\n` +
                `  panel:    ${estado.caja}  [${estado.cajaRect}]
` +
                `  ventana:  ${estado.vista}`,
            { cause: original },
        );
    }

    await elemento.click();
}

/** Pulsa el botón cuyo texto contiene `texto`. */
export async function pulsar(texto: string, timeout = 20_000): Promise<void> {
    await pulsarXPath(
        `//button[contains(normalize-space(.), ${literalXPath(texto)})]`,
        `botón "${texto}"`,
        timeout,
    );
}

/** Pulsa el enlace del menú (`<Link>` de react-router se renderiza como `<a href>`). */
export async function irA(ruta: string): Promise<void> {
    const enlace = $(`a[href="${ruta}"]`);
    await enlace.waitForClickable({ timeout: 20_000 });
    await enlace.click();
}

/** Rellena un campo controlado por React. Vacía primero para poder reutilizarlo en reintentos. */
export async function escribir(selector: string, valor: string): Promise<void> {
    const campo = $(selector);
    await campo.waitForDisplayed({ timeout: 20_000 });
    await campo.click();
    await campo.clearValue();
    await campo.setValue(valor);
}

/**
 * Invoca un comando Tauri desde la propia webview.
 *
 * Sólo se usa para LEER lo que la interfaz no enseña: dónde está una mesa en el plano (que es un
 * `<canvas>` de Konva, sin elementos que consultar), si esa mesa ha vuelto a libre, y el número de
 * ticket, que viaja al ESC/POS pero no se pinta en ninguna pantalla. Los datos del recorrido los
 * crea el test por la interfaz, que es lo que se está probando.
 *
 * Va por `__TAURI_INTERNALS__.invoke` —el mismo canal que usa `@tpv/client`— y guarda el resultado
 * en `window` para recogerlo después: así basta con `Execute Script`, sin depender de que el
 * driver implemente la variante asíncrona.
 */
export async function leerDeLaApp<N extends NombreComando>(
    comando: N,
    ...parametros: keyof ArgsComando<N> extends never ? [args?: ArgsComando<N>] : [args: ArgsComando<N>]
): Promise<RetornoComando<N>> {
    if (!(comando in nombresComandos)) throw new Error("Comando fuera del contrato generado");
    const args = parametros[0] ?? {};
    const marca = `__e2e_${Math.random().toString(36).slice(2)}`;

    await browser.execute(
        (m: string, cmd: string, a: Record<string, unknown>) => {
            const w = window as unknown as Record<string, unknown> & {
                __TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> };
            };
            if (!w.__TAURI_INTERNALS__) {
                w[m] = { hecho: true, error: "La webview no expone __TAURI_INTERNALS__" };
                return;
            }
            w[m] = { hecho: false };
            w.__TAURI_INTERNALS__.invoke(cmd, a).then(
                (valor: unknown) => {
                    w[m] = { hecho: true, valor };
                },
                (error: unknown) => {
                    w[m] = {
                        hecho: true,
                        error: String((error as { message?: string })?.message ?? error),
                    };
                },
            );
        },
        marca,
        String(comando),
        args,
    );

    const resultado = (await browser.waitUntil(
        async () => {
            const r = (await browser.execute(
                (m: string) => (window as unknown as Record<string, unknown>)[m],
                marca,
            )) as { hecho?: boolean; valor?: unknown; error?: string } | undefined;
            return r?.hecho ? r : false;
        },
        { timeout: 30_000, timeoutMsg: `El comando "${comando}" no respondió` },
    )) as { valor?: unknown; error?: string };

    await browser.execute((m: string) => {
        delete (window as unknown as Record<string, unknown>)[m];
    }, marca);

    if (resultado.error) throw new Error(`${comando}: ${resultado.error}`);
    return resultado.valor as RetornoComando<N>;
}
