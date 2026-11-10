import { beforeEach, expect, it, vi } from "vitest";
import { importarCobrosLegados, leerCobroLegado } from "../src/features/ventaRapida/cobrosLegados";
const guardar = vi.hoisted(() => vi.fn());
const lineas = vi.hoisted(() => vi.fn());
vi.mock("@tpv/client", () => ({ commands: { vrGuardarCobroPendiente: guardar, vrGetLineasComanda: lineas } }));
beforeEach(() => {
    guardar.mockReset();
    lineas.mockReset();
    // Por defecto, el ticket de los cobros está en esta base.
    lineas.mockImplementation(({ id_comanda }: { id_comanda: string }) =>
        Promise.resolve(id_comanda === "comanda" ? [{ ID_Detalle: "detalle", ID_Comanda: "comanda" }] : []));
});
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

it("una copia ilegible o un cobro incompleto no bloquea los de otros operadores", async () => {
    const storage = almacen();
    const roto = "tpv:ventaRapida:pendingCobros:v1:roto";
    const mixto = "tpv:ventaRapida:pendingCobros:v1:mixto";
    const otro = "tpv:ventaRapida:pendingCobros:v1:otro";
    const incompleto = { ...cobro, destinatario: { nombre_razon: "Ana" } };
    storage.setItem(roto, "{JSON ilegible");
    storage.setItem(mixto, JSON.stringify([incompleto, cobro]));
    storage.setItem(otro, JSON.stringify([{ ...cobro, idPago: "otro-pago" }]));
    guardar.mockResolvedValue(undefined);
    await expect(importarCobrosLegados(storage)).rejects.toThrow();
    expect(guardar).toHaveBeenCalledTimes(2);
    expect(storage.getItem(roto)).toBe("{JSON ilegible");
    expect(JSON.parse(storage.getItem(mixto)!)).toEqual([incompleto]);
    expect(storage.getItem(otro)).toBeNull();
});

// AUD-06: la clave antigua no dice de qué negocio era el cobro, y el navegador se queda aunque la
// licencia del equipo pase a otro negocio: antes se importaban todos a la base que hubiera.
it("un cobro antiguo cuyo ticket no está en esta base se aparta como desconocido, sin importarlo", async () => {
    const storage = almacen();
    const clave = "tpv:ventaRapida:pendingCobros:v1:trabajador";
    const ajeno = { ...cobro, idPago: "pago-ajeno", idComanda: "comanda-de-otro-negocio" };
    storage.setItem(clave, JSON.stringify([ajeno, cobro]));
    guardar.mockResolvedValue(undefined);

    await importarCobrosLegados(storage);

    expect(guardar).toHaveBeenCalledTimes(1);
    expect(guardar.mock.calls[0][0].id_pago).toBe(cobro.idPago);
    expect(storage.getItem(clave)).toBeNull();
    expect(JSON.parse(storage.getItem(`tpv:ventaRapida:pendingCobros:desconocidos:${clave}`)!)).toEqual([ajeno]);

    // Una segunda pasada no vuelve a mirarlos ni los importa.
    await importarCobrosLegados(storage);
    expect(guardar).toHaveBeenCalledTimes(1);
});

it("tampoco se importa uno cuyo ticket está pero sin todas las líneas que cobra", async () => {
    const storage = almacen();
    const clave = "tpv:ventaRapida:pendingCobros:v1:trabajador";
    const otrasLineas = { ...cobro, detalleIds: ["detalle", "detalle-de-otro"], ticketItemIds: [] };
    storage.setItem(clave, JSON.stringify([otrasLineas]));
    guardar.mockResolvedValue(undefined);

    await importarCobrosLegados(storage);

    expect(guardar).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getItem(`tpv:ventaRapida:pendingCobros:desconocidos:${clave}`)!)).toEqual([otrasLineas]);
});

it("si no se puede comprobar de quién es, se conserva donde estaba", async () => {
    const storage = almacen();
    const clave = "tpv:ventaRapida:pendingCobros:v1:trabajador";
    storage.setItem(clave, JSON.stringify([cobro]));
    lineas.mockRejectedValue(new Error("Inicia sesión para hacer esto"));

    await expect(importarCobrosLegados(storage)).rejects.toThrow("Inicia sesión");

    expect(guardar).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getItem(clave)!)).toEqual([cobro]);
    expect(storage.getItem(`tpv:ventaRapida:pendingCobros:desconocidos:${clave}`)).toBeNull();
});
