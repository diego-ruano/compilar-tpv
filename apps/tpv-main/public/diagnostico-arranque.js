/* global window, document, navigator, setTimeout */
// Diagnóstico del arranque. Va antes que la app y sin módulos, así que corre aunque el código de la
// app no se pueda ni leer (un navegador más antiguo que la sintaxis con la que se compila).
//
// Apunta los errores de JavaScript y lo que no ha cargado, y si a los 10 segundos la app no ha
// pintado nada, los enseña en pantalla con la versión del navegador. Sin esto, en un iPhone sin Mac
// una pantalla en blanco no dice nada. Si la app arranca, no hace nada.
(function () {
    // También lo lee el diagnóstico de la pantalla (cinco toques en el logo, en el móvil).
    var errores = (window.__erroresTpv = []);
    window.addEventListener(
        "error",
        function (e) {
            var origen = e.target && (e.target.src || e.target.href);
            if (errores.length > 50) errores.shift();
            if (origen) errores.push("No ha cargado: " + origen);
            else errores.push((e.message || "Error") + (e.filename ? " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")" : ""));
        },
        true
    );
    window.addEventListener("unhandledrejection", function (e) {
        var r = e.reason;
        errores.push("Promesa rechazada: " + ((r && (r.stack || r.message)) || String(r)));
    });
    setTimeout(function () {
        var raiz = document.getElementById("root");
        if (raiz && raiz.childNodes.length > 0) return;
        var caja = document.createElement("pre");
        caja.style.whiteSpace = "pre-wrap";
        caja.style.wordBreak = "break-word";
        caja.style.padding = "16px";
        caja.style.margin = "0";
        caja.style.font = "13px/1.4 monospace";
        caja.style.color = "#111";
        caja.textContent =
            "La aplicación no ha llegado a arrancar.\n\n" +
            (errores.length ? errores.join("\n\n") : "No ha habido ningún error de JavaScript.") +
            "\n\nNavegador: " + navigator.userAgent;
        document.body.appendChild(caja);
    }, 10000);
})();
