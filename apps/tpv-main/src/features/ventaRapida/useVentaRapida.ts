import { useCatalogoServicio } from "../../shared/lib/useCatalogoServicio";
import { useColaOperaciones } from "../../shared/lib/useColaOperaciones";
import { useCobrosPendientes } from "./useCobrosPendientes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveImageUrl } from "../../shared/lib/imageUrl";
import { shouldReloadTicket } from "../../shared/lib/syncStatements";
import { captureException } from "../../shared/observability/sentry";
import { useAuth } from "../../shared/stores/useAuth";
import { useSyncSignal } from "../../shared/stores/useSyncSignal";
import { useMode } from "../../shared/stores/useMode";
import { useToast } from "../../shared/toast";

import type { CobroImprimible } from "../../shared/ticket/PrintTicketModal";

import { commands, esError, toAppError } from "@tpv/client";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";

import {
CategoriaDisplay,
Paso,
ProductoDisplay,
TicketItem,
} from "./types";

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
import {
vrAddLineaComanda,
vrBootstrap,
vrCreateComandaBarra,
vrDeleteComandaIfSafe,
vrDeleteLineaIfUnpaid,
vrGetLineasComanda,
vrGetOrCreateComandaBarra,
vrListCategoriasVendibles,
vrListComandasBarra,
vrListProductosByCategoria,
vrRemoveLastUnpaidLinea,
vrSearchProductos,
vrUpdateNotaDetalle,
} from "./ventaRapidaAPI";
import { mesasUpdateDetalleIngredientes } from "../mesas/mesasApi";
import type { CambioIngredienteInput } from "@tpv/contracts";

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

const apiCatalogo = { categorias: vrListCategoriasVendibles, productos: vrListProductosByCategoria, buscar: vrSearchProductos };

