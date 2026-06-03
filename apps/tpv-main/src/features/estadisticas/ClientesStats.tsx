// src/features/estadisticas/ClientesStats.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";
import { clientesStatsResumen } from "./statsApis";

/* =========================
   Tipos
========================= */
export type StatsRange = "hoy" | "semana" | "mes" | "anio";

type ChartSeriesI64 = { labels: string[]; values: number[] }; // counts
type ChartSeriesF64 = { labels: string[]; values: number[] }; // euros

export type ClientesStatsResponse = {
    // KPI
    nuevos: number;
    recurrentes: number;
    no_recurrentes: number;
    ticket_medio_cliente: number;

    // Charts
    nuevos_por_bucket: ChartSeriesI64;
    top_clientes_gasto: ChartSeriesF64;
};

/* =========================
   Helpers
========================= */
function formatEur(n: number) {
    return new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 2,
    }).format(Number.isFinite(n) ? n : 0);
}

function rangeLabel(r: StatsRange) {
    if (r === "hoy") return "Hoy";
    if (r === "semana") return "Semana";
    if (r === "mes") return "Mes";
    return "Año";
}

/* =========================
   Leyenda estilo Mesas / foto
   - solo circulito de color
   - texto normal
   - sin borde del circulito
========================= */
function useLegendClean() {
    return useMemo(
        () =>
            ({
                show: true,
                position: "bottom",
                labels: { useSeriesColors: false }, // ✅ texto blanco/negro normal, NO azul
                markers: {
                    width: 10,
                    height: 10,
                    radius: 999, // ✅ circulito
                    strokeWidth: 0, // ✅ sin borde
                },
            }) as any,
        [],
    );
}

/* =========================
   ChartCard inline (responsive + no solapes)
========================= */
function ChartCard({
    title,
    subtitle,
    loading,
    emptyText,
    heightClass = "min-h-[320px]",
    children,
}: {
    title: string;
    subtitle?: string;
    loading?: boolean;
    emptyText?: string;
    heightClass?: string;
    children: React.ReactNode;
}) {
    return (
        <section
            className={[
                "bg-blanco rounded-xl shadow-xs border border-black/5",
                "p-4 flex flex-col min-w-0",
                heightClass,
            ].join(" ")}
        >
            <header className="min-w-0">
                <h4 className="text-base font-extrabold text-negro truncate">
                    {title}
                </h4>
                {subtitle ? (
                    <p className="text-sm text-negro/60 truncate">{subtitle}</p>
                ) : null}
            </header>

            <div className="mt-3 flex-1 min-h-0 overflow-hidden">
                {loading ? (
                    <div className="h-full flex items-center justify-center text-sm text-negro/50">
                        Cargando…
                    </div>
                ) : (
                    children
                )}

                {!loading && emptyText ? (
                    <div className="mt-2 text-xs text-negro/40">{emptyText}</div>
                ) : null}
            </div>
        </section>
    );
}

/* =========================
   KPI Card
========================= */
function KPICard({
    label,
    value,
    sub,
}: {
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
}) {
    return (
        <div className="bg-blanco rounded-xl shadow-xs p-4 border border-black/5 min-w-0">
            <p className="text-sm text-negro/60 truncate">{label}</p>
            <p className="text-2xl font-extrabold text-negro mt-1 truncate">
                {value}
            </p>
            {sub ? (
                <div className="text-xs text-negro/40 mt-1 min-w-0">{sub}</div>
            ) : null}
        </div>
    );
}

