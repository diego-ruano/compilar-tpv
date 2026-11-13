// La clave de idempotencia del correo de un pedido (`features/proveedores/claveDeEnvio.ts`): la
// misma mientras se reintenta el mismo pedido sin cambiarlo; otra si cambia o es otro pedido.
import { describe, expect, it } from "vitest";

import { claveDeEnvio } from "../src/features/proveedores/claveDeEnvio";

let n = 0;
const nuevoId = () => `id-${++n}`;
const correo = (notas: string) => ({ email_destino: "pedidos@bebidas.test", nombre_proveedor: "Bebidas", notas, lineas: [] });

describe("la clave del correo de un pedido", () => {
  it("un reintento del mismo pedido sin cambios lleva la misma", () => {
    const primera = claveDeEnvio(null, "p-1", correo("lo de siempre"), nuevoId);
    const reintento = claveDeEnvio(primera, "p-1", correo("lo de siempre"), nuevoId);
    expect(reintento.id).toBe(primera.id);
  });

  it("si el pedido cambia, o es otro, lleva otra", () => {
    const primera = claveDeEnvio(null, "p-1", correo("lo de siempre"), nuevoId);
    expect(claveDeEnvio(primera, "p-1", correo("y dos cajas más"), nuevoId).id).not.toBe(primera.id);
    expect(claveDeEnvio(primera, "p-2", correo("lo de siempre"), nuevoId).id).not.toBe(primera.id);
  });

  it("sin intento anterior es nueva, y es un UUID si no se le dice otra cosa", () => {
    expect(claveDeEnvio(null, "p-1", correo("x")).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
