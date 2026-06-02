// src/server/index.ts

// =========================================================
// Durable Object principal
// =========================================================
import { TenantHub } from "../durableObjects/tenantHub";
export { TenantHub };

import type { Client } from "@libsql/client/web";
import { createDbClient } from "./db/clients";
import { json, unauthorized, serverError, corsHeaders } from "./utils/response";
import { verifyJwtHs256 } from "./middleware/jwtHs256";

// =========================================================
// Pairing (solo lectura)
// =========================================================
import { handlePairPending } from "./endpoints/rest/pairing/pairPending";

// =========================================================
// Sync
// =========================================================

import { handleSyncChanges } from "./endpoints/rest/sync/syncChanges";

// =========================================================
// Login
// =========================================================
import { handleLoginHashPassword } from "./endpoints/rest/queries/login/loginHashPassword";
import { handleLoginListUsers } from "./endpoints/rest/queries/login/loginListUsers";
import { handleLoginUser } from "./endpoints/rest/queries/login/loginUser";
import { handleLoginTodayPunchStatus } from "./endpoints/rest/queries/login/loginTodayPunchStatus";
import { handleLoginPunch } from "./endpoints/rest/queries/login/loginPunch";
import { handleLoginCompleteInitialSetup } from "./endpoints/rest/queries/login/loginCompleteInitialSetup";
import { handleLoginSetTurnoPartidoHoy } from "./endpoints/rest/queries/login/loginSetTurnoPartidoHoy";

// =========================================================
// Venta rápida (lectura)
// =========================================================
import { handleVrBootstrap } from "./endpoints/rest/queries/vr/reads/vrBootstrap";
import { handleVrListCategoriasVendibles } from "./endpoints/rest/queries/vr/reads/vrListCategoriasVendibles";
import { handleVrListProductosByCategoria } from "./endpoints/rest/queries/vr/reads/vrListProductosByCategoria";
import { handleVrSearchProductos } from "./endpoints/rest/queries/vr/reads/vrSearchProductos";
import { handleVrListComandasBarra } from "./endpoints/rest/queries/vr/reads/vrListComandasBarra";
import { handleVrGetLineasComanda } from "./endpoints/rest/queries/vr/reads/vrGetLineasComanda";
import { handleVrGetIndexRows } from "./endpoints/rest/queries/vr/reads/vrGetIndexRows";
import { handleVrGetDetallesVerTicket } from "./endpoints/rest/queries/vr/reads/vrGetDetallesVerTicket";

// =========================================================
// Venta rápida (escritura)
// =========================================================
import { handleVrCreateComandaBarra } from "./endpoints/rest/queries/vr/writes/vrCreateComandaBarra";
import { handleVrAddLineaComanda } from "./endpoints/rest/queries/vr/writes/vrAddLineaComanda";
import { handleVrRemoveLastUnpaidLinea } from "./endpoints/rest/queries/vr/writes/vrRemoveLastUnpaidLinea";
import { handleVrDeleteLineaIfUnpaid } from "./endpoints/rest/queries/vr/writes/vrDeleteLineaIfUnpaid";
import { handleVrUpdateNotaDetalle } from "./endpoints/rest/queries/vr/writes/vrUpdateNotaDetalle";
import { handleVrCobrarFraccionado } from "./endpoints/rest/queries/vr/writes/vrCobrarFraccionado";
import { handleVrRestarStock } from "./endpoints/rest/queries/vr/writes/vrRestarStock";
import { handleVrDeleteComandaIfSafe } from "./endpoints/rest/queries/vr/writes/vrDeleteComandaIfSafe";

// =========================================================
// Clientes (lectura)
// =========================================================
import { handleClientsGetOverview } from "./endpoints/rest/queries/clients/clientsGetOverview";
import { handleClientsGetClienteForm } from "./endpoints/rest/queries/clients/clientsGetClienteForm";

// =========================================================
// Clientes (escritura)
// =========================================================
import { handleClientsCreateCliente } from "./endpoints/rest/queries/clients/clientsCreateCliente";
import { handleClientsUpdateCliente } from "./endpoints/rest/queries/clients/clientsUpdateCliente";

