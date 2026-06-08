// src/shared/stores/useTheme.ts
import { create } from "zustand";

export type Theme = "light" | "dark";

const STORAGE_KEY = "tpv:theme";

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
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
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
