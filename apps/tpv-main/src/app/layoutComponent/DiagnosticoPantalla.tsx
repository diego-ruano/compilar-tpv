// src/app/layoutComponent/DiagnosticoPantalla.tsx
//
// Diagnóstico de la pantalla en el móvil: cinco toques seguidos en el logo de la barra de título. Sin
// un Mac no hay inspector de Safari para el iPhone, y esto enseña lo que haría falta mirar en él:
// qué está desplazado, qué es más ancho que la pantalla, qué contenedores hay bajo el último toque y
// los errores de JavaScript. Mientras está cerrado no hace nada.

import { useEffect, useState } from "react";

declare global {
    interface Window {
        /** Los errores que apunta `public/diagnostico-arranque.js`. */
        __erroresTpv?: string[];
    }
}

function nombre(el: Element): string {
    const id = el.id ? `#${el.id}` : "";
    const clases = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 4).join(".") : "";
    return `${el.tagName.toLowerCase()}${id}${clases ? `.${clases}` : ""}`;
}

function esDesplazable(el: Element): boolean {
    const e = getComputedStyle(el);
    return /(auto|scroll)/.test(e.overflowX) || /(auto|scroll)/.test(e.overflowY);
}

function medidas(el: Element): string {
    return `${nombre(el)}\n   desplazado x=${Math.round(el.scrollLeft)} y=${Math.round(el.scrollTop)} · contenido ${el.scrollWidth}×${el.scrollHeight} en ${el.clientWidth}×${el.clientHeight}`;
}

let ultimoToque: Element | null = null;

function informe(): string {
    const vv = window.visualViewport;
    const raiz = document.documentElement;
    const zona = document.querySelector(".zona-segura");
    const lineas: string[] = [
        `Ventana ${window.innerWidth}×${window.innerHeight}, desplazada x=${window.scrollX} y=${window.scrollY}`,
        vv
            ? `Vista visible ${Math.round(vv.width)}×${Math.round(vv.height)}, desplazada x=${Math.round(vv.offsetLeft)} y=${Math.round(vv.offsetTop)}, escala ${vv.scale}`
            : "Sin visualViewport",
        `Documento: contenido ${raiz.scrollWidth}×${raiz.scrollHeight} en ${raiz.clientWidth}×${raiz.clientHeight}`,
        `Zonas seguras (arriba derecha abajo izquierda): ${zona ? getComputedStyle(zona).padding : "—"}`,
    ];

    const desplazados: string[] = [];
    const anchos: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (el.closest("[data-diagnostico]")) continue;
        if (el.scrollLeft > 0 || el.scrollTop > 0) desplazados.push(medidas(el));
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && esDesplazable(el)) anchos.push(medidas(el));
    }
    lineas.push("", `Desplazados (${desplazados.length}):`, ...desplazados.slice(0, 8));
    lineas.push("", `Con contenido más ancho que ellos (${anchos.length}):`, ...anchos.slice(0, 8));

    const cadena: string[] = [];
    for (let el = ultimoToque; el && el !== document.body; el = el.parentElement) {
        if (esDesplazable(el)) cadena.push(medidas(el));
    }
    lineas.push("", "Contenedores bajo el último toque (de dentro a fuera):", ...(cadena.length ? cadena : ["—"]));

    const errores = window.__erroresTpv ?? [];
    lineas.push("", `Errores (${errores.length}):`, ...(errores.length ? errores.slice(-10) : ["—"]));
    lineas.push("", navigator.userAgent);
    return lineas.join("\n");
}

export default function DiagnosticoPantalla({ onCerrar }: { onCerrar: () => void }) {
    const [texto, setTexto] = useState(informe);

    useEffect(() => {
        const apuntar = (e: TouchEvent) => {
            if (e.target instanceof Element && !e.target.closest("[data-diagnostico]")) ultimoToque = e.target;
        };
        document.addEventListener("touchstart", apuntar, { passive: true, capture: true });
        const reloj = window.setInterval(() => setTexto(informe()), 700);
        return () => {
            document.removeEventListener("touchstart", apuntar, { capture: true });
            window.clearInterval(reloj);
        };
    }, []);

    return (
        <div
            data-diagnostico
            className="pointer-events-none fixed inset-x-2 bottom-2 top-1/2 z-[9999] flex flex-col rounded-xl border border-border bg-surface/95 shadow-2xl"
        >
            <div className="pointer-events-auto flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <p className="text-sm font-bold text-fg">Diagnóstico de la pantalla</p>
                <button
                    type="button"
                    onClick={onCerrar}
                    className="rounded-lg border border-border px-3 py-1 text-sm font-semibold text-fg"
                >
                    Cerrar
                </button>
            </div>
            <pre className="pointer-events-auto min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-snug text-fg">
                {texto}
            </pre>
        </div>
    );
}
