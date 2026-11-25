// src/features/estadisticas/MesasStats.tsx
import { useMemo } from "react";
import Chart from "react-apexcharts";

import { APEX_CHART_BASE } from "./apexBase";
import type { MesasStatsResponse, StatsRange } from "@tpv/contracts";
import { useMesasStats } from "./statsQueries";
import { CERO, deCentimos, eur } from "../../shared/lib/dinero";

function cn(...classes: Array<string | false | null | undefined>) {
    return classes.filter(Boolean).join(" ");
}

export default function MesasStats({ range }: { range: StatsRange }) {
    const query = useMesasStats(range);

    const data: MesasStatsResponse | null = query.data ?? null;
    const loading = query.isFetching;
    const error = query.isError
        ? "No se pudieron cargar las estadísticas de mesas."
        : null;

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
            chart: { ...APEX_CHART_BASE, type: "donut" as const, toolbar: { show: false } },
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
            chart: { ...APEX_CHART_BASE, type: "bar" as const, toolbar: { show: false } },
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
            chart: { ...APEX_CHART_BASE, type: "bar" as const, toolbar: { show: false } },
            xaxis: { categories },
            dataLabels: { enabled: false },
            plotOptions: {
                bar: {
                    borderRadius: 10,
                    columnWidth: "55%",
                },
            },
            grid: { strokeDashArray: 4 },
            yaxis: { labels: { formatter: (v: any) => eur(deCentimos(Number(v))) } },
            tooltip: {
                y: {
                    formatter: (v: any) => eur(deCentimos(Number(v))),
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
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
                <div className="min-w-0">
                    <h3 className="text-lg font-bold text-fg">
                        Mesas · Estadísticas
                    </h3>
                    <p className="text-sm text-fg-muted">
                        Ocupación, ticket medio, servicios cerrados y top mesas.
                    </p>
                </div>

                <div className="text-sm text-fg-muted">
                    Rango:{" "}
                    <span className="font-semibold text-fg">
                        {range.toUpperCase()}
                    </span>
                </div>
            </div>

            {error ? (
                <div className="rounded-xl border border-border bg-surface p-4">
                    <p className="text-sm font-semibold text-fg">{error}</p>
                    <p className="text-xs text-fg-muted mt-1">
                        Revisa el backend de stats o la conexión Tauri invoke.
                    </p>
                </div>
            ) : null}

            {/* KPIs + Donut */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                {/* Donut ocupación */}
                <div className="bg-surface rounded-xl border border-border p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-fg">
                            % Mesas ocupadas
                        </p>
                        <span className="text-xs text-fg-muted">
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
                <div className="bg-surface rounded-xl border border-border p-4 flex flex-col">
                    <p className="text-sm font-semibold text-fg">
                        Ticket medio por mesa
                    </p>
                    <p className="text-xs text-fg-muted mt-1">
                        Se calcula en el rango actual.
                    </p>

                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center">
                            <p className="text-4xl font-bold text-fg">
                                {eur(data?.ticket_medio_por_mesa ?? CERO)}
                            </p>
                            <p className="text-xs text-fg-subtle mt-1">
                                (solo valor)
                            </p>
                        </div>
                    </div>
                </div>

                {/* Mesa top comandas */}
                <div className="bg-surface rounded-xl border border-border p-4 flex flex-col">
                    <p className="text-sm font-semibold text-fg">
                        Mesa con más comandas
                    </p>
                    <p className="text-xs text-fg-muted mt-1">
                        Mesa + zona (en el rango actual)
                    </p>

                    <div className="flex-1 flex items-center justify-center">
                        {data?.mesa_top_comandas ? (
                            <div className="text-center">
                                <p className="text-3xl font-bold text-fg">
                                    {data.mesa_top_comandas.mesa}
                                </p>
                                <p className="text-sm text-fg-muted mt-1">
                                    Zona:{" "}
                                    <span className="font-semibold text-fg">
                                        {data.mesa_top_comandas.zona}
                                    </span>
                                </p>
                                <p className="text-xs text-fg-subtle mt-1">
                                    Comandas: {data.mesa_top_comandas.comandas}
                                </p>
                            </div>
                        ) : (
                            <p className="text-sm text-fg-muted">
                                Sin datos en este rango.
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {/* Servicios cerrados */}
                <div className="bg-surface rounded-xl border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-sm font-semibold text-fg">
                                Servicios cerrados
                            </p>
                            <p className="text-xs text-fg-muted mt-1">
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
                <div className="bg-surface rounded-xl border border-border p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-sm font-semibold text-fg">
                                Top 10 mesas por ingresos
                            </p>
                            <p className="text-xs text-fg-muted mt-1">
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
