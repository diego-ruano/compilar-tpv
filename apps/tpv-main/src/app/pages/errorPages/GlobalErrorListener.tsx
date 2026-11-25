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
            // Las promesas rechazadas se REPORTAN pero no tumban la pantalla. En un TPV, la
            // mayoría son un fallo de red pasajero (una subida, un refetch); cambiar la caja por
            // una pantalla de error a mitad de servicio es peor que el propio error, y el
            // camarero no puede hacer nada con ella. Un error SÍNCRONO no controlado (el `error`
            // de arriba) es otra cosa: ahí la UI ya está en un estado indefinido.
            captureException(event.reason);
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
