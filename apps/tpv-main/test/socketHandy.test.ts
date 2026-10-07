import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstadoSocketHandy } from "@tpv/contracts";
const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), listeners: new Map<string, (e: {payload: unknown}) => void>(), removes: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("../src/shared/observability/sentry", () => ({ captureException: vi.fn() }));
import { iniciarSocketHandy } from "../src/shared/lib/socketHandy";
import { useMainPresence } from "../src/shared/stores/useMainPresence";
import { useSyncSignal } from "../src/shared/stores/useSyncSignal";
import { queryClient } from "../src/shared/lib/queryClient";
import { useBusinessSettings } from "../src/shared/stores/useBusinessSettings";
import { useTicketSettings } from "../src/shared/stores/useTicketSettings";
const foto = (cambio: Partial<EstadoSocketHandy> = {}): EstadoSocketHandy => ({ revision: 0, generacion: 1, conexion: 1, tenant_id: "negocio-a", estado: "conectada", main_online: true, volcando: false, rechazo: null, ...cambio });
const asentar = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
beforeEach(() => {
    h.listen.mockImplementation(async (nombre, callback) => {
        h.listeners.set(nombre, callback);
        const quitar = vi.fn(() => h.listeners.delete(nombre)); h.removes.push(quitar); return quitar;
    });
    h.invoke.mockImplementation(async (nombre) => nombre === "handy_socket_estado" ? foto() : null);
    vi.spyOn(useBusinessSettings.getState(), "init").mockResolvedValue();
    vi.spyOn(useTicketSettings.getState(), "init").mockResolvedValue();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useMainPresence.setState({ mainOnline: null, volcando: false, rechazo: null });
});
afterEach(() => { h.listeners.clear(); h.removes = []; h.invoke.mockReset(); h.listen.mockReset(); vi.restoreAllMocks(); });
describe("presentación del socket Handy nativo", () => {
    it("sólo observa en modo Handy y no solicita tickets, firmas ni SQL", async () => {
        expect(iniciarSocketHandy("tpv")).toBeNull(); expect(iniciarSocketHandy(null)).toBeNull();
        const socket = iniciarSocketHandy("handy")!; await asentar();
        expect(h.invoke.mock.calls.map(([nombre]) => nombre)).toEqual(["handy_socket_estado"]);
        expect(useMainPresence.getState().mainOnline).toBe(true); socket.detener();
    });
    it("un snapshot atrasado no sustituye una revocación más reciente", async () => {
        let resolver!: (f: EstadoSocketHandy) => void;
        h.invoke.mockImplementation(() => new Promise((resolve) => { resolver = resolve; }));
        const socket = iniciarSocketHandy("handy")!; await asentar();
        h.listeners.get("handy:estado")!({payload: foto({revision: 5, estado: "rechazada", main_online: null, rechazo: "dispositivo"})});
        resolver(foto({revision: 4})); await asentar();
        expect(useMainPresence.getState().rechazo).toBe("dispositivo"); expect(useMainPresence.getState().mainOnline).toBeNull(); socket.detener();
    });
    it("presencia y volcado se publican juntos, sin un desbloqueo intermedio", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        const vistos: unknown[] = []; const quitar = useMainPresence.subscribe((p) => vistos.push([p.mainOnline, p.volcando]));
        h.listeners.get("handy:estado")!({payload: foto({revision: 1, main_online: true, volcando: true})});
        expect(vistos).toEqual([[true, true]]); quitar(); socket.detener();
    });
    it("refresca las áreas y el ticket afectados a partir de metadatos", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        const info = {ids: ["c1"], touchedComanda: true, uncertain: false, touchedCatalog: false};
        h.listeners.get("handy:cambio")!({payload: {generacion: 1, cambio: {tablas: ["detalle_comanda"], comanda: info}}});
        expect(vi.mocked(queryClient.invalidateQueries).mock.calls.map(([args]) => args?.queryKey)).toEqual([["mesas"], ["stats"]]);
        expect(useSyncSignal.getState().comanda).toEqual(info); socket.detener();
    });
    it("ignora los avisos de una conexión que pertenece al vínculo anterior", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        h.listeners.get("handy:cambio")!({payload: {generacion: 0, cambio: {tablas: null, comanda: {}}}});
        expect(queryClient.invalidateQueries).not.toHaveBeenCalled(); socket.detener();
    });
    it("los ajustes se releen y una tabla desconocida obliga al refresco completo", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        h.listeners.get("handy:cambio")!({payload: {generacion: 1, cambio: {tablas: null, comanda: {ids: [], touchedComanda: true, uncertain: true, touchedCatalog: true}}}});
        expect(queryClient.invalidateQueries).toHaveBeenCalledWith();
        expect(useBusinessSettings.getState().init).toHaveBeenCalledOnce(); expect(useTicketSettings.getState().init).toHaveBeenCalledOnce(); socket.detener();
    });
    it("el botón pide un reintento nativo sin recrear los observadores", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar(); socket.reconectarSiHaceFalta(true); await asentar();
        expect(h.invoke).toHaveBeenLastCalledWith("handy_socket_reintentar", {forzar: true}); expect(h.listen).toHaveBeenCalledTimes(2); socket.detener();
    });
    it("desmontar no cierra el servicio y limpia registros que llegan tarde", async () => {
        const socket = iniciarSocketHandy("handy")!; socket.detener(); await asentar();
        expect(h.listeners.size).toBe(0); expect(h.removes.every((quitar) => quitar.mock.calls.length === 1)).toBe(true); expect(h.invoke).not.toHaveBeenCalled();
    });
    it("un fallo parcial al registrar elimina el otro observador", async () => {
        h.listen.mockImplementationOnce(async () => { throw new Error("fallo"); });
        const socket = iniciarSocketHandy("handy")!; await asentar();
        expect(h.listeners.size).toBe(0); expect(h.invoke).not.toHaveBeenCalled(); socket.detener();
    });
});
