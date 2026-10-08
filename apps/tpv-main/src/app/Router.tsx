import React from "react";
import { createBrowserRouter } from "react-router-dom";

import App from "./App";
import VentaRapida from "./pages/VentaRapida";
import Mesas from "./pages/Mesas";
import Logout from "./pages/Logout";
import NotFound from "./pages/errorPages/NotFound";

// RI-23: sólo las pantallas de servicio forman parte del arranque. Sus imports estáticos
// incluyen también los modales, el catálogo, la cocina y el plano de Mesas.
const pantalla = (cargar: () => Promise<{ default: React.ComponentType }>) =>
    async () => ({ Component: (await cargar()).default });

export const appRouter = createBrowserRouter([
    {
        path: "/",
        element: <App />,
        children: [
            { path: "setup", lazy: pantalla(() => import("./pages/SetUpInicial")) },

            { index: true, element: <VentaRapida /> },
            { path: "VentaRapida", element: <VentaRapida /> },

            { path: "Mesas", element: <Mesas /> },
            { path: "Comandas", element: <Mesas /> },
            { path: "Mesas/editar", lazy: pantalla(() => import("./pages/mesasPages/EditTables")) },

            { path: "Inventario", lazy: pantalla(() => import("./pages/Inventario")) },
            { path: "Reservas", lazy: pantalla(() => import("./pages/Reservas")) },

            { path: "Trabajadores", lazy: pantalla(() => import("./pages/Trabajadores")) },
            { path: "Trabajadores/nuevo-trabajador", lazy: pantalla(() => import("./pages/trabajadoresPages/AddTrabajador")) },
            { path: "Trabajadores/editar/:id", lazy: pantalla(() => import("./pages/trabajadoresPages/EditTrabajador")) },

            { path: "Proveedores", lazy: pantalla(() => import("./pages/Proveedores")) },
            { path: "Clientes", lazy: pantalla(() => import("./pages/Clientes")) },
            { path: "Tareas", lazy: pantalla(() => import("./pages/Tareas")) },

            { path: "Estadisticas", lazy: pantalla(() => import("./pages/Estadisticas")) },
            { path: "Cuentas", lazy: pantalla(() => import("./pages/Cuentas")) },
            { path: "Notificaciones", lazy: pantalla(() => import("./pages/Notificaciones")) },
            { path: "Configuracion", lazy: pantalla(() => import("./pages/Configuracion")) },

            { path: "Logout", element: <Logout /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
