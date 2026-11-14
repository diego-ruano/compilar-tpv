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
import { useContactSettings } from "../src/shared/stores/useContactSettings";
import { useAuth } from "../src/shared/stores/useAuth";
const foto = (cambio: Partial<EstadoSocketHandy> = {}): EstadoSocketHandy => ({ revision: 0, generacion: 1, conexion: 1, tenant_id: "negocio-a", estado: "conectada", main_online: true, volcando: false, rechazo: null, ...cambio });
const asentar = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
/** Los `init` de los tres stores de ajustes: negocio, ticket y contacto. */
const inits = () => [useBusinessSettings, useTicketSettings, useContactSettings].map((s) => vi.mocked(s.getState().init));
beforeEach(() => {
    h.listen.mockImplementation(async (nombre, callback) => {
        h.listeners.set(nombre, callback);
        const quitar = vi.fn(() => h.listeners.delete(nombre)); h.removes.push(quitar); return quitar;
    });
    h.invoke.mockImplementation(async (nombre) => nombre === "handy_socket_estado" ? foto() : null);
    vi.spyOn(useBusinessSettings.getState(), "init").mockResolvedValue();
    vi.spyOn(useTicketSettings.getState(), "init").mockResolvedValue();
    vi.spyOn(useContactSettings.getState(), "init").mockResolvedValue();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    useMainPresence.setState({ mainOnline: null, volcando: false, rechazo: null, generacion: -1, conexion: -1, tenantId: null, estadoConexion: "pausada" });
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
        vi.mocked(queryClient.invalidateQueries).mockClear();
        const info = {ids: ["c1"], touchedComanda: true, uncertain: false, touchedCatalog: false};
        h.listeners.get("handy:cambio")!({payload: {generacion: 1, cambio: {tablas: ["detalle_comanda"], comanda: info}}});
        expect(vi.mocked(queryClient.invalidateQueries).mock.calls.map(([args]) => args?.queryKey)).toEqual([["mesas", "meta"], ["stats"]]);
        expect(useSyncSignal.getState().comanda).toEqual(info); socket.detener();
    });
    it("un cobro de la Main refresca sus áreas, sin releerlo todo ni los ajustes", async () => {
        // Cada cobro escribe en la caja, en el stock y en lo fiscal. Con una sola de esas tablas sin
        // entrada en el mapa, cada venta es un `invalidateQueries()` de todo en cada Handy.
        const socket = iniciarSocketHandy("handy")!; await asentar();
        vi.mocked(queryClient.invalidateQueries).mockClear();
        for (const init of inits()) init.mockClear();
        const tablas = ["comandas", "pagos", "pago_detalles", "lotes_producto", "lote_consumos", "movimientos_caja", "serie_facturacion", "registros_facturacion"];
        h.listeners.get("handy:cambio")!({payload: {generacion: 1, cambio: {tablas, comanda: {ids: ["c1"], touchedComanda: true, uncertain: false, touchedCatalog: true}}}});
        const claves = vi.mocked(queryClient.invalidateQueries).mock.calls.map(([args]) => args?.queryKey);
        expect(claves).not.toContain(undefined);
        expect(claves.map((c) => String(c)).sort()).toEqual(["cuentas", "inventario", "mesas,meta", "proveedores", "stats"]);
        for (const init of inits()) expect(init).not.toHaveBeenCalled();
        socket.detener();
    });
    it("ignora los avisos de una conexión que pertenece al vínculo anterior", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        vi.mocked(queryClient.invalidateQueries).mockClear();
        h.listeners.get("handy:cambio")!({payload: {generacion: 0, cambio: {tablas: null, comanda: {}}}});
        expect(queryClient.invalidateQueries).not.toHaveBeenCalled(); socket.detener();
    });
    it("un cambio sin clasificar obliga al refresco completo y a releer los tres ajustes", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        for (const init of inits()) init.mockClear();
        h.listeners.get("handy:cambio")!({payload: {generacion: 1, cambio: {tablas: null, comanda: {ids: [], touchedComanda: true, uncertain: true, touchedCatalog: true}}}});
        expect(queryClient.invalidateQueries).toHaveBeenCalledWith();
        for (const init of inits()) expect(init).toHaveBeenCalledOnce();
        socket.detener();
    });
    it("un cambio en una tabla de ajustes relee sólo su store", async () => {
        // Cada store es una petición a la nube: cambiar el teléfono de contacto no es motivo para
        // volver a pedir los ajustes del negocio y los del ticket.
        const socket = iniciarSocketHandy("handy")!; await asentar();
        const [negocio, ticket, contacto] = inits();
        const sinTicket = {ids: [], touchedComanda: false, uncertain: false, touchedCatalog: false};
        const llega = (tablas: string[]) => {
            for (const init of inits()) init.mockClear();
            h.listeners.get("handy:cambio")!({payload: {generacion: 1, cambio: {tablas, comanda: sinTicket}}});
        };
        llega(["contact_settings"]);
        expect(contacto).toHaveBeenCalledOnce(); expect(negocio).not.toHaveBeenCalled(); expect(ticket).not.toHaveBeenCalled();
        llega(["business_settings"]);
        expect(negocio).toHaveBeenCalledOnce(); expect(ticket).not.toHaveBeenCalled(); expect(contacto).not.toHaveBeenCalled();
        llega(["ticket_settings", "business_settings"]);
        expect(negocio).toHaveBeenCalledOnce(); expect(ticket).toHaveBeenCalledOnce(); expect(contacto).not.toHaveBeenCalled();
        llega(["pagos"]);
        for (const init of inits()) expect(init).not.toHaveBeenCalled();
        socket.detener();
    });
    it("una conexión nueva relee los tres ajustes, y la misma conexión ninguno", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        for (const init of inits()) expect(init).toHaveBeenCalledOnce();
        for (const init of inits()) init.mockClear();
        // La presencia de la Main no ha cambiado ni hay conexión nueva: nada que releer.
        h.listeners.get("handy:estado")!({payload: foto({revision: 1})});
        for (const init of inits()) expect(init).not.toHaveBeenCalled();
        h.listeners.get("handy:estado")!({payload: foto({revision: 2, conexion: 2})});
        for (const init of inits()) expect(init).toHaveBeenCalledOnce();
        socket.detener();
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
        useMainPresence.setState({mainOnline: true});
        h.listen.mockImplementationOnce(async () => { throw new Error("fallo"); });
        const socket = iniciarSocketHandy("handy")!; await asentar();
        expect(h.listeners.size).toBe(0); expect(h.invoke).not.toHaveBeenCalled(); expect(useMainPresence.getState().mainOnline).toBeNull();
        socket.reconectarSiHaceFalta(true); await asentar();
        expect(h.listeners.size).toBe(2); expect(useMainPresence.getState().mainOnline).toBe(true); socket.detener();
    });
    it("recupera cambios perdidos al reconectar y al volver a observar el servicio", async () => {
        let socket = iniciarSocketHandy("handy")!; await asentar();
        vi.mocked(queryClient.invalidateQueries).mockClear();
        const tick = useSyncSignal.getState().tick;
        h.listeners.get("handy:estado")!({payload: foto({revision: 2, conexion: 2})});
        expect(queryClient.invalidateQueries).toHaveBeenCalledOnce();
        expect(useSyncSignal.getState().tick).toBe(tick + 1); expect(useSyncSignal.getState().comanda.uncertain).toBe(true);
        socket.detener(); socket = iniciarSocketHandy("handy")!; await asentar();
        expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2); socket.detener();
    });
    it("espera a que la Main termine el volcado antes de releer datos perdidos", async () => {
        h.invoke.mockImplementation(async () => foto({volcando: true}));
        const socket = iniciarSocketHandy("handy")!; await asentar();
        expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
        h.listeners.get("handy:estado")!({payload: foto({revision: 1, volcando: false})});
        expect(queryClient.invalidateQueries).toHaveBeenCalledOnce(); socket.detener();
    });
    it("cambiar de vínculo retira la sesión y las cachés anteriores sin otro logout nativo", async () => {
        const socket = iniciarSocketHandy("handy")!; await asentar();
        useAuth.setState({role: "Administrador", idUsuario: "usuario-a"});
        queryClient.setQueryData(["clientes"], ["cliente-a"]);
        useBusinessSettings.setState({business_name: "Negocio A"});
        h.listeners.get("handy:estado")!({payload: foto({revision: 1, generacion: 2, tenant_id: null, estado: "pausada", main_online: null})});
        expect(useAuth.getState().idUsuario).toBeNull(); expect(queryClient.getQueryData(["clientes"])).toBeUndefined();
        expect(useBusinessSettings.getState().business_name).toBe("TPV"); expect(useMainPresence.getState().mainOnline).toBeNull();
        expect(h.invoke.mock.calls.map(([nombre]) => nombre)).toEqual(["handy_socket_estado"]); socket.detener();
    });
});
