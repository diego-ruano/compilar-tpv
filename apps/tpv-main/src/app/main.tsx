import React, { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import AppErrorBoundary from "./pages/errorPages/AppErrorBoundary";

import AppBoot from "./AppBoot";
import { appRouter } from "./Router";
import { queryClient } from "../shared/lib/queryClient";

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