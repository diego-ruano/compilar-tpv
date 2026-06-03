import { useEffect, useState } from "react";
import ErrorFallback from "./ErrorFallback";

export default function GlobalErrorListener({
    children,
}: {
    children: React.ReactNode;
}) {
    const [fatal, setFatal] = useState<unknown>(null);

    useEffect(() => {
        const onError = (event: ErrorEvent) => {
            // evita que te salga el overlay default en algunos casos
            event.preventDefault?.();
            setFatal(event.error ?? event.message);
        };

        const onUnhandledRejection = (event: PromiseRejectionEvent) => {
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
