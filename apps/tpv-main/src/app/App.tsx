import "../Global.css";
import Layout from "./layouts/layout";
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../shared/stores/useAuth";
import { useEstadoSync } from "../shared/stores/useEstadoSync";
import { useInactivityLogout } from "../shared/lib/useInactivityLogout";
import { entraEnCuentas, esAdmin } from "../shared/lib/permisos";
import { useNotificacionesToast } from "../features/notificaciones/useNotificacionesToast";
import { fetchRecoveryStatus, fetchSetupPendiente } from "../features/login/loginApi";
import Login from "./pages/Login";
import SetupInicial from "./pages/SetUpInicial";
import RecuperarDatos from "./pages/RecuperarDatos";

// ✅ importa tu provider
import { ToastProvider } from "../shared/toast";

function AppInner() {
    const role = useAuth((s) => s.role);
    const requiresSetup = useAuth((s) => s.requiresSetup);
    const location = useLocation();
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
        Promise.all([fetchSetupPendiente(), fetchRecoveryStatus()])
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
            .catch((e) => {
                console.error("No se pudo comprobar el setup inicial:", e);
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
                        void fetchSetupPendiente()
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
    if (role === "Cocinero" && (path === "/" || path === "/ventarapida")) {
        return <Navigate to="/Comandas" replace />;
    }

    // Rutas de administrador. El menu ya no las enseña a los demas, pero un menu no es un
    // permiso: sin esto bastaria con escribir la URL. El candado de verdad vive en los comandos
    // Tauri (SEC-01) y, para la Handy, en el worker; esto solo evita que la pantalla se abra —y
    // que quien llegue a ella la vea entera rota a base de "permiso denegado".
    //
    // Configuracion y las fichas de trabajador se añaden con SEC-01: sus comandos pasaron a exigir
    // rol, asi que dejarlas abiertas era ofrecer una pantalla que no funciona. La ficha ademas es la
    // unica que devuelve la PII del personal.
    //
    // Cuentas tiene su propio candado: entra tambien el camarero, que ve los cobros y sus bajas.
    if (role && !entraEnCuentas(role) && path.startsWith("/cuentas")) {
        return <Navigate to="/" replace />;
    }
    const RUTAS_DE_ADMIN = [
        "/configuracion",
        "/trabajadores/nuevo-trabajador",
        "/trabajadores/editar",
    ];
    if (role && !esAdmin(role) && RUTAS_DE_ADMIN.some((r) => path.startsWith(r))) {
        return <Navigate to="/" replace />;
    }

    return (
        <Layout>
            <Outlet />
        </Layout>
    );
}

export default function App() {
    return (
        <ToastProvider>
            <AppInner />
        </ToastProvider>
    );
}
