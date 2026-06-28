import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
    'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function ModalShell({
    open,
    onClose,
    className = "fixed inset-0 z-50 flex items-center justify-center",
    children,
}: {
    open: boolean;
    onClose: () => void;
    className?: string;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const fn = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", fn);
        return () => document.removeEventListener("keydown", fn);
    }, [open, onClose]);

    useEffect(() => {
        if (!open || !ref.current) return;
        const first = ref.current.querySelector<HTMLElement>(FOCUSABLE);
        first?.focus();
    }, [open]);

    const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Tab" || !ref.current) return;
        const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (el) => el.offsetParent !== null,
        );
        if (els.length === 0) return;
        if (e.shiftKey) {
            if (document.activeElement === els[0]) {
                e.preventDefault();
                els[els.length - 1].focus();
            }
        } else if (document.activeElement === els[els.length - 1]) {
            e.preventDefault();
            els[0].focus();
        }
    };

    if (!open) return null;

    return (
        <div ref={ref} role="dialog" aria-modal="true" className={className} onKeyDown={trapTab}>
            {children}
        </div>
    );
}
