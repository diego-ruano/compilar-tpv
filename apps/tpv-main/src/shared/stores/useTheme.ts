// src/shared/stores/useTheme.ts
import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Theme = "light" | "dark";

const STORAGE_KEY = "tpv:theme";

// Colores de fondo por tema en RGBA (0-255), espejo de --bg en Global.css.
// En Windows el canal alpha se ignora; ambos son opacos.
const BG_DARK: [number, number, number, number] = [14, 15, 19, 255]; // #0e0f13
const BG_LIGHT: [number, number, number, number] = [243, 248, 255, 255]; // #f3f8ff

/**
 * Fija el color de fondo NATIVO del WebView2 (no del DOM). Ese color es el que
 * el webview pinta durante una recarga (Ctrl+R), antes de que exista la nueva
 * página; por defecto es blanco y ahí nace el destello. Al fijarlo aquí persiste
 * entre recargas dentro del mismo proceso, eliminando el flash blanco.
 */
function applyNativeBackground(dark: boolean) {
    try {
        void getCurrentWindow()
            .setBackgroundColor(dark ? BG_DARK : BG_LIGHT)
            .catch(() => {
                /* API/permiso no disponible: ignoramos */
            });
    } catch {
        /* fuera de contexto Tauri: ignoramos */
    }
}

/**
 * Lee el tema inicial.
 * Por ahora arrancamos en CLARO por defecto (las pantallas aún se están
 * migrando a dark mode fase a fase). Respetamos lo que el usuario haya
 * elegido previamente (localStorage). En el futuro podríamos respetar
 * prefers-color-scheme como default.
 */
function getInitialTheme(): Theme {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === "light" || stored === "dark") return stored;
    } catch {
        /* localStorage no disponible: ignoramos */
    }
    return "light";
}

function applyThemeClass(theme: Theme) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const dark = theme === "dark";
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
    // Mantiene sincronizado el fondo inline que fija `public/tema-inicial.js` (lo carga
    // index.html antes del primer pintado), para que un cambio de tema en caliente no deje al
    // <html> con un color de fondo obsoleto detrás del body.
    root.style.backgroundColor = dark ? "#0e0f13" : "#f3f8ff";
    root.style.colorScheme = dark ? "dark" : "light";
    applyNativeBackground(dark);
    applyAndroidBars(dark);
}

/**
 * RI-76: en Android la app no se dibuja bajo las barras del sistema, y lo que queda detrás de ellas
 * lo pinta `MainActivity`. El puente sólo existe allí.
 */
function applyAndroidBars(dark: boolean) {
    try {
        (window as { TpvAndroid?: { tema(oscuro: boolean): void } }).TpvAndroid?.tema(dark);
    } catch {
        /* puente no disponible: ignoramos */
    }
}

type ThemeState = {
    theme: Theme;
    setTheme: (t: Theme) => void;
    toggleTheme: () => void;
};

export const useTheme = create<ThemeState>((set, get) => ({
    theme: getInitialTheme(),

    setTheme: (t) => {
        applyThemeClass(t);
        try {
            window.localStorage.setItem(STORAGE_KEY, t);
        } catch {
            /* ignoramos errores de persistencia */
        }
        set({ theme: t });
    },

    toggleTheme: () => {
        const next = get().theme === "dark" ? "light" : "dark";
        get().setTheme(next);
    },
}));

/**
 * Aplica la clase del tema al <html> lo antes posible (antes del render)
 * para evitar el "flash" de tema incorrecto. Se llama desde main.tsx.
 */
export function initTheme() {
    applyThemeClass(useTheme.getState().theme);
}
