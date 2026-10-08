import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import AppErrorBoundary from "./pages/errorPages/AppErrorBoundary";
import GlobalErrorListener from "./pages/errorPages/GlobalErrorListener";

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

// `AppErrorBoundary` sólo ve lo que revienta DURANTE el render de React. Todo lo asíncrono —una
// promesa rechazada sin `catch`, un error dentro de un `setTimeout`— pasa de largo, y en esta app
// eso es casi todo (sockets, invokes, mutaciones). `GlobalErrorListener` engancha `window.onerror`
// y `unhandledrejection` y los reporta. Existía desde hace tiempo pero no lo montaba nadie: ni se
// reportaban esos errores ni aparecía la pantalla de fallo escrita para ellos.
root.render(
    <AppErrorBoundary>
        <GlobalErrorListener>
            <QueryClientProvider client={queryClient}>
                <AppBoot router={appRouter} />
            </QueryClientProvider>
        </GlobalErrorListener>
    </AppErrorBoundary>
);
