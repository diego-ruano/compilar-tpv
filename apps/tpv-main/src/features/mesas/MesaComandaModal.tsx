import { commands } from "@tpv/client";
import { cn } from "../../shared/lib/cn";
import { useCatalogoServicio } from "../../shared/lib/useCatalogoServicio";
import { Modal,NotaLineaModal,ProductCard } from "./ComandaElementos";
import { addDetalle,deleteDetalleById,ensureOpenComanda,fmtReserva,loadTicketForComanda,removeOnePendingDetalle } from "./comanda";
import type { Paso,ProductoDisplay,TicketItem } from "./tiposComanda";
// components/mesasComponents/MesaComandaModal.tsx
import { useQueryClient } from "@tanstack/react-query";
import { ImageOff,Printer } from "lucide-react";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { shouldReloadTicket } from "../../shared/lib/syncStatements";
import { useAuth } from "../../shared/stores/useAuth";
import { useSyncSignal } from "../../shared/stores/useSyncSignal";
import ImageWithFallback from "../../shared/ui/ImageWithFallback";
import { refrescarTrasCambiarReservas } from "../reservas/reservasQueries";

import { esError,toAppError } from "@tpv/client";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useMode } from "../../shared/stores/useMode";
import { anunciarCobro } from "../../shared/ticket/AvisoFiscalModal";
import DatosFiscalesModal from "../../shared/ticket/DatosFiscalesModal";
import PrintTicketModal,{ type CobroImprimible } from "../../shared/ticket/PrintTicketModal";
import { useToast } from "../../shared/toast";
import ProductDetailModal from "../inventario/ProductDetailModal";

import type {
DestinatarioInput,
MesaMetaOut
} from "@tpv/contracts";
import { conAviso } from "../../shared/lib/conAviso";
import { abs,CERO,eur } from "../../shared/lib/dinero";
import {
cambioDelCobro,
DENOMS_COBRO,
sumaImportes,
totalRecuento,
} from "../../shared/lib/efectivo";
import { useColaOperaciones } from "../../shared/lib/useColaOperaciones";
import { mesasCobrarDetalles,mesasUpdateDetalleNota,productosListByCategoria,productosSearchByNombre,reservaFinalizar,reservaMarcarActivaAhora } from "./mesasApi";

/* =========================
   Tipos
========================= */
const apiCatalogo = { categorias: () => commands.listCategoriasVendibles(), productos: productosListByCategoria, buscar: productosSearchByNombre };

