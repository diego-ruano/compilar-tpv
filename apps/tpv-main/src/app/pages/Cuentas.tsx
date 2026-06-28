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
    Save,
    Coins,
    ArrowRightLeft,
    Plus,
    Minus,
} from "lucide-react";
import { SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import {
    cuentasGetEntradas,
    cuentasGetSalidas,
    type ProveedorMini,
    type Entrada,
    type Salida,
    DEFAULT_DENOMS,
    getXFondo,
    setXFondo,
    cashTotal,
    calcDeltaToReachFondo,
    incCash,
    decCash,
    resetCash,
    type Denom,
    type CashCount,
} from "../../features/cuentas/cuentasApis";
import {
    useCuentasEntradas,
    useCuentasSalidas,
    useCuentasProveedoresMini,
    useCreateGasto,
    useUpdateGasto,
    useDeleteGasto,
    useUpdatePago,
    useDeletePago,
} from "../../features/cuentas/cuentasQueries";

// PDF
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Tauri: guardar en ruta elegida por el usuario
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

function euro(n: number) {
    return n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

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

function moneyLabel(value: number) {
    if (value < 1) return `${Math.round(value * 100)}c`;
    return `${value}€`;
}

function DenomsGrid({
    title,
    subtitle,
    denoms,
    count,
    onAdd,
    onRemove,
    onReset,
    total,
}: {
    title: string;
    subtitle?: string;
    denoms: Denom[];
    count: CashCount;
    onAdd: (label: string) => void;
    onRemove: (label: string) => void;
    onReset: () => void;
    total: number;
}) {
    return (
        <div className="min-w-0 rounded-2xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-fg sm:text-lg">
                            {title}
                        </h3>
                        <Badge>Total: {euro(total)}</Badge>
                    </div>
                    {subtitle ? (
                        <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={onReset}
                    className="h-8 shrink-0 rounded-lg border border-border bg-surface px-3 text-xs font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98]"
                >
                    Reset
                </button>
            </div>

            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(135px,1fr))] gap-2.5">
                {denoms.map((d) => {
                    const c = count[d.label] || 0;
                    const active = c > 0;
                    const subtotal = Math.round(c * d.value * 100) / 100;
                    return (
                        <div
                            key={d.label}
                            className={cn(
                                "min-w-0 rounded-xl border p-3 transition-colors",
                                active
                                    ? "border-accent bg-accent-soft ring-1 ring-accent/30"
                                    : "border-border bg-surface-2",
                            )}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <p className="truncate text-base font-extrabold text-fg">
                                    {d.label}
                                </p>
                                {active ? (
                                    <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-accent-fg">
                                        {c}
                                    </span>
                                ) : (
                                    <span className="text-xs text-fg-subtle">{moneyLabel(d.value)}</span>
                                )}
                            </div>

                            <p className="mt-0.5 truncate text-[11px] text-fg-muted">
                                {active ? `Subtotal ${euro(subtotal)}` : moneyLabel(d.value)}
                            </p>

                            <div className="mt-3 grid grid-cols-[2rem_minmax(1.5rem,1fr)_2rem] items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => onRemove(d.label)}
                                    disabled={c === 0}
                                    aria-label={`Quitar ${d.label}`}
                                    className={cn(
                                        "grid size-8 place-items-center rounded-lg border border-border bg-surface text-fg transition hover:bg-surface-2 active:scale-[0.95] cursor-pointer",
                                        c === 0 && "cursor-not-allowed opacity-40",
                                    )}
                                >
                                    <Minus className="size-4" aria-hidden />
                                </button>

                                <div className="min-w-0 text-center">
                                    <p className="truncate text-lg font-extrabold leading-none text-fg">
                                        {c}
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => onAdd(d.label)}
                                    aria-label={`Añadir ${d.label}`}
                                    className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.95] cursor-pointer"
                                >
                                    <Plus className="size-4" aria-hidden />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

type SalidaExt = Salida & {
    proveedorId?: string | null;
    proveedorNombre?: string | null;
};

function normalizeProveedorId(v: unknown): string | null {
    const s = String(v ?? "").trim();
    return s ? s : null;
}

function mapEntradaUI(r: any): Entrada {
    return {
        id: String(r?.id ?? ""),
        fechaHora: String(r?.fechaHora ?? "").slice(0, 16),
        cliente: String(r?.cliente ?? ""),
        metodo:
            String(r?.metodo ?? "Efectivo") === "Tarjeta" ? "Tarjeta" : "Efectivo",
        importe: Number(r?.importe ?? 0),
    };
}

function mapSalidaUI(
    r: any,
    proveedoresMap: Map<string, string>,
): SalidaExt {
    const proveedorId = normalizeProveedorId(
        r?.proveedorId ?? r?.ID_Proveedor ?? r?.idProveedor ?? r?.id_proveedor,
    );

    const proveedorNombre =
        r?.proveedorNombre ??
        r?.Proveedor_Nombre ??
        r?.proveedor_nombre ??
        (proveedorId ? proveedoresMap.get(proveedorId) : null) ??
        null;

    return {
        id: String(r?.id ?? r?.ID_Gasto ?? ""),
        fechaHora: String(r?.fechaHora ?? r?.Fecha ?? "").slice(0, 10),
        tipoGasto: String(r?.tipoGasto ?? r?.Tipo_Gasto ?? ""),
        concepto: String(r?.concepto ?? r?.Concepto ?? ""),
        importe: Number(r?.importe ?? r?.Importe ?? 0),
        proveedorId,
        proveedorNombre,
    };
}

export default function Cuentas() {
    const [busqueda, setBusqueda] = useState("");
    const [del, setDel] = useState(() => todayYMD());
    const [al, setAl] = useState(() => todayYMD());

    const rangoInvalido = !!del && !!al && del > al;

    // Lecturas cacheadas (TanStack Query). El rango (del/al) forma parte de la queryKey.
    const entradasQuery = useCuentasEntradas({ del, al }, !rangoInvalido);
    const salidasQuery = useCuentasSalidas({ del, al }, !rangoInvalido);
    const proveedoresQuery = useCuentasProveedoresMini();

    // Escrituras (mutaciones con invalidación en onSuccess).
    const createGasto = useCreateGasto();
    const updateGasto = useUpdateGasto();
    const deleteGasto = useDeleteGasto();
    const updatePago = useUpdatePago();
    const deletePago = useDeletePago();

    const proveedores: ProveedorMini[] = useMemo(
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
        for (const p of proveedores) m.set(p.id, p.nombre);
        return m;
    }, [proveedores]);

    // Datos derivados de las queries (mismos mappers que antes).
    const entradasDB = useMemo<Entrada[]>(
        () => (entradasQuery.data ?? []).map(mapEntradaUI),
        [entradasQuery.data],
    );
    const loadingEntradas = entradasQuery.isFetching;

    const salidasDB = useMemo<SalidaExt[]>(
        () => (salidasQuery.data ?? []).map((r) => mapSalidaUI(r, proveedoresMap)),
        [salidasQuery.data, proveedoresMap],
    );
    const loadingSalidas = salidasQuery.isFetching;

    // Wrapper que conserva el nombre/uso previo: refresca proveedores bajo demanda.
    const ensureProveedores = async () => {
        await proveedoresQuery.refetch();
    };

    const [confirmAccion, setConfirmAccion] = useState<
        | { tipo: "gasto"; gasto: SalidaExt }
        | { tipo: "entrada"; entrada: Entrada }
        | null
    >(null);
    const [confirmando, setConfirmando] = useState(false);
    const [confirmError, setConfirmError] = useState<string | null>(null);

    const [openAddGasto, setOpenAddGasto] = useState(false);
    const [gFecha, setGFecha] = useState(() => todayYMD());
    const [gTipo, setGTipo] = useState("Suministros");
    const [gConcepto, setGConcepto] = useState("");
    const [gImporte, setGImporte] = useState<string>("");
    const [gProveedorId, setGProveedorId] = useState<string>("");
    const [savingGasto, setSavingGasto] = useState(false);
    const savingGastoRef = useRef(false);
    const [errGasto, setErrGasto] = useState<string | null>(null);

    const [savingPdf, setSavingPdf] = useState(false);
    const [pdfError, setPdfError] = useState<string | null>(null);

    const [openEditGasto, setOpenEditGasto] = useState(false);
    const [editGastoId, setEditGastoId] = useState<string | null>(null);
    const [egFecha, setEgFecha] = useState("");
    const [egTipo, setEgTipo] = useState("Suministros");
    const [egConcepto, setEgConcepto] = useState("");
    const [egImporte, setEgImporte] = useState<string>("");
    const [egProveedorId, setEgProveedorId] = useState<string>("");
    const [savingEditGasto, setSavingEditGasto] = useState(false);
    const [errEditGasto, setErrEditGasto] = useState<string | null>(null);

    const [openEditPago, setOpenEditPago] = useState(false);
    const [editPagoId, setEditPagoId] = useState<string | null>(null);
    const [epFechaHora, setEpFechaHora] = useState("");
    const [epMetodo, setEpMetodo] = useState<"Tarjeta" | "Efectivo">("Efectivo");
    const [epImporte, setEpImporte] = useState<string>("");
    const [savingEditPago, setSavingEditPago] = useState(false);
    const [errEditPago, setErrEditPago] = useState<string | null>(null);

    const [openX, setOpenX] = useState(false);
    const [xFondo, setXFondoState] = useState<CashCount>({});
    const [xCierre, setXCierreState] = useState<CashCount>({});
    const [xSavedToast, setXSavedToast] = useState<string | null>(null);

    const denoms = DEFAULT_DENOMS;

    const totalFondo = useMemo(() => cashTotal(denoms, xFondo), [denoms, xFondo]);
    const totalCierre = useMemo(() => cashTotal(denoms, xCierre), [denoms, xCierre]);

    const deltas = useMemo(() => {
        return calcDeltaToReachFondo({
            denoms,
            fondo: xFondo,
            cierre: xCierre,
        });
    }, [denoms, xFondo, xCierre]);

    const deltaResumen = useMemo(() => {
        let add = 0;
        let remove = 0;
        for (const d of deltas) {
            const v = d.delta * d.value;
            if (d.delta > 0) add += v;
            if (d.delta < 0) remove += Math.abs(v);
        }
        add = Math.round(add * 100) / 100;
        remove = Math.round(remove * 100) / 100;
        return {
            add,
            remove,
            neto: Math.round((totalFondo - totalCierre) * 100) / 100,
        };
    }, [deltas, totalFondo, totalCierre]);

    const abrirModalX = () => {
        const saved = getXFondo();
        setXFondoState(saved || {});
        setXCierreState({});
        setXSavedToast(null);
        setOpenX(true);
    };

    const guardarFondoPredeterminado = () => {
        setXFondo(xFondo);
        setXSavedToast("✅ Fondo predeterminado guardado.");
        setTimeout(() => setXSavedToast(null), 1800);
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

    const q = busqueda.trim().toLowerCase();

    const entradasFiltradas = useMemo(() => {
        return entradasDB.filter((e) => {
            const texto = `${e.fechaHora} ${e.cliente} ${e.metodo} ${e.importe}`.toLowerCase();
            return !q || texto.includes(q);
        });
    }, [entradasDB, q]);

    const salidasFiltradas = useMemo(() => {
        return salidasDB.filter((s) => {
            const extraProv = `${s.proveedorId ?? ""} ${s.proveedorNombre ?? ""}`.toLowerCase();
            const texto = `${s.fechaHora} ${s.tipoGasto} ${s.concepto} ${s.importe} ${extraProv}`.toLowerCase();
            return !q || texto.includes(q);
        });
    }, [salidasDB, q]);

    const totalEntradas = useMemo(
        () => entradasFiltradas.reduce((acc, e) => acc + (Number(e.importe) || 0), 0),
        [entradasFiltradas],
    );

    const totalSalidas = useMemo(
        () => salidasFiltradas.reduce((acc, s) => acc + (Number(s.importe) || 0), 0),
        [salidasFiltradas],
    );

    const balance = totalEntradas - totalSalidas;

    const abrirModalGasto = async () => {
        setErrGasto(null);
        setGFecha(todayYMD());
        setGTipo("Suministros");
        setGConcepto("");
        setGImporte("");
        setGProveedorId("");
        await ensureProveedores();
        setOpenAddGasto(true);
    };

    const abrirEditarGasto = async (s: SalidaExt) => {
        setErrEditGasto(null);
        setEditGastoId(s.id);
        setEgFecha(s.fechaHora);
        setEgTipo(s.tipoGasto || "Suministros");
        setEgConcepto(s.concepto || "");
        setEgImporte(String(s.importe ?? ""));
        setEgProveedorId(
            s.proveedorId !== null && s.proveedorId !== undefined
                ? String(s.proveedorId)
                : "",
        );
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
            const importe = Number(String(egImporte).replace(",", "."));

            const provRaw = (egProveedorId || "").trim();
            const proveedorId = provRaw === "" ? null : provRaw;

            if (!fecha) return setErrEditGasto("La fecha es obligatoria.");
            if (!tipo) return setErrEditGasto("El tipo es obligatorio.");
            if (!concepto) return setErrEditGasto("El concepto es obligatorio.");
            if (!Number.isFinite(importe) || importe <= 0) {
                return setErrEditGasto("El importe debe ser mayor que 0.");
            }

            if (tipo === "Proveedor") {
                if (!proveedorId) {
                    return setErrEditGasto("Selecciona un proveedor.");
                }
            }

            setSavingEditGasto(true);

            const ok = await updateGasto.mutateAsync({
                idGasto: editGastoId,
                fecha,
                tipoGasto: tipo,
                concepto,
                importe,
                proveedorId: tipo === "Proveedor" ? proveedorId : null,
            });

            if (!ok) throw new Error("No se pudo actualizar el gasto.");

            setOpenEditGasto(false);
        } catch (e: any) {
            console.error(e);
            setErrEditGasto(String(e?.message ?? "Error actualizando gasto"));
        } finally {
            setSavingEditGasto(false);
        }
    };

    const borrarGasto = (s: SalidaExt) => {
        setConfirmError(null);
        setConfirmAccion({ tipo: "gasto", gasto: s });
    };

    const abrirEditarPago = (e: Entrada) => {
        setErrEditPago(null);
        setEditPagoId(e.id);
        setEpFechaHora(e.fechaHora);
        setEpMetodo(e.metodo);
        setEpImporte(String(e.importe ?? ""));
        setOpenEditPago(true);
    };

    const guardarEditarPago = async () => {
        try {
            setErrEditPago(null);
            if (!editPagoId) return;

            const fechaHora = (epFechaHora || "").trim();
            const importe = Number(String(epImporte).replace(",", "."));

            if (!fechaHora) return setErrEditPago("La fecha/hora es obligatoria.");
            if (!Number.isFinite(importe) || importe <= 0) {
                return setErrEditPago("El importe debe ser mayor que 0.");
            }

            setSavingEditPago(true);

            const ok = await updatePago.mutateAsync({
                idPago: editPagoId,
                fechaHora,
                metodo: epMetodo,
                importe,
            });

            if (!ok) throw new Error("No se pudo actualizar la entrada.");

            setOpenEditPago(false);
        } catch (e: any) {
            console.error(e);
            setErrEditPago(String(e?.message ?? "Error actualizando entrada"));
        } finally {
            setSavingEditPago(false);
        }
    };

    const borrarPago = (e: Entrada) => {
        setConfirmError(null);
        setConfirmAccion({ tipo: "entrada", entrada: e });
    };

    const confirmarBorrado = async () => {
        if (!confirmAccion) return;

        setConfirmando(true);
        setConfirmError(null);

        try {
            if (confirmAccion.tipo === "gasto") {
                await deleteGasto.mutateAsync(confirmAccion.gasto.id);
            } else {
                await deletePago.mutateAsync(confirmAccion.entrada.id);
            }

            setConfirmAccion(null);
        } catch (e: any) {
            console.error("Error borrando:", e);
            setConfirmError(String(e?.message ?? "Error borrando"));
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
            const importe = Number(String(gImporte).replace(",", "."));

            const provRaw = (gProveedorId || "").trim();
            const proveedorId = provRaw === "" ? null : provRaw;

            if (!fecha) { setErrGasto("La fecha es obligatoria."); return; }
            if (!tipo) { setErrGasto("El tipo es obligatorio."); return; }
            if (!concepto) { setErrGasto("El concepto es obligatorio."); return; }
            if (!Number.isFinite(importe) || importe <= 0) {
                setErrGasto("El importe debe ser un número mayor que 0.");
                return;
            }

            if (tipo === "Proveedor" && !proveedorId) {
                setErrGasto("Selecciona un proveedor.");
                return;
            }

            const ok = await createGasto.mutateAsync({
                fecha,
                tipoGasto: tipo,
                concepto,
                importe,
                proveedorId: tipo === "Proveedor" ? proveedorId : null,
            });

            if (!ok) throw new Error("No se pudo guardar el gasto.");

            setOpenAddGasto(false);
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

            const formatMoney = (n: number) => euro(Number(n || 0));

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
                `Entradas: ${formatMoney(totalEntradas)} | Salidas: ${formatMoney(
                    totalSalidas,
                )} | Balance: ${formatMoney(balance)}`,
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

            if (!entradasFiltradas.length) {
                ctx = write(ctx, "Sin entradas para este rango/filtro.", { color: gray });
            } else {
                for (const e of entradasFiltradas) {
                    ctx = writeRow(ctx, [
                        { text: e.fechaHora, x: M },
                        { text: e.cliente, x: M + 140 },
                        { text: e.metodo, x: M + 380 },
                        {
                            text: formatMoney(e.importe),
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

            if (!salidasFiltradas.length) {
                ctx = write(ctx, "Sin salidas para este rango/filtro.", { color: gray });
            } else {
                for (const s of salidasFiltradas) {
                    const provName =
                        s.proveedorNombre ??
                        (s.proveedorId ? proveedoresMap.get(s.proveedorId) : null);

                    const conceptoPdf =
                        s.tipoGasto === "Proveedor" && (provName || s.proveedorId)
                            ? `${s.concepto} (Prov: ${provName ?? s.proveedorId})`
                            : s.concepto;

                    ctx = writeRow(ctx, [
                        { text: s.fechaHora, x: M },
                        { text: s.tipoGasto, x: M + 110 },
                        { text: conceptoPdf, x: M + 230 },
                        {
                            text: formatMoney(s.importe),
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

            const totalEntradasHoy = entradasHoyF.reduce(
                (acc: number, e: any) => acc + (Number(e.importe) || 0),
                0,
            );
            const totalSalidasHoy = salidasHoyF.reduce(
                (acc: number, s: any) => acc + (Number(s.importe ?? s.Importe) || 0),
                0,
            );
            const balanceHoy = totalEntradasHoy - totalSalidasHoy;

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
            const formatMoney = (n: number) => euro(Number(n || 0));
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
                `Entradas: ${formatMoney(totalEntradasHoy)} | Salidas: ${formatMoney(
                    totalSalidasHoy,
                )} | Balance: ${formatMoney(balanceHoy)}`,
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
                        { text: String(e.fechaHora ?? ""), x: M },
                        { text: String(e.cliente ?? ""), x: M + 140 },
                        { text: String(e.metodo ?? ""), x: M + 380 },
                        {
                            text: formatMoney(Number(e.importe ?? 0)),
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
                for (const s of salidasHoyF as any[]) {
                    const fecha = String(s.fechaHora ?? s.Fecha ?? "");
                    const tipo = String(s.tipoGasto ?? s.Tipo_Gasto ?? "");
                    const conceptoBase = String(s.concepto ?? s.Concepto ?? "");
                    const provId = normalizeProveedorId(s.proveedorId ?? s.ID_Proveedor ?? 0);
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
                            text: formatMoney(Number(s.importe ?? s.Importe ?? 0)),
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
                        <Badge>Entradas: {euro(totalEntradas)}</Badge>
                        <Badge>Salidas: {euro(totalSalidas)}</Badge>
                        <Badge>
                            Balance:{" "}
                            <span className={balance >= 0 ? "text-success" : "text-danger"}>
                                {euro(balance)}
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
                                <Badge>Total: {euro(totalEntradas)}</Badge>
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
                                                            <div className="text-xs text-fg-muted">{e.fechaHora}</div>
                                                            <div className="font-semibold text-fg truncate">
                                                                {e.cliente}
                                                            </div>
                                                            <div className="text-xs text-fg-muted">{e.metodo}</div>
                                                        </div>
                                                        <div className="flex flex-col items-end gap-2">
                                                            <div className="font-extrabold text-fg">
                                                                {euro(e.importe)}
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                                                                    <Pencil className="size-4" aria-hidden />
                                                                </MiniIconButton>
                                                                <MiniIconButton
                                                                    title="Borrar"
                                                                    variant="danger"
                                                                    onClick={() => borrarPago(e)}
                                                                >
                                                                    <Trash2 className="size-4" aria-hidden />
                                                                </MiniIconButton>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-3 text-sm hover:bg-surface-2">
                                                        <div className="col-span-3">{e.fechaHora}</div>
                                                        <div className="col-span-4 min-w-0">
                                                            <div className="font-medium truncate">{e.cliente}</div>
                                                            <div className="text-xs text-fg-muted">{e.metodo}</div>
                                                        </div>
                                                        <div className="col-span-2 font-semibold">
                                                            {euro(e.importe)}
                                                        </div>
                                                        <div className="col-span-3 flex justify-end gap-2">
                                                            <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                                                                <Pencil className="size-4" aria-hidden />
                                                            </MiniIconButton>
                                                            <MiniIconButton
                                                                title="Borrar"
                                                                variant="danger"
                                                                onClick={() => borrarPago(e)}
                                                            >
                                                                <Trash2 className="size-4" aria-hidden />
                                                            </MiniIconButton>
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
                        </section>

                        <section className="flex h-full min-h-0 overflow-hidden flex-col rounded-3xl border border-border bg-surface p-4 shadow-sm sm:p-5">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">Salidas</h2>
                                    <p className="text-sm text-fg-muted">Gastos del negocio.</p>
                                </div>
                                <PrimaryButton onClick={abrirModalGasto} className="shrink-0">
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
                                                    s.tipoGasto === "Proveedor" && s.proveedorId
                                                        ? proveedorLabel(s.proveedorId)
                                                        : null;

                                                return (
                                                    <div key={s.id} className="p-4 sm:p-0">
                                                        <div className="sm:hidden flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-xs text-fg-muted">{s.fechaHora}</div>
                                                                <div className="font-semibold text-fg truncate">
                                                                    {s.concepto}
                                                                </div>
                                                                <div className="text-xs text-fg-muted">
                                                                    {s.tipoGasto}
                                                                    {provText ? <> · {provText}</> : null}
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-col items-end gap-2">
                                                                <div className="font-extrabold text-fg">
                                                                    {euro(s.importe)}
                                                                </div>
                                                                <div className="flex gap-2">
                                                                    <MiniIconButton title="Editar" onClick={() => abrirEditarGasto(s)}>
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
                                                            <div className="col-span-2">{s.fechaHora}</div>
                                                            <div className="col-span-2 truncate">
                                                                {s.tipoGasto}
                                                                {provText ? (
                                                                    <span className="ml-1 text-xs text-fg-muted">
                                                                        ({provText})
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                            <div className="col-span-3 truncate">{s.concepto}</div>
                                                            <div className="col-span-2 font-semibold">
                                                                {euro(s.importe)}
                                                            </div>
                                                            <div className="col-span-3 flex justify-end gap-2">
                                                                <MiniIconButton title="Editar" onClick={() => abrirEditarGasto(s)}>
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
                        </section>
                    </div>

            {/* FOOTER */}
            <div className="w-full rounded-2xl border border-border bg-surface p-4 shadow-sm">
                <div className="grid grid-cols-1 gap-3 sm:flex sm:items-center sm:justify-between">
                    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                        <button
                            onClick={guardarPdf}
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
                            onClick={abrirModalX}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-4 text-sm font-extrabold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
                        >
                            <Calculator className="size-4" aria-hidden />
                            Entrada de Caja
                        </button>
                    </div>

                    <button
                        onClick={sacarCuentaDelDia}
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

            {openAddGasto ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
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
                                            <option key={p.id} value={String(p.id)}>
                                                {p.nombre}
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
                                <input
                                    value={gImporte}
                                    onChange={(e) => setGImporte(e.target.value)}
                                    inputMode="decimal"
                                    placeholder="Ej: 120.50"
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
                                />
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
                                onClick={guardarGasto}
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
                </div>
            ) : null}

            {openEditGasto ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
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
                                            <option key={p.id} value={String(p.id)}>
                                                {p.nombre}
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
                                <input
                                    value={egImporte}
                                    onChange={(e) => setEgImporte(e.target.value)}
                                    inputMode="decimal"
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                />
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
                                onClick={guardarEditarGasto}
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
                </div>
            ) : null}

            {openEditPago ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
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
                                    value={epImporte}
                                    onChange={(e) => setEpImporte(e.target.value)}
                                    inputMode="decimal"
                                    className="mt-1 w-full rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none"
                                />
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
                                onClick={guardarEditarPago}
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
                </div>
            ) : null}

            {openX ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
                    <div
                        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
                        onClick={() => setOpenX(false)}
                    />

                    <div className="relative flex h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-3xl border border-border bg-surface shadow-2xl">
                        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-surface px-4 py-4 sm:px-6">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                                    <Calculator className="size-6" aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-xl font-extrabold text-fg">
                                        Entrada de Caja
                                    </h3>
                                    <p className="mt-0.5 text-sm text-fg-muted">
                                        Cuenta el efectivo del fondo y del cierre para preparar el
                                        siguiente turno.
                                    </p>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => setOpenX(false)}
                                className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-2xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg active:scale-[0.98]"
                                title="Cerrar"
                            >
                                <X className="size-4" aria-hidden />
                            </button>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
                            {xSavedToast ? (
                                <div className="mb-4 rounded-2xl border border-success/30 bg-success-soft px-4 py-2 text-sm text-success">
                                    {xSavedToast}
                                </div>
                            ) : null}

                            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                                    <p className="flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
                                        <Wallet className="size-4 text-accent" aria-hidden />
                                        Fondo total
                                    </p>
                                    <p className="mt-1 text-2xl font-extrabold text-fg">{euro(totalFondo)}</p>
                                    <p className="mt-2 text-xs text-fg-muted">
                                        Lo que quieres tener al empezar cada turno.
                                    </p>
                                </div>

                                <div className="rounded-2xl border border-border bg-surface-2 p-4">
                                    <p className="flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
                                        <Coins className="size-4 text-accent" aria-hidden />
                                        Cierre total
                                    </p>
                                    <p className="mt-1 text-2xl font-extrabold text-fg">{euro(totalCierre)}</p>
                                    <p className="mt-2 text-xs text-fg-muted">
                                        Lo que tienes ahora mismo al acabar.
                                    </p>
                                </div>

                                <div
                                    className={cn(
                                        "rounded-2xl border p-4",
                                        deltaResumen.neto >= 0
                                            ? "border-danger/30 bg-danger-soft"
                                            : "border-success/30 bg-success-soft",
                                    )}
                                >
                                    <p
                                        className={cn(
                                            "flex items-center gap-1.5 text-xs font-semibold",
                                            deltaResumen.neto >= 0 ? "text-danger" : "text-success",
                                        )}
                                    >
                                        <ArrowRightLeft className="size-4" aria-hidden />
                                        Diferencia neta
                                    </p>
                                    <p
                                        className={cn(
                                            "mt-1 text-2xl font-extrabold",
                                            deltaResumen.neto >= 0 ? "text-danger" : "text-success",
                                        )}
                                    >
                                        {deltaResumen.neto >= 0
                                            ? `Faltan ${euro(deltaResumen.neto)}`
                                            : `Sobran ${euro(Math.abs(deltaResumen.neto))}`}
                                    </p>
                                    <p
                                        className={cn(
                                            "mt-2 text-xs",
                                            deltaResumen.neto >= 0 ? "text-danger/80" : "text-success/80",
                                        )}
                                    >
                                        Detalle por monedas/billetes abajo.
                                    </p>
                                </div>
                            </div>

                            <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
                                <DenomsGrid
                                    title="1 · Fondo (predeterminado)"
                                    subtitle="Con cuánto quieres empezar siempre todos los turnos."
                                    denoms={denoms}
                                    count={xFondo}
                                    total={totalFondo}
                                    onAdd={(label) => setXFondoState((prev) => incCash(prev, label))}
                                    onRemove={(label) => setXFondoState((prev) => decCash(prev, label))}
                                    onReset={() => setXFondoState(resetCash())}
                                />

                                <DenomsGrid
                                    title="2 · Cierre (final del día)"
                                    subtitle="Lo que tienes hoy en caja al cerrar."
                                    denoms={denoms}
                                    count={xCierre}
                                    total={totalCierre}
                                    onAdd={(label) => setXCierreState((prev) => incCash(prev, label))}
                                    onRemove={(label) => setXCierreState((prev) => decCash(prev, label))}
                                    onReset={() => setXCierreState(resetCash())}
                                />
                            </div>

                            <div className="mt-4 rounded-2xl border border-border bg-surface-2 p-4 sm:p-5">
                                <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                                    <div>
                                        <h4 className="text-lg font-extrabold text-fg">
                                            3 · Qué añadir / quitar para el siguiente servicio
                                        </h4>
                                        <p className="mt-1 text-sm text-fg-muted">
                                            Objetivo: que el cierre se convierta en tu fondo predeterminado.
                                        </p>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge>Añadir aprox: {euro(deltaResumen.add)}</Badge>
                                        <Badge>Quitar aprox: {euro(deltaResumen.remove)}</Badge>
                                    </div>
                                </div>

                                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                    {deltas
                                        .filter((d) => d.delta !== 0)
                                        .map((d) => {
                                            const sign = d.delta > 0 ? "add" : "remove";
                                            return (
                                                <div
                                                    key={d.label}
                                                    className={[
                                                        "rounded-2xl border p-3",
                                                        sign === "add"
                                                            ? "border-success/30 bg-success-soft"
                                                            : "border-danger/30 bg-danger-soft",
                                                    ].join(" ")}
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <p className="font-extrabold text-fg">{d.label}</p>
                                                        <span className="text-xs text-fg-muted">{moneyLabel(d.value)}</span>
                                                    </div>

                                                    <div className="mt-2 flex items-end justify-between gap-2">
                                                        <div>
                                                            <p className="text-xs text-fg-muted">Acción</p>
                                                            <p
                                                                className={[
                                                                    "text-sm font-extrabold",
                                                                    sign === "add" ? "text-success" : "text-danger",
                                                                ].join(" ")}
                                                            >
                                                                {sign === "add" ? "Añadir" : "Quitar"} {Math.abs(d.delta)}
                                                            </p>
                                                        </div>

                                                        <div className="text-right">
                                                            <p className="text-xs text-fg-muted">Impacto</p>
                                                            <p className="text-sm font-extrabold text-fg">
                                                                {euro(Math.round(Math.abs(d.delta * d.value) * 100) / 100)}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}

                                    {!deltas.some((d) => d.delta !== 0) ? (
                                        <div className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm text-fg-muted">
                                            ✅ Perfecto: el cierre ya coincide con tu fondo predeterminado.
                                        </div>
                                    ) : null}
                                </div>

                                <div className="mt-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setXFondoState(xCierre);
                                            setXFondo(xCierre);
                                            setXSavedToast("✅ Fondo actualizado con el cierre actual.");
                                            setTimeout(() => setXSavedToast(null), 1800);
                                        }}
                                        className="h-10 px-4 rounded-2xl border border-border bg-surface text-sm font-semibold text-fg hover:bg-surface-2 active:scale-[0.98] transition"
                                        title="Si quieres que el fondo predeterminado pase a ser lo que tienes ahora mismo"
                                    >
                                        Usar cierre como nuevo fondo
                                    </button>
                                    <button
                                        type="button"
                                        onClick={guardarFondoPredeterminado}
                                        className="inline-flex h-10 items-center justify-center gap-2 rounded-2xl border border-accent bg-accent px-4 text-sm font-extrabold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
                                    >
                                        <Save className="size-4" aria-hidden />
                                        Guardar fondo
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {confirmAccion ? (
                <div className="fixed inset-0 z-[60] flex items-center justify-center">
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => (confirmando ? null : setConfirmAccion(null))}
                    />

                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-fg">
                                    {confirmAccion.tipo === "gasto" ? "Borrar gasto" : "Borrar entrada"}
                                </h3>
                                <p className="text-sm text-fg-muted">
                                    {confirmAccion.tipo === "gasto"
                                        ? "Esto eliminará el gasto de la base de datos."
                                        : "Esto eliminará también sus relaciones de pago."}
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
                                        {confirmAccion.gasto.fechaHora || "—"}
                                    </div>
                                    <div className="truncate">
                                        <span className="font-semibold">Concepto:</span>{" "}
                                        {confirmAccion.gasto.concepto || "—"}
                                    </div>
                                    <div>
                                        <span className="font-semibold">Importe:</span>{" "}
                                        {euro(Number(confirmAccion.gasto.importe || 0))}
                                    </div>
                                    {confirmAccion.gasto.tipoGasto === "Proveedor" &&
                                        confirmAccion.gasto.proveedorId ? (
                                        <div>
                                            <span className="font-semibold">Proveedor:</span>{" "}
                                            {proveedorLabel(confirmAccion.gasto.proveedorId)}
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <div>
                                        <span className="font-semibold">Fecha/Hora:</span>{" "}
                                        {confirmAccion.entrada.fechaHora || "—"}
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
                                        {euro(Number(confirmAccion.entrada.importe || 0))}
                                    </div>
                                </div>
                            )}
                        </div>

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

                            <button
                                type="button"
                                disabled={confirmando}
                                onClick={confirmarBorrado}
                                className={[
                                    "h-10 px-5 rounded-xl border border-danger bg-danger text-sm font-bold text-white shadow-sm",
                                    "hover:opacity-90 active:scale-[0.97]",
                                    confirmando ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                {confirmando ? "Borrando..." : "Sí, borrar"}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
