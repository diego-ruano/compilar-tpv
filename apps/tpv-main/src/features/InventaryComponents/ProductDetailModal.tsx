import React, { useEffect, useMemo, useState } from "react";
import { type ProductoDetalle, type LoteRow } from "./api/inventarioAPI";
import { fileUrlFromAppData } from "./utils/inventarioImages";
import AddLoteModal from "./ui/AddLoteModal";
import {
  useAjustarLote,
  useLotesByProducto,
  useProductoDetalle,
} from "./inventarioQueries";

type Props = {
  open: boolean;
  onClose: () => void;
  productId: number | null;
  onEdit?: (id: number) => void;
  onDeleted?: (id: number) => Promise<void> | void;
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

async function toImageUrlMaybe(ruta: string | null | undefined): Promise<string> {
  const r = String(ruta ?? "").trim();
  if (!r) return "";

  if (r.startsWith("http://") || r.startsWith("https://") || r.startsWith("asset://") || r.startsWith("tauri://")) {
    return r;
  }

  return await fileUrlFromAppData(r);
}

export default function ProductDetailModal({ open, onClose, productId, onEdit, onDeleted }: Props) {
  const [imgUrl, setImgUrl] = useState<string>("");

  const [alergOpen, setAlergOpen] = useState(false);
  const [alergImgUrl, setAlergImgUrl] = useState<Record<number, string>>({});

  // ✅ lotes
  const [lotesOpen, setLotesOpen] = useState(false);
  const [addLoteOpen, setAddLoteOpen] = useState(false);

  // ajustar stock lote
  const [ajustar, setAjustar] = useState<LoteRow | null>(null);
  const [nuevoStock, setNuevoStock] = useState("");
  const [ajustando, setAjustando] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Carga de detalle y lotes vía TanStack Query (sólo activa con el modal abierto).
  const activeId = open ? productId : null;
  const detalleQuery = useProductoDetalle(activeId);
  const lotesQuery = useLotesByProducto(activeId);
  const ajustarLote = useAjustarLote();

  const p: ProductoDetalle | null = detalleQuery.data ?? null;
  const lotes: LoteRow[] = lotesQuery.data ?? [];
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

    (async () => {
      const url = (p as any)?.Ruta_Imagen ? await toImageUrlMaybe((p as any).Ruta_Imagen) : "";

      const map: Record<number, string> = {};
      if ((p as any)?.alergs?.length) {
        await Promise.all(
          (p as any).alergs.map(async (a: any) => {
            const id = Number(a.ID_Alergeno);
            if (!Number.isFinite(id) || id <= 0) return;
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
        return (Number(a.ID_Lote) || 0) - (Number(b.ID_Lote) || 0);
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

  if (!open) return null;
  if (!productId) return null;

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-blanco w-full max-w-[820px] rounded-2xl shadow-xl border border-black/10 relative overflow-hidden max-h-[88vh] flex flex-col">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 w-10 h-10 rounded-2xl border border-negro/20 hover:bg-gris transition flex items-center justify-center"
        >
          ✕
        </button>

        <div className="px-6 pt-6 pb-4 border-b border-black/10">
          <h2 className="text-xl font-extrabold text-center">{title}</h2>
        </div>

        <div className="p-6 overflow-y-auto">
          {loading ? (
            <p className="text-center text-negro/70">Cargando...</p>
          ) : !p ? (
            <p className="text-center text-negro/70">No se encontró el producto.</p>
          ) : (
            <>
              <div className="flex gap-4 items-center">
                <div className="w-[84px] h-[84px] rounded-2xl border border-negro/10 bg-gris overflow-hidden flex items-center justify-center shrink-0">
                  {imgUrl ? (
                    <img src={imgUrl} alt={(p as any).Nombre} className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <span className="text-negro/40 text-xs font-semibold">IMG</span>
                  )}
                </div>

                <div className="min-w-0">
                  <p className="text-negro/50 font-extrabold text-sm uppercase">PRODUCTO</p>
                  <p className="text-2xl font-extrabold text-negro truncate">{(p as any).Nombre || "—"}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-5">
                <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                  <p className="text-sm font-semibold text-negro/60">Stock total</p>
                  <p className="text-xl font-extrabold text-negro">{String(stockTotal)}</p>
                </div>

                <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                  <p className="text-sm font-semibold text-negro/60">Mínimo</p>
                  <p className="text-xl font-extrabold text-negro">{numOrDash((p as any).Stock_Minimo)}</p>
                </div>

                <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                  <p className="text-sm font-semibold text-negro/60">Precio</p>
                  <p className="text-xl font-extrabold text-negro">
                    {(p as any).Precio_Venta == null ? "—" : String((p as any).Precio_Venta)}
                  </p>
                </div>

                <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                  <p className="text-sm font-semibold text-negro/60">Pedido esp.</p>
                  <p className="text-xl font-extrabold text-negro">
                    {(p as any).Cantidad_Pedido_Esperada == null ? "—" : String((p as any).Cantidad_Pedido_Esperada)}
                  </p>
                </div>

                <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                  <p className="text-sm font-semibold text-negro/60">FEFO (caducidad)</p>
                  <p className="text-xl font-extrabold text-negro">{formatDateES((fefo as any)?.Caducidad ?? null)}</p>
                  <p className="text-xs text-negro/60 mt-1">
                    Lote: {(fefo as any)?.Codigo_Lote ?? "—"}
                  </p>
                </div>

                <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                  <p className="text-sm font-semibold text-negro/60">Última entrada</p>
                  <p className="text-xl font-extrabold text-negro">{formatDateTimeES((ultimaEntrada as any)?.Fecha_Entrada ?? null)}</p>
                </div>
              </div>

              {/* Alérgenos */}
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setAlergOpen((v) => !v)}
                  className="w-full border border-negro/20 rounded-2xl py-3 font-extrabold hover:bg-gris transition flex items-center justify-between px-4"
                >
                  <span>Alérgenos</span>
                  <span className="text-negro/60 text-sm font-semibold">{(p as any).alergs?.length ? `${(p as any).alergs.length}` : "—"}</span>
                </button>

                <div className={["overflow-hidden transition-all duration-300", alergOpen ? "max-h-[420px] opacity-100 mt-3" : "max-h-0 opacity-0 mt-0"].join(" ")}>
                  <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                    {!(p as any).alergs?.length ? (
                      <p className="text-sm text-negro/60">Este producto no tiene alérgenos marcados.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {(p as any).alergs.map((a: any) => {
                          const id = Number(a.ID_Alergeno);
                          const url = alergImgUrl[id] ?? "";
                          return (
                            <div key={a.ID_Alergeno} className="flex items-center gap-2 px-3 py-2 rounded-2xl border border-negro/10 bg-blanco">
                              <div className="w-7 h-7 rounded-xl border border-negro/10 bg-gris overflow-hidden flex items-center justify-center">
                                {url ? (
                                  <img src={url} alt={a.Nombre} className="w-full h-full object-cover" draggable={false} />
                                ) : (
                                  <span className="text-[10px] text-negro/40 font-bold">IMG</span>
                                )}
                              </div>
                              <span className="text-sm font-extrabold text-negro">{a.Nombre}</span>
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
                  className="w-full border border-negro/20 rounded-2xl py-3 font-extrabold hover:bg-gris transition flex items-center justify-between px-4"
                >
                  <span>Lotes</span>
                  <span className="text-negro/60 text-sm font-semibold">{lotes?.length ? `${lotes.length}` : "—"}</span>
                </button>

                <div className={["overflow-hidden transition-all duration-300", lotesOpen ? "max-h-[560px] opacity-100 mt-3" : "max-h-0 opacity-0 mt-0"].join(" ")}>
                  <div className="rounded-2xl border border-negro/10 bg-gris/30 p-4">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <p className="text-sm font-semibold text-negro/70">
                        Gestiona entradas de almacén (FEFO sale de aquí)
                      </p>

                      <button
                        type="button"
                        onClick={() => setAddLoteOpen(true)}
                        className="px-4 py-2 rounded-xl bg-verde text-white font-extrabold hover:opacity-90 transition"
                      >
                        + Añadir lote
                      </button>
                    </div>

                    {!lotes?.length ? (
                      <p className="text-sm text-negro/60 text-center py-4">No hay lotes para este producto.</p>
                    ) : (
                      <div className="rounded-2xl border border-negro/10 bg-blanco overflow-hidden">
                        <div className="grid grid-cols-12 gap-2 px-4 py-3 bg-gris/40 text-xs font-extrabold text-negro/70">
                          <div className="col-span-4">Lote</div>
                          <div className="col-span-3">Caducidad</div>
                          <div className="col-span-2 text-right">Stock</div>
                          <div className="col-span-3">Entrada</div>
                        </div>

                        <div className="max-h-[320px] overflow-auto">
                          {lotes.map((l: any) => {
                            const isFefo = (fefo as any)?.ID_Lote === l.ID_Lote;
                            return (
                              <div key={l.ID_Lote} className={`grid grid-cols-12 gap-2 px-4 py-3 border-t border-negro/10 text-sm items-center ${isFefo ? "bg-verde/5" : ""}`}>
                                <div className="col-span-4 font-extrabold text-negro truncate">
                                  {l.Codigo_Lote}
                                  {isFefo && <span className="ml-2 text-xs font-extrabold text-verde">FEFO</span>}
                                </div>
                                <div className="col-span-3 text-negro/80">{formatDateES(l.Caducidad)}</div>
                                <div className="col-span-2 text-right font-extrabold">{String(l.Stock_Disponible ?? 0)}</div>
                                <div className="col-span-3 flex items-center justify-between gap-2">
                                  <span className="text-negro/70">{formatDateTimeES(l.Fecha_Entrada)}</span>
                                  <button
                                    type="button"
                                    className="px-3 py-1.5 rounded-xl border border-negro/20 hover:bg-gris transition text-xs font-extrabold"
                                    onClick={() => {
                                      setAjustar(l);
                                      setNuevoStock(String(l.Stock_Disponible ?? 0));
                                    }}
                                  >
                                    Ajustar
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Acciones */}
              <div className="grid grid-cols-2 gap-3 mt-5">
                <button
                  type="button"
                  onClick={() => onEdit?.((p as any).ID_Producto)}
                  className="w-full border border-negro/20 rounded-2xl py-3 font-extrabold hover:bg-gris transition"
                >
                  Editar
                </button>

                <button
                  type="button"
                  onClick={() => setAddLoteOpen(true)}
                  className="w-full border border-negro/20 rounded-2xl py-3 font-extrabold hover:bg-gris transition"
                >
                  Añadir lote
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="w-full border border-rojo text-rojo rounded-2xl py-3 font-extrabold hover:bg-rojo hover:text-white transition col-span-2"
                >
                  Eliminar producto
                </button>
              </div>

              {/* Modal añadir lote */}
              <AddLoteModal
                open={addLoteOpen}
                onClose={() => setAddLoteOpen(false)}
                productId={productId}
                onSaved={async () => {
                  // La mutación de creación de lote ya invalida la caché; refrescamos por si acaso.
                  await lotesQuery.refetch();
                }}
              />

              {/* Modal ajustar stock lote */}
              {ajustar && (
                <div
                  className="fixed inset-0 z-[90] bg-black/40 flex items-end sm:items-center justify-center p-3"
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget && !ajustando) setAjustar(null);
                  }}
                >
                  <div className="bg-blanco w-full max-w-[520px] rounded-2xl shadow-xl border border-black/10 overflow-hidden">
                    <div className="p-5 border-b border-black/10">
                      <h3 className="text-lg font-extrabold text-center">Ajustar stock del lote</h3>
                      <p className="text-center text-sm text-negro/60 mt-1">
                        {ajustar.Codigo_Lote}
                      </p>
                    </div>

                    <div className="p-5">
                      <label className="font-semibold">Nuevo stock disponible</label>
                      <input
                        type="number"
                        step="0.01"
                        value={nuevoStock}
                        onChange={(e) => setNuevoStock(e.target.value)}
                        className="border border-negro/20 rounded-xl px-3 py-2 w-full mt-2"
                        disabled={ajustando}
                      />

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-5">
                        <button
                          type="button"
                          onClick={() => setAjustar(null)}
                          disabled={ajustando}
                          className="w-full px-4 py-2 rounded-xl border border-negro/20 hover:bg-gris transition font-semibold disabled:opacity-60"
                        >
                          Cancelar
                        </button>

                        <button
                          type="button"
                          disabled={ajustando}
                          onClick={async () => {
                            const n = Number(String(nuevoStock).replace(",", "."));
                            if (!Number.isFinite(n) || n < 0) return;

                            setAjustando(true);
                            try {
                              // La invalidación de onSuccess recachea los lotes automáticamente.
                              await ajustarLote.mutateAsync({
                                id_lote: (ajustar as any).ID_Lote,
                                stock_disponible: n,
                                notas: null,
                              });

                              setAjustar(null);
                            } finally {
                              setAjustando(false);
                            }
                          }}
                          className="w-full px-4 py-2 rounded-xl font-extrabold transition disabled:opacity-60 bg-verde text-white hover:opacity-90"
                        >
                          {ajustando ? "Guardando..." : "Guardar"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
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
            <div className="bg-blanco w-full max-w-[520px] rounded-2xl shadow-xl border border-black/10 overflow-hidden">
              <div className="p-5 border-b border-black/10">
                <h3 className="text-lg font-extrabold text-center">Confirmar</h3>
              </div>

              <div className="p-5">
                <p className="text-negro/80 text-center">¿Seguro que quieres eliminar este producto?</p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="w-full px-4 py-2 rounded-xl border border-negro/20 hover:bg-gris transition font-semibold disabled:opacity-60"
                  >
                    Cancelar
                  </button>

                  <button
                    type="button"
                    disabled={deleting}
                    onClick={async () => {
                      if (!p) return;
                      setDeleting(true);
                      try {
                        await onDeleted?.((p as any).ID_Producto);
                        setConfirmDelete(false);
                        onClose();
                      } finally {
                        setDeleting(false);
                      }
                    }}
                    className="w-full px-4 py-2 rounded-xl font-extrabold transition disabled:opacity-60 border border-rojo text-white bg-rojo hover:opacity-90"
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
