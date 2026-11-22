import { commands } from "@tpv/client";
import {
Calculator,
Eye,
FileDown,
FileText,
Pencil,
Printer,
ReceiptText,
Trash2,
Undo2,
Wallet,
X,
} from "lucide-react";
import React,{ useEffect,useMemo,useState } from "react";
import FormularioGasto from "../../features/cuentas/FormularioGasto";
import { proveedorDelGasto } from "../../features/cuentas/proveedorDelGasto";

import { toAppError } from "@tpv/client";
import type {
CambioCajaInput,
DestinatarioInput,
Dinero,
ImpactoCajaDto,
ProveedorMiniDto
} from "@tpv/contracts";
import { printerTicketDePago } from "../../features/configuracion/api/printerApis";
import CierreCajaModal from "../../features/cuentas/CierreCajaModal";
import CasillaTicket from "../../features/cuentas/CasillaTicket";
import DevolverModal from "../../features/cuentas/DevolverModal";
import ImpactoCierreModal from "../../features/cuentas/ImpactoCierreModal";
import ReabrirCierreModal from "../../features/cuentas/ReabrirCierreModal";
import { useQueryClient } from "@tanstack/react-query";
import { cierreImprimir,cierreReabrir,type CierreResumenDto } from "../../features/cuentas/cierreApis";
import {
avisoDeLineasDevueltas,
subtituloCuentas,
cuentasGetEntradas,
cuentasGetSalidas,
esAnulado,
esDevolucion,
type ClaseBaja,
type EntradaDto,
type SalidaDto,
} from "../../features/cuentas/cuentasApis";
import {
cuentasKeys,
useAnularPago,
useCierresCaja,
useCuentasEntradas,
useFacturasCanjeables,
useCuentasProveedoresMini,
useCuentasResumen,
useCuentasSalidas,
useDeleteGasto,
usePilaDeCursores,
useUpdatePago,
} from "../../features/cuentas/cuentasQueries";
import { cn } from "../../shared/lib/cn";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import DatosFiscalesModal from "../../shared/ticket/DatosFiscalesModal";
import PrintTicketModal,{
type CobroImprimible,
} from "../../shared/ticket/PrintTicketModal";
import { ModalShell,SearchInput } from "../../shared/ui";
import { useToast } from "../../shared/toast";


// PDF
import { generarPdfCuentas } from "../../features/cuentas/generarPdfCuentas";

// Tauri: guardar en ruta elegida por el usuario
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { conAviso } from "../../shared/lib/conAviso";
import { CERO,eur,restar,sumar } from "../../shared/lib/dinero";
import { esAdmin } from "../../shared/lib/permisos";
import { usePermisos } from "../../shared/lib/usePermisos";
import { useMode } from "../../shared/stores/useMode";

