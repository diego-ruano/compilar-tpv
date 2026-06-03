import "./Global.css";
import Layout from "./layouts/layout";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./shared/stores/useAuth";
import Login from "./pages/Login";

// ✅ importa tu provider
import { ToastProvider } from "./components/toast";

function AppInner() {
    const role = useAuth((s) => s.role);
    const requiresSetup = useAuth((s) => s.requiresSetup);
    const location = useLocation();

    if (!role) return <Login />;

    if (requiresSetup) {
        if (location.pathname !== "/setup") {
            return <Navigate to="/setup" replace />;
        }
        return <Outlet />;
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
