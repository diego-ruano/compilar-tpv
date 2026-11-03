import { commands } from "@tpv/client";
import "../Global.css";
import Layout from "./layouts/layout";
import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigation } from "react-router-dom";
import { useAuth } from "../shared/stores/useAuth";
import { useEstadoSync } from "../shared/stores/useEstadoSync";
import { useInactivityLogout } from "../shared/lib/useInactivityLogout";
import { esAdmin } from "../shared/lib/permisos";
import { useNotificacionesToast } from "../features/notificaciones/useNotificacionesToast";

import Login from "./pages/Login";
const SetupInicial = lazy(() => import("./pages/SetUpInicial"));
const RecuperarDatos = lazy(() => import("./pages/RecuperarDatos"));

// ✅ importa tu provider
import { ToastProvider } from "../shared/toast";

import { usePermisos } from "../shared/lib/usePermisos";
import { toAppError } from "@tpv/client";
import { captureException } from "../shared/observability/sentry";

function AppInner() {
    const role = useAuth((s) => s.role);
    const permisos = usePermisos();
    const requiresSetup = useAuth((s) => s.requiresSetup);
    const location = useLocation();
    const navegacion = useNavigation();
    const marcarDatosPerdidos = useEstadoSync((s) => s.marcarDatosPerdidos);
    const configurarRecuperacion = useEstadoSync((s) => s.configurarRecuperacion);

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
    }, [role, configurarRecuperacion, marcarDatosPerdidos]);

    if (!role) {
        if (primeraPantalla === null) return null;
        if (primeraPantalla === "recuperar") {
            return (
                <RecuperarDatos
                    onRecuperado={() => {
                        marcarDatosPerdidos(false);
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
    if (permisos.isPending) return null;
    if (permisos.isError) return <div className="p-4"><p>{toAppError(permisos.error).message}</p><button onClick={() => void permisos.refetch()}>Reintentar</button><button onClick={() => useAuth.getState().logout()}>Cerrar sesión</button></div>;
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
