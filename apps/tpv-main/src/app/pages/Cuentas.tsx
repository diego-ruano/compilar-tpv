import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    Wallet,
    Pencil,
    Trash2,
    X,
    FileDown,
    Send,
    Calculator,
    ReceiptText,
    Printer,
    FileText,
} from "lucide-react";

import PrintTicketModal, {
    type PrintableLine,
} from "../../shared/ticket/PrintTicketModal";
import type { DatosDelTicket } from "../../features/configuracion/api/printerApis";
import DatosFiscalesModal, {
} from "../../shared/ticket/DatosFiscalesModal";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import type {
    CambioCajaInput,
    DestinatarioInput,
    Dinero,
    ImpactoCajaDto,
    LineaTicketDto,
    ProveedorMiniDto,
    TicketReimpresionDto,
} from "@tpv/contracts";
import { invokeClient, toAppError } from "@tpv/client";
import { ModalShell, SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import {
    cuentasGetEntradas,
    cuentasGetSalidas,
    esAnulado,
    type EntradaDto,
    type SalidaDto,
    type ClaseBaja,
} from "../../features/cuentas/cuentasApis";
import CierreCajaModal from "../../features/cuentas/CierreCajaModal";
import ImpactoCierreModal from "../../features/cuentas/ImpactoCierreModal";
import {
    cierreDetalle,
    cierreImprimir,
    cierreListar,
    cierreReabrir,
    type CierreResumenDto,
} from "../../features/cuentas/cierreApis";
import {
    useCuentasEntradas,
    useCuentasSalidas,
    useCuentasResumen,
    useCuentasProveedoresMini,
    useCreateGasto,
    useUpdateGasto,
    useDeleteGasto,
    useUpdatePago,
    useAnularPago,
} from "../../features/cuentas/cuentasQueries";
import { CUENTAS_PAGE_SIZE, cuentasPrevisualizarCambio } from "../../features/cuentas/cuentasApis";

// PDF
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Tauri: guardar en ruta elegida por el usuario
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { conAviso } from "../../shared/lib/conAviso";
import { CERO, eur, restar, sumar } from "../../shared/lib/dinero";
import { CampoDinero, useImporte } from "../../shared/ui/CampoDinero";

function todayYMD() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function asciiSafe(s: string) {
    return (s ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ñ/g, "n")
        .replace(/Ñ/g, "N")
        // jsPDF sólo lleva WinAnsi: lo que no sea ASCII imprimible hay que quitarlo antes.
        // eslint-disable-next-line no-control-regex -- el rango es a propósito, no un descuido.
        .replace(/[^\x00-\x7F]/g, "");
}

function Badge({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-fg-muted">
            {children}
        </span>
    );
}

function PrimaryButton({
    children,
    onClick,
    disabled,
    className = "",
}: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={[
                "h-9 px-3 rounded-xl border border-accent bg-accent text-xs font-bold text-white shadow-sm",
                "hover:bg-accent-hover active:scale-[0.98] transition",
                disabled ? "opacity-60 cursor-not-allowed" : "",
                className,
            ].join(" ")}
        >
            {children}
        </button>
    );
}

function MiniIconButton({
    title,
    children,
    onClick,
    variant = "neutral",
}: {
    title?: string;
    children: React.ReactNode;
    onClick?: () => void;
    variant?: "neutral" | "danger";
}) {
    return (
        <button
            type="button"
            title={title}
            onClick={onClick}
            className={[
                "h-9 w-9 rounded-xl border shadow-sm transition active:scale-[0.98]",
                "grid place-items-center",
                variant === "danger"
                    ? "border-danger/30 bg-danger-soft text-danger hover:bg-danger-soft"
                    : "border-border bg-surface text-fg-muted hover:bg-surface-2",
            ].join(" ")}
        >
            {children}
        </button>
    );
}

/** Lo que se le pasa al modal para reimprimir un cobro ya hecho. */
type Reimpresion = {
    items: PrintableLine[];
    datos: DatosDelTicket;
};

/** Añade el tachado a las clases de una celda cuando el cobro está anulado. */
function tachadoSi(anulado: boolean, clases: string): string {
    return anulado ? `${clases} line-through opacity-60` : clases;
}

/**
 * El sello de un cobro anulado: quién, cuándo y por qué (CUENTA-07).
 *
 * Va debajo de la fila y no en un tooltip a propósito. Ésta es la pantalla en la que alguien busca
 * por qué falta dinero de la caja, y lo que se está mirando es precisamente la lista de cobros que
 * alguien deshizo: esconder el motivo detrás de un hover es esconderlo.
 */
function SelloAnulado({ entrada }: { entrada: EntradaDto }) {
    if (!esAnulado(entrada)) return null;

    const quien = (entrada.anulado_por ?? "").trim();
    const cuando = (entrada.anulado_en ?? "").slice(0, 16);
    const motivo = (entrada.motivo_anulacion ?? "").trim();

    return (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="rounded-lg border border-danger/30 bg-danger-soft px-2 py-0.5 font-bold uppercase tracking-wide text-danger">
                Anulado
            </span>
            <span className="text-fg-muted">
                {[quien, cuando].filter(Boolean).join(" · ") || "sin firma"}
            </span>
            {motivo ? (
                <span className="min-w-0 truncate text-fg-muted" title={motivo}>
                    «{motivo}»
                </span>
            ) : null}
        </div>
    );
}

