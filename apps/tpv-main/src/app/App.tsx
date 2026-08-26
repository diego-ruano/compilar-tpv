import "../Global.css";
import Layout from "./layouts/layout";
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../shared/stores/useAuth";
import { useInactivityLogout } from "../shared/lib/useInactivityLogout";
import { useNotificacionesToast } from "../features/notificaciones/useNotificacionesToast";
import { fetchSetupPendiente } from "../features/login/loginApi";
import Login from "./pages/Login";
import SetupInicial from "./pages/SetUpInicial";

// ✅ importa tu provider
import { ToastProvider } from "../shared/toast";

function AppInner() {
    const role = useAuth((s) => s.role);
    const requiresSetup = useAuth((s) => s.requiresSetup);
    const location = useLocation();

    // Auto-logout por inactividad (solo actúa con sesión iniciada).
    useInactivityLogout();

    // Toast al llegar una notificación nueva (no-op sin sesión).
    useNotificacionesToast();

    // Primer arranque: elegir el PIN va ANTES del login. Antes se entraba con el PIN del seed y
    // se cambiaba después, o sea que había que teclear un PIN que no era de nadie. Es una lectura
    // de la BD local (en un Handy responde que no sin salir a la red); si falla, login y ya.
    const [setupPendiente, setSetupPendiente] = useState<boolean | null>(null);
    useEffect(() => {
        if (role) return;

        let vivo = true;
        fetchSetupPendiente()
            .then((r) => {
                if (vivo) setSetupPendiente(r.pendiente);
            })
            .catch((e) => {
                console.error("No se pudo comprobar el setup inicial:", e);
                if (vivo) setSetupPendiente(false);
            });
        return () => {
            vivo = false;
        };
    }, [role]);

    if (!role) {
        if (setupPendiente === null) return null;
        if (setupPendiente) {
            // Al terminar se cae al login, que es donde se estrena el PIN recién elegido.
            return <SetupInicial onCompletado={() => setSetupPendiente(false)} />;
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

    // Cuentas es solo del administrador (CUENTA-06). El menu ya no la enseña a los demas, pero un
    // menu no es un permiso: sin esto bastaria con escribir la URL. El candado de verdad para lo que
    // se ESCRIBE vive mas abajo -en los comandos y, para la Handy, en el worker-; esto solo evita
    // que la pantalla se abra.
    if (role && role !== "Administrador" && path === "/cuentas") {
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
