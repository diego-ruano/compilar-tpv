// src/pages/VentaRapida.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, ReceiptText, ArrowLeft } from "lucide-react";
import { resolveImageUrl } from "../../shared/lib/imageUrl";
import { useAuth } from "../../shared/stores/useAuth";
import { useSyncSignal } from "../../shared/stores/useSyncSignal";
import { shouldReloadTicket } from "../../shared/lib/syncStatements";
import { useToast } from "../../shared/toast";
import { SearchInput } from "../../shared/ui";
import { captureException } from "../../shared/observability/sentry";

import AddProductModal from "../../features/ventaRapida/ui/AddProductModal";
import CatalogGrid from "../../features/ventaRapida/ui/CatalogGrid";
import CashPanel from "../../features/ventaRapida/ui/CashPanel";
import TicketPanel from "../../features/ventaRapida/ui/TicketPanel";
import type { DatosDelTicket } from "../../features/configuracion/api/printerApis";
import VerTicketsModal from "../../features/ventaRapida/ui/VerTicketsModal";

import ProductDetailModal from "../../features/InventaryComponents/ProductDetailModal";
import DatosFiscalesModal, {
} from "../../shared/ticket/DatosFiscalesModal";
import { anunciarCobro } from "../../shared/ticket/AvisoFiscalModal";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { esError, toAppError } from "@tpv/client";

import {
  CategoriaDisplay,
  ProductoDisplay,
  Paso,
  TicketItem,
} from "../../features/ventaRapida/types";
import { cn } from "../../features/ventaRapida/utils";

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
} from "../../features/ventaRapida/ventaRapidaAPI";
import { conAviso } from "../../shared/lib/conAviso";
import type {
  CategoriaRow,
  ComandaBarraRow,
  DestinatarioInput,
  Dinero,
  LineaComandaRow,
} from "@tpv/contracts";
import { CERO, deCentimos, escalar } from "../../shared/lib/dinero";
import {
  cambioDelCobro,
  DENOMS_COBRO,
  sumaImportes,
  totalRecuento,
} from "../../shared/lib/efectivo";

/* =========================
   EVENTO GLOBAL
========================= */
const emitVrChanged = () => {
  window.dispatchEvent(new CustomEvent("vr:changed"));
};


type LoadTicketOpts = {
  keepSelection?: boolean;
  silentError?: boolean;
};

type PendingCobroIntent = {
  id: string;
  idComanda: string;
  metodo: "tarjeta" | "efectivo";
  ticketItemIds: string[];
  detalleIds: string[];
  importeTotal: Dinero;
  /**
   * El id del cobro (`Pagos.ID_Pago`). Se genera al encolar y se persiste con el intent, así que un
   * reintento tras un cierre inesperado lleva el mismo: si el cobro ya se guardó, la Main devuelve
   * su número en vez de rechazarlo por no quedar líneas pendientes.
   */
  idPago: string;
  createdAtMs: number;
  /**
   * FISCAL-02: los datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe
   * pasa del límite de la simplificada y entonces no hay alternativa. Ausente = ticket (`F2`).
   *
   * Viaja DENTRO del intent, y por tanto se persiste en `localStorage` con él. Tiene coste —el
   * nombre y el NIF de un cliente ahí mientras el cobro no cierre— y se paga a propósito: la
   * alternativa es que un reinicio a mitad de cobro reemita el intent sin estos datos, y entonces
   * el camino VOLUNTARIO se degrada en silencio a un ticket simplificado. Un cliente que pidió
   * factura y se fue con un ticket es un error que nadie descubre hasta su trimestre. El dato, por
   * lo demás, acaba en el SQLite de este mismo equipo de todas formas.
   */
  destinatario?: DestinatarioInput | null;
};

const PENDING_COBROS_STORAGE_PREFIX = "tpv:ventaRapida:pendingCobros:v1";

function makeTempTicketId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `tmp-${crypto.randomUUID()}`;
  }

  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeDetalleTicketId(idDetalle: string): string {
  return `detalle-${String(idDetalle ?? "").trim()}`;
}

function parseDetalleIdFromTicketItemId(ticketItemId: string): string {
  const raw = String(ticketItemId || "").trim();
  if (!raw.startsWith("detalle-")) return "";

  return raw.slice("detalle-".length).trim();
}

