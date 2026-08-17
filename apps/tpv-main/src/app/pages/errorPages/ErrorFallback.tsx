import { useNavigate } from "react-router-dom";
import { isAppError } from "@tpv/client";

type Props = {
    error?: unknown;
    resetError?: () => void;
};

function formatError(err: unknown): string {
    // ARCH-05: un error de un comando llega como `{ code, message }`. Sin este caso
    // caería en el JSON.stringify de abajo y la pantalla de crash enseñaría el objeto
    // crudo en vez del motivo.
    if (isAppError(err)) return `${err.code}: ${err.message}`;
    if (err instanceof Error) {
        return `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
    }
    if (typeof err === "string") return err;

    try {
        return JSON.stringify(err, null, 2);
    } catch {
        return "Error desconocido";
    }
}

export default function ErrorFallback({ error, resetError }: Props) {
    const navigate = useNavigate();

    const goHome = () => {
        resetError?.();
        navigate("/", { replace: true }); // tu menú principal es "/"
    };

    const reload = () => {
        window.location.reload();
    };

    return (
        <div className="min-h-screen w-full bg-gris flex items-center justify-center p-6">
            <div className="max-w-xl w-full bg-blanco rounded-2xl shadow-md p-6 flex flex-col gap-4">
                <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-xl bg-red-100 flex items-center justify-center">
                        <span className="text-red-600 text-xl">!</span>
                    </div>

                    <div className="flex-1">
                        <h1 className="text-2xl font-bold">
                            Ups… ha ocurrido un error
                        </h1>
                        <p className="text-gray-600 mt-1">
                            Se ha producido un fallo inesperado. Puedes volver
                            al menú principal o reiniciar la aplicación.
                        </p>
                    </div>
                </div>

                <div className="flex gap-3 flex-wrap">
                    <button
                        onClick={goHome}
                        className="px-4 py-2 rounded-xl bg-verde text-white font-semibold hover:opacity-90"
                    >
                        Volver al menú principal
                    </button>

                    <button
                        onClick={reload}
                        className="px-4 py-2 rounded-xl border border-gray-300 hover:bg-gray-50"
                    >
                        Reiniciar app
                    </button>
                </div>

                {typeof error !== "undefined" && (
                    <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-gray-600">
                            Detalles técnicos
                        </summary>

                        <pre className="mt-2 p-3 bg-gray-100 rounded-xl text-xs overflow-auto max-h-64 whitespace-pre-wrap">
                            {formatError(error)}
                        </pre>
                    </details>
                )}
            </div>
        </div>
    );
}
