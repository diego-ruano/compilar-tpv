/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** La plataforma para la que compila Tauri (`windows`, `android`…); fuera de Tauri no existe. */
    readonly TAURI_ENV_PLATFORM?: string;
}
