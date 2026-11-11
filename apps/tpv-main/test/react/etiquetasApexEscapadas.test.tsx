/** @vitest-environment jsdom */
// AUD-25: el texto del negocio no llega como HTML a una gráfica.
//
// ApexCharts escribe con `innerHTML` el título del tooltip, el nombre de la serie dentro del tooltip
// y el texto de la leyenda. Aquí se montan las pantallas reales de Estadísticas, con el ApexCharts
// del lockfile y con nombres hostiles en lo que devuelven los comandos, se pasa el puntero por cada
// barra, cada sector y cada línea, y se comprueba que el nombre se lee tal cual y que en el
// documento no ha aparecido ningún elemento suyo.
//
// jsdom no navega: se vigila la inserción del marcado (el sumidero), no el efecto del `meta`. Lo que
// hace la webview con él lo cierra la política de navegación (`src-tauri/src/navegacion.rs`).

import { cleanup, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { escaparHtml } from "../../src/features/estadisticas/apexBase";
import ClientesStats from "../../src/features/estadisticas/ClientesStats";
import MesasStats from "../../src/features/estadisticas/MesasStats";
import ProductosStats from "../../src/features/estadisticas/ProductosStats";
import ProveedoresStats from "../../src/features/estadisticas/ProveedoresStats";
import ReservasStats from "../../src/features/estadisticas/ReservasStats";
import TrabajadoresStats from "../../src/features/estadisticas/TrabajadoresStats";
import { queryClient } from "../../src/shared/lib/queryClient";
import { ToastProvider } from "../../src/shared/toast";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/** El nombre de la auditoría: saca la ventana a otra web y deja una sonda para encontrarlo. */
const HOSTIL = "<meta http-equiv=refresh content=0;url=http://127.0.0.1:9/><b id=sonda>x</b>";
/** Un nombre legítimo con todo lo que se escapa: tiene que leerse igual. */
const LEGIBLE = `Bar "El 5" & Cía <tapas> d'Ana`;

// La máquina que corre esto puede ir muy cargada: los plazos son un techo, no una espera.
const ESPERA_MS = 30_000;
const PLAZO = { timeout: 180_000 };

const BARRA = ".apexcharts-bar-area";
const SECTOR = ".apexcharts-pie-area";
const LINEA = ".apexcharts-line-series";

const originales: Array<[object, string, PropertyDescriptor | undefined]> = [];
function sustituir(obj: object, prop: string, descriptor: PropertyDescriptor) {
    originales.push([obj, prop, Object.getOwnPropertyDescriptor(obj, prop)]);
    Object.defineProperty(obj, prop, { configurable: true, ...descriptor });
}

beforeAll(() => {
    // jsdom no tiene geometría: lo mínimo para que ApexCharts dibuje y coloque el tooltip.
    const caja = { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400 };
    const valor = (value: unknown) => ({ writable: true, value });
    sustituir(Element.prototype, "getBoundingClientRect", valor(() => ({ ...caja, toJSON: () => caja })));
    sustituir(SVGElement.prototype, "getBBox", valor(() => ({ x: 0, y: 0, width: 40, height: 12 })));
    sustituir(SVGElement.prototype, "getComputedTextLength", valor(() => 40));
    sustituir(SVGElement.prototype, "getTotalLength", valor(() => 100));
    sustituir(SVGElement.prototype, "getPointAtLength", valor(() => ({ x: 0, y: 0 })));
    sustituir(SVGElement.prototype, "getScreenCTM", valor(() => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => ({}) })));
    sustituir(globalThis, "ResizeObserver", valor(class { observe() {} unobserve() {} disconnect() {} }));
    for (const ancho of ["clientWidth", "offsetWidth"]) sustituir(HTMLElement.prototype, ancho, { get: () => 800 });
    for (const alto of ["clientHeight", "offsetHeight"]) sustituir(HTMLElement.prototype, alto, { get: () => 400 });
});

afterAll(() => {
    for (const [obj, prop, descriptor] of originales.reverse()) {
        if (descriptor) Object.defineProperty(obj, prop, descriptor);
        else delete (obj as Record<string, unknown>)[prop];
    }
});

beforeEach(() => {
    queryClient.clear();
    invoke.mockReset();
});

afterEach(cleanup);

function responder(respuestas: Record<string, unknown>) {
    invoke.mockImplementation(async (comando: string) => {
        if (comando in respuestas) return respuestas[comando];
        throw new Error(`comando inesperado: ${comando}`);
    });
}

function montar(pantalla: ReactElement) {
    return render(
        <QueryClientProvider client={queryClient}>
            <ToastProvider>{pantalla}</ToastProvider>
        </QueryClientProvider>,
    ).container;
}

