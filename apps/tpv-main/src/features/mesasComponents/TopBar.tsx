import { Link } from "react-router-dom";
import { LayoutGrid, ChefHat, Pencil } from "lucide-react";

type TopBarProps = {
    canEditMesas?: boolean;
    isCocinero?: boolean;
};

export default function TopBar({
    canEditMesas = true,
    isCocinero = false,
}: TopBarProps) {
    return (
        <div className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="flex min-w-0 items-center gap-3">
                <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                    {isCocinero ? <ChefHat className="size-6" aria-hidden /> : <LayoutGrid className="size-6" aria-hidden />}
                </div>
                <div className="min-w-0">
                    <h2 className="text-xl font-bold text-fg sm:text-2xl">
                        {isCocinero ? "Comandas" : "Mesas"}
                    </h2>
                    <p className="text-sm text-fg-muted">
                        {isCocinero ? "Comandas pendientes de cocina." : "Selecciona una mesa para gestionar su comanda."}
                    </p>
                </div>
            </div>

            {canEditMesas ? (
                <Link
                    to="/Mesas/editar"
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2"
                >
                    <Pencil className="size-4" aria-hidden />
                    <span className="hidden sm:inline">Editar/Crear mapa de salones</span>
                    <span className="sm:hidden">Editar mapa</span>
                </Link>
            ) : null}
        </div>
    );
}