function todayYMD() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
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
    disabled = false,
    children,
    onClick,
    variant = "neutral",
}: {
    title?: string;
    disabled?: boolean;
    children: React.ReactNode;
    onClick?: () => void;
    variant?: "neutral" | "danger";
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
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

/**
 * Lo devuelto de un cobro, y el porqué de una devolución. Como el sello de un anulado, a la vista:
 * es lo que se busca cuando falta dinero.
 */
function SelloDevolucion({ entrada }: { entrada: EntradaDto }) {
    if (esAnulado(entrada)) return null;
    if (esDevolucion(entrada)) {
        const motivo = (entrada.motivo_devolucion ?? "").trim();
        return (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="rounded-lg border border-warning/30 bg-warning-soft px-2 py-0.5 font-bold uppercase tracking-wide text-warning">
                    Devolución
                </span>
                {motivo ? (
                    <span className="min-w-0 truncate text-fg-muted" title={motivo}>
                        «{motivo}»
                    </span>
                ) : null}
            </div>
        );
    }
    if ((entrada.devuelto ?? CERO) > 0) {
        return <div className="mt-1 text-xs text-warning">Devuelto {eur((entrada.devuelto ?? CERO))}</div>;
    }
    return null;
}

export default function Cuentas() {
    // El camarero entra a los cobros y sus bajas; el resto de la caja (gastos, totales, cierre,
    // facturas con NIF, exportar) es del administrador y ni se pide ni se enseña.
    const { puede, rol } = usePermisos();
    const toast = useToast();
    const admin = puede("cuentas.gastos");
    const cobrosPermitidos = puede("cuentas.cobros");
    const exportarPermitido = admin && cobrosPermitidos;
    const cierresPermitidos = puede("caja.cerrar");
    // En la Handy, Cuentas es de consulta: cobrar, devolver, los gastos y los cierres se hacen en el
    // TPV principal, que tiene el cajón y la impresora. Lo rechazarían su adaptador y el worker
    // (`caja_solo_en_main`), así que ni se ofrece.
    const esHandy = useMode((st) => st.mode) === "handy";
    const escribeCaja = !esHandy;
    const fiscal = esAdmin(rol) && escribeCaja;
    const puedeCerrarCaja = cierresPermitidos && escribeCaja;

    const [busqueda, setBusqueda] = useState("");
    const [del, setDel] = useState(() => todayYMD());
    const [al, setAl] = useState(() => todayYMD());

    const rangoInvalido = !!del && !!al && del > al;

    // Paginación por clave (CUENTA-05, RI-18), una por panel.
    const paginasEntradas = usePilaDeCursores();
    const paginasSalidas = usePilaDeCursores();
    const { reiniciar: reiniciarEntradas } = paginasEntradas;
    const { reiniciar: reiniciarSalidas } = paginasSalidas;

    // Búsqueda server-side con debounce: el texto viaja al backend (no filtra en cliente).
    const [qDebounced, setQDebounced] = useState("");
    useEffect(() => {
        const t = setTimeout(() => setQDebounced(busqueda.trim()), 300);
        return () => clearTimeout(t);
    }, [busqueda]);

    // Al cambiar rango o búsqueda, volver a la primera página.
    useEffect(() => {
        reiniciarEntradas();
        reiniciarSalidas();
    }, [del, al, qDebounced, reiniciarEntradas, reiniciarSalidas]);

    // Lecturas cacheadas (TanStack Query). Rango + búsqueda + página forman la queryKey.
    const entradasQuery = useCuentasEntradas(
        { del, al, q: qDebounced, cursor: paginasEntradas.cursor },
        !rangoInvalido && cobrosPermitidos,
    );
    const salidasQuery = useCuentasSalidas(
        { del, al, q: qDebounced, cursor: paginasSalidas.cursor },
        !rangoInvalido && admin,
    );
    // Totales de cabecera sobre TODO el rango (no solo la página visible).
    const resumenQuery = useCuentasResumen({ del, al, q: qDebounced }, !rangoInvalido && admin);
    const proveedoresQuery = useCuentasProveedoresMini();

    // Escrituras (mutaciones con invalidación en onSuccess).
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

    const entradasDB = useMemo(() => cobrosPermitidos ? entradasQuery.data?.filas ?? [] : [], [entradasQuery.data, cobrosPermitidos]);
    // Relee (otra página, otro rango, un cambio de otro equipo): los botones de página esperan y el
    // pie lo dice, pero la lista se queda con lo de antes hasta que llega lo nuevo. El hueco con
    // «Cargando…» sólo sale la primera vez, cuando no hay nada que enseñar: sustituir la lista en
    // cada relectura la hacía parpadear.
    const loadingEntradas = entradasQuery.isFetching;
    const primeraCargaEntradas = entradasQuery.isLoading;

    const salidasDB = useMemo(() => admin ? salidasQuery.data?.filas ?? [] : [], [salidasQuery.data, admin]);
    const loadingSalidas = salidasQuery.isFetching;
    const primeraCargaSalidas = salidasQuery.isLoading;

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

    const [formularioGasto, setFormularioGasto] = useState<{ gasto: SalidaDto | null } | null>(null);

    const [savingPdf, setSavingPdf] = useState(false);
    const [pdfError, setPdfError] = useState<string | null>(null);

    const [openEditPago, setOpenEditPago] = useState(false);
    // Ticket que se está reimprimiendo (null = ninguno). Ver `reimprimirTicket`.
    const [reimpresion, setReimpresion] = useState<CobroImprimible | null>(null);
    const [editPagoId, setEditPagoId] = useState<string | null>(null);
    const [epFechaHora, setEpFechaHora] = useState("");
    const [epMetodo, setEpMetodo] = useState<"Tarjeta" | "Efectivo">("Efectivo");
    // El importe de un cobro no se edita (CUENTA-02): sólo se enseña.
    const [epImporte, setEpImporte] = useState<Dinero>(CERO);
    const [savingEditPago, setSavingEditPago] = useState(false);
    const [errEditPago, setErrEditPago] = useState<string | null>(null);

    const [openCierre, setOpenCierre] = useState(false);
    // El histórico de cierres es del administrador: el camarero ni lo pide. Va por React Query con
    // la clave de Cuentas, así que un cierre hecho en otro equipo lo refresca solo.
    const qc = useQueryClient();
    const cierresQuery = useCierresCaja(cierresPermitidos);
    const cierres: CierreResumenDto[] = useMemo(
        () => (cierresPermitidos ? (cierresQuery.data ?? []) : []),
        [cierresPermitidos, cierresQuery.data],
    );
    const cierresError = cierresPermitidos && cierresQuery.error ? toAppError(cierresQuery.error).message : null;

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

    // Lo que cambia en esta pantalla y toca un cierre (un gasto, un cobro, deshacer un cierre) lo
    // vuelve a pedir; si no se puede ver, no hay nada que pedir.
    const recargarCierres = React.useCallback(
        () => qc.invalidateQueries({ queryKey: cuentasKeys.cierres() }),
        [qc],
    );

    // INC-20261031-024: un fallo al imprimir (sin impresora, sin papel) se avisa con `conAviso` en
    // el botón. Antes se guardaba en `cierresError`, que es el de CARGAR el historial, y la tabla
    // entera se sustituía por el mensaje hasta volver a entrar en Cuentas.
    const imprimirCierre = async (idCierre: string) => {
        await cierreImprimir(await commands.cierreDetalle(idCierre));
    };

    // Deshacer un cierre es para volver a contar el cajón, y por eso sólo se ofrece en el último
    // (CAJA-01): el de hace tres días ya no se puede contar otra vez. Corregir un apunte de un cierre
    // ya hecho no necesita deshacer nada: se rectifica solo. Queda registrado quién y cuándo.
    const idUltimoCierre = cierres.find((c) => !c.reabierto_en)?.id_cierre ?? null;
    const [cierreAReabrir, setCierreAReabrir] = useState<string | null>(null);
    const deshacerCierre = async (idCierre: string) => {
        await cierreReabrir(idCierre);
        setCierreAReabrir(null);
        await recargarCierres();
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
        const impacto = await commands.cuentasPrevisualizarCambio(cambio);
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

    // Una lista que no se ha podido cargar no puede parecer una lista vacía: en caja, «no hay
    // cobros» y «no se han podido leer» piden cosas distintas. Se avisa al empezar a fallar, no
    // en cada reintento.
    useEffect(() => {
        if (entradasQuery.isError) {
            toast.error("No se pudieron cargar los ingresos", toAppError(entradasQuery.error).message);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entradasQuery.isError]);

    useEffect(() => {
        if (salidasQuery.isError) {
            toast.error("No se pudieron cargar las salidas", toAppError(salidasQuery.error).message);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [salidasQuery.isError]);

    // La búsqueda y la paginación se hacen en el servidor (CUENTA-05): la lista ya llega filtrada
    // y paginada, así que se muestra tal cual (sin filtrar de nuevo en cliente).
    const entradasFiltradas = entradasDB;
    const salidasFiltradas = salidasDB;

    // Totales de cabecera: del resumen agregado (todo el rango + búsqueda), no de la página visible.
    const resumen = admin ? resumenQuery.data : undefined;
    const totalEntradas = resumen?.total_entradas ?? CERO;
    const totalSalidas = resumen?.total_salidas ?? CERO;
    const balance = restar(totalEntradas, totalSalidas);

    // Hay "siguiente" si el backend devolvió dónde empieza (RI-18). Lo sabe él, que pide una fila
    // de más: antes se deducía de los contadores del resumen, que son otra consulta y cuentan otra
    // cosa (los anulados salen en la lista pero no son ventas).
    const siguienteEntradas = entradasQuery.data?.siguiente ?? null;
    const siguienteSalidas = salidasQuery.data?.siguiente ?? null;
    const hasNextEntradas = siguienteEntradas != null;
    const hasNextSalidas = siguienteSalidas != null;

    const abrirModalGasto = async () => { await ensureProveedores(); setFormularioGasto({ gasto: null }); };
    const abrirEditarGasto = async (gasto: SalidaDto) => { await ensureProveedores(); setFormularioGasto({ gasto }); };

    const borrarGasto = (gasto: SalidaDto) => {
        setConfirmError(null);
        setConfirmAccion({ tipo: "gasto", gasto });
    };

    const [devolverDe, setDevolverDe] = useState<{ entrada: EntradaDto; todo: boolean } | null>(null);

    const reimprimirTicket = (e: EntradaDto) => {
        setReimpresion({ idPago: e.id, esCopia: true });
    };

    /**
     * Tras una devolución, abre el modal de impresión con su factura rectificativa elegida. No la
     * imprime: el cliente casi nunca la pide, pero es una factura y tiene que poder entregarse
     * (art. 17 del RD 1619/2012). La devolución ya está hecha: si esto falla, sólo se avisa.
     */
    const ofrecerRectificativa = async (idPago: string) => {
        try {
            const t = await printerTicketDePago(idPago);
            const rectificativa = (t.facturas_del_cobro ?? []).find((f) => f.tipo_factura.startsWith("R"));
            if (rectificativa) setReimpresion({ idPago, numFactura: rectificativa.num_serie });
        } catch (err) {
            toast.error("No se pudo preparar la rectificativa para imprimir", toAppError(err).message);
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

       Lo que sí se esconde es en los **anulados**: un cobro que no existe no se puede facturar.

       Si el cobro YA tiene factura completa (una F3, o la F1 de cuando se cobró), el mismo botón la
       corrige: el formulario sale con los datos actuales y se emite la factura que la corrige. */
    const limite_simplif = useBusinessSettings((st) => st.limite_simplif);
    const [facturaDe, setFacturaDe] = useState<{
        /** Los cobros cuyos tickets se facturan (uno, o varios del mismo cliente). */
        entradas: EntradaDto[];
        /** El número de la factura completa vigente que se corrige; `null` = se emite una F3. */
        corregir: string | null;
        inicial: Partial<DestinatarioInput> | null;
    } | null>(null);
    // FISCAL-02: varios tickets del mismo cliente en una sola factura (FAQ de la AEAT, apartado
    // 27). `null` = no se está eligiendo. Se guardan las entradas y no sólo sus ids: la lista va
    // por páginas, y lo elegido en una no puede perderse al pasar a otra.
    const [seleccionTickets, setSeleccionTickets] = useState<Map<string, EntradaDto> | null>(null);
    // DOC-INC-01: al elegir, qué tickets de la página se pueden facturar. Se pide al entrar en el
    // modo y con cada página.
    const idsFacturables = useMemo(
        () => entradasDB.filter((e) => !esAnulado(e) && !esDevolucion(e)).map((e) => e.id),
        [entradasDB],
    );
    const canjeablesQuery = useFacturasCanjeables(idsFacturables, seleccionTickets !== null);
    // Uno marcado antes de saber que no se puede facturar se quita: la emisión lo rechazaría.
    useEffect(() => {
        const motivos = canjeablesQuery.data;
        if (!motivos) return;
        setSeleccionTickets((prev) => {
            if (!prev || ![...prev.keys()].some((id) => motivos.get(id))) return prev;
            return new Map([...prev].filter(([id]) => !motivos.get(id)));
        });
    }, [canjeablesQuery.data]);
    useEffect(() => {
        if (canjeablesQuery.isError) {
            toast.error(
                "No se pudo comprobar qué tickets se pueden facturar",
                toAppError(canjeablesQuery.error).message,
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canjeablesQuery.isError]);
    const alternarTicket = (e: EntradaDto) =>
        setSeleccionTickets((prev) => {
            if (!prev) return prev;
            const next = new Map(prev);
            if (next.has(e.id)) next.delete(e.id);
            else next.set(e.id, e);
            return next;
        });
    const [f3Guardando, setF3Guardando] = useState(false);
    const [f3Error, setF3Error] = useState<string | null>(null);

    /** Abre el formulario de factura de un cobro: para emitirla o, si ya la tiene, corregirla. */
    const abrirFactura = async (e: EntradaDto) => {
        setF3Error(null);
        try {
            const t = await printerTicketDePago(e.id);
            // La factura completa vigente: la última con cliente y en positivo (una F3 corregida
            // deja detrás la errónea y su negativa; una F1 corregida, su rectificativa).
            const vigente = [...(t.facturas_del_cobro ?? [])]
                .reverse()
                .find((f) => ["F1", "F3", "R1", "R2", "R3", "R4"].includes(f.tipo_factura) && f.importe > 0);
            if (!vigente) {
                setFacturaDe({ entradas: [e], corregir: null, inicial: null });
                return;
            }
            const actual = await printerTicketDePago(e.id, false, vigente.num_serie);
            setFacturaDe({
                entradas: [e],
                corregir: vigente.num_serie,
                inicial: actual.destinatario ?? null,
            });
        } catch (err) {
            setFacturaDe({ entradas: [e], corregir: null, inicial: null });
            setF3Error(toAppError(err).message);
        }
    };

    /** Emite o corrige la factura. Devuelve si ha entrado: el formulario guarda entonces los datos
     *  en la ficha del cliente (FISCAL-02). */
    const confirmarFactura = async (d: DestinatarioInput): Promise<boolean> => {
        if (!facturaDe) return false;
        setF3Guardando(true);
        setF3Error(null);
        try {
            const bloque = facturaDe.corregir
                ? await commands.verifactuCorregirFactura(facturaDe.corregir, d)
                : await commands.verifactuEmitirFacturaDeTickets(facturaDe.entradas.map((x) => x.id), d);
            const primera = facturaDe.entradas[0];
            setFacturaDe(null);
            setSeleccionTickets(null);
            // Y se abre LA FACTURA NUEVA para imprimir, que es a lo que ha venido el cliente: no una
            // copia del ticket que canjea ni la factura errónea (RI-29).
            if (primera) setReimpresion({ idPago: primera.id, numFactura: bloque.num_serie_factura });
            return true;
        } catch (err) {
            setF3Error(toAppError(err).message);
            return false;
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
        } catch (e) {
            setErrEditPago(toAppError(e).message);
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
                        const hecho = await anularPago.mutateAsync({ id_pago: idPago, motivo, clase });
                        setConfirmAccion(null);
                        // CAJ-INC-02: adónde han ido sus consumiciones, que puede no ser su mesa
                        // de antes si se volvió a abrir.
                        const aviso = avisoDeLineasDevueltas(hecho);
                        if (aviso) toast.info("Cobro dado de baja", aviso);
                        void recargarCierres();
                        if (clase === "DEVOLUCION") void ofrecerRectificativa(idPago);
                    },
                    // Anular pide el motivo siempre, y ése es también el de la rectificación.
                    true,
                );
            }
        } catch (e) {
            setConfirmError(toAppError(e).message);
        } finally {
            setConfirmando(false);
        }
    };

    const exportarPdf = async (tipo: "rango" | "dia") => {
        try {
            setPdfError(null);
            setSavingPdf(true);
            const inicio = tipo === "dia" ? todayYMD() : del;
            const fin = tipo === "dia" ? inicio : al;
            const filePath = await save({
                title: tipo === "dia" ? "Sacar cuenta del día (PDF)" : "Guardar PDF de Cuentas",
                defaultPath: tipo === "dia" ? `cuenta_dia_${inicio}.pdf` : `cuentas_${inicio || "inicio"}_${fin || "fin"}.pdf`,
                filters: [{ name: "PDF", extensions: ["pdf"] }],
            });
            if (!filePath) return;
            // Todo el rango, independiente de la página visible y de su cursor.
            const filtro = { del: inicio, al: fin, ...(tipo === "rango" ? { q: qDebounced } : {}) };
            const [entradas, salidas] = await Promise.all([cuentasGetEntradas(filtro), cuentasGetSalidas(filtro)]);
            const bytes = await generarPdfCuentas({ del: inicio, al: fin, tipo,
                entradas: entradas.filas, salidas: salidas.filas, proveedores: proveedoresMap });
            await writeFile(filePath, bytes);
        } catch (e) {
            setPdfError(toAppError(e).message);
        } finally {
            setSavingPdf(false);
        }
    };
    const guardarPdf = () => exportarPdf("rango");
    const sacarCuentaDelDia = () => exportarPdf("dia");

    const proveedorLabel = (id: string | null | undefined) => {
        if (!id) return "";
        return proveedoresMap.get(id) ?? `Proveedor #${id}`;
    };

    // Las acciones de un cobro, iguales en la fila de móvil y en la de escritorio. El camarero
    // reimprime, devuelve y da de baja; facturar con NIF y editar son del administrador. Una
    // devolución sólo se reimprime: lo que la deshace es la baja por error de su cobro.
    const accionesDeCobro = (e: EntradaDto) => (
        <>
            <MiniIconButton title="Reimprimir ticket" onClick={() => reimprimirTicket(e)}>
                <Printer className="size-4" aria-hidden />
            </MiniIconButton>
            {esAnulado(e) || esDevolucion(e) || !escribeCaja ? null : seleccionTickets ? (
                <CasillaTicket
                    marcada={seleccionTickets.has(e.id)}
                    motivo={canjeablesQuery.data?.get(e.id)}
                    onClick={() => alternarTicket(e)}
                />
            ) : (
                <>
                    {fiscal ? (
                        <MiniIconButton
                            title="Factura con NIF (emitir o corregir)"
                            onClick={() => void abrirFactura(e)}
                        >
                            <FileText className="size-4" aria-hidden />
                        </MiniIconButton>
                    ) : null}
                    {admin ? (
                        <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                            <Pencil className="size-4" aria-hidden />
                        </MiniIconButton>
                    ) : null}
                    <MiniIconButton
                        title="Devolver (todo o una parte)"
                        onClick={() => setDevolverDe({ entrada: e, todo: false })}
                    >
                        <Undo2 className="size-4" aria-hidden />
                    </MiniIconButton>
                    <MiniIconButton title="Anular" variant="danger" onClick={() => borrarPago(e)}>
                        <Trash2 className="size-4" aria-hidden />
                    </MiniIconButton>
                </>
            )}
        </>
    );

    // Un editor abierto se cierra si se retira el permiso que lo abrió (los permisos se releen al
    // volver a la ventana): lo que guardase se rechazaría.
    useEffect(() => {
        if (admin) return;
        setFormularioGasto(null);
        setOpenEditPago(false);
        setConfirmAccion((c) => (c?.tipo === "gasto" ? null : c));
    }, [admin]);
    useEffect(() => {
        if (cobrosPermitidos) return;
        setDevolverDe(null);
        setConfirmAccion((c) => (c?.tipo === "entrada" ? null : c));
    }, [cobrosPermitidos]);
    useEffect(() => {
        if (fiscal) return;
        setFacturaDe(null);
        setSeleccionTickets(null);
    }, [fiscal]);
    useEffect(() => {
        if (puedeCerrarCaja) return;
        setOpenCierre(false);
        setCierreAReabrir(null);
    }, [puedeCerrarCaja]);

    // Las acciones de un gasto, iguales en la fila de móvil y en la de escritorio. En la Handy sólo
    // se mira.
    const accionesDeGasto = (s: SalidaDto) =>
        escribeCaja ? (
            <>
                <MiniIconButton title="Editar" onClick={conAviso(() => abrirEditarGasto(s))}>
                    <Pencil className="size-4" aria-hidden />
                </MiniIconButton>
                <MiniIconButton title="Borrar" variant="danger" onClick={() => borrarGasto(s)}>
                    <Trash2 className="size-4" aria-hidden />
                </MiniIconButton>
            </>
        ) : (
            <MiniIconButton title="Ver" onClick={conAviso(() => abrirEditarGasto(s))}>
                <Eye className="size-4" aria-hidden />
            </MiniIconButton>
        );

    // Lo que comparten la fila del histórico de cierres y su ficha en pantalla estrecha. CAJA-01: la
    // foto de esa noche no cambia nunca; si se corrigió un apunte de su periodo, lo que marca hoy va
    // debajo.
    const vistaDeCierre = (c: CierreResumenDto) => {
        const esperadoHoy = c.rect_esperado ?? null;
        const descuadreHoy = c.rect_descuadre ?? null;
        const descuadreVigente = descuadreHoy ?? c.descuadre;
        return {
            esperado: (
                <>
                    {eur(c.esperado)}
                    {esperadoHoy !== null ? <span className="block text-[11px]">hoy {eur(esperadoHoy)}</span> : null}
                </>
            ),
            diferencia: (
                <>
                    {c.descuadre === 0 ? "—" : eur(c.descuadre)}
                    {descuadreHoy !== null ? (
                        <span className="block text-[11px] font-normal">
                            hoy {descuadreHoy === 0 ? "cuadra" : eur(descuadreHoy)}
                        </span>
                    ) : null}
                </>
            ),
            claseDiferencia: descuadreVigente === 0 ? "text-success" : "text-danger",
        };
    };
    const sellosDeCierre = (c: CierreResumenDto) => (
        <>
            {c.reabierto_en ? (
                <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] font-normal text-fg-muted">
                    deshecho
                </span>
            ) : null}
            {c.rect_esperado != null ? (
                <span
                    className="ml-2 rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[11px] font-normal text-warning"
                    title="Se corrigió un apunte de este cierre después de cerrarlo. Imprímelo para ver qué cambió, quién y por qué."
                >
                    rectificado
                </span>
            ) : null}
        </>
    );
    const accionesDeCierre = (c: CierreResumenDto) => (
        <>
            <button
                type="button"
                onClick={conAviso(() => imprimirCierre(c.id_cierre), "No se ha podido imprimir el arqueo")}
                title="Imprimir el arqueo"
                className="grid size-8 cursor-pointer place-items-center rounded-lg border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
            >
                <Printer className="size-4" aria-hidden />
            </button>
            {puedeCerrarCaja && c.id_cierre === idUltimoCierre ? (
                <button
                    type="button"
                    onClick={() => setCierreAReabrir(c.id_cierre)}
                    title="Deshacer el cierre para volver a contar el cajón"
                    className="h-8 cursor-pointer rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-fg transition hover:bg-surface-2"
                >
                    Deshacer
                </button>
            ) : null}
        </>
    );

    // INC-20261031-023: la página se desplaza si no cabe, y las listas no bajan de un alto mínimo.
    // Antes era de alto fijo y sin desplazamiento: las listas se quedaban con lo que sobraba tras la
    // cabecera, el pie y el historial de cierres, y a 1280×800 no sobraba nada.
    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-y-auto bg-bg p-3 sm:p-4 lg:px-10 lg:py-5">
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
                                {subtituloCuentas({ cobros: cobrosPermitidos, gastos: admin, soloConsulta: esHandy })}
                            </p>
                        </div>
                    </div>

                    {admin ? (
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
                    ) : null}
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
                {esHandy ? (
                    <div className="rounded-2xl border border-border bg-surface-2 px-4 py-2 text-sm text-fg-muted">
                        Cobros, devoluciones, gastos y cierres se hacen en el TPV principal.
                    </div>
                ) : null}
            </div>

            {/* PANELES */}
            <div
                className={cn(
                    "grid min-h-128 flex-1 grid-cols-1 gap-4 overflow-hidden lg:min-h-80",
                    admin && cobrosPermitidos
                        ? "grid-rows-[repeat(2,minmax(0,1fr))] lg:grid-cols-2 lg:grid-rows-1"
                        : "grid-rows-[minmax(0,1fr)]",
                )}
            >
                        {cobrosPermitidos ? <section className="flex h-full min-h-0 overflow-hidden flex-col rounded-3xl border border-border bg-surface p-4 shadow-sm sm:p-5">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">Entradas</h2>
                                    <p className="text-sm text-fg-muted">
                                        Pagos de clientes (tarjeta o efectivo).
                                    </p>
                                </div>
                                {admin || fiscal ? (
                                <div className="flex items-center gap-2">
                                    {fiscal ? (
                                    <button
                                        type="button"
                                        onClick={() => setSeleccionTickets((s) => (s ? null : new Map()))}
                                        className="rounded-xl border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-2"
                                        title="Elegir varios tickets del mismo cliente y emitir una sola factura con NIF"
                                    >
                                        {seleccionTickets ? "Cancelar" : "Factura de varios tickets"}
                                    </button>
                                    ) : null}
                                    {admin ? <Badge>Total: {eur(totalEntradas)}</Badge> : null}
                                </div>
                                ) : null}
                            </div>

                            {seleccionTickets ? (
                                <div className="mt-3 flex flex-none items-center justify-between gap-3 rounded-2xl border border-accent bg-accent/10 px-4 py-2 text-sm">
                                    <span className="text-fg">
                                        {seleccionTickets.size} ticket{seleccionTickets.size === 1 ? "" : "s"} ·{" "}
                                        <strong>
                                            {eur(
                                                sumar(...[...seleccionTickets.values()].map((x) => x.importe)),
                                            )}
                                        </strong>
                                    </span>
                                    <button
                                        type="button"
                                        disabled={seleccionTickets.size === 0}
                                        onClick={() => {
                                            setF3Error(null);
                                            setFacturaDe({
                                                entradas: [...seleccionTickets.values()],
                                                corregir: null,
                                                inicial: null,
                                            });
                                        }}
                                        className="rounded-xl border border-accent bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                                    >
                                        Emitir factura
                                    </button>
                                </div>
                            ) : null}

                            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border">
                                <div className="hidden sm:grid grid-cols-12 gap-2 bg-surface-2 px-4 py-3 text-xs font-semibold text-fg-muted">
                                    <div className="col-span-3">Fecha/Hora</div>
                                    <div className="col-span-4">Cliente / Método</div>
                                    <div className="col-span-2">EUR</div>
                                    <div className="col-span-3"></div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                                    {primeraCargaEntradas ? (
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
                                                            <SelloDevolucion entrada={e} />
                                                        </div>
                                                        <div className="flex flex-col items-end gap-2">
                                                            <div className={tachadoSi(esAnulado(e), "font-extrabold text-fg")}>
                                                                {eur(e.importe)}
                                                            </div>
                                                            <div className="flex gap-2">
                                                                {accionesDeCobro(e)}
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
                                                            <SelloDevolucion entrada={e} />
                                                        </div>
                                                        <div className={tachadoSi(esAnulado(e), "col-span-2 font-semibold")}>
                                                            {eur(e.importe)}
                                                        </div>
                                                        <div className="col-span-3 flex justify-end gap-2">
                                                            {accionesDeCobro(e)}
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
                                    Página {paginasEntradas.pagina}
                                    {loadingEntradas ? " · cargando…" : ""}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        disabled={paginasEntradas.pagina <= 1 || loadingEntradas}
                                        onClick={paginasEntradas.retroceder}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Anterior
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!hasNextEntradas || loadingEntradas}
                                        onClick={() => {
                                            if (siguienteEntradas) paginasEntradas.avanzar(siguienteEntradas);
                                        }}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Siguiente
                                    </button>
                                </div>
                            </div>
                        </section> : null}

                        {admin ? (
                        <section className="flex h-full min-h-0 overflow-hidden flex-col rounded-3xl border border-border bg-surface p-4 shadow-sm sm:p-5">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">Salidas</h2>
                                    <p className="text-sm text-fg-muted">Gastos del negocio.</p>
                                </div>
                                {escribeCaja ? (
                                <PrimaryButton onClick={conAviso(abrirModalGasto)} className="shrink-0">
                                    Agregar gasto
                                </PrimaryButton>
                                ) : null}
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
                                    {primeraCargaSalidas ? (
                                        <div className="p-4 text-sm text-fg-muted">Cargando salidas…</div>
                                    ) : salidasFiltradas.length ? (
                                        <div className="divide-y divide-border">
                                            {salidasFiltradas.map((s) => {
                                                const provText = proveedorDelGasto(s, proveedorLabel);

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
                                                                    {accionesDeGasto(s)}
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
                                                                {accionesDeGasto(s)}
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
                                    Página {paginasSalidas.pagina}
                                    {loadingSalidas ? " · cargando…" : ""}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        disabled={paginasSalidas.pagina <= 1 || loadingSalidas}
                                        onClick={paginasSalidas.retroceder}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Anterior
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!hasNextSalidas || loadingSalidas}
                                        onClick={() => {
                                            if (siguienteSalidas) paginasSalidas.avanzar(siguienteSalidas);
                                        }}
                                        className="h-8 rounded-lg border border-border bg-surface px-3 font-semibold text-fg transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Siguiente
                                    </button>
                                </div>
                            </div>
                        </section>
                        ) : null}
                    </div>

            {exportarPermitido || puedeCerrarCaja || cierresPermitidos ? (
            <>
            {/* FOOTER: sólo lo que se puede hacer con estos permisos. Un botón desactivado que
                parece activo no dice nada. */}
            <div className="w-full rounded-2xl border border-border bg-surface p-4 shadow-sm">
                <div className="grid grid-cols-1 gap-3 sm:flex sm:items-center sm:justify-between">
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                        {exportarPermitido ? (
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
                        ) : null}

                        {puedeCerrarCaja ? (
                        <button
                            type="button"
                            onClick={() => setOpenCierre(true)}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-4 text-sm font-extrabold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
                        >
                            <Calculator className="size-4" aria-hidden />
                            Cerrar caja
                        </button>
                        ) : null}
                    </div>

                    {exportarPermitido ? (
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
                    ) : null}
                </div>
            </div>

            {/* Histórico de arqueos. Es donde se investiga un descuadre pasado: sin esto, "faltaban
                50 €" es un recuerdo, no un dato. */}
            {cierresPermitidos ? <div className="mt-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
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
                    <>
                    {/* En pantalla ancha, una tabla; en una estrecha, una ficha por cierre: la tabla
                        no cabía y obligaba a desplazarse de lado. */}
                    <div className="mt-3 hidden md:block">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs font-semibold text-fg-muted">
                                    <th className="px-2 py-2">Cuándo</th>
                                    <th className="px-2 py-2">Quién</th>
                                    <th className="px-2 py-2 text-right">Esperado</th>
                                    <th className="px-2 py-2 text-right">Contado</th>
                                    <th className="px-2 py-2 text-right">Diferencia</th>
                                    <th className="px-2 py-2 text-right">Retirado</th>
                                    <th className="px-2 py-2">Motivo</th>
                                    <th className="px-2 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {cierres.map((c) => {
                                    const v = vistaDeCierre(c);
                                    return (
                                    <tr key={c.id_cierre} className="border-t border-border">
                                        <td className="px-2 py-2 text-fg">
                                            {c.fecha_hora}
                                            {sellosDeCierre(c)}
                                        </td>
                                        <td className="px-2 py-2 text-fg-muted">{c.usuario_nombre ?? "—"}</td>
                                        <td className="px-2 py-2 text-right text-fg-muted">{v.esperado}</td>
                                        <td className="px-2 py-2 text-right text-fg">{eur(c.contado)}</td>
                                        <td className={cn("px-2 py-2 text-right font-semibold", v.claseDiferencia)}>
                                            {v.diferencia}
                                        </td>
                                        <td className="px-2 py-2 text-right text-fg-muted">{eur(c.retirado)}</td>
                                        <td className="px-2 py-2 text-fg-muted">{c.motivo ?? ""}</td>
                                        <td className="px-2 py-2">
                                            <div className="flex items-center justify-end gap-1.5">
                                                {accionesDeCierre(c)}
                                            </div>
                                        </td>
                                    </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <ul className="mt-3 grid gap-2 md:hidden">
                        {cierres.map((c) => {
                            const v = vistaDeCierre(c);
                            return (
                                <li key={c.id_cierre} className="rounded-xl border border-border p-3 text-sm">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="font-semibold text-fg">
                                                {c.fecha_hora}
                                                {sellosDeCierre(c)}
                                            </div>
                                            <div className="text-xs text-fg-muted">{c.usuario_nombre ?? "—"}</div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1.5">{accionesDeCierre(c)}</div>
                                    </div>
                                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                                        <dt className="text-xs text-fg-muted">Esperado</dt>
                                        <dd className="text-right text-fg-muted">{v.esperado}</dd>
                                        <dt className="text-xs text-fg-muted">Contado</dt>
                                        <dd className="text-right text-fg">{eur(c.contado)}</dd>
                                        <dt className="text-xs text-fg-muted">Diferencia</dt>
                                        <dd className={cn("text-right font-semibold", v.claseDiferencia)}>{v.diferencia}</dd>
                                        <dt className="text-xs text-fg-muted">Retirado</dt>
                                        <dd className="text-right text-fg-muted">{eur(c.retirado)}</dd>
                                    </dl>
                                    {c.motivo ? <p className="mt-2 text-xs text-fg-muted">{c.motivo}</p> : null}
                                </li>
                            );
                        })}
                    </ul>
                    </>
                )}
            </div> : null}
            </>
            ) : null}

            {formularioGasto && <FormularioGasto
                soloLectura={!escribeCaja}
                key={formularioGasto.gasto?.id ?? "nuevo"} gasto={formularioGasto.gasto} fechaInicial={todayYMD()}
                proveedores={proveedores} errorProveedores={errProveedores} conAvisoDeCierre={conAvisoDeCierre}
                onCerrar={() => setFormularioGasto(null)} onGuardado={() => void recargarCierres()}
            />}

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

            {cierreAReabrir && <ReabrirCierreModal
                onCancelar={() => setCierreAReabrir(null)}
                onConfirmar={() => deshacerCierre(cierreAReabrir)}
            />}
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
                                    {proveedorDelGasto(confirmAccion.gasto, proveedorLabel) ? (
                                        <div>
                                            <span className="font-semibold">Proveedor:</span>{" "}
                                            {proveedorDelGasto(confirmAccion.gasto, proveedorLabel)}
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
                                            titulo: "Le devuelvo todo el dinero al cliente",
                                            detalle:
                                                (confirmAccion.entrada.devuelto ?? CERO) > 0
                                                    ? "Ya tiene devoluciones: se devuelve lo que queda, eligiendo cómo sale el dinero."
                                                    : "La venta ocurrió. Se emite una factura rectificativa por el importe en negativo. Los artículos NO vuelven a la comanda, y el stock se repone. Para devolver sólo una parte, usa «Devolver».",
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
                                            onClick={() => {
                                                // Con devoluciones parciales, devolverlo «todo» es
                                                // devolver lo que queda: por la pantalla de devolver.
                                                if (
                                                    op.clase === "DEVOLUCION" &&
                                                    (confirmAccion.entrada.devuelto ?? CERO) > 0
                                                ) {
                                                    setDevolverDe({ entrada: confirmAccion.entrada, todo: true });
                                                    setConfirmAccion(null);
                                                    return;
                                                }
                                                setClaseBaja(op.clase);
                                            }}
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
                open={facturaDe !== null}
                onClose={() => {
                    setFacturaDe(null);
                    setF3Error(null);
                }}
                onConfirmar={confirmarFactura}
                importe={sumar(...(facturaDe?.entradas ?? []).map((x) => x.importe))}
                inicial={facturaDe?.inicial ?? null}
                corrigiendo={facturaDe?.corregir ?? null}
                accion={
                    facturaDe?.corregir
                        ? { texto: "Corregir factura", enCurso: "Corrigiendo…" }
                        : { texto: "Emitir factura", enCurso: "Emitiendo…" }
                }
                limite={limite_simplif}
                obligatorio={false}
                guardando={f3Guardando}
                error={f3Error}
            />

            {/* Reimpresión de un cobro ya hecho: mismo número que el original, marcado COPIA. */}
            {devolverDe ? (
                <DevolverModal
                    entrada={devolverDe.entrada}
                    todo={devolverDe.todo}
                    onCerrar={() => setDevolverDe(null)}
                    onHecho={(d) => {
                        setDevolverDe(null);
                        setReimpresion(
                            d.num_factura ? { idPago: d.id_pago, numFactura: d.num_factura } : { idPago: d.id_pago },
                        );
                    }}
                />
            ) : null}

            <PrintTicketModal
                open={reimpresion !== null}
                onClose={() => setReimpresion(null)}
                titulo="Reimprimir ticket"
                items={[]}
                cobro={reimpresion}
            />
        </div>
    );
}