export default function Cuentas() {
    const [busqueda, setBusqueda] = useState("");
    const [del, setDel] = useState(() => todayYMD());
    const [al, setAl] = useState(() => todayYMD());

    const rangoInvalido = !!del && !!al && del > al;

    // Paginación (CUENTA-05): página 1-based por panel.
    const [pageEntradas, setPageEntradas] = useState(1);
    const [pageSalidas, setPageSalidas] = useState(1);

    // Búsqueda server-side con debounce: el texto viaja al backend (no filtra en cliente).
    const [qDebounced, setQDebounced] = useState("");
    useEffect(() => {
        const t = setTimeout(() => setQDebounced(busqueda.trim()), 300);
        return () => clearTimeout(t);
    }, [busqueda]);

    // Al cambiar rango o búsqueda, volver a la primera página.
    useEffect(() => {
        setPageEntradas(1);
        setPageSalidas(1);
    }, [del, al, qDebounced]);

    // Lecturas cacheadas (TanStack Query). Rango + búsqueda + página forman la queryKey.
    const entradasQuery = useCuentasEntradas(
        { del, al, q: qDebounced, page: pageEntradas },
        !rangoInvalido,
    );
    const salidasQuery = useCuentasSalidas(
        { del, al, q: qDebounced, page: pageSalidas },
        !rangoInvalido,
    );
    // Totales de cabecera sobre TODO el rango (no solo la página visible).
    const resumenQuery = useCuentasResumen({ del, al, q: qDebounced }, !rangoInvalido);
    const proveedoresQuery = useCuentasProveedoresMini();

    // Escrituras (mutaciones con invalidación en onSuccess).
    const createGasto = useCreateGasto();
    const updateGasto = useUpdateGasto();
    const deleteGasto = useDeleteGasto();
    const updatePago = useUpdatePago();
    const anularPago = useAnularPago();

    const proveedores: ProveedorMiniDto[] = useMemo(
        () => proveedoresQuery.data ?? [],
        [proveedoresQuery.data],
    );
    const loadingProveedores = proveedoresQuery.isFetching;
    const errProveedores = proveedoresQuery.isError
        ? String(
              (proveedoresQuery.error as any)?.message ??
                  "Error cargando proveedores",
          )
        : null;

    const proveedoresMap = useMemo(() => {
        const m = new Map<string, string>();
        for (const p of proveedores) m.set(p.ID_Proveedor, p.Nombre_Empresa);
        return m;
    }, [proveedores]);

    const entradasDB = useMemo(() => entradasQuery.data ?? [], [entradasQuery.data]);
    const loadingEntradas = entradasQuery.isFetching;

    const salidasDB = useMemo(() => salidasQuery.data ?? [], [salidasQuery.data]);
    const loadingSalidas = salidasQuery.isFetching;

    // Wrapper que conserva el nombre/uso previo: refresca proveedores bajo demanda.
    const ensureProveedores = async () => {
        await proveedoresQuery.refetch();
    };

    const [confirmAccion, setConfirmAccion] = useState<
        | { tipo: "gasto"; gasto: SalidaDto }
        | { tipo: "entrada"; entrada: EntradaDto }
        | null
    >(null);
    const [confirmando, setConfirmando] = useState(false);
    const [confirmError, setConfirmError] = useState<string | null>(null);
    /// Motivo de la anulación (CUENTA-07). Obligatorio: quién y cuándo los pone el sistema, el
    /// porqué sólo puede ponerlo quien anula.
    const [motivoAnulacion, setMotivoAnulacion] = useState("");
    /**
     * FISCAL-01: cuál de los dos instrumentos se está usando. Arranca **sin elegir** a propósito.
     *
     * Son dos cosas legalmente distintas —anular una factura que no respondía a una operación real
     * frente a rectificar una que sí— y la mayoría de las veces lo que hace falta es la segunda.
     * Preseleccionar una sería elegir por el usuario en la única decisión de esta pantalla que no
     * se puede deshacer: el registro que se emita no se modifica jamás.
     */
    const [claseBaja, setClaseBaja] = useState<ClaseBaja | null>(null);

    const [openAddGasto, setOpenAddGasto] = useState(false);
    const [gFecha, setGFecha] = useState(() => todayYMD());
    const [gTipo, setGTipo] = useState("Suministros");
    const [gConcepto, setGConcepto] = useState("");
    const gImporte = useImporte();
    const [gProveedorId, setGProveedorId] = useState<string>("");
    const [savingGasto, setSavingGasto] = useState(false);
    const savingGastoRef = useRef(false);
    const [errGasto, setErrGasto] = useState<string | null>(null);
    const [gPagadoConCaja, setGPagadoConCaja] = useState(false);

    const [savingPdf, setSavingPdf] = useState(false);
    const [pdfError, setPdfError] = useState<string | null>(null);

    const [openEditGasto, setOpenEditGasto] = useState(false);
    const [editGastoId, setEditGastoId] = useState<string | null>(null);
    const [egFecha, setEgFecha] = useState("");
    const [egTipo, setEgTipo] = useState("Suministros");
    const [egConcepto, setEgConcepto] = useState("");
    const egImporte = useImporte();
    const [egProveedorId, setEgProveedorId] = useState<string>("");
    const [savingEditGasto, setSavingEditGasto] = useState(false);
    const [errEditGasto, setErrEditGasto] = useState<string | null>(null);
    const [egPagadoConCaja, setEgPagadoConCaja] = useState(false);

    const [openEditPago, setOpenEditPago] = useState(false);
    // Ticket que se está reimprimiendo (null = ninguno). Ver `reimprimirTicket`.
    const [reimpresion, setReimpresion] = useState<Reimpresion | null>(null);
    const [editPagoId, setEditPagoId] = useState<string | null>(null);
    const [epFechaHora, setEpFechaHora] = useState("");
    const [epMetodo, setEpMetodo] = useState<"Tarjeta" | "Efectivo">("Efectivo");
    // El importe de un cobro no se edita (CUENTA-02): sólo se enseña.
    const [epImporte, setEpImporte] = useState<Dinero>(CERO);
    const [savingEditPago, setSavingEditPago] = useState(false);
    const [errEditPago, setErrEditPago] = useState<string | null>(null);

    const [openCierre, setOpenCierre] = useState(false);
    const [cierres, setCierres] = useState<CierreResumenDto[]>([]);
    const [cierresError, setCierresError] = useState<string | null>(null);

    /**
     * CAJA-01: un cambio que toca un cierre de caja ya hecho se enseña antes de hacerlo. No se
     * bloquea nada: es el «¿seguro?» con lo que va a cambiar delante, y el motivo si mueve un
     * descuadre. `hacer` es el cambio de verdad, que se ejecuta al confirmar.
     */
    const [aviso, setAviso] = useState<{
        impacto: ImpactoCajaDto;
        motivoYaDado: boolean;
        hacer: (motivo: string | null) => Promise<void>;
    } | null>(null);
    const [avisoGuardando, setAvisoGuardando] = useState(false);
    const [avisoError, setAvisoError] = useState<string | null>(null);

    const recargarCierres = React.useCallback(async () => {
        try {
            setCierres(await cierreListar(50));
            setCierresError(null);
        } catch (e) {
            setCierresError(toAppError(e).message);
        }
    }, []);

    useEffect(() => {
        void recargarCierres();
    }, [recargarCierres]);

    const imprimirCierre = async (idCierre: string) => {
        try {
            await cierreImprimir(await cierreDetalle(idCierre));
        } catch (e) {
            setCierresError(toAppError(e).message);
        }
    };

    // Deshacer un cierre es para volver a contar el cajón, y por eso sólo se ofrece en el último
    // (CAJA-01): el de hace tres días ya no se puede contar otra vez. Corregir un apunte de un cierre
    // ya hecho no necesita deshacer nada: se rectifica solo. Queda registrado quién y cuándo.
    const idUltimoCierre = cierres.find((c) => !c.reabierto_en)?.id_cierre ?? null;
    const deshacerCierre = async (idCierre: string) => {
        try {
            await cierreReabrir(idCierre);
            await recargarCierres();
        } catch (e) {
            setCierresError(toAppError(e).message);
        }
    };

    /**
     * Hace el cambio directamente si es del periodo abierto; si toca un cierre ya hecho, primero lo
     * enseña y espera a que se confirme. Los errores del cambio hecho aquí suben al que llama; los
     * del cambio confirmado desde el aviso se pintan en el aviso.
     */
    const conAvisoDeCierre = async (
        cambio: CambioCajaInput,
        hacer: (motivo: string | null) => Promise<void>,
        motivoYaDado = false,
    ) => {
        const impacto = await cuentasPrevisualizarCambio(cambio);
        if (impacto.cierres.length === 0) {
            await hacer(null);
            return;
        }
        setAvisoError(null);
        setAviso({ impacto, motivoYaDado, hacer });
    };

    const confirmarAviso = async (motivo: string | null) => {
        if (!aviso) return;
        setAvisoGuardando(true);
        setAvisoError(null);
        try {
            await aviso.hacer(motivo);
            setAviso(null);
        } catch (e) {
            setAvisoError(toAppError(e).message);
        } finally {
            setAvisoGuardando(false);
        }
    };

    // Mostrar errores de carga como antes (los logs/efectos previos se sustituyen por
    // los estados de error de las queries).
    useEffect(() => {
        if (entradasQuery.isError) {
            console.error("Error cargando ingresos:", entradasQuery.error);
        }
    }, [entradasQuery.isError, entradasQuery.error]);

    useEffect(() => {
        if (salidasQuery.isError) {
            console.error("Error cargando salidas:", salidasQuery.error);
        }
    }, [salidasQuery.isError, salidasQuery.error]);

    // La búsqueda y la paginación se hacen en el servidor (CUENTA-05): la lista ya llega filtrada
    // y paginada, así que se muestra tal cual (sin filtrar de nuevo en cliente).
    const entradasFiltradas = entradasDB;
    const salidasFiltradas = salidasDB;

    // Totales de cabecera: del resumen agregado (todo el rango + búsqueda), no de la página visible.
    const resumen = resumenQuery.data;
    const totalEntradas = resumen?.total_entradas ?? CERO;
    const totalSalidas = resumen?.total_salidas ?? CERO;
    const balance = restar(totalEntradas, totalSalidas);

    // Controles de paginación: hay "siguiente" si aún quedan filas por debajo del total del resumen.
    // Los anulados salen en la lista pero NO cuentan en `countEntradas` (no son ventas), así que
    // la paginación tiene que sumar los dos o la última página se quedaría corta.
    const hasNextEntradas =
        pageEntradas * CUENTAS_PAGE_SIZE <
        (resumen?.count_entradas ?? 0) + (resumen?.count_anuladas ?? 0);
    const hasNextSalidas =
        pageSalidas * CUENTAS_PAGE_SIZE < (resumen?.count_salidas ?? 0);

    const abrirModalGasto = async () => {
        setErrGasto(null);
        setGFecha(todayYMD());
        setGTipo("Suministros");
        setGConcepto("");
        gImporte.poner(null);
        setGProveedorId("");
        setGPagadoConCaja(false);
        await ensureProveedores();
        setOpenAddGasto(true);
    };

    const abrirEditarGasto = async (s: SalidaDto) => {
        setErrEditGasto(null);
        setEditGastoId(s.id);
        setEgFecha(s.fecha_hora);
        setEgTipo(s.tipo_gasto || "Suministros");
        setEgConcepto(s.concepto || "");
        // RI-53: se rellenaba con los céntimos en crudo («1250») y se releía como euros, así que
        // guardar sin tocar nada multiplicaba el gasto por 100.
        egImporte.poner(s.importe);
        setEgProveedorId(s.proveedor_id ?? "");
        setEgPagadoConCaja(s.pagado_con_caja);
        await ensureProveedores();
        setOpenEditGasto(true);
    };

    const guardarEditarGasto = async () => {
        try {
            setErrEditGasto(null);
            if (!editGastoId) return;

            const fecha = (egFecha || "").trim();
            const tipo = (egTipo || "").trim();
            const concepto = (egConcepto || "").trim();
            const importe = egImporte.valor ?? CERO;

            const provRaw = (egProveedorId || "").trim();
            const proveedorId = provRaw === "" ? null : provRaw;

            if (!fecha) return setErrEditGasto("La fecha es obligatoria.");
            if (!tipo) return setErrEditGasto("El tipo es obligatorio.");
            if (!concepto) return setErrEditGasto("El concepto es obligatorio.");
            if (!egImporte.legible) return setErrEditGasto("El importe no se entiende.");
            if (importe <= 0) {
                return setErrEditGasto("El importe debe ser mayor que 0.");
            }

            if (tipo === "Proveedor") {
                if (!proveedorId) {
                    return setErrEditGasto("Selecciona un proveedor.");
                }
            }

            setSavingEditGasto(true);

            const idGasto = editGastoId;
            const pagadoConCaja = egPagadoConCaja;
            await conAvisoDeCierre(
                { tipo: "editar_gasto", id_gasto: idGasto, fecha, importe, pagado_con_caja: pagadoConCaja },
                async (motivo) => {
                    const ok = await updateGasto.mutateAsync({
                        args: {
                            id_gasto: idGasto,
                            fecha,
                            tipo_gasto: tipo,
                            concepto,
                            importe,
                            proveedor_id: tipo === "Proveedor" ? (proveedorId ?? undefined) : undefined,
                            pagado_con_caja: pagadoConCaja,
                        },
                        motivoRectificacion: motivo,
                    });
                    if (!ok) throw new Error("No se pudo actualizar el gasto.");
                    setOpenEditGasto(false);
                    void recargarCierres();
                },
            );
        } catch (e: any) {
            console.error(e);
            setErrEditGasto(String(e?.message ?? "Error actualizando gasto"));
        } finally {
            setSavingEditGasto(false);
        }
    };

    const borrarGasto = (s: SalidaDto) => {
        setConfirmError(null);
        setConfirmAccion({ tipo: "gasto", gasto: s });
    };

    /**
     * Vuelve a sacar un ticket ya cobrado.
     *
     * Todo se lee del cobro guardado —número, método, origen y los tipos de IVA congelados en sus
     * líneas—, así que la copia dice lo mismo que dijo el original aunque hoy hayan cambiado los
     * precios o los tipos. Y sale marcada como COPIA: dos papeles idénticos parecerían dos ventas.
     */
    const reimprimirTicket = async (e: EntradaDto) => {
        try {
            const t = await invokeClient<TicketReimpresionDto | null>(
                "cuentas_ticket_para_reimprimir",
                { idPago: e.id },
            );
            if (!t) return;

            setReimpresion({
                items: t.lineas.map((l: LineaTicketDto, i: number) => ({
                    id: `${e.id}-${i}`,
                    nombre: l.nombre,
                    precio: l.precio_unitario,
                    cantidad: l.cantidad,
                    pagado: true,
                    ivaPercent: l.iva_percent ?? null,
                })),
                datos: {
                    numeroTicket: t.numero_ticket || null,
                    metodoPago: t.metodo_pago || null,
                    origen: t.origen || null,
                    esCopia: true,
                    esAnulado: t.anulado,
                },
            });
        } catch (err) {
            console.error("cuentas_ticket_para_reimprimir falló:", err);
        }
    };

    /* ── FISCAL-02: la factura completa EN SUSTITUCIÓN (`F3`) ───────────────────
       Es el «¿me lo puedes hacer con IVA?» del día siguiente: el cliente vuelve con un ticket ya
       expedido y pide factura.

       **No rectifica nada** (art. 15.6 ROF): canjear una simplificada por una completa no es
       rectificar, así que la original se queda exactamente como está y se emite un registro nuevo
       que la referencia en `FacturasSustituidas`. Por eso el botón no se esconde cuando el cobro ya
       tiene factura: un cliente puede pedirla con días de diferencia y lo que hay que poder hacer es
       emitirla, no impedirlo.

       Lo que sí se esconde es en los **anulados**: un cobro que no existe no se puede facturar. */
    const limiteSimplif = useBusinessSettings((st) => st.limiteSimplif);
    const [f3Pago, setF3Pago] = useState<EntradaDto | null>(null);
    const [f3Guardando, setF3Guardando] = useState(false);
    const [f3Error, setF3Error] = useState<string | null>(null);

    const emitirFacturaSustitutiva = async (e: EntradaDto, d: DestinatarioInput) => {
        setF3Guardando(true);
        setF3Error(null);
        try {
            // El número de la factura original no viaja en la fila de la lista; se pide por el mismo
            // camino que la reimpresión, que es el que ya sabe resolverlo desde el id del pago.
            const t = await invokeClient<TicketReimpresionDto | null>(
                "cuentas_ticket_para_reimprimir",
                { idPago: e.id },
            );
            const numero = (t?.numero_ticket ?? "").trim();
            if (!numero) {
                setF3Error(
                    "Ese cobro no tiene número de factura, así que no hay nada que sustituir. " +
                        "Pasa con los cobros anteriores a que el negocio completara sus datos fiscales.",
                );
                return;
            }

            await invokeClient("verifactu_emitir_factura_de_ticket", {
                numeroTicket: numero,
                destinatario: d,
            });

            setF3Pago(null);
            // Y se imprime, que es para lo que ha venido el cliente.
            await reimprimirTicket(e);
        } catch (err) {
            setF3Error(toAppError(err).message);
        } finally {
            setF3Guardando(false);
        }
    };

    const abrirEditarPago = (e: EntradaDto) => {
        setErrEditPago(null);
        setEditPagoId(e.id);
        setEpFechaHora(e.fecha_hora);
        setEpMetodo(e.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo");
        setEpImporte(e.importe);
        setOpenEditPago(true);
    };

    const guardarEditarPago = async () => {
        try {
            setErrEditPago(null);
            if (!editPagoId) return;

            const fechaHora = (epFechaHora || "").trim();
            // El importe no se edita (CUENTA-02): el backend lo recalcula desde las líneas cobradas.
            const importe = epImporte;

            if (!fechaHora) return setErrEditPago("La fecha/hora es obligatoria.");

            setSavingEditPago(true);

            const idPago = editPagoId;
            const metodo = epMetodo;
            await conAvisoDeCierre(
                { tipo: "editar_pago", id_pago: idPago, fecha_hora: fechaHora, metodo },
                async (motivo) => {
                    const ok = await updatePago.mutateAsync({
                        args: { id_pago: idPago, fecha_hora: fechaHora, metodo, importe },
                        motivoRectificacion: motivo,
                    });
                    if (!ok) throw new Error("No se pudo actualizar la entrada.");
                    setOpenEditPago(false);
                    void recargarCierres();
                },
            );
        } catch (e: any) {
            console.error(e);
            setErrEditPago(String(e?.message ?? "Error actualizando entrada"));
        } finally {
            setSavingEditPago(false);
        }
    };

    const borrarPago = (e: EntradaDto) => {
        setConfirmError(null);
        setMotivoAnulacion("");
        setClaseBaja(null);
        setConfirmAccion({ tipo: "entrada", entrada: e });
    };

    const confirmarBorrado = async () => {
        if (!confirmAccion) return;

        setConfirmando(true);
        setConfirmError(null);

        try {
            if (confirmAccion.tipo === "gasto") {
                const idGasto = confirmAccion.gasto.id;
                await conAvisoDeCierre({ tipo: "borrar_gasto", id_gasto: idGasto }, async (motivo) => {
                    await deleteGasto.mutateAsync({ args: { id_gasto: idGasto }, motivoRectificacion: motivo });
                    setConfirmAccion(null);
                    void recargarCierres();
                });
            } else {
                const idPago = confirmAccion.entrada.id;
                const motivo = motivoAnulacion;
                // El botón está deshabilitado hasta que se elige, así que aquí nunca es null.
                // El `?? "ERROR"` es el lado conservador si alguna vez lo fuera: una anulación
                // devuelve las líneas y el stock, que es reversible.
                const clase = claseBaja ?? "ERROR";
                await conAvisoDeCierre(
                    // REV-08: la clase viaja también en la previsualización. Una devolución no
                    // toca el cierre de la venta, así que enseñar lo contrario sería pedir un
                    // motivo por un descuadre que no va a ocurrir.
                    { tipo: "anular_pago", id_pago: idPago, clase },
                    async () => {
                        await anularPago.mutateAsync({ id_pago: idPago, motivo, clase });
                        setConfirmAccion(null);
                        void recargarCierres();
                    },
                    // Anular pide el motivo siempre, y ése es también el de la rectificación.
                    true,
                );
            }
        } catch (e: any) {
            console.error("Error en la operación de caja:", e);
            setConfirmError(toAppError(e).message);
        } finally {
            setConfirmando(false);
        }
    };

    const guardarGasto = async () => {
        // Guard síncrono: evita doble-submit antes de que React repinte el estado.
        if (savingGastoRef.current) return;
        savingGastoRef.current = true;
        setSavingGasto(true);
        try {
            setErrGasto(null);

            const fecha = (gFecha || "").trim();
            const tipo = (gTipo || "").trim();
            const concepto = (gConcepto || "").trim();
            const importe = gImporte.valor ?? CERO;

            const provRaw = (gProveedorId || "").trim();
            const proveedorId = provRaw === "" ? null : provRaw;

            if (!fecha) { setErrGasto("La fecha es obligatoria."); return; }
            if (!tipo) { setErrGasto("El tipo es obligatorio."); return; }
            if (!concepto) { setErrGasto("El concepto es obligatorio."); return; }
            if (!gImporte.legible) { setErrGasto("El importe no se entiende."); return; }
            if (importe <= 0) {
                setErrGasto("El importe debe ser un número mayor que 0.");
                return;
            }

            if (tipo === "Proveedor" && !proveedorId) {
                setErrGasto("Selecciona un proveedor.");
                return;
            }

            const pagadoConCaja = gPagadoConCaja;
            await conAvisoDeCierre(
                { tipo: "crear_gasto", fecha, importe, pagado_con_caja: pagadoConCaja },
                async (motivo) => {
                    const ok = await createGasto.mutateAsync({
                        args: {
                            fecha,
                            tipo_gasto: tipo,
                            concepto,
                            importe,
                            proveedor_id: tipo === "Proveedor" ? (proveedorId ?? undefined) : undefined,
                            pagado_con_caja: pagadoConCaja,
                        },
                        motivoRectificacion: motivo,
                    });
                    if (!ok) throw new Error("No se pudo guardar el gasto.");
                    setOpenAddGasto(false);
                    void recargarCierres();
                },
            );
        } catch (e: any) {
            console.error(e);
            setErrGasto(String(e?.message ?? "Error guardando gasto"));
        } finally {
            savingGastoRef.current = false;
            setSavingGasto(false);
        }
    };

    const guardarPdf = async () => {
        try {
            setPdfError(null);
            setSavingPdf(true);

            const defaultName = `cuentas_${del || "inicio"}_${al || "fin"}.pdf`;

            const filePath = await save({
                title: "Guardar PDF de Cuentas",
                defaultPath: defaultName,
                filters: [{ name: "PDF", extensions: ["pdf"] }],
            });

            if (!filePath) return;

            // El PDF refleja TODO el rango (no la página visible): traemos todas las filas sin
            // paginar (page/pageSize omitidos ⇒ el backend devuelve el conjunto completo).
            const [entradasRaw, salidasRaw] = await Promise.all([
                cuentasGetEntradas({ del, al, q: qDebounced }),
                cuentasGetSalidas({ del, al, q: qDebounced }),
            ]);
            const entradasFull = entradasRaw;
            const salidasFull = salidasRaw;
            // Un cobro anulado no es una venta: no suma (CUENTA-07). Sale en el listado igual, y
            // marcado, porque este PDF es el documento con el que se cuadra la caja y una salida
            // de dinero que no aparece es exactamente lo que no se puede explicar después.
            const totalEntradasPdf = sumar(
                ...entradasFull.map((e) => (esAnulado(e) ? CERO : e.importe)),
            );
            const totalSalidasPdf = sumar(...salidasFull.map((s) => s.importe));
            const balancePdf = restar(totalEntradasPdf, totalSalidasPdf);

            const pdfDoc = await PDFDocument.create();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

            const PAGE_W = 595.28;
            const PAGE_H = 841.89;
            const M = 50;

            const mkPage = () => {
                const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
                return { page, y: PAGE_H - M };
            };

            const gray = rgb(0.35, 0.35, 0.35);
            const black = rgb(0.1, 0.1, 0.1);


            const safeText = (t: any) =>
                asciiSafe(
                    String(t ?? "")
                        .replace(/\s+/g, " ")
                        .trim(),
                );

            const drawLine = (ctx: any) => {
                if (ctx.y < M + 20) ctx = mkPage();
                ctx.page.drawLine({
                    start: { x: M, y: ctx.y },
                    end: { x: PAGE_W - M, y: ctx.y },
                    thickness: 1,
                    color: rgb(0.9, 0.9, 0.9),
                });
                ctx.y -= 10;
                return ctx;
            };

            const write = (
                ctx: any,
                text: string,
                opts?: { size?: number; bold?: boolean; color?: any },
            ) => {
                const size = opts?.size ?? 11;
                const usedFont = opts?.bold ? fontBold : font;
                const color = opts?.color ?? black;

                if (ctx.y < M + 40) ctx = mkPage();

                ctx.page.drawText(safeText(text), {
                    x: M,
                    y: ctx.y,
                    size,
                    font: usedFont,
                    color,
                });
                ctx.y -= size + 6;
                return ctx;
            };

            const writeRow = (
                ctx: any,
                cols: Array<{
                    text: string;
                    x: number;
                    w?: number;
                    align?: "left" | "right";
                }>,
                opts?: { size?: number; bold?: boolean; color?: any },
            ) => {
                const size = opts?.size ?? 10;
                const usedFont = opts?.bold ? fontBold : font;
                const color = opts?.color ?? black;

                if (ctx.y < M + 30) ctx = mkPage();

                for (const c of cols) {
                    const t = safeText(c.text);
                    let x = c.x;

                    if (c.align === "right") {
                        const w = usedFont.widthOfTextAtSize(t, size);
                        x = c.x + (c.w ?? 0) - w;
                    }

                    ctx.page.drawText(t, {
                        x,
                        y: ctx.y,
                        size,
                        font: usedFont,
                        color,
                    });
                }

                ctx.y -= size + 6;
                return ctx;
            };

            let ctx = mkPage();

            ctx = write(ctx, "Cuentas", { size: 20, bold: true });
            ctx = write(ctx, `Rango: ${del || "-"}  a  ${al || "-"}`, {
                size: 11,
                color: gray,
            });
            ctx = write(
                ctx,
                `Entradas: ${eur(totalEntradasPdf)} | Salidas: ${eur(
                    totalSalidasPdf,
                )} | Balance: ${eur(balancePdf)}`,
                { size: 12, bold: true },
            );
            ctx.y -= 6;
            ctx = drawLine(ctx);

            ctx.y -= 16;
            ctx = write(ctx, "Entradas", { size: 14, bold: true });
            ctx = writeRow(
                ctx,
                [
                    { text: "Fecha/Hora", x: M },
                    { text: "Cliente", x: M + 140 },
                    { text: "Metodo", x: M + 380 },
                    {
                        text: "Importe",
                        x: M + 460,
                        w: PAGE_W - M - (M + 460),
                        align: "right",
                    },
                ],
                { bold: true, color: gray },
            );
            ctx = drawLine(ctx);
            ctx.y -= 8;

            if (!entradasFull.length) {
                ctx = write(ctx, "Sin entradas para este rango/filtro.", { color: gray });
            } else {
                for (const e of entradasFull) {
                    ctx = writeRow(ctx, [
                        { text: e.fecha_hora, x: M },
                        { text: e.cliente, x: M + 140 },
                        { text: esAnulado(e) ? `${e.metodo} · ANULADO` : e.metodo, x: M + 380 },
                        {
                            text: eur(e.importe),
                            x: M + 460,
                            w: PAGE_W - M - (M + 460),
                            align: "right",
                        },
                    ]);
                }
            }

            ctx.y -= 8;
            ctx = drawLine(ctx);

            ctx.y -= 16;
            ctx = write(ctx, "Salidas", { size: 14, bold: true });
            ctx = writeRow(
                ctx,
                [
                    { text: "Fecha", x: M },
                    { text: "Tipo", x: M + 110 },
                    { text: "Concepto", x: M + 230 },
                    {
                        text: "Importe",
                        x: M + 460,
                        w: PAGE_W - M - (M + 460),
                        align: "right",
                    },
                ],
                { bold: true, color: gray },
            );
            ctx = drawLine(ctx);
            ctx.y -= 8;

            if (!salidasFull.length) {
                ctx = write(ctx, "Sin salidas para este rango/filtro.", { color: gray });
            } else {
                for (const s of salidasFull) {
                    const provName = s.proveedor_id ? proveedoresMap.get(s.proveedor_id) : null;

                    const conceptoPdf =
                        s.tipo_gasto === "Proveedor" && (provName || s.proveedor_id)
                            ? `${s.concepto} (Prov: ${provName ?? s.proveedor_id})`
                            : s.concepto;

                    ctx = writeRow(ctx, [
                        { text: s.fecha_hora, x: M },
                        { text: s.tipo_gasto, x: M + 110 },
                        { text: conceptoPdf, x: M + 230 },
                        {
                            text: eur(s.importe),
                            x: M + 460,
                            w: PAGE_W - M - (M + 460),
                            align: "right",
                        },
                    ]);
                }
            }

            if (ctx.y < M + 60) ctx = mkPage();
            ctx.y = M;
            ctx.page.drawText(safeText(`Generado: ${new Date().toLocaleString("es-ES")}`), {
                x: M,
                y: ctx.y,
                size: 9,
                font,
                color: gray,
            });

            const bytes = await pdfDoc.save();
            await writeFile(filePath, new Uint8Array(bytes));
        } catch (e: any) {
            console.error("Error guardando PDF:", e);
            setPdfError(String(e?.message ?? "Error guardando PDF"));
        } finally {
            setSavingPdf(false);
        }
    };

    const sacarCuentaDelDia = async () => {
        try {
            setPdfError(null);
            setSavingPdf(true);

            const hoy = todayYMD();

            const entradasHoy = await cuentasGetEntradas({ del: hoy, al: hoy });
            const salidasHoy = await cuentasGetSalidas({ del: hoy, al: hoy });

            const entradasHoyF = entradasHoy ?? [];
            const salidasHoyF = salidasHoy ?? [];

            const totalEntradasHoy = sumar(
                ...entradasHoyF.map((e) => (esAnulado(e) ? CERO : e.importe)),
            );
            const totalSalidasHoy = sumar(...salidasHoyF.map((s) => s.importe));
            const balanceHoy = restar(totalEntradasHoy, totalSalidasHoy);

            const defaultName = `cuenta_dia_${hoy}.pdf`;
            const filePath = await save({
                title: "Sacar cuenta del dia (PDF)",
                defaultPath: defaultName,
                filters: [{ name: "PDF", extensions: ["pdf"] }],
            });
            if (!filePath) return;

            const pdfDoc = await PDFDocument.create();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

            const PAGE_W = 595.28;
            const PAGE_H = 841.89;
            const M = 50;

            const mkPage = () => {
                const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
                return { page, y: PAGE_H - M };
            };

            const gray = rgb(0.35, 0.35, 0.35);
            const black = rgb(0.1, 0.1, 0.1);
            const safeText = (t: any) =>
                asciiSafe(
                    String(t ?? "")
                        .replace(/\s+/g, " ")
                        .trim(),
                );

            const drawLine = (ctx: any) => {
                if (ctx.y < M + 20) ctx = mkPage();
                ctx.page.drawLine({
                    start: { x: M, y: ctx.y },
                    end: { x: PAGE_W - M, y: ctx.y },
                    thickness: 1,
                    color: rgb(0.9, 0.9, 0.9),
                });
                ctx.y -= 10;
                return ctx;
            };

            const write = (
                ctx: any,
                text: string,
                opts?: { size?: number; bold?: boolean; color?: any },
            ) => {
                const size = opts?.size ?? 11;
                const usedFont = opts?.bold ? fontBold : font;
                const color = opts?.color ?? black;

                if (ctx.y < M + 40) ctx = mkPage();

                ctx.page.drawText(safeText(text), {
                    x: M,
                    y: ctx.y,
                    size,
                    font: usedFont,
                    color,
                });
                ctx.y -= size + 6;
                return ctx;
            };

            const writeRow = (
                ctx: any,
                cols: Array<{
                    text: string;
                    x: number;
                    w?: number;
                    align?: "left" | "right";
                }>,
                opts?: { size?: number; bold?: boolean; color?: any },
            ) => {
                const size = opts?.size ?? 10;
                const usedFont = opts?.bold ? fontBold : font;
                const color = opts?.color ?? black;

                if (ctx.y < M + 30) ctx = mkPage();

                for (const c of cols) {
                    const t = safeText(c.text);
                    let x = c.x;
                    if (c.align === "right") {
                        const w = usedFont.widthOfTextAtSize(t, size);
                        x = c.x + (c.w ?? 0) - w;
                    }
                    ctx.page.drawText(t, {
                        x,
                        y: ctx.y,
                        size,
                        font: usedFont,
                        color,
                    });
                }

                ctx.y -= size + 6;
                return ctx;
            };

            let ctx = mkPage();

            ctx = write(ctx, "Cuenta del dia", { size: 20, bold: true });
            ctx = write(ctx, `Fecha: ${hoy}`, { size: 11, color: gray });
            ctx = write(
                ctx,
                `Entradas: ${eur(totalEntradasHoy)} | Salidas: ${eur(
                    totalSalidasHoy,
                )} | Balance: ${eur(balanceHoy)}`,
                { size: 12, bold: true },
            );
            ctx.y -= 6;
            ctx = drawLine(ctx);

            ctx.y -= 16;
            ctx = write(ctx, "Entradas", { size: 14, bold: true });
            ctx = writeRow(
                ctx,
                [
                    { text: "Fecha/Hora", x: M },
                    { text: "Cliente", x: M + 140 },
                    { text: "Metodo", x: M + 380 },
                    {
                        text: "Importe",
                        x: M + 460,
                        w: PAGE_W - M - (M + 460),
                        align: "right",
                    },
                ],
                { bold: true, color: gray },
            );
            ctx = drawLine(ctx);
            ctx.y -= 8;

            if (!entradasHoyF.length) {
                ctx = write(ctx, "Sin entradas hoy.", { color: gray });
            } else {
                for (const e of entradasHoyF) {
                    ctx = writeRow(ctx, [
                        { text: e.fecha_hora, x: M },
                        { text: e.cliente, x: M + 140 },
                        {
                            text: esAnulado(e) ? `${e.metodo} · ANULADO` : e.metodo,
                            x: M + 380,
                        },
                        {
                            text: eur(e.importe),
                            x: M + 460,
                            w: PAGE_W - M - (M + 460),
                            align: "right",
                        },
                    ]);
                }
            }

            ctx.y -= 8;
            ctx = drawLine(ctx);

            ctx.y -= 16;
            ctx = write(ctx, "Salidas", { size: 14, bold: true });
            ctx = writeRow(
                ctx,
                [
                    { text: "Fecha", x: M },
                    { text: "Tipo", x: M + 110 },
                    { text: "Concepto", x: M + 230 },
                    {
                        text: "Importe",
                        x: M + 460,
                        w: PAGE_W - M - (M + 460),
                        align: "right",
                    },
                ],
                { bold: true, color: gray },
            );
            ctx = drawLine(ctx);
            ctx.y -= 8;

            if (!salidasHoyF.length) {
                ctx = write(ctx, "Sin salidas hoy.", { color: gray });
            } else {
                for (const s of salidasHoyF) {
                    const fecha = s.fecha_hora;
                    const tipo = s.tipo_gasto;
                    const conceptoBase = s.concepto;
                    const provId = s.proveedor_id;
                    const provName = provId ? proveedoresMap.get(provId) : null;

                    const concepto =
                        tipo === "Proveedor" && (provName || provId)
                            ? `${conceptoBase} (Prov: ${provName ?? provId})`
                            : conceptoBase;

                    ctx = writeRow(ctx, [
                        { text: fecha.slice(0, 10), x: M },
                        { text: tipo, x: M + 110 },
                        { text: concepto, x: M + 230 },
                        {
                            text: eur(s.importe),
                            x: M + 460,
                            w: PAGE_W - M - (M + 460),
                            align: "right",
                        },
                    ]);
                }
            }

            if (ctx.y < M + 60) ctx = mkPage();
            ctx.y = M;
            ctx.page.drawText(safeText(`Generado: ${new Date().toLocaleString("es-ES")}`), {
                x: M,
                y: ctx.y,
                size: 9,
                font,
                color: gray,
            });

            const bytes = await pdfDoc.save();
            await writeFile(filePath, new Uint8Array(bytes));
        } catch (e: any) {
            console.error("Error sacar cuenta del dia:", e);
            setPdfError(String(e?.message ?? "Error sacar cuenta del dia"));
        } finally {
            setSavingPdf(false);
        }
    };

    const proveedorLabel = (id: string | null | undefined) => {
        if (!id) return "";
        return proveedoresMap.get(id) ?? `Proveedor #${id}`;
    };

    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-hidden bg-bg p-3 sm:p-4 lg:px-10 lg:py-5">
            {/* HEADER */}
            <div className="flex w-full shrink-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                            <Wallet className="size-6" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-xl font-bold text-fg sm:text-2xl">Cuentas</h1>
                            <p className="text-sm text-fg-muted">
                                Filtra ingresos y gastos por fecha o búsqueda.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Badge>Entradas: {eur(totalEntradas)}</Badge>
                        <Badge>Salidas: {eur(totalSalidas)}</Badge>
                        {/* Sólo aparece si ha habido alguna: un contador a cero todos los días
                            deja de leerse, y éste es el número por el que hay que preguntar. */}
                        {(resumen?.count_anuladas ?? 0) > 0 ? (
                            <Badge>
                                <span className="text-danger">
                                    Anulados: {resumen?.count_anuladas} · {eur(resumen?.total_anulado ?? CERO)}
                                </span>
                            </Badge>
                        ) : null}
                        <Badge>
                            Balance:{" "}
                            <span className={balance >= 0 ? "text-success" : "text-danger"}>
                                {eur(balance)}
                            </span>
                        </Badge>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                    <div className="md:col-span-7">
                        <SearchInput
                            value={busqueda}
                            onValueChange={setBusqueda}
                            placeholder="Buscar (cliente, concepto, método, importe...)"
                        />
                    </div>

                    <div className="md:col-span-5">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <label className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-1.5">
                                <span className="w-8 text-xs font-medium text-fg-muted">Del</span>
                                <input
                                    type="date"
                                    value={del}
                                    onChange={(e) => setDel(e.target.value)}
                                    className="w-full bg-transparent text-xs text-fg outline-none"
                                />
                            </label>
                            <label className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-1.5">
                                <span className="w-8 text-xs font-medium text-fg-muted">Al</span>
                                <input
                                    type="date"
                                    value={al}
                                    onChange={(e) => setAl(e.target.value)}
                                    className="w-full bg-transparent text-xs text-fg outline-none"
                                />
                            </label>
                        </div>
                    </div>
                </div>

                {rangoInvalido && (
                    <div className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-2 text-sm text-warning">
                        La fecha «Del» no puede ser posterior a «Al».
                    </div>
                )}
                {pdfError && (
                    <div className="rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                        {pdfError}
                    </div>
                )}
            </div>

            {/* PANELES */}
            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[repeat(2,minmax(0,1fr))] gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
                        <section className="flex h-full min-h-0 overflow-hidden flex-col rounded-3xl border border-border bg-surface p-4 shadow-sm sm:p-5">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">Entradas</h2>
                                    <p className="text-sm text-fg-muted">
                                        Pagos de clientes (tarjeta o efectivo).
                                    </p>
                                </div>
                                <Badge>Total: {eur(totalEntradas)}</Badge>
                            </div>

                            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border">
                                <div className="hidden sm:grid grid-cols-12 gap-2 bg-surface-2 px-4 py-3 text-xs font-semibold text-fg-muted">
                                    <div className="col-span-3">Fecha/Hora</div>
                                    <div className="col-span-4">Cliente / Método</div>
                                    <div className="col-span-2">EUR</div>
                                    <div className="col-span-3"></div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                                    {loadingEntradas ? (
                                        <div className="p-4 text-sm text-fg-muted">Cargando entradas…</div>
                                    ) : entradasFiltradas.length ? (
                                        <div className="divide-y divide-border">
                                            {entradasFiltradas.map((e) => (
                                                <div key={e.id} className="p-4 sm:p-0">
                                                    <div className="sm:hidden flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="text-xs text-fg-muted">{e.fecha_hora}</div>
                                                            <div className={tachadoSi(esAnulado(e), "font-semibold text-fg truncate")}>
                                                                {e.cliente}
                                                            </div>
                                                            <div className="text-xs text-fg-muted">{e.metodo}</div>
                                                            <SelloAnulado entrada={e} />
                                                        </div>
                                                        <div className="flex flex-col items-end gap-2">
                                                            <div className={tachadoSi(esAnulado(e), "font-extrabold text-fg")}>
                                                                {eur(e.importe)}
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <MiniIconButton
                                                                    title="Reimprimir ticket"
                                                                    onClick={conAviso(() => reimprimirTicket(e))}
                                                                >
                                                                    <Printer className="size-4" aria-hidden />
                                                                </MiniIconButton>
                                                                {esAnulado(e) ? null : (
                                                                    <>
                                                                        <MiniIconButton
                                                                            title="Hacer factura con NIF"
                                                                            onClick={() => {
                                                                                setF3Error(null);
                                                                                setF3Pago(e);
                                                                            }}
                                                                        >
                                                                            <FileText className="size-4" aria-hidden />
                                                                        </MiniIconButton>
                                                                        <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                                                                            <Pencil className="size-4" aria-hidden />
                                                                        </MiniIconButton>
                                                                        <MiniIconButton
                                                                            title="Anular"
                                                                            variant="danger"
                                                                            onClick={() => borrarPago(e)}
                                                                        >
                                                                            <Trash2 className="size-4" aria-hidden />
                                                                        </MiniIconButton>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-3 text-sm hover:bg-surface-2">
                                                        <div className={tachadoSi(esAnulado(e), "col-span-3")}>
                                                            {e.fecha_hora}
                                                        </div>
                                                        <div className="col-span-4 min-w-0">
                                                            <div className={tachadoSi(esAnulado(e), "font-medium truncate")}>
                                                                {e.cliente}
                                                            </div>
                                                            <div className="text-xs text-fg-muted">{e.metodo}</div>
                                                            <SelloAnulado entrada={e} />
                                                        </div>
                                                        <div className={tachadoSi(esAnulado(e), "col-span-2 font-semibold")}>
                                                            {eur(e.importe)}
                                                        </div>
                                                        <div className="col-span-3 flex justify-end gap-2">
                                                            <MiniIconButton
                                                                title="Reimprimir ticket"
                                                                onClick={conAviso(() => reimprimirTicket(e))}
                                                            >
                                                                <Printer className="size-4" aria-hidden />
                                                            </MiniIconButton>
                                                            {esAnulado(e) ? null : (
                                                                <>
                                                                    <MiniIconButton
                                                                        title="Hacer factura con NIF"
                                                                        onClick={() => {
                                                                            setF3Error(null);
                                                                            setF3Pago(e);
                                                                        }}
                                                                    >
                                                                        <FileText className="size-4" aria-hidden />
                                                                    </MiniIconButton>
                                                                    <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                                                                        <Pencil className="size-4" aria-hidden />
                                                                    </MiniIconButton>
                                                                    <MiniIconButton
                                                                        title="Anular"
                                                                        variant="danger"
                                                                        onClick={() => borrarPago(e)}
                                                                    >
                                                                        <Trash2 className="size-4" aria-hidden />
                                                                    </MiniIconButton>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-4 text-sm text-fg-muted">Sin entradas.</div>
                                    )}
                                </div>
                            </div>

                            <div className="mt-3 flex flex-none items-center justify-between gap-2 text-xs text-fg-muted">
                                <span>
                                    Página {pageEntradas}
                                    {loadingEntradas ? " · cargando…" : ""}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        disabled={pageEntradas <= 1 || loadingEntradas}
                                        onClick={() => setPageEntradas((p) => Math.max(1, p - 1))}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Anterior
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!hasNextEntradas || loadingEntradas}
                                        onClick={() => setPageEntradas((p) => p + 1)}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Siguiente
                                    </button>
                                </div>
                            </div>
                        </section>

                        <section className="flex h-full min-h-0 overflow-hidden flex-col rounded-3xl border border-border bg-surface p-4 shadow-sm sm:p-5">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">Salidas</h2>
                                    <p className="text-sm text-fg-muted">Gastos del negocio.</p>
                                </div>
                                <PrimaryButton onClick={conAviso(abrirModalGasto)} className="shrink-0">
                                    Agregar gasto
                                </PrimaryButton>
                            </div>

                            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border">
                                <div className="hidden sm:grid grid-cols-12 gap-2 bg-surface-2 px-4 py-3 text-xs font-semibold text-fg-muted">
                                    <div className="col-span-2">Fecha</div>
                                    <div className="col-span-2">Tipo</div>
                                    <div className="col-span-3">Concepto</div>
                                    <div className="col-span-2">EUR</div>
                                    <div className="col-span-3"></div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                                    {loadingSalidas ? (
                                        <div className="p-4 text-sm text-fg-muted">Cargando salidas…</div>
                                    ) : salidasFiltradas.length ? (
                                        <div className="divide-y divide-border">
                                            {salidasFiltradas.map((s) => {
                                                const provText =
                                                    s.tipo_gasto === "Proveedor" && s.proveedor_id
                                                        ? proveedorLabel(s.proveedor_id)
                                                        : null;

                                                return (
                                                    <div key={s.id} className="p-4 sm:p-0">
                                                        <div className="sm:hidden flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-xs text-fg-muted">{s.fecha_hora}</div>
                                                                <div className="font-semibold text-fg truncate">
                                                                    {s.concepto}
                                                                </div>
                                                                <div className="text-xs text-fg-muted">
                                                                    {s.tipo_gasto}
                                                                    {provText ? <> · {provText}</> : null}
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-col items-end gap-2">
                                                                <div className="font-extrabold text-fg">
                                                                    {eur(s.importe)}
                                                                </div>
                                                                <div className="flex gap-2">
                                                                    <MiniIconButton title="Editar" onClick={conAviso(() => abrirEditarGasto(s))}>
                                                                        <Pencil className="size-4" aria-hidden />
                                                                    </MiniIconButton>
                                                                    <MiniIconButton
                                                                        title="Borrar"
                                                                        variant="danger"
                                                                        onClick={() => borrarGasto(s)}
                                                                    >
                                                                        <Trash2 className="size-4" aria-hidden />
                                                                    </MiniIconButton>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-3 text-sm hover:bg-surface-2">
                                                            <div className="col-span-2">{s.fecha_hora}</div>
                                                            <div className="col-span-2 truncate">
                                                                {s.tipo_gasto}
                                                                {provText ? (
                                                                    <span className="ml-1 text-xs text-fg-muted">
                                                                        ({provText})
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                            <div className="col-span-3 truncate">{s.concepto}</div>
                                                            <div className="col-span-2 font-semibold">
                                                                {eur(s.importe)}
                                                            </div>
                                                            <div className="col-span-3 flex justify-end gap-2">
                                                                <MiniIconButton title="Editar" onClick={conAviso(() => abrirEditarGasto(s))}>
                                                                    <Pencil className="size-4" aria-hidden />
                                                                </MiniIconButton>
                                                                <MiniIconButton
                                                                    title="Borrar"
                                                                    variant="danger"
                                                                    onClick={() => borrarGasto(s)}
                                                                >
                                                                    <Trash2 className="size-4" aria-hidden />
                                                                </MiniIconButton>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="p-4 text-sm text-fg-muted">Sin salidas.</div>
                                    )}
                                </div>
                            </div>

                            <div className="mt-3 flex flex-none items-center justify-between gap-2 text-xs text-fg-muted">
                                <span>
                                    Página {pageSalidas}
                                    {loadingSalidas ? " · cargando…" : ""}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        disabled={pageSalidas <= 1 || loadingSalidas}
                                        onClick={() => setPageSalidas((p) => Math.max(1, p - 1))}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Anterior
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!hasNextSalidas || loadingSalidas}
                                        onClick={() => setPageSalidas((p) => p + 1)}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Siguiente
                                    </button>
                                </div>
                            </div>
                        </section>
                    </div>

            {/* FOOTER */}
            <div className="w-full rounded-2xl border border-border bg-surface p-4 shadow-sm">
                <div className="grid grid-cols-1 gap-3 sm:flex sm:items-center sm:justify-between">
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                        <button
                            onClick={conAviso(guardarPdf)}
                            disabled={savingPdf}
                            className={cn(
                                "inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg shadow-sm transition hover:bg-surface-2 active:scale-[0.98] cursor-pointer",
                                savingPdf && "opacity-60 cursor-not-allowed",
                            )}
                        >
                            <FileDown className="size-4" aria-hidden />
                            {savingPdf ? "Generando…" : "Guardar PDF"}
                        </button>

                        <button
                            type="button"
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg shadow-sm transition hover:bg-surface-2 active:scale-[0.98] cursor-pointer"
                        >
                            <Send className="size-4" aria-hidden />
                            Enviar a gestoría
                        </button>

                        <button
                            type="button"
                            onClick={() => setOpenCierre(true)}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-4 text-sm font-extrabold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
                        >
                            <Calculator className="size-4" aria-hidden />
                            Cerrar caja
                        </button>
                    </div>

                    <button
                        onClick={conAviso(sacarCuentaDelDia)}
                        disabled={savingPdf}
                        className={cn(
                            "inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-extrabold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] sm:w-auto cursor-pointer",
                            savingPdf && "opacity-60 cursor-not-allowed",
                        )}
                    >
                        <ReceiptText className="size-4" aria-hidden />
                        Sacar cuenta del día
                    </button>
                </div>
            </div>

            {/* Histórico de arqueos. Es donde se investiga un descuadre pasado: sin esto, "faltaban
                50 €" es un recuerdo, no un dato. */}
            <div className="mt-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-fg sm:text-lg">Cierres de caja</h3>
                    <span className="text-xs text-fg-muted">
                        Los últimos {cierres.length || 0}
                    </span>
                </div>

                {cierresError ? (
                    <p className="mt-3 text-sm text-danger">{cierresError}</p>
                ) : cierres.length === 0 ? (
                    <p className="mt-3 text-sm text-fg-muted">
                        Todavía no se ha cerrado la caja ninguna vez.
                    </p>
                ) : (
                    <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[640px] text-sm">
                            <thead>
                                <tr className="text-left text-xs font-semibold text-fg-muted">
                                    <th className="py-2">Cuándo</th>
                                    <th className="py-2">Quién</th>
                                    <th className="py-2 text-right">Esperado</th>
                                    <th className="py-2 text-right">Contado</th>
                                    <th className="py-2 text-right">Diferencia</th>
                                    <th className="py-2 text-right">Retirado</th>
                                    <th className="py-2">Motivo</th>
                                    <th className="py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {cierres.map((c) => {
                                    // CAJA-01: la foto de esa noche no cambia nunca; si se corrigió un apunte
                                    // de su periodo, lo que marca hoy va debajo.
                                    const esperadoHoy = c.rect_esperado ?? null;
                                    const descuadreHoy = c.rect_descuadre ?? null;
                                    const descuadreVigente = descuadreHoy ?? c.descuadre;
                                    return (
                                    <tr key={c.id_cierre} className="border-t border-border">
                                        <td className="py-2 text-fg">
                                            {c.fecha_hora}
                                            {c.reabierto_en ? (
                                                <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-muted">
                                                    deshecho
                                                </span>
                                            ) : null}
                                            {esperadoHoy !== null ? (
                                                <span
                                                    className="ml-2 rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[11px] text-warning"
                                                    title="Se corrigió un apunte de este cierre después de cerrarlo. Imprímelo para ver qué cambió, quién y por qué."
                                                >
                                                    rectificado
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="py-2 text-fg-muted">{c.usuario_nombre ?? "—"}</td>
                                        <td className="py-2 text-right text-fg-muted">
                                            {eur(c.esperado)}
                                            {esperadoHoy !== null ? (
                                                <span className="block text-[11px]">hoy {eur(esperadoHoy)}</span>
                                            ) : null}
                                        </td>
                                        <td className="py-2 text-right text-fg">{eur(c.contado)}</td>
                                        <td
                                            className={cn(
                                                "py-2 text-right font-semibold",
                                                descuadreVigente === 0 ? "text-success" : "text-danger",
                                            )}
                                        >
                                            {c.descuadre === 0 ? "—" : eur(c.descuadre)}
                                            {descuadreHoy !== null ? (
                                                <span className="block text-[11px] font-normal">
                                                    hoy {descuadreHoy === 0 ? "cuadra" : eur(descuadreHoy)}
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="py-2 text-right text-fg-muted">{eur(c.retirado)}</td>
                                        <td className="py-2 text-fg-muted">{c.motivo ?? ""}</td>
                                        <td className="py-2">
                                            <div className="flex items-center justify-end gap-1.5">
                                                <button
                                                    type="button"
                                                    onClick={() => void imprimirCierre(c.id_cierre)}
                                                    title="Imprimir el arqueo"
                                                    className="grid size-8 cursor-pointer place-items-center rounded-lg border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                                                >
                                                    <Printer className="size-4" aria-hidden />
                                                </button>
                                                {c.id_cierre === idUltimoCierre ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => void deshacerCierre(c.id_cierre)}
                                                        title="Deshacer el cierre para volver a contar el cajón"
                                                        className="h-8 cursor-pointer rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-fg transition hover:bg-surface-2"
                                                    >
                                                        Deshacer
                                                    </button>
                                                ) : null}
                                            </div>
                                        </td>
                                    </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <ModalShell
                open={openAddGasto}
                onClose={() => { if (!savingGasto) setOpenAddGasto(false); }}
            >
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => (savingGasto ? null : setOpenAddGasto(false))}
                    />
                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-fg">Agregar gasto</h3>
                                <p className="text-sm text-fg-muted">
                                    Registra luz, agua, pedidos, alquiler, etc.
                                </p>
                            </div>

                            <button
                                type="button"
                                className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                                onClick={() => (savingGasto ? null : setOpenAddGasto(false))}
                                title="Cerrar"
                            >
                                <X className="size-4" aria-hidden />
                            </button>
                        </div>

                        <div className="mt-5 grid grid-cols-1 gap-3">
                            <label className="text-xs font-semibold text-fg-muted">
                                Fecha
                                <input
                                    type="date"
                                    value={gFecha}
                                    onChange={(e) => setGFecha(e.target.value)}
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-fg-muted">
                                Tipo
                                <select
                                    value={gTipo}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setGTipo(v);
                                        if (v !== "Proveedor") setGProveedorId("");
                                    }}
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none"
                                >
                                    <option value="Suministros">Suministros</option>
                                    <option value="Luz">Luz</option>
                                    <option value="Agua">Agua</option>
                                    <option value="Alquiler">Alquiler</option>
                                    <option value="Nomina">Nomina</option>
                                    <option value="Proveedor">Proveedor</option>
                                    <option value="Mantenimiento">Mantenimiento</option>
                                    <option value="Otros">Otros</option>
                                </select>
                            </label>

                            {gTipo === "Proveedor" ? (
                                <label className="text-xs font-semibold text-fg-muted">
                                    Proveedor
                                    <select
                                        value={gProveedorId}
                                        onChange={(e) => setGProveedorId(e.target.value)}
                                        className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                    >
                                        <option value="">
                                            {loadingProveedores ? "Cargando..." : "Selecciona proveedor"}
                                        </option>
                                        {proveedores.map((p) => (
                                            <option key={p.ID_Proveedor} value={p.ID_Proveedor}>
                                                {p.Nombre_Empresa}
                                            </option>
                                        ))}
                                    </select>

                                    {errProveedores ? (
                                        <p className="mt-1 text-[11px] text-danger">{errProveedores}</p>
                                    ) : (
                                        <p className="mt-1 text-[11px] text-fg-muted">
                                            Se vinculará el gasto con el proveedor seleccionado.
                                        </p>
                                    )}
                                </label>
                            ) : null}

                            <label className="text-xs font-semibold text-fg-muted">
                                Concepto
                                <input
                                    value={gConcepto}
                                    onChange={(e) => setGConcepto(e.target.value)}
                                    placeholder="Ej: Pedido cocacolas, Luz enero, Agua..."
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
                                />
                            </label>

                            <label className="text-xs font-semibold text-fg-muted">
                                Importe (EUR)
                                <CampoDinero
                                    {...gImporte.campo}
                                    placeholder="Ej: 120,50"
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
                                />
                            </label>
                            <label className="flex cursor-pointer items-start gap-2 rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
                                <input
                                    type="checkbox"
                                    checked={gPagadoConCaja}
                                    onChange={(e) => setGPagadoConCaja(e.target.checked)}
                                    className="mt-0.5 size-4 accent-accent"
                                />
                                <span>
                                    <span className="font-semibold">Pagado con dinero del cajón</span>
                                    <span className="block text-xs text-fg-muted">
                                        Resta de lo que debería haber en el cierre de caja. Déjalo sin marcar si se pagó por banco o con tarjeta.
                                    </span>
                                </span>
                            </label>

                            {errGasto ? (
                                <div className="rounded-2xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                                    {errGasto}
                                </div>
                            ) : null}
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                disabled={savingGasto}
                                onClick={() => setOpenAddGasto(false)}
                                className={[
                                    "h-10 px-4 rounded-xl border border-border bg-surface text-sm font-semibold text-fg shadow-sm",
                                    "hover:bg-surface-2 active:scale-[0.97]",
                                    savingGasto ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                Cancelar
                            </button>

                            <button
                                type="button"
                                disabled={savingGasto}
                                onClick={conAviso(guardarGasto)}
                                className={[
                                    "h-10 px-5 rounded-xl border border-accent bg-accent text-sm font-bold text-white shadow-sm",
                                    "hover:bg-accent-hover active:scale-[0.97]",
                                    savingGasto ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                {savingGasto ? "Guardando..." : "Guardar gasto"}
                            </button>
                        </div>
                    </div>
            </ModalShell>

            <ModalShell
                open={openEditGasto}
                onClose={() => { if (!savingEditGasto) setOpenEditGasto(false); }}
            >
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => (savingEditGasto ? null : setOpenEditGasto(false))}
                    />
                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-fg">Editar gasto</h3>
                                <p className="text-sm text-fg-muted">
                                    Modifica fecha, tipo, concepto e importe.
                                </p>
                            </div>

                            <button
                                type="button"
                                className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                                onClick={() => (savingEditGasto ? null : setOpenEditGasto(false))}
                                title="Cerrar"
                            >
                                <X className="size-4" aria-hidden />
                            </button>
                        </div>

                        <div className="mt-5 grid grid-cols-1 gap-3">
                            <label className="text-xs font-semibold text-fg-muted">
                                Fecha
                                <input
                                    type="date"
                                    value={egFecha}
                                    onChange={(e) => setEgFecha(e.target.value)}
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-fg-muted">
                                Tipo
                                <select
                                    value={egTipo}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setEgTipo(v);
                                        if (v !== "Proveedor") setEgProveedorId("");
                                    }}
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none"
                                >
                                    <option value="Suministros">Suministros</option>
                                    <option value="Luz">Luz</option>
                                    <option value="Agua">Agua</option>
                                    <option value="Alquiler">Alquiler</option>
                                    <option value="Nomina">Nomina</option>
                                    <option value="Proveedor">Proveedor</option>
                                    <option value="Mantenimiento">Mantenimiento</option>
                                    <option value="Otros">Otros</option>
                                </select>
                            </label>

                            {egTipo === "Proveedor" ? (
                                <label className="text-xs font-semibold text-fg-muted">
                                    Proveedor
                                    <select
                                        value={egProveedorId}
                                        onChange={(e) => setEgProveedorId(e.target.value)}
                                        className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                    >
                                        <option value="">
                                            {loadingProveedores ? "Cargando..." : "Selecciona proveedor"}
                                        </option>
                                        {proveedores.map((p) => (
                                            <option key={p.ID_Proveedor} value={p.ID_Proveedor}>
                                                {p.Nombre_Empresa}
                                            </option>
                                        ))}
                                    </select>

                                    {errProveedores ? (
                                        <p className="mt-1 text-[11px] text-danger">{errProveedores}</p>
                                    ) : null}
                                </label>
                            ) : null}

                            <label className="text-xs font-semibold text-fg-muted">
                                Concepto
                                <input
                                    value={egConcepto}
                                    onChange={(e) => setEgConcepto(e.target.value)}
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-fg-muted">
                                Importe (EUR)
                                <CampoDinero
                                    {...egImporte.campo}
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                />
                            </label>
                            <label className="flex cursor-pointer items-start gap-2 rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg">
                                <input
                                    type="checkbox"
                                    checked={egPagadoConCaja}
                                    onChange={(e) => setEgPagadoConCaja(e.target.checked)}
                                    className="mt-0.5 size-4 accent-accent"
                                />
                                <span>
                                    <span className="font-semibold">Pagado con dinero del cajón</span>
                                    <span className="block text-xs text-fg-muted">
                                        Resta de lo que debería haber en el cierre de caja. Déjalo sin marcar si se pagó por banco o con tarjeta.
                                    </span>
                                </span>
                            </label>

                            {errEditGasto ? (
                                <div className="rounded-2xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                                    {errEditGasto}
                                </div>
                            ) : null}
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                disabled={savingEditGasto}
                                onClick={() => setOpenEditGasto(false)}
                                className={[
                                    "h-10 px-4 rounded-xl border border-border bg-surface text-sm font-semibold text-fg shadow-sm",
                                    "hover:bg-surface-2 active:scale-[0.97]",
                                    savingEditGasto ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                Cancelar
                            </button>

                            <button
                                type="button"
                                disabled={savingEditGasto}
                                onClick={conAviso(guardarEditarGasto)}
                                className={[
                                    "h-10 px-5 rounded-xl border border-accent bg-accent text-sm font-bold text-white shadow-sm",
                                    "hover:bg-accent-hover active:scale-[0.97]",
                                    savingEditGasto ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                {savingEditGasto ? "Guardando..." : "Guardar cambios"}
                            </button>
                        </div>
                    </div>
            </ModalShell>

            <ModalShell
                open={openEditPago}
                onClose={() => { if (!savingEditPago) setOpenEditPago(false); }}
            >
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => (savingEditPago ? null : setOpenEditPago(false))}
                    />
                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-fg">Editar entrada</h3>
                                <p className="text-sm text-fg-muted">
                                    Modifica fecha/hora, método e importe.
                                </p>
                            </div>

                            <button
                                type="button"
                                className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                                onClick={() => (savingEditPago ? null : setOpenEditPago(false))}
                                title="Cerrar"
                            >
                                <X className="size-4" aria-hidden />
                            </button>
                        </div>

                        <div className="mt-5 grid grid-cols-1 gap-3">
                            <label className="text-xs font-semibold text-fg-muted">
                                Fecha/Hora (YYYY-MM-DD HH:mm)
                                <input
                                    value={epFechaHora}
                                    onChange={(e) => setEpFechaHora(e.target.value)}
                                    placeholder="2026-01-29 12:30"
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-fg-muted">
                                Método
                                <select
                                    value={epMetodo}
                                    onChange={(e) =>
                                        setEpMetodo(e.target.value === "Tarjeta" ? "Tarjeta" : "Efectivo")
                                    }
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none"
                                >
                                    <option value="Efectivo">Efectivo</option>
                                    <option value="Tarjeta">Tarjeta</option>
                                </select>
                            </label>

                            <label className="text-xs font-semibold text-fg-muted">
                                Importe (EUR)
                                <input
                                    value={eur(epImporte)}
                                    readOnly
                                    disabled
                                    className="mt-1 w-full cursor-not-allowed rounded-2xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg-muted outline-none"
                                />
                                <span className="mt-1 block text-[11px] font-normal text-fg-subtle">
                                    Se calcula automáticamente desde las líneas cobradas; no es editable.
                                </span>
                            </label>

                            {errEditPago ? (
                                <div className="rounded-2xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                                    {errEditPago}
                                </div>
                            ) : null}
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                disabled={savingEditPago}
                                onClick={() => setOpenEditPago(false)}
                                className={[
                                    "h-10 px-4 rounded-xl border border-border bg-surface text-sm font-semibold text-fg shadow-sm",
                                    "hover:bg-surface-2 active:scale-[0.97]",
                                    savingEditPago ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                Cancelar
                            </button>

                            <button
                                type="button"
                                disabled={savingEditPago}
                                onClick={conAviso(guardarEditarPago)}
                                className={[
                                    "h-10 px-5 rounded-xl border border-accent bg-accent text-sm font-bold text-white shadow-sm",
                                    "hover:bg-accent-hover active:scale-[0.97]",
                                    savingEditPago ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                {savingEditPago ? "Guardando..." : "Guardar cambios"}
                            </button>
                        </div>
                    </div>
            </ModalShell>

            <CierreCajaModal
                open={openCierre}
                onClose={() => setOpenCierre(false)}
                onCerrado={() => {
                    // Un cierre estrena el histórico y decide a qué cierre pertenece cada apunte a
                    // partir de ahora, así que se recarga todo lo que cuelga de él.
                    void recargarCierres();
                    void entradasQuery.refetch();
                    void salidasQuery.refetch();
                }}
            />

            {confirmAccion ? (
            <ModalShell
                open
                onClose={() => { if (!confirmando) setConfirmAccion(null); }}
                className="fixed inset-0 z-[60] flex items-center justify-center"
            >
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => (confirmando ? null : setConfirmAccion(null))}
                    />

                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-fg">
                                    {confirmAccion.tipo === "gasto"
                                        ? "Borrar gasto"
                                        : "Deshacer este cobro"}
                                </h3>
                                <p className="text-sm text-fg-muted">
                                    {confirmAccion.tipo === "gasto"
                                        ? "Esto eliminará el gasto de la base de datos."
                                        : "El cobro no se borra: queda registrado con tu nombre, la hora y el motivo. Elige abajo qué ha pasado — son dos cosas distintas y la factura que se emite no es la misma."}
                                </p>
                            </div>

                            <button
                                type="button"
                                className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                                onClick={() => (confirmando ? null : setConfirmAccion(null))}
                                title="Cerrar"
                            >
                                <X className="size-4" aria-hidden />
                            </button>
                        </div>

                        <div className="mt-4 rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm text-fg">
                            {confirmAccion.tipo === "gasto" ? (
                                <div className="space-y-1">
                                    <div>
                                        <span className="font-semibold">Fecha:</span>{" "}
                                        {confirmAccion.gasto.fecha_hora || "—"}
                                    </div>
                                    <div className="truncate">
                                        <span className="font-semibold">Concepto:</span>{" "}
                                        {confirmAccion.gasto.concepto || "—"}
                                    </div>
                                    <div>
                                        <span className="font-semibold">Importe:</span>{" "}
                                        {eur(confirmAccion.gasto.importe)}
                                    </div>
                                    {confirmAccion.gasto.tipo_gasto === "Proveedor" &&
                                        confirmAccion.gasto.proveedor_id ? (
                                        <div>
                                            <span className="font-semibold">Proveedor:</span>{" "}
                                            {proveedorLabel(confirmAccion.gasto.proveedor_id)}
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <div>
                                        <span className="font-semibold">Fecha/Hora:</span>{" "}
                                        {confirmAccion.entrada.fecha_hora || "—"}
                                    </div>
                                    <div className="truncate">
                                        <span className="font-semibold">Cliente:</span>{" "}
                                        {confirmAccion.entrada.cliente || "—"}
                                    </div>
                                    <div>
                                        <span className="font-semibold">Método:</span>{" "}
                                        {confirmAccion.entrada.metodo || "—"}
                                    </div>
                                    <div>
                                        <span className="font-semibold">Importe:</span>{" "}
                                        {eur(confirmAccion.entrada.importe)}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* FISCAL-01: los dos instrumentos, con la diferencia explicada en una
                            frase cada uno. No son dos botones parecidos: el de arriba dice que la
                            venta no ocurrió y el de abajo que sí. */}
                        {confirmAccion.tipo === "entrada" ? (
                            <div className="mt-4 grid gap-2">
                                {(
                                    [
                                        {
                                            clase: "DEVOLUCION" as ClaseBaja,
                                            titulo: "Le devuelvo el dinero al cliente",
                                            detalle:
                                                "La venta ocurrió. Se emite una factura rectificativa por el importe en negativo. Los artículos NO vuelven a la comanda y el stock no se repone: el cliente se los llevó.",
                                        },
                                        {
                                            clase: "ERROR" as ClaseBaja,
                                            titulo: "Este cobro nunca debió existir",
                                            detalle:
                                                "Un ticket de prueba, una mesa equivocada, un cobro duplicado. Se anula la factura, los artículos vuelven a la comanda como pendientes y el stock se repone.",
                                        },
                                    ] as const
                                ).map((op) => {
                                    const activa = claseBaja === op.clase;
                                    return (
                                        <button
                                            key={op.clase}
                                            type="button"
                                            disabled={confirmando}
                                            onClick={() => setClaseBaja(op.clase)}
                                            className={[
                                                "w-full rounded-2xl border px-4 py-3 text-left transition",
                                                activa
                                                    ? "border-primary bg-primary/10"
                                                    : "border-border bg-surface hover:bg-surface-2",
                                                confirmando ? "opacity-60 cursor-not-allowed" : "",
                                            ].join(" ")}
                                        >
                                            <div className="text-sm font-semibold text-fg">
                                                {op.titulo}
                                            </div>
                                            <div className="mt-0.5 text-xs text-fg-muted">
                                                {op.detalle}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}

                        {confirmAccion.tipo === "entrada" ? (
                            <label className="mt-4 block">
                                <span className="text-sm font-semibold text-fg">
                                    {claseBaja === "DEVOLUCION"
                                        ? "Motivo de la devolución"
                                        : "Motivo de la anulación"}
                                </span>
                                <input
                                    type="text"
                                    autoFocus
                                    value={motivoAnulacion}
                                    onChange={(ev) => setMotivoAnulacion(ev.target.value)}
                                    placeholder="Cobro duplicado, error de importe…"
                                    disabled={confirmando}
                                    className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-primary"
                                />
                            </label>
                        ) : null}

                        {confirmError ? (
                            <div className="mt-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                                {confirmError}
                            </div>
                        ) : null}

                        <div className="mt-6 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                disabled={confirmando}
                                onClick={() => setConfirmAccion(null)}
                                className={[
                                    "h-10 px-4 rounded-xl border border-border bg-surface text-sm font-semibold text-fg shadow-sm",
                                    "hover:bg-surface-2 active:scale-[0.97]",
                                    confirmando ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                Cancelar
                            </button>

                            {(() => {
                                // Para un cobro hacen falta las dos cosas: haber elegido QUÉ ha
                                // pasado y escribir por qué. Sin la primera no se sabe qué factura
                                // emitir, y es una decisión que no se deshace.
                                const falta =
                                    confirmAccion.tipo === "entrada" &&
                                    (!motivoAnulacion.trim() || claseBaja === null);
                                const bloqueado = confirmando || falta;
                                return (
                                    <button
                                        type="button"
                                        disabled={bloqueado}
                                        onClick={conAviso(confirmarBorrado)}
                                        className={[
                                            "h-10 px-5 rounded-xl border border-danger bg-danger text-sm font-bold text-white shadow-sm",
                                            "hover:opacity-90 active:scale-[0.97]",
                                            bloqueado ? "opacity-60 cursor-not-allowed" : "",
                                        ].join(" ")}
                                    >
                                        {confirmAccion.tipo === "gasto"
                                            ? confirmando
                                                ? "Borrando..."
                                                : "Sí, borrar"
                                            : claseBaja === "DEVOLUCION"
                                              ? confirmando
                                                  ? "Devolviendo..."
                                                  : "Sí, devolver"
                                              : confirmando
                                                ? "Anulando..."
                                                : "Sí, anular"}
                                    </button>
                                );
                            })()}
                        </div>
                    </div>
            </ModalShell>
            ) : null}

            {aviso ? (
                <ImpactoCierreModal
                    impacto={aviso.impacto}
                    motivoYaDado={aviso.motivoYaDado}
                    guardando={avisoGuardando}
                    error={avisoError}
                    onCancelar={() => {
                        if (!avisoGuardando) setAviso(null);
                    }}
                    onConfirmar={(motivo) => void confirmarAviso(motivo)}
                />
            ) : null}

            {/* FISCAL-02: el cliente vuelve con el ticket y pide factura. Se emite una F3 EN
                SUSTITUCIÓN y se reimprime; la simplificada original no se toca. */}
            <DatosFiscalesModal
                open={f3Pago !== null}
                onClose={() => {
                    setF3Pago(null);
                    setF3Error(null);
                }}
                onConfirmar={(d) => {
                    const e = f3Pago;
                    if (e) return emitirFacturaSustitutiva(e, d);
                }}
                importe={f3Pago?.importe ?? CERO}
                limite={limiteSimplif}
                obligatorio={false}
                guardando={f3Guardando}
                error={f3Error}
            />

            {/* Reimpresión de un cobro ya hecho: mismo número que el original, marcado COPIA. */}
            <PrintTicketModal
                open={reimpresion !== null}
                onClose={() => setReimpresion(null)}
                titulo="Reimprimir ticket"
                items={reimpresion?.items ?? []}
                datos={reimpresion?.datos}
            />
        </div>
    );
}
