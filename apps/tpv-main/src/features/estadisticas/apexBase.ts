// Base común de configuración de ApexCharts.
//
// ⚠️ POR QUÉ EXISTE ESTE FICHERO (bug de layout sólo en el .exe instalado)
//
// ApexCharts v5 ya no publica su CSS como fichero a importar: lo lleva **embebido como
// string dentro del JS** y lo inyecta al montar la primera gráfica, creando en runtime un
// `<style id="apexcharts-css">` (y otro con el CSS de la leyenda dentro del <foreignObject>
// del SVG).
//
// La CSP del build de producción (`app.security.csp` en tauri.conf.json) declara
// `style-src 'self'`, que NO permite estilos inline, así que el navegador bloquea esos dos
// <style> y las gráficas se quedan literalmente sin ninguna regla: los tooltips pierden
// `position:absolute`/`opacity:0` y se convierten en texto estático siempre visible tirado
// por la página, la leyenda pierde el `display:flex` y los divs `.resize-triggers` dejan de
// estar ocultos y rompen el responsive.
//
// En `pnpm tauri dev` no se veía porque la CSP sólo se aplica a los assets que sirve el
// protocolo `tauri://`; en escritorio-dev el webview carga el servidor de Vite
// (http://localhost:1420) directamente y ahí no hay cabecera CSP ninguna.
//
// Solución: desactivamos la auto-inyección con `injectStyleSheet: false` y las dos hojas se
// importan desde `Global.css` (`@import "apexcharts/dist/…"`), de modo que Vite las mete en
// el CSS del bundle. Ese CSS se sirve como `<link rel="stylesheet">` desde el propio origen,
// que sí pasa la CSP. Se importan allí y no aquí para garantizar el orden: primero el CSS
// base de ApexCharts y después el bloque de tematizado claro/oscuro de Global.css.

/**
 * Opciones de `chart` comunes a todas las gráficas de estadísticas.
 *
 * ⚠️ Toda gráfica nueva DEBE esparcir esto en su `chart: {}`:
 *
 * ```ts
 * chart: { ...APEX_CHART_BASE, type: "bar", toolbar: { show: false } }
 * ```
 *
 * Si se olvida, la gráfica volverá a intentar inyectar su `<style>` y se verá rota en el
 * build instalado (pero bien en dev, que es lo traicionero). Y una pantalla que no importe este
 * fichero puede montarla sin los formateadores de abajo. Lo vigila `test/graficasConBase.test.ts`.
 */
export const APEX_CHART_BASE = {
    injectStyleSheet: false,
} as const;

// AUD-25: EL TEXTO DEL NEGOCIO NO LLEGA COMO HTML A UNA GRÁFICA
//
// ApexCharts escribe con `innerHTML` tres textos que aquí salen de la base (nombres de clientes,
// productos, proveedores, mesas, zonas y trabajadores), y un nombre es lo que quiera quien lo
// escribe:
//
//   - el título del tooltip: la categoría de la barra o del punto;
//   - el nombre de la serie dentro del tooltip: en una tarta, la etiqueta del sector;
//   - el texto de la leyenda: la etiqueta del sector o, con barras `distributed`, la categoría.
//
// Lo demás lo pinta como texto (los ejes, las etiquetas de datos y el centro de una tarta son
// SVG) o son números (los valores).
//
// Los tres pasan por un formateador, y ApexCharts funde `window.Apex` entre sus valores por
// defecto y las opciones de cada gráfica: fijándolos aquí los heredan todas, también las que
// lleguen después, porque para esparcir `APEX_CHART_BASE` hay que importar este fichero.
//
// Una gráfica que fije el suyo (`tooltip.x.formatter`, `tooltip.y.title.formatter` o
// `legend.formatter`) pisa el de aquí y tiene que escapar ella: devuelve un texto fijo o lo que
// sea pasado por `escaparHtml`. Las entradas de `legend.customLegendItems` no se escapan antes:
// pasan por `legend.formatter`, y saldrían escapadas dos veces.
//
// ApexCharts sólo funde objetos. `tooltip`, `tooltip.x`, `tooltip.y`, `tooltip.y.title` y
// `legend` van siempre como objeto: una lista en `tooltip.y` (la admite, con un formateador por
// serie) o cualquier otro valor sustituye al de aquí, y el nombre de la serie saldría sin escapar.
//
// Lo que estos formateadores no alcanzan no lo usa ninguna gráfica: `xaxis.tooltip.formatter`,
// que se salta el del título; el tooltip del eje Y; y lo que ApexCharts escribe tal cual
// (`tooltip.custom`, `tooltip.z`, `legend.tooltipHoverFormatter`, `legend.markers.customHTML`, el
// `customSVG` de una anotación, los iconos de `chart.toolbar.tools` y el nombre de un `goal`). El
// valor también se escribe como HTML: `tooltip.y.formatter` y el formateador del eje Y sólo dan
// formato al número. `test/graficasConBase.test.ts` vigila todo esto en lo corriente.

const ENTIDADES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/**
 * El HTML que se lee igual que el texto: un nombre con `&`, `<` o comillas se ve tal cual.
 * Una etiqueta de varias líneas llega como lista y ApexCharts la une con espacios.
 */
export function escaparHtml(texto: unknown): string {
    const plano = Array.isArray(texto) ? texto.join(" ") : String(texto ?? "");
    return plano.replace(/[&<>"']/g, (c) => ENTIDADES[c]!);
}

type ConFormateador = { labels?: { formatter?: unknown } };
type ContextoApex = {
    w?: {
        config?: {
            chart?: { type?: string };
            plotOptions?: { bar?: { horizontal?: boolean } };
            xaxis?: ConFormateador;
            yaxis?: ConFormateador | ConFormateador[];
        };
    };
};

const BARRAS = ["bar", "rangeBar", "boxPlot"];

/**
 * El título que pondría ApexCharts, escapado. Fijar `tooltip.x.formatter` le quita el suyo, que
 * es el formateador de las etiquetas del eje de categorías (el vertical en barras horizontales),
 * y hay que conservarlo: en una gráfica de líneas el valor que llega es la posición del punto y
 * es ese formateador quien la convierte en su etiqueta. Con eje de fechas llega la marca de
 * tiempo: esa gráfica trae su propio `tooltip.x.formatter`.
 */
function tituloDelTooltip(valor: unknown, ...resto: unknown[]): string {
    // ApexCharts pasa (valor, contexto) y, con eje de fechas, (valor, marca, contexto).
    const config = (resto.find((r) => typeof r === "object" && r !== null && "w" in r) as ContextoApex | undefined)
        ?.w?.config;
    const horizontal = config?.plotOptions?.bar?.horizontal === true && BARRAS.includes(config.chart?.type ?? "");
    const eje = horizontal ? [config?.yaxis].flat()[0] : config?.xaxis;
    const delEje = eje?.labels?.formatter;
    return escaparHtml(typeof delEje === "function" ? (delEje(valor, ...resto) ?? valor) : valor);
}

if (typeof window !== "undefined") {
    // Sobre el objeto que ya hubiera: ApexCharts crea `window.Apex` al cargarse y guarda cosas en él.
    const global = window as unknown as { Apex?: Record<string, unknown> };
    global.Apex = Object.assign(global.Apex ?? {}, {
        tooltip: {
            x: { formatter: tituloDelTooltip },
            y: { title: { formatter: (serie: unknown) => (serie ? `${escaparHtml(serie)}: ` : "") } },
        },
        legend: { formatter: escaparHtml },
    });
}