/** Las gráficas de la pantalla que tienen `marca` (una barra, un sector, una línea), en su orden. */
const graficasCon = (pantalla: HTMLElement, marca: string) =>
    [...pantalla.querySelectorAll(".apexcharts-canvas")].filter((g) => g.querySelector(marca));

/**
 * Espera a que `listo` devuelva algo. Sólo espera, no comprueba: lo que tiene que ser cierto se
 * mira después, una vez, y si no lo es el test falla en ese momento y no al agotar el plazo.
 *
 * No es `waitFor` a propósito: `waitFor` repite con cada cambio del DOM y pasar el puntero lo
 * cambia, así que mientras la espera no se cumple se llaman el uno al otro sin dejar correr el
 * reloj, y el test se queda colgado en vez de fallar. El reloj es el monotónico.
 */
async function esperar<T>(que: string, listo: () => T | null | undefined | false): Promise<T> {
    const limite = performance.now() + ESPERA_MS;
    for (;;) {
        const hallado = listo();
        if (hallado) return hallado;
        if (performance.now() > limite) throw new Error(`Sigue sin haber ${que} tras ${ESPERA_MS / 1000} s`);
        await new Promise((seguir) => setTimeout(seguir, 25));
    }
}

/**
 * Pasa el puntero por lo que devuelva `buscar` y devuelve su gráfica cuando ApexCharts ha escrito
 * el tooltip de ese elemento. Para saberlo sin mirar qué ha escrito, vacía antes los `textos` del
 * tooltip y espera a que vuelvan a tener algo. Se busca en cada intento porque ApexCharts tarda
 * en dibujar, redibuja al cambiar los datos y deja 20 ms entre dos tooltips; un toque
 * (`touchmove`) va al mismo manejador.
 */
async function apuntar(buscar: () => Element | null | undefined, textos: string): Promise<Element> {
    const escritos = () => [...(buscar()?.closest(".apexcharts-canvas")?.querySelectorAll(textos) ?? [])];
    for (const texto of await esperar("tooltip en la gráfica", () => escritos().length > 0 && escritos())) {
        texto.textContent = "";
    }
    return esperar("tooltip del elemento señalado", () => {
        const el = buscar();
        el?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 200 }));
        return escritos().length > 0 && escritos().every((texto) => texto.innerHTML !== "") && el?.closest(".apexcharts-canvas");
    });
}

/** Se lee `texto` y dentro no hay ningún elemento: es texto, no marcado. */
function esTexto(el: Element | null | undefined, texto: string) {
    expect(el?.textContent).toBe(texto);
    expect(el?.childElementCount).toBe(0);
}

const TITULO = ".apexcharts-tooltip-title";
const SERIE = ".apexcharts-tooltip-text-y-label";
const EJE = ".apexcharts-xaxistooltip-text";

/** El título del tooltip de cada barra es su etiqueta. `porGrafica`: las de cada gráfica de barras. */
async function comprobarBarras(pantalla: HTMLElement, porGrafica: string[][]) {
    for (const [g, etiquetas] of porGrafica.entries()) {
        for (const [j, etiqueta] of etiquetas.entries()) {
            const grafica = await apuntar(() => graficasCon(pantalla, BARRA)[g]?.querySelector(`${BARRA}[j='${j}']`), TITULO);
            esTexto(grafica.querySelector(TITULO), etiqueta);
        }
    }
    expect(graficasCon(pantalla, BARRA)).toHaveLength(porGrafica.length);
}

/** La leyenda y el nombre de la serie en el tooltip de cada sector son su etiqueta. */
async function comprobarTarta(pantalla: HTMLElement, g: number, etiquetas: string[]) {
    for (const [j, etiqueta] of etiquetas.entries()) {
        const grafica = await apuntar(() => graficasCon(pantalla, SECTOR)[g]?.querySelector(`${SECTOR}[j='${j}']`), SERIE);
        esTexto(grafica.querySelector(`.apexcharts-tooltip-series-group.apexcharts-active ${SERIE}`), `${etiqueta}: `);
    }
    const leyenda = [...graficasCon(pantalla, SECTOR)[g]!.querySelectorAll(".apexcharts-legend-text")];
    expect(leyenda).toHaveLength(etiquetas.length);
    for (const [j, etiqueta] of etiquetas.entries()) esTexto(leyenda[j], etiqueta);
}

/**
 * En una gráfica de líneas, el título del tooltip y el del eje son la etiqueta de un punto. Sin
 * geometría no se elige cuál, así que todas las etiquetas son hostiles; y tiene que ser la etiqueta,
 * no la posición del punto, que es lo que ApexCharts le pasa al formateador.
 */
