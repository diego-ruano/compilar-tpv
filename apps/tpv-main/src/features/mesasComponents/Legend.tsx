// components/mesasComponents/Legend.tsx
import { useTheme } from "../../shared/stores/useTheme";

export default function Legend() {
    const dark = useTheme((s) => s.theme === "dark");

    // Mismos valores que TableNode para que los swatches coincidan con el canvas.
    const libreFill = dark ? "rgba(71,85,105,0.95)" : "rgba(15,23,42,0.92)";

    return (
        <div className="mt-4 flex shrink-0 flex-wrap gap-x-8 gap-y-3 text-sm text-fg-muted">
            <div className="flex items-center gap-3">
                <div className="size-4 rounded border border-border" style={{ background: libreFill }} />
                <span>Mesa libre</span>
            </div>

            <div className="flex items-center gap-3">
                <div className="size-4 rounded border border-border bg-amber-500" />
                <span>Pendiente de cobro</span>
            </div>

            <div className="flex items-center gap-3">
                <div className="size-4 rounded border border-border bg-blue-600" />
                <span>Reserva en curso</span>
            </div>

            <div className="flex items-center gap-3">
                <div className="size-4 rounded border-4 border-blue-600" style={{ background: libreFill }} />
                <span>Reserva próxima</span>
            </div>
        </div>
    );
}
