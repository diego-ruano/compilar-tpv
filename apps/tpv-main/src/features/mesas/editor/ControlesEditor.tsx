import type React from "react";

function cn(...classes: Array<string | false | null | undefined>) {
    return classes.filter(Boolean).join(" ");
}

type BtnVariant = "primary" | "danger" | "neutral" | "accent";

export function IconButton({
    icon,
    children,
    onClick,
    disabled,
    variant = "neutral",
}: {
    icon?: React.ReactNode;
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    variant?: BtnVariant;
}) {
    const base =
        "h-10 min-w-0 justify-center px-2 sm:px-4 rounded-xl border text-xs sm:text-sm font-semibold shadow-sm transition inline-flex items-center gap-1.5 sm:gap-2 select-none";
    const variants: Record<BtnVariant, string> = {
        neutral: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-border bg-surface text-fg hover:bg-surface-2 active:scale-[0.98]",
        primary: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-accent bg-accent text-white hover:bg-accent-hover active:scale-[0.98]",
        danger: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-danger/30 bg-danger-soft text-danger hover:bg-danger-soft active:scale-[0.98]",
        accent: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-accent/30 bg-accent-soft text-accent hover:bg-accent-soft active:scale-[0.98]",
    };

    return (
        <button
            disabled={disabled}
            onClick={onClick}
            className={cn(base, variants[variant])}
        >
            {icon ? <span className="text-base leading-none">{icon}</span> : null}
            <span className="min-w-0 truncate">{children}</span>
        </button>
    );
}

export function Chip({
    active,
    children,
    onClick,
}: {
    active?: boolean;
    children: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "h-9 px-3 rounded-xl border text-sm font-semibold shadow-sm transition inline-flex items-center gap-2",
                active
                    ? "border-accent bg-accent text-white"
                    : "border-border bg-surface text-fg-muted hover:bg-surface-2",
            )}
        >
            {children}
        </button>
    );
}

export function Modal({
    open,
    title,
    children,
    onClose,
}: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
}) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-2 sm:p-4">
            <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl sm:max-h-[calc(100dvh-2rem)]">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-3 sm:p-4">
                    <div className="text-base font-bold text-fg">
                        {title}
                    </div>
                    <button
                        onClick={onClose}
                        className="h-9 w-9 rounded-xl border border-border bg-surface text-fg-muted hover:bg-surface-2"
                    >
                        ✕
                    </button>
                </div>
                {/* El cuerpo ocupa lo que deje la cabecera dentro del alto del panel: con un alto
                    calculado aparte podía pasarse y el panel cortaba lo último. */}
                <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">{children}</div>
            </div>
        </div>
    );
}
