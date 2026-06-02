import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

import { useToast } from "../toast";
import { cn } from "../ventaRapida/utils";

import {
  statsProductosListCategorias,
  statsProductosResumen,
  type StatsRange,
  type StatsCategoriaRow,
  type ProductosStatsResumen,
} from "./statsApis";

export default function ProductosStats({ range }: { range: StatsRange }) {
  const toast = useToast();

  const [loading, setLoading] = useState(false);
  const [loadingCats, setLoadingCats] = useState(false);

  const [categorias, setCategorias] = useState<StatsCategoriaRow[]>([]);

  const [catTopId, setCatTopId] = useState<number | null>(null);
  const [catWorstId, setCatWorstId] = useState<number | null>(null);

  const [resumen, setResumen] = useState<ProductosStatsResumen | null>(null);

  const cargarCategorias = useCallback(async () => {
    setLoadingCats(true);
    try {
      const rows = await statsProductosListCategorias();
      setCategorias(rows);
    } catch (e) {
      console.error(e);
      setCategorias([]);
      toast.error("Error", "No se pudieron cargar las categorías.");
    } finally {
      setLoadingCats(false);
    }
  }, [toast]);

  const cargarResumen = useCallback(async () => {
    setLoading(true);
    try {
      const data = await statsProductosResumen({
        range,
        categoriaTopId: catTopId,
        categoriaWorstId: catWorstId,
      });
      setResumen(data);
    } catch (e) {
      console.error(e);
      setResumen(null);
      toast.error("Error", "No se pudieron cargar las estadísticas de productos.");
    } finally {
      setLoading(false);
    }
  }, [range, catTopId, catWorstId, toast]);

  useEffect(() => {
    void cargarCategorias();
  }, [cargarCategorias]);

  useEffect(() => {
    void cargarResumen();
  }, [cargarResumen]);

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
    value: number | null;
    onChange: (v: number | null) => void;
    disabled?: boolean;
  }) => (
    <select
      className={cn(
        "rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold outline-none",
        "focus:ring-2 focus:ring-black/10",
        disabled && "opacity-60 cursor-not-allowed",
      )}
      disabled={disabled}
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : Number(v));
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
      <div className="bg-white rounded-xl border border-black/10 p-4 flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-negro">Productos</h3>
          <p className="text-sm text-negro/60">
            Mejores/peores productos y rankings por unidades vendidas (según rango).
          </p>
        </div>

        <div className="text-xs text-negro/50">
          {loading || loadingCats ? "Cargando…" : "Actualizado"}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-black/10 p-4">
          <p className="text-sm text-negro/60">Mejor producto</p>
          <p className="text-2xl font-extrabold text-negro mt-1 truncate">{bestName ?? "—"}</p>
          <p className="text-xs text-negro/50 mt-1">Producto con más unidades vendidas.</p>
        </div>

        <div className="bg-white rounded-xl border border-black/10 p-4">
          <p className="text-sm text-negro/60">Peor producto (vendible)</p>
          <p className="text-2xl font-extrabold text-negro mt-1 truncate">{worstName ?? "—"}</p>
          <p className="text-xs text-negro/50 mt-1">Producto vendible con menos unidades vendidas.</p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* Top 10 mejores */}
        <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-[460px]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-base font-bold text-negro truncate">Top 10 mejores productos</h4>
              <p className="text-sm text-negro/60 truncate">
                Más vendidos (unidades) {catTopId ? "· filtrado" : "· todas"}
              </p>
            </div>

            <SelectCategoria value={catTopId} onChange={setCatTopId} disabled={loadingCats} />
          </div>

          <div className={cn("mt-4 flex-1 min-h-0", loading && "opacity-60", "[&_.apexcharts-tooltip-marker]:!rounded-full")}>
            {topLabels.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-negro/50">
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
        <div className="bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-[460px]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-base font-bold text-negro truncate">Top 10 peores productos</h4>
              <p className="text-sm text-negro/60 truncate">
                Menos vendidos (unidades) {catWorstId ? "· filtrado" : "· todas"}
              </p>
            </div>

            <SelectCategoria value={catWorstId} onChange={setCatWorstId} disabled={loadingCats} />
          </div>

          <div className={cn("mt-4 flex-1 min-h-0", loading && "opacity-60", "[&_.apexcharts-tooltip-marker]:!rounded-full")}>
            {worstLabels.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-negro/50">
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