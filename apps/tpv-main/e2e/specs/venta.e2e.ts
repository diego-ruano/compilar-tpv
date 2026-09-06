// TEST-01 · Un E2E del camino del dinero.
//
// Un solo recorrido, en orden, sobre la app COMPILADA: React → IPC de Tauri → comandos Rust →
// SQLite → y vuelta. No cubre el frontend ni lo pretende: comprueba que esa costura aguanta, que
// es lo único que hoy no mira ningún test.
//
// Los pasos 1-4 (activación, PIN, login) parecen andamiaje y no lo son: son el estreno de un
// cliente real, y tampoco los prueba nadie.
//
// El recorrido está pensado para que la última cifra lo verifique todo: si algo se rompe entre
// React y SQLite, el arqueo del paso 8 deja de cuadrar.

import fs from "node:fs";
import path from "node:path";

import { $, $$, browser, expect } from "@wdio/globals";

import { fitTransform } from "../../src/features/mesasComponents/geometry.js";
import type { Salon } from "../../src/features/mesasComponents/types.js";
import {
    APP_ID_E2E,
    cargarDotEnv,
    dirDatosE2E,
    licenciaDePruebas,
} from "../helpers/entorno.js";
import {
    conTexto,
    escribir,
    irA,
    leerDeLaApp,
    literalXPath,
    pulsar,
    pulsarXPath,
} from "../helpers/ui.js";

cargarDotEnv();

/* ── Los datos del recorrido ──────────────────────────────────────────────────
   Elegidos para que las cuentas salgan redondas y un descuadre se vea a simple
   vista: 2 × 5,00 € = 10,00 €, que se paga con UN billete de 10 y se cuenta con
   UN billete de 10. Con fondo de partida 0, lo que debería haber en el cajón es
   exactamente lo cobrado.                                                     */
const NEGOCIO = "Bar E2E TEST-01";
const PIN = "4321"; // distinto del 1234 del seed: así el login prueba el PIN elegido, no el sembrado
const EMAIL = "e2e@altarialights.test";
const ZONA = "Salón E2E";
const MESA = "M1";
const CATEGORIA = "Bebidas E2E";
const PRODUCTO = "Caña E2E";
const PRECIO = "5.00";
const IVA = "10";
const UNIDADES = 2;
const TOTAL = "10,00";

/** El id de la mesa creada por el test (UUID de la BD). Lo rellena el paso 5. */
let idMesa = "";

