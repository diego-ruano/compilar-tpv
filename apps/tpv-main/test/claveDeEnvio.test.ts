// La clave de idempotencia del correo de un pedido (`features/proveedores/claveDeEnvio.ts`): la
// misma mientras se reintenta el mismo pedido sin cambiarlo, aunque entretanto se mande otro pedido;
// otra si cambia, si es otro pedido o si el envío ya terminó bien.
import { describe, expect, it } from "vitest";

import { claveDeEnvio, envioTerminado } from "../src/features/proveedores/claveDeEnvio";

let n = 0;
const nuevoId = () => `id-${++n}`;
const correo = (notas: string) => ({ email_destino: "pedidos@bebidas.test", nombre_proveedor: "Bebidas", notas, lineas: [] });

describe("la clave del correo de un pedido", () => {
  it("un reintento del mismo pedido sin cambios lleva la misma, aunque entretanto se mande otro", () => {
    const primera = claveDeEnvio("p-1", correo("lo de siempre"), nuevoId);
    const deOtro = claveDeEnvio("p-2", correo("lo de siempre"), nuevoId);
    expect(deOtro).not.toBe(primera);
    expect(claveDeEnvio("p-1", correo("lo de siempre"), nuevoId)).toBe(primera);
  });

  it("si el pedido cambia lleva otra", () => {
    const primera = claveDeEnvio("p-3", correo("lo de siempre"), nuevoId);
    expect(claveDeEnvio("p-3", correo("y dos cajas más"), nuevoId)).not.toBe(primera);
  });

  it("un envío que terminó bien olvida su clave: mandarlo otra vez es otro envío", () => {
    const primera = claveDeEnvio("p-4", correo("x"), nuevoId);
    envioTerminado("p-4");
    expect(claveDeEnvio("p-4", correo("x"), nuevoId)).not.toBe(primera);
  });

  it("sin decirle cómo, la clave es un UUID", () => {
    expect(claveDeEnvio("p-5", correo("x"))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
