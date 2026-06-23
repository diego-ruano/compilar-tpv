// components/mesasComponents/Legend.tsx
export default function Legend() {
    return (
        <div className="mt-4 flex shrink-0 flex-wrap gap-x-8 gap-y-3 text-sm text-fg-muted">
            <div className="flex items-center gap-3">
                <div className="size-4 rounded border border-border bg-slate-700" />
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
                <div className="size-4 rounded border-4 border-blue-600 bg-slate-700" />
                <span>Reserva próxima</span>
            </div>
        </div>
    );
}
