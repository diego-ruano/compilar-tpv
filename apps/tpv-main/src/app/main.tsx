import React, { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import AppErrorBoundary from "./pages/errorPages/AppErrorBoundary";

import AppBoot from "./AppBoot";
import { appRouter } from "./Router";
import { queryClient } from "../shared/lib/queryClient";
import { initTheme } from "../shared/stores/useTheme";
import { initSentry } from "../shared/observability/sentry";

// Observabilidad lo primero: así se capturan también los errores del arranque.
initSentry();

// Aplica el tema (claro/oscuro) al <html> antes del primer render para
// evitar el parpadeo de tema incorrecto.
initTheme();

const container = document.getElementById("root");

if (!container) {
    throw new Error("El elemento con ID 'root' no se encontró en el DOM.");
}

const root = ReactDOM.createRoot(container);

root.render(
    <AppErrorBoundary>
        <QueryClientProvider client={queryClient}>
            <AppBoot router={appRouter} />
        </QueryClientProvider>
    </AppErrorBoundary>
);