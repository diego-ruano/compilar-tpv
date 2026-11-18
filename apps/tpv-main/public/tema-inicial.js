/* global localStorage, document */
// Tema claro u oscuro en el <html> ANTES del primer pintado, para que al abrir (o con Ctrl+R) no
// salga un destello claro antes de que React monte y `useTheme` ponga la clase. Va en el <head>, sin
// `type="module"`, para frenar el pintado. Es un fichero y no un <script> en línea porque la CSP
// (`script-src 'self'`) no deja correr los de en línea en la app instalada.
(function () {
    try {
        var oscuro = localStorage.getItem("tpv:theme") === "dark";
        var raiz = document.documentElement;
        if (oscuro) raiz.classList.add("dark");
        raiz.style.backgroundColor = oscuro ? "#0e0f13" : "#f3f8ff";
        raiz.style.colorScheme = oscuro ? "dark" : "light";
    } catch {
        /* localStorage no disponible: se queda el tema por defecto */
    }
})();
