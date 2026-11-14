import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (e: {payload: unknown}) => void>(), removes: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, fn) => { h.listeners.set(name, fn); const remove = vi.fn(() => h.listeners.delete(name)); h.removes.push(remove); return remove; }) }));
import { iniciarSocketMain } from "../src/shared/lib/socketMain";
import { useEstadoSync } from "../src/shared/stores/useEstadoSync";
import { useSyncSignal } from "../src/shared/stores/useSyncSignal";
import { queryClient } from "../src/shared/lib/queryClient";
import { useBusinessSettings } from "../src/shared/stores/useBusinessSettings";
import { useTicketSettings } from "../src/shared/stores/useTicketSettings";
import { useContactSettings } from "../src/shared/stores/useContactSettings";
const entrada = { modo: "tpv" as const, hidratada: true, preferencia: "auto" as const, datosPerdidos: false, reconciliacionPendiente: false };
const asentar = async () => { for (let i=0; i<10; i++) await Promise.resolve(); };
afterEach(() => { h.listeners.clear(); h.removes=[]; vi.restoreAllMocks(); h.invoke.mockReset(); });
function backend() { h.invoke.mockImplementation(async (name) => name === "sync_estado" ? {revision:0,estado:"conectado",detalle:null,fase_recuperacion:"inactiva",fallos_recuperacion:0} : null); }
describe("presentación de la réplica nativa", () => {
    it("lee el estado nativo sin abrir un socket ni pedir SQL", async () => {
        backend(); const socket = iniciarSocketMain(entrada)!; await asentar();
        expect(useEstadoSync.getState().estado).toBe("conectado");
        expect(h.invoke.mock.calls.map(([name]) => name)).toEqual(["sync_estado", "sync_reintentar"]);
        socket.detener(); expect(h.removes.every((fn) => fn.mock.calls.length === 1)).toBe(true);
    });
    it("un snapshot antiguo no sustituye un evento más reciente", async () => {
        let resolver!: (v: unknown) => void;
        h.invoke.mockImplementation((name) => name === "sync_estado" ? new Promise((resolve) => { resolver=resolve; }) : Promise.resolve(null));
        const socket = iniciarSocketMain(entrada)!; await asentar();
        h.listeners.get("sync:estado")!({payload:{revision:2,estado:"conectado",detalle:null,fase_recuperacion:"inactiva",fallos_recuperacion:0}});
        resolver({revision:1,estado:"reconectando",detalle:null,fase_recuperacion:"inactiva",fallos_recuperacion:0}); await asentar();
        expect(useEstadoSync.getState().estado).toBe("conectado"); socket.detener();
    });
    it("refresca sólo las áreas afectadas y conserva el ticket seleccionado", async () => {
        backend(); const socket = iniciarSocketMain(entrada)!; await asentar();
        const invalidar = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
        const info = {ids:["c1"],touchedComanda:true,uncertain:false,touchedCatalog:false};
        h.listeners.get("sync:cambio")!({payload:{tablas:["detalle_comanda"],comanda:info}});
        expect(invalidar.mock.calls.map(([args]) => args?.queryKey)).toEqual([["mesas","meta"],["stats"]]);
        expect(useSyncSignal.getState().comanda).toEqual(info); socket.detener();
    });
    it("un cambio de ajustes que llega de una Handy relee sólo su store, también el de contacto", async () => {
        backend(); const socket = iniciarSocketMain(entrada)!; await asentar();
        vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
        const [negocio, ticket, contacto] = [useBusinessSettings, useTicketSettings, useContactSettings].map((s) => vi.spyOn(s.getState(), "init").mockResolvedValue());
        const comanda = {ids:[],touchedComanda:false,uncertain:false,touchedCatalog:false};
        h.listeners.get("sync:cambio")!({payload:{tablas:["contact_settings"],comanda}});
        expect(contacto).toHaveBeenCalledOnce(); expect(negocio).not.toHaveBeenCalled(); expect(ticket).not.toHaveBeenCalled();
        h.listeners.get("sync:cambio")!({payload:{tablas:["ticket_settings"],comanda}});
        expect(ticket).toHaveBeenCalledOnce(); expect(negocio).not.toHaveBeenCalled(); expect(contacto).toHaveBeenCalledOnce();
        h.listeners.get("sync:cambio")!({payload:{tablas:["pagos"],comanda}});
        expect(negocio).not.toHaveBeenCalled();
        // Sin clasificar no se sabe cuál: los tres.
        h.listeners.get("sync:cambio")!({payload:{tablas:null,comanda}});
        expect(negocio).toHaveBeenCalledOnce(); expect(ticket).toHaveBeenCalledTimes(2); expect(contacto).toHaveBeenCalledTimes(2);
        socket.detener();
    });
    it("cerrar la vista deja de escuchar y mantiene viva la réplica", async () => {
        backend(); const socket = iniciarSocketMain(entrada)!; socket.detener(); await asentar();
        expect(h.listeners.size).toBe(0); expect(h.invoke).not.toHaveBeenCalled();
    });
    it("sólo una confirmación nativa desbloquea la recuperación", async () => {
        backend(); const socket = iniciarSocketMain({...entrada,reconciliacionPendiente:true})!; await asentar();
        useEstadoSync.setState({reconciliacionPendiente:true});
        h.listeners.get("sync:estado")!({payload:{revision:1,estado:"conectado",detalle:null,fase_recuperacion:"verificando",fallos_recuperacion:0}});
        expect(useEstadoSync.getState().reconciliacionPendiente).toBe(true);
        h.listeners.get("sync:estado")!({payload:{revision:2,estado:"conectado",detalle:null,fase_recuperacion:"completada",fallos_recuperacion:0}});
        expect(useEstadoSync.getState().reconciliacionPendiente).toBe(false); socket.detener();
    });
});
