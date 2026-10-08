import { expect, it } from "vitest";
import { crearColaOperaciones } from "../src/shared/lib/colaOperaciones";

it("espera la confirmación antes de ejecutar la siguiente escritura, incluso después de un fallo", async () => {
    const cola = crearColaOperaciones();
    let terminar!: () => void;
    const llamadas: number[] = [];
    const primera = cola.ejecutar(async () => { llamadas.push(1); await new Promise<void>(r => { terminar = r; }); });
    const segunda = cola.ejecutar(async () => { llamadas.push(2); throw new Error("Sin stock"); });
    const fallo = expect(segunda).rejects.toThrow("Sin stock");
    const tercera = cola.ejecutar(async () => { llamadas.push(3); return "confirmado"; });
    await Promise.resolve();
    expect(llamadas).toEqual([1]);
    expect(cola.pendientes()).toBe(3);
    terminar();
    await primera;
    await fallo;
    expect(await tercera).toBe("confirmado");
    await cola.esperar();
    expect(llamadas).toEqual([1, 2, 3]);
    expect(cola.pendientes()).toBe(0);
});
