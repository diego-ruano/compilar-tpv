// components/mesasComponents/Legend.tsx
export default function Legend() {
    return (
        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-4 text-sm text-negro/80">

            {/* Mesa libre */}
            <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded bg-slate-900" />
                <span>Mesa libre</span>
            </div>

            {/* Pendiente de cobro */}
            <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded bg-amber-500" />
                <span>Pendiente de cobro</span>
            </div>

            {/* Reserva activa */}
            <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded bg-blue-600" />
                <span>Reserva en curso</span>
            </div>

            {/* Reserva próxima */}
            <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded bg-slate-900 border-4 border-blue-600" />
                <span>Reserva próxima</span>
            </div>

        </div>
    );
}
