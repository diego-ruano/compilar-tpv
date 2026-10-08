import { beforeEach, expect, it, vi } from "vitest";
import { importarCobrosLegados, leerCobroLegado } from "../src/features/ventaRapida/cobrosLegados";
const guardar = vi.hoisted(() => vi.fn());
vi.mock("@tpv/client", () => ({ commands: { vrGuardarCobroPendiente: guardar } }));
beforeEach(() => guardar.mockReset());
const cobro = { idPago: "0192f7a4-3b1c-7d2e-8f00-123456789abc", idComanda: "comanda", metodo: "efectivo", importeTotal: 300,
    detalleIds: ["detalle"], ticketItemIds: ["detalle-detalle"], destinatario: { nombre_razon: "Señor Prueba", nif: "12345678Z" } };
function almacen() {
    const datos = new Map<string, string>();
    return { get length() { return datos.size; }, key: (i: number) => [...datos.keys()][i] ?? null,
        getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v); }, removeItem: (k: string) => { datos.delete(k); }, clear: () => datos.clear() };
}
it("conserva la copia antigua y el destinatario si SQLite no confirma la importación", async () => {
    const storage = almacen();
    const key = "tpv:ventaRapida:pendingCobros:v1:otro:trabajador";
    storage.setItem(key, JSON.stringify([cobro]));
    guardar.mockRejectedValue(new Error("Disco lleno"));
    await expect(importarCobrosLegados(storage)).rejects.toThrow("Disco lleno");
    expect(JSON.parse(storage.getItem(key)!)).toEqual([cobro]);
    guardar.mockResolvedValue(undefined);
    await importarCobrosLegados(storage);
    expect(storage.getItem(key)).toBeNull();
    expect(guardar.mock.calls[guardar.mock.calls.length - 1][0].destinatario.nombre_razon).toBe("Señor Prueba");
});
it("no descarta ni rebaja a ticket una factura incompleta", () => {
    expect(() => leerCobroLegado({ ...cobro, destinatario: { nombre_razon: "Ana" } })).toThrow("Factura antigua incompleta");
});
