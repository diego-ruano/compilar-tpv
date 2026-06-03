// src/pages/VentaRapida.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAuth } from "../shared/stores/useAuth";
import { useToast } from "../shared/toast";

import AddProductModal from "../features/ventaRapida/ui/AddProductModal";
import CatalogGrid from "../features/ventaRapida/ui/CatalogGrid";
import CashPanel from "../features/ventaRapida/ui/CashPanel";
import TicketPanel from "../features/ventaRapida/ui/TicketPanel";
import VerTicketsModal from "../features/ventaRapida/ui/VerTicketsModal";

import ProductDetailModal from "../features/InventaryComponents/ProductDetailModal";

import {
  Categoria,
  CategoriaDisplay,
  Producto,
  ProductoDisplay,
  Paso,
  TicketItem,
  DENOMS,
} from "../features/ventaRapida/types";
import { cn, eur } from "../features/ventaRapida/utils";

import {
  vrBootstrap,
  vrListCategoriasVendibles,
  vrListProductosByCategoria,
  vrSearchProductos,
  vrGetOrCreateComandaBarra,
  vrCreateComandaBarra,
  vrListComandasBarra,
  vrGetLineasComanda,
  vrAddLineaComanda,
  vrRemoveLastUnpaidLinea,
  vrDeleteLineaIfUnpaid,
  vrUpdateNotaDetalle,
  vrCobrarFraccionado,
  vrDeleteComandaIfSafe,
  type ComandaBarraRow as ApiComandaBarraRow,
  type LineaComandaRow as ApiLineaComandaRow,
} from "../features/ventaRapida/ventaRapidaAPI";

/* =========================
   EVENTO GLOBAL
========================= */
const emitVrChanged = () => {
  window.dispatchEvent(new CustomEvent("vr:changed"));
};

type ComandaBarraRow = ApiComandaBarraRow;
type LineaComandaRow = ApiLineaComandaRow;

type LoadTicketOpts = {
  keepSelection?: boolean;
  silentError?: boolean;
};

type PendingCobroIntent = {
  id: string;
  idComanda: number;
  metodo: "tarjeta" | "efectivo";
  ticketItemIds: string[];
  detalleIds: number[];
  importeTotal: number;
  idUsuarioCobrador: number | null;
  idTrabajadorCobrador: number | null;
  opIdCobro: string;
  createdAtMs: number;
};

const PENDING_COBROS_STORAGE_PREFIX = "tpv:ventaRapida:pendingCobros:v1";

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.rows)) return obj.rows as T[];
    if (Array.isArray(obj.result)) return obj.result as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.lineas)) return obj.lineas as T[];
    if (Array.isArray(obj.comandas)) return obj.comandas as T[];
    if (Array.isArray(obj.categorias)) return obj.categorias as T[];
    if (Array.isArray(obj.productos)) return obj.productos as T[];
  }

  return [];
}

function makeTempTicketId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `tmp-${crypto.randomUUID()}`;
  }

  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeDetalleTicketId(idDetalle: number): string {
  return `detalle-${Number(idDetalle)}`;
}

function parseDetalleIdFromTicketItemId(ticketItemId: string): number {
  const raw = String(ticketItemId || "").trim();
  if (!raw.startsWith("detalle-")) return 0;

  const id = Number(raw.slice("detalle-".length));
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function makeStableCobroOpId(intentId: string): string {
  return `vr_cobrar_fraccionado_${String(intentId || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120)}`;
}

function sanitizePendingCobroIntent(value: unknown): PendingCobroIntent | null {
  if (!value || typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const id = String(obj.id ?? "").trim();
  const idComanda = Number(obj.idComanda ?? obj.id_comanda ?? 0);
  const metodoRaw = String(obj.metodo ?? "").trim().toLowerCase();
  const ticketItemIds = Array.isArray(obj.ticketItemIds)
    ? obj.ticketItemIds.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const detalleIds = Array.isArray(obj.detalleIds)
    ? obj.detalleIds.map((x) => Number(x || 0)).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  const importeTotal = Number(obj.importeTotal ?? 0);
  const createdAtMs = Number(obj.createdAtMs ?? Date.now());
  const opIdCobro = String(obj.opIdCobro ?? obj.op_id_cobro ?? "").trim() || makeStableCobroOpId(id);

  if (!id) return null;
  if (!Number.isFinite(idComanda) || idComanda <= 0) return null;
  if (metodoRaw !== "tarjeta" && metodoRaw !== "efectivo") return null;
  if (ticketItemIds.length === 0) return null;
  if (!Number.isFinite(importeTotal) || importeTotal <= 0) return null;

  return {
    id,
    idComanda,
    metodo: metodoRaw,
    ticketItemIds,
    detalleIds,
    importeTotal,
    idUsuarioCobrador:
      Number(obj.idUsuarioCobrador ?? 0) > 0 ? Number(obj.idUsuarioCobrador) : null,
    idTrabajadorCobrador:
      Number(obj.idTrabajadorCobrador ?? 0) > 0 ? Number(obj.idTrabajadorCobrador) : null,
    opIdCobro,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Date.now(),
  };
}

function loadPendingCobrosFromStorage(storageKey: string): PendingCobroIntent[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];

    return arr
      .map(sanitizePendingCobroIntent)
      .filter(Boolean) as PendingCobroIntent[];
  } catch {
    return [];
  }
}

function savePendingCobrosToStorage(storageKey: string, cobros: PendingCobroIntent[]): void {
  try {
    if (cobros.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(cobros));
  } catch (e) {
    console.error("No se pudieron persistir los cobros pendientes:", e);
  }
}

