// Montar la carta, abrir una mesa y cobrarla.
//
// Vive aquí y no dentro del recorrido de la venta para que ése se lea como una secuencia de pasos
// y no como una lista de selectores. Y un recorrido NO puede importar a otro —importar un fichero
// de spec lo EJECUTA, sus `describe` se registran en quien lo importa—, así que si otro llega a
// necesitarlo, el sitio de lo compartido ya es `helpers/`.
//
// Son gestos, no aserciones: cada recorrido comprueba lo suyo. Lo único que estas funciones
// garantizan es haber dejado la aplicación donde dicen.

import { $, browser } from "@wdio/globals";

import { fitTransform } from "../../src/features/mesasComponents/geometry.js";
import type { Salon } from "../../src/features/mesasComponents/types.js";
import { conTexto, escribir, irA, leerDeLaApp, literalXPath, pulsar, pulsarXPath } from "./ui.js";

/** Un producto de la carta del test. */
export type Producto = {
    categoria: string;
    nombre: string;
    /** Con punto decimal: es lo que espera el `<input type="number">`. */
    precio: string;
    /** Porcentaje, sin el símbolo. */
    iva: string;
};

/**
 * Da de alta una categoría y, dentro de ella, un producto con precio, IVA y un lote inicial.
 *
 * El lote no es decoración: es lo que da stock, y cobrar tiene que descontarlo. Sin él la venta
 * seguiría funcionando (el descuento de stock es best-effort y no bloquea un cobro) y el recorrido
 * dejaría de mirar la mitad de lo que pasa al cobrar.
 */
export async function montarLaCarta(p: Producto): Promise<void> {
    await irA("/Inventario");

    await pulsar("Nueva categoría");
    const nombreCategoria = $('//label[contains(., "Nombre")]/following-sibling::input');
    await nombreCategoria.waitForDisplayed({ timeout: 20_000 });
    await nombreCategoria.setValue(p.categoria);
    await pulsar("Guardar categoría");

    // Hay que entrar en la categoría: "Nuevo producto" no existe en la lista de categorías, sólo
    // dentro de una. Es lo mismo que hace quien da de alta la carta.
    await pulsar(p.categoria);
    await pulsar("Nuevo producto");
    await escribir("#producto-nombre", p.nombre);

    // Las categorías del desplegable se cargan aparte del modal.
    const categoria = $("#producto-categoria");
    await browser.waitUntil(async () => (await categoria.getText()).includes(p.categoria), {
        timeout: 30_000,
        timeoutMsg: `"${p.categoria}" no llegó al desplegable de categorías`,
    });
    await categoria.selectByVisibleText(p.categoria);

    await escribir("#producto-precio-venta", p.precio);
    await escribir("#producto-iva", p.iva);
    await escribir("#producto-lote-codigo", "L-E2E");
    await escribir("#producto-lote-cantidad", "50");
    await pulsar("Guardar producto");

    // El modal se cierra al guardar: esperarlo es esperar a que la escritura haya terminado.
    await $("#producto-nombre").waitForExist({ reverse: true, timeout: 30_000 });
}

/**
 * Crea la primera zona con una mesa dentro y guarda el plano.
 *
 * Devuelve el **id de la mesa en la BD**, que es lo que hace falta después para preguntar por su
 * estado: el plano es un `<canvas>` y no hay ningún elemento del que leerlo.
 */
export async function crearZonaConMesa(zona: string, mesa: string): Promise<string> {
    await irA("/Mesas");
    await $('a[href="/Mesas/editar"]').waitForClickable({ timeout: 30_000 });
    await $('a[href="/Mesas/editar"]').click();

    await pulsar("Crear primera zona");

    const nombreZona = $('//div[normalize-space(.)="Nombre zona"]/following-sibling::input');
    await nombreZona.waitForDisplayed({ timeout: 20_000 });
    await nombreZona.setValue(zona);

    await pulsar("Añadir mesa");
    const nombreMesa = $('//div[contains(., "Nombre / Nº mesa")]/following-sibling::input');
    await nombreMesa.waitForDisplayed({ timeout: 20_000 });
    await nombreMesa.clearValue();
    await nombreMesa.setValue(mesa);
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

    if (salones[0].name !== zona || salones[0].tables[0].name !== mesa) {
        throw new Error(
            `El layout guardado no es el que se creó: zona "${salones[0].name}", ` +
                `mesa "${salones[0].tables[0].name}".`,
        );
    }

    await pulsar("Volver");

    return salones[0].tables[0].id.replace(/^db-mesa-/, "");
}

/**
 * Abre la mesa del plano.
 *
 * El plano lo pinta Konva sobre un `<canvas>`: las mesas no son elementos, así que no hay nada que
 * seleccionar ni nada a lo que hacer `click()`. Se calcula dónde cae la mesa con la MISMA función
 * que usa la pantalla (`fitTransform`) sobre el layout real, y se pulsa ahí. Copiar la cuenta en
 * vez de importarla habría dejado dos versiones que se separan al primer retoque del encuadre.
 */
export async function abrirMesa(mesa: string): Promise<void> {
    await irA("/Mesas");

    const lienzo = $("canvas");
    await lienzo.waitForDisplayed({ timeout: 30_000 });

    const salones = await leerDeLaApp<Salon[]>("load_layout");
    const salon = salones[0];
    const figura = salon.tables.find((t) => t.name === mesa) ?? salon.tables[0];

    const { width, height } = await lienzo.getSize();
    const vista = fitTransform(salon, width, height, 26);

    // El nodo de la mesa se dibuja con su origen en (x, y) y la figura de (0,0) a (ancho, alto).
    const centroX = vista.x + (figura.x + figura.width / 2) * vista.scale;
    const centroY = vista.y + (figura.y + figura.height / 2) * vista.scale;

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

    await tituloDelModal(mesa).waitForDisplayed({ timeout: 30_000 });
}

