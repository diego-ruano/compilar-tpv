import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Plus,
  Pencil,
  Trash2,
  Boxes,
  TriangleAlert,
  Tag,
  ShoppingCart,
  CalendarClock,
  Clock,
  ChevronDown,
  ShieldAlert,
  Layers,
  ImageOff,
} from "lucide-react";
import type { LoteDto, ProductoDetalleDto } from "@tpv/contracts";

import { eur } from "../../shared/lib/dinero";
import { resolveImageUrl } from "../../shared/lib/imageUrl";
import ImageWithFallback from "../../shared/ui/ImageWithFallback";
import AddLoteModal from "./ui/AddLoteModal";
import {
  useLotesByProducto,
  useProductoDetalle,
} from "./inventarioQueries";
import { conAviso } from "../../shared/lib/conAviso";

type Props = {
  open: boolean;
  onClose: () => void;
  productId: string | null;
  onEdit?: (id: string) => void;
  onDeleted?: (id: string) => Promise<void> | void;
};

function formatDateES(yyyyMmDd: string | null | undefined) {
  if (!yyyyMmDd) return "—";
  const onlyDate = String(yyyyMmDd).split(" ")[0]; // por si viene datetime
  const [y, m, d] = onlyDate.split("-");
  if (!y || !m || !d) return yyyyMmDd;
  return `${d}/${m}/${y}`;
}

function formatDateTimeES(v: string | null | undefined) {
  if (!v) return "—";
  const s = String(v);
  const [date, time] = s.split(" ");
  const t = time ? time.slice(0, 5) : "";
  const d = formatDateES(date);
  return t ? `${d} ${t}` : d;
}

function numOrDash(v: number | null | undefined) {
  return v == null ? "—" : String(v);
}

