import { commands } from "@tpv/client";
import "../Global.css";
import Layout from "./layouts/layout";
import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigation } from "react-router-dom";
import { useAuth } from "../shared/stores/useAuth";
import { useBusinessSettings } from "../shared/stores/useBusinessSettings";
import { useContactSettings } from "../shared/stores/useContactSettings";
import { useEstadoSync } from "../shared/stores/useEstadoSync";
import { useTicketSettings } from "../shared/stores/useTicketSettings";
import { useInactivityLogout } from "../shared/lib/useInactivityLogout";
import { esAdmin, estadoPermisos, motivoDeCierre } from "../shared/lib/permisos";
import { useNotificacionesToast } from "../features/notificaciones/useNotificacionesToast";

import Login from "./pages/Login";
const SetupInicial = lazy(() => import("./pages/SetUpInicial"));
const RecuperarDatos = lazy(() => import("./pages/RecuperarDatos"));

// ✅ importa tu provider
import { ToastProvider, useToast } from "../shared/toast";

import { usePermisos } from "../shared/lib/usePermisos";
import { toAppError } from "@tpv/client";
import { captureException } from "../shared/observability/sentry";

/**
 * No se han podido leer nunca los permisos de la sesión: sin ellos no se sabe qué enseñar. Se
 * reintenta solo (`usePermisos`); aquí, el motivo y las dos salidas.
 */
function PermisosNoLeidos({ motivo, onReintentar }: { motivo: string; onReintentar: () => void }) {
    return (
        <div className="flex min-h-full w-full items-center justify-center bg-bg p-6 text-fg">
            <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-sm">
                <h1 className="text-xl font-bold">No se han podido leer tus permisos</h1>
                <p className="mt-2 text-sm text-fg-muted">{motivo}</p>
                <p className="mt-1 text-sm text-fg-muted">Se vuelve a intentar solo en unos segundos.</p>
                <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                    <button
                        type="button"
                        onClick={onReintentar}
                        className="flex-1 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-hover"
                    >
                        Reintentar
                    </button>
                    <button
                        type="button"
                        onClick={() => useAuth.getState().logout()}
                        className="flex-1 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-semibold text-fg hover:bg-surface-2"
                    >
                        Cerrar sesión
                    </button>
                </div>
            </div>
        </div>
    );
}