/**
 * El título del modal de una mesa.
 *
 * Es un `div`, no un encabezado: se busca el nodo EXACTO para no acabar encontrando cualquier
 * contenedor que lo envuelva.
 */
function tituloDelModal(mesa: string) {
    return $(`//div[normalize-space(text())=${literalXPath(`Mesa: ${mesa}`)}]`);
}

/**
 * Cierra el modal de la mesa por su aspa.
 *
 * ⚠️ Acotado a la cabecera del modal a propósito: el aspa de la barra de título de la propia
 * aplicación lleva el mismo `aria-label="Cerrar"`, y ese botón cierra el TPV en mitad del test.
 */
export async function cerrarElModalDeLaMesa(mesa: string): Promise<void> {
    await pulsarXPath(
        `//div[normalize-space(text())=${literalXPath(`Mesa: ${mesa}`)}]` +
            `/following-sibling::div//button[@aria-label="Cerrar"]`,
        "aspa de cerrar el modal de la mesa",
    );
}

/** Añade `unidades` de un producto al ticket, pulsando su tarjeta. */
export async function anadirLineas(p: Producto, unidades: number): Promise<void> {
    await conTexto("p", p.categoria).waitForDisplayed({ timeout: 30_000 });
    await conTexto("button", p.categoria).click();

    const tarjeta = conTexto("p", p.nombre);
    await tarjeta.waitForDisplayed({ timeout: 30_000 });
    for (let i = 0; i < unidades; i++) await tarjeta.click();
}

/** Espera a que el panel del ticket muestre ese total pendiente (`"10,00"`). */
export async function esperarTotalPendiente(importe: string): Promise<void> {
    const cifra = $('//div[starts-with(normalize-space(.), "Total pendiente")]/span');
    await browser.waitUntil(async () => (await cifra.getText()).includes(importe), {
        timeout: 30_000,
        timeoutMsg: `El ticket no llegó a ${importe} €`,
    });
}

/** Suma un billete en el contador de efectivo del cobro (el "+" de esa denominación). */
export async function sumarBillete(etiqueta: string): Promise<void> {
    await pulsarXPath(
        `//p[normalize-space(text())=${literalXPath(etiqueta)}]` +
            `/ancestor::div[contains(@class,"flex-col")][1]//button[normalize-space(.)="+"]`,
        `"+" de ${etiqueta} en el cobro`,
    );
}

/**
 * Cobra todo el ticket en efectivo con el billete indicado y espera a que el cobro haya entrado.
 *
 * "Haya entrado" se mide por que «Cobrar todo» se apague: es la señal de que ya no queda nada
 * pendiente en esta comanda, o sea de que la transacción del cobro llegó a COMMIT. Esperar a un
 * mensaje sería esperar a algo que la pantalla no siempre enseña.
 */
export async function cobrarTodoEnEfectivo(billete: string): Promise<void> {
    await pulsar("Cobrar todo");
    await pulsar("Cobrar en efectivo");

    await sumarBillete(billete);
    await conTexto("p", "Cambio").waitForDisplayed({ timeout: 20_000 });

    await pulsar("Confirmar cobro");

    await browser.waitUntil(async () => !(await conTexto("button", "Cobrar todo").isEnabled()), {
        timeout: 30_000,
        timeoutMsg: 'Tras cobrar, "Cobrar todo" seguía activo',
    });
}

/**
 * Cómo ve la app el estado de una mesa.
 *
 * `mesas_meta_all` sólo devuelve las mesas con una comanda ABIERTA: una mesa libre no sale en el
 * mapa, y así es justamente como la pinta el plano (sin meta = libre). Por eso "no está" se traduce
 * aquí a LIBRE en vez de a un fallo.
 */
export async function estadoDeMesa(idMesa: string): Promise<string> {
    try {
        const mapa = await leerDeLaApp<Record<string, { estado?: string }>>("mesas_meta_all");
        // La clave puede venir como UUID o como `db-mesa-<uuid>`: `mesasLoadMesaMeta` normaliza las
        // dos, así que aquí se aceptan las dos también.
        const meta = mapa[idMesa] ?? mapa[`db-mesa-${idMesa}`];
        return meta?.estado ?? "LIBRE";
    } catch (e) {
        return `el comando falló: ${String(e)}`;
    }
}

/** Espera a que la mesa vuelva a LIBRE, contando en el error lo que se vio por última vez. */
export async function esperarMesaLibre(idMesa: string): Promise<void> {
    let ultimo = "(no se llegó a leer)";
    const libre = await browser
        .waitUntil(
            async () => {
                ultimo = await estadoDeMesa(idMesa);
                return ultimo === "LIBRE";
            },
            { timeout: 30_000 },
        )
        .then(
            () => true,
            () => false,
        );

    // `timeoutMsg` se construye al llamar y no al fallar, así que lo que cuenta el último intento
    // hay que lanzarlo después de esperar.
    if (!libre) throw new Error(`La mesa ${idMesa} sigue en ${ultimo} tras el cobro.`);
}

/** Las entradas de caja (cobros) que ve la pantalla de Cuentas. Sólo LEE. */
export async function entradasDeCaja(): Promise<
    Array<{ id: string; importe: number; metodo: string }>
> {
    return await leerDeLaApp("cuentas_get_entradas", {
        args: { del: null, al: null, q: null, page: null, page_size: null },
    });
}
