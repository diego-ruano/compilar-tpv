import React, { useEffect, useMemo, useState } from "react";
import {
    cuentasGetEntradas,
    cuentasGetSalidas,
    cuentasCreateGasto,
    cuentasUpdateGasto,
    cuentasDeleteGasto,
    cuentasUpdatePago,
    cuentasDeletePago,
    cuentasListProveedoresMini,
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
} from "../features/cuentas/cuentasApis";

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
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700">
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
                "h-9 px-3 rounded-xl border border-slate-900 bg-slate-900 text-xs font-bold text-white shadow-sm",
                "hover:bg-slate-800 active:scale-[0.98] transition",
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
                    ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
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
        <div className="rounded-3xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 className="text-base sm:text-lg font-semibold text-slate-900">
                            {title}
                        </h3>
                        <Badge>Total: {euro(total)}</Badge>
                    </div>
                    {subtitle ? (
                        <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={onReset}
                    className="h-9 px-3 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-50 active:scale-[0.98] transition"
                >
                    Reset
                </button>
            </div>

            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {denoms.map((d) => {
                    const c = count[d.label] || 0;
                    return (
                        <div
                            key={d.label}
                            className="rounded-2xl border border-slate-200 bg-slate-50/40 p-3"
                        >
                            <div className="flex items-center justify-between">
                                <p className="font-extrabold text-slate-900">{d.label}</p>
                                <span className="text-xs text-slate-500">
                                    {moneyLabel(d.value)}
                                </span>
                            </div>

                            <div className="mt-2 flex items-center justify-between gap-2">
                                <button
                                    type="button"
                                    onClick={() => onRemove(d.label)}
                                    disabled={c === 0}
                                    className={[
                                        "w-10 h-10 rounded-xl border border-slate-200 bg-white font-bold",
                                        "hover:bg-slate-50 active:scale-[0.98] transition",
                                        c === 0 ? "opacity-40 cursor-not-allowed" : "",
                                    ].join(" ")}
                                >
                                    −
                                </button>

                                <div className="flex-1 text-center">
                                    <p className="text-[11px] text-slate-500">Cantidad</p>
                                    <p className="text-lg font-extrabold text-slate-900">{c}</p>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => onAdd(d.label)}
                                    className="w-10 h-10 rounded-xl border border-slate-200 bg-white font-bold hover:bg-slate-50 active:scale-[0.98] transition"
                                >
                                    +
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
    proveedorId?: number | null;
    proveedorNombre?: string | null;
};

function normalizeProveedorId(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function mapEntradaUI(r: any): Entrada {
    return {
        id: String(r?.id ?? crypto.randomUUID()),
        fechaHora: String(r?.fechaHora ?? "").slice(0, 16),
        cliente: String(r?.cliente ?? ""),
        metodo:
            String(r?.metodo ?? "Efectivo") === "Tarjeta" ? "Tarjeta" : "Efectivo",
        importe: Number(r?.importe ?? 0),
    };
}

function mapSalidaUI(
    r: any,
    proveedoresMap: Map<number, string>,
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
        id: String(r?.id ?? r?.ID_Gasto ?? crypto.randomUUID()),
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

    const [entradasDB, setEntradasDB] = useState<Entrada[]>([]);
    const [loadingEntradas, setLoadingEntradas] = useState(false);

    const [salidasDB, setSalidasDB] = useState<SalidaExt[]>([]);
    const [loadingSalidas, setLoadingSalidas] = useState(false);

    const [proveedores, setProveedores] = useState<ProveedorMini[]>([]);
    const [loadingProveedores, setLoadingProveedores] = useState(false);
    const [errProveedores, setErrProveedores] = useState<string | null>(null);

    const proveedoresMap = useMemo(() => {
        const m = new Map<number, string>();
        for (const p of proveedores) m.set(p.id, p.nombre);
        return m;
    }, [proveedores]);

    const ensureProveedores = async () => {
        try {
            if (loadingProveedores) return;
            if (proveedores.length > 0) return;

            setErrProveedores(null);
            setLoadingProveedores(true);
            const rows = await cuentasListProveedoresMini();
            setProveedores(rows ?? []);
        } catch (e: any) {
            console.error("Error cargando proveedores:", e);
            setErrProveedores(String(e?.message ?? "Error cargando proveedores"));
            setProveedores([]);
        } finally {
            setLoadingProveedores(false);
        }
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
    const [errGasto, setErrGasto] = useState<string | null>(null);

    const [savingPdf, setSavingPdf] = useState(false);
    const [pdfError, setPdfError] = useState<string | null>(null);

    const [openEditGasto, setOpenEditGasto] = useState(false);
    const [editGastoId, setEditGastoId] = useState<number | null>(null);
    const [egFecha, setEgFecha] = useState("");
    const [egTipo, setEgTipo] = useState("Suministros");
    const [egConcepto, setEgConcepto] = useState("");
    const [egImporte, setEgImporte] = useState<string>("");
    const [egProveedorId, setEgProveedorId] = useState<string>("");
    const [savingEditGasto, setSavingEditGasto] = useState(false);
    const [errEditGasto, setErrEditGasto] = useState<string | null>(null);

    const [openEditPago, setOpenEditPago] = useState(false);
    const [editPagoId, setEditPagoId] = useState<number | null>(null);
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

    useEffect(() => {
        void ensureProveedores();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                setLoadingEntradas(true);
                const rows = await cuentasGetEntradas({ del, al });
                if (!cancelled) setEntradasDB((rows ?? []).map(mapEntradaUI));
            } catch (e) {
                console.error("Error cargando ingresos:", e);
                if (!cancelled) setEntradasDB([]);
            } finally {
                if (!cancelled) setLoadingEntradas(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [del, al]);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                setLoadingSalidas(true);
                const rows = await cuentasGetSalidas({ del, al });
                if (!cancelled) {
                    setSalidasDB((rows ?? []).map((r) => mapSalidaUI(r, proveedoresMap)));
                }
            } catch (e) {
                console.error("Error cargando salidas:", e);
                if (!cancelled) setSalidasDB([]);
            } finally {
                if (!cancelled) setLoadingSalidas(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [del, al, proveedoresMap]);

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

    const refrescarGastos = async () => {
        const rows = await cuentasGetSalidas({ del, al });
        setSalidasDB((rows ?? []).map((r) => mapSalidaUI(r, proveedoresMap)));
    };

    const refrescarEntradas = async () => {
        const rows = await cuentasGetEntradas({ del, al });
        setEntradasDB((rows ?? []).map(mapEntradaUI));
    };

    const abrirEditarGasto = async (s: SalidaExt) => {
        setErrEditGasto(null);
        setEditGastoId(Number(s.id));
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
            const proveedorId = provRaw === "" ? null : Number(provRaw);

            if (!fecha) return setErrEditGasto("La fecha es obligatoria.");
            if (!tipo) return setErrEditGasto("El tipo es obligatorio.");
            if (!concepto) return setErrEditGasto("El concepto es obligatorio.");
            if (!Number.isFinite(importe) || importe <= 0) {
                return setErrEditGasto("El importe debe ser mayor que 0.");
            }

            if (tipo === "Proveedor") {
                if (!proveedorId || !Number.isFinite(proveedorId) || proveedorId <= 0) {
                    return setErrEditGasto("Selecciona un proveedor.");
                }
            }

            setSavingEditGasto(true);

            const ok = await cuentasUpdateGasto({
                idGasto: editGastoId,
                fecha,
                tipoGasto: tipo,
                concepto,
                importe,
                proveedorId: tipo === "Proveedor" ? proveedorId : null,
            });

            if (!ok) throw new Error("No se pudo actualizar el gasto.");

            await refrescarGastos();
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
        setEditPagoId(Number(e.id));
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

            const ok = await cuentasUpdatePago({
                idPago: editPagoId,
                fechaHora,
                metodo: epMetodo,
                importe,
            });

            if (!ok) throw new Error("No se pudo actualizar la entrada.");

            await refrescarEntradas();
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
                await cuentasDeleteGasto(Number(confirmAccion.gasto.id));
                await refrescarGastos();
            } else {
                await cuentasDeletePago(Number(confirmAccion.entrada.id));
                await refrescarEntradas();
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
        try {
            setErrGasto(null);

            const fecha = (gFecha || "").trim();
            const tipo = (gTipo || "").trim();
            const concepto = (gConcepto || "").trim();
            const importe = Number(String(gImporte).replace(",", "."));

            const provRaw = (gProveedorId || "").trim();
            const proveedorId = provRaw === "" ? null : Number(provRaw);

            if (!fecha) return setErrGasto("La fecha es obligatoria.");
            if (!tipo) return setErrGasto("El tipo es obligatorio.");
            if (!concepto) return setErrGasto("El concepto es obligatorio.");
            if (!Number.isFinite(importe) || importe <= 0) {
                return setErrGasto("El importe debe ser un número mayor que 0.");
            }

            if (tipo === "Proveedor") {
                if (!proveedorId || !Number.isFinite(proveedorId) || proveedorId <= 0) {
                    return setErrGasto("Selecciona un proveedor.");
                }
            }

            setSavingGasto(true);

            const ok = await cuentasCreateGasto({
                fecha,
                tipoGasto: tipo,
                concepto,
                importe,
                proveedorId: tipo === "Proveedor" ? proveedorId : null,
            });

            if (!ok) throw new Error("No se pudo guardar el gasto.");

            await refrescarGastos();
            setOpenAddGasto(false);
        } catch (e: any) {
            console.error(e);
            setErrGasto(String(e?.message ?? "Error guardando gasto"));
        } finally {
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
                ctx.page.drawLine({
                    start: { x: M, y: ctx.y },
                    end: { x: PAGE_W - M, y: ctx.y },
                    thickness: 1,
                    color: rgb(0.9, 0.9, 0.9),
                });
                ctx.y -= 10;
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
            drawLine(ctx);

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
            drawLine(ctx);
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
            drawLine(ctx);

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
            drawLine(ctx);
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

            const qLocal = busqueda.trim().toLowerCase();

            const entradasHoyF = (entradasHoy ?? []).filter((e) => {
                const texto = `${e.fechaHora} ${e.cliente} ${e.metodo} ${e.importe}`.toLowerCase();
                return !qLocal || texto.includes(qLocal);
            });

            const salidasHoyF = (salidasHoy ?? []).filter((s: any) => {
                const extraProv = `${s.ID_Proveedor ?? s.proveedorId ?? ""}`.toLowerCase();
                const texto = `${s.fechaHora ?? s.Fecha} ${s.tipoGasto ?? s.Tipo_Gasto} ${s.concepto ?? s.Concepto} ${s.importe ?? s.Importe} ${extraProv}`.toLowerCase();
                return !qLocal || texto.includes(qLocal);
            });

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
                ctx.page.drawLine({
                    start: { x: M, y: ctx.y },
                    end: { x: PAGE_W - M, y: ctx.y },
                    thickness: 1,
                    color: rgb(0.9, 0.9, 0.9),
                });
                ctx.y -= 10;
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
            drawLine(ctx);

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
            drawLine(ctx);
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
            drawLine(ctx);

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
            drawLine(ctx);
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

    const proveedorLabel = (id: number | null | undefined) => {
        if (!id || id <= 0) return "";
        return proveedoresMap.get(id) ?? `Proveedor #${id}`;
    };

    return (
        <div className="w-full min-h-dvh sm:h-dvh bg-transparent sm:overflow-hidden">
            <div className="min-h-dvh sm:h-dvh px-3 sm:px-6 py-4 sm:py-0 flex items-start sm:items-center justify-center">
                <div
                    className={[
                        "w-full max-w-[1280px]",
                        "rounded-3xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white shadow-sm",
                        "flex flex-col",
                        "h-auto",
                        "sm:h-[720px] sm:overflow-hidden",
                    ].join(" ")}
                >
                    <div className="flex flex-col gap-3 p-4 sm:p-6 md:flex-row md:items-center md:justify-between flex-none">
                        <div className="min-w-0">
                            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900">
                                Cuentas
                            </h1>
                            <p className="text-sm text-slate-600">
                                Filtra ingresos y gastos por fecha o búsqueda.
                            </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <Badge>Entradas: {euro(totalEntradas)}</Badge>
                            <Badge>Salidas: {euro(totalSalidas)}</Badge>
                            <Badge>
                                Balance:{" "}
                                <span className={balance >= 0 ? "text-emerald-700" : "text-rose-700"}>
                                    {euro(balance)}
                                </span>
                            </Badge>
                        </div>
                    </div>

                    <div className="px-4 sm:px-6 pb-4 flex-none">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                            <div className="md:col-span-7">
                                <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                                    <span className="text-slate-400">🔎</span>
                                    <input
                                        value={busqueda}
                                        onChange={(e) => setBusqueda(e.target.value)}
                                        placeholder="Buscar (cliente, concepto, método, importe...)"
                                        className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                                    />
                                </div>
                            </div>

                            <div className="md:col-span-5">
                                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        <label className="flex items-center gap-2">
                                            <span className="text-xs font-medium text-slate-500 w-8">Del</span>
                                            <input
                                                type="date"
                                                value={del}
                                                onChange={(e) => setDel(e.target.value)}
                                                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                                            />
                                        </label>
                                        <label className="flex items-center gap-2">
                                            <span className="text-xs font-medium text-slate-500 w-8">Al</span>
                                            <input
                                                type="date"
                                                value={al}
                                                onChange={(e) => setAl(e.target.value)}
                                                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                                            />
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {pdfError && (
                            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                                {pdfError}
                            </div>
                        )}
                    </div>

                    <div
                        className={[
                            "grid grid-cols-1 gap-4 px-4 sm:px-6 pb-4",
                            "lg:grid-cols-2",
                            "sm:flex-1 sm:min-h-0 sm:overflow-hidden",
                        ].join(" ")}
                    >
                        <section className="rounded-3xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm flex flex-col">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-slate-900">Entradas</h2>
                                    <p className="text-sm text-slate-600">
                                        Pagos de clientes (tarjeta o efectivo).
                                    </p>
                                </div>
                                <Badge>Total: {euro(totalEntradas)}</Badge>
                            </div>

                            <div className="mt-4 rounded-2xl border border-slate-200 overflow-hidden flex flex-col sm:flex-1 sm:min-h-0">
                                <div className="hidden sm:grid grid-cols-12 gap-2 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-600">
                                    <div className="col-span-4">Fecha/Hora</div>
                                    <div className="col-span-5">Cliente / Método</div>
                                    <div className="col-span-2 text-right">EUR</div>
                                    <div className="col-span-1 text-right">⋯</div>
                                </div>

                                <div className="sm:flex-1 sm:overflow-auto">
                                    {loadingEntradas ? (
                                        <div className="p-4 text-sm text-slate-500">Cargando entradas…</div>
                                    ) : entradasFiltradas.length ? (
                                        <div className="divide-y divide-slate-100">
                                            {entradasFiltradas.map((e) => (
                                                <div key={e.id} className="p-4 sm:p-0">
                                                    <div className="sm:hidden flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="text-xs text-slate-500">{e.fechaHora}</div>
                                                            <div className="font-semibold text-slate-900 truncate">
                                                                {e.cliente}
                                                            </div>
                                                            <div className="text-xs text-slate-500">{e.metodo}</div>
                                                        </div>
                                                        <div className="flex flex-col items-end gap-2">
                                                            <div className="font-extrabold text-slate-900">
                                                                {euro(e.importe)}
                                                            </div>
                                                            <div className="flex gap-2">
                                                                <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                                                                    ✎
                                                                </MiniIconButton>
                                                                <MiniIconButton
                                                                    title="Borrar"
                                                                    variant="danger"
                                                                    onClick={() => borrarPago(e)}
                                                                >
                                                                    🗑
                                                                </MiniIconButton>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-3 text-sm hover:bg-slate-50">
                                                        <div className="col-span-4">{e.fechaHora}</div>
                                                        <div className="col-span-5 min-w-0">
                                                            <div className="font-medium truncate">{e.cliente}</div>
                                                            <div className="text-xs text-slate-500">{e.metodo}</div>
                                                        </div>
                                                        <div className="col-span-2 text-right font-semibold">
                                                            {euro(e.importe)}
                                                        </div>
                                                        <div className="col-span-1 flex justify-end gap-2">
                                                            <MiniIconButton title="Editar" onClick={() => abrirEditarPago(e)}>
                                                                ✎
                                                            </MiniIconButton>
                                                            <MiniIconButton
                                                                title="Borrar"
                                                                variant="danger"
                                                                onClick={() => borrarPago(e)}
                                                            >
                                                                🗑
                                                            </MiniIconButton>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-4 text-sm text-slate-500">Sin entradas.</div>
                                    )}
                                </div>
                            </div>
                        </section>

                        <section className="rounded-3xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm flex flex-col">
                            <div className="flex items-start justify-between gap-3 flex-none">
                                <div>
                                    <h2 className="text-lg font-semibold text-slate-900">Salidas</h2>
                                    <p className="text-sm text-slate-600">Gastos del negocio.</p>
                                </div>
                                <PrimaryButton onClick={abrirModalGasto} className="shrink-0">
                                    Agregar gasto
                                </PrimaryButton>
                            </div>

                            <div className="mt-4 rounded-2xl border border-slate-200 overflow-hidden flex flex-col sm:flex-1 sm:min-h-0">
                                <div className="hidden sm:grid grid-cols-12 gap-2 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-600">
                                    <div className="col-span-2">Fecha</div>
                                    <div className="col-span-3">Tipo</div>
                                    <div className="col-span-4">Concepto</div>
                                    <div className="col-span-2 text-right">EUR</div>
                                    <div className="col-span-1 text-right">⋯</div>
                                </div>

                                <div className="sm:flex-1 sm:overflow-auto">
                                    {loadingSalidas ? (
                                        <div className="p-4 text-sm text-slate-500">Cargando salidas…</div>
                                    ) : salidasFiltradas.length ? (
                                        <div className="divide-y divide-slate-100">
                                            {salidasFiltradas.map((s) => {
                                                const provText =
                                                    s.tipoGasto === "Proveedor" && s.proveedorId
                                                        ? proveedorLabel(s.proveedorId)
                                                        : null;

                                                return (
                                                    <div key={s.id} className="p-4 sm:p-0">
                                                        <div className="sm:hidden flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-xs text-slate-500">{s.fechaHora}</div>
                                                                <div className="font-semibold text-slate-900 truncate">
                                                                    {s.concepto}
                                                                </div>
                                                                <div className="text-xs text-slate-500">
                                                                    {s.tipoGasto}
                                                                    {provText ? <> · {provText}</> : null}
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-col items-end gap-2">
                                                                <div className="font-extrabold text-slate-900">
                                                                    {euro(s.importe)}
                                                                </div>
                                                                <div className="flex gap-2">
                                                                    <MiniIconButton title="Editar" onClick={() => abrirEditarGasto(s)}>
                                                                        ✎
                                                                    </MiniIconButton>
                                                                    <MiniIconButton
                                                                        title="Borrar"
                                                                        variant="danger"
                                                                        onClick={() => borrarGasto(s)}
                                                                    >
                                                                        🗑
                                                                    </MiniIconButton>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-3 text-sm hover:bg-slate-50">
                                                            <div className="col-span-2">{s.fechaHora}</div>
                                                            <div className="col-span-3">
                                                                {s.tipoGasto}
                                                                {provText ? (
                                                                    <span className="ml-2 text-xs text-slate-500">
                                                                        ({provText})
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                            <div className="col-span-4 truncate">{s.concepto}</div>
                                                            <div className="col-span-2 text-right font-semibold">
                                                                {euro(s.importe)}
                                                            </div>
                                                            <div className="col-span-1 flex justify-end gap-2">
                                                                <MiniIconButton title="Editar" onClick={() => abrirEditarGasto(s)}>
                                                                    ✎
                                                                </MiniIconButton>
                                                                <MiniIconButton
                                                                    title="Borrar"
                                                                    variant="danger"
                                                                    onClick={() => borrarGasto(s)}
                                                                >
                                                                    🗑
                                                                </MiniIconButton>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="p-4 text-sm text-slate-500">Sin salidas.</div>
                                    )}
                                </div>
                            </div>
                        </section>
                    </div>

                    <div className="px-4 sm:px-6 pb-4 sm:pb-6 flex-none">
                        <div className="grid grid-cols-1 gap-3 sm:flex sm:items-center sm:justify-between">
                            <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2">
                                <button
                                    onClick={guardarPdf}
                                    disabled={savingPdf}
                                    className={[
                                        "h-10 px-4 rounded-2xl text-sm font-semibold shadow-sm transition active:scale-[0.98]",
                                        "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
                                        "focus:outline-none focus:ring-2 focus:ring-slate-300",
                                        savingPdf ? "opacity-60 cursor-not-allowed" : "",
                                    ].join(" ")}
                                >
                                    {savingPdf ? "Generando…" : "📄 Guardar PDF"}
                                </button>

                                <button
                                    type="button"
                                    className={[
                                        "h-10 px-4 rounded-2xl text-sm font-semibold shadow-sm transition active:scale-[0.98]",
                                        "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
                                        "focus:outline-none focus:ring-2 focus:ring-slate-300",
                                    ].join(" ")}
                                >
                                    📊 Ver estadísticas
                                </button>

                                <button
                                    type="button"
                                    className={[
                                        "h-10 px-4 rounded-2xl text-sm font-semibold shadow-sm transition active:scale-[0.98]",
                                        "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
                                        "focus:outline-none focus:ring-2 focus:ring-slate-300",
                                    ].join(" ")}
                                >
                                    ✉️ Enviar a gestoría
                                </button>

                                <button
                                    type="button"
                                    onClick={abrirModalX}
                                    className={[
                                        "h-10 px-4 rounded-2xl text-sm font-extrabold shadow-sm transition active:scale-[0.98]",
                                        "border border-slate-900 bg-slate-900 text-white hover:bg-slate-800",
                                        "focus:outline-none focus:ring-2 focus:ring-slate-300",
                                    ].join(" ")}
                                >
                                    🧮 Entrada de Caja
                                </button>
                            </div>

                            <button
                                onClick={sacarCuentaDelDia}
                                disabled={savingPdf}
                                className={[
                                    "h-10 px-5 rounded-2xl text-sm font-extrabold shadow-sm transition active:scale-[0.98]",
                                    "bg-slate-900 text-white hover:bg-slate-800",
                                    "focus:outline-none focus:ring-2 focus:ring-slate-300",
                                    "w-full sm:w-auto",
                                    savingPdf ? "opacity-60 cursor-not-allowed" : "",
                                ].join(" ")}
                            >
                                🧾 Sacar cuenta del día
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {openAddGasto ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => (savingGasto ? null : setOpenAddGasto(false))}
                    />
                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-slate-200 bg-white shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-slate-900">Agregar gasto</h3>
                                <p className="text-sm text-slate-600">
                                    Registra luz, agua, pedidos, alquiler, etc.
                                </p>
                            </div>

                            <button
                                type="button"
                                className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                onClick={() => (savingGasto ? null : setOpenAddGasto(false))}
                                title="Cerrar"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="mt-5 grid grid-cols-1 gap-3">
                            <label className="text-xs font-semibold text-slate-600">
                                Fecha
                                <input
                                    type="date"
                                    value={gFecha}
                                    onChange={(e) => setGFecha(e.target.value)}
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-slate-600">
                                Tipo
                                <select
                                    value={gTipo}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setGTipo(v);
                                        if (v !== "Proveedor") setGProveedorId("");
                                    }}
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none"
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
                                <label className="text-xs font-semibold text-slate-600">
                                    Proveedor
                                    <select
                                        value={gProveedorId}
                                        onChange={(e) => setGProveedorId(e.target.value)}
                                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
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
                                        <p className="mt-1 text-[11px] text-rose-700">{errProveedores}</p>
                                    ) : (
                                        <p className="mt-1 text-[11px] text-slate-500">
                                            Se vinculará el gasto con el proveedor seleccionado.
                                        </p>
                                    )}
                                </label>
                            ) : null}

                            <label className="text-xs font-semibold text-slate-600">
                                Concepto
                                <input
                                    value={gConcepto}
                                    onChange={(e) => setGConcepto(e.target.value)}
                                    placeholder="Ej: Pedido cocacolas, Luz enero, Agua..."
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
                                />
                            </label>

                            <label className="text-xs font-semibold text-slate-600">
                                Importe (EUR)
                                <input
                                    value={gImporte}
                                    onChange={(e) => setGImporte(e.target.value)}
                                    inputMode="decimal"
                                    placeholder="Ej: 120.50"
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
                                />
                            </label>

                            {errGasto ? (
                                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
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
                                    "h-10 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm",
                                    "hover:bg-slate-50 active:scale-[0.97]",
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
                                    "h-10 px-5 rounded-xl border border-slate-900 bg-slate-900 text-sm font-bold text-white shadow-sm",
                                    "hover:bg-slate-800 active:scale-[0.97]",
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
                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-slate-200 bg-white shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-slate-900">Editar gasto</h3>
                                <p className="text-sm text-slate-600">
                                    Modifica fecha, tipo, concepto e importe.
                                </p>
                            </div>

                            <button
                                type="button"
                                className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                onClick={() => (savingEditGasto ? null : setOpenEditGasto(false))}
                                title="Cerrar"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="mt-5 grid grid-cols-1 gap-3">
                            <label className="text-xs font-semibold text-slate-600">
                                Fecha
                                <input
                                    type="date"
                                    value={egFecha}
                                    onChange={(e) => setEgFecha(e.target.value)}
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-slate-600">
                                Tipo
                                <select
                                    value={egTipo}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setEgTipo(v);
                                        if (v !== "Proveedor") setEgProveedorId("");
                                    }}
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none"
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
                                <label className="text-xs font-semibold text-slate-600">
                                    Proveedor
                                    <select
                                        value={egProveedorId}
                                        onChange={(e) => setEgProveedorId(e.target.value)}
                                        className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
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
                                        <p className="mt-1 text-[11px] text-rose-700">{errProveedores}</p>
                                    ) : null}
                                </label>
                            ) : null}

                            <label className="text-xs font-semibold text-slate-600">
                                Concepto
                                <input
                                    value={egConcepto}
                                    onChange={(e) => setEgConcepto(e.target.value)}
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-slate-600">
                                Importe (EUR)
                                <input
                                    value={egImporte}
                                    onChange={(e) => setEgImporte(e.target.value)}
                                    inputMode="decimal"
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
                                />
                            </label>

                            {errEditGasto ? (
                                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
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
                                    "h-10 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm",
                                    "hover:bg-slate-50 active:scale-[0.97]",
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
                                    "h-10 px-5 rounded-xl border border-slate-900 bg-slate-900 text-sm font-bold text-white shadow-sm",
                                    "hover:bg-slate-800 active:scale-[0.97]",
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
                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-slate-200 bg-white shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-slate-900">Editar entrada</h3>
                                <p className="text-sm text-slate-600">
                                    Modifica fecha/hora, método e importe.
                                </p>
                            </div>

                            <button
                                type="button"
                                className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                onClick={() => (savingEditPago ? null : setOpenEditPago(false))}
                                title="Cerrar"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="mt-5 grid grid-cols-1 gap-3">
                            <label className="text-xs font-semibold text-slate-600">
                                Fecha/Hora (YYYY-MM-DD HH:mm)
                                <input
                                    value={epFechaHora}
                                    onChange={(e) => setEpFechaHora(e.target.value)}
                                    placeholder="2026-01-29 12:30"
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
                                />
                            </label>

                            <label className="text-xs font-semibold text-slate-600">
                                Método
                                <select
                                    value={epMetodo}
                                    onChange={(e) =>
                                        setEpMetodo(e.target.value === "Tarjeta" ? "Tarjeta" : "Efectivo")
                                    }
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none"
                                >
                                    <option value="Efectivo">Efectivo</option>
                                    <option value="Tarjeta">Tarjeta</option>
                                </select>
                            </label>

                            <label className="text-xs font-semibold text-slate-600">
                                Importe (EUR)
                                <input
                                    value={epImporte}
                                    onChange={(e) => setEpImporte(e.target.value)}
                                    inputMode="decimal"
                                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none"
                                />
                            </label>

                            {errEditPago ? (
                                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
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
                                    "h-10 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm",
                                    "hover:bg-slate-50 active:scale-[0.97]",
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
                                    "h-10 px-5 rounded-xl border border-slate-900 bg-slate-900 text-sm font-bold text-white shadow-sm",
                                    "hover:bg-slate-800 active:scale-[0.97]",
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
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setOpenX(false)} />

                    <div className="relative w-[1100px] max-w-[94vw] max-h-[88vh] overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white shadow-2xl">
                        <div className="p-4 sm:p-6 border-b border-slate-200 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-xl font-extrabold text-slate-900">Hacer la X (Caja)</h3>
                                <p className="mt-1 text-sm text-slate-600">
                                    Define el <b>fondo</b> con el que quieres empezar siempre y mete el{" "}
                                    <b>cierre</b> del día. Abajo te diremos qué <b>añadir/quitar</b> para
                                    el siguiente servicio.
                                </p>
                            </div>

                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setOpenX(false)}
                                    className="h-10 w-10 rounded-2xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 active:scale-[0.98] transition"
                                    title="Cerrar"
                                >
                                    ✕
                                </button>
                            </div>
                        </div>

                        <div className="p-4 sm:p-6 overflow-auto max-h-[calc(88vh-88px)]">
                            {xSavedToast ? (
                                <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
                                    {xSavedToast}
                                </div>
                            ) : null}

                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
                                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                                    <p className="text-xs font-semibold text-slate-500">Fondo total</p>
                                    <p className="mt-1 text-2xl font-extrabold text-slate-900">{euro(totalFondo)}</p>
                                    <p className="mt-2 text-xs text-slate-500">
                                        (Lo que quieres tener al empezar cada turno)
                                    </p>
                                </div>

                                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                                    <p className="text-xs font-semibold text-slate-500">Cierre total</p>
                                    <p className="mt-1 text-2xl font-extrabold text-slate-900">{euro(totalCierre)}</p>
                                    <p className="mt-2 text-xs text-slate-500">
                                        (Lo que tienes ahora mismo al acabar)
                                    </p>
                                </div>

                                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                                    <p className="text-xs font-semibold text-slate-500">
                                        Diferencia neta (fondo - cierre)
                                    </p>
                                    <p
                                        className={[
                                            "mt-1 text-2xl font-extrabold",
                                            deltaResumen.neto >= 0 ? "text-rose-700" : "text-emerald-700",
                                        ].join(" ")}
                                    >
                                        {deltaResumen.neto >= 0
                                            ? `Te faltan ${euro(deltaResumen.neto)}`
                                            : `Te sobran ${euro(Math.abs(deltaResumen.neto))}`}
                                    </p>
                                    <p className="mt-2 text-xs text-slate-500">
                                        Esto es el neto. Abajo verás el detalle por monedas/billetes.
                                    </p>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <DenomsGrid
                                    title="Fondo (predeterminado)"
                                    subtitle="Con cuánto quieres empezar siempre todos los turnos."
                                    denoms={denoms}
                                    count={xFondo}
                                    total={totalFondo}
                                    onAdd={(label) => setXFondoState((prev) => incCash(prev, label))}
                                    onRemove={(label) => setXFondoState((prev) => decCash(prev, label))}
                                    onReset={() => setXFondoState(resetCash())}
                                />

                                <DenomsGrid
                                    title="Cierre (final del día)"
                                    subtitle="Lo que tienes hoy en caja al cerrar."
                                    denoms={denoms}
                                    count={xCierre}
                                    total={totalCierre}
                                    onAdd={(label) => setXCierreState((prev) => incCash(prev, label))}
                                    onRemove={(label) => setXCierreState((prev) => decCash(prev, label))}
                                    onReset={() => setXCierreState(resetCash())}
                                />
                            </div>

                            <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
                                <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                                    <div>
                                        <h4 className="text-lg font-extrabold text-slate-900">
                                            Qué añadir / quitar para el siguiente servicio
                                        </h4>
                                        <p className="mt-1 text-sm text-slate-600">
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
                                                            ? "border-emerald-200 bg-emerald-50"
                                                            : "border-rose-200 bg-rose-50",
                                                    ].join(" ")}
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <p className="font-extrabold text-slate-900">{d.label}</p>
                                                        <span className="text-xs text-slate-500">{moneyLabel(d.value)}</span>
                                                    </div>

                                                    <div className="mt-2 flex items-end justify-between gap-2">
                                                        <div>
                                                            <p className="text-xs text-slate-600">Acción</p>
                                                            <p
                                                                className={[
                                                                    "text-sm font-extrabold",
                                                                    sign === "add" ? "text-emerald-800" : "text-rose-800",
                                                                ].join(" ")}
                                                            >
                                                                {sign === "add" ? "Añadir" : "Quitar"} {Math.abs(d.delta)}
                                                            </p>
                                                        </div>

                                                        <div className="text-right">
                                                            <p className="text-xs text-slate-600">Impacto</p>
                                                            <p className="text-sm font-extrabold text-slate-900">
                                                                {euro(Math.round(Math.abs(d.delta * d.value) * 100) / 100)}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}

                                    {!deltas.some((d) => d.delta !== 0) ? (
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
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
                                        className="h-10 px-4 rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-900 hover:bg-slate-50 active:scale-[0.98] transition"
                                        title="Si quieres que el fondo predeterminado pase a ser lo que tienes ahora mismo"
                                    >
                                        Usar cierre como nuevo fondo
                                    </button>
                                    <button
                                        type="button"
                                        onClick={guardarFondoPredeterminado}
                                        className="h-10 px-4 rounded-2xl border border-slate-900 bg-slate-900 text-white text-sm font-extrabold shadow-sm hover:bg-slate-800 active:scale-[0.98] transition"
                                    >
                                        💾 Guardar fondo
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

                    <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-slate-200 bg-white shadow-xl p-6">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold text-slate-900">
                                    {confirmAccion.tipo === "gasto" ? "Borrar gasto" : "Borrar entrada"}
                                </h3>
                                <p className="text-sm text-slate-600">
                                    {confirmAccion.tipo === "gasto"
                                        ? "Esto eliminará el gasto de la base de datos."
                                        : "Esto eliminará también sus relaciones de pago."}
                                </p>
                            </div>

                            <button
                                type="button"
                                className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                onClick={() => (confirmando ? null : setConfirmAccion(null))}
                                title="Cerrar"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
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
                            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                                {confirmError}
                            </div>
                        ) : null}

                        <div className="mt-6 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                disabled={confirmando}
                                onClick={() => setConfirmAccion(null)}
                                className={[
                                    "h-10 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm",
                                    "hover:bg-slate-50 active:scale-[0.97]",
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
                                    "h-10 px-5 rounded-xl border border-rose-700 bg-rose-700 text-sm font-bold text-white shadow-sm",
                                    "hover:bg-rose-600 active:scale-[0.97]",
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