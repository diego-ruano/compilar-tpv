// src/pages/Estadisticas.tsx
import React, { useMemo, useState } from "react";

// ✅ Ajusta estas rutas a tu estructura real
import MesasStats from "../features/estadisticas/MesasStats";
import ProductosStats from "../features/estadisticas/ProductosStats";
import ReservasStats from "../features/estadisticas/ReservasStats";
import ProveedoresStats from "../features/estadisticas/ProveedoresStats";
import TrabajadoresStats from "../features/estadisticas/TrabajadoresStats";
import ClientesStats from "../features/estadisticas/ClientesStats";

type StatsRange = "hoy" | "semana" | "mes" | "anio";
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
        <div className="w-full h-full bg-gris p-6">
            <div className="w-full h-full flex flex-col gap-4 min-h-0">
                {/* TopBar */}
                <div className="bg-blanco rounded-xl shadow-xs p-4 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="flex flex-col min-w-0">
                            <h2 className="text-2xl font-bold text-negro">
                                ESTADÍSTICAS
                            </h2>
                            <p className="text-sm text-negro/60">
                                Viendo:{" "}
                                <span className="font-semibold text-negro">
                                    {categoriaLabel}
                                </span>
                            </p>
                        </div>

                        {/* Controles */}
                        <div className="flex items-center gap-3 flex-wrap justify-end">
                            {/* Select categoría */}
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-negro/60">
                                    Categoría
                                </span>
                                <select
                                    value={categoria}
                                    onChange={(e) =>
                                        setCategoria(e.target.value as StatsKey)
                                    }
                                    className="w-56 rounded-xl border border-black/10 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-black/10"
                                >
                                    {STATS_OPTIONS.map((o) => (
                                        <option key={o.key} value={o.key}>
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Rango */}
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-negro/60">
                                    Rango
                                </span>

                                <div className="flex items-center gap-2">
                                    {RANGE_OPTIONS.map((r) => {
                                        const active = r.key === range;
                                        return (
                                            <button
                                                key={r.key}
                                                type="button"
                                                onClick={() => setRange(r.key)}
                                                className={cn(
                                                    "px-3 py-2 rounded-xl text-sm font-semibold transition",
                                                    active
                                                        ? "bg-black text-white"
                                                        : "bg-white border border-black/10 hover:bg-black/5 text-negro",
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
                    </div>

                    {/* Línea separadora ligera */}
                    <div className="h-px w-full bg-black/5" />
                </div>

                {/* Contenido */}
                <div className="flex-1 min-h-0 bg-blanco rounded-xl shadow-xs p-4 overflow-y-auto pr-1">
                    {renderContenido()}
                </div>
            </div>
        </div>
    );
}
