// src/features/estadisticas/ReservasStats.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { toAppError } from "@tpv/client";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

import { useToast } from "../../shared/toast";
import { cn } from "../ventaRapida/utils";

import { APEX_CHART_BASE } from "./apexBase";
import {
    type StatsRange,
    type StatsTurno,
    type ReservasStatsResponse,
} from "@tpv/contracts";
import { useReservasStats } from "./statsQueries";

export default function ReservasStats({ range }: { range: StatsRange }) {
    const toast = useToast();

    const [turno, setTurno] = useState<StatsTurno>("TODOS");

    const query = useReservasStats(range, turno);

    const data: ReservasStatsResponse | null = query.data ?? null;
    const loading = query.isFetching;

    useEffect(() => {
        if (query.isError) {
            toast.error("No se pudieron cargar las estadísticas de reservas", toAppError(query.error).message);
        }
    }, [query.isError, query.error, toast]);

    const totalReservas = data?.total_reservas ?? 0;
    const cancelaciones = data?.cancelaciones ?? 0;

    // Donut: mesas reservadas vs no reservadas (según turno)
    const mesasReservadas = data?.mesas_turno?.mesas_reservadas ?? 0;
    const mesasNoReservadas = data?.mesas_turno?.mesas_no_reservadas ?? 0;
    const totalMesasTurno = mesasReservadas + mesasNoReservadas;

    const pctReservadas = useMemo(() => {
        if (totalMesasTurno <= 0) return 0;
        return Math.round((mesasReservadas / totalMesasTurno) * 100);
    }, [mesasReservadas, totalMesasTurno]);

    // Bar: reservas por bucket
    const barLabels = useMemo(() => data?.reservas_por_bucket?.labels ?? [], [data?.reservas_por_bucket?.labels]);
    const barValues = useMemo(() => data?.reservas_por_bucket?.values ?? [], [data?.reservas_por_bucket?.values]);
    const barHeight = useMemo(
        () => Math.max(380, Math.min(680, barLabels.length * 30)),
        [barLabels.length],
    );

    // Donut: estado reservas
    const estadoLabels = useMemo(() => data?.estado?.labels ?? [], [data?.estado?.labels]);
    const estadoValues = useMemo(() => data?.estado?.values ?? [], [data?.estado?.values]);

    // Donut: franjas horarias
    const franjaLabels = useMemo(() => data?.franjas?.labels ?? [], [data?.franjas?.labels]);
    const franjaValues = useMemo(() => data?.franjas?.values ?? [], [data?.franjas?.values]);
    const totalFranjas = useMemo(
        () => franjaValues.reduce((a, b) => a + Number(b || 0), 0),
        [franjaValues],
    );

    /**
     * ✅ Base “estilo Mesas / tu foto”
     * - colors directos
     * - stroke 0 (sin bordes negros)
     * - leyenda: SOLO circulito de color, texto normal
     * - tooltip: NO pintar entero
     */
    const legendClean = useMemo(
        () =>
            ({
                show: true,
                position: "bottom",
                labels: { useSeriesColors: false }, // ✅ texto normal (no coloreado)
                markers: {
                    width: 10,
                    height: 10,
                    radius: 999, // ✅ circulito
                    strokeWidth: 0, // ✅ sin borde
                },
            }) as any,
        [],
    );

    const donutBase = useCallback(
        (labels: string[], colors: string[]): ApexOptions => ({
            chart: { ...APEX_CHART_BASE, type: "donut", toolbar: { show: false }, fontFamily: "inherit" },
            labels,
            colors,
            legend: legendClean,
            dataLabels: { enabled: false },
            stroke: { width: 0 },
            plotOptions: {
                pie: {
                    donut: {
                        size: "70%",
                        labels: {
                            show: true,
                            showAlways: true, // ✅ siempre visible (TS no lo tipa)
                            name: { show: true, showAlways: true, offsetY: -6 },
                            value: {
                                show: true,
                                showAlways: true,
                                offsetY: 6,
                                formatter: (v: string) => `${Math.round(Number(v) || 0)}`,
                            },
                            total: { show: false, showAlways: true },
                        } as any,
                    },
                },
            },
            tooltip: { fillSeriesColor: false },
            grid: { padding: { top: 0, bottom: 0 } },
        }),
        [legendClean],
    );

    // ✅ Donut turno (ya lo tenías bien)
    const donutTurnoOptions: ApexOptions = useMemo(() => {
        const labels = ["Reservadas", "No reservadas"];
        const colors = ["#0ea5e9", "#10b981"]; // sky-500, emerald-500

        return {
            ...donutBase(labels, colors),
            plotOptions: {
                pie: {
                    donut: {
                        size: "72%",
                        labels: {
                            show: true,
                            showAlways: true,
                            name: { show: true, showAlways: true, offsetY: -6 },
                            value: {
                                show: true,
                                showAlways: true,
                                offsetY: 6,
                                formatter: (v: string) => `${Math.round(Number(v) || 0)}`,
                            },
                            total: {
                                show: true,
                                showAlways: true,
                                label: `${pctReservadas}%`,
                                formatter: () => `${mesasReservadas}/${totalMesasTurno}`,
                            },
                        } as any,
                    },
                },
            },
        };
    }, [donutBase, pctReservadas, mesasReservadas, totalMesasTurno]);

    // ✅ Donut estados (AHORA IGUAL: texto siempre visible + total en centro)
    const estadoOptions: ApexOptions = useMemo(() => {
        // Por llegar, en la mesa, terminadas, canceladas y no vinieron.
        const colors = ["#0ea5e9", "#10b981", "#94a3b8", "#ef4444", "#f59e0b"];
        const totalEstado = estadoValues.reduce((a, b) => a + Number(b || 0), 0);

        return {
            ...donutBase(estadoLabels, colors),
            plotOptions: {
                pie: {
                    donut: {
                        size: "72%",
                        labels: {
                            show: true,
                            showAlways: true,
                            name: { show: true, showAlways: true, offsetY: -6 },
                            value: {
                                show: true,
                                showAlways: true,
                                offsetY: 6,
                                formatter: (v: string) => `${Math.round(Number(v) || 0)}`,
                            },
                            total: {
                                show: true,
                                showAlways: true,
                                label: "Total",
                                formatter: () => `${Math.round(Number(totalEstado) || 0)}`,
                            },
                        } as any,
                    },
                },
            },
        };
    }, [donutBase, estadoLabels, estadoValues]);

    // ✅ Donut franjas (AHORA IGUAL: texto siempre visible + total en centro)
    const franjasOptions: ApexOptions = useMemo(() => {
        const colors = ["#016FFC", "#10b981", "#f59e0b", "#2B81D4"];
        const total = franjaValues.reduce((a, b) => a + Number(b || 0), 0);

        return {
            ...donutBase(franjaLabels, colors),
            plotOptions: {
                pie: {
                    donut: {
                        size: "72%",
                        labels: {
                            show: true,
                            showAlways: true,
                            name: { show: true, showAlways: true, offsetY: -6 },
                            value: {
                                show: true,
                                showAlways: true,
                                offsetY: 6,
                                formatter: (v: string) => `${Math.round(Number(v) || 0)}`,
                            },
                            total: {
                                show: true,
                                showAlways: true,
                                label: "Total",
                                formatter: () => `${Math.round(Number(total) || 0)}`,
                            },
                        } as any,
                    },
                },
            },
        };
    }, [donutBase, franjaLabels, franjaValues]);

    // ✅ Barras: azul Mesas + sin borde negro + leyenda “circulito”
    const barOptions: ApexOptions = useMemo(
        () => ({
            chart: { ...APEX_CHART_BASE, type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
            colors: ["#0ea5e9"],
            stroke: { width: 0 },
            plotOptions: {
                bar: {
                    horizontal: true,
                    borderRadius: 8,
                    barHeight: "70%",
                },
            },
            dataLabels: { enabled: false },
            grid: { strokeDashArray: 4 },
            xaxis: { categories: barLabels, labels: { trim: true } },
            legend: legendClean,
            tooltip: {
                fillSeriesColor: false,
                y: {
                    formatter: (val: number) => `${Math.round(val)}`,
                    title: { formatter: () => "Reservas" },
                },
            },
        }),
        [barLabels, legendClean],
    );

    const barSeries = useMemo(() => [{ name: "Reservas", data: barValues }], [barValues]);

    // ===== UI helpers =====
    const SelectTurno = ({
        value,
        onChange,
        disabled,
    }: {
        value: StatsTurno;
        onChange: (v: StatsTurno) => void;
        disabled?: boolean;
    }) => (
        <select
            className={cn(
                "rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold outline-none",
                "focus:ring-2 focus:ring-ring",
                disabled && "opacity-60 cursor-not-allowed",
            )}
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value as StatsTurno)}
        >
            <option value="COMIDA">Turno · Comida</option>
            <option value="CENA">Turno · Cena</option>
            <option value="TODOS">Turno · Todos</option>
        </select>
    );

    return (
        <div className="w-full h-full flex flex-col gap-4 min-h-0">
            {/* Header */}
            <div className="bg-surface rounded-xl border border-border p-4 flex items-center justify-between">
                <div className="min-w-0">
                    <h3 className="text-lg font-bold text-fg">Reservas</h3>
                    <p className="text-sm text-fg-muted">
                        Volumen, estados, distribución por rango y comportamiento por turnos.
                    </p>
                </div>
                <div className="text-xs text-fg-subtle">{loading ? "Cargando…" : "Actualizado"}</div>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-surface rounded-xl border border-border p-4">
                    <p className="text-sm text-fg-muted">Reservas</p>
                    <p className="text-2xl font-extrabold text-fg mt-1">{totalReservas}</p>
                    <p className="text-xs text-fg-subtle mt-1">Total de reservas en el rango.</p>
                </div>

                <div className="bg-surface rounded-xl border border-border p-4">
                    <p className="text-sm text-fg-muted">Cancelaciones</p>
                    <p className="text-2xl font-extrabold text-fg mt-1">{cancelaciones}</p>
                    <p className="text-xs text-fg-subtle mt-1">Reservas canceladas en el rango.</p>
                </div>

                <div className="bg-surface rounded-xl border border-border p-4">
                    <p className="text-sm text-fg-muted">% mesas reservadas (turno)</p>
                    <p className="text-2xl font-extrabold text-fg mt-1">
                        {totalMesasTurno > 0 ? `${pctReservadas}%` : "—"}
                    </p>
                    <p className="text-xs text-fg-subtle mt-1">Según el turno seleccionado.</p>
                </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
                {/* Donut turno */}
                <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-[460px]">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h4 className="text-base font-bold text-fg truncate">Mesas reservadas vs no reservadas</h4>
                            <p className="text-sm text-fg-muted truncate">Comparativa por turno (porcentaje).</p>
                        </div>
                        <SelectTurno value={turno} onChange={setTurno} disabled={loading} />
                    </div>

                    <div className="mt-4 flex-1 min-h-0 flex items-center justify-center">
                        {totalMesasTurno <= 0 ? (
                            <div className="text-sm text-fg-subtle">No hay datos para este rango/turno.</div>
                        ) : (
                            <ReactApexChart
                                type="donut"
                                height={360}
                                options={donutTurnoOptions}
                                series={[mesasReservadas, mesasNoReservadas]}
                            />
                        )}
                    </div>
                </div>

                {/* Barras */}
                <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-[460px]">
                    <div className="min-w-0">
                        <h4 className="text-base font-bold text-fg truncate">Reservas por periodo</h4>
                        <p className="text-sm text-fg-muted truncate">Distribución por {range}.</p>
                    </div>

                    <div className="mt-4 flex-1 min-h-0">
                        {barLabels.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-sm text-fg-subtle">No hay datos para este rango.</div>
                        ) : (
                            <ReactApexChart type="bar" height={barHeight} options={barOptions} series={barSeries as any} />
                        )}
                    </div>
                </div>

                {/* Donut estados */}
                <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-[460px]">
                    <div className="min-w-0">
                        <h4 className="text-base font-bold text-fg truncate">Estado de las reservas</h4>
                        <p className="text-sm text-fg-muted truncate">Por llegar · En la mesa · Terminadas · Canceladas · No vinieron</p>
                    </div>

                    <div className="mt-4 flex-1 min-h-0 flex items-center justify-center">
                        {estadoLabels.length === 0 ? (
                            <div className="text-sm text-fg-subtle">No hay datos.</div>
                        ) : (
                            <ReactApexChart type="donut" height={360} options={estadoOptions} series={estadoValues} />
                        )}
                    </div>
                </div>

                {/* Donut franjas + desglose */}
                <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-[460px]">
                    <div className="min-w-0">
                        <h4 className="text-base font-bold text-fg truncate">Reservas por franja horaria</h4>
                        <p className="text-sm text-fg-muted truncate">Distribución por franjas (con desglose).</p>
                    </div>

                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0">
                        <div className="flex items-center justify-center min-h-[320px]">
                            {franjaLabels.length === 0 ? (
                                <div className="text-sm text-fg-subtle">No hay datos.</div>
                            ) : (
                                <ReactApexChart type="donut" height={330} options={franjasOptions} series={franjaValues} />
                            )}
                        </div>

                        <div className="flex flex-col justify-center gap-2 min-h-0">
                            {franjaLabels.length === 0 ? (
                                <div className="text-sm text-fg-subtle">Sin desglose disponible.</div>
                            ) : (
                                <div className="bg-surface rounded-xl border border-border p-3">
                                    <p className="text-xs font-semibold text-fg-muted">Desglose</p>

                                    <div className="mt-2 flex flex-col gap-2">
                                        {franjaLabels.map((lbl, i) => {
                                            const v = Number(franjaValues[i] ?? 0);
                                            const pct = totalFranjas > 0 ? Math.round((v / totalFranjas) * 100) : 0;

                                            return (
                                                <div key={`${lbl}-${i}`} className="flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold text-fg truncate">{lbl}</p>
                                                        <p className="text-xs text-fg-subtle">{pct}% del total</p>
                                                    </div>

                                                    <div className="text-sm font-extrabold text-fg">{v}</div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