function AppInner() {
    const role = useAuth((s) => s.role);
    const permisos = usePermisos();
    const toast = useToast();
    const decision = estadoPermisos({ isError: permisos.isError, error: permisos.error, hayDatos: permisos.data !== undefined });
    // El usuario ya no está activo (lo desactivaron con la sesión abierta) o el backend ya no reconoce
    // la sesión: fuera, y el login dice por qué.
    useEffect(() => {
        if (decision === "cerrar_sesion" && role) {
            useAuth.getState().logout(motivoDeCierre(permisos.error, toAppError(permisos.error).message));
        }
    }, [decision, role, permisos.error]);
    // Una relectura que falla con permisos ya leídos no desmonta nada: se avisa una vez por racha, y
    // `usePermisos` la reintenta sola.
    const relecturaFallida = decision === "trabajar" && permisos.isError;
    useEffect(() => {
        if (relecturaFallida) toast.warning("No se han podido actualizar tus permisos", toAppError(permisos.error).message);
        // Sólo al empezar la racha: el aviso no se repite en cada reintento.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [relecturaFallida]);
    const requiresSetup = useAuth((s) => s.requiresSetup);
    const location = useLocation();
    const navegacion = useNavigation();
    const marcarDatosPerdidos = useEstadoSync((s) => s.marcarDatosPerdidos);
    const configurarRecuperacion = useEstadoSync((s) => s.configurarRecuperacion);
    // SYNC-32: la réplica ha visto que esta base es anterior a lo que guarda la nube y la ha pasado
    // a recuperarse de ella; ya no admite escrituras. Se cierra la sesión y se va a la pantalla de
    // recuperación, que lo explica (el efecto de abajo la elige al quedar sin sesión, o al cambiar).
    const anteriorALaNube = useEstadoSync((s) => s.anteriorALaNube);
    useEffect(() => {
        if (anteriorALaNube && role) useAuth.getState().logout();
    }, [anteriorALaNube, role]);

    // Auto-logout por inactividad (solo actúa con sesión iniciada).
    useInactivityLogout();

    // Toast al llegar una notificación nueva (no-op sin sesión).
    useNotificacionesToast();

    // Primer arranque: elegir el PIN va ANTES del login. Antes se entraba con el PIN del seed y
    // se cambiaba después, o sea que había que teclear un PIN que no era de nadie. Es una lectura
    // de la BD local (en un Handy responde que no sin salir a la red). Si la comprobación falla,
    // se mantiene el acceso cerrado: mostrar el login sin conocer el estado de la BD sería inseguro.
    const [primeraPantalla, setPrimeraPantalla] = useState<
        "setup" | "recuperar" | "login" | null
    >(null);
    useEffect(() => {
        if (role) return;

        let vivo = true;
        Promise.all([commands.setupPendiente(), commands.recoveryStatus()])
            .then(([r, recovery]) => {
                if (!vivo) return;
                // El orden importa: la recuperación gana. Las dos son "no se puede entrar todavía",
                // pero pedir un PIN nuevo sobre una BD perdida fabrica una credencial falsa y la
                // replica a la nube (ver RecuperarDatos).
                setPrimeraPantalla(
                    r.requiere_recuperacion || recovery.state !== "ready"
                        ? "recuperar"
                        : r.pendiente
                          ? "setup"
                          : "login",
                );
                configurarRecuperacion(recovery.state);
            })
            .catch((e: unknown) => {
                captureException(e, { fase: "comprobar_setup_inicial" });
                if (vivo) {
                    marcarDatosPerdidos(true);
                    setPrimeraPantalla("recuperar");
                }
            });
        return () => {
            vivo = false;
        };
    }, [role, anteriorALaNube, configurarRecuperacion, marcarDatosPerdidos]);

    if (!role) {
        if (primeraPantalla === null) return null;
        if (primeraPantalla === "recuperar") {
            return (
                <RecuperarDatos
                    onRecuperado={() => {
                        marcarDatosPerdidos(false);
                        // AUD-06: la base ya no es la que se leyó al arrancar (una copia, o la de la
                        // nube tras un traslado). El nombre, el logo y los datos del ticket se vuelven
                        // a leer de la que hay ahora (los `init` no fallan: el error lo cuenta cada store).
                        void useBusinessSettings.getState().init();
                        void useTicketSettings.getState().init();
                        void useContactSettings.getState().init();
                        // Una base creada de cero trae el admin inicial con `Requiere_Setup=1`.
                        // Se vuelve a preguntar en vez de obligar a entrar con el PIN público.
                        void commands.setupPendiente()
                            .then((r) => setPrimeraPantalla(r.pendiente ? "setup" : "login"))
                            .catch(() => setPrimeraPantalla("login"));
                    }}
                />
            );
        }
        if (primeraPantalla === "setup") {
            // Al terminar se cae al login, que es donde se estrena el PIN recién elegido.
            return <SetupInicial onCompletado={() => setPrimeraPantalla("login")} />;
        }
        return <Login />;
    }

    if (requiresSetup) {
        if (location.pathname !== "/setup") {
            return <Navigate to="/setup" replace />;
        }
        return <Outlet />;
    }

    const path = location.pathname.toLowerCase();
    // Leer los permisos de la sesión es casi instantáneo: un «Cargando permisos…» ahí sólo parpadea
    // entre el login y la aplicación. Mientras tanto no se pinta nada, como al arrancar.
    if (decision === "esperar" || decision === "cerrar_sesion") return null;
    if (decision === "sin_permisos") return <PermisosNoLeidos motivo={toAppError(permisos.error).message} onReintentar={() => void permisos.refetch()} />;
    const destino = permisos.puede("servicio.vender") ? "/VentaRapida" : permisos.puede("servicio.cocina") ? "/Comandas" : permisos.puede("tareas.propias") ? "/Tareas" : "/Inventario";
    if ((path === "/" || path === "/ventarapida") && !permisos.puede("servicio.vender")) return <Navigate to={destino} replace />;
    const reglas: [string, boolean][] = [
        ["/configuracion", esAdmin(permisos.rol)],
        ["/trabajadores/nuevo-trabajador", esAdmin(permisos.rol)],
        ["/trabajadores/editar", esAdmin(permisos.rol)],
        ["/mesas/editar", permisos.puede("plano.gestionar")],
        ["/mesas", permisos.puede("servicio.vender")],
        ["/comandas", permisos.puede("servicio.cocina") || permisos.puede("servicio.vender")],
        ["/reservas", permisos.puede("reservas.gestionar")],
        ["/clientes", permisos.puede("clientes.gestionar")],
        ["/proveedores", permisos.puede("proveedores.gestionar") || permisos.puede("pedidos.gestionar")],
        ["/estadisticas", permisos.puede("estadisticas.ver")],
        ["/cuentas", permisos.puede("cuentas.cobros") || permisos.puede("cuentas.gastos") || permisos.puede("caja.cerrar")],
        ["/tareas", permisos.puede("tareas.propias") || permisos.puede("tareas.gestionar")],
    ];
    const regla = reglas.find(([ruta]) => path.startsWith(ruta));
    if (regla && !regla[1]) return <Navigate to={destino} replace />;

    return (
        <Layout>
            {navegacion.state !== "idle" && <p role="status" className="px-4 py-1">Cargando pantalla…</p>}
            <Outlet />
        </Layout>
    );
}

export default function App() {
    return (
        <ToastProvider>
            <Suspense fallback={<p role="status" className="p-4">Cargando pantalla…</p>}>
                <AppInner />
            </Suspense>
        </ToastProvider>
    );
}