// =========================================================
// Trabajadores / Turnos / Horarios
// =========================================================
import { handleTrabajadoresGetAll } from "./endpoints/rest/queries/trabajadores/trabajadoresGetAll";
import { handleTrabajadoresGetTrabajadorIdByUsuario } from "./endpoints/rest/queries/trabajadores/trabajadoresGetTrabajadorIdByUsuario";
import { handleTurnosGetAll } from "./endpoints/rest/queries/trabajadores/turnosGetAll";
import { handleTrabajadoresCreate } from "./endpoints/rest/queries/trabajadores/trabajadoresCreate";
import { handleTrabajadoresUpdate } from "./endpoints/rest/queries/trabajadores/trabajadoresUpdate";
import { handleHorariosGetAsignacionesSemana } from "./endpoints/rest/queries/trabajadores/horariosGetAsignacionesSemana";
import { handleHorariosCreateAsignacion } from "./endpoints/rest/queries/trabajadores/horariosCreateAsignacion";
import { handleHorariosUpdateAsignacion } from "./endpoints/rest/queries/trabajadores/horariosUpdateAsignacion";
import { handleHorariosDeleteAsignacion } from "./endpoints/rest/queries/trabajadores/horariosDeleteAsignacion";
import { handleHorariosCopySemanaAsignaciones } from "./endpoints/rest/queries/trabajadores/horariosCopySemanaAsignaciones";
import { handleHorariosSetPredeterminadoDesdeSemana } from "./endpoints/rest/queries/trabajadores/horariosSetPredeterminadoDesdeSemana";

// =========================================================
// Proveedores (lectura)
// =========================================================
import { handleProveedoresGetAll } from "./endpoints/rest/queries/proveedores/proveedoresGetAll";
import { handleProveedoresGetProductos } from "./endpoints/rest/queries/proveedores/proveedoresGetProductos";
import { handleProveedoresGetCategorias } from "./endpoints/rest/queries/proveedores/proveedoresGetCategorias";
import { handleProveedoresGetProductosAll } from "./endpoints/rest/queries/proveedores/proveedoresGetProductosAll";

// =========================================================
// Proveedores (escritura)
// =========================================================
import { handleProveedoresSave } from "./endpoints/rest/queries/proveedores/proveedoresSave";
import { handleProveedoresDelete } from "./endpoints/rest/queries/proveedores/proveedoresDelete";
import { handleProveedoresSetVinculos } from "./endpoints/rest/queries/proveedores/proveedoresSetVinculos";
import { handleProveedoresCreateProducto } from "./endpoints/rest/queries/proveedores/proveedoresCreateProducto";

// =========================================================
// Inventario (lectura)
// =========================================================
import { handleInventarioListCategorias } from "./endpoints/rest/queries/inventory/inventarioListCategorias";
import { handleInventarioListProveedoresMini } from "./endpoints/rest/queries/inventory/inventarioListProveedoresMini";
import { handleInventarioListProductosByCategoria } from "./endpoints/rest/queries/inventory/inventarioListProductosByCategoria";
import { handleInventarioGetResumen } from "./endpoints/rest/queries/inventory/inventarioGetResumen";
import { handleInventarioListAlergenos } from "./endpoints/rest/queries/inventory/inventarioListAlergenos";
import { handleInventarioGetAlergenosProducto } from "./endpoints/rest/queries/inventory/inventarioGetAlergenosProducto";
import { handleInventarioGetProducto } from "./endpoints/rest/queries/inventory/inventarioGetProducto";
import { handleInventarioGetProductDetail } from "./endpoints/rest/queries/inventory/inventarioGetProductDetail";
import { handleInventarioGetProductoDetalle } from "./endpoints/rest/queries/inventory/inventarioGetProductoDetalle";
import { handleInventarioListLotesByProducto } from "./endpoints/rest/queries/inventory/inventarioListLotesByProducto";

