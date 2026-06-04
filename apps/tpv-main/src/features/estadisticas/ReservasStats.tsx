// src/features/estadisticas/ReservasStats.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

import { useToast } from "../../shared/toast";
import { cn } from "../ventaRapida/utils";

import {
    type StatsRange,
    type StatsTurno,
    type ReservasStatsResponse,
} from "./statsApis";
import { useReservasStats } from "./statsQueries";

export default function ReservasStats({ range }: { range: StatsRange }) {
    const toast = useToast();

    const [turno, setTurno] = useState<StatsTurno>("TODOS");

    const query = useReservasStats(range, turno);

    const data: ReservasStatsResponse | null = query.data ?? null;
    const loading = query.isFetching;

    useEffect(() => {
        if (query.isError) {
            console.error(query.error);
            toast.error("Error", "No se pudieron cargar las estadísticas de reservas.");
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
    const barLabels = data?.reservas_por_bucket?.labels ?? [];
    const barValues = data?.reservas_por_bucket?.values ?? [];
    const barHeight = useMemo(
        () => Math.max(380, Math.min(680, barLabels.length * 30)),
        [barLabels.length],
    );

    // Donut: estado reservas
    const estadoLabels = data?.estado?.labels ?? [];
    const estadoValues = data?.estado?.values ?? [];

    // Donut: franjas horarias
    const franjaLabels = data?.franjas?.labels ?? [];
    const franjaValues = data?.franjas?.values ?? [];
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
            chart: { type: "donut", toolbar: { show: false }, fontFamily: "inherit" },
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
        const colors = ["#0ea5e9", "#10b981", "#94a3b8"];
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
        const colors = ["#0ea5e9", "#10b981", "#f59e0b", "#a78bfa"];
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
            chart: { type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
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
                "rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold outline-none",
                "focus:ring-2 focus:ring-black/10",
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
            <div className="bg-white rounded-xl border border-black/10 p-4 flex items-center justify-between">
                <div className="min-w-0">
                    <h3 className="text-lg font-bold text-negro">Reservas</h3>
                    <p className="text-sm text-negro/60">
                        Volumen, estados, distribución por rango y comportamiento por turnos.
                    </p>
                </div>
                <div className="text-xs text-negro/50">{loading ? "Cargando…" : "Actualizado"}</div>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-black/10 p-4">
                    <p className="text-sm text-negro/60">Reservas</p>
                    <p className="text-2xl font-extrabold text-negro mt-1">{totalReservas}</p>
                    <p className="text-xs text-negro/50 mt-1">Total de reservas en el rango.</p>
                </div>

                <div className="bg-white rounded-xl border border-black/10 p-4">
                    <p className="text-sm text-negro/60">Cancelaciones</p>
                    <p className="text-2xl font-extrabold text-negro mt-1">{cancelaciones}</p>
                    <p className="text-xs text-negro/50 mt-1">Reservas canceladas en el rango.</p>
                </div>

                <div className="bg-white rounded-xl border border-black/10 p-4">
                    <p className="text-sm text-negro/60">% mesas reservadas (turno)</p>
                    <p className="text-2xl font-extrabold text-negro mt-1">
                        {totalMesasTurno > 0 ? `${pctReservadas}%` : "—"}
                    </p>
                    <p className="text-xs text-negro/50 mt-1">Según el turno seleccionado.</p>
                </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
                {/* Donut turno */}
                <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-[460px]">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h4 className="text-base font-bold text-negro truncate">Mesas reservadas vs no reservadas</h4>
                            <p className="text-sm text-negro/60 truncate">Comparativa por turno (porcentaje).</p>
                        </div>
                        <SelectTurno value={turno} onChange={setTurno} disabled={loading} />
                    </div>

                    <div className="mt-4 flex-1 min-h-0 flex items-center justify-center">
                        {totalMesasTurno <= 0 ? (
                            <div className="text-sm text-negro/50">No hay datos para este rango/turno.</div>
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
                <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-[460px]">
                    <div className="min-w-0">
                        <h4 className="text-base font-bold text-negro truncate">Reservas por periodo</h4>
                        <p className="text-sm text-negro/60 truncate">Distribución por {range}.</p>
                    </div>

                    <div className="mt-4 flex-1 min-h-0">
                        {barLabels.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-sm text-negro/50">No hay datos para este rango.</div>
                        ) : (
                            <ReactApexChart type="bar" height={barHeight} options={barOptions} series={barSeries as any} />
                        )}
                    </div>
                </div>

                {/* Donut estados */}
                <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-[460px]">
                    <div className="min-w-0">
                        <h4 className="text-base font-bold text-negro truncate">Estado de las reservas</h4>
                        <p className="text-sm text-negro/60 truncate">Activas · Finalizadas · Canceladas</p>
                    </div>

                    <div className="mt-4 flex-1 min-h-0 flex items-center justify-center">
                        {estadoLabels.length === 0 ? (
                            <div className="text-sm text-negro/50">No hay datos.</div>
                        ) : (
                            <ReactApexChart type="donut" height={360} options={estadoOptions} series={estadoValues} />
                        )}
                    </div>
                </div>

                {/* Donut franjas + desglose */}
                <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-[460px]">
                    <div className="min-w-0">
                        <h4 className="text-base font-bold text-negro truncate">Reservas por franja horaria</h4>
                        <p className="text-sm text-negro/60 truncate">Distribución por franjas (con desglose).</p>
                    </div>

                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0">
                        <div className="flex items-center justify-center min-h-[320px]">
                            {franjaLabels.length === 0 ? (
                                <div className="text-sm text-negro/50">No hay datos.</div>
                            ) : (
                                <ReactApexChart type="donut" height={330} options={franjasOptions} series={franjaValues} />
                            )}
                        </div>

                        <div className="flex flex-col justify-center gap-2 min-h-0">
                            {franjaLabels.length === 0 ? (
                                <div className="text-sm text-negro/50">Sin desglose disponible.</div>
                            ) : (
                                <div className="bg-white rounded-xl border border-black/10 p-3">
                                    <p className="text-xs font-semibold text-negro/60">Desglose</p>

                                    <div className="mt-2 flex flex-col gap-2">
                                        {franjaLabels.map((lbl, i) => {
                                            const v = Number(franjaValues[i] ?? 0);
                                            const pct = totalFranjas > 0 ? Math.round((v / totalFranjas) * 100) : 0;

                                            return (
                                                <div key={`${lbl}-${i}`} className="flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold text-negro truncate">{lbl}</p>
                                                        <p className="text-xs text-negro/50">{pct}% del total</p>
                                                    </div>

                                                    <div className="text-sm font-extrabold text-negro">{v}</div>
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