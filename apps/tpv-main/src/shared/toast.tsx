import React, {
    createContext,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

export type ToastVariant = "info" | "warning" | "success" | "error";

export type ToastItem = {
    id: number;
    title: string;
    message?: string;
    variant: ToastVariant;
};

type ToastContextValue = {
    push: (t: Omit<ToastItem, "id">) => void;
    info: (title: string, message?: string) => void;
    success: (title: string, message?: string) => void;
    warning: (title: string, message?: string) => void;
    error: (title: string, message?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

// Los avisos del `ToastProvider` montado, para quien avisa desde fuera de un componente y no puede
// llamar a un hook (`shared/lib/conAviso.ts`). `null` mientras no haya ninguno montado.
let avisosMontados: ToastContextValue | null = null;

export function avisosFueraDeReact(): ToastContextValue | null {
    return avisosMontados;
}

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

function ToastCard({
    toast,
    onClose,
}: {
    toast: ToastItem;
    onClose: (id: number) => void;
}) {
    const variantClasses = useMemo(() => {
        switch (toast.variant) {
            case "success":
                return "border-emerald-200 bg-emerald-50 text-emerald-900";
            case "error":
                return "border-rose-200 bg-rose-50 text-rose-900";
            case "warning":
                return "border-amber-200 bg-amber-50 text-amber-900";
            case "info":
            default:
                return "border-sky-200 bg-sky-50 text-sky-900";
        }
    }, [toast.variant]);

    return (
        <div
            className={cn(
                "pointer-events-auto w-[360px] max-w-[92vw] overflow-hidden rounded-2xl border shadow-lg",
                "backdrop-blur supports-[backdrop-filter]:bg-white/70",
                variantClasses,
            )}
            role="status"
            aria-live="polite"
        >
            <div className="flex items-start gap-3 p-4">
                <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-current opacity-70" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                        {toast.title}
                    </p>
                    {toast.message ? (
                        <p className="mt-1 text-sm/5 opacity-90">
                            {toast.message}
                        </p>
                    ) : null}
                </div>
                <button
                    onClick={() => onClose(toast.id)}
                    className="rounded-xl px-2 py-1 text-sm font-medium opacity-80 hover:opacity-100 hover:bg-black/5 active:scale-[0.98]"
                    aria-label="Cerrar notificación"
                    type="button"
                >
                    ✕
                </button>
            </div>
        </div>
    );
}

export function ToastProvider({
    children,
    maxToasts = 3,
    durationMs = 2600,
}: {
    children: React.ReactNode;
    maxToasts?: number;
    durationMs?: number;
}) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const timers = useRef<Record<number, number>>({});

    const remove = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        const tm = timers.current[id];
        if (tm) window.clearTimeout(tm);
        delete timers.current[id];
    }, []);

    const push = useCallback(
        (t: Omit<ToastItem, "id">) => {
            const id = Date.now() + Math.floor(Math.random() * 1000);
            const toast: ToastItem = { id, ...t };

            setToasts((prev) => [toast, ...prev].slice(0, maxToasts));

            timers.current[id] = window.setTimeout(() => {
                remove(id);
            }, durationMs);
        },
        [durationMs, maxToasts, remove],
    );

    const api = useMemo<ToastContextValue>(
        () => ({
            push,
            info: (title, message) => push({ title, message, variant: "info" }),
            success: (title, message) =>
                push({ title, message, variant: "success" }),
            warning: (title, message) =>
                push({ title, message, variant: "warning" }),
            error: (title, message) =>
                push({ title, message, variant: "error" }),
        }),
        [push],
    );

    useEffect(() => {
        avisosMontados = api;
        return () => {
            if (avisosMontados === api) avisosMontados = null;
        };
    }, [api]);

    return (
        <ToastContext.Provider value={api}>
            {children}

            {/* Contenedor global (siempre arriba a la derecha, como en Login) */}
            <div className="pointer-events-none fixed right-4 top-4 z-[9999] flex flex-col gap-3">
                {toasts.map((t) => (
                    <ToastCard key={t.id} toast={t} onClose={remove} />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = React.useContext(ToastContext);
    if (!ctx) {
        throw new Error(
            "useToast() se está usando sin <ToastProvider> por encima. " +
                "Envuelve tu App (o main.tsx) con <ToastProvider>.",
        );
    }
    return ctx;
}
