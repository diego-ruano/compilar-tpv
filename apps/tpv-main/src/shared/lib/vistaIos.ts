// src/shared/lib/vistaIos.ts
//
// Lo que necesita la página en el iPhone para quedarse quieta (con `src-tauri/src/vista_ios.rs`,
// que apaga el desplazamiento de la webview).
//
// - Marca el <html> con `plataforma-ios`, que es lo que mira `Global.css` para quitar el rebote de
//   los contenedores y el desplazamiento lateral.
// - Al cerrar el teclado, devuelve la página a su sitio: WebKit la desplaza entera para enseñar el
//   campo que se está escribiendo y no siempre la devuelve, y la app se queda movida.

import { esIos } from "./plataforma";

function esCampoDeTexto(el: Element | null): boolean {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
    if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset"].includes(el.type);
    return el instanceof HTMLElement && el.isContentEditable;
}

function recolocar(): void {
    // Con el teclado abierto en otro campo, el desplazamiento es el que lo deja a la vista.
    if (esCampoDeTexto(document.activeElement)) return;
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

/** Va una vez, al arrancar. Fuera del iPhone no hace nada. */
export function iniciarVistaIos(): void {
    if (!esIos) return;
    document.documentElement.classList.add("plataforma-ios");
    // Tras el `focusout` el foco aún no ha llegado al campo siguiente: se mira un instante después.
    document.addEventListener("focusout", () => {
        window.setTimeout(recolocar, 100);
    });
    window.visualViewport?.addEventListener("resize", recolocar);
}
