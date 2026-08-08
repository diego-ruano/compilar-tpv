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
 * build instalado (pero bien en dev, que es lo traicionero).
 */
export const APEX_CHART_BASE = {
    injectStyleSheet: false,
} as const;
