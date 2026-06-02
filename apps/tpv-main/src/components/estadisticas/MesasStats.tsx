// src/components/estadisticas/MesasStats.tsx
import React, { useEffect, useMemo, useState } from "react";
import Chart from "react-apexcharts";

// ✅ esto lo vamos a crear en statsApis.ts en el siguiente paso
import { mesasStatsGet, type MesasStatsResponse } from "./statsApis";

export type StatsRange = "hoy" | "semana" | "mes" | "anio";

function eur(n: number) {
    const v = Number.isFinite(n) ? n : 0;
    return new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 2,
    }).format(v);
}

function cn(...classes: Array<string | false | null | undefined>) {
    return classes.filter(Boolean).join(" ");
}

export default function MesasStats({ range }: { range: StatsRange }) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<MesasStatsResponse | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                setLoading(true);
                setError(null);
                const res = await mesasStatsGet(range);
                if (!alive) return;
                setData(res);
            } catch (e) {
                console.error(e);
                if (!alive) return;
                setError("No se pudieron cargar las estadísticas de mesas.");
                setData(null);
            } finally {
                if (alive) setLoading(false);
            }
        })();

        return () => {
            alive = false;
        };
    }, [range]);

    const ocupadas = data?.ocupadas ?? 0;
    const totalMesas = data?.total_mesas ?? 0;
    const libres = Math.max(0, totalMesas - ocupadas);
    const pct = useMemo(() => {
        if (!totalMesas) return 0;
        const p = (ocupadas / totalMesas) * 100;
        return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
    }, [ocupadas, totalMesas]);

    const donutOptions = useMemo(() => {
        return {
            chart: { type: "donut" as const, toolbar: { show: false } },
            labels: ["Ocupadas", "Libres"],
            legend: { position: "bottom" as const },
            dataLabels: { enabled: false },
            plotOptions: {
                pie: {
                    donut: {
                        size: "70%",
                        labels: {
                            show: true,
                            name: { show: true },
                            value: { show: true },
                            total: {
                                show: true,
                                label: "Ocupación",
                                formatter: () => `${pct}%`,
                            },
                        },
                    },
                },
            },
            stroke: { width: 0 },
        };
    }, [pct]);

    const donutSeries = useMemo(() => [ocupadas, libres], [ocupadas, libres]);

    const serviciosOptions = useMemo(() => {
        const labels = data?.servicios?.labels ?? [];
        return {
            chart: { type: "bar" as const, toolbar: { show: false } },
            xaxis: { categories: labels },
            dataLabels: { enabled: false },
            plotOptions: {
                bar: {
                    borderRadius: 10,
                    columnWidth: "55%",
                },
            },
            grid: { strokeDashArray: 4 },
            yaxis: { labels: { formatter: (v: any) => String(Math.round(v)) } },
        };
    }, [data?.servicios?.labels]);

    const serviciosSeries = useMemo(() => {
        return [
            {
                name: "Servicios cerrados",
                data: data?.servicios?.values ?? [],
            },
        ];
    }, [data?.servicios?.values]);

    const topMesasOptions = useMemo(() => {
        const rows = data?.top_mesas_ingresos ?? [];
        const categories = rows.map((r) => `${r.mesa} · ${r.zona}`);
        return {
            chart: { type: "bar" as const, toolbar: { show: false } },
            xaxis: { categories },
            dataLabels: { enabled: false },
            plotOptions: {
                bar: {
                    borderRadius: 10,
                    columnWidth: "55%",
                },
            },
            grid: { strokeDashArray: 4 },
            yaxis: { labels: { formatter: (v: any) => eur(Number(v)) } },
            tooltip: {
                y: {
                    formatter: (v: any) => eur(Number(v)),
                },
            },
        };
    }, [data?.top_mesas_ingresos]);

    const topMesasSeries = useMemo(() => {
        const rows = data?.top_mesas_ingresos ?? [];
        return [
            {
                name: "Ingresos",
                data: rows.map((r) => Number(r.total ?? 0)),
            },
        ];
    }, [data?.top_mesas_ingresos]);

    return (
        <div className="w-full h-full flex flex-col gap-4">
            {/* Header interno */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                    <h3 className="text-lg font-bold text-negro">
                        Mesas · Estadísticas
                    </h3>
                    <p className="text-sm text-negro/60">
                        Ocupación, ticket medio, servicios cerrados y top mesas.
                    </p>
                </div>

                <div className="text-sm text-negro/60">
                    Rango:{" "}
                    <span className="font-semibold text-negro">
                        {range.toUpperCase()}
                    </span>
                </div>
            </div>

            {error ? (
                <div className="rounded-xl border border-black/10 bg-white p-4">
                    <p className="text-sm font-semibold text-negro">{error}</p>
                    <p className="text-xs text-negro/60 mt-1">
                        Revisa el backend de stats o la conexión Tauri invoke.
                    </p>
                </div>
            ) : null}

            {/* KPIs + Donut */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                {/* Donut ocupación */}
                <div className="bg-white rounded-xl border border-black/10 p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-negro">
                            % Mesas ocupadas
                        </p>
                        <span className="text-xs text-negro/60">
                            {ocupadas}/{totalMesas}
                        </span>
                    </div>

                    <div className={cn("mt-3", loading && "opacity-60")}>
                        <Chart
                            options={donutOptions as any}
                            series={donutSeries as any}
                            type="donut"
                            height={280}
                        />
                    </div>
                </div>

                {/* Ticket medio */}
                <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col">
                    <p className="text-sm font-semibold text-negro">
                        Ticket medio por mesa
                    </p>
                    <p className="text-xs text-negro/60 mt-1">
                        Se calcula en el rango actual.
                    </p>

                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center">
                            <p className="text-4xl font-bold text-negro">
                                {eur(data?.ticket_medio_por_mesa ?? 0)}
                            </p>
                            <p className="text-xs text-negro/50 mt-1">
                                (solo valor)
                            </p>
                        </div>
                    </div>
                </div>

                {/* Mesa top comandas */}
                <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col">
                    <p className="text-sm font-semibold text-negro">
                        Mesa con más comandas
                    </p>
                    <p className="text-xs text-negro/60 mt-1">
                        Mesa + zona (en el rango actual)
                    </p>

                    <div className="flex-1 flex items-center justify-center">
                        {data?.mesa_top_comandas ? (
                            <div className="text-center">
                                <p className="text-3xl font-bold text-negro">
                                    {data.mesa_top_comandas.mesa}
                                </p>
                                <p className="text-sm text-negro/70 mt-1">
                                    Zona:{" "}
                                    <span className="font-semibold text-negro">
                                        {data.mesa_top_comandas.zona}
                                    </span>
                                </p>
                                <p className="text-xs text-negro/50 mt-1">
                                    Comandas: {data.mesa_top_comandas.comandas}
                                </p>
                            </div>
                        ) : (
                            <p className="text-sm text-negro/60">
                                Sin datos en este rango.
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {/* Servicios cerrados */}
                <div className="bg-white rounded-xl border border-black/10 p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-sm font-semibold text-negro">
                                Servicios cerrados
                            </p>
                            <p className="text-xs text-negro/60 mt-1">
                                Nº de comandas totalmente pagadas.
                            </p>
                        </div>
                    </div>

                    <div className={cn("mt-3", loading && "opacity-60")}>
                        <Chart
                            options={serviciosOptions as any}
                            series={serviciosSeries as any}
                            type="bar"
                            height={320}
                        />
                    </div>
                </div>

                {/* Top 10 mesas ingresos */}
                <div className="bg-white rounded-xl border border-black/10 p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-sm font-semibold text-negro">
                                Top 10 mesas por ingresos
                            </p>
                            <p className="text-xs text-negro/60 mt-1">
                                Total generado por mesa + zona.
                            </p>
                        </div>
                    </div>

                    <div className={cn("mt-3", loading && "opacity-60")}>
                        <Chart
                            options={topMesasOptions as any}
                            series={topMesasSeries as any}
                            type="bar"
                            height={320}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
