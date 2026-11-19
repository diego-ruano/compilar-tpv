// components/mesasComponents/Legend.tsx
import { useTheme } from "../../shared/stores/useTheme";

export default function Legend() {
    const dark = useTheme((s) => s.theme === "dark");

    // Mismos valores que TableNode para que los swatches coincidan con el canvas.
    const libreFill = dark ? "rgba(71,85,105,0.95)" : "rgba(15,23,42,0.92)";

    return (
        // En el teléfono, una caja de dos por dos con las muestras alineadas.
        <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-border bg-surface-2 px-3 py-2 text-[11px] text-fg-muted sm:flex sm:flex-wrap sm:gap-x-6 sm:gap-y-2 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:text-sm">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <div className="size-3.5 shrink-0 rounded border border-border sm:size-4" style={{ background: libreFill }} />
                <span className="max-sm:truncate">Mesa libre</span>
            </div>

            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <div className="size-3.5 shrink-0 rounded border border-border bg-amber-500 sm:size-4" />
                <span className="max-sm:truncate">Pendiente de cobro</span>
            </div>

            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <div className="size-3.5 shrink-0 rounded border border-border bg-blue-600 sm:size-4" />
                <span className="max-sm:truncate">Reserva en curso</span>
            </div>

            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <div className="size-3.5 shrink-0 rounded border-[3px] border-blue-600 sm:size-4 sm:border-4" style={{ background: libreFill }} />
                <span className="max-sm:truncate">Reserva próxima</span>
            </div>
        </div>
    );
}