export default function MesaComandaModal({
    open,
    onClose,
    mesaId,
    mesaNombre,
    mesaMeta,
    onChanged,
}: {
    open: boolean;
    onClose: () => void;
    mesaId: string;
    mesaNombre: string;
    mesaMeta?: MesaMetaOut | null;
    onChanged?: () => void;
}) {
    const { categorias, categoriaSeleccionada, setCategoriaSeleccionada, productos, loadingProductos, query, setQuery, q, busqueda, loadingBusqueda } = useCatalogoServicio(open, apiCatalogo);

    const [idComanda, setIdComanda] = useState<string | null>(null);
    const [ticket, setTicket] = useState<TicketItem[]>([]);
    const [loadingTicket, setLoadingTicket] = useState(false);
    const { cola, pendientes: escriturasPendientes } = useColaOperaciones();
    const comandaActualRef = useRef<string | null>(null);
    const lecturaTicketRef = useRef({ version: 0 });
    const cobroEnCursoRef = useRef(false);
    useEffect(() => {
        const lecturas = lecturaTicketRef.current;
        comandaActualRef.current = open ? idComanda : null;
        ++lecturaTicketRef.current.version;
        return () => { comandaActualRef.current = null; ++lecturas.version; };
    }, [open, mesaId, idComanda]);


    const [paso, setPaso] = useState<Paso>("categorias");
    const [cashCount, setCashCount] = useState<Record<string, number>>({});
    const [printOpen, setPrintOpen] = useState(false);
    // El último cobro de ESTA comanda: su ticket lo compone Rust desde el pago (RI-29). Sin él, lo
    // único que se imprime es una precuenta. Se olvida al cambiar de comanda: el número de un cobro
    // no puede acabar en el papel de otra mesa.
    const [ultimoCobro, setUltimoCobro] = useState<CobroImprimible | null>(null);
    useEffect(() => {
        setUltimoCobro(null);
    }, [idComanda]);
    // Cobrar es cosa de la Main: es la que tiene impresora y cajón. Cerrar una mesa desde un Handy
    // dejaría al cliente sin ticket y el dinero sin registrar. El servidor también lo rechaza;
    // esto evita que se llegue a intentar.
    const puedeCobrar = useMode((s) => s.mode) === "tpv";

    const { idUsuario, idTrabajador, role } = useAuth();
    const isAdmin = (role || "").toLowerCase().includes("admin");
    const operador = isAdmin ? null : (idTrabajador ?? idUsuario ?? null);
    // La reserva llega en `mesaMeta`, que es la FOTO del plano al abrir el modal: mientras está
    // abierto su query se deshabilita (Mesas.tsx) para no refrescar el mapa en cada línea, y el
    // único refetch es al cerrar. Por eso marcar la llegada o la salida del cliente no cambiaba
    // nada en pantalla hasta salir del modal.
    const reservaMeta = mesaMeta?.reserva ?? null;

    // Lo que la propia pantalla acaba de hacer con la reserva. `null` = manda la foto del plano.
    const [estadoReserva, setEstadoReserva] = useState<"ACTIVA" | "FINALIZADA" | null>(null);

    // Marcar la llegada o la salida escribe en Reservas, y esa pantalla lee de su propia cache:
    // sin invalidarla podia seguir enseniando el estado viejo (staleTime 30 s) al navegar.
    const qc = useQueryClient();
    const invalidarReservas = useCallback(() => refrescarTrasCambiarReservas(qc), [qc]);

    // Al abrir, o si se salta a otra mesa/reserva, vuelve a mandar el plano.
    useEffect(() => {
        setEstadoReserva(null);
    }, [open, mesaId, reservaMeta?.idReserva]);

    // La reserva que se PINTA (cartel, botón y título). Una finalizada deja de colgar de la mesa:
    // el meta sólo trae PROXIMA/ACTIVA, así que el cartel se va igual que al reabrir el modal.
    const reserva = useMemo(() => {
        if (!reservaMeta) return null;
        if (estadoReserva === "FINALIZADA") return null;
        return estadoReserva ? { ...reservaMeta, estado: estadoReserva } : reservaMeta;
    }, [reservaMeta, estadoReserva]);

    // `onChanged` llega como arrow nueva en cada render del padre; la guardamos en un ref
    // para que `notifyChanged` (y, en cascada, reloadTicket/addProducto…) sea estable y
    // React.memo de ProductCard pueda evitar re-renders de las tarjetas no afectadas.
    const onChangedRef = useRef(onChanged);
    useEffect(() => {
        onChangedRef.current = onChanged;
    });

    const notifyChanged = useCallback(() => {
        try {
            onChangedRef.current?.();
        } finally {
            window.dispatchEvent(new CustomEvent("mesas:changed"));
        }
    }, []);

    const [openNota, setOpenNota] = useState(false);
    const [notaTarget, setNotaTarget] = useState<TicketItem | null>(null);

    const abrirNota = (linea: TicketItem) => {
        setNotaTarget(linea);
        setOpenNota(true);
    };

    const cerrarNota = () => {
        setOpenNota(false);
        setNotaTarget(null);
    };

    const guardarNotaLinea = async (idDetalle: string, nota: string) => {
        if (!idComanda || cobroEnCursoRef.current) return;
        const cId = idComanda;
        ++lecturaTicketRef.current.version;
        await cola.ejecutar(async () => {
            await mesasUpdateDetalleNota({ idDetalle, nota: nota.trim() || null });
            await leerTicket(cId);
            notifyChanged();
        });
    };

    const [openProductDetail, setOpenProductDetail] = useState(false);
    const [productDetailTarget, setProductDetailTarget] =
        useState<ProductoDisplay | null>(null);

    const abrirDetalleProducto = useCallback((p: ProductoDisplay) => {
        setProductDetailTarget(p);
        setOpenProductDetail(true);
    }, []);

    const cerrarDetalleProducto = () => {
        setOpenProductDetail(false);
        setProductDetailTarget(null);
    };

    useEffect(() => {
        if (!open) return;
        let cancelado = false;
        const lecturas = lecturaTicketRef.current;
        comandaActualRef.current = null;
        ++lecturaTicketRef.current.version;
        setTicket([]);
        setIdComanda(null);
        setLoadingTicket(true);
        void (async () => {
            try {
                const reservaActiva = reservaMeta?.estado === "ACTIVA" ? { idReserva: reservaMeta.idReserva } : null;
                const cId = await ensureOpenComanda(mesaId, operador, reservaActiva);
                if (cancelado) return;
                const t = await loadTicketForComanda(cId);
                if (cancelado) return;
                comandaActualRef.current = cId;
                setIdComanda(cId);
                setTicket(t);
                notifyChanged();
            } catch (e) {
                if (!cancelado) {
                    toast.error("No se pudo abrir la comanda", toAppError(e).message);
                    setIdComanda(null);
                    setTicket([]);
                }
            } finally {
                if (!cancelado) setLoadingTicket(false);
            }
        })();
        return () => { cancelado = true; comandaActualRef.current = null; ++lecturas.version; };
        // La foto de la reserva sólo cambia al abrir o al cambiar de mesa.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, mesaId, idUsuario, reservaMeta?.estado, reservaMeta?.idReserva]);

    const aplicarTicket = useCallback((cId: string, t: TicketItem[]) => {
        if (comandaActualRef.current !== cId) return;
        setTicket(prev => {
            const seleccion = new Set(prev.filter(l => l.seleccionado).map(l => l.id));
            return t.map(l => ({ ...l, seleccionado: !l.pagado && seleccion.has(l.id) }));
        });
    }, []);

    const leerTicket = useCallback(async (cId: string) => {
        const lectura = ++lecturaTicketRef.current.version;
        const t = await loadTicketForComanda(cId);
        if (lectura === lecturaTicketRef.current.version) aplicarTicket(cId, t);
    }, [aplicarTicket]);

    const cicloVista = useRef({ valor: 0 });
    useEffect(() => {
        const ciclo = cicloVista.current;
        ++ciclo.valor;
        return () => { ++ciclo.valor; };
    }, [open, mesaId]);
    const marcarLlegada = useCallback(async () => {
        if (!reserva || cola.pendientes() || cobroEnCursoRef.current) return;
        const ciclo = cicloVista.current.valor;
        setLoadingTicket(true);
        ++lecturaTicketRef.current.version;
        try {
            await cola.ejecutar(async () => {
                try {
                    await reservaMarcarActivaAhora(reserva.idReserva);
                } catch (e) {
                    // La reserva ha cambiado con la mesa abierta (la canceló el cliente, pasó a «No
                    // vino»): que el plano y Reservas la relean. El aviso, con el texto del backend,
                    // lo da `conAviso`.
                    invalidarReservas(); notifyChanged();
                    throw e;
                }
                invalidarReservas(); notifyChanged();
                if (ciclo !== cicloVista.current.valor) return;
                setEstadoReserva("ACTIVA");
                const cId = await ensureOpenComanda(mesaId, operador, { idReserva: reserva.idReserva });
                if (ciclo !== cicloVista.current.valor) return;
                comandaActualRef.current = cId;
                setIdComanda(cId);
                await leerTicket(cId);
            });
        } finally { if (ciclo === cicloVista.current.valor) setLoadingTicket(false); }
    }, [reserva, cola, mesaId, operador, invalidarReservas, notifyChanged, leerTicket]);

    const reloadTicket = useCallback(async () => {
        if (!idComanda) return;
        // Los refrescos remotos esperan a que las escrituras de la propia pantalla terminen.
        await cola.esperar();
        await leerTicket(idComanda);
        notifyChanged();
    }, [idComanda, cola, leerTicket, notifyChanged]);

    // Sincronización nube → Main: si llega un cambio por WebSocket mientras la comanda está
    // abierta, recargar el ticket SOLO si el cambio afecta a esta comanda (no a otra que edite
    // otro dispositivo). La BD local ya es la verdad.
    const syncTick = useSyncSignal((s) => s.tick);
    useEffect(() => {
        if (!syncTick) return;
        if (!open || !idComanda) return;
        const info = useSyncSignal.getState().comanda;
        if (shouldReloadTicket(info, idComanda)) {
            // HIG-04: `reloadTicket` no captura. Es un refresco de fondo —el siguiente cambio lo
            // vuelve a intentar—, así que basta con que el fallo quede a la vista y no se pierda.
            reloadTicket().catch((e) =>
                console.error("Fallo recargando el ticket tras un cambio remoto", e),
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncTick]);

    const addProductoToTicket = useCallback(async (p: ProductoDisplay) => {
        if (!idComanda || loadingTicket || cobroEnCursoRef.current || (!isAdmin && operador == null)) return;
        ++lecturaTicketRef.current.version;
        await cola.ejecutar(async () => {
            const t = await addDetalle(idComanda, p, operador);
            ++lecturaTicketRef.current.version;
            aplicarTicket(idComanda, t);
            notifyChanged();
        });
    }, [idComanda, loadingTicket, isAdmin, operador, cola, aplicarTicket, notifyChanged]);

    const removeProductoFromTicket = useCallback(async (productoId: string) => {
        if (!idComanda || loadingTicket || cobroEnCursoRef.current) return;
        ++lecturaTicketRef.current.version;
        await cola.ejecutar(async () => {
            await removeOnePendingDetalle(idComanda, productoId);
            await leerTicket(idComanda);
            notifyChanged();
        });
    }, [idComanda, loadingTicket, cola, leerTicket, notifyChanged]);

    const anadirConAviso = useMemo(() => conAviso(addProductoToTicket), [addProductoToTicket]);
    const quitarConAviso = useMemo(() => conAviso(removeProductoFromTicket), [removeProductoFromTicket]);

    const countEnTicket = (productoId: string) =>
        ticket.filter((t) => t.productoId === productoId && !t.pagado).length;

    const totalPendiente = useMemo(
        () =>
            sumaImportes(ticket.filter((t) => !t.pagado).map((t) => t.precio)),
        [ticket],
    );

    const totalSeleccionado = useMemo(
        () =>
            sumaImportes(
                ticket.filter((t) => !t.pagado && t.seleccionado).map((t) => t.precio),
            ),
        [ticket],
    );

    const haySeleccion = useMemo(
        () => ticket.some((t) => !t.pagado && t.seleccionado),
        [ticket],
    );

    const seleccionaTodoPendiente = () => {
        setTicket((prev) =>
            prev.map((t) => (t.pagado ? t : { ...t, seleccionado: true })),
        );
    };

    const limpiarSeleccion = () => {
        setTicket((prev) =>
            prev.map((t) => (t.pagado ? t : { ...t, seleccionado: false })),
        );
    };

    const toggleSeleccion = (idDetalle: string) => {
        setTicket((prev) =>
            prev.map((t) =>
                t.id === idDetalle && !t.pagado
                    ? { ...t, seleccionado: !t.seleccionado }
                    : t,
            ),
        );
    };

    const eliminarLineaTicket = async (idDetalle: string) => {
        if (!idComanda || cobroEnCursoRef.current || !ticket.some(t => t.id === idDetalle && !t.pagado)) return;
        const cId = idComanda;
        ++lecturaTicketRef.current.version;
        try {
            await cola.ejecutar(async () => {
                await deleteDetalleById(idDetalle);
                await leerTicket(cId);
                notifyChanged();
            });
        } catch (e) {
            toast.error("No se pudo quitar la línea", toAppError(e).message);
        }
    };

    /* ── FISCAL-02: la factura completa ───────────────────────────────────────
       Dos caminos distintos hasta el mismo formulario, y la pantalla los distingue porque no se
       parecen:

         · VOLUNTARIO. El cliente la pide. Se marca la casilla antes de cobrar y se puede cancelar.
         · OBLIGATORIO. El importe pasa del límite de la simplificada, así que el backend RECHAZA el
           cobro con `factura_completa_requerida`. Sin esos datos no se puede cobrar, y esto es lo
           que impide que el camarero se quede mirando un error sin salida.

       El límite no se comprueba aquí. Lo decide Rust dentro de la transacción del cobro, que es
       donde se conoce el importe exacto que se va a registrar; la pantalla sólo reacciona a su
       rechazo. Comprobarlo en los dos lados sería tener dos criterios para la misma cifra. */
    const limite_simplif = useBusinessSettings((st) => st.limite_simplif);
    const [quiereFactura, setQuiereFactura] = useState(false);
    const [pideFactura, setPideFactura] = useState<{
        metodo: "tarjeta" | "efectivo";
        obligatorio: boolean;
    } | null>(null);
    const [errorFactura, setErrorFactura] = useState<string | null>(null);
    const [cobrandoFactura, setCobrandoFactura] = useState(false);
    const toast = useToast();

    const cobrar = async (
        metodo: "tarjeta" | "efectivo",
        destinatario?: DestinatarioInput | null,
    ) => {
        if (!idComanda || cobroEnCursoRef.current || cola.pendientes() > 0) return;

        const ids = ticket
            .filter((t) => !t.pagado && t.seleccionado)
            .map((t) => t.id);

        if (!ids.length) return;

        // Camino voluntario: se pidió factura y todavía no hay datos. Se pregunta ANTES de cobrar —
        // una vez cobrado, convertir el ticket en factura ya es otra operación (una F3 sustitutiva).
        if (quiereFactura && !destinatario) {
            setErrorFactura(null);
            setPideFactura({ metodo, obligatorio: false });
            return;
        }
        cobroEnCursoRef.current = true;
        setCobrandoFactura(true);
        ++lecturaTicketRef.current.version;

        try {
            const idPago = await mesasCobrarDetalles({
                idComanda,
                metodo: metodo === "tarjeta" ? "Tarjeta" : "Efectivo",
                tipo:
                    ids.length === ticket.filter((t) => !t.pagado).length
                        ? "TOTAL"
                        : "FRACCIONADO",
                detalleIds: ids,
                destinatario: destinatario ?? undefined,
            });

            // El ticket de este cobro: imprimir saca el de su factura, con sus líneas y no las de
            // la mesa entera (RI-29).
            if (idPago && comandaActualRef.current === idComanda) setUltimoCobro({ idPago });

            // La escritura ya está confirmada: estos ids están pagados aunque falle el refresco.
            if (comandaActualRef.current === idComanda) {
                setTicket(prev => prev.map(l => ids.includes(l.id) ? { ...l, pagado: true, seleccionado: false } : l));
            }
            await leerTicket(idComanda).catch(e => toast.warning("Cobro guardado; no se pudo refrescar el ticket", toAppError(e).message));
            if (comandaActualRef.current !== idComanda) { notifyChanged(); anunciarCobro(); return; }

            setCashCount({});
            setPaso("categorias");
            setCategoriaSeleccionada(null);
            setQuery("");
            window.dispatchEvent(new CustomEvent("mesas:changed"));
            notifyChanged();
            // FISCAL-01: se ha cobrado. Si el equipo lleva tres días sin remitir, el aviso sale
            // ahora — después del cobro, nunca antes.
            anunciarCobro();
            setQuiereFactura(false);
            setPideFactura(null);
            setErrorFactura(null);
        } catch (e) {
            console.error("Error cobrando:", e);
            if (comandaActualRef.current !== idComanda) { toast.error("No se pudo cobrar", toAppError(e).message); return; }
            // El importe pasa del límite de la simplificada: no es un fallo, es que falta un dato.
            // Se abre el formulario en modo obligatorio en vez de dejar al camarero sin salida.
            if (esError(e, "factura_completa_requerida")) {
                setErrorFactura(null);
                setPideFactura({ metodo, obligatorio: true });
                return;
            }
            // Si el fallo llega con el formulario abierto, se enseña DENTRO: cerrarlo perdería los
            // datos que el cliente acaba de dictar.
            if (pideFactura) {
                setErrorFactura(toAppError(e).message);
                return;
            }
            // ⚠️ Y si no, se DICE. Esto antes no existía: cualquier error que no fuera
            // `factura_completa_requerida` acababa en un `console.error` y nada más, así que el
            // camarero pulsaba «Confirmar cobro» y **no pasaba nada** — ni toast, ni mensaje, ni
            // cobro. El caso que lo destapó es el peor posible: un equipo recién instalado sin el
            // NIF del negocio no puede emitir la factura, así que NINGÚN cobro entra, y la pantalla
            // no lo contaba (FIS-01).
            //
            // El texto sale de `AppErrorDto.message`, que el catálogo de `ErrorCode` ya escribe en
            // castellano y para humanos («Faltan los datos fiscales del negocio…»). Aquí no se
            // ramifica por código: cualquier cosa que llegue hasta este punto es algo que quien
            // está cobrando tiene que ver.
            toast.error("No se pudo cobrar", toAppError(e).message);
        } finally {
            cobroEnCursoRef.current = false;
            setCobrandoFactura(false);
        }
    };

    const totalEfectivo = useMemo(() => totalRecuento(DENOMS_COBRO, cashCount), [cashCount]);

    const totalACobrar = useMemo(
        () => (haySeleccion ? totalSeleccionado : CERO),
        [haySeleccion, totalSeleccionado],
    );

    const diferencia = useMemo(
        () => cambioDelCobro(totalEfectivo, totalACobrar),
        [totalEfectivo, totalACobrar],
    );

    const addCash = (label: string) =>
        setCashCount((p) => ({ ...p, [label]: (p[label] || 0) + 1 }));

    const removeCash = (label: string) => {
        setCashCount((prev) => {
            const cur = prev[label] || 0;
            const next = Math.max(0, cur - 1);
            const out = { ...prev, [label]: next };
            if (next === 0) delete out[label];
            return out;
        });
    };

    const resetCash = () => setCashCount({});

    const showingSearch = q.length > 0;

    const leftTitle = useMemo(() => {
        if (paso === "efectivo") return "Cobro en efectivo";
        if (showingSearch) return `Productos · "${q}"`;
        if (categoriaSeleccionada)
            return `Productos · ${categoriaSeleccionada.Nombre}`;
        return "Categorías";
    }, [paso, showingSearch, q, categoriaSeleccionada]);

    const leftSubtitle = useMemo(() => {
        if (paso === "efectivo")
            return "Selecciona billetes/monedas y verás el cambio.";
        if (showingSearch) return "Resultados del buscador (con + / −).";
        if (categoriaSeleccionada)
            return "Usa +/− o pulsa la tarjeta para añadir.";
        return "Elige una categoría para ver sus productos.";
    }, [paso, showingSearch, categoriaSeleccionada]);

    useEffect(() => {
        setPaso(actual => {
            if (categoriaSeleccionada && !showingSearch && actual === "categorias") return "productos";
            if (!categoriaSeleccionada && !showingSearch && actual === "productos") return "categorias";
            return actual;
        });
    }, [categoriaSeleccionada, showingSearch]);

    const modalTitle = useMemo(() => {
        if (reserva?.estado === "ACTIVA")
            return `Mesa: ${mesaNombre} · Reserva ${reserva.clienteNombre}`;
        return `Mesa: ${mesaNombre}`;
    }, [mesaNombre, reserva?.estado, reserva?.clienteNombre]);

    return (
        <Modal
            open={open}
            title={modalTitle}
            headerRight={
                <button
                    type="button"
                    onClick={() => setPrintOpen(true)}
                    disabled={ticket.length === 0}
                    className={cn(
                        "flex items-center gap-2 rounded-xl border px-3 h-10 text-sm font-semibold transition",
                        ticket.length === 0
                            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
                            : "border-border bg-surface text-fg hover:bg-surface-2 cursor-pointer",
                    )}
                    title="Imprimir ticket"
                >
                    <Printer className="size-4" aria-hidden />
                    Imprimir
                </button>
            }
            onClose={() => {
                setPaso("categorias");
                setCategoriaSeleccionada(null);
                setQuery("");
                    setCashCount({});
                limpiarSeleccion();
                cerrarNota();
                cerrarDetalleProducto();
                onClose();
            }}
        >
            <PrintTicketModal
                open={printOpen}
                onClose={() => setPrintOpen(false)}
                items={ticket}
                cobro={ultimoCobro}
            />
            <DatosFiscalesModal
                open={pideFactura !== null}
                onClose={() => {
                    setPideFactura(null);
                    setErrorFactura(null);
                    // Cancelar el camino OBLIGATORIO deja la casilla sin marcar: el cobro no se ha
                    // hecho y el camarero vuelve a la pantalla de método. Es lo correcto — el
                    // cliente puede ir a buscar el NIF y volver.
                    setQuiereFactura(false);
                }}
                onConfirmar={async (d) => {
                    const metodo = pideFactura?.metodo ?? "tarjeta";
                    await cobrar(metodo, d);
                }}
                importe={totalSeleccionado}
                limite={limite_simplif}
                obligatorio={pideFactura?.obligatorio ?? false}
                guardando={cobrandoFactura}
                error={errorFactura}
            />
            <NotaLineaModal
                open={openNota}
                productoNombre={notaTarget?.nombre ?? ""}
                initialValue={notaTarget?.notas ?? ""}
                onCancel={cerrarNota}
                onSave={async (nota) => {
                    if (!notaTarget) return;
                    // HIG-04: el modal llama a esto con `void` (Ctrl+Enter) o soltando la promesa
                    // (botón), así que un fallo no lo recogía nadie. Se avisa y el modal se queda
                    // abierto con el texto, para poder volver a intentarlo.
                    try {
                        await guardarNotaLinea(notaTarget.id, nota);
                        cerrarNota();
                    } catch (e) {
                        toast.error("No se pudo guardar la nota", toAppError(e).message);
                    }
                }}
            />

            <ProductDetailModal
                open={openProductDetail}
                onClose={cerrarDetalleProducto}
                productId={productDetailTarget?.ID_Producto ?? null}
            />

            <div className="w-full h-full flex flex-col min-h-0">
                {reserva ? (
                    <div
                        className={cn(
                            "mb-4 rounded-2xl border p-4 flex items-start justify-between gap-3",
                            reserva.estado === "ACTIVA"
                                ? "border-blue-200 bg-blue-50"
                                : "border-blue-200/70 bg-blue-50/60",
                        )}
                    >
                        <div className="min-w-0">
                            <p className={cn("font-extrabold", "text-blue-900")}>
                                {reserva.estado === "ACTIVA"
                                    ? "🔵 Reserva activa"
                                    : reserva.minutosPara < 0
                                      ? `🔷 Reserva por llegar (${-reserva.minutosPara} min tarde)`
                                      : "🔷 Reserva próxima"}
                            </p>

                            <p className="text-sm text-blue-900/80 mt-1">
                                {reserva.clienteNombre} · {reserva.diaYMD} {reserva.hora} ·{" "}
                                {fmtReserva(reserva)}
                            </p>

                            {reserva.estado === "PROXIMA" ? (
                                <p className="text-xs text-blue-900/60 mt-2">
                                    Pulsa “Ha llegado ya el cliente” cuando esté en el local
                                    para imputar comandas a la reserva.
                                </p>
                            ) : null}
                        </div>

                        {reserva.estado === "PROXIMA" ? (
                            <button
                                type="button"
                                className="shrink-0 px-4 py-2 rounded-xl font-semibold border-2 border-blue-600 text-blue-700 bg-surface hover:bg-blue-600 hover:text-white transition"
                                disabled={escriturasPendientes > 0 || cobrandoFactura}
                                onClick={conAviso(marcarLlegada)}
                            >
                                ✅ Ha llegado ya el cliente
                            </button>
                        ) : null}

                        {reserva.estado === "ACTIVA" ? (
                            <button
                                type="button"
                                className="shrink-0 px-4 py-2 rounded-xl font-semibold border-2 border-danger text-danger bg-surface hover:bg-danger hover:text-white transition"
                                onClick={conAviso(async () => {
                                    try {
                                        await reservaFinalizar(reserva.idReserva);
                                        setEstadoReserva("FINALIZADA");
                                        invalidarReservas();
                                        notifyChanged();
                                    } catch (e) {
                                        // Antes se tragaba el error. Si la reserva ha cambiado con la
                                        // mesa abierta, que se relea y se diga (`conAviso`).
                                        invalidarReservas();
                                        notifyChanged();
                                        throw e;
                                    }
                                })}
                            >
                                🧾 El cliente abandona la mesa
                            </button>
                        ) : null}
                    </div>
                ) : null}

                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain lg:flex-row lg:gap-4 lg:overflow-hidden">
                    <div className="flex min-h-[32rem] flex-none flex-col rounded-xl border border-border bg-surface p-3 sm:p-4 lg:min-h-0 lg:flex-1">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-fg">
                                    {leftTitle}
                                </h3>
                                <p className="text-sm text-fg-muted">
                                    {leftSubtitle}
                                </p>
                            </div>

                            {categoriaSeleccionada &&
                                !showingSearch &&
                                paso !== "efectivo" ? (
                                <button
                                    className="px-3 py-2 rounded-xl border border-border bg-surface hover:bg-surface-2 text-sm font-semibold"
                                    onClick={() => setCategoriaSeleccionada(null)}
                                    type="button"
                                >
                                    Ver categorías
                                </button>
                            ) : null}
                        </div>

                        <div className="mt-3">
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Buscar producto por nombre…"
                                className="w-full rounded-xl border border-border bg-surface px-4 py-3 outline-none focus:ring-2 focus:ring-ring"
                                disabled={paso === "efectivo"}
                            />
                            {paso === "efectivo" ? (
                                <p className="mt-2 text-xs text-fg-subtle">
                                    Estás en modo efectivo. Termina el cobro o pulsa
                                    “Cancelar”.
                                </p>
                            ) : null}
                        </div>

                        <div
                            className={cn(
                                "mt-4 flex-1 min-h-0",
                                paso === "efectivo" && "overflow-y-auto pr-1",
                            )}
                        >
                            {paso === "efectivo" ? (
                                <div className="flex flex-col gap-4">
                                    <div className="rounded-xl border border-border bg-surface p-4">
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm text-fg-muted">Total a cobrar</p>
                                            <p className="text-xl font-bold">
                                                {eur(totalACobrar)}
                                            </p>
                                        </div>

                                        <div className="mt-2 flex items-center justify-between">
                                            <p className="text-sm text-fg-muted">Te han dado</p>
                                            <p className="text-xl font-bold">
                                                {eur(totalEfectivo)}
                                            </p>
                                        </div>

                                        <div className="mt-3 rounded-xl p-3 border border-border bg-surface-2">
                                            {diferencia >= 0 ? (
                                                <div className="flex items-center justify-between">
                                                    <p className="text-sm font-semibold text-success">
                                                        Cambio
                                                    </p>
                                                    <p className="text-lg font-bold text-success">
                                                        {eur(diferencia)}
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className="flex items-center justify-between">
                                                    <p className="text-sm font-semibold text-danger">
                                                        Falta
                                                    </p>
                                                    <p className="text-lg font-bold text-danger">
                                                        {eur(abs(diferencia))}
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        <div className="mt-3 flex gap-2">
                                            <button
                                                className="flex-1 px-3 py-3 rounded-xl border border-border bg-surface hover:bg-surface-2 text-sm font-semibold"
                                                onClick={resetCash}
                                                type="button"
                                            >
                                                Reset
                                            </button>

                                            <button
                                                className={cn(
                                                    "flex-1 px-3 py-3 rounded-xl text-sm font-semibold transition",
                                                    diferencia >= 0
                                                        ? "bg-accent text-white hover:bg-accent-hover"
                                                        : "bg-surface-2 text-fg-subtle cursor-not-allowed",
                                                )}
                                                disabled={diferencia < 0 || cobrandoFactura || escriturasPendientes > 0}
                                                onClick={conAviso(() => cobrar("efectivo"))}
                                                type="button"
                                                title={
                                                    diferencia < 0
                                                        ? "Falta dinero"
                                                        : "Confirmar cobro en efectivo"
                                                }
                                            >
                                                Confirmar cobro
                                            </button>

                                            <button
                                                className="flex-1 px-3 py-3 rounded-xl border border-danger/30 bg-danger-soft text-danger hover:bg-danger-soft text-sm font-semibold"
                                                onClick={() => {
                                                    setPaso("metodo");
                                                    setCashCount({});
                                                }}
                                                type="button"
                                            >
                                                Cancelar
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                        {DENOMS_COBRO.map((d) => {
                                            const count = cashCount[d.label] || 0;
                                            return (
                                                <div
                                                    key={d.label}
                                                    className="rounded-xl border border-border bg-surface p-3 flex flex-col gap-2"
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <p className="font-bold">{d.label}</p>
                                                        <span className="text-xs text-fg-subtle">
                                                            {eur(d.value)}
                                                        </span>
                                                    </div>

                                                    <div className="flex items-center justify-between gap-2">
                                                        <button
                                                            className={cn(
                                                                "w-10 h-10 rounded-xl border border-border bg-surface hover:bg-surface-2 font-bold",
                                                                count === 0 &&
                                                                "opacity-40 cursor-not-allowed",
                                                            )}
                                                            disabled={count === 0}
                                                            onClick={() => removeCash(d.label)}
                                                            type="button"
                                                        >
                                                            −
                                                        </button>

                                                        <div className="flex-1 text-center">
                                                            <p className="text-xs text-fg-subtle">
                                                                Cantidad
                                                            </p>
                                                            <p className="text-lg font-bold">
                                                                {count}
                                                            </p>
                                                        </div>

                                                        <button
                                                            className="w-10 h-10 rounded-xl border border-border bg-surface hover:bg-surface-2 font-bold"
                                                            onClick={() => addCash(d.label)}
                                                            type="button"
                                                        >
                                                            +
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : (
                                <div className="h-full overflow-y-auto pr-1">
                                    {showingSearch ? (
                                        loadingBusqueda ? (
                                            <p className="text-sm text-fg-muted">Buscando…</p>
                                        ) : busqueda.length === 0 ? (
                                            <p className="text-sm text-fg-muted">
                                                No hay resultados.
                                            </p>
                                        ) : (
                                            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] sm:gap-3 lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                                                {busqueda.map((p) => (
                                                    <ProductCard
                                                        key={p.ID_Producto}
                                                        p={p}
                                                        qty={countEnTicket(p.ID_Producto)}
                                                        bloqueado={loadingTicket || cobrandoFactura}
                                                        onAdd={anadirConAviso}
                                                        onRemove={quitarConAviso}
                                                        onInfo={abrirDetalleProducto}
                                                    />
                                                ))}
                                            </div>
                                        )
                                    ) : !categoriaSeleccionada ? (
                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(135px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] sm:gap-3">
                                            {categorias.map((c) => (
                                                <button
                                                    key={c.ID_Categoria}
                                                    onClick={() => setCategoriaSeleccionada(c)}
                                                    className="rounded-xl border border-border bg-surface hover:bg-surface-2 p-3 text-left transition"
                                                    type="button"
                                                >
                                                    <ImageWithFallback
                                                        src={c.urlImagen}
                                                        alt={c.Nombre}
                                                        className="w-full h-28 object-cover rounded-lg border border-border"
                                                        fallback={
                                                            <div className="flex h-28 w-full items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-subtle">
                                                                <ImageOff className="size-6" aria-hidden />
                                                            </div>
                                                        }
                                                    />
                                                    <p className="mt-2 font-bold">{c.Nombre}</p>
                                                </button>
                                            ))}
                                        </div>
                                    ) : loadingProductos ? (
                                        <p className="text-sm text-fg-muted">
                                            Cargando productos…
                                        </p>
                                    ) : productos.length === 0 ? (
                                        <p className="text-sm text-fg-muted">
                                            No hay productos en esta categoría.
                                        </p>
                                    ) : (
                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] sm:gap-3 lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                                            {productos.map((p) => (
                                                <ProductCard
                                                    key={p.ID_Producto}
                                                    p={p}
                                                    qty={countEnTicket(p.ID_Producto)}
                                                        bloqueado={loadingTicket || cobrandoFactura}
                                                    onAdd={anadirConAviso}
                                                    onRemove={quitarConAviso}
                                                    onInfo={abrirDetalleProducto}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex min-h-[32rem] w-full shrink-0 flex-col rounded-xl border border-border bg-surface p-3 sm:p-4 lg:min-h-0 lg:w-[420px]">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg font-bold text-fg">Ticket</h3>
                            {(escriturasPendientes > 0 || cobrandoFactura) && <span role="status" className="text-sm text-fg-muted">Guardando…</span>}
                            <div className="text-sm font-semibold text-fg-muted">
                                Total pendiente:{" "}
                                <span className="text-fg">{eur(totalPendiente)}</span>
                            </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                            <button
                                className={cn(
                                    "flex-1 px-3 py-2 rounded-xl text-sm font-semibold transition",
                                    puedeCobrar && ticket.some((t) => !t.pagado)
                                        ? "bg-accent text-white hover:bg-accent-hover"
                                        : "bg-surface-2 text-fg-subtle cursor-not-allowed",
                                )}
                                disabled={!puedeCobrar || loadingTicket || cobrandoFactura || escriturasPendientes > 0 || !ticket.some((t) => !t.pagado)}
                                onClick={() => {
                                    seleccionaTodoPendiente();
                                    setPaso("metodo");
                                }}
                                type="button"
                            >
                                Cobrar todo
                            </button>

                            <button
                                className={cn(
                                    "flex-1 px-3 py-2 rounded-xl text-sm font-semibold transition",
                                    puedeCobrar && haySeleccion
                                        ? "bg-surface border border-border hover:bg-surface-2"
                                        : "bg-surface-2 text-fg-subtle cursor-not-allowed",
                                )}
                                disabled={!puedeCobrar || loadingTicket || cobrandoFactura || escriturasPendientes > 0 || !haySeleccion}
                                onClick={() => setPaso("metodo")}
                                type="button"
                            >
                                Cobrar fraccionado
                            </button>
                        </div>

                        <div className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1 rounded-xl border border-border bg-surface">
                            {loadingTicket ? (
                                <div className="p-4 text-sm text-fg-muted">Cargando…</div>
                            ) : ticket.length === 0 ? (
                                <div className="p-4 text-sm text-fg-muted">
                                    Añade productos para empezar.
                                </div>
                            ) : (
                                <div className="p-3 flex flex-col gap-2">
                                    {ticket.map((t) => {
                                        const checked = t.seleccionado && !t.pagado;
                                        const hasNota = Boolean((t.notas ?? "").trim());

                                        return (
                                            <div
                                                key={t.id}
                                                role="button"
                                                tabIndex={t.pagado ? -1 : 0}
                                                onClick={() => {
                                                    if (!t.pagado) toggleSeleccion(t.id);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (t.pagado) return;
                                                    if (
                                                        e.key === "Enter" ||
                                                        e.key === " "
                                                    ) {
                                                        e.preventDefault();
                                                        toggleSeleccion(t.id);
                                                    }
                                                }}
                                                className={cn(
                                                    "w-full rounded-xl border p-3 text-left transition flex items-center justify-between gap-3",
                                                    "border-border hover:bg-surface-2",
                                                    t.pagado && "opacity-70",
                                                )}
                                                aria-disabled={t.pagado}
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div
                                                        className={cn(
                                                            "w-6 h-6 rounded-full border flex items-center justify-center shrink-0",
                                                            checked
                                                                ? "border-success bg-emerald-500"
                                                                : "border-border bg-surface",
                                                            t.pagado &&
                                                            "border-border bg-surface-2",
                                                        )}
                                                    >
                                                        {checked ? (
                                                            <div className="w-2.5 h-2.5 rounded-full bg-surface" />
                                                        ) : null}
                                                    </div>

                                                    <div className="min-w-0">
                                                        <p
                                                            className={cn(
                                                                "font-semibold truncate",
                                                                t.pagado &&
                                                                "line-through text-fg-subtle",
                                                            )}
                                                        >
                                                            {t.nombre}
                                                        </p>

                                                        <p
                                                            className={cn(
                                                                "text-xs",
                                                                t.pagado
                                                                    ? "text-fg-subtle"
                                                                    : !t.pasaCocina
                                                                        ? "text-fg-muted font-semibold"
                                                                        : t.estadoCocina ===
                                                                            "PREPARADO"
                                                                            ? "text-success font-semibold"
                                                                            : "text-fg-subtle",
                                                            )}
                                                        >
                                                            {t.pagado
                                                                ? "Cobrado"
                                                                : !t.pasaCocina
                                                                    ? "No cocina"
                                                                    : t.estadoCocina ===
                                                                        "PREPARADO"
                                                                        ? "Preparado"
                                                                        : "Pendiente"}
                                                        </p>

                                                        {hasNota ? (
                                                            <p className="mt-1 text-[11px] text-fg-muted truncate">
                                                                📝 {t.notas}
                                                            </p>
                                                        ) : null}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className={cn(
                                                            "font-bold",
                                                            t.pagado &&
                                                            "line-through text-fg-subtle",
                                                        )}
                                                    >
                                                        {eur(t.precio)}
                                                    </span>

                                                    {!t.pagado ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                abrirNota(t);
                                                            }}
                                                            className={cn(
                                                                "w-8 h-8 flex items-center justify-center rounded-lg border transition",
                                                                hasNota
                                                                    ? "border-amber-200 bg-amber-50 text-warning hover:bg-warning-soft"
                                                                    : "border-border text-fg-subtle hover:bg-surface-2",
                                                            )}
                                                            title={
                                                                hasNota
                                                                    ? "Editar nota"
                                                                    : "Añadir nota"
                                                            }
                                                        >
                                                            ✏️
                                                        </button>
                                                    ) : null}

                                                    {!t.pagado ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                void eliminarLineaTicket(t.id);
                                                            }}
                                                            className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-fg-subtle hover:bg-danger-soft hover:text-danger hover:border-danger/30 transition"
                                                            title="Eliminar producto"
                                                        >
                                                            🗑️
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="mt-4 rounded-xl border border-border bg-surface p-3">
                            <div className="flex items-center justify-between">
                                <p className="text-sm text-fg-muted">Seleccionado</p>
                                <p className="font-bold">{eur(totalSeleccionado)}</p>
                            </div>

                            {paso === "metodo" ? (
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <button
                                        className={cn(
                                            "px-3 py-3 rounded-xl text-sm font-semibold transition",
                                            haySeleccion
                                                ? "bg-accent text-white hover:bg-accent-hover"
                                                : "bg-surface-2 text-fg-subtle cursor-not-allowed",
                                        )}
                                        disabled={!puedeCobrar || loadingTicket || cobrandoFactura || escriturasPendientes > 0 || !haySeleccion}
                                        onClick={conAviso(() => cobrar("tarjeta"))}
                                        type="button"
                                    >
                                        Cobrar con tarjeta
                                    </button>

                                    <button
                                        className={cn(
                                            "px-3 py-3 rounded-xl text-sm font-semibold transition",
                                            haySeleccion
                                                ? "bg-surface border border-border hover:bg-surface-2"
                                                : "bg-surface-2 text-fg-subtle cursor-not-allowed",
                                        )}
                                        disabled={!puedeCobrar || loadingTicket || cobrandoFactura || escriturasPendientes > 0 || !haySeleccion}
                                        onClick={() => {
                                            setPaso("efectivo");
                                            setCashCount({});
                                        }}
                                        type="button"
                                    >
                                        Cobrar en efectivo
                                    </button>

                                    <label className="col-span-2 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={quiereFactura}
                                            onChange={(e) =>
                                                setQuiereFactura(e.target.checked)
                                            }
                                            className="h-4 w-4 accent-[var(--accent)]"
                                        />
                                        <span className="font-semibold">
                                            El cliente pide factura con NIF
                                        </span>
                                        <span className="text-xs text-fg-subtle">
                                            (se piden sus datos al cobrar)
                                        </span>
                                    </label>

                                    <button
                                        className="col-span-2 px-3 py-2 rounded-xl border border-border bg-surface hover:bg-surface-2 text-sm font-semibold"
                                        onClick={() => {
                                            setPaso("categorias");
                                            limpiarSeleccion();
                                            setQuiereFactura(false);
                                        }}
                                        type="button"
                                    >
                                        Cancelar cobro
                                    </button>
                                </div>
                            ) : (
                                <p className="mt-2 text-xs text-fg-subtle">
                                    Selecciona productos pendientes y pulsa “Cobrar
                                    fraccionado”, o pulsa “Cobrar todo”.
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
