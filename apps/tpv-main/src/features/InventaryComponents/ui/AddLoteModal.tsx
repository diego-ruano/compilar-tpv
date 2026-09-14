import React, { useEffect, useMemo, useState } from "react";
import Modal from "../ui/Modal";
import { useToast } from "../../../shared/toast";
import { type LoteRow } from "../api/inventarioAPI";
import { useCreateLote, useUpdateLote } from "../inventarioQueries";
import { conAviso } from "../../../shared/lib/conAviso";

type Props = {
    open: boolean;
    onClose: () => void;
    productId: string | null;
    loteToEdit?: LoteRow | null;
    onSaved: () => void;
};

function toNum(v: string) {
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
}

function dateInputValue(v: string | null | undefined) {
    return String(v ?? "").split(" ")[0];
}

export default function AddLoteModal({ open, onClose, productId, loteToEdit = null, onSaved }: Props) {
    const toast = useToast();

    const createLote = useCreateLote();
    const updateLote = useUpdateLote();
    const isEdit = !!loteToEdit;

    const [codigoLote, setCodigoLote] = useState("");
    const [caducidad, setCaducidad] = useState("");
    const [cantidad, setCantidad] = useState("");
    const [costeUnitario, setCosteUnitario] = useState("");
    const [notas, setNotas] = useState("");

    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;

        if (!loteToEdit) {
            reset();
            return;
        }

        setCodigoLote(loteToEdit.Codigo_Lote ?? "");
        setCaducidad(dateInputValue(loteToEdit.Caducidad));
        setCantidad(String(loteToEdit.Stock_Disponible ?? ""));
        setCosteUnitario(loteToEdit.Coste_Unitario == null ? "" : String(loteToEdit.Coste_Unitario));
        setNotas(loteToEdit.Notas ?? "");
        setLoading(false);
    }, [open, loteToEdit]);

    const ok = useMemo(() => {
        if (!productId) return false;
        if (!codigoLote.trim()) return false;

        const cant = toNum(cantidad);
        if (!Number.isFinite(cant) || cant < 0) return false;

        const cu = costeUnitario.trim() ? toNum(costeUnitario) : NaN;
        if (costeUnitario.trim() && (!Number.isFinite(cu) || cu < 0)) return false;

        return true;
    }, [productId, codigoLote, cantidad, costeUnitario]);

    const reset = () => {
        setCodigoLote("");
        setCaducidad("");
        setCantidad("");
        setCosteUnitario("");
        setNotas("");
        setLoading(false);
    };

    async function guardar(e: React.FormEvent) {
        e.preventDefault();
        if (!productId) return;

        if (!ok) {
            toast.info("Validación", "Revisa el código de lote y la cantidad.");
            return;
        }

        setLoading(true);
        try {
            const cant = toNum(cantidad);
            const cu = costeUnitario.trim() ? toNum(costeUnitario) : null;

            if (isEdit && loteToEdit) {
                await updateLote.mutateAsync({
                    id_lote: loteToEdit.ID_Lote,
                    id_producto: productId,
                    codigo_lote: codigoLote.trim(),
                    caducidad: caducidad.trim() ? caducidad : null,
                    stock_disponible: cant,
                    coste_unitario: cu != null && Number.isFinite(cu) ? cu : null,
                    fecha_entrada: loteToEdit.Fecha_Entrada || null,
                    id_proveedor: loteToEdit.ID_Proveedor ?? null,
                    notas: notas.trim() ? notas.trim() : null,
                });
            } else {
                await createLote.mutateAsync({
                    id_producto: productId,
                    codigo_lote: codigoLote.trim(),
                    caducidad: caducidad.trim() ? caducidad : null,
                    stock_disponible: cant,
                    coste_unitario: cu != null && Number.isFinite(cu) ? cu : null,
                    fecha_entrada: null,
                    id_proveedor: null,
                    notas: notas.trim() ? notas.trim() : null,
                });
            }

            toast.success("OK", isEdit ? "Lote actualizado" : "Lote creado");
            onSaved();
            reset();
            onClose();
        } catch (err) {
            console.error("Error guardando lote:", err);
            toast.error("Error", isEdit ? "No se pudo actualizar el lote" : "No se pudo crear el lote");
        } finally {
            setLoading(false);
        }
    }

    if (!open) return null;

    return (
        <Modal open={open} onClose={() => { if (!loading) { reset(); onClose(); } }} title={isEdit ? "Editar lote" : "Añadir lote"} maxWidthClass="max-w-[720px]">
            <form onSubmit={conAviso(guardar)} className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="md:col-span-2">
                    <label className="text-sm font-semibold text-fg">Código de lote *</label>
                    <input
                        value={codigoLote}
                        onChange={(e) => setCodigoLote(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
                        required
                    />
                </div>

                <div>
                    <label className="text-sm font-semibold text-fg">Caducidad</label>
                    <input
                        type="date"
                        value={caducidad}
                        onChange={(e) => setCaducidad(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
                    />
                </div>

                <div>
                    <label className="text-sm font-semibold text-fg">Cantidad *</label>
                    <input
                        type="number"
                        step="0.01"
                        value={cantidad}
                        onChange={(e) => setCantidad(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
                        required
                    />
                </div>

                <div>
                    <label className="text-sm font-semibold text-fg">Coste unitario</label>
                    <input
                        type="number"
                        step="0.01"
                        value={costeUnitario}
                        onChange={(e) => setCosteUnitario(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
                    />
                </div>

                <div className="md:col-span-2">
                    <label className="text-sm font-semibold text-fg">Notas</label>
                    <textarea
                        value={notas}
                        onChange={(e) => setNotas(e.target.value)}
                        className="mt-1 min-h-[90px] w-full resize-none rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
                    />
                </div>

                <button
                    type="submit"
                    disabled={loading || !ok}
                    className="mt-1 cursor-pointer rounded-xl bg-accent py-2 font-extrabold text-accent-fg shadow-sm transition hover:bg-accent-hover disabled:opacity-60 md:col-span-2"
                >
                    {loading ? "Guardando..." : isEdit ? "Guardar cambios" : "Crear lote"}
                </button>
            </form>
        </Modal>
    );
}