async function comprobarLineas(pantalla: HTMLElement, g: number, etiquetas: string[]) {
    const grafica = await apuntar(() => graficasCon(pantalla, LINEA)[g]?.querySelector("svg"), `${TITULO}, ${EJE}`);
    for (const escrito of [grafica.querySelector(TITULO), grafica.querySelector(EJE)]) {
        expect(etiquetas).toContain(escrito?.textContent);
        expect(escrito?.childElementCount).toBe(0);
    }
}

/** Nada de lo que traía un nombre se ha vuelto un elemento del documento. */
function sinMarcado() {
    expect(document.querySelector("meta, #sonda")).toBeNull();
}

describe("AUD-25: un nombre no llega como HTML a una gráfica", () => {
    it("Clientes: el top por gasto y la evolución de nuevos", PLAZO, async () => {
        const dias = [`${HOSTIL} 01/11`, `${HOSTIL} 02/11`, `${HOSTIL} 03/11`];
        const top = [`${LEGIBLE} #1`, `${HOSTIL} #00000000-0000-7000-8000-00000000c0de`];
        responder({
            stats_clientes_resumen: {
                nuevos: 3,
                recurrentes: 2,
                no_recurrentes: 1,
                ticket_medio_cliente: 1500,
                nuevos_por_bucket: { labels: dias, values: [1, 2, 3] },
                top_clientes_gasto: { labels: top, values: [250000, 120000] },
            },
        });
        const pantalla = montar(<ClientesStats range="mes" />);

        await comprobarBarras(pantalla, [top]);
        await comprobarLineas(pantalla, 0, dias);
        expect(invoke).toHaveBeenCalledWith("stats_clientes_resumen", { args: { range: "mes" } });
        sinMarcado();
    });

    it("Productos: los dos rankings, también al cambiar los datos", PLAZO, async () => {
        const resumen = (mejores: string[], peores: string[]) => ({
            mejor_producto: HOSTIL,
            peor_producto_vendible: LEGIBLE,
            top10_mejores: { labels: mejores, values: [9, 4] },
            top10_peores: { labels: peores, values: [1, 2] },
        });
        const categorias = [{ ID_Categoria: "c1", Nombre: HOSTIL }];
        responder({
            stats_productos_list_categorias: categorias,
            stats_productos_resumen: resumen([LEGIBLE, HOSTIL], [HOSTIL, LEGIBLE]),
        });
        const pantalla = montar(<ProductosStats range="mes" />);

        await comprobarBarras(pantalla, [[LEGIBLE, HOSTIL], [HOSTIL, LEGIBLE]]);
        sinMarcado();

        // Las mismas gráficas con datos nuevos: ApexCharts funde las opciones sobre las que ya tenía.
        const otros = [`${HOSTIL} (2)`, `${LEGIBLE} (2)`];
        responder({
            stats_productos_list_categorias: categorias,
            stats_productos_resumen: resumen(otros, otros),
        });
        await queryClient.invalidateQueries();
        // El eje es SVG y lleva las etiquetas como texto: en él se ve que ya ha redibujado.
        await esperar("gráficas con los datos nuevos", () =>
            graficasCon(pantalla, BARRA).every((grafica) => grafica.querySelector("svg")?.textContent?.includes("(2)")),
        );

        await comprobarBarras(pantalla, [otros, otros]);
        sinMarcado();
    });

    it("Proveedores: el reparto por proveedor y la evolución del gasto", PLAZO, async () => {
        const dias = [`${HOSTIL} 01/11`, `${HOSTIL} 02/11`];
        const proveedores = [HOSTIL, LEGIBLE];
        responder({
            stats_proveedores_resumen: {
                total_gasto: 10000,
                num_gastos: 2,
                gasto_medio: 5000,
                porcentaje_sobre_total_gastos: 50,
                proveedor_top: { nombre: HOSTIL, total: 7000 },
                gastos_evolucion: { labels: dias, values: [3000, 7000] },
                gasto_por_proveedor: { labels: proveedores, values: [7000, 3000] },
                ultimos_gastos: [{ fecha: "2026-11-01", proveedor: HOSTIL, concepto: HOSTIL, importe: 7000 }],
            },
        });
        const pantalla = montar(<ProveedoresStats range="mes" />);

        await comprobarBarras(pantalla, [proveedores]);
        await comprobarLineas(pantalla, 0, dias);
        sinMarcado();
    });

    it("Mesas: los servicios y el top por ingresos, con el nombre de la mesa y el de la zona", PLAZO, async () => {
        const dias = [`${HOSTIL} L`, `${LEGIBLE} M`];
        responder({
            stats_mesas_get: {
                total_mesas: 4,
                ocupadas: 1,
                ticket_medio_por_mesa: 2500,
                mesa_top_comandas: { mesa: HOSTIL, zona: HOSTIL, comandas: 3 },
                servicios: { labels: dias, values: [4, 6] },
                top_mesas_ingresos: [
                    { mesa: HOSTIL, zona: LEGIBLE, total: 5000 },
                    { mesa: "Mesa 2", zona: HOSTIL, total: 3000 },
                ],
            },
        });
        const pantalla = montar(<MesasStats range="mes" />);

        await comprobarBarras(pantalla, [dias, [`${HOSTIL} · ${LEGIBLE}`, `Mesa 2 · ${HOSTIL}`]]);
        await comprobarTarta(pantalla, 0, ["Ocupadas", "Libres"]);
        sinMarcado();
    });

    it("Trabajadores: las horas de cada grupo y el ranking de ventas", PLAZO, async () => {
        const trabajador = (id: string, nombre: string, rol: string) => ({
            id_trabajador: id,
            nombre,
            rol,
            tareas_asignadas: 2,
            tareas_finalizadas: 1,
            puntualidad: null,
            horas_trabajadas: 7.5,
            comandas_preparadas: 3,
            comandas_tomadas: 4,
            cobros_realizados: 2,
            ticket_medio: 1800,
        });
        responder({
            stats_trabajadores_resumen: {
                cocineros: [trabajador("t1", HOSTIL, "Cocinero"), trabajador("t2", LEGIBLE, "Cocinero")],
                camareros: [trabajador("t3", LEGIBLE, "Camarero"), trabajador("t4", HOSTIL, "Camarero")],
                limpieza: [trabajador("t5", HOSTIL, "Limpieza")],
                ranking_ventas: { labels: [HOSTIL, LEGIBLE], values: [10000, 5000] },
            },
        });
        const pantalla = montar(<TrabajadoresStats range="mes" />);

        // En el orden de la pantalla: horas de cocina, horas de sala, ranking y horas de limpieza.
        await comprobarBarras(pantalla, [[HOSTIL, LEGIBLE], [LEGIBLE, HOSTIL], [HOSTIL, LEGIBLE], [HOSTIL]]);
        sinMarcado();
    });

    // Hoy las etiquetas de estas tartas son fijas (las pone el backend, no la base). Se prueban con
    // nombres hostiles porque la leyenda y el nombre de la serie son los otros dos sitios donde
    // ApexCharts escribe HTML: una tarta por producto o por zona pasaría por aquí.
    it("Reservas: la leyenda de una tarta y el nombre del sector en su tooltip", PLAZO, async () => {
        const estados = ["Por llegar", HOSTIL, LEGIBLE];
        const franjas = [`${HOSTIL} 13-15`, LEGIBLE];
        const dias = [`${HOSTIL} 01/11`, LEGIBLE];
        responder({
            stats_reservas_resumen: {
                total_reservas: 6,
                cancelaciones: 1,
                mesas_turno: { turno: "TODOS", mesas_reservadas: 2, mesas_no_reservadas: 3 },
                reservas_por_bucket: { labels: dias, values: [2, 4] },
                estado: { labels: estados, values: [1, 2, 3] },
                franjas: { labels: franjas, values: [2, 4] },
            },
        });
        const pantalla = montar(<ReservasStats range="mes" />);

        await comprobarTarta(pantalla, 0, ["Reservadas", "No reservadas"]);
        await comprobarTarta(pantalla, 1, estados);
        await comprobarTarta(pantalla, 2, franjas);
        await comprobarBarras(pantalla, [dias]);
        sinMarcado();
    });
});

describe("escaparHtml", () => {
    /** Lo que se leería al escribir `html` con `innerHTML`, y los elementos que crearía. */
    function pintar(html: string) {
        const caja = document.createElement("div");
        caja.innerHTML = html;
        return { texto: caja.textContent, elementos: caja.childElementCount };
    }

    it.each([HOSTIL, LEGIBLE, "a &amp; b", "&lt;b&gt;", "<img src=x onerror=alert(1)>", "", "Mesa 4"])(
        "«%s» se lee tal cual y no crea ningún elemento",
        (texto) => {
            expect(pintar(escaparHtml(texto))).toEqual({ texto, elementos: 0 });
        },
    );

    it("escapa también lo que cerraría un atributo", () => {
        expect(escaparHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
    });

    it("una etiqueta de varias líneas se une con espacios, como hace ApexCharts", () => {
        expect(escaparHtml(["<b>Mesa", "4</b>"])).toBe("&lt;b&gt;Mesa 4&lt;/b&gt;");
    });

    it("lo que no es texto no rompe la gráfica", () => {
        expect(escaparHtml(12.5)).toBe("12.5");
        expect(escaparHtml(null)).toBe("");
        expect(escaparHtml(undefined)).toBe("");
    });
});
