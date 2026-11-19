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
    // En el teléfono, más estrecha: deja la altura al mapa.
    return (
        <div className="flex w-full shrink-0 flex-col items-stretch gap-2 rounded-2xl border border-border bg-surface p-2 shadow-sm xs:flex-row xs:items-center xs:justify-between sm:gap-3 sm:p-4">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent sm:size-11 sm:rounded-2xl">
                    {isCocinero ? <ChefHat className="size-5 sm:size-6" aria-hidden /> : <LayoutGrid className="size-5 sm:size-6" aria-hidden />}
                </div>
                <div className="min-w-0">
                    <h2 className="text-lg font-bold text-fg max-sm:leading-tight sm:text-2xl">
                        {isCocinero ? "Comandas" : "Mesas"}
                    </h2>
                    <p className="hidden text-sm text-fg-muted sm:block">
                        {isCocinero ? "Comandas pendientes de cocina." : "Selecciona una mesa para gestionar su comanda."}
                    </p>
                </div>
            </div>

            {canEditMesas ? (
                <Link
                    to="/Mesas/editar"
                    className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm font-semibold sm:py-2 text-fg transition hover:bg-surface-2 xs:w-auto"
                >
                    <Pencil className="size-4" aria-hidden />
                    <span className="hidden sm:inline">Editar/Crear mapa de salones</span>
                    <span className="sm:hidden">Editar mapa</span>
                </Link>
            ) : null}
        </div>
    );
}
