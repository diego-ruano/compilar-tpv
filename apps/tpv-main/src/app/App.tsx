import "../Global.css";
import Layout from "./layouts/layout";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../shared/stores/useAuth";
import { useInactivityLogout } from "../shared/lib/useInactivityLogout";
import Login from "./pages/Login";

// ✅ importa tu provider
import { ToastProvider } from "../shared/toast";

function AppInner() {
    const role = useAuth((s) => s.role);
    const requiresSetup = useAuth((s) => s.requiresSetup);
    const location = useLocation();

    // Auto-logout por inactividad (solo actúa con sesión iniciada).
    useInactivityLogout();

    if (!role) return <Login />;

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
