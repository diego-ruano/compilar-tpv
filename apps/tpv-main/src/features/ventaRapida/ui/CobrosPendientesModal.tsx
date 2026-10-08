import { useRef, useState } from "react";
import type { CobroPendienteDto } from "@tpv/contracts";
import { toAppError } from "@tpv/client";
import { ModalShell } from "../../../shared/ui/ModalShell";
import { eur } from "../../../shared/lib/dinero";

export default function CobrosPendientesModal({ open, onClose, pendientes, ocupado, onResolver, onCancelar, onEditarFactura }: {
    open: boolean; onClose: () => void; pendientes: CobroPendienteDto[]; ocupado: boolean;
    onResolver: (p: CobroPendienteDto) => Promise<void>; onCancelar: (p: CobroPendienteDto) => Promise<void>;
    onEditarFactura: (p: CobroPendienteDto) => void;
}) {
    const [descartar, setDescartar] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [actuando, setActuando] = useState(false);
    const guardia = useRef(false);
    const ejecutar = async (accion: () => Promise<void>) => {
        if (guardia.current || ocupado) return;
        guardia.current = true; setActuando(true); setError(null);
        try { await accion(); setDescartar(null); }
        catch (e) { setError(toAppError(e).message); }
        finally { guardia.current = false; setActuando(false); }
    };
    return <ModalShell open={open} onClose={() => { if (!guardia.current && !ocupado) onClose(); }}>
        <div className="absolute inset-0 bg-black/50" />
        <section className="relative max-h-[85vh] w-full max-w-xl overflow-auto rounded-2xl bg-surface p-5 text-fg">
            <h2 className="text-lg font-bold">Cobros pendientes</h2>
            <p className="my-2 text-sm text-fg-muted">Revisa el cobro antes de reintentarlo. Si ya se guardó, se recupera el mismo pago.</p>
            {error && <p role="alert" className="text-danger">{error}</p>}
            {!pendientes.length && <p>No hay cobros pendientes.</p>}
            {pendientes.map(p => <div key={p.cobro.id_pago} className="my-3 rounded-xl border border-border p-3">
                <p className="font-semibold">{eur(p.cobro.importe_total)} · {p.cobro.metodo}</p>
                <p className="text-sm text-fg-muted">{new Date(p.creado_en_ms).toLocaleString("es-ES")} · {p.cobro.detalles.length} líneas</p>
                {p.ultimo_error && <p className="my-1 text-sm text-danger">{p.ultimo_error}</p>}
                {descartar === p.cobro.id_pago ? <>
                    <p className="my-2 text-sm">¿Descartar esta preparación? No anula ningún pago guardado; las líneas mantienen su estado real.</p>
                    <button disabled={ocupado || actuando} onClick={() => void ejecutar(() => onCancelar(p))} className="mr-3 text-danger">Sí, descartar preparación</button>
                    <button disabled={ocupado || actuando} onClick={() => setDescartar(null)}>Volver</button>
                </> : <div className="mt-2 flex gap-4">
                    <button disabled={ocupado || actuando} onClick={() => void ejecutar(() => onResolver(p))} className="text-accent">Resolver cobro</button>
                    <button disabled={ocupado || actuando} onClick={() => onEditarFactura(p)}>Datos de factura</button>
                    <button disabled={ocupado || actuando} onClick={() => setDescartar(p.cobro.id_pago)}>Descartar preparación</button>
                </div>}
            </div>)}
            <button disabled={ocupado || actuando} onClick={onClose} className="mt-3 rounded-xl border border-border px-4 py-2">Cerrar</button>
        </section>
    </ModalShell>;
}