describe("El camino del dinero", () => {
    it("1 · arranca en un equipo recién instalado", async () => {
        const titulo = conTexto("h1", "¿Cómo vas a usar este dispositivo?");
        await titulo.waitForDisplayed({ timeout: 60_000 });
    });

    it("2 · se configura como TPV y activa la licencia contra el worker real", async () => {
        await pulsar("Configurar como TPV");

        // La comprobación que sostiene el plan entero: elegir modo TPV es lo que abre la base, y
        // esa base tiene que nacer en la carpeta del identificador de E2E. Si apareciera en la de
        // producción, este test estaría vendiendo contra los datos de trabajo del equipo.
        const dir = dirDatosE2E();
        expect(dir.endsWith(APP_ID_E2E)).toBe(true);
        await browser.waitUntil(() => fs.existsSync(path.join(dir, "data.db")), {
            timeout: 60_000,
            timeoutMsg: `No apareció data.db en ${dir}`,
        });

        await $("#activation-license-key").waitForDisplayed({ timeout: 30_000 });
        await escribir("#activation-license-key", licenciaDePruebas());
        await escribir("#activation-legal-name", "E2E TEST-01 S.L.");
        await escribir("#activation-business-name", NEGOCIO);
        await escribir("#activation-email", EMAIL);
        await escribir("#activation-phone", "+34600000000");
        await escribir("#activation-country", "España");

        await pulsar("Activar TPV");

        // Activar sale a internet. Si falla, el mensaje de la propia pantalla es lo que distingue
        // "no hay red" de "la app está mal", así que se rescata para el informe.
        const setup = conTexto("h1", "Termina de preparar tu cuenta");
        await setup.waitForDisplayed({ timeout: 120_000 }).catch(async (e) => {
            const error = await $("pre[role='alert']");
            const detalle = (await error.isExisting()) ? await error.getText() : "(sin mensaje)";
            throw new Error(`La activación no llegó a la pantalla de setup.\nLa app dijo: ${detalle}`, {
                cause: e,
            });
        });
    });

    it("3 · elige el PIN del primer arranque", async () => {
        await escribir("#setup-pin-nuevo", PIN);
        await escribir("#setup-pin-confirmacion", PIN);
        await escribir("#setup-email", EMAIL);

        await pulsar("Guardar y continuar");

        // Guardar el PIN sube también el setup a la nube (para que la Handy pueda entrar con datos
        // reales), y con un tenant recién aprovisionado eso tarda. La app ya está configurada
        // cuando termina; lo que se espera aquí es a que la pantalla pase al login.
        await conTexto("h2", "PIN de acceso").waitForDisplayed({ timeout: 180_000 });
    });

    it("4 · ficha entrada e inicia sesión con ese PIN", async () => {
        // El usuario que siembra la base: "Admin TPV", Administrador.
        await pulsar("Admin TPV");

        // Fichar entrada es obligatorio antes de entrar (y consume el PIN, que se vuelve a teclear).
        await tecleaPin();
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

        await tecleaPin();
        await pulsar("Entrar");

        // Dentro: el menú lateral sólo existe con sesión.
        await $('a[href="/Inventario"]').waitForDisplayed({ timeout: 60_000 });
    });

    it("5a · crea una categoría y un producto con precio, IVA y stock", async () => {
        await irA("/Inventario");

        await pulsar("Nueva categoría");
        const nombreCategoria = $('//label[contains(., "Nombre")]/following-sibling::input');
        await nombreCategoria.waitForDisplayed({ timeout: 20_000 });
        await nombreCategoria.setValue(CATEGORIA);
        await pulsar("Guardar categoría");

        // Hay que entrar en la categoría: "Nuevo producto" no existe en la lista de categorías,
        // sólo dentro de una. Es lo mismo que hace quien da de alta la carta.
        await pulsar(CATEGORIA);
        await pulsar("Nuevo producto");
        await escribir("#producto-nombre", PRODUCTO);
        // Las categorías del desplegable se cargan aparte del modal.
        const categoria = $("#producto-categoria");
        await browser.waitUntil(
            async () => (await categoria.getText()).includes(CATEGORIA),
            { timeout: 30_000, timeoutMsg: `"${CATEGORIA}" no llegó al desplegable de categorías` },
        );
        await categoria.selectByVisibleText(CATEGORIA);
        await escribir("#producto-precio-venta", PRECIO);
        await escribir("#producto-iva", IVA);
        // El lote inicial viene activado: es lo que da stock, y cobrar tiene que descontarlo.
        await escribir("#producto-lote-codigo", "L-E2E");
        await escribir("#producto-lote-cantidad", "50");
        await pulsar("Guardar producto");

        // El modal se cierra al guardar: esperarlo es esperar a que la escritura haya terminado.
        await $("#producto-nombre").waitForExist({ reverse: true, timeout: 30_000 });
    });

    it("5b · crea una zona con una mesa y guarda el plano", async () => {
        await irA("/Mesas");
        await $('a[href="/Mesas/editar"]').waitForClickable({ timeout: 30_000 });
        await $('a[href="/Mesas/editar"]').click();

        await pulsar("Crear primera zona");

        const nombreZona = $('//div[normalize-space(.)="Nombre zona"]/following-sibling::input');
        await nombreZona.waitForDisplayed({ timeout: 20_000 });
        await nombreZona.setValue(ZONA);

        await pulsar("Añadir mesa");
        const nombreMesa = $('//div[contains(., "Nombre / Nº mesa")]/following-sibling::input');
        await nombreMesa.waitForDisplayed({ timeout: 20_000 });
        await nombreMesa.clearValue();
        await nombreMesa.setValue(MESA);
        await pulsar("Crear mesa");

        await pulsar("Guardar layout");

        // El guardado le pone a la mesa su UUID de la BD; hasta que vuelve con él, no hay mesa que
        // abrir en el plano.
        const salones = await browser.waitUntil(
            async () => {
                const s = await leerDeLaApp<Salon[]>("load_layout");
                return s.length && s[0].tables.length ? s : false;
            },
            { timeout: 30_000, timeoutMsg: "El layout guardado no volvió con la mesa" },
        );

        expect(salones[0].name).toBe(ZONA);
        expect(salones[0].tables[0].name).toBe(MESA);
        idMesa = salones[0].tables[0].id.replace(/^db-mesa-/, "");
        expect(idMesa.length).toBeGreaterThan(0);

        await pulsar("Volver");
    });

    it("6 · abre la mesa y le añade dos líneas", async () => {
        await abrirLaMesa();

        await conTexto("p", CATEGORIA).waitForDisplayed({ timeout: 30_000 });
        await conTexto("button", CATEGORIA).click();

        const tarjeta = conTexto("p", PRODUCTO);
        await tarjeta.waitForDisplayed({ timeout: 30_000 });
        for (let i = 0; i < UNIDADES; i++) await tarjeta.click();

        await esperarTotalPendiente(TOTAL);

        // Con la comanda abierta y sin cobrar, la mesa figura como PENDIENTE. Se comprueba aquí
        // para que el "vuelve a libre" del paso 7 signifique algo: sin esto, ver que la mesa no
        // está ocupada pasaría igual con una mesa que nunca llegó a estarlo.
        expect(await estadoDeLaMesa()).toBe("PENDIENTE");
    });

    it("7 · cobra en efectivo, con el importe exacto", async () => {
        await pulsar("Cobrar todo");
        await pulsar("Cobrar en efectivo");

        // Un billete de 10 € para 10,00 €: cambio 0.
        await sumarBillete("10€");
        await conTexto("p", "Cambio").waitForDisplayed({ timeout: 20_000 });

        await pulsar("Confirmar cobro");

        // Cobrado todo: ya no queda nada que cobrar en esta comanda.
        await browser.waitUntil(
            async () => !(await conTexto("button", "Cobrar todo").isEnabled()),
            { timeout: 30_000, timeoutMsg: 'Tras cobrar, "Cobrar todo" seguía activo' },
        );

        // Acotado a la cabecera del modal a propósito: el aspa de la barra de título de la propia
        // aplicación lleva el mismo `aria-label="Cerrar"`, y ese botón cierra el TPV.
        await pulsarXPath(
            `//div[normalize-space(text())=${literalXPath(`Mesa: ${MESA}`)}]` +
                `/following-sibling::div//button[@aria-label="Cerrar"]`,
            "aspa de cerrar el modal de la mesa",
        );

        // La mesa vuelve a libre. El plano es un `<canvas>`, así que el estado se lee por el mismo
        // comando con el que lo pinta la app.
        let ultimo = "(no se llegó a leer)";
        const libre = await browser
            .waitUntil(
                async () => {
                    ultimo = await estadoDeLaMesa();
                    return ultimo === "LIBRE";
                },
                { timeout: 30_000 },
            )
            .then(
                () => true,
                () => false,
            );

        // `timeoutMsg` se construye al llamar y no al fallar, así que lo que cuenta el último
        // intento hay que lanzarlo después de esperar.
        if (!libre) throw new Error(`La mesa ${idMesa} sigue en ${ultimo} tras el cobro.`);

        // Y el cobro salió con número de ticket. No se pinta en ninguna pantalla —viaja al
        // ESC/POS—, así que se lee por el mismo comando que usa la reimpresión de Cuentas.
        const entradas = await leerDeLaApp<Array<{ id: string; importe: number; metodo: string }>>(
            "cuentas_get_entradas",
            { args: { del: null, al: null, q: null, page: null, page_size: null } },
        );
        expect(entradas.length).toBe(1);
        expect(entradas[0].metodo).toBe("Efectivo");
        expect(entradas[0].importe).toBeCloseTo(10, 2);

        const ticket = await leerDeLaApp<{ numero_ticket: string | null }>(
            "cuentas_ticket_para_reimprimir",
            { idPago: entradas[0].id },
        );
        expect(ticket.numero_ticket).toBeTruthy();
    });

    it("8 · cierra caja: lo que debería haber es lo cobrado, y el descuadre es 0", async () => {
        await irA("/Cuentas");
        await pulsar("Cerrar caja");

        await conTexto("h3", "Cerrar caja").waitForDisplayed({ timeout: 30_000 });

        // Primer cierre: hay que declarar con cuánto se empezó. Con 0, lo esperado es exactamente
        // lo cobrado en efectivo, que es lo que hace la comprobación legible.
        const fondo = $('//input[@placeholder="150"]');
        await fondo.waitForDisplayed({ timeout: 20_000 });
        await fondo.setValue("0");

        // El valor de la tarjeta, no la tarjeta entera: el texto del contenedor arrastra las otras
        // cifras del arqueo y una comprobación así pasaría por casualidad.
        const deberiaHaber = $('//p[contains(., "Debería haber")]/following-sibling::p[1]');
        await browser.waitUntil(async () => (await deberiaHaber.getText()).includes(TOTAL), {
            timeout: 20_000,
            timeoutMsg: `"Debería haber" no mostró ${TOTAL} €`,
        });

        // Se cuenta el cajón: un billete de 10, lo mismo que entró.
        await contarEnElCajon("10€");

        // La cifra que justifica el test entero.
        await conTexto("p", "Cuadra").waitForDisplayed({ timeout: 20_000 });

        // El de confirmar, no el de la pantalla de detrás: los dos dicen "Cerrar caja".
        await pulsarXPath(
            '//button[normalize-space(.)="Cancelar"]/following-sibling::button[contains(., "Cerrar caja")]',
            "botón de confirmar el cierre",
        );

        // El arqueo queda guardado y sale en el histórico de la pantalla.
        await conTexto("h3", "Cierres de caja").waitForDisplayed({ timeout: 30_000 });
        await browser.waitUntil(
            async () => {
                const cierres = await leerDeLaApp<Array<{ descuadre: number }>>("cierre_listar", {
                    args: { limite: 10 },
                });
                return cierres.length === 1 && Math.abs(cierres[0].descuadre) < 0.005;
            },
            { timeout: 30_000, timeoutMsg: "El cierre no quedó guardado con descuadre 0" },
        );
    });
});

