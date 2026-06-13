import React, { useMemo, useState } from "react";
import Modal from "../ui/Modal";
import { useToast } from "../../../shared/toast";
import { useCreateLote } from "../inventarioQueries";

type Props = {
    open: boolean;
    onClose: () => void;
    productId: string | null;
    onSaved: () => void;
};

function toNum(v: string) {
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
}

export default function AddLoteModal({ open, onClose, productId, onSaved }: Props) {
    const toast = useToast();

    const createLote = useCreateLote();

    const [codigoLote, setCodigoLote] = useState("");
    const [caducidad, setCaducidad] = useState("");
    const [cantidadInicial, setCantidadInicial] = useState("");
    const [stockDisponible, setStockDisponible] = useState("");
    const [costeUnitario, setCosteUnitario] = useState("");
    const [notas, setNotas] = useState("");

    const [loading, setLoading] = useState(false);

    const ok = useMemo(() => {
        if (!productId) return false;
        if (!codigoLote.trim()) return false;

        const ci = toNum(cantidadInicial);
        if (!Number.isFinite(ci) || ci < 0) return false;

        const sd = stockDisponible.trim() ? toNum(stockDisponible) : ci;
        if (!Number.isFinite(sd) || sd < 0) return false;

        const cu = costeUnitario.trim() ? toNum(costeUnitario) : NaN;
        if (costeUnitario.trim() && (!Number.isFinite(cu) || cu < 0)) return false;

        return true;
    }, [productId, codigoLote, cantidadInicial, stockDisponible, costeUnitario]);

    const reset = () => {
        setCodigoLote("");
        setCaducidad("");
        setCantidadInicial("");
        setStockDisponible("");
        setCosteUnitario("");
        setNotas("");
        setLoading(false);
    };

    async function guardar(e: React.FormEvent) {
        e.preventDefault();
        if (!productId) return;

        if (!ok) {
            toast.info("Validación", "Revisa código de lote y cantidades.");
            return;
        }

        setLoading(true);
        try {
            const ci = toNum(cantidadInicial);
            const sd = stockDisponible.trim() ? toNum(stockDisponible) : ci;
            const cu = costeUnitario.trim() ? toNum(costeUnitario) : null;

            await createLote.mutateAsync({
                id_producto: productId,
                codigo_lote: codigoLote.trim(),
                caducidad: caducidad.trim() ? caducidad : null,
                cantidad_inicial: ci,
                stock_disponible: Number.isFinite(sd) ? sd : null,
                coste_unitario: cu != null && Number.isFinite(cu) ? cu : null,
                fecha_entrada: null,
                id_proveedor: null,
                notas: notas.trim() ? notas.trim() : null,
            });

            toast.success("OK", "Lote creado");
            onSaved();
            reset();
            onClose();
        } catch (err) {
            console.error("Error creando lote:", err);
            toast.error("Error", "No se pudo crear el lote");
        } finally {
            setLoading(false);
        }
    }

    if (!open) return null;

    return (
        <Modal open={open} onClose={() => { if (!loading) { reset(); onClose(); } }} title="Añadir lote" maxWidthClass="max-w-[720px]">
            <form onSubmit={guardar} className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                    <label className="text-sm font-semibold text-fg">Cantidad inicial *</label>
                    <input
                        type="number"
                        step="0.01"
                        value={cantidadInicial}
                        onChange={(e) => setCantidadInicial(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
                        required
                    />
                </div>

                <div>
                    <label className="text-sm font-semibold text-fg">Stock disponible</label>
                    <input
                        type="number"
                        step="0.01"
                        value={stockDisponible}
                        onChange={(e) => setStockDisponible(e.target.value)}
                        placeholder="Si vacío = cantidad inicial"
                        className="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={loading}
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
                    {loading ? "Guardando..." : "Crear lote"}
                </button>
            </form>
        </Modal>
    );
}
