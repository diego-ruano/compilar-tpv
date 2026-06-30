import { useEffect, useState } from "react";
import ErrorFallback from "./ErrorFallback";
import { captureException } from "../../../shared/observability/sentry";

export default function GlobalErrorListener({
    children,
}: {
    children: React.ReactNode;
}) {
    const [fatal, setFatal] = useState<unknown>(null);

    useEffect(() => {
        const onError = (event: ErrorEvent) => {
            // Reporta a Sentry ANTES del preventDefault: si no, este handler "consume" el error y
            // el manejador global de Sentry no llegaría a verlo.
            captureException(event.error ?? event.message);
            // evita que te salga el overlay default en algunos casos
            event.preventDefault?.();
            setFatal(event.error ?? event.message);
        };

        const onUnhandledRejection = (event: PromiseRejectionEvent) => {
            // Igual que arriba: las promesas rechazadas no controladas también se reportan aquí.
            captureException(event.reason);
            event.preventDefault?.();
            setFatal(event.reason);
        };

        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onUnhandledRejection);

        return () => {
            window.removeEventListener("error", onError);
            window.removeEventListener(
                "unhandledrejection",
                onUnhandledRejection,
            );
        };
    }, []);

    if (fatal) {
        return (
            <ErrorFallback error={fatal} resetError={() => setFatal(null)} />
        );
    }

    return <>{children}</>;
}
