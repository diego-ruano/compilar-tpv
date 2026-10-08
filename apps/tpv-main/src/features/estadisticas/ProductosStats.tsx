import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

import { useToast } from "../../shared/toast";
import { cn } from "../ventaRapida/utils";

import { APEX_CHART_BASE } from "./apexBase";
import {
  type StatsRange,
  type StatsCategoriaRow,
  type ProductosStatsResponse as ProductosStatsResumen,
} from "@tpv/contracts";
import { useProductosCategorias, useProductosResumen } from "./statsQueries";

export default function ProductosStats({ range }: { range: StatsRange }) {
  const toast = useToast();

  const [catTopId, setCatTopId] = useState<string | null>(null);
  const [catWorstId, setCatWorstId] = useState<string | null>(null);

  const categoriasQuery = useProductosCategorias();
  const resumenQuery = useProductosResumen(range, catTopId, catWorstId);

  const categorias: StatsCategoriaRow[] = categoriasQuery.data ?? [];
  const resumen: ProductosStatsResumen | null = resumenQuery.data ?? null;

  const loadingCats = categoriasQuery.isFetching;
  const loading = resumenQuery.isFetching;

  useEffect(() => {
    if (categoriasQuery.isError) {
      console.error(categoriasQuery.error);
      toast.error("Error", "No se pudieron cargar las categorías.");
    }
  }, [categoriasQuery.isError, categoriasQuery.error, toast]);

  useEffect(() => {
    if (resumenQuery.isError) {
      console.error(resumenQuery.error);
      toast.error("Error", "No se pudieron cargar las estadísticas de productos.");
    }
  }, [resumenQuery.isError, resumenQuery.error, toast]);

  const bestName = resumen?.mejor_producto ?? null;
  const worstName = resumen?.peor_producto_vendible ?? null;

  const topLabels = resumen?.top10_mejores?.labels ?? [];
  const topValues = resumen?.top10_mejores?.values ?? [];

  const worstLabels = resumen?.top10_peores?.labels ?? [];
  const worstValues = resumen?.top10_peores?.values ?? [];

  const heightTop = useMemo(
    () => Math.max(380, Math.min(680, topLabels.length * 30)),
    [topLabels.length],
  );
  const heightWorst = useMemo(
    () => Math.max(380, Math.min(680, worstLabels.length * 30)),
    [worstLabels.length],
  );

  /**
   * ✅ Opciones base (estilo Mesas)
   * - colors => color directo a la serie
   * - stroke 0 => sin “borde negro”
   * - legend: texto normal, solo el circulito del color
   * - tooltip: NO pintar el tooltip entero
   */
  const barOptions = useCallback(
    (labels: string[], title: string, color: string): ApexOptions => ({
      chart: {
        ...APEX_CHART_BASE,
        type: "bar",
        toolbar: { show: false },
        animations: { enabled: true },
        fontFamily: "inherit",
      },
      colors: [color],
      stroke: { width: 0 },
      title: { text: "", style: { fontSize: "0px" } },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 8,
          barHeight: "70%",
        },
      },
      dataLabels: { enabled: false },
      grid: { strokeDashArray: 4 },
      xaxis: {
        categories: labels,
        labels: { trim: true },
      },
      legend: {
        show: true,
        labels: { useSeriesColors: false }, // ✅ NO colorear texto
        markers: {
          width: 10,
          height: 10,
          strokeWidth: 0,
        } as any,
      } as any,
      tooltip: {
        fillSeriesColor: false, // ✅ NO colorear tooltip entero
        marker: { show: true },
        y: {
          formatter: (val: number) => `${val}`,
          title: { formatter: () => title },
        },
      },
    }),
    [],
  );

  const topSeries = useMemo(() => [{ name: "Unidades", data: topValues }], [topValues]);
  const worstSeries = useMemo(() => [{ name: "Unidades", data: worstValues }], [worstValues]);

  const SelectCategoria = ({
    value,
    onChange,
    disabled,
  }: {
    value: string | null;
    onChange: (v: string | null) => void;
    disabled?: boolean;
  }) => (
    <select
      className={cn(
        "rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold outline-none",
        "focus:ring-2 focus:ring-ring",
        disabled && "opacity-60 cursor-not-allowed",
      )}
      disabled={disabled}
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : v);
      }}
    >
      <option value="">Todas las categorías</option>
      {categorias.map((c) => (
        <option key={c.ID_Categoria} value={c.ID_Categoria}>
          {c.Nombre}
        </option>
      ))}
    </select>
  );

  return (
    <div className="w-full h-full flex flex-col gap-4 min-h-0">
      {/* Header */}
      <div className="bg-surface rounded-xl border border-border p-4 flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-fg">Productos</h3>
          <p className="text-sm text-fg-muted">
            Mejores/peores productos y rankings por unidades vendidas (según rango).
          </p>
        </div>

        <div className="text-xs text-fg-subtle">
          {loading || loadingCats ? "Cargando…" : "Actualizado"}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-sm text-fg-muted">Mejor producto</p>
          <p className="text-2xl font-extrabold text-fg mt-1 truncate">{bestName ?? "—"}</p>
          <p className="text-xs text-fg-subtle mt-1">Producto con más unidades vendidas.</p>
        </div>

        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-sm text-fg-muted">Peor producto (vendible)</p>
          <p className="text-2xl font-extrabold text-fg mt-1 truncate">{worstName ?? "—"}</p>
          <p className="text-xs text-fg-subtle mt-1">Producto vendible con menos unidades vendidas.</p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* Top 10 mejores */}
        <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-[460px]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-base font-bold text-fg truncate">Top 10 mejores productos</h4>
              <p className="text-sm text-fg-muted truncate">
                Más vendidos (unidades) {catTopId ? "· filtrado" : "· todas"}
              </p>
            </div>

            <SelectCategoria value={catTopId} onChange={setCatTopId} disabled={loadingCats} />
          </div>

          <div className={cn("mt-4 flex-1 min-h-0", loading && "opacity-60", "[&_.apexcharts-tooltip-marker]:!rounded-full")}>
            {topLabels.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-fg-subtle">
                No hay datos para este rango/filtro.
              </div>
            ) : (
              <ReactApexChart
                type="bar"
                height={heightTop}
                options={barOptions(topLabels, "Unidades", "#0ea5e9")}
                series={topSeries as any}
              />
            )}
          </div>
        </div>

        {/* Top 10 peores */}
        <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-[460px]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-base font-bold text-fg truncate">Top 10 peores productos</h4>
              <p className="text-sm text-fg-muted truncate">
                Menos vendidos (unidades) {catWorstId ? "· filtrado" : "· todas"}
              </p>
            </div>

            <SelectCategoria value={catWorstId} onChange={setCatWorstId} disabled={loadingCats} />
          </div>

          <div className={cn("mt-4 flex-1 min-h-0", loading && "opacity-60", "[&_.apexcharts-tooltip-marker]:!rounded-full")}>
            {worstLabels.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-fg-subtle">
                No hay datos para este rango/filtro.
              </div>
            ) : (
              <ReactApexChart
                type="bar"
                height={heightWorst}
                options={barOptions(worstLabels, "Unidades", "#f43f5e")}
                series={worstSeries as any}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}