// RES-MEJ-02: una reserva de 5 en una mesa de 4 se guardaba sin aviso. Se avisa, sin impedirlo.
import { expect, it } from "vitest";

import { avisoDeAforo, mesaConPlazas } from "../src/features/reservas/aforo";

it("avisa sólo si son más que las plazas", () => {
    expect(avisoDeAforo(5, 4)).toBe("Son 5 y la mesa es de 4. Se puede guardar igualmente.");
    expect(avisoDeAforo(4, 4)).toBeNull();
    expect(avisoDeAforo(2, 4)).toBeNull();
    expect(avisoDeAforo(5, 0)).toBeNull(); // sin plazas apuntadas
});

it("la mesa elegida dice sus plazas", () => {
    expect(mesaConPlazas("1", 4)).toBe("1 · 4 plazas");
    expect(mesaConPlazas("Barra", 1)).toBe("Barra · 1 plaza");
    expect(mesaConPlazas("2", 0)).toBe("2");
});
