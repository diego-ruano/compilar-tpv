import { invoke } from "@tauri-apps/api/core";
import { toAppError, type AppErrorDto } from "./errores";

/** Un comando que ha fallado, tal como lo ve quien lo invocó. */
export type FalloAlInvocar = { comando: string; error: AppErrorDto; duracionMs: number };

let alFallar: ((fallo: FalloAlInvocar) => void) | null = null;
const registrados = new WeakSet<object>();

/**
 * Lo que hay que hacer cuando un comando falla: registrarlo (`fallosDeComandos.ts` de la app). Por
 * aquí pasan todos, así que nadie más tiene que acordarse; avisar a quien está delante sigue siendo
 * cosa de cada pantalla.
 */
export function alFallarUnComando(fn: ((fallo: FalloAlInvocar) => void) | null): void {
    alFallar = fn;
}

/** ¿Este error ya lo registró `invocar`? Para que quien lo recoja después no lo cuente dos veces. */
export function yaRegistrado(e: unknown): boolean {
    return typeof e === "object" && e !== null && registrados.has(e);
}

/** Transporte interno de los comandos generados; las pantallas sólo reciben sus firmas tipadas. */
export async function invocar<T>(nombre: string, args?: Record<string, unknown>): Promise<T> {
    const inicio = performance.now();
    try {
        return await invoke<T>(nombre, args);
    } catch (e) {
        const error = toAppError(e);
        if (alFallar) {
            try {
                alFallar({ comando: nombre, error, duracionMs: Math.round(performance.now() - inicio) });
                registrados.add(error);
            } catch {
                // Registrar nunca cambia lo que recibe quien llamó.
            }
        }
        throw error;
    }
}
