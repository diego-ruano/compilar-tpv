import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "./errores";

/** Transporte interno de los comandos generados; las pantallas sólo reciben sus firmas tipadas. */
export async function invocar<T>(nombre: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(nombre, args);
    } catch (e) {
        throw toAppError(e);
    }
}