export default function VentaRapida() {
  const [categorias, setCategorias] = useState<CategoriaDisplay[]>([]);
  const [categoriaSeleccionada, setCategoriaSeleccionada] =
    useState<CategoriaDisplay | null>(null);

  const toast = useToast();

  const idTrabajadorAuth = useAuth((s) => s.idTrabajador);
  const idUsuarioAuth = useAuth((s) => s.idUsuario);

  const pendingCobrosStorageKey = useMemo(
    () =>
      `${PENDING_COBROS_STORAGE_PREFIX}:${idUsuarioAuth ?? "anon"}:${idTrabajadorAuth ?? "none"}`,
    [idUsuarioAuth, idTrabajadorAuth],
  );

  const [productos, setProductos] = useState<ProductoDisplay[]>([]);
  const [loadingProductos, setLoadingProductos] = useState(false);

  const [query, setQuery] = useState("");
  const q = query.trim();

  const [busqueda, setBusqueda] = useState<ProductoDisplay[]>([]);
  const [loadingBusqueda, setLoadingBusqueda] = useState(false);

  const [ticket, setTicket] = useState<TicketItem[]>([]);
  const ticketRef = useRef<TicketItem[]>([]);

  const [paso, setPaso] = useState<Paso>("categorias");
  const [cashCount, setCashCount] = useState<Record<string, number>>({});
  const [openAddProduct, setOpenAddProduct] = useState(false);

  const [openProductDetail, setOpenProductDetail] = useState(false);
  const [productDetailId, setProductDetailId] = useState<number | null>(null);

  const [seleccionados, setSeleccionados] = useState<Set<string>>(() => new Set());
  const seleccionadosRef = useRef<Set<string>>(new Set());

  const [openVerTickets, setOpenVerTickets] = useState(false);
  const [comandasBarra, setComandasBarra] = useState<ComandaBarraRow[]>([]);
  const [loadingComandas, setLoadingComandas] = useState(false);

  const [idComandaActiva, setIdComandaActiva] = useState<number | null>(null);
  const idComandaActivaRef = useRef<number | null>(null);
  const ensureComandaPromiseRef = useRef<Promise<number> | null>(null);

  const didInitRef = useRef(false);

  const [detalleIdByTicketId, setDetalleIdByTicketId] = useState<Record<string, number>>({});
  const detalleIdByTicketIdRef = useRef<Record<string, number>>({});

  const pendingTicketWritesRef = useRef(0);
  const cancelledAddTempIdsRef = useRef<Set<string>>(new Set());

  const pendingCobrosRef = useRef<PendingCobroIntent[]>([]);
  const runningCobrosRef = useRef<Set<string>>(new Set());
  const cobroFlushTimerRef = useRef<number | null>(null);

  const syncTimerRef = useRef<number | null>(null);
  const syncRunIdRef = useRef(0);

  const setPendingCobrosLocal = useCallback(
    (next: PendingCobroIntent[] | ((prev: PendingCobroIntent[]) => PendingCobroIntent[])) => {
      const nextValue =
        typeof next === "function" ? (next as (prev: PendingCobroIntent[]) => PendingCobroIntent[])(pendingCobrosRef.current) : next;

      pendingCobrosRef.current = nextValue;
      savePendingCobrosToStorage(pendingCobrosStorageKey, nextValue);
    },
    [pendingCobrosStorageKey],
  );

  const beginTicketWrite = useCallback(() => {
    pendingTicketWritesRef.current += 1;
  }, []);

  const endTicketWrite = useCallback(() => {
    pendingTicketWritesRef.current = Math.max(0, pendingTicketWritesRef.current - 1);
  }, []);

  const hasPendingTicketWrites = useCallback(() => {
    return pendingTicketWritesRef.current > 0;
  }, []);

  const warnPendingTicketWrites = useCallback(() => {
    toast.info(
      "Espera un momento",
      "Hay productos terminando de añadirse o quitarse antes de cambiar de ticket.",
    );
  }, [toast]);

  const resolveDetallesForCobroIntent = useCallback((intent: PendingCobroIntent): number[] | null => {
    const detalleMap = detalleIdByTicketIdRef.current;

    const detalles = intent.ticketItemIds.map((ticketItemId, idx) => {
      const fromMap = Number(detalleMap[ticketItemId] || 0);
      if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;

      const fromStored = Number(intent.detalleIds?.[idx] || 0);
      if (Number.isFinite(fromStored) && fromStored > 0) return fromStored;

      return parseDetalleIdFromTicketItemId(ticketItemId);
    });

    if (detalles.length !== intent.ticketItemIds.length) return null;
    if (detalles.some((n) => !Number.isFinite(n) || n <= 0)) return null;

    return detalles;
  }, []);

  const setSeleccionadosLocal = useCallback(
    (nextValue: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setSeleccionados((prev) => {
        const next =
          typeof nextValue === "function"
            ? (nextValue as (prev: Set<string>) => Set<string>)(prev)
            : nextValue;

        seleccionadosRef.current = next;
        return next;
      });
    },
    [],
  );

  const addTicketItemLocal = useCallback((item: TicketItem) => {
    setTicket((prev) => {
      const next = [...prev, item];
      ticketRef.current = next;
      return next;
    });

    setDetalleIdByTicketId((prev) => {
      const next = {
        ...prev,
        [item.id]: Number(item.detalleId || 0),
      };

      detalleIdByTicketIdRef.current = next;
      return next;
    });
  }, []);

  const removeTicketItemLocal = useCallback(
    (ticketItemId: string) => {
      setTicket((prev) => {
        const next = prev.filter((t) => t.id !== ticketItemId);
        ticketRef.current = next;
        return next;
      });

      setDetalleIdByTicketId((prev) => {
        const next = { ...prev };
        delete next[ticketItemId];

        detalleIdByTicketIdRef.current = next;
        return next;
      });

      setSeleccionadosLocal((prev) => {
        const next = new Set(prev);
        next.delete(ticketItemId);
        return next;
      });
    },
    [setSeleccionadosLocal],
  );

  const restoreTicketItemLocal = useCallback((item: TicketItem) => {
    setTicket((prev) => {
      if (prev.some((t) => t.id === item.id)) {
        ticketRef.current = prev;
        return prev;
      }

      const next = [...prev, item];
      ticketRef.current = next;
      return next;
    });

    setDetalleIdByTicketId((prev) => {
      const next = {
        ...prev,
        [item.id]: Number(item.detalleId || 0),
      };

      detalleIdByTicketIdRef.current = next;
      return next;
    });
  }, []);

  const clearTicketLocal = useCallback(() => {
    ticketRef.current = [];
    detalleIdByTicketIdRef.current = {};
    setPendingCobrosLocal([]);
    runningCobrosRef.current.clear();

    if (cobroFlushTimerRef.current !== null) {
      window.clearTimeout(cobroFlushTimerRef.current);
      cobroFlushTimerRef.current = null;
    }

    setTicket([]);
    setDetalleIdByTicketId({});
    setSeleccionadosLocal(new Set());
  }, [setPendingCobrosLocal, setSeleccionadosLocal]);

  const applyLineasToTicketPanel = useCallback(
    (lineasInput: unknown, opts?: LoadTicketOpts): TicketItem[] => {
      const lineas = asArray<LineaComandaRow>(lineasInput);
      const map: Record<string, number> = {};

      const ui: TicketItem[] = lineas.map((l) => {
        const idDetalle = Number(l.ID_Detalle || 0);
        const id = makeDetalleTicketId(idDetalle);

        map[id] = idDetalle;

        return {
          id,
          detalleId: idDetalle,
          productoId: Number(l.ID_Producto),
          nombre: String((l as any).Nombre ?? "Producto"),
          precio: Number(l.Precio_Unitario || 0) * Number(l.Cantidad || 1),
          pagado: Number((l as any).Pagado ?? 0) === 1,
          seleccionado: false,
          notas: l.Notas ?? null,
        };
      });

      const selectableIds = new Set(ui.filter((t) => !t.pagado).map((t) => t.id));

      ticketRef.current = ui;
      detalleIdByTicketIdRef.current = map;

      setDetalleIdByTicketId(map);
      setTicket(ui);

      if (opts?.keepSelection) {
        setSeleccionadosLocal((prev) => {
          const next = new Set<string>();

          for (const id of prev) {
            if (selectableIds.has(id)) {
              next.add(id);
            }
          }

          return next;
        });
      } else {
        setSeleccionadosLocal(new Set());
      }

      return ui;
    },
    [setSeleccionadosLocal],
  );

  const replaceTicketItemLocal = useCallback(
    (oldId: string, nextItem: TicketItem) => {
      const currentItem = ticketRef.current.find((t) => t.id === oldId);

      const mergedItem: TicketItem = currentItem
        ? {
          ...nextItem,
          pagado: currentItem.pagado,
          seleccionado: false,
          notas: currentItem.notas ?? nextItem.notas ?? null,
        }
        : nextItem;

      const idDetalle = Number(mergedItem.detalleId || 0);

      const nextDetalleMap = {
        ...detalleIdByTicketIdRef.current,
        [oldId]: idDetalle,
        [mergedItem.id]: idDetalle,
      };

      detalleIdByTicketIdRef.current = nextDetalleMap;
      setDetalleIdByTicketId(nextDetalleMap);

      if (oldId !== mergedItem.id && pendingCobrosRef.current.some((intent) => intent.ticketItemIds.includes(oldId))) {
        setPendingCobrosLocal((prev) =>
          prev.map((intent) => {
            if (!intent.ticketItemIds.includes(oldId)) return intent;

            const ticketItemIds = intent.ticketItemIds.map((id) => (id === oldId ? mergedItem.id : id));
            const detalleIds = ticketItemIds.map((id, idx) => {
              const mapped = Number(nextDetalleMap[id] || 0);
              if (Number.isFinite(mapped) && mapped > 0) return mapped;

              const stored = Number(intent.detalleIds?.[idx] || 0);
              if (Number.isFinite(stored) && stored > 0) return stored;

              return parseDetalleIdFromTicketItemId(id);
            });

            return {
              ...intent,
              ticketItemIds,
              detalleIds,
            };
          }),
        );
      }

      setTicket((prev) => {
        const next = prev.map((t) => (t.id === oldId ? mergedItem : t));
        ticketRef.current = next;
        return next;
      });

      setSeleccionadosLocal((prev) => {
        if (!prev.has(oldId)) return prev;

        const next = new Set(prev);
        next.delete(oldId);

        if (!mergedItem.pagado) {
          next.add(mergedItem.id);
        }

        return next;
      });
    },
    [setPendingCobrosLocal, setSeleccionadosLocal],
  );

  useEffect(() => {
    return () => {
      syncRunIdRef.current += 1;

      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }

      if (cobroFlushTimerRef.current !== null) {
        window.clearTimeout(cobroFlushTimerRef.current);
        cobroFlushTimerRef.current = null;
      }
    };
  }, []);

  const abrirDetalleProducto = useCallback((productId: number) => {
    setProductDetailId(Number(productId));
    setOpenProductDetail(true);
  }, []);

  const cerrarDetalleProducto = useCallback(() => {
    setOpenProductDetail(false);
    setProductDetailId(null);
  }, []);

  const cargarCategorias = useCallback(async () => {
    try {
      const baseDir = await appDataDir();
      const raw = await vrListCategoriasVendibles();
      const rows = asArray<Categoria>(raw);

      const procesadas: CategoriaDisplay[] = await Promise.all(
        rows.map(async (cat) => ({
          ...cat,
          urlImagen: cat.Ruta_Imagen
            ? convertFileSrc(await join(baseDir, cat.Ruta_Imagen))
            : "",
        })),
      );

      setCategorias(procesadas);
    } catch (e) {
      console.error("Fallo al cargar categorías", e);
      setCategorias([]);
    }
  }, []);

  const cargarProductosDeCategoria = useCallback(async (cat: CategoriaDisplay | null) => {
    if (!cat) return;

    setLoadingProductos(true);

    try {
      const baseDir = await appDataDir();
      const idCat = Number(cat.ID_Categoria);
      const raw = await vrListProductosByCategoria(idCat);
      const rows = asArray<Producto>(raw);

      const procesados: ProductoDisplay[] = await Promise.all(
        rows.map(async (p) => ({
          ...p,
          urlImagen: p.Ruta_Imagen
            ? convertFileSrc(await join(baseDir, p.Ruta_Imagen))
            : "",
        })),
      );

      setProductos(procesados);
    } catch (e) {
      console.error("Fallo al cargar productos", e);
      setProductos([]);
    } finally {
      setLoadingProductos(false);
    }
  }, []);

  const buscarProductosPorNombre = useCallback(async (texto: string) => {
    const safeQ = texto.trim();

    if (!safeQ) {
      setBusqueda([]);
      return;
    }

    setLoadingBusqueda(true);

    try {
      const baseDir = await appDataDir();
      const raw = await vrSearchProductos(safeQ, 60);
      const rows = asArray<Producto>(raw);

      const procesados: ProductoDisplay[] = await Promise.all(
        rows.map(async (p) => ({
          ...p,
          urlImagen: p.Ruta_Imagen
            ? convertFileSrc(await join(baseDir, p.Ruta_Imagen))
            : "",
        })),
      );

      setBusqueda(procesados);
    } catch (e) {
      console.error("Fallo búsqueda", e);
      setBusqueda([]);
    } finally {
      setLoadingBusqueda(false);
    }
  }, []);

  const refreshComandasBarra = useCallback(
    async (opts?: { includePagadas?: boolean; silent?: boolean }) => {
      const silent = Boolean(opts?.silent);

      if (!silent) {
        setLoadingComandas(true);
      }

      try {
        const includePagadas = Boolean(opts?.includePagadas);

        const raw = await vrListComandasBarra({
          includePagadas,
          limit: includePagadas ? 200 : 60,
        });

        const rows = asArray<ComandaBarraRow>(raw);
        setComandasBarra(rows);
      } catch (e) {
        console.error("Error vrListComandasBarra:", e);

        if (!silent) {
          setComandasBarra([]);
        }
      } finally {
        if (!silent) {
          setLoadingComandas(false);
        }
      }
    },
    [],
  );

  const cargarComandaEnTicketPanel = useCallback(
    async (idComanda: number, opts?: LoadTicketOpts): Promise<TicketItem[]> => {
      try {
        const raw = await vrGetLineasComanda(idComanda);
        return applyLineasToTicketPanel(raw, opts);
      } catch (e) {
        console.error("Error cargarComandaEnTicketPanel:", e);

        if (!opts?.silentError) {
          toast.error("Error", "No se pudo cargar el ticket desde la base de datos.");
        }

        if (!opts?.keepSelection) {
          setSeleccionadosLocal(new Set());
        }

        return [];
      }
    },
    [applyLineasToTicketPanel, setSeleccionadosLocal, toast],
  );

  const queueComandaRefresh = useCallback(
    (
      idComanda: number,
      opts?: {
        refreshTicket?: boolean;
        refreshComandas?: boolean;
      },
    ) => {
      const refreshTicket = opts?.refreshTicket ?? true;
      const refreshComandas = opts?.refreshComandas ?? false;

      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }

      const run = () => {
        syncTimerRef.current = null;

        if (pendingTicketWritesRef.current > 0) {
          syncTimerRef.current = window.setTimeout(run, 250);
          return;
        }

        const runId = ++syncRunIdRef.current;

        void (async () => {
          try {
            if (refreshTicket && idComandaActivaRef.current === idComanda) {
              await cargarComandaEnTicketPanel(idComanda, {
                keepSelection: true,
                silentError: true,
              });
            }

            if (syncRunIdRef.current !== runId) return;

            if (refreshComandas && openVerTickets) {
              await refreshComandasBarra({
                includePagadas: true,
                silent: true,
              });
            }
          } catch (e) {
            console.error("queueComandaRefresh error:", e);
          }
        })();
      };

      syncTimerRef.current = window.setTimeout(run, 250);
    },
    [cargarComandaEnTicketPanel, openVerTickets, refreshComandasBarra],
  );

  const ensureComandaActiva = useCallback(async () => {
    if (idComandaActivaRef.current) {
      return idComandaActivaRef.current;
    }

    if (ensureComandaPromiseRef.current) {
      return await ensureComandaPromiseRef.current;
    }

    const p = (async () => {
      const id = await vrGetOrCreateComandaBarra(idTrabajadorAuth ?? null);

      setIdComandaActiva(id);
      idComandaActivaRef.current = id;

      return id;
    })();

    ensureComandaPromiseRef.current = p;

    try {
      return await p;
    } finally {
      ensureComandaPromiseRef.current = null;
    }
  }, [idTrabajadorAuth]);

  const cargarBootstrapInicial = useCallback(async () => {
    try {
      const baseDir = await appDataDir();
      const boot = await vrBootstrap(idTrabajadorAuth ?? null);

      const categoriasProcesadas: CategoriaDisplay[] = await Promise.all(
        asArray<Categoria>(boot.categorias).map(async (cat) => ({
          ...cat,
          urlImagen: cat.Ruta_Imagen
            ? convertFileSrc(await join(baseDir, cat.Ruta_Imagen))
            : "",
        })),
      );

      const idComanda = Number(boot.idComanda || boot.id_comanda || 0);

      if (!(idComanda > 0)) {
        throw new Error("bootstrap_id_comanda_missing");
      }

      setCategorias(categoriasProcesadas);
      setIdComandaActiva(idComanda);
      idComandaActivaRef.current = idComanda;

      applyLineasToTicketPanel(boot.lineas);
    } catch (e) {
      console.error("Fallo bootstrap venta rápida, usando flujo anterior:", e);

      await cargarCategorias();

      const id = await ensureComandaActiva();
      await cargarComandaEnTicketPanel(id);
    }
  }, [
    applyLineasToTicketPanel,
    cargarCategorias,
    cargarComandaEnTicketPanel,
    ensureComandaActiva,
    idTrabajadorAuth,
  ]);

  const markTicketItemsAsPaidLocal = useCallback(
    (ticketItemIds: string[]) => {
      const ids = new Set(ticketItemIds);

      setTicket((prev) => {
        const next = prev.map((t) =>
          ids.has(t.id)
            ? {
              ...t,
              pagado: true,
              seleccionado: false,
            }
            : t,
        );

        ticketRef.current = next;
        return next;
      });

      setSeleccionadosLocal((prev) => {
        const next = new Set(prev);

        for (const id of ids) {
          next.delete(id);
        }

        return next;
      });
    },
    [setSeleccionadosLocal],
  );

  const rollbackTicketItemsPaidLocal = useCallback(
    (ticketItemIds: string[], detalles: number[]) => {
      const ids = new Set(ticketItemIds);
      const detalleIds = new Set(detalles.map((n) => Number(n)).filter((n) => n > 0));

      setTicket((prev) => {
        const next = prev.map((t) => {
          const currentDetalleId = Number(detalleIdByTicketIdRef.current[t.id] ?? t.detalleId ?? 0);

          if (ids.has(t.id) || detalleIds.has(currentDetalleId)) {
            return {
              ...t,
              pagado: false,
              seleccionado: false,
            };
          }

          return t;
        });

        ticketRef.current = next;
        return next;
      });

      setSeleccionadosLocal(new Set());
    },
    [setSeleccionadosLocal],
  );

  const flushPendingCobros = useCallback(() => {
    if (cobroFlushTimerRef.current !== null) {
      window.clearTimeout(cobroFlushTimerRef.current);
      cobroFlushTimerRef.current = null;
    }

    const runnable = pendingCobrosRef.current.filter(
      (intent) => !runningCobrosRef.current.has(intent.id),
    );

    for (const intent of runnable) {
      const detalles = resolveDetallesForCobroIntent(intent);

      if (!detalles) {
        // Las líneas todavía están confirmando su ID_Detalle; reintentamos luego.
        continue;
      }

      runningCobrosRef.current.add(intent.id);

      void (async () => {
        const detallesUsados = detalles;

        try {
          const metodoDb = intent.metodo === "tarjeta" ? "Tarjeta" : "Efectivo";

          /*
            Una sola llamada: el cobro descuenta stock e inserta Lote_Consumos
            en la misma transacción idempotente. Ya no hay segunda llamada a
            restarStock ni opIdStock.
          */
          const pago = await vrCobrarFraccionado({
            idComanda: intent.idComanda,
            metodo: metodoDb as any,
            importeTotal: intent.importeTotal,
            idUsuarioCobrador: intent.idUsuarioCobrador,
            idTrabajadorCobrador: intent.idTrabajadorCobrador,
            detalles: detallesUsados,
            opId: intent.opIdCobro,
          });

          if (pago?.error === "insufficient_stock") {
            // No se creó el pago: revertimos el marcado optimista de cobrado.
            setPendingCobrosLocal((prev) => prev.filter((x) => x.id !== intent.id));
            rollbackTicketItemsPaidLocal(intent.ticketItemIds, detallesUsados);

            toast.error(
              "Sin stock suficiente",
              "No hay stock para cobrar estas líneas. Las he devuelto a pendiente.",
            );

            if (idComandaActivaRef.current === intent.idComanda) {
              queueComandaRefresh(intent.idComanda, {
                refreshTicket: true,
                refreshComandas: false,
              });
            }

            return;
          }

          if (!pago?.ok) {
            throw new Error("No se pudo guardar el pago.");
          }

          setPendingCobrosLocal((prev) => prev.filter((x) => x.id !== intent.id));
          emitVrChanged();
        } catch (e) {
          console.error("Error cobrando venta rápida:", e);

          setPendingCobrosLocal((prev) => prev.filter((x) => x.id !== intent.id));
          rollbackTicketItemsPaidLocal(intent.ticketItemIds, detallesUsados);

          toast.error(
            "Error",
            "No se pudo completar el cobro. He devuelto esas líneas a pendiente.",
          );

          if (idComandaActivaRef.current === intent.idComanda) {
            queueComandaRefresh(intent.idComanda, {
              refreshTicket: true,
              refreshComandas: false,
            });
          }
        } finally {
          runningCobrosRef.current.delete(intent.id);

          if (pendingCobrosRef.current.length > 0) {
            cobroFlushTimerRef.current = window.setTimeout(() => {
              flushPendingCobros();
            }, 500);
          }
        }
      })();
    }

    if (
      pendingCobrosRef.current.length > 0 &&
      pendingCobrosRef.current.some(
        (intent) => resolveDetallesForCobroIntent(intent) === null,
      )
    ) {
      cobroFlushTimerRef.current = window.setTimeout(() => {
        flushPendingCobros();
      }, 180);
    }
  }, [
    queueComandaRefresh,
    resolveDetallesForCobroIntent,
    rollbackTicketItemsPaidLocal,
    setPendingCobrosLocal,
    toast,
  ]);

  const queueFlushPendingCobros = useCallback(() => {
    if (cobroFlushTimerRef.current !== null) {
      window.clearTimeout(cobroFlushTimerRef.current);
    }

    cobroFlushTimerRef.current = window.setTimeout(() => {
      flushPendingCobros();
    }, 60);
  }, [flushPendingCobros]);

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    void cargarBootstrapInicial();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stored = loadPendingCobrosFromStorage(pendingCobrosStorageKey);
    if (stored.length === 0) return;

    setPendingCobrosLocal(stored);

    const timer = window.setTimeout(() => {
      queueFlushPendingCobros();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [pendingCobrosStorageKey, queueFlushPendingCobros, setPendingCobrosLocal]);

  useEffect(() => {
    idComandaActivaRef.current = idComandaActiva;
  }, [idComandaActiva]);

  useEffect(() => {
    if (!categoriaSeleccionada) return;
    void cargarProductosDeCategoria(categoriaSeleccionada);
  }, [categoriaSeleccionada, cargarProductosDeCategoria]);

  useEffect(() => {
    const t = window.setTimeout(() => void buscarProductosPorNombre(q), 180);
    return () => window.clearTimeout(t);
  }, [q, buscarProductosPorNombre]);

  const showingSearch = q.length > 0;

  useEffect(() => {
    if (paso === "efectivo" || paso === "metodo") return;

    if (categoriaSeleccionada && !showingSearch) {
      setPaso("productos");
    }

    if (!categoriaSeleccionada && !showingSearch) {
      setPaso("categorias");
    }
  }, [categoriaSeleccionada, showingSearch, paso]);

  const onGuardarNota = useCallback(
    async (detalleId: number, nota: string) => {
      if (hasPendingTicketWrites()) {
        warnPendingTicketWrites();
        return;
      }

      if (!(Number(detalleId) > 0)) {
        toast.info("Espera un momento", "Todavía se está guardando esta línea.");
        return;
      }

      const clean = nota.trim();

      try {
        const ok = await vrUpdateNotaDetalle(Number(detalleId), clean);

        if (!ok) {
          throw new Error("No se pudo guardar la nota.");
        }

        setTicket((prev) => {
          const next = prev.map((t) =>
            t.detalleId === detalleId ? { ...t, notas: clean || null } : t,
          );

          ticketRef.current = next;
          return next;
        });

        emitVrChanged();
      } catch (e) {
        console.error(e);
        toast.error("Error", "No se pudo guardar la nota.");
      }
    },
    [hasPendingTicketWrites, toast, warnPendingTicketWrites],
  );

  const totalPendiente = useMemo(
    () => ticket.filter((t) => !t.pagado).reduce((acc, t) => acc + Number(t.precio || 0), 0),
    [ticket],
  );

  const haySeleccion = useMemo(
    () => ticket.some((t) => !t.pagado && seleccionados.has(t.id)),
    [ticket, seleccionados],
  );

  const totalSeleccionado = useMemo(
    () =>
      ticket
        .filter((t) => !t.pagado && seleccionados.has(t.id))
        .reduce((acc, t) => acc + Number(t.precio || 0), 0),
    [ticket, seleccionados],
  );

  const seleccionaTodoPendiente = useCallback(() => {
    const currentTicket = ticketRef.current;

    setSeleccionadosLocal(
      new Set(
        currentTicket
          .filter((t) => !t.pagado)
          .map((t) => t.id),
      ),
    );
  }, [setSeleccionadosLocal]);

  const limpiarSeleccion = useCallback(() => {
    setSeleccionadosLocal(new Set());
  }, [setSeleccionadosLocal]);

  const toggleSeleccion = useCallback(
    (id: string) => {
      const it = ticketRef.current.find((t) => t.id === id);

      if (!it || it.pagado) return;

      setSeleccionadosLocal((prev) => {
        const next = new Set(prev);

        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }

        return next;
      });
    },
    [setSeleccionadosLocal],
  );

  const ticketForPanel = useMemo(
    () => ticket.map((t) => ({ ...t, seleccionado: !t.pagado && seleccionados.has(t.id) })),
    [ticket, seleccionados],
  );

  const qtyByProductId = useMemo(() => {
    const m = new Map<number, number>();

    for (const t of ticket) {
      if (t.pagado) continue;
      m.set(t.productoId, (m.get(t.productoId) ?? 0) + 1);
    }

    return m;
  }, [ticket]);

  const getQty = useCallback((id: number) => qtyByProductId.get(id) ?? 0, [qtyByProductId]);

  const getQtyZero = useCallback((_id: number) => 0, []);

  const addProductoToTicket = useCallback(
    async (p: ProductoDisplay) => {
      const idProducto = Number(p.ID_Producto);
      const precio = Number(p.Precio_Venta || 0);
      const tempId = makeTempTicketId();

      const tempItem: TicketItem = {
        id: tempId,
        detalleId: 0,
        productoId: idProducto,
        nombre: String(p.Nombre ?? "Producto"),
        precio,
        pagado: false,
        seleccionado: false,
        notas: null,
      };

      addTicketItemLocal(tempItem);
      beginTicketWrite();

      let idComanda: number | null = null;
      let success = false;
      let needsReconcile = false;

      try {
        idComanda = await ensureComandaActiva();

        const result = await vrAddLineaComanda(idComanda, idProducto, 1, precio);

        if (!result?.ok) {
          throw new Error("No se pudo insertar la línea.");
        }

        if (cancelledAddTempIdsRef.current.has(tempId)) {
          await vrRemoveLastUnpaidLinea(idComanda, idProducto);
          success = true;
          emitVrChanged();
          return;
        }

        const idDetalle = Number(result.idDetalle || 0);

        if (idDetalle > 0) {
          replaceTicketItemLocal(tempId, {
            ...tempItem,
            id: makeDetalleTicketId(idDetalle),
            detalleId: idDetalle,
          });

          queueFlushPendingCobros();
        } else {
          needsReconcile = true;
        }

        success = true;
        emitVrChanged();
      } catch (e) {
        console.error(e);

        if (!cancelledAddTempIdsRef.current.has(tempId)) {
          removeTicketItemLocal(tempId);

          const affectedCobros = pendingCobrosRef.current.filter((intent) =>
            intent.ticketItemIds.includes(tempId),
          );

          if (affectedCobros.length > 0) {
            setPendingCobrosLocal((prev) =>
              prev.filter((intent) => !intent.ticketItemIds.includes(tempId)),
            );

            for (const intent of affectedCobros) {
              const detalles = resolveDetallesForCobroIntent(intent) ?? [];

              rollbackTicketItemsPaidLocal(intent.ticketItemIds, detalles);
            }

            toast.error(
              "Error",
              "No se pudo añadir un producto, así que se canceló el cobro pendiente.",
            );
          } else {
            toast.error("Error", "No se pudo añadir el producto al ticket.");
          }
        }
      } finally {
        cancelledAddTempIdsRef.current.delete(tempId);
        endTicketWrite();

        if (success && idComanda && needsReconcile) {
          queueComandaRefresh(idComanda, {
            refreshTicket: true,
            refreshComandas: false,
          });
        }
      }
    },
    [
      addTicketItemLocal,
      beginTicketWrite,
      endTicketWrite,
      ensureComandaActiva,
      queueComandaRefresh,
      queueFlushPendingCobros,
      removeTicketItemLocal,
      replaceTicketItemLocal,
      resolveDetallesForCobroIntent,
      rollbackTicketItemsPaidLocal,
      setPendingCobrosLocal,
      toast,
    ],
  );

  const removeProductoFromTicket = useCallback(
    async (productoId: number) => {
      const idProducto = Number(productoId);

      const item = [...ticketRef.current]
        .reverse()
        .find((t) => !t.pagado && Number(t.productoId) === idProducto);

      if (!item) return;

      if (!(Number(item.detalleId) > 0)) {
        cancelledAddTempIdsRef.current.add(item.id);
        removeTicketItemLocal(item.id);
        emitVrChanged();
        return;
      }

      removeTicketItemLocal(item.id);
      beginTicketWrite();

      try {
        const idComanda = await ensureComandaActiva();
        const ok = await vrRemoveLastUnpaidLinea(idComanda, idProducto);

        if (!ok) {
          throw new Error("No se pudo borrar la línea.");
        }

        emitVrChanged();
      } catch (e) {
        console.error(e);

        restoreTicketItemLocal(item);
        toast.error("Error", "No se pudo quitar el producto del ticket.");
      } finally {
        endTicketWrite();
      }
    },
    [
      beginTicketWrite,
      endTicketWrite,
      ensureComandaActiva,
      removeTicketItemLocal,
      restoreTicketItemLocal,
      toast,
    ],
  );

  const eliminarLineaTicket = useCallback(
    async (ticketItemId: string) => {
      const item = ticketRef.current.find((t) => t.id === ticketItemId);
      if (!item) return;

      const idDetalle = Number(item.detalleId || 0);

      if (!(idDetalle > 0)) {
        cancelledAddTempIdsRef.current.add(item.id);
        removeTicketItemLocal(item.id);
        emitVrChanged();
        return;
      }

      removeTicketItemLocal(ticketItemId);
      beginTicketWrite();

      try {
        const idComanda = await ensureComandaActiva();
        const ok = await vrDeleteLineaIfUnpaid(idComanda, idDetalle);

        if (!ok) {
          throw new Error("No se pudo eliminar.");
        }

        emitVrChanged();
      } catch (e) {
        console.error(e);

        restoreTicketItemLocal(item);
        toast.error("Error", "No se pudo eliminar la línea del ticket.");
      } finally {
        endTicketWrite();
      }
    },
    [
      beginTicketWrite,
      endTicketWrite,
      ensureComandaActiva,
      removeTicketItemLocal,
      restoreTicketItemLocal,
      toast,
    ],
  );

  const cobrar = useCallback(
    async (_metodo: "tarjeta" | "efectivo") => {
      if (hasPendingTicketWrites()) {
        warnPendingTicketWrites();
        return;
      }

      const currentTicket = ticketRef.current;
      const currentSeleccionados = seleccionadosRef.current;

      const seleccionadosItems = currentTicket.filter(
        (t) => !t.pagado && currentSeleccionados.has(t.id),
      );

      if (seleccionadosItems.length === 0) return;

      const idUsuarioCobrador: number | null = idUsuarioAuth ?? null;
      const idTrabajadorCobrador: number | null = idTrabajadorAuth ?? null;

      try {
        const idComanda = await ensureComandaActiva();

        const detalleIds = seleccionadosItems.map((it) => {
          const fromItem = Number(it.detalleId || 0);
          if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;

          const fromMap = Number(detalleIdByTicketIdRef.current[it.id] || 0);
          if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;

          return parseDetalleIdFromTicketItemId(it.id);
        });

        if (detalleIds.some((n) => !Number.isFinite(n) || n <= 0)) {
          toast.info(
            "Espera un momento",
            "Todavía se están confirmando líneas del ticket antes de cobrar.",
          );

          queueComandaRefresh(idComanda, {
            refreshTicket: true,
            refreshComandas: false,
          });

          return;
        }

        const importeTotal =
          Math.round(seleccionadosItems.reduce((acc, it) => acc + Number(it.precio || 0), 0) * 100) /
          100;

        const ticketItemIds = seleccionadosItems.map((it) => it.id);

        const intentId = makeTempTicketId();

        const intent: PendingCobroIntent = {
          id: intentId,
          idComanda,
          metodo: _metodo,
          ticketItemIds,
          detalleIds,
          importeTotal,
          idUsuarioCobrador,
          idTrabajadorCobrador,
          opIdCobro: makeStableCobroOpId(intentId),
          createdAtMs: Date.now(),
        };

        setPendingCobrosLocal((prev) => [
          ...prev.filter((x) => {
            const prevIds = new Set(x.ticketItemIds);
            const prevDetalles = new Set(x.detalleIds.map((n) => Number(n)).filter((n) => n > 0));

            return !ticketItemIds.some((id, idx) => {
              const detalleId = Number(detalleIds[idx] || 0);
              return prevIds.has(id) || prevDetalles.has(detalleId);
            });
          }),
          intent,
        ]);

        markTicketItemsAsPaidLocal(ticketItemIds);

        setCashCount({});
        setPaso("categorias");
        setSeleccionadosLocal(new Set());

        queueFlushPendingCobros();
        emitVrChanged();
      } catch (e) {
        console.error("Error preparando cobro venta rápida:", e);
        toast.error("Error", "No se pudo preparar el cobro.");
      }
    },
    [
      hasPendingTicketWrites,
      idUsuarioAuth,
      idTrabajadorAuth,
      ensureComandaActiva,
      markTicketItemsAsPaidLocal,
      queueComandaRefresh,
      queueFlushPendingCobros,
      setPendingCobrosLocal,
      setSeleccionadosLocal,
      toast,
      warnPendingTicketWrites,
    ],
  );

  const totalEfectivo = useMemo(() => {
    let sum = 0;

    for (const d of DENOMS) {
      const c = cashCount[d.label] || 0;
      sum += d.value * c;
    }

    return Math.round(sum * 100) / 100;
  }, [cashCount]);

  const totalACobrar = useMemo(() => (haySeleccion ? totalSeleccionado : 0), [
    haySeleccion,
    totalSeleccionado,
  ]);

  const diferencia = useMemo(() => {
    const diff = totalEfectivo - totalACobrar;
    return Math.round(diff * 100) / 100;
  }, [totalEfectivo, totalACobrar]);

  const addCash = useCallback((label: string) => {
    setCashCount((p) => ({ ...p, [label]: (p[label] || 0) + 1 }));
  }, []);

  const removeCash = useCallback((label: string) => {
    setCashCount((prev) => {
      const cur = prev[label] || 0;
      const next = Math.max(0, cur - 1);
      const out: Record<string, number> = { ...prev, [label]: next };

      if (next === 0) {
        delete out[label];
      }

      return out;
    });
  }, []);

  const resetCash = useCallback(() => setCashCount({}), []);

  const leftTitle = useMemo(() => {
    if (paso === "efectivo") return "Cobro en efectivo";
    if (showingSearch) return `Productos · "${q}"`;
    if (categoriaSeleccionada) return `Productos · ${categoriaSeleccionada.Nombre}`;
    return "Categorías";
  }, [paso, showingSearch, q, categoriaSeleccionada]);

  const leftSubtitle = useMemo(() => {
    if (paso === "efectivo") return "Selecciona billetes/monedas y verás el cambio.";
    if (showingSearch) return "Resultados del buscador (con + / −).";
    if (categoriaSeleccionada) return "Usa +/− o pulsa la tarjeta para añadir.";
    return "Elige una categoría para ver sus productos.";
  }, [paso, showingSearch, categoriaSeleccionada]);

  const onProductoGuardado = useCallback(async () => {
    if (showingSearch) return buscarProductosPorNombre(q);
    if (categoriaSeleccionada) return cargarProductosDeCategoria(categoriaSeleccionada);
    return cargarCategorias();
  }, [
    showingSearch,
    buscarProductosPorNombre,
    q,
    categoriaSeleccionada,
    cargarProductosDeCategoria,
    cargarCategorias,
  ]);

  const variant: "search" | "categories" | "products" = showingSearch
    ? "search"
    : !categoriaSeleccionada
      ? "categories"
      : "products";

  const nuevoTicket = useCallback(async () => {
    if (hasPendingTicketWrites()) {
      warnPendingTicketWrites();
      return;
    }

    if (pendingCobrosRef.current.length > 0) {
      toast.info("Espera un momento", "Hay un cobro terminando en segundo plano.");
      return;
    }

    try {
      const idNew = await vrCreateComandaBarra(idTrabajadorAuth ?? null);

      setIdComandaActiva(idNew);
      idComandaActivaRef.current = idNew;

      clearTicketLocal();

      setPaso("categorias");
      setCashCount({});
      setQuery("");
      setBusqueda([]);
      setCategoriaSeleccionada(null);

      emitVrChanged();
    } catch (e) {
      console.error(e);
      toast.error("Error", "No se pudo crear un nuevo ticket.");
    }
  }, [
    clearTicketLocal,
    hasPendingTicketWrites,
    idTrabajadorAuth,
    toast,
    warnPendingTicketWrites,
  ]);

  const abrirVerTickets = useCallback(async () => {
    if (hasPendingTicketWrites()) {
      warnPendingTicketWrites();
      return;
    }

    if (pendingCobrosRef.current.length > 0) {
      toast.info("Espera un momento", "Hay un cobro terminando en segundo plano.");
      return;
    }

    setOpenVerTickets(true);
    await refreshComandasBarra({ includePagadas: true });
  }, [hasPendingTicketWrites, refreshComandasBarra, toast, warnPendingTicketWrites]);

  const abrirTicketDesdeModal = useCallback(
    async (id: string) => {
      if (hasPendingTicketWrites()) {
        warnPendingTicketWrites();
        return;
      }

      if (pendingCobrosRef.current.length > 0) {
        toast.info("Espera un momento", "Hay un cobro terminando en segundo plano.");
        return;
      }

      const idComanda = Number(id);

      if (!Number.isFinite(idComanda)) return;

      setIdComandaActiva(idComanda);
      idComandaActivaRef.current = idComanda;

      await cargarComandaEnTicketPanel(idComanda);
      setOpenVerTickets(false);

      emitVrChanged();
    },
    [cargarComandaEnTicketPanel, hasPendingTicketWrites, toast, warnPendingTicketWrites],
  );

  const eliminarTicketDesdeModal = useCallback(
    async (id: string) => {
      if (hasPendingTicketWrites()) {
        warnPendingTicketWrites();
        return;
      }

      if (pendingCobrosRef.current.length > 0) {
        toast.info("Espera un momento", "Hay un cobro terminando en segundo plano.");
        return;
      }

      try {
        const idComanda = Number(id);

        if (!Number.isFinite(idComanda)) return;

        const ok = await vrDeleteComandaIfSafe(idComanda);

        if (!ok) {
          toast.error("No se puede", "Ese ticket ya tiene líneas pagadas y no se puede borrar.");
          return;
        }

        await refreshComandasBarra({ includePagadas: true });

        if (idComandaActivaRef.current === idComanda) {
          const idNew = await vrCreateComandaBarra(idTrabajadorAuth ?? null);

          setIdComandaActiva(idNew);
          idComandaActivaRef.current = idNew;

          clearTicketLocal();
        }

        emitVrChanged();
      } catch (e) {
        console.error(e);
        toast.error("Error", "No se pudo eliminar el ticket.");
      }
    },
    [
      clearTicketLocal,
      hasPendingTicketWrites,
      idTrabajadorAuth,
      refreshComandasBarra,
      toast,
      warnPendingTicketWrites,
    ],
  );

  const cobrarTicketDesdeModal = useCallback(
    async (id: string) => {
      if (hasPendingTicketWrites()) {
        warnPendingTicketWrites();
        return;
      }

      if (pendingCobrosRef.current.length > 0) {
        toast.info("Espera un momento", "Hay un cobro terminando en segundo plano.");
        return;
      }

      const idComanda = Number(id);

      if (!Number.isFinite(idComanda)) return;

      setIdComandaActiva(idComanda);
      idComandaActivaRef.current = idComanda;

      const ui = await cargarComandaEnTicketPanel(idComanda);

      setSeleccionadosLocal(new Set(ui.filter((t) => !t.pagado).map((t) => t.id)));
      setPaso("metodo");
      setOpenVerTickets(false);

      emitVrChanged();
    },
    [
      cargarComandaEnTicketPanel,
      hasPendingTicketWrites,
      setSeleccionadosLocal,
      toast,
      warnPendingTicketWrites,
    ],
  );

  const onOpenAddProductCb = useCallback(() => setOpenAddProduct(true), []);

  const onSelectCategoriaCb = useCallback((c: CategoriaDisplay) => {
    setCategoriaSeleccionada(c);
  }, []);

  const onAddProductoCb = useCallback(
    (p: ProductoDisplay) => void addProductoToTicket(p),
    [addProductoToTicket],
  );

  const onRemoveProductoCb = useCallback(
    (id: number) => void removeProductoFromTicket(id),
    [removeProductoFromTicket],
  );

  const onOpenProductDetailCb = useCallback(
    (id: number) => abrirDetalleProducto(id),
    [abrirDetalleProducto],
  );

  return (
    <div className="h-full min-h-0 bg-blanco text-negro flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-black/10 px-3 sm:px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-extrabold truncate">Venta rápida</h1>
          <p className="text-xs sm:text-sm text-black/60 truncate">
            Ticket rápido de barra · {idComandaActiva ? `#${idComandaActiva}` : "sin ticket"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={nuevoTicket}
            className="px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
          >
            Nuevo ticket
          </button>

          <button
            type="button"
            onClick={abrirVerTickets}
            className={cn(
              "px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold",
              loadingComandas && "opacity-60",
            )}
          >
            Ver tickets
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-3 p-3 overflow-hidden">
        <div className="min-h-0 rounded-2xl border border-black/10 bg-black/[0.02] overflow-hidden flex flex-col">
          <div className="p-3 border-b border-black/10 bg-white">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-bold truncate">{leftTitle}</h2>
                <p className="text-xs sm:text-sm text-black/60">{leftSubtitle}</p>
              </div>

              <div className="flex items-center gap-2">
                {categoriaSeleccionada && paso !== "efectivo" && (
                  <button
                    type="button"
                    onClick={() => setCategoriaSeleccionada(null)}
                    className="px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
                  >
                    Categorías
                  </button>
                )}

                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar producto..."
                  className="w-48 sm:w-64 px-3 py-2 rounded-xl border border-black/10 bg-white outline-none focus:ring-2 focus:ring-black/10 text-sm"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {paso === "efectivo" ? (
              <CashPanel
                denoms={DENOMS}
                cashCount={cashCount}
                totalACobrar={totalACobrar}
                totalEfectivo={totalEfectivo}
                diferencia={diferencia}
                formatMoney={eur}
                onAddCash={addCash}
                onRemoveCash={removeCash}
                onReset={resetCash}
                onConfirm={() => void cobrar("efectivo")}
                onCancel={() => {
                  setPaso("metodo");
                  setCashCount({});
                }}
              />
            ) : (
              <CatalogGrid
                variant={variant}
                categorias={categorias}
                productos={productos}
                busqueda={busqueda}
                loading={variant === "search" ? loadingBusqueda : loadingProductos}
                getQty={variant === "categories" ? getQtyZero : getQty}
                onSelectCategoria={onSelectCategoriaCb}
                onAddProducto={onAddProductoCb}
                onRemoveProducto={onRemoveProductoCb}
                onOpenProductDetail={onOpenProductDetailCb}
                onOpenAddProduct={onOpenAddProductCb}
                formatPrice={eur}
              />
            )}
          </div>
        </div>

        <div className="min-h-0 rounded-2xl border border-black/10 bg-white overflow-hidden flex flex-col">
          <TicketPanel
            ticket={ticketForPanel}
            paso={paso}
            totalPendiente={totalPendiente}
            totalSeleccionado={totalSeleccionado}
            haySeleccion={haySeleccion}
            formatMoney={eur}
            onCobrarTodo={() => {
              seleccionaTodoPendiente();
              setPaso("metodo");
            }}
            onCobrarFraccionado={() => {
              setPaso("metodo");
            }}
            onToggleSeleccion={(id) => toggleSeleccion(id)}
            onEliminarLinea={(id) => void eliminarLineaTicket(id)}
            onCobrarTarjeta={async () => {
              await cobrar("tarjeta");
            }}
            onStartEfectivo={() => {
              setPaso("efectivo");
              setCashCount({});
            }}
            onCancelarCobro={() => {
              setPaso("categorias");
              limpiarSeleccion();
            }}
            onGuardarNota={onGuardarNota}
          />
        </div>
      </div>

      <AddProductModal
        open={openAddProduct}
        onClose={() => setOpenAddProduct(false)}
        categoriaPreseleccionadaId={
          categoriaSeleccionada ? Number(categoriaSeleccionada.ID_Categoria) : null
        }
        onSaved={async () => {
          await onProductoGuardado();
        }}
      />

      <ProductDetailModal
        open={openProductDetail}
        onClose={cerrarDetalleProducto}
        productId={productDetailId ?? 0}
      />

      <VerTicketsModal
        open={openVerTickets}
        onClose={() => {
          setOpenVerTickets(false);
        }}
        comandas={comandasBarra}
        onOpenTicket={(id) => void abrirTicketDesdeModal(id)}
        onDeleteTicket={(id) => void eliminarTicketDesdeModal(id)}
        onCobrarTicket={(id) => void cobrarTicketDesdeModal(id)}
      />
    </div>
  );
}