/* ── Gestos que no son un `click` en un selector ─────────────────────────── */

/**
 * Teclea el PIN en el teclado numérico del login, comprobando cada tecla.
 *
 * Se comprueba porque no hacerlo salía carísimo: una pulsación que no entra deja el PIN a medias y
 * lo que falla después es otra cosa —el botón de fichar sigue apagado, o el fichaje contesta que
 * el PIN no es—, así que el informe habla de cualquier cosa menos de la tecla que se perdió. El
 * display se pone en modo visible para poder leer lo tecleado, que es la única forma de saberlo.
 */
async function tecleaPin(): Promise<void> {
    const ojo = $('//button[@aria-label="Mostrar PIN"]');
    if (await ojo.isExisting()) await ojo.click();

    const leerPin = async () =>
        (await $$('//span[contains(@class,"tabular-nums")]').map((s) => s.getText())).join("");

    for (const digito of PIN) {
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

/**
 * Abre la mesa creada por el test.
 *
 * El plano de salones lo pinta Konva sobre un `<canvas>`: las mesas no son elementos, así que no
 * hay nada que seleccionar ni nada a lo que hacer `click()`. Se calcula dónde cae la mesa con la
 * MISMA función que usa la pantalla (`fitTransform`) sobre el layout real, y se pulsa ahí. Copiar
 * la cuenta en vez de importarla habría dejado dos versiones que se separan al primer retoque del
 * encuadre.
 */
async function abrirLaMesa(): Promise<void> {
    await irA("/Mesas");

    const lienzo = $("canvas");
    await lienzo.waitForDisplayed({ timeout: 30_000 });

    const salones = await leerDeLaApp<Salon[]>("load_layout");
    const salon = salones[0];
    const mesa = salon.tables[0];

    const { width, height } = await lienzo.getSize();
    const vista = fitTransform(salon, width, height, 26);

    // El nodo de la mesa se dibuja con su origen en (x, y) y la figura de (0,0) a (ancho, alto).
    const centroX = vista.x + (mesa.x + mesa.width / 2) * vista.scale;
    const centroY = vista.y + (mesa.y + mesa.height / 2) * vista.scale;

    // Los desplazamientos de la acción son relativos al CENTRO del elemento.
    await browser
        .action("pointer")
        .move({
            origin: lienzo,
            x: Math.round(centroX - width / 2),
            y: Math.round(centroY - height / 2),
        })
        .down()
        .pause(80)
        .up()
        .perform();

    // El titulo del modal es un `div`, no un encabezado: se busca el nodo exacto para no acabar
    // encontrando cualquier contenedor que lo envuelva.
    await $(`//div[normalize-space(text())=${literalXPath(`Mesa: ${MESA}`)}]`).waitForDisplayed({
        timeout: 30_000,
    });
}

/**
 * Cómo ve la app el estado de esta mesa.
 *
 * `mesas_meta_all` sólo devuelve las mesas con una comanda ABIERTA: una mesa libre no sale en el
 * mapa, y así es justamente como la pinta el plano (sin meta = libre). Por eso "no está" se
 * traduce aquí a LIBRE en vez de a un fallo.
 */
async function estadoDeLaMesa(): Promise<string> {
    try {
        const mapa = await leerDeLaApp<Record<string, { estado?: string }>>("mesas_meta_all");
        // La clave puede venir como UUID o como `db-mesa-<uuid>`: `mesasLoadMesaMeta` normaliza
        // las dos, así que aquí se aceptan las dos también.
        const meta = mapa[idMesa] ?? mapa[`db-mesa-${idMesa}`];
        return meta?.estado ?? "LIBRE";
    } catch (e) {
        return `el comando falló: ${String(e)}`;
    }
}

/** Espera a que el panel del ticket muestre ese total pendiente. */
async function esperarTotalPendiente(importe: string): Promise<void> {
    const cifra = $('//div[starts-with(normalize-space(.), "Total pendiente")]/span');
    await browser.waitUntil(async () => (await cifra.getText()).includes(importe), {
        timeout: 30_000,
        timeoutMsg: `El ticket no llegó a ${importe} €`,
    });
}

/** Suma un billete en el contador de efectivo del cobro (el "+" de esa denominación). */
async function sumarBillete(etiqueta: string): Promise<void> {
    await pulsarXPath(
        `//p[normalize-space(text())=${literalXPath(etiqueta)}]` +
            `/ancestor::div[contains(@class,"flex-col")][1]//button[normalize-space(.)="+"]`,
        `"+" de ${etiqueta} en el cobro`,
    );
}

/** Suma un billete al recuento del cajón del cierre (hay dos contadores: se acota por el título). */
async function contarEnElCajon(etiqueta: string): Promise<void> {
    await pulsarXPath(
        `//h3[contains(., "Cuenta el cajón")]/ancestor::div[contains(@class,"rounded-2xl")][1]` +
            `//button[@aria-label=${literalXPath(`Añadir ${etiqueta}`)}]`,
        `"+" de ${etiqueta} en el recuento del cajón`,
    );
}