function parseSqliteDateTime(s: string) {
  // "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS"
  const x = String(s || "").trim();
  if (!x) return NaN;
  const iso = x.includes(" ") ? x.replace(" ", "T") : x;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

const toImageUrlMaybe = resolveImageUrl;

export default function ProductDetailModal({ open, onClose, productId, onEdit, onDeleted }: Props) {
  const [imgUrl, setImgUrl] = useState<string>("");

  const [alergOpen, setAlergOpen] = useState(false);
  const [alergImgUrl, setAlergImgUrl] = useState<Record<string, string>>({});

  // ✅ lotes
  const [lotesOpen, setLotesOpen] = useState(false);
  const [addLoteOpen, setAddLoteOpen] = useState(false);
  const [editingLote, setEditingLote] = useState<LoteDto | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Carga de detalle y lotes vía TanStack Query (sólo activa con el modal abierto).
  const activeId = open ? productId : null;
  const detalleQuery = useProductoDetalle(activeId);
  const lotesQuery = useLotesByProducto(activeId);

  const p: ProductoDetalleDto | null = detalleQuery.data ?? null;
  const lotes: LoteDto[] = lotesQuery.data ?? [];
  const loading = detalleQuery.isFetching || lotesQuery.isFetching;

  // Resuelve URLs de imagen (producto + alérgenos) cuando llega el detalle cacheado.
  useEffect(() => {
    let cancelled = false;

    if (!open || !productId || !p) {
      setImgUrl("");
      setAlergImgUrl({});
      setAlergOpen(false);
      return;
    }

    void (async () => {
      const url = p?.Ruta_Imagen ? await toImageUrlMaybe(p.Ruta_Imagen) : "";

      const map: Record<string, string> = {};
      if (p?.alergs?.length) {
        await Promise.all(
          p.alergs.map(async (a) => {
            const id = String(a.ID_Alergeno ?? "").trim();
            if (!id) return;
            const u = await toImageUrlMaybe(a.Ruta_Imagen);
            if (u) map[id] = u;
          }),
        );
      }

      if (cancelled) return;
      setImgUrl(url);
      setAlergImgUrl(map);
      setAlergOpen(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, productId, p]);

  // Muestra el toast/limpieza cuando falla la carga (paridad con el catch anterior).
  useEffect(() => {
    if (detalleQuery.isError || lotesQuery.isError) {
      console.error(
        "Error cargando detalle producto:",
        detalleQuery.error ?? lotesQuery.error,
      );
      setImgUrl("");
      setAlergOpen(false);
      setAlergImgUrl({});
    }
  }, [detalleQuery.isError, lotesQuery.isError, detalleQuery.error, lotesQuery.error]);

  const title = useMemo(() => "Acciones del producto", []);

  const stockTotal = useMemo(() => {
    return (lotes ?? []).reduce((acc, l: any) => acc + (Number(l.Stock_Disponible) || 0), 0);
  }, [lotes]);

  const fefo = useMemo(() => {
    const arr = (lotes ?? [])
      .filter((l: any) => (Number(l.Stock_Disponible) || 0) > 0 && l.Caducidad)
      .slice()
      .sort((a: any, b: any) => {
        const da = Date.parse(String(a.Caducidad));
        const db = Date.parse(String(b.Caducidad));
        if (da !== db) return da - db;
        const ea = parseSqliteDateTime(String(a.Fecha_Entrada || ""));
        const eb = parseSqliteDateTime(String(b.Fecha_Entrada || ""));
        if (ea !== eb && Number.isFinite(ea) && Number.isFinite(eb)) return ea - eb;
        return String(a.ID_Lote ?? "").localeCompare(String(b.ID_Lote ?? ""));
      });
    return arr[0] ?? null;
  }, [lotes]);

  const ultimaEntrada = useMemo(() => {
    const arr = (lotes ?? []).slice().sort((a: any, b: any) => {
      const ta = parseSqliteDateTime(String(a.Fecha_Entrada || ""));
      const tb = parseSqliteDateTime(String(b.Fecha_Entrada || ""));
      if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return tb - ta;
    });
    return arr[0] ?? null;
  }, [lotes]);

  const minimo = Number(p?.Stock_Minimo);
  const bajoStock = Number.isFinite(minimo) && minimo > 0 && stockTotal <= minimo;

  if (!open) return null;
  if (!productId) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-2 sm:p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-[calc(100dvh-1rem)] w-full max-w-[820px] flex-col overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-xl sm:max-h-[calc(100dvh-1.5rem)]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-xl border border-border text-fg-muted hover:bg-surface-2 hover:text-fg transition cursor-pointer"
        >
          <X className="size-4" aria-hidden />
        </button>

        <div className="shrink-0 border-b border-border px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6">
          <h2 className="text-center text-lg font-extrabold text-fg sm:text-xl">{title}</h2>
        </div>

        <div className="min-h-0 overflow-y-auto p-3 sm:p-6">
          {loading ? (
            <p className="text-center text-fg-muted">Cargando...</p>
          ) : !p ? (
            <p className="text-center text-fg-muted">No se encontró el producto.</p>
          ) : (
            <>
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface-2 sm:size-20">
                  <ImageWithFallback
                    src={imgUrl}
                    alt={p.Nombre}
                    className="h-full w-full object-cover"
                    fallback={
                      <div className="flex h-full w-full items-center justify-center">
                        <ImageOff className="size-7 text-fg-subtle" aria-hidden />
                      </div>
                    }
                  />
                </div>

                <div className="min-w-0">
                  <p className="text-xs font-extrabold uppercase tracking-wide text-fg-subtle">Producto</p>
                  <p className="truncate text-xl font-extrabold text-fg sm:text-2xl">{p.Nombre || "—"}</p>

                  <span
                    className={
                      "mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold " +
                      (bajoStock
                        ? "border border-danger/30 bg-danger-soft text-danger"
                        : "border border-success/30 bg-success-soft text-success")
                    }
                  >
                    {bajoStock ? (
                      <>
                        <TriangleAlert className="size-3.5" aria-hidden />
                        Stock bajo · {String(stockTotal)}
                      </>
                    ) : (
                      <>
                        <Boxes className="size-3.5" aria-hidden />
                        En stock · {String(stockTotal)}
                      </>
                    )}
                  </span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-5 sm:grid-cols-3 sm:gap-3">
                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
                    <Boxes className="size-4 text-accent" aria-hidden />
                    Stock total
                  </p>
                  <p className="mt-1 text-xl font-extrabold text-fg">{String(stockTotal)}</p>
                </div>

                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
                    <TriangleAlert className="size-4 text-accent" aria-hidden />
                    Mínimo
                  </p>
                  <p className="mt-1 text-xl font-extrabold text-fg">{numOrDash(p.Stock_Minimo)}</p>
                </div>

                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
                    <Tag className="size-4 text-accent" aria-hidden />
                    Precio
                  </p>
                  <p className="mt-1 text-xl font-extrabold text-fg">
                    {p.Precio_Venta == null ? "—" : eur(p.Precio_Venta)}
                  </p>
                </div>

                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
                    <ShoppingCart className="size-4 text-accent" aria-hidden />
                    Pedido esp.
                  </p>
                  <p className="mt-1 text-xl font-extrabold text-fg">
                    {p.Cantidad_Pedido_Esperada == null ? "—" : String(p.Cantidad_Pedido_Esperada)}
                  </p>
                </div>

                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
                    <CalendarClock className="size-4 text-accent" aria-hidden />
                    FEFO (caducidad)
                  </p>
                  <p className="mt-1 text-xl font-extrabold text-fg">{formatDateES(fefo?.Caducidad ?? null)}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    Lote: {fefo?.Codigo_Lote ?? "—"}
                  </p>
                </div>

                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted">
                    <Clock className="size-4 text-accent" aria-hidden />
                    Última entrada
                  </p>
                  <p className="mt-1 text-xl font-extrabold text-fg">{formatDateTimeES(ultimaEntrada?.Fecha_Entrada ?? null)}</p>
                </div>
              </div>

              {/* Alérgenos */}
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setAlergOpen((v) => !v)}
                  className="flex w-full cursor-pointer items-center justify-between rounded-2xl border border-border px-4 py-3 font-extrabold text-fg transition hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2">
                    <ShieldAlert className="size-5 text-accent" aria-hidden />
                    Alérgenos
                  </span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-fg-muted">
                    {p.alergs?.length ? `${p.alergs.length}` : "—"}
                    <ChevronDown
                      className={"size-4 transition-transform " + (alergOpen ? "rotate-180" : "")}
                      aria-hidden
                    />
                  </span>
                </button>

                <div className={["overflow-hidden transition-all duration-300", alergOpen ? "max-h-[420px] opacity-100 mt-3" : "max-h-0 opacity-0 mt-0"].join(" ")}>
                  <div className="rounded-2xl border border-border bg-surface-2 p-4">
                    {!p.alergs?.length ? (
                      <p className="text-sm text-fg-muted">Este producto no tiene alérgenos marcados.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {p.alergs.map((a) => {
                          const id = String(a.ID_Alergeno ?? "").trim();
                          const url = alergImgUrl[id] ?? "";
                          return (
                            <div key={a.ID_Alergeno} className="flex items-center gap-2 px-3 py-2 rounded-2xl border border-border bg-surface">
                              <div className="w-7 h-7 rounded-xl border border-border bg-surface-2 overflow-hidden flex items-center justify-center">
                                {url ? (
                                  <img src={url} alt={a.Nombre} className="w-full h-full object-cover" draggable={false} />
                                ) : (
                                  <span className="text-[10px] text-fg-subtle font-bold">IMG</span>
                                )}
                              </div>
                              <span className="text-sm font-extrabold text-fg">{a.Nombre}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ✅ Lotes */}
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setLotesOpen((v) => !v)}
                  className="flex w-full cursor-pointer items-center justify-between rounded-2xl border border-border px-4 py-3 font-extrabold text-fg transition hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2">
                    <Layers className="size-5 text-accent" aria-hidden />
                    Lotes
                  </span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-fg-muted">
                    {lotes?.length ? `${lotes.length}` : "—"}
                    <ChevronDown
                      className={"size-4 transition-transform " + (lotesOpen ? "rotate-180" : "")}
                      aria-hidden
                    />
                  </span>
                </button>

                <div className={["overflow-hidden transition-all duration-300", lotesOpen ? "max-h-[560px] opacity-100 mt-3" : "max-h-0 opacity-0 mt-0"].join(" ")}>
                  <div className="rounded-2xl border border-border bg-surface-2 p-4">
                    <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm font-semibold text-fg-muted">
                        Gestiona entradas de almacén (FEFO sale de aquí)
                      </p>

                      <button
                        type="button"
                        onClick={() => {
                          setEditingLote(null);
                          setAddLoteOpen(true);
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 font-extrabold text-accent-fg shadow-sm transition hover:bg-accent-hover cursor-pointer"
                      >
                        <Plus className="size-4" aria-hidden />
                        Añadir lote
                      </button>
                    </div>

                    {!lotes?.length ? (
                      <p className="text-sm text-fg-muted text-center py-4">No hay lotes para este producto.</p>
                    ) : (
                      <div className="overflow-x-auto rounded-2xl border border-border bg-surface [scrollbar-gutter:stable]">
                       <div className="min-w-[680px]">
                        <div className="grid grid-cols-12 gap-2 bg-surface-2 px-4 py-3 text-xs font-extrabold text-fg-muted">
                          <div className="col-span-3">Lote</div>
                          <div className="col-span-2">Caducidad</div>
                          <div className="col-span-1 text-right">Cantidad</div>
                          <div className="col-span-4 pl-6">Entrada</div>
                          <div className="col-span-2 text-right">Acciones</div>
                        </div>

                        <div className="max-h-[320px] overflow-auto">
                          {lotes.map((l: any) => {
                            const isFefo = fefo?.ID_Lote === l.ID_Lote;
                            return (
                              <div key={l.ID_Lote} className={`grid grid-cols-12 gap-2 px-4 py-3 border-t border-border text-sm items-center ${isFefo ? "bg-accent-soft" : ""}`}>
                                <div className="col-span-3 font-extrabold text-fg truncate">
                                  {l.Codigo_Lote}
                                  {isFefo && <span className="ml-2 text-xs font-extrabold text-accent">FEFO</span>}
                                </div>
                                <div className="col-span-2 text-fg-muted">{formatDateES(l.Caducidad)}</div>
                                <div className="col-span-1 text-right font-extrabold">{String(l.Stock_Disponible ?? 0)}</div>
                                <div className="col-span-4 pl-6 text-fg-muted">{formatDateTimeES(l.Fecha_Entrada)}</div>
                                <div className="col-span-2 flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    className="px-3 py-1.5 rounded-xl border border-border hover:bg-surface-2 transition text-xs font-extrabold"
                                    onClick={() => {
                                      setEditingLote(l);
                                      setAddLoteOpen(true);
                                    }}
                                  >
                                    Editar
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                       </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Acciones */}
              <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
                <button
                  type="button"
                  onClick={() => onEdit?.(p.ID_Producto)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3 font-extrabold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
                >
                  <Pencil className="size-4" aria-hidden />
                  Editar
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setEditingLote(null);
                    setAddLoteOpen(true);
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-surface py-3 font-extrabold text-fg transition hover:bg-surface-2 cursor-pointer"
                >
                  <Plus className="size-4" aria-hidden />
                  Añadir lote
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-danger/30 bg-danger-soft py-3 font-extrabold text-danger transition hover:opacity-90 cursor-pointer sm:col-span-2"
                >
                  <Trash2 className="size-4" aria-hidden />
                  Eliminar producto
                </button>
              </div>

              {/* Modal añadir lote */}
              <AddLoteModal
                open={addLoteOpen}
                onClose={() => {
                  setAddLoteOpen(false);
                  setEditingLote(null);
                }}
                productId={productId}
                loteToEdit={editingLote}
                onSaved={conAviso(async () => {
                  // La mutación de creación de lote ya invalida la caché; refrescamos por si acaso.
                  await lotesQuery.refetch();
                })}
              />

            </>
          )}
        </div>

        {/* Confirm delete */}
        {confirmDelete && (
          <div
            className="absolute inset-0 bg-black/40 flex items-end sm:items-center justify-center p-3"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setConfirmDelete(false);
            }}
          >
            <div className="bg-surface w-full max-w-[520px] rounded-2xl shadow-xl border border-border overflow-hidden">
              <div className="p-5 border-b border-border">
                <h3 className="text-lg font-extrabold text-center">Confirmar</h3>
              </div>

              <div className="p-5">
                <p className="text-fg-muted text-center">¿Seguro que quieres eliminar este producto?</p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="w-full px-4 py-2 rounded-xl border border-border hover:bg-surface-2 transition font-semibold disabled:opacity-60"
                  >
                    Cancelar
                  </button>

                  <button
                    type="button"
                    disabled={deleting}
                    onClick={conAviso(async () => {
                      if (!p) return;
                      setDeleting(true);
                      try {
                        await onDeleted?.(p.ID_Producto);
                        setConfirmDelete(false);
                        onClose();
                      } finally {
                        setDeleting(false);
                      }
                    })}
                    className="w-full cursor-pointer rounded-xl bg-danger px-4 py-2 font-extrabold text-danger-fg shadow-sm transition hover:opacity-90 disabled:opacity-60"
                  >
                    {deleting ? "Eliminando..." : "Eliminar"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
