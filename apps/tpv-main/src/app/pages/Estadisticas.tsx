// src/app/pages/Estadisticas.tsx
import { useMemo, useState } from "react";
import { BarChart3, CloudDownload } from "lucide-react";
import type { StatsRange } from "@tpv/contracts";

import { useBackfillHistorico } from "../../shared/lib/backfillQueries";

// ✅ Ajusta estas rutas a tu estructura real
import MesasStats from "../../features/estadisticas/MesasStats";
import ProductosStats from "../../features/estadisticas/ProductosStats";
import ReservasStats from "../../features/estadisticas/ReservasStats";
import ProveedoresStats from "../../features/estadisticas/ProveedoresStats";
import TrabajadoresStats from "../../features/estadisticas/TrabajadoresStats";
import ClientesStats from "../../features/estadisticas/ClientesStats";

type StatsKey =
    | "mesas"
    | "productos"
    | "reservas"
    | "proveedores"
    | "trabajadores"
    | "clientes";

const STATS_OPTIONS: Array<{ key: StatsKey; label: string }> = [
    { key: "mesas", label: "Mesas" },
    { key: "productos", label: "Productos" },
    { key: "reservas", label: "Reservas" },
    { key: "proveedores", label: "Proveedores" },
    { key: "trabajadores", label: "Trabajadores" },
    { key: "clientes", label: "Clientes" },
];

const RANGE_OPTIONS: Array<{ key: StatsRange; label: string }> = [
    { key: "hoy", label: "Hoy" },
    { key: "semana", label: "Semana" },
    { key: "mes", label: "Mes" },
    { key: "anio", label: "Año" },
];

// mini cn para no depender de otros módulos
function cn(...classes: Array<string | false | null | undefined>) {
    return classes.filter(Boolean).join(" ");
}

/**
 * SYNC-19 · Estas cifras pueden estar incompletas, y hay que decirlo.
 *
 * Tras recuperar el equipo, el histórico anterior a la ventana llega en segundo plano. Mientras
 * eso pasa, un total de "Año" —o de "Mes", si la recuperación fue hace poco— va a crecer solo cada
 * pocos minutos. Sin este aviso, lo que ve el dueño es un número que cambia sin motivo, y eso no se
 * lee como "todavía está descargando": se lee como que el programa suma mal.
 *
 * No bloquea nada. La alternativa —deshabilitar los rangos largos— deja media pantalla inútil justo
 * después de una avería, que es cuando más falta hace mirar cómo va el negocio.
 */
function AvisoHistoricoIncompleto() {
    const { data } = useBackfillHistorico();
    if (!data || data.tablas_pendientes === 0) return null;

    const total = data.tablas_pendientes + data.tablas_completadas;
    const pct = total > 0 ? Math.round((data.tablas_completadas / total) * 100) : 0;

    return (
        <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
            <CloudDownload className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
            <p className="text-fg">
                <span className="font-semibold">Todavía se está descargando el histórico ({pct} %).</span>{" "}
                Los totales de periodos largos pueden seguir subiendo hasta que termine. Lo reciente
                ya está completo.
            </p>
        </div>
    );
}

export default function Estadisticas() {
    const [categoria, setCategoria] = useState<StatsKey>("mesas");
    const [range, setRange] = useState<StatsRange>("hoy");

    const categoriaLabel = useMemo(
        () => STATS_OPTIONS.find((o) => o.key === categoria)?.label ?? "—",
        [categoria],
    );

    const renderContenido = () => {
        switch (categoria) {
            case "mesas":
                return <MesasStats range={range as any} />;
            case "productos":
                return <ProductosStats range={range as any} />;
            case "reservas":
                return <ReservasStats range={range as any} />;
            case "proveedores":
                return <ProveedoresStats range={range as any} />;
            case "trabajadores":
                return <TrabajadoresStats range={range as any} />;
            case "clientes":
                return <ClientesStats range={range as any} />;
            default:
                return null;
        }
    };

    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-hidden bg-bg p-3 sm:p-4 lg:px-10 lg:py-5">
            {/* HEADER */}
            <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                        <BarChart3 className="size-6" aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-xl font-bold text-fg sm:text-2xl">Estadísticas</h2>
                        <p className="text-sm text-fg-muted">
                            Viendo: <span className="font-semibold text-fg">{categoriaLabel}</span>
                        </p>
                    </div>
                </div>

                {/* Controles */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                    <select
                        value={categoria}
                        onChange={(e) => setCategoria(e.target.value as StatsKey)}
                        className="h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring sm:w-52"
                    >
                        {STATS_OPTIONS.map((o) => (
                            <option key={o.key} value={o.key}>
                                {o.label}
                            </option>
                        ))}
                    </select>

                    <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-2 p-1">
                        {RANGE_OPTIONS.map((r) => {
                            const active = r.key === range;
                            return (
                                <button
                                    key={r.key}
                                    type="button"
                                    onClick={() => setRange(r.key)}
                                    className={cn(
                                        "flex-1 cursor-pointer rounded-lg px-3 py-1.5 text-sm font-semibold transition sm:flex-none",
                                        active
                                            ? "bg-accent text-white shadow-sm"
                                            : "text-fg-muted hover:bg-surface hover:text-fg",
                                    )}
                                    title={`Ver ${r.label.toLowerCase()}`}
                                >
                                    {r.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <AvisoHistoricoIncompleto />

            {/* Contenido */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {renderContenido()}
            </div>
        </div>
    );
}