/** RI-47: controlador de venta; la vista consume exclusivamente datos confirmados. */
export function useVentaRapida() {
  const { categorias, setCategorias, categoriaSeleccionada, setCategoriaSeleccionada, productos, loadingProductos,
    query, setQuery, q, busqueda, loadingBusqueda, cargarCategorias, cargarProductosDeCategoria, buscarProductosPorNombre } = useCatalogoServicio(true, apiCatalogo, false);

  const toast = useToast();

  const idTrabajadorAuth = useAuth((s) => s.idTrabajador);
  const { cola, pendientes: escriturasPendientes } = useColaOperaciones();
  const recuperacion = useCobrosPendientes();
  const recargarPendientes = recuperacion.recargar;
  const [openPendientes, setOpenPendientes] = useState(false);
  const cobroEnCursoRef = useRef(false);
  const [cobrando, setCobrando] = useState(false);


  const [ticket, setTicket] = useState<TicketItem[]>([]);
  const ticketRef = useRef<TicketItem[]>([]);

  const [paso, setPaso] = useState<Paso>("categorias");
  // El último cobro de la venta en curso: su ticket lo compone Rust desde el pago (RI-29). Sin él,
  // lo único que se imprime es una precuenta.
  const [ultimoCobro, setUltimoCobro] = useState<CobroImprimible | null>(null);
  const [cashCount, setCashCount] = useState<Record<string, number>>({});

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
          // INC-03: la categoría viene con la línea. Deducirla de los productos que la pantalla tenía
          // cargados dejaba en «Sin categoría» lo de otras categorías al recargar el ticket.
          categoriaNombre: l.Categoria ?? null,
          notas: l.Notas ?? null,
          cambiosIngredientes: l.Cambios_Ingredientes ?? null,
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
    [setSeleccionadosLocal],
  );

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
        if (!silent) {
          toast.error("No se pudieron cargar los tickets", toAppError(e).message);
          setComandasBarra([]);
        }
      } finally {
        if (!silent) {
          setLoadingComandas(false);
        }
      }
    },
    [toast],
  );

  const cargarComandaEnTicketPanel = useCallback(
    async (idComanda: string, opts?: LoadTicketOpts): Promise<TicketItem[]> => {
      const lectura = ++lecturaTicketRef.current;
      try {
        const lineas = await vrGetLineasComanda(idComanda);
        if (lectura !== lecturaTicketRef.current || idComandaActivaRef.current !== idComanda) return [];
        return applyLineasToTicketPanel(lineas, opts);
      } catch (e) {
        if (!opts?.silentError) {
          toast.error("No se pudo cargar el ticket", toAppError(e).message);
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
            // Las cargas de dentro ya avisan de lo suyo: lo que llega aquí es un fallo de la pantalla.
            captureException(e, { fase: "refrescar_comanda" });
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
      // Se sigue por el flujo anterior. Se captura como excepción en Sentry (no sólo breadcrumb) para que aparezca como issue
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
    setCategorias,
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

  // Los ingredientes de una línea: el mismo comando que en mesas (es la misma tabla), por la cola.
  const onGuardarIngredientes = useCallback(async (detalleId: string, cambios: CambioIngredienteInput[]) => {
    if (cobroEnCursoRef.current) return;
    await cola.ejecutar(async () => {
      const id = idComandaActivaRef.current;
      if (!id || cobroEnCursoRef.current) return;
      if (recuperacion.pendientes.some(p => p.cobro.id_comanda === id)) { setOpenPendientes(true); return; }
      ++lecturaTicketRef.current;
      await mesasUpdateDetalleIngredientes({ idDetalle: detalleId, cambios });
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
        // Al ticket activo: añadir tras cobrarlo todo pasa a uno nuevo (ver `addProductoToTicket`).
        await cargarComandaEnTicketPanel(idComandaActivaRef.current ?? id, { keepSelection: true });
        emitVrChanged();
      } catch (e) { toast.error("No se pudo modificar el ticket", toAppError(e).message); }
    });
  }, [cola, ensureComandaActiva, cargarComandaEnTicketPanel, recuperacion.pendientes, toast]);

  // INC-20261030-016: un ticket cobrado entero ya no admite líneas (el backend lo rechaza), y
  // después de cobrar se queda a la vista con su ticket para imprimir. Lo que se añade entonces es
  // otra venta: abre un ticket nuevo, como «Nuevo ticket», y va ahí. Antes entraba en el cobrado,
  // donde se quedaba sin cobrar en cuanto se pasaba a otro ticket.
  const addProductoToTicket = useCallback((p: ProductoDisplay) => escribirLinea(async (id) => {
    const cobrado = ticketRef.current.length > 0 && ticketRef.current.every((t) => t.pagado);
    if (!cobrado) {
      await vrAddLineaComanda(id, p.ID_Producto, 1);
      return;
    }
    const nuevo = await vrCreateComandaBarra(idTrabajadorAuth ?? null);
    idComandaActivaRef.current = nuevo;
    setIdComandaActiva(nuevo);
    clearTicketLocal();
    await vrAddLineaComanda(nuevo, p.ID_Producto, 1);
  }), [escribirLinea, idTrabajadorAuth, clearTicketLocal]);
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
      emitVrChanged();
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
      setCategoriaSeleccionada(null);

      emitVrChanged();
    } catch (e) {
      toast.error("No se pudo crear un nuevo ticket", toAppError(e).message);
    } finally {
      ensureComandaPromiseRef.current = null;
    }
  }, [
    setCategoriaSeleccionada,
    setQuery,
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
  }, [hasPendingTicketWrites, refreshComandasBarra, warnPendingTicketWrites]);

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
    [cargarComandaEnTicketPanel, hasPendingTicketWrites, warnPendingTicketWrites],
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
        toast.error("No se pudo eliminar el ticket", toAppError(e).message);
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
      // INC-04: sólo cobra la Main; la pantalla ya no lo ofrece en una Handy.
      if (useMode.getState().mode !== "tpv") return;
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
      warnPendingTicketWrites,
    ],
  );

  const onVolverCb = useCallback(() => setCategoriaSeleccionada(null), [setCategoriaSeleccionada]);

  const onSelectCategoriaCb = useCallback((c: CategoriaDisplay) => {
    setCategoriaSeleccionada(c);
  }, [setCategoriaSeleccionada]);

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

  return {
    nuevoTicket, abrirVerTickets, loadingComandas, escriturasPendientes, cobrando, recuperacion,
    setOpenPendientes, leftTitle, leftSubtitle, paso,
    query, setQuery, cashCount, totalACobrar, totalEfectivo, diferencia,
    addCash, removeCash, resetCash, cobrar, setPaso, setCashCount,
    variant, categorias, productos, busqueda, loadingBusqueda, loadingProductos,
    getQtyZero, getQty, onSelectCategoriaCb, onAddProductoCb, onRemoveProductoCb, onOpenProductDetailCb,
    onVolverCb, ultimoCobro, ticketForPanel, totalPendiente, totalSeleccionado,
    haySeleccion, seleccionaTodoPendiente, toggleSeleccion, eliminarLineaTicket, limpiarSeleccion, setQuiereFactura,
    quiereFactura, onGuardarNota, onGuardarIngredientes, openProductDetail,
    cerrarDetalleProducto, productDetailId, pideFactura, cancelarFactura, confirmarFactura, limite_simplif,
    errorFactura, openPendientes, setErrorFactura, setPideFactura, resolverPendiente, openVerTickets,
    setOpenVerTickets, comandasBarra, abrirTicketDesdeModal, eliminarTicketDesdeModal, cobrarTicketDesdeModal,
  };
}