function sanitizePendingCobroIntent(value: unknown): PendingCobroIntent | null {
  if (!value || typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const id = String(obj.id ?? "").trim();
  const idComanda = String(obj.idComanda ?? obj.id_comanda ?? "").trim();
  const metodoRaw = String(obj.metodo ?? "").trim().toLowerCase();
  const ticketItemIds = Array.isArray(obj.ticketItemIds)
    ? obj.ticketItemIds.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const detalleIds = Array.isArray(obj.detalleIds)
    ? obj.detalleIds.map((x) => String(x ?? "").trim()).filter((s) => s.length > 0)
    : [];

  const importeTotal = deCentimos(Number(obj.importeTotal ?? 0));
  const createdAtMs = Number(obj.createdAtMs ?? Date.now());
  const idPago = String(obj.idPago ?? "").trim() || crypto.randomUUID();

  // El destinatario se valida entero o se descarta: medio destinatario (nombre sin NIF) haría que
  // el backend rechazara el cobro una y otra vez sin que nada lo explicara.
  const dRaw = obj.destinatario;
  let destinatario: PendingCobroIntent["destinatario"] = null;
  if (dRaw && typeof dRaw === "object") {
    const d = dRaw as Record<string, unknown>;
    const nombre = String(d.nombre_razon ?? "").trim();
    const nif = String(d.nif ?? "").trim().toUpperCase();
    const domicilio = String(d.domicilio ?? "").trim();
    if (nombre && nif) {
      destinatario = { nombre_razon: nombre, nif, domicilio: domicilio || undefined };
    }
  }

  if (!id) return null;
  if (!idComanda) return null;
  if (metodoRaw !== "tarjeta" && metodoRaw !== "efectivo") return null;
  if (ticketItemIds.length === 0) return null;
  if (importeTotal <= 0) return null;

  return {
    id,
    idComanda,
    metodo: metodoRaw,
    ticketItemIds,
    detalleIds,
    importeTotal,
    idPago,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Date.now(),
    destinatario,
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

  const categoriaNombreById = useMemo(() => {
    const map: Record<string, string> = {};

    for (const cat of categorias) {
      const id = String(cat.ID_Categoria ?? "").trim();
      if (id) {
        map[id] = String(cat.Nombre ?? "");
      }
    }

    return map;
  }, [categorias]);

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

  const getCategoriaNombreParaProducto = useCallback(
    (productoId: string | null | undefined) => {
      const id = String(productoId ?? "").trim();
      if (!id) return null;

      const fromProductos = productos.find((p) => p.ID_Producto === id);
      if (fromProductos?.ID_Categoria) {
        const nombre = categoriaNombreById[String(fromProductos.ID_Categoria)] ?? null;
        if (nombre) return nombre;
      }

      const fromBusqueda = busqueda.find((p) => p.ID_Producto === id);
      if (fromBusqueda?.ID_Categoria) {
        const nombre = categoriaNombreById[String(fromBusqueda.ID_Categoria)] ?? null;
        if (nombre) return nombre;
      }

      if (categoriaSeleccionada?.ID_Categoria) {
        const idCat = String(categoriaSeleccionada.ID_Categoria ?? "").trim();
        if (idCat && idCat === String(fromProductos?.ID_Categoria ?? "") && categoriaSeleccionada.Nombre) {
          return categoriaSeleccionada.Nombre;
        }
      }

      return null;
    },
    [busqueda, categoriaNombreById, categoriaSeleccionada, productos],
  );

  const [ticket, setTicket] = useState<TicketItem[]>([]);
  const ticketRef = useRef<TicketItem[]>([]);

  const [paso, setPaso] = useState<Paso>("categorias");
  // Qué papel se imprime. Vacío = PRECUENTA (aún no se ha cobrado); tras el cobro se rellena con
  // el número que devuelve, y entonces sale un ticket de venta.
  const [datosTicket, setDatosTicket] = useState<DatosDelTicket | undefined>(undefined);
  const [cashCount, setCashCount] = useState<Record<string, number>>({});
  const [openAddProduct, setOpenAddProduct] = useState(false);

  const [openProductDetail, setOpenProductDetail] = useState(false);
  const [productDetailId, setProductDetailId] = useState<string | null>(null);

  const [seleccionados, setSeleccionados] = useState<Set<string>>(() => new Set());
  const seleccionadosRef = useRef<Set<string>>(new Set());

  const [openVerTickets, setOpenVerTickets] = useState(false);
  const [comandasBarra, setComandasBarra] = useState<ComandaBarraRow[]>([]);
  const [loadingComandas, setLoadingComandas] = useState(false);

  const [idComandaActiva, setIdComandaActiva] = useState<string | null>(null);
  const idComandaActivaRef = useRef<string | null>(null);
  const ensureComandaPromiseRef = useRef<Promise<string> | null>(null);

  const didInitRef = useRef(false);

  const [detalleIdByTicketId, setDetalleIdByTicketId] = useState<Record<string, string>>({});
  const detalleIdByTicketIdRef = useRef<Record<string, string>>({});

  const pendingTicketWritesRef = useRef(0);
  const cancelledAddTempIdsRef = useRef<Set<string>>(new Set());

  const pendingCobrosRef = useRef<PendingCobroIntent[]>([]);
  const runningCobrosRef = useRef<Set<string>>(new Set());
  const cobroFlushTimerRef = useRef<number | null>(null);

  /* ── FISCAL-02: la factura completa ─────────────────────────────────────────
     Aquí el cobro es OPTIMISTA y diferido (el intent se encola, se marca la línea como cobrada y
     la llamada sale después), así que los dos caminos hasta el formulario llegan en momentos
     distintos:

       · VOLUNTARIO. Se marca la casilla y se piden los datos ANTES de encolar.
       · OBLIGATORIO. El backend rechaza el intent con `factura_completa_requerida`, ya encolado.
         Ese intent NO se deshace: se queda en la cola esperando el dato, porque deshacerlo
         devolvería las líneas a pendiente y el camarero tendría que volver a seleccionarlas con el
         cliente delante.

     El límite no se comprueba en esta pantalla. Lo decide Rust dentro de la transacción del cobro,
     que es donde se conoce el importe exacto que se va a registrar. */
  const limiteSimplif = useBusinessSettings((st) => st.limiteSimplif);
  const [quiereFactura, setQuiereFactura] = useState(false);
  /** Intents parados esperando un destinatario. Mientras estén aquí, el drenado los salta. */
  const esperandoDestinatarioRef = useRef<Set<string>>(new Set());
  const [pideFactura, setPideFactura] = useState<
    | { clase: "voluntario"; metodo: "tarjeta" | "efectivo"; importe: Dinero }
    | { clase: "obligatorio"; intentId: string; importe: Dinero }
    | null
  >(null);
  const [errorFactura, setErrorFactura] = useState<string | null>(null);

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

  const resolveDetallesForCobroIntent = useCallback((intent: PendingCobroIntent): string[] | null => {
    const detalleMap = detalleIdByTicketIdRef.current;

    const detalles = intent.ticketItemIds.map((ticketItemId, idx) => {
      const fromMap = String(detalleMap[ticketItemId] ?? "").trim();
      if (fromMap) return fromMap;

      const fromStored = String(intent.detalleIds?.[idx] ?? "").trim();
      if (fromStored) return fromStored;

      return parseDetalleIdFromTicketItemId(ticketItemId);
    });

    if (detalles.length !== intent.ticketItemIds.length) return null;
    if (detalles.some((s) => !s)) return null;

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
        [item.id]: String(item.detalleId ?? "").trim(),
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
        [item.id]: String(item.detalleId ?? "").trim(),
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
    (lineas: LineaComandaRow[], opts?: LoadTicketOpts): TicketItem[] => {
      const map: Record<string, string> = {};

      const ui: TicketItem[] = lineas.map((l) => {
        const idDetalle = String(l.ID_Detalle ?? "").trim();
        const id = makeDetalleTicketId(idDetalle);

        map[id] = idDetalle;

        return {
          id,
          detalleId: idDetalle,
          productoId: l.ID_Producto,
          nombre: l.Nombre || "Producto",
          precio: escalar(l.Precio_Unitario, l.Cantidad || 1),
          pagado: l.Pagado === 1,
          seleccionado: false,
          categoriaNombre: getCategoriaNombreParaProducto(String(l.ID_Producto ?? "")),
          notas: l.Notas ?? null,
          // Tipo de IVA congelado en la línea al venderla (null = el del negocio). Va al ticket.
          ivaPercent: l.IVA_Percent ?? null,
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
    [getCategoriaNombreParaProducto, setSeleccionadosLocal],
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

      const idDetalle = String(mergedItem.detalleId ?? "").trim();

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
              const mapped = String(nextDetalleMap[id] ?? "").trim();
              if (mapped) return mapped;

              const stored = String(intent.detalleIds?.[idx] ?? "").trim();
              if (stored) return stored;

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
    if (!ticket.length) return;

    let changed = false;
    const nextTicket = ticket.map((item) => {
      if (String(item.categoriaNombre ?? "").trim()) return item;

      const resolved = getCategoriaNombreParaProducto(item.productoId);
      if (resolved) {
        changed = true;
        return { ...item, categoriaNombre: resolved };
      }

      return item;
    });

    if (changed) {
      ticketRef.current = nextTicket;
      setTicket(nextTicket);
    }
  }, [getCategoriaNombreParaProducto, ticket]);

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

  const abrirDetalleProducto = useCallback((productId: string) => {
    setProductDetailId(productId);
    setOpenProductDetail(true);
  }, []);

  const cerrarDetalleProducto = useCallback(() => {
    setOpenProductDetail(false);
    setProductDetailId(null);
  }, []);

  const cargarCategorias = useCallback(async () => {
    try {
      const rows = await vrListCategoriasVendibles();

      const procesadas: CategoriaDisplay[] = await Promise.all(
        rows.map(async (cat) => ({
          ...cat,
          urlImagen: await resolveImageUrl(cat.Ruta_Imagen),
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
      const idCat = cat.ID_Categoria;
      const rows = await vrListProductosByCategoria(idCat);

      const procesados: ProductoDisplay[] = await Promise.all(
        rows.map(async (p) => ({
          ...p,
          urlImagen: await resolveImageUrl(p.Ruta_Imagen),
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
      const rows = await vrSearchProductos(safeQ, 60);

      const procesados: ProductoDisplay[] = await Promise.all(
        rows.map(async (p) => ({
          ...p,
          urlImagen: await resolveImageUrl(p.Ruta_Imagen),
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

        const rows = await vrListComandasBarra({
          includePagadas,
          limit: includePagadas ? 200 : 60,
        });
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
    async (idComanda: string, opts?: LoadTicketOpts): Promise<TicketItem[]> => {
      try {
        const lineas = await vrGetLineasComanda(idComanda);
        return applyLineasToTicketPanel(lineas, opts);
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
      idComanda: string,
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

  // Sincronización nube → Main: al aplicarse un cambio recibido por WebSocket, recargar el
  // ticket SOLO si el cambio afecta a la comanda abierta (no la que edite otro dispositivo).
  // Usa el camino "seguro" (queueComandaRefresh respeta las escrituras locales pendientes, no
  // interrumpe al cajero). La barra de comandas sí se mantiene al día.
  const syncTick = useSyncSignal((s) => s.tick);
  useEffect(() => {
    if (!syncTick) return;
    const info = useSyncSignal.getState().comanda;
    const id = idComandaActivaRef.current;
    if (id && shouldReloadTicket(info, id)) {
      queueComandaRefresh(id, { refreshTicket: true, refreshComandas: true });
    } else if (info.touchedComanda) {
      // El cambio tocó otra comanda (o no hay ticket abierto): refrescar solo la barra.
      void refreshComandasBarra({ silent: true, includePagadas: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTick]);

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
      const boot = await vrBootstrap(idTrabajadorAuth ?? null);

      const categoriasProcesadas: CategoriaDisplay[] = await Promise.all(
        boot.categorias.map(async (cat: CategoriaRow) => ({
          ...cat,
          urlImagen: await resolveImageUrl(cat.Ruta_Imagen),
        })),
      );

      const idComanda = boot.idComanda.trim();

      if (!idComanda) {
        throw new Error("bootstrap_id_comanda_missing");
      }

      setCategorias(categoriasProcesadas);
      setIdComandaActiva(idComanda);
      idComandaActivaRef.current = idComanda;

      applyLineasToTicketPanel(boot.lineas);
    } catch (e) {
      console.error("Fallo bootstrap venta rápida, usando flujo anterior:", e);
      // Se captura como excepción en Sentry (no sólo breadcrumb) para que aparezca como issue
      // con traza, aunque el flujo se recupere con el camino anterior.
      captureException(e, { flujo: "vrBootstrap" });

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
    (ticketItemIds: string[], detalles: string[]) => {
      const ids = new Set(ticketItemIds);
      const detalleIds = new Set(detalles.map((n) => String(n ?? "").trim()).filter((n) => n.length > 0));

      setTicket((prev) => {
        const next = prev.map((t) => {
          const currentDetalleId = String(detalleIdByTicketIdRef.current[t.id] ?? t.detalleId ?? "").trim();

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
      (intent) =>
        !runningCobrosRef.current.has(intent.id) &&
        // Un intent parado esperando el NIF del cliente no se reintenta: volvería a ser rechazado
        // cada 500 ms, en bucle y con el formulario abierto delante.
        !esperandoDestinatarioRef.current.has(intent.id),
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
            Una sola llamada: el cobro descuenta el stock (lotes y suelto) y
            deja su traza en la misma transacción idempotente.
          */
          const pago = await vrCobrarFraccionado({
            idComanda: intent.idComanda,
            metodo: metodoDb,
            importeTotal: intent.importeTotal,
            detalles: detallesUsados,
            idPago: intent.idPago,
            destinatario: intent.destinatario ?? undefined,
          });

          if (pago?.numeroTicket) {
            // Datos del ticket recién emitido: con ellos, imprimir saca un ticket de venta
            // numerado en vez de una precuenta.
            setDatosTicket({
              numeroTicket: pago.numeroTicket,
              metodoPago: metodoDb === "Tarjeta" ? "Tarjeta" : "Efectivo",
              origen: "Barra",
            });
          }

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
          // FISCAL-01: aquí es donde el cobro ha salido de verdad (el intent se encoló antes, de
          // forma optimista). Si el equipo lleva tres días sin remitir, el aviso sale ahora.
          anunciarCobro();
        } catch (e) {
          console.error("Error cobrando venta rápida:", e);

          // El importe pasa del límite de la simplificada y falta el destinatario. No es un fallo
          // del cobro: es un dato que falta. El intent se CONSERVA —con sus líneas marcadas— y se
          // para hasta que alguien escriba el NIF; deshacerlo obligaría a volver a seleccionar las
          // líneas con el cliente delante.
          if (esError(e, "factura_completa_requerida")) {
            esperandoDestinatarioRef.current.add(intent.id);
            setErrorFactura(null);
            setPideFactura({
              clase: "obligatorio",
              intentId: intent.id,
              importe: intent.importeTotal,
            });
            return;
          }

          setPendingCobrosLocal((prev) => prev.filter((x) => x.id !== intent.id));
          rollbackTicketItemsPaidLocal(intent.ticketItemIds, detallesUsados);

          // El motivo, no un «Error» a secas. `AppErrorDto.message` ya viene del catálogo de
          // `ErrorCode` escrito para humanos y en castellano, así que decirlo cuesta lo mismo que
          // callarlo — y la diferencia es enorme cuando lo que pasa es que faltan los datos
          // fiscales del negocio y ningún cobro va a entrar hasta que alguien los rellene
          // (FIS-01). Con «Error» a secas, el camarero repite el cobro cuatro veces.
          toast.error(
            "No se pudo cobrar",
            `${toAppError(e).message} He devuelto esas líneas a pendiente.`,
          );

          if (idComandaActivaRef.current === intent.idComanda) {
            queueComandaRefresh(intent.idComanda, {
              refreshTicket: true,
              refreshComandas: false,
            });
          }
        } finally {
          runningCobrosRef.current.delete(intent.id);

          // Se cuentan los REMITIBLES, no los pendientes: con un intent parado esperando un NIF,
          // mirar sólo el tamaño de la cola dejaría un temporizador girando cada 500 ms para nada.
          const hayRemitibles = pendingCobrosRef.current.some(
            (x) => !esperandoDestinatarioRef.current.has(x.id),
          );
          if (hayRemitibles) {
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
        (intent) =>
          !esperandoDestinatarioRef.current.has(intent.id) &&
          resolveDetallesForCobroIntent(intent) === null,
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
    async (detalleId: string, nota: string) => {
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
        const ok = await vrUpdateNotaDetalle(detalleId, clean);

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
    () => sumaImportes(ticket.filter((t) => !t.pagado).map((t) => t.precio)),
    [ticket],
  );

  const haySeleccion = useMemo(
    () => ticket.some((t) => !t.pagado && seleccionados.has(t.id)),
    [ticket, seleccionados],
  );

  const totalSeleccionado = useMemo(
    () =>
      sumaImportes(
        ticket.filter((t) => !t.pagado && seleccionados.has(t.id)).map((t) => t.precio),
      ),
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
    const m = new Map<string, number>();

    for (const t of ticket) {
      if (t.pagado) continue;
      m.set(t.productoId, (m.get(t.productoId) ?? 0) + 1);
    }

    return m;
  }, [ticket]);

  const getQty = useCallback((id: string) => qtyByProductId.get(id) ?? 0, [qtyByProductId]);

  const getQtyZero = useCallback((_id: string) => 0, []);

  const addProductoToTicket = useCallback(
    async (p: ProductoDisplay) => {
      const idProducto = p.ID_Producto;
      const precio = p.Precio_Venta;
      const tempId = makeTempTicketId();
      const categoriaNombre =
        getCategoriaNombreParaProducto(idProducto) ||
        String(
          p.ID_Categoria && categoriaNombreById[String(p.ID_Categoria)]
            ? categoriaNombreById[String(p.ID_Categoria)]
            : "",
        ).trim() ||
        (categoriaSeleccionada?.ID_Categoria === p.ID_Categoria && categoriaSeleccionada?.Nombre
          ? categoriaSeleccionada.Nombre
          : null);

      const tempItem: TicketItem = {
        id: tempId,
        detalleId: "",
        productoId: idProducto,
        nombre: String(p.Nombre ?? "Producto"),
        precio,
        pagado: false,
        seleccionado: false,
        categoriaNombre,
        notas: null,
      };

      addTicketItemLocal(tempItem);
      beginTicketWrite();

      let idComanda: string | null = null;
      let success = false;
      let needsReconcile = false;

      try {
        idComanda = await ensureComandaActiva();

        const result = await vrAddLineaComanda(idComanda, idProducto, 1);

        if (!result?.ok) {
          throw new Error("No se pudo insertar la línea.");
        }

        if (cancelledAddTempIdsRef.current.has(tempId)) {
          await vrRemoveLastUnpaidLinea(idComanda, idProducto);
          success = true;
          emitVrChanged();
          return;
        }

        const idDetalle = String(result.idDetalle ?? "").trim();

        if (idDetalle) {
          // El precio de verdad es el que ha puesto el backend desde el catálogo; el de la
          // carta en caché puede haberse quedado viejo (RI-27).
          replaceTicketItemLocal(tempId, {
            ...tempItem,
            id: makeDetalleTicketId(idDetalle),
            detalleId: idDetalle,
            precio: result.precioUnitario,
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
    async (productoId: string) => {
      const idProducto = productoId;

      const item = [...ticketRef.current]
        .reverse()
        .find((t) => !t.pagado && t.productoId === idProducto);

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

      const idDetalle = String(item.detalleId ?? "").trim();

      if (!idDetalle) {
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
    async (
      _metodo: "tarjeta" | "efectivo",
      destinatario?: DestinatarioInput | null,
    ) => {
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

      // Camino voluntario: se pidió factura y aún no hay datos. Se preguntan ANTES de encolar el
      // intent, porque una vez cobrado convertir el ticket en factura ya es otra operación (una F3
      // sustitutiva, desde Cuentas).
      if (quiereFactura && !destinatario) {
        const importe = sumaImportes(seleccionadosItems.map((it) => it.precio));
        setErrorFactura(null);
        setPideFactura({ clase: "voluntario", metodo: _metodo, importe });
        return;
      }

      // REV-17: el cobrador ya no se mete en el intent. Lo pone el backend desde la sesión, así
      // que un cobro que se reintenta al volver de un cierre inesperado queda a nombre de quien
      // tiene la sesión abierta entonces — que es quien está delante del cajón.
      try {
        const idComanda = await ensureComandaActiva();

        const detalleIds = seleccionadosItems.map((it) => {
          const fromItem = String(it.detalleId ?? "").trim();
          if (fromItem) return fromItem;

          const fromMap = String(detalleIdByTicketIdRef.current[it.id] ?? "").trim();
          if (fromMap) return fromMap;

          return parseDetalleIdFromTicketItemId(it.id);
        });

        if (detalleIds.some((s) => !s)) {
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

        const importeTotal = sumaImportes(seleccionadosItems.map((it) => it.precio));

        const ticketItemIds = seleccionadosItems.map((it) => it.id);

        const intentId = makeTempTicketId();

        const intent: PendingCobroIntent = {
          id: intentId,
          idComanda,
          metodo: _metodo,
          ticketItemIds,
          detalleIds,
          importeTotal,
          idPago: crypto.randomUUID(),
          createdAtMs: Date.now(),
          destinatario: destinatario ?? null,
        };

        setPendingCobrosLocal((prev) => [
          ...prev.filter((x) => {
            const prevIds = new Set(x.ticketItemIds);
            const prevDetalles = new Set(x.detalleIds.map((n) => String(n ?? "").trim()).filter((n) => n.length > 0));

            return !ticketItemIds.some((id, idx) => {
              const detalleId = String(detalleIds[idx] ?? "").trim();
              return prevIds.has(id) || prevDetalles.has(detalleId);
            });
          }),
          intent,
        ]);

        markTicketItemsAsPaidLocal(ticketItemIds);

        setCashCount({});
        setPaso("categorias");
        setSeleccionadosLocal(new Set());
        setQuiereFactura(false);
        setPideFactura(null);
        setErrorFactura(null);

        queueFlushPendingCobros();
        emitVrChanged();
      } catch (e) {
        console.error("Error preparando cobro venta rápida:", e);
        toast.error("Error", "No se pudo preparar el cobro.");
      }
    },
    [
      quiereFactura,
      hasPendingTicketWrites,
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

  /**
   * Los datos del cliente ya están. Según de dónde se venga, son dos cosas distintas:
   *
   *   · VOLUNTARIO — el cobro no ha salido todavía: se encola con el destinatario dentro.
   *   · OBLIGATORIO — el intent ya está en la cola y parado: se le añade el dato y se suelta. No se
   *     vuelve a encolar nada, porque el `idPago` es el mismo y la idempotencia del backend es
   *     por ahí: reencolar crearía un segundo intent para el mismo cobro.
   */
  const confirmarFactura = useCallback(
    async (d: DestinatarioInput) => {
      const p = pideFactura;
      if (!p) return;

      if (p.clase === "voluntario") {
        await cobrar(p.metodo, d);
        return;
      }

      setPendingCobrosLocal((prev) =>
        prev.map((x) =>
          x.id === p.intentId
            ? {
                  ...x,
                  destinatario: d,
              }
            : x,
        ),
      );
      esperandoDestinatarioRef.current.delete(p.intentId);
      setPideFactura(null);
      setErrorFactura(null);
      setQuiereFactura(false);
      queueFlushPendingCobros();
    },
    [pideFactura, cobrar, setPendingCobrosLocal, queueFlushPendingCobros],
  );

  /**
   * Se cierra el formulario sin datos.
   *
   * En el camino OBLIGATORIO hay que deshacer: el intent está en la cola con sus líneas marcadas
   * como cobradas y ese cobro no va a poder salir nunca. Dejarlo ahí sería una venta que el ticket
   * da por cobrada y que no existe. Las líneas vuelven a pendiente y el camarero decide —el cliente
   * puede ir a buscar el NIF, o cobrar por partes por debajo del límite—.
   */
  const cancelarFactura = useCallback(() => {
    const p = pideFactura;
    setPideFactura(null);
    setErrorFactura(null);
    setQuiereFactura(false);
    if (!p || p.clase !== "obligatorio") return;

    const intent = pendingCobrosRef.current.find((x) => x.id === p.intentId);
    esperandoDestinatarioRef.current.delete(p.intentId);
    setPendingCobrosLocal((prev) => prev.filter((x) => x.id !== p.intentId));
    if (intent) {
      rollbackTicketItemsPaidLocal(intent.ticketItemIds, intent.detalleIds);
      toast.info(
        "Cobro deshecho",
        "Ese importe necesita factura con NIF. He devuelto las líneas a pendiente.",
      );
      if (idComandaActivaRef.current === intent.idComanda) {
        queueComandaRefresh(intent.idComanda, {
          refreshTicket: true,
          refreshComandas: false,
        });
      }
    }
  }, [
    pideFactura,
    setPendingCobrosLocal,
    rollbackTicketItemsPaidLocal,
    queueComandaRefresh,
    toast,
  ]);

  const totalEfectivo = useMemo(() => totalRecuento(DENOMS_COBRO, cashCount), [cashCount]);

  const totalACobrar = useMemo(() => (haySeleccion ? totalSeleccionado : CERO), [
    haySeleccion,
    totalSeleccionado,
  ]);

  const diferencia = useMemo(
    () => cambioDelCobro(totalEfectivo, totalACobrar),
    [totalEfectivo, totalACobrar],
  );

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

  // Sincronización nube → catálogo: al llegar un cambio por WebSocket (`syncTick`) que afecte
  // al catálogo (productos/categorías/stock), recargar SOLO la vista de catálogo visible
  // (búsqueda / productos de la categoría abierta / grid de categorías). Va en un efecto aparte
  // del ticket a propósito: se refresca sin tocar el ticket ni el resto de la pantalla (buena
  // UX). Si el cambio fue solo de una comanda, no recargamos el catálogo.
  useEffect(() => {
    if (!syncTick) return;
    if (!useSyncSignal.getState().comanda.touchedCatalog) return;
    void onProductoGuardado();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTick]);

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

    // Nulificar la ref antes del await: si el usuario toca un producto mientras Rust procesa,
    // ensureComandaActiva esperará esta promesa en vez de usar la ref obsoleta (race → FK error).
    idComandaActivaRef.current = null;
    const p = vrCreateComandaBarra(idTrabajadorAuth ?? null).then((idNew) => {
      setIdComandaActiva(idNew);
      idComandaActivaRef.current = idNew;
      return idNew;
    });
    ensureComandaPromiseRef.current = p;

    try {
      await p;

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
    } finally {
      ensureComandaPromiseRef.current = null;
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

      const idComanda = id;

      if (!idComanda) return;

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
        const idComanda = id;

        if (!idComanda) return;

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

      const idComanda = id;

      if (!idComanda) return;

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
    (id: string) => void removeProductoFromTicket(id),
    [removeProductoFromTicket],
  );

  const onOpenProductDetailCb = useCallback(
    (id: string) => abrirDetalleProducto(id),
    [abrirDetalleProducto],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface py-3 pl-16 pr-3 sm:flex-row sm:items-center sm:justify-between sm:pl-16 sm:pr-4 lg:px-4">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-extrabold text-fg sm:text-xl">Venta rápida</h1>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <button
            type="button"
            onClick={conAviso(nuevoTicket)}
            className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98] cursor-pointer"
          >
            <Plus className="size-4" aria-hidden />
            Nuevo ticket
          </button>

          <button
            type="button"
            onClick={conAviso(abrirVerTickets)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98] cursor-pointer",
              loadingComandas && "opacity-60",
            )}
          >
            <ReceiptText className="size-4" aria-hidden />
            Ver tickets
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 touch-pan-y auto-rows-max grid-cols-1 content-start gap-3 overflow-y-scroll overscroll-contain p-3 [scrollbar-gutter:stable] lg:auto-rows-auto lg:content-stretch lg:grid-cols-[minmax(0,1fr)_minmax(360px,38vw)] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex h-[clamp(20rem,58dvh,44rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface md:h-[clamp(24rem,62dvh,44rem)] lg:h-auto">
          <div className="border-b border-border bg-surface p-3">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <h2 className="truncate text-base font-bold text-fg sm:text-lg">{leftTitle}</h2>
                <p className="text-xs text-fg-muted sm:text-sm">{leftSubtitle}</p>
              </div>

              <div className="flex min-w-0 flex-col gap-2 xs:flex-row xs:items-center">
                {categoriaSeleccionada && paso !== "efectivo" && (
                  <button
                    type="button"
                    onClick={() => setCategoriaSeleccionada(null)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
                  >
                    <ArrowLeft className="size-4" aria-hidden />
                    Categorías
                  </button>
                )}

                <SearchInput
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Buscar producto..."
                  className="w-full xs:w-48 sm:w-64"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {paso === "efectivo" ? (
              <CashPanel
                denoms={DENOMS_COBRO}
                cashCount={cashCount}
                totalACobrar={totalACobrar}
                totalEfectivo={totalEfectivo}
                diferencia={diferencia}
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
              />
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
          <TicketPanel
            datosTicket={datosTicket}
            ticket={ticketForPanel}
            paso={paso}
            totalPendiente={totalPendiente}
            totalSeleccionado={totalSeleccionado}
            haySeleccion={haySeleccion}
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
              setQuiereFactura(false);
            }}
            quiereFactura={quiereFactura}
            onQuiereFacturaChange={setQuiereFactura}
            onGuardarNota={onGuardarNota}
          />
        </div>
      </div>

      <AddProductModal
        open={openAddProduct}
        onClose={() => setOpenAddProduct(false)}
        categoriaPreseleccionadaId={
          categoriaSeleccionada ? categoriaSeleccionada.ID_Categoria : null
        }
        onSaved={conAviso(async () => {
          await onProductoGuardado();
        })}
      />

      <ProductDetailModal
        open={openProductDetail}
        onClose={cerrarDetalleProducto}
        productId={productDetailId}
      />

      <DatosFiscalesModal
        open={pideFactura !== null}
        onClose={cancelarFactura}
        onConfirmar={confirmarFactura}
        importe={pideFactura?.importe ?? CERO}
        limite={limiteSimplif}
        obligatorio={pideFactura?.clase === "obligatorio"}
        error={errorFactura}
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
