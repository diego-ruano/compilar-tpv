// La clave de idempotencia del correo de un pedido (`features/proveedores/claveDeEnvio.ts`): la
// misma mientras se reintenta el mismo pedido sin cambiarlo, aunque entretanto se mande otro pedido
// o se cierre la aplicación; otra si cambia, si es otro pedido, si el envío ya terminó bien o si
// lleva una semana sin retomarse.
import { describe, expect, it } from "vitest";

import { claveDeEnvio, envioTerminado } from "../src/features/proveedores/claveDeEnvio";

let n = 0;
const nuevoId = () => `id-${++n}`;
const correo = (notas: string) => ({ email_destino: "pedidos@bebidas.test", nombre_proveedor: "Bebidas", notas, lineas: [] });

/** El almacenamiento de la aplicación, que sobrevive a cerrarla. */
function almacen(): Storage {
  const datos = new Map<string, string>();
  return {
    getItem: (k: string) => datos.get(k) ?? null,
    setItem: (k: string, v: string) => void datos.set(k, v),
    removeItem: (k: string) => void datos.delete(k),
    clear: () => datos.clear(),
    key: (i: number) => [...datos.keys()][i] ?? null,
    get length() {
      return datos.size;
    },
  };
}

describe("la clave del correo de un pedido", () => {
  it("un reintento del mismo pedido sin cambios lleva la misma, aunque entretanto se mande otro", () => {
    const a = almacen();
    const primera = claveDeEnvio("p-1", correo("lo de siempre"), { almacen: a, nuevoId });
    const deOtro = claveDeEnvio("p-2", correo("lo de siempre"), { almacen: a, nuevoId });
    expect(deOtro).not.toBe(primera);
    expect(claveDeEnvio("p-1", correo("lo de siempre"), { almacen: a, nuevoId })).toBe(primera);
  });

  it("se queda en el almacenamiento: cerrar y volver a abrir la aplicación no la pierde", () => {
    const a = almacen();
    const primera = claveDeEnvio("p-1", correo("x"), { almacen: a, nuevoId });
    // Lo que se lee al volver a abrir es lo guardado, no lo que tenía la aplicación en memoria.
    expect(JSON.parse(a.getItem("tpv:pedidos:enviosEnCurso:v1")!)["p-1"]).toMatchObject({ id: primera });
    expect(claveDeEnvio("p-1", correo("x"), { almacen: a, nuevoId })).toBe(primera);
  });

  it("si el pedido cambia lleva otra", () => {
    const a = almacen();
    const primera = claveDeEnvio("p-3", correo("lo de siempre"), { almacen: a, nuevoId });
    expect(claveDeEnvio("p-3", correo("y dos cajas más"), { almacen: a, nuevoId })).not.toBe(primera);
  });

  it("un envío que terminó bien olvida su clave: mandarlo otra vez es otro envío", () => {
    const a = almacen();
    const primera = claveDeEnvio("p-4", correo("x"), { almacen: a, nuevoId });
    envioTerminado("p-4", { almacen: a });
    expect(claveDeEnvio("p-4", correo("x"), { almacen: a, nuevoId })).not.toBe(primera);
  });

  it("una que nadie retoma caduca a la semana", () => {
    const a = almacen();
    const ahora = Date.now();
    const primera = claveDeEnvio("p-5", correo("x"), { almacen: a, nuevoId, ahora });
    expect(claveDeEnvio("p-5", correo("x"), { almacen: a, nuevoId, ahora: ahora + 8 * 24 * 3600 * 1000 })).not.toBe(primera);
  });

  it("sin almacenamiento, en memoria; y sin decirle cómo, la clave es un UUID", () => {
    const primera = claveDeEnvio("p-6", correo("x"), { almacen: null });
    expect(primera).toMatch(/^[0-9a-f-]{36}$/);
    expect(claveDeEnvio("p-6", correo("x"), { almacen: null })).toBe(primera);
  });

  it("un almacenamiento ilegible no rompe el envío", () => {
    const a = almacen();
    a.setItem("tpv:pedidos:enviosEnCurso:v1", "{no es json");
    expect(claveDeEnvio("p-7", correo("x"), { almacen: a, nuevoId })).toMatch(/^id-/);
  });
});
