import { useColaOperaciones } from "../../shared/lib/useColaOperaciones";
import { useCobrosPendientes } from "../../features/ventaRapida/useCobrosPendientes";
import CobrosPendientesModal from "../../features/ventaRapida/ui/CobrosPendientesModal";
import { usePermisos } from "../../shared/lib/usePermisos";
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
import type { CobroImprimible } from "../../shared/ticket/PrintTicketModal";
import VerTicketsModal from "../../features/ventaRapida/ui/VerTicketsModal";

import ProductDetailModal from "../../features/InventaryComponents/ProductDetailModal";
import DatosFiscalesModal, {
} from "../../shared/ticket/DatosFiscalesModal";
import { anunciarCobro } from "../../shared/ticket/AvisoFiscalModal";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { commands, esError, toAppError } from "@tpv/client";

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
  vrDeleteComandaIfSafe,
} from "../../features/ventaRapida/ventaRapidaAPI";
import { conAviso } from "../../shared/lib/conAviso";
import type {
  CategoriaRow,
  CobroPendienteDto,
  ComandaBarraRow,
  DestinatarioInput,
  Dinero,
  LineaComandaRow,
} from "@tpv/contracts";
import { CERO, escalar } from "../../shared/lib/dinero";
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

function makeDetalleTicketId(idDetalle: string): string { return `detalle-${idDetalle}`; }

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
  const { cola, pendientes: escriturasPendientes } = useColaOperaciones();
  const recuperacion = useCobrosPendientes();
  const recargarPendientes = recuperacion.recargar;
  const [openPendientes, setOpenPendientes] = useState(false);
  const cobroEnCursoRef = useRef(false);
  const [cobrando, setCobrando] = useState(false);

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
  // El último cobro de la venta en curso: su ticket lo compone Rust desde el pago (RI-29). Sin él,
  // lo único que se imprime es una precuenta.
  const [ultimoCobro, setUltimoCobro] = useState<CobroImprimible | null>(null);
  const [cashCount, setCashCount] = useState<Record<string, number>>({});
  const { puede } = usePermisos();
  const [openAddProduct, setOpenAddProduct] = useState(false);

  const [openProductDetail, setOpenProductDetail] = useState(false);
  const [productDetailId, setProductDetailId] = useState<string | null>(null);

  const [seleccionados, setSeleccionados] = useState<Set<string>>(() => new Set());
  const seleccionadosRef = useRef<Set<string>>(new Set());

  const [openVerTickets, setOpenVerTickets] = useState(false);
  const [comandasBarra, setComandasBarra] = useState<ComandaBarraRow[]>([]);
  const [loadingComandas, setLoadingComandas] = useState(false);

  const [idComandaActiva, setIdComandaActiva] = useState<string | null>(null);
  // Otra venta, otro papel: el cobro de la anterior no se ofrece para imprimir en ésta (RI-29).
  useEffect(() => {
    setUltimoCobro(null);
  }, [idComandaActiva]);
  const idComandaActivaRef = useRef<string | null>(null);
  const ensureComandaPromiseRef = useRef<Promise<string> | null>(null);

  const didInitRef = useRef(false);

  const limite_simplif = useBusinessSettings((st) => st.limite_simplif);
  const [quiereFactura, setQuiereFactura] = useState(false);
  const [pideFactura, setPideFactura] = useState<
    | { clase: "voluntario"; metodo: "tarjeta" | "efectivo"; importe: Dinero }
    | { clase: "obligatorio"; idPago: string; importe: Dinero }
    | null
  >(null);
  const [errorFactura, setErrorFactura] = useState<string | null>(null);

  const syncTimerRef = useRef<number | null>(null);
  const syncRunIdRef = useRef(0);
  const lecturaTicketRef = useRef(0);

  const hasPendingTicketWrites = useCallback(() => cola.pendientes() > 0 || cobroEnCursoRef.current, [cola]);
  const warnPendingTicketWrites = useCallback(() => toast.info("Espera un momento", "Se está confirmando el ticket."), [toast]);

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

  const clearTicketLocal = useCallback(() => {
    ticketRef.current = [];
    setTicket([]);
    setSeleccionadosLocal(new Set());
  }, [setSeleccionadosLocal]);

  const applyLineasToTicketPanel = useCallback(
    (lineas: LineaComandaRow[], opts?: LoadTicketOpts): TicketItem[] => {

      const ui: TicketItem[] = lineas.map((l) => {
        const idDetalle = String(l.ID_Detalle ?? "").trim();
        const id = makeDetalleTicketId(idDetalle);


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
          iva_percent: l.IVA_Percent ?? null,
        };
      });

      const selectableIds = new Set(ui.filter((t) => !t.pagado).map((t) => t.id));

      ticketRef.current = ui;

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
      const lectura = ++lecturaTicketRef.current;
      try {
        const lineas = await vrGetLineasComanda(idComanda);
        if (lectura !== lecturaTicketRef.current || idComandaActivaRef.current !== idComanda) return [];
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

        if (cola.pendientes() > 0 || cobroEnCursoRef.current) {
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
    [cargarComandaEnTicketPanel, openVerTickets, refreshComandasBarra, cola],
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

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    void cargarBootstrapInicial();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const onGuardarNota = useCallback(async (detalleId: string, nota: string) => {
    if (cobroEnCursoRef.current) return;
    await cola.ejecutar(async () => {
      const id = idComandaActivaRef.current;
      if (!id || cobroEnCursoRef.current) return;
      if (recuperacion.pendientes.some(p => p.cobro.id_comanda === id)) { setOpenPendientes(true); return; }
      ++lecturaTicketRef.current;
      await vrUpdateNotaDetalle(detalleId, nota.trim());
      await cargarComandaEnTicketPanel(id, { keepSelection: true });
      emitVrChanged();
    });
  }, [cola, cargarComandaEnTicketPanel, recuperacion.pendientes]);

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

  const escribirLinea = useCallback(async (operacion: (id: string) => Promise<unknown>) => {
    if (cobroEnCursoRef.current) return;
    await cola.ejecutar(async () => {
      const id = await ensureComandaActiva();
      ++lecturaTicketRef.current;
      if (recuperacion.pendientes.some(p => p.cobro.id_comanda === id)) {
        setOpenPendientes(true);
        toast.info("Cobro pendiente", "Resuelve o descarta el cobro antes de modificar estas líneas.");
        return;
      }
      try {
        await operacion(id);
        await cargarComandaEnTicketPanel(id, { keepSelection: true });
        emitVrChanged();
      } catch (e) { toast.error("No se pudo modificar el ticket", toAppError(e).message); }
    });
  }, [cola, ensureComandaActiva, cargarComandaEnTicketPanel, recuperacion.pendientes, toast]);

  const addProductoToTicket = useCallback((p: ProductoDisplay) => escribirLinea(id => vrAddLineaComanda(id, p.ID_Producto, 1)), [escribirLinea]);
  const removeProductoFromTicket = useCallback((productoId: string) => escribirLinea(id => vrRemoveLastUnpaidLinea(id, productoId)), [escribirLinea]);
  const eliminarLineaTicket = useCallback((ticketItemId: string) => escribirLinea(id => {
    const item = ticketRef.current.find(t => t.id === ticketItemId);
    return item ? vrDeleteLineaIfUnpaid(id, item.detalleId) : Promise.resolve();
  }), [escribirLinea]);

  const confirmarCobro = useCallback(async (idPago: string, idComanda: string, importe: Dinero, ejecutar: () => Promise<unknown>) => {
    if (cobroEnCursoRef.current || cola.pendientes()) return;
    cobroEnCursoRef.current = true;
    ++lecturaTicketRef.current;
    setCobrando(true);
    try {
      await ejecutar();
      setOpenPendientes(false);
      if (idComandaActivaRef.current === idComanda) {
        await cargarComandaEnTicketPanel(idComanda);
        setUltimoCobro({ idPago });
        setCashCount({}); setPaso("categorias"); setQuiereFactura(false);
      }
      setPideFactura(null); setErrorFactura(null);
      anunciarCobro(); emitVrChanged();
    } catch (e) {
      if (esError(e, "factura_completa_requerida")) {
        setOpenPendientes(false);
        setPideFactura({ clase: "obligatorio", idPago, importe });
        setErrorFactura(null);
      } else {
        setErrorFactura(toAppError(e).message);
        toast.error("No se pudo cobrar", `${toAppError(e).message} El cobro queda pendiente de resolver.`);
      }
    } finally {
      await recargarPendientes();
      cobroEnCursoRef.current = false;
      setCobrando(false);
    }
  }, [cola, cargarComandaEnTicketPanel, recargarPendientes, toast]);

  const cobrar = useCallback(async (metodo: "tarjeta" | "efectivo", destinatario?: DestinatarioInput | null) => {
    if (hasPendingTicketWrites()) { warnPendingTicketWrites(); return; }
    const seleccion = ticketRef.current.filter(t => !t.pagado && seleccionadosRef.current.has(t.id));
    if (!seleccion.length) return;
    const importe = sumaImportes(seleccion.map(t => t.precio));
    if (quiereFactura && !destinatario) { setPideFactura({ clase: "voluntario", metodo, importe }); return; }
    const idComanda = idComandaActivaRef.current;
    if (!idComanda) return;
    if (recuperacion.pendientes.some(p => p.cobro.id_comanda === idComanda)) { setOpenPendientes(true); return; }
    const idPago = crypto.randomUUID();
    await confirmarCobro(idPago, idComanda, importe, () => commands.vrCobrarFraccionado({
      id_pago: idPago, id_comanda: idComanda, metodo: metodo === "tarjeta" ? "Tarjeta" : "Efectivo",
      importe_total: importe, detalles: seleccion.map(t => t.detalleId), destinatario,
    }));
  }, [hasPendingTicketWrites, warnPendingTicketWrites, quiereFactura, recuperacion.pendientes, confirmarCobro]);

  const resolverPendiente = useCallback(async (p: CobroPendienteDto, destinatario?: DestinatarioInput) => {
    await confirmarCobro(p.cobro.id_pago, p.cobro.id_comanda, p.cobro.importe_total,
      () => commands.vrResolverCobroPendiente({ id_pago: p.cobro.id_pago, destinatario }));
  }, [confirmarCobro]);

  const confirmarFactura = useCallback(async (d: DestinatarioInput) => {
    if (!pideFactura) return;
    if (pideFactura.clase === "voluntario") { await cobrar(pideFactura.metodo, d); return; }
    const p = recuperacion.pendientes.find(p => p.cobro.id_pago === pideFactura.idPago);
    if (p) await resolverPendiente(p, d);
  }, [pideFactura, cobrar, recuperacion.pendientes, resolverPendiente]);
  const cancelarFactura = useCallback(() => {
    if (cobroEnCursoRef.current) return;
    setPideFactura(null); setErrorFactura(null); setQuiereFactura(false);
  }, []);

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


    setOpenVerTickets(true);
    await refreshComandasBarra({ includePagadas: true });
  }, [hasPendingTicketWrites, refreshComandasBarra, toast, warnPendingTicketWrites]);

  const abrirTicketDesdeModal = useCallback(
    async (id: string) => {
      if (hasPendingTicketWrites()) {
        warnPendingTicketWrites();
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

      {escriturasPendientes > 0 || cobrando ? <p role="status" className="px-4 text-sm text-fg-muted">{cobrando ? "Confirmando cobro…" : "Guardando ticket…"}</p> : null}
      {recuperacion.main && (recuperacion.pendientes.length > 0 || recuperacion.error) ? <button onClick={() => setOpenPendientes(true)} className="px-4 py-2 text-left text-sm text-danger">Cobros pendientes ({recuperacion.pendientes.length}){recuperacion.error ? ` · ${recuperacion.error}` : ""}</button> : null}
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
                ocupado={cobrando}
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
                onOpenAddProduct={puede("catalogo.editar") && puede("catalogo.precios") ? onOpenAddProductCb : undefined}
              />
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
          <TicketPanel
            ocupado={cobrando || escriturasPendientes > 0}
            ultimoCobro={ultimoCobro}
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
        limite={limite_simplif}
        obligatorio={pideFactura?.clase === "obligatorio"}
        error={errorFactura}
        guardando={cobrando}
        inicial={pideFactura?.clase === "obligatorio" ? recuperacion.pendientes.find(p => p.cobro.id_pago === pideFactura.idPago)?.cobro.destinatario : null}
      />

      <CobrosPendientesModal open={openPendientes} onClose={() => setOpenPendientes(false)} pendientes={recuperacion.pendientes} ocupado={cobrando}
        onEditarFactura={p => { setOpenPendientes(false); setErrorFactura(null); setPideFactura({ clase: "obligatorio", idPago: p.cobro.id_pago, importe: p.cobro.importe_total }); }}
        onResolver={resolverPendiente} onCancelar={async p => { await commands.vrCancelarCobroPendiente(p.cobro.id_pago); await recuperacion.recargar(); }} />
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