// =========================================================
// Inventario (escritura)
// =========================================================
import { handleInventarioCreateCategoria } from "./endpoints/rest/queries/inventory/inventarioCreateCategoria";
import { handleInventarioUpsertProducto } from "./endpoints/rest/queries/inventory/inventarioUpsertProducto";
import { handleInventarioCreateLote } from "./endpoints/rest/queries/inventory/inventarioCreateLote";
import { handleInventarioSetAlergenosProducto } from "./endpoints/rest/queries/inventory/inventarioSetAlergenosProducto";
import { handleInventarioDeleteProducto } from "./endpoints/rest/queries/inventory/inventarioDeleteProducto";
import { handleInventarioAjustarLote } from "./endpoints/rest/queries/inventory/inventarioAjustarLote";

// =========================================================
// Bills / Cuentas (lectura)
// =========================================================
import { handleBillsGetEntradas } from "./endpoints/rest/queries/bills/billsGetEntradas";
import { handleBillsGetSalidas } from "./endpoints/rest/queries/bills/billsGetSalidas";

// =========================================================
// Bills / Cuentas (escritura)
// =========================================================
import { handleBillsCreateGasto } from "./endpoints/rest/queries/bills/billsCreateGasto";
import { handleBillsUpdateGasto } from "./endpoints/rest/queries/bills/billsUpdateGasto";
import { handleBillsDeleteGasto } from "./endpoints/rest/queries/bills/billsDeleteGasto";
import { handleBillsUpdatePago } from "./endpoints/rest/queries/bills/billsUpdatePago";
import { handleBillsDeletePago } from "./endpoints/rest/queries/bills/billsDeletePago";

// =========================================================
// Stats (solo lectura)
// =========================================================
import { handleStatsMesasGet } from "./endpoints/rest/queries/stats/statsMesasGet";
import { handleStatsProductosListCategorias } from "./endpoints/rest/queries/stats/statsProductosListCategorias";
import { handleStatsProductosResumen } from "./endpoints/rest/queries/stats/statsProductosResumen";
import { handleStatsReservasResumen } from "./endpoints/rest/queries/stats/statsReservasResumen";
import { handleStatsTrabajadoresResumen } from "./endpoints/rest/queries/stats/statsTrabajadoresResumen";
import { handleStatsClientesResumen } from "./endpoints/rest/queries/stats/statsClientesResumen";
import { handleStatsProveedoresResumen } from "./endpoints/rest/queries/stats/statsProveedoresResumen";

// =========================================================
// Tareas
// =========================================================
import { handleTareasGetTrabajadores } from "./endpoints/rest/queries/tasks/tareasGetTrabajadores";
import { handleTareasGetTareasAdmin } from "./endpoints/rest/queries/tasks/tareasGetTareasAdmin";
import { handleTareasGetTareaById } from "./endpoints/rest/queries/tasks/tareasGetTareaById";
import { handleTareasGetTareaAsignados } from "./endpoints/rest/queries/tasks/tareasGetTareaAsignados";
import { handleTareasGetMisTareas } from "./endpoints/rest/queries/tasks/tareasGetMisTareas";
import { handleTareasCreateTarea } from "./endpoints/rest/queries/tasks/tareasCreateTarea";
import { handleTareasUpdateTarea } from "./endpoints/rest/queries/tasks/tareasUpdateTarea";
import { handleTareasSetAsignacionesTarea } from "./endpoints/rest/queries/tasks/tareasSetAsignacionesTarea";
import { handleTareasDeleteTarea } from "./endpoints/rest/queries/tasks/tareasDeleteTarea";
import { handleTareasMarcarTareaFinalizada } from "./endpoints/rest/queries/tasks/tareasMarcarFinalizada";

