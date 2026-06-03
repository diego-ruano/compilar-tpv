import React from "react";
import { createBrowserRouter } from "react-router-dom";

import App from "./App";
import SetupInicial from "./pages/SetUpInicial";
import VentaRapida from "./pages/VentaRapida";
import Mesas from "./pages/Mesas";
import EditTables from "./pages/mesasPages/EditTables";
import Inventario from "./pages/Inventario";
import Reservas from "./pages/Reservas";
import Trabajadores from "./pages/Trabajadores";
import AddTrabajador from "./pages/trabajadoresPages/AddTrabajador";
import EditTrabajador from "./pages/trabajadoresPages/EditTrabajador";
import Proveedores from "./pages/Proveedores";
import Clientes from "./pages/Clientes";
import Estadisticas from "./pages/Estadisticas";
import Configuracion from "./pages/Configuracion";
import Cuentas from "./pages/Cuentas";
import Tareas from "./pages/Tareas";
import Logout from "./pages/Logout";
import NotFound from "./pages/errorPages/NotFound";

export const appRouter = createBrowserRouter([
    {
        path: "/",
        element: <App />,
        children: [
            { path: "setup", element: <SetupInicial /> },

            { index: true, element: <VentaRapida /> },
            { path: "VentaRapida", element: <VentaRapida /> },

            { path: "Mesas", element: <Mesas /> },
            { path: "Mesas/editar", element: <EditTables /> },

            { path: "Inventario", element: <Inventario /> },
            { path: "Reservas", element: <Reservas /> },

            { path: "Trabajadores", element: <Trabajadores /> },
            { path: "Trabajadores/nuevo-trabajador", element: <AddTrabajador /> },
            { path: "Trabajadores/editar/:id", element: <EditTrabajador /> },

            { path: "Proveedores", element: <Proveedores /> },
            { path: "Clientes", element: <Clientes /> },
            { path: "Tareas", element: <Tareas /> },

            { path: "Estadisticas", element: <Estadisticas /> },
            { path: "Cuentas", element: <Cuentas /> },
            { path: "Configuracion", element: <Configuracion /> },

            { path: "Logout", element: <Logout /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);