/* =========================
   Componente
========================= */
export default function ClientesStats({ range }: { range: StatsRange }) {
    const legendClean = useLegendClean();

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<ClientesStatsResponse | null>(null);

    const cargar = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await clientesStatsResumen({ range });
            setData(res);
        } catch (e: any) {
            console.error(e);
            setData(null);
            setError(e?.message || String(e));
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => {
        void cargar();
    }, [cargar]);

    const nuevos = data?.nuevos ?? 0;
    const recurrentes = data?.recurrentes ?? 0;
    const noRecurrentes = data?.no_recurrentes ?? 0;

    const totalClientesRango = recurrentes + noRecurrentes;

    const pctRecurrentes = useMemo(() => {
        const total = recurrentes + noRecurrentes;
        if (total <= 0) return 0;
        return Math.round((recurrentes / total) * 100);
    }, [recurrentes, noRecurrentes]);

    /* ---------- Donut: recurrentes vs no ---------- */
    const donutSeries = useMemo(
        () => [recurrentes, noRecurrentes],
        [recurrentes, noRecurrentes],
    );

    const donutOptions: ApexOptions = useMemo(
        () => ({
            chart: { type: "donut", toolbar: { show: false }, fontFamily: "inherit" },
            labels: ["Recurrentes", "No recurrentes"],
            colors: ["#0ea5e9", "#94a3b8"], // ✅ azul Mesas + gris
            legend: legendClean,
            dataLabels: { enabled: false },
            stroke: { width: 0 }, // ✅ sin borde negro (como Mesas)
            plotOptions: {
                pie: {
                    donut: {
                        size: "72%",
                        labels: {
                            show: true,
                            name: { show: true },
                            value: {
                                show: true,
                                formatter: (v: string) =>
                                    `${Math.round(Number(v) || 0)}`,
                            },
                            total: {
                                show: true,
                                label: "% recurrentes",
                                formatter: () => `${pctRecurrentes}%`,
                            },
                        },
                    },
                },
            },
            tooltip: {
                fillSeriesColor: false, // ✅ no pintar todo el tooltip
                y: {
                    formatter: (v: number) => `${Math.round(v)} clientes`,
                    title: { formatter: () => "Clientes" },
                },
            },
            grid: { padding: { top: 0, bottom: 0 } },
        }),
        [pctRecurrentes, legendClean],
    );

    /* ---------- Línea: nuevos por bucket ---------- */
    const bucketLabels = data?.nuevos_por_bucket?.labels ?? [];
    const bucketValues = data?.nuevos_por_bucket?.values ?? [];

    const lineSeries = useMemo(
        () => [{ name: "Clientes nuevos", data: bucketValues }],
        [bucketValues],
    );

    const lineOptions: ApexOptions = useMemo(
        () => ({
            chart: { type: "line", toolbar: { show: false }, fontFamily: "inherit" },
            colors: ["#0ea5e9"], // ✅ azul Mesas
            stroke: { width: 3, curve: "smooth" },
            dataLabels: { enabled: false },
            grid: { strokeDashArray: 4 },
            legend: legendClean,
            xaxis: {
                categories: bucketLabels,
                labels: {
                    rotate: -35,
                    hideOverlappingLabels: true,
                    trim: true,
                    style: { fontSize: "12px" },
                },
            },
            tooltip: {
                shared: true,
                fillSeriesColor: false,
                y: {
                    formatter: (v: number) => `${Math.round(v)} clientes`,
                    title: { formatter: () => "Nuevos" },
                },
            },
            yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` } },
        }),
        [bucketLabels, legendClean],
    );

    /* ---------- Barras: top clientes por gasto ---------- */
    const topLabels = data?.top_clientes_gasto?.labels ?? [];
    const topValues = data?.top_clientes_gasto?.values ?? [];

    const topHeight = useMemo(() => {
        const estimated = topLabels.length * 34 + 110;
        return Math.max(320, Math.min(720, estimated));
    }, [topLabels.length]);

    const topSeries = useMemo(
        () => [{ name: "Gasto total", data: topValues }],
        [topValues],
    );

    const topOptions: ApexOptions = useMemo(
        () => ({
            chart: { type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
            colors: ["#0ea5e9"], // ✅ azul Mesas
            stroke: { width: 0 }, // ✅ sin borde negro
            plotOptions: {
                bar: {
                    horizontal: true,
                    borderRadius: 8,
                    barHeight: "70%",
                },
            },
            dataLabels: { enabled: false },
            grid: { strokeDashArray: 4 },
            legend: legendClean,
            xaxis: {
                categories: topLabels,
                labels: { trim: true, style: { fontSize: "12px" } },
            },
            tooltip: {
                fillSeriesColor: false,
                y: {
                    formatter: (v: number) => formatEur(v),
                    title: { formatter: () => "Total" },
                },
            },
        }),
        [topLabels, legendClean],
    );

    return (
        <div className="w-full h-full min-h-0 flex flex-col gap-4">
            {/* Header */}
            <div className="bg-blanco rounded-xl shadow-xs p-4 border border-black/5 min-w-0">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="text-lg font-bold text-negro truncate">
                            Clientes
                        </h3>
                        <p className="text-sm text-negro/60 truncate">
                            Nuevos, recurrentes, ticket medio por cliente y top gasto ·
                            Rango: {rangeLabel(range)}
                        </p>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-3">
                        <span className="text-xs text-negro/50">
                            {loading ? "Cargando…" : "Actualizado"}
                        </span>
                        <button
                            onClick={() => void cargar()}
                            disabled={loading}
                            className="px-3 py-2 rounded-lg bg-white border border-black/10 shadow-xs text-sm font-semibold hover:opacity-90 disabled:opacity-60 whitespace-nowrap"
                            title="Recargar"
                        >
                            Recargar
                        </button>
                    </div>
                </div>
            </div>

            {error ? (
                <div className="bg-blanco rounded-xl shadow-xs p-4 border border-rose-200 text-rose-700 min-w-0">
                    <p className="font-bold">Error</p>
                    <p className="text-sm break-words">{error}</p>
                </div>
            ) : null}

            {/* KPIs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 min-w-0">
                <KPICard label="Clientes nuevos" value={nuevos} />

                <KPICard
                    label="Clientes (en el rango)"
                    value={totalClientesRango}
                    sub={
                        <span className="truncate block">
                            {recurrentes} recurrentes · {noRecurrentes} no recurrentes
                        </span>
                    }
                />

                <KPICard label="% recurrentes" value={`${pctRecurrentes}%`} />

                <KPICard
                    label="Ticket medio / cliente"
                    value={formatEur(data?.ticket_medio_cliente ?? 0)}
                />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0 min-w-0">
                <ChartCard
                    title="Recurrentes vs no recurrentes"
                    subtitle="Distribución de clientes en el rango"
                    loading={loading}
                    heightClass="min-h-[340px]"
                >
                    {totalClientesRango <= 0 ? (
                        <div className="h-full flex items-center justify-center text-sm text-negro/50">
                            No hay datos para este rango.
                        </div>
                    ) : (
                        <div className="w-full h-full">
                            <ReactApexChart
                                type="donut"
                                height={320}
                                options={donutOptions}
                                series={donutSeries}
                            />
                        </div>
                    )}
                </ChartCard>

                <ChartCard
                    title="Evolución de clientes nuevos"
                    subtitle="Clientes nuevos por hora/día/mes (según el rango)"
                    loading={loading}
                    heightClass="min-h-[340px]"
                >
                    {bucketLabels.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-sm text-negro/50">
                            No hay datos para este rango.
                        </div>
                    ) : (
                        <div className="w-full h-full">
                            <ReactApexChart
                                type="line"
                                height={320}
                                options={lineOptions}
                                series={lineSeries as any}
                            />
                        </div>
                    )}
                </ChartCard>

                <div className="xl:col-span-2 min-h-0 min-w-0">
                    <ChartCard
                        title="Top clientes por gasto total"
                        subtitle="Quiénes han gastado más en total"
                        loading={loading}
                        heightClass="min-h-[360px]"
                    >
                        {topLabels.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-sm text-negro/50">
                                No hay datos para este rango.
                            </div>
                        ) : (
                            <div className="w-full min-h-0 overflow-auto pr-1">
                                <ReactApexChart
                                    type="bar"
                                    height={topHeight}
                                    options={topOptions}
                                    series={topSeries as any}
                                />
                            </div>
                        )}
                    </ChartCard>
                </div>
            </div>
        </div>
    );
}