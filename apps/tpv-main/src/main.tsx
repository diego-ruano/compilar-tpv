import React, { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import AppErrorBoundary from "./pages/errorPages/AppErrorBoundary";

import AppBoot from "./AppBoot";
import { appRouter } from "./Router";

const container = document.getElementById("root");

if (!container) {
    throw new Error("El elemento con ID 'root' no se encontró en el DOM.");
}

const root = ReactDOM.createRoot(container);

root.render(
    <AppErrorBoundary>
        <AppBoot router={appRouter} />
    </AppErrorBoundary>
);