// =========================================================
// Mesas / Comandas / Ticket / Cocina
// =========================================================
import { handleCatalogoListCategoriasVendibles } from "./endpoints/rest/queries/tables/catalogoListCategoriasVendibles";
import { handleCatalogoListProductosByCategoria } from "./endpoints/rest/queries/tables/catalogoListProductosByCategoria";
import { handleCatalogoSearchProductosByNombre } from "./endpoints/rest/queries/tables/catalogoSearchProductosByNombre";
import { handleComandasGetAbiertaByMesa } from "./endpoints/rest/queries/tables/comandasGetAbiertaByMesa";
import { handleComandasGetLineas } from "./endpoints/rest/queries/tables/comandasGetLineas";
import { handleComandasAbrir } from "./endpoints/rest/queries/tables/comandasAbrir";
import { handleComandasAddLinea } from "./endpoints/rest/queries/tables/comandasAddLinea";
import { handleComandasSetTrabajadorIfNull } from "./endpoints/rest/queries/tables/comandasSetTrabajadorIfNull";
import { handleMesasLoadLayout } from "./endpoints/rest/queries/tables/mesasLoadLayout";
import { handleMesasSaveLayout } from "./endpoints/rest/queries/tables/mesasSaveLayout";
import { handleMesasGetOcupadas } from "./endpoints/rest/queries/tables/mesasGetOcupadas";
import { handleMesasMetaAll } from "./endpoints/rest/queries/tables/mesasMetaAll";
import { handleTicketRemoveOnePendingDetalle } from "./endpoints/rest/queries/tables/ticketRemoveOnePendingDetalle";
import { handleTicketDeleteDetalle } from "./endpoints/rest/queries/tables/ticketDeleteDetalle";
import { handleTicketUpdateDetalleNota } from "./endpoints/rest/queries/tables/ticketUpdateDetalleNota";
import { handleTicketCobrarDetalles } from "./endpoints/rest/queries/tables/ticketCobrarDetalles";
import { handleKitchenListTodayPending } from "./endpoints/rest/queries/tables/kitchenListTodayPending";
import { handleKitchenSetLineState } from "./endpoints/rest/queries/tables/kitchenSetLineState";
import { handleReservasSetEstado } from "./endpoints/rest/queries/tables/reservasSetEstado";
import { handleComandasCerrar } from "./endpoints/rest/queries/tables/comandasCerrar";
import { handleComandasCreateBarra } from "./endpoints/rest/queries/tables/comandasCreateBarra";
import { handleComandasDeleteBarraIfSafe } from "./endpoints/rest/queries/tables/comandasDeleteBarraIfSafe";
import { handleComandasGetOrCreateBarra } from "./endpoints/rest/queries/tables/comandasGetOrCreateBarra";
import { handleComandasListBarra } from "./endpoints/rest/queries/tables/comandasListBarra";
import { handleMesasGetOrCreateMesaBarra } from "./endpoints/rest/queries/tables/mesasGetOrCreateMesaBarra";

// =========================================================
// Reservas
// =========================================================
import { handleReservasGetMeta } from "./endpoints/rest/queries/reservations/reservasGetMeta";
import { handleReservasGetMes } from "./endpoints/rest/queries/reservations/reservasGetMes";
import { handleReservasSave } from "./endpoints/rest/queries/reservations/reservasSave";
import { handleReservasDelete } from "./endpoints/rest/queries/reservations/reservasDelete";

// =========================================================
// Configuración
// =========================================================
import { handleConfigGetBusinessSettings } from "./endpoints/rest/queries/configuracion/configGetBusinessSettings";
import { handleConfigPatchBusinessSettings } from "./endpoints/rest/queries/configuracion/configPatchBusinessSettings";
import { handleConfigGetTicketSettings } from "./endpoints/rest/queries/configuracion/configGetTicketSettings";
import { handleConfigPatchTicketSettings } from "./endpoints/rest/queries/configuracion/configPatchTicketSettings";

export interface Env {
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;

    LICENSE_JWT_SECRET: string;
    LICENSE_STORE_KEY: string;

    TenantHub: DurableObjectNamespace;
    ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

// =========================================================
// Cliente central cacheado por isolate
// =========================================================
let centralDb: Client | null = null;

function getCentralDb(env: Env): Client {
    if (!centralDb) {
        centralDb = createDbClient({
            url: env.TURSO_DATABASE_URL,
            authToken: env.TURSO_AUTH_TOKEN,
        });
    }
    return centralDb;
}

function readBearerMaybe(req: Request): string {
    const h = req.headers.get("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m?.[1] || "";
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // =========================================================
        // CORS preflight
        // =========================================================
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(request),
            });
        }

        // =========================================================
        // Health
        // =========================================================
        if (url.pathname === "/health") {
            return json(
                { ok: true, service: "tpv-server", ts: Date.now() },
                200,
                request,
            );
        }

        // =========================================================
        // WebSocket
        // =========================================================
        if (url.pathname === "/ws" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);

                const tokenQ = url.searchParams.get("token") || "";
                const token = tokenQ || readBearerMaybe(request);
                if (!token) return unauthorized(request, "missing_token");

                const payload = await verifyJwtHs256(
                    token,
                    env.LICENSE_JWT_SECRET,
                );

                const tenantId = String((payload as any).tenantId || "");
                const deviceId = String((payload as any).deviceId || "");
                const roleFromToken = String(
                    (payload as any).role || "unknown",
                );

                if (!tenantId || !deviceId) {
                    return unauthorized(request, "invalid_token_claims");
                }

                const r = await dbCentral.execute({
                    sql: `
                        SELECT revoked_at_ms, role, device_pubkey_b64
                        FROM devices
                        WHERE tenant_id=? AND device_id=?
                        LIMIT 1
                    `,
                    args: [tenantId, deviceId],
                });

                const row = r.rows?.[0] as any | undefined;
                if (!row) return unauthorized(request, "device_not_registered");
                if (row.revoked_at_ms) {
                    return unauthorized(request, "device_revoked");
                }

                const roleFinal = String(row.role || roleFromToken || "unknown");
                const pubB64 = String(row.device_pubkey_b64 || "").trim();

                const id = env.TenantHub.idFromName(tenantId);
                const stub = env.TenantHub.get(id);

                const doUrl = new URL(request.url);
                doUrl.pathname = "/ws";

                const doReq0 = new Request(doUrl.toString(), request);
                const h = new Headers(doReq0.headers);
                h.set("x-tenant-id", tenantId);
                h.set("x-device-id", deviceId);
                h.set("x-role", roleFinal);
                if (pubB64) h.set("x-device-pubkey-b64", pubB64);

                return await stub.fetch(new Request(doReq0, { headers: h }));
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Pairing
        // =========================================================
        if (url.pathname === "/v1/pair/pending" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handlePairPending(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Sync
        // =========================================================

        if (url.pathname === "/v1/sync/changes" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleSyncChanges(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Inventario (lectura)
        // =========================================================
        if (url.pathname === "/v1/inventario/categorias" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioListCategorias(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/proveedores-mini" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioListProveedoresMini(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/productos/by-categoria" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioListProductosByCategoria(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/resumen" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioGetResumen(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/alergenos" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioListAlergenos(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/alergenos/by-producto" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioGetAlergenosProducto(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/producto/get" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioGetProducto(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/producto/detail" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioGetProductDetail(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/producto/detalle" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioGetProductoDetalle(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/lotes/by-producto" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioListLotesByProducto(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Login
        // =========================================================
        if (url.pathname === "/v1/login/hash_password" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleLoginHashPassword(request, env, dbCentral);
        }

        if (url.pathname === "/v1/login/users" && request.method === "GET") {
            const dbCentral = getCentralDb(env);
            return await handleLoginListUsers(request, env, dbCentral);
        }

        if (url.pathname === "/v1/login/user" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleLoginUser(request, env, dbCentral);
        }

        if (url.pathname === "/v1/login/today_punch_status" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleLoginTodayPunchStatus(request, env, dbCentral);
        }

        if (url.pathname === "/v1/login/punch" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleLoginPunch(request, env, dbCentral);
        }

        if (url.pathname === "/v1/login/complete_initial_setup" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleLoginCompleteInitialSetup(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/login/set-turno-partido-hoy" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleLoginSetTurnoPartidoHoy(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Venta rápida (lectura)
        // =========================================================
        if (url.pathname === "/v1/vr/bootstrap" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrBootstrap(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/list-categorias-vendibles" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrListCategoriasVendibles(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/list-productos-by-categoria" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrListProductosByCategoria(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/search-productos" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrSearchProductos(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/list-comandas-barra" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrListComandasBarra(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/get-lineas-comanda" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrGetLineasComanda(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/get-index-rows" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrGetIndexRows(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/get-detalles-ver-ticket" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrGetDetallesVerTicket(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Venta rápida (escritura)
        // =========================================================
        if (url.pathname === "/v1/vr/create-comanda-barra" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrCreateComandaBarra(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/add-linea-comanda" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrAddLineaComanda(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/remove-last-unpaid-linea" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrRemoveLastUnpaidLinea(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/delete-linea-if-unpaid" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrDeleteLineaIfUnpaid(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/update-nota-detalle" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrUpdateNotaDetalle(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/cobrar-fraccionado" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrCobrarFraccionado(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/restar-stock" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrRestarStock(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/vr/delete-comanda-if-safe" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleVrDeleteComandaIfSafe(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Inventario (escritura)
        // =========================================================
        if (url.pathname === "/v1/inventario/categoria/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioCreateCategoria(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/producto/upsert" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioUpsertProducto(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/lote/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioCreateLote(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/alergenos/set-producto" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioSetAlergenosProducto(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/producto/delete" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioDeleteProducto(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/inventario/lote/ajustar" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleInventarioAjustarLote(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Clientes (lectura)
        // =========================================================
        if (url.pathname === "/v1/clients/overview" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleClientsGetOverview(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/clients/form" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleClientsGetClienteForm(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Clientes (escritura)
        // =========================================================
        if (url.pathname === "/v1/clients/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleClientsCreateCliente(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/clients/update" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleClientsUpdateCliente(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Trabajadores / Turnos / Horarios
        // =========================================================
        if (url.pathname === "/v1/trabajadores/all" && request.method === "GET") {
            const dbCentral = getCentralDb(env);
            return await handleTrabajadoresGetAll(request, env, dbCentral);
        }

        if (url.pathname === "/v1/trabajadores/id-by-usuario" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleTrabajadoresGetTrabajadorIdByUsuario(
                request,
                env,
                dbCentral,
            );
        }

        if (url.pathname === "/v1/trabajadores/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTrabajadoresCreate(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/trabajadores/update" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTrabajadoresUpdate(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/turnos/all" && request.method === "GET") {
            const dbCentral = getCentralDb(env);
            return await handleTurnosGetAll(request, env, dbCentral);
        }

        if (url.pathname === "/v1/horarios/asignaciones/semana" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleHorariosGetAsignacionesSemana(
                request,
                env,
                dbCentral,
            );
        }

        if (url.pathname === "/v1/horarios/asignacion/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleHorariosCreateAsignacion(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/horarios/asignacion/update" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleHorariosUpdateAsignacion(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/horarios/asignacion/delete" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleHorariosDeleteAsignacion(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/horarios/copy-semana" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleHorariosCopySemanaAsignaciones(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/horarios/set-predeterminado-desde-semana" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleHorariosSetPredeterminadoDesdeSemana(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Reservas
        // =========================================================
        if (url.pathname === "/v1/reservas/meta" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleReservasGetMeta(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/reservas/mes" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleReservasGetMes(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/reservas/save" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleReservasSave(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/reservas/delete" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleReservasDelete(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/reservas/set-estado" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleReservasSetEstado(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Mesas / Comandas / Ticket / Cocina
        // =========================================================
        if (url.pathname === "/v1/comandas/cerrar" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasCerrar(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/create-barra" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasCreateBarra(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/delete-barra-if-safe" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasDeleteBarraIfSafe(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/get-or-create-barra" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasGetOrCreateBarra(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/list-barra" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasListBarra(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/mesas/get-or-create-mesa-barra" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleMesasGetOrCreateMesaBarra(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/mesas/layout/load" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleMesasLoadLayout(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/mesas/layout/save" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleMesasSaveLayout(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/mesas/ocupadas" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleMesasGetOcupadas(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/mesas/meta/all" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleMesasMetaAll(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/catalogo/categorias" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleCatalogoListCategoriasVendibles(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/catalogo/productos/by-categoria" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleCatalogoListProductosByCategoria(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/catalogo/productos/search" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleCatalogoSearchProductosByNombre(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/get-abierta-by-mesa" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasGetAbiertaByMesa(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/get-lineas" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasGetLineas(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/abrir" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasAbrir(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/add-linea" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasAddLinea(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/comandas/set-trabajador-if-null" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleComandasSetTrabajadorIfNull(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/ticket/remove-one-pending" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTicketRemoveOnePendingDetalle(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/ticket/delete-detalle" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTicketDeleteDetalle(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/ticket/update-detalle-notas" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTicketUpdateDetalleNota(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/ticket/cobrar-detalles" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTicketCobrarDetalles(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/kitchen/today/pending" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleKitchenListTodayPending(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/kitchen/set-line-state" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleKitchenSetLineState(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Bills / Cuentas
        // =========================================================
        if (url.pathname === "/v1/bills/entradas" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsGetEntradas(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/bills/salidas" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsGetSalidas(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/bills/gasto/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsCreateGasto(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/bills/gasto/update" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsUpdateGasto(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/bills/gasto/delete" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsDeleteGasto(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/bills/pago/update" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsUpdatePago(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/bills/pago/delete" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleBillsDeletePago(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Proveedores
        // =========================================================
        if (url.pathname === "/v1/proveedores/all" && request.method === "GET") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresGetAll(request, env, dbCentral);
        }

        if (url.pathname === "/v1/proveedores/productos" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresGetProductos(request, env, dbCentral);
        }

        if (url.pathname === "/v1/proveedores/categorias" && request.method === "GET") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresGetCategorias(request, env, dbCentral);
        }

        if (url.pathname === "/v1/proveedores/productos/all" && request.method === "GET") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresGetProductosAll(
                request,
                env,
                dbCentral,
            );
        }

        if (url.pathname === "/v1/proveedores/save" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresSave(request, env, dbCentral);
        }

        if (url.pathname === "/v1/proveedores/delete" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresDelete(request, env, dbCentral);
        }

        if (url.pathname === "/v1/proveedores/set-vinculos" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresSetVinculos(request, env, dbCentral);
        }

        if (url.pathname === "/v1/proveedores/producto/create" && request.method === "POST") {
            const dbCentral = getCentralDb(env);
            return await handleProveedoresCreateProducto(request, env, dbCentral);
        }

        // =========================================================
        // Tareas
        // =========================================================
        if (url.pathname === "/v1/tareas/trabajadores" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasGetTrabajadores(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/admin/list" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasGetTareasAdmin(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/get" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasGetTareaById(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/asignados" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasGetTareaAsignados(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/mis" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasGetMisTareas(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/create" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasCreateTarea(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/update" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasUpdateTarea(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/set-asignaciones" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasSetAsignacionesTarea(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/delete" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasDeleteTarea(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/tareas/finalizar" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleTareasMarcarTareaFinalizada(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Configuración
        // =========================================================
        if (url.pathname === "/v1/config/business" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleConfigGetBusinessSettings(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/config/business/patch" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleConfigPatchBusinessSettings(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/config/ticket" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleConfigGetTicketSettings(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/config/ticket/patch" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleConfigPatchTicketSettings(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Stats
        // =========================================================
        if (url.pathname === "/v1/stats/mesas/get" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsMesasGet(request, env, dbCentral);
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/stats/productos/categorias" && request.method === "GET") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsProductosListCategorias(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/stats/productos/resumen" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsProductosResumen(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/stats/reservas/resumen" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsReservasResumen(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/stats/trabajadores/resumen" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsTrabajadoresResumen(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/stats/clientes/resumen" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsClientesResumen(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        if (url.pathname === "/v1/stats/proveedores/resumen" && request.method === "POST") {
            try {
                const dbCentral = getCentralDb(env);
                return await handleStatsProveedoresResumen(
                    request,
                    env,
                    dbCentral,
                );
            } catch (e: any) {
                return serverError(request, "internal_error", {
                    message: String(e?.message || e),
                    name: e?.name,
                    stack: e?.stack,
                });
            }
        }

        // =========================================================
        // Assets / fallback
        // =========================================================
        if (env?.ASSETS?.fetch) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not found", { status: 404 });
    },
};
