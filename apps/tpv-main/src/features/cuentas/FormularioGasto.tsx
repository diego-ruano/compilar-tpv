import { toAppError } from "@tpv/client";
import type { CambioCajaInput, CreateGastoInput, ProveedorMiniDto, SalidaDto } from "@tpv/contracts";
import { useReducer, useRef, useState } from "react";
import { CampoDinero, useImporte } from "../../shared/ui/CampoDinero";
import { ModalShell } from "../../shared/ui/ModalShell";
import { useCreateGasto, useUpdateGasto } from "./cuentasQueries";

type Campos = Omit<CreateGastoInput, "importe" | "id_gasto">;
type Cambio = { [K in keyof Campos]-?: { campo: K; valor: Campos[K] } }[keyof Campos];
function reducir(campos: Campos, cambio: Cambio): Campos {
    const siguiente = { ...campos, [cambio.campo]: cambio.valor };
    if (cambio.campo === "tipo_gasto" && cambio.valor !== "Proveedor") siguiente.proveedor_id = null;
    return siguiente;
}

/** Estado del formulario aislado de las tablas; crear y editar comparten la misma validación. */
export default function FormularioGasto({ gasto, fechaInicial, proveedores, errorProveedores, onCerrar, onGuardado, conAvisoDeCierre, soloLectura = false }: {
    gasto: SalidaDto | null; fechaInicial: string; proveedores: ProveedorMiniDto[]; errorProveedores: string | null;
    /** En la Handy: se mira, no se guarda (la caja se toca en el TPV principal). */
    soloLectura?: boolean;
    onCerrar: () => void; onGuardado: () => void;
    conAvisoDeCierre: (cambio: CambioCajaInput, hacer: (motivo: string | null) => Promise<void>) => Promise<void>;
}) {
    const crear = useCreateGasto();
    const editar = useUpdateGasto();
    const [campos, dispatch] = useReducer(reducir, {
        fecha: gasto?.fecha_hora ?? fechaInicial, tipo_gasto: gasto?.tipo_gasto || "Suministros",
        concepto: gasto?.concepto ?? "", proveedor_id: gasto?.proveedor_id ?? null, pagado_con_caja: gasto?.pagado_con_caja ?? false,
    });
    const importe = useImporte(gasto?.importe ?? null);
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const guardia = useRef(false);
    const cerrar = () => { if (!guardia.current) onCerrar(); };
    const guardar = async () => {
        if (guardia.current) return;
        if (!campos.fecha.trim() || !campos.concepto.trim() || !campos.tipo_gasto) { setError("Completa fecha, tipo y concepto."); return; }
        if (!importe.legible || importe.valor == null || importe.valor <= 0) { setError("Introduce un importe válido mayor que cero."); return; }
        const args: CreateGastoInput = { ...campos, fecha: campos.fecha.trim(), concepto: campos.concepto.trim(), importe: importe.valor };
        if (args.tipo_gasto === "Proveedor" && !args.proveedor_id) { setError("Selecciona un proveedor."); return; }
        guardia.current = true; setGuardando(true); setError(null);
        try {
            const cambio: CambioCajaInput = gasto
                ? { tipo: "editar_gasto", id_gasto: gasto.id, fecha: args.fecha, importe: args.importe, pagado_con_caja: args.pagado_con_caja ?? false }
                : { tipo: "crear_gasto", fecha: args.fecha, importe: args.importe, pagado_con_caja: args.pagado_con_caja ?? false };
            await conAvisoDeCierre(cambio, async motivoRectificacion => {
                const ok = gasto ? await editar.mutateAsync({ args: { ...args, id_gasto: gasto.id }, motivoRectificacion })
                    : await crear.mutateAsync({ args, motivoRectificacion });
                if (!ok) throw new Error("No se pudo guardar el gasto.");
                onGuardado(); onCerrar();
            });
        } catch (e) { setError(toAppError(e).message); }
        finally { guardia.current = false; setGuardando(false); }
    };
    const clase = "mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg";
    return <ModalShell open onClose={cerrar}>
        <div className="absolute inset-0 bg-black/40" onClick={cerrar} />
        <section className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-fg">{soloLectura ? "Gasto" : gasto ? "Editar gasto" : "Añadir gasto"}</h3>
            {soloLectura && <p className="mt-1 text-sm text-fg-muted">Los gastos se apuntan y se corrigen en el TPV principal.</p>}
            <fieldset disabled={guardando || soloLectura} className="mt-5 grid gap-3">
                <label className="text-xs font-semibold text-fg-muted">Fecha<input className={clase} type="date" value={campos.fecha} onChange={e => dispatch({ campo: "fecha", valor: e.target.value })} /></label>
                <label className="text-xs font-semibold text-fg-muted">Tipo<select className={clase} value={campos.tipo_gasto} onChange={e => dispatch({ campo: "tipo_gasto", valor: e.target.value })}>
                    {["Suministros", "Luz", "Agua", "Alquiler", "Nomina", "Proveedor", "Mantenimiento", "Otros"].map(t => <option key={t}>{t}</option>)}
                </select></label>
                {campos.tipo_gasto === "Proveedor" && <label className="text-xs font-semibold text-fg-muted">Proveedor<select className={clase} value={campos.proveedor_id ?? ""} onChange={e => dispatch({ campo: "proveedor_id", valor: e.target.value || null })}>
                    <option value="">Selecciona proveedor</option>{proveedores.map(p => <option key={p.ID_Proveedor} value={p.ID_Proveedor}>{p.Nombre_Empresa}</option>)}
                </select>{errorProveedores && <p className="text-danger">{errorProveedores}</p>}</label>}
                <label className="text-xs font-semibold text-fg-muted">Concepto<input className={clase} value={campos.concepto} onChange={e => dispatch({ campo: "concepto", valor: e.target.value })} /></label>
                <label className="text-xs font-semibold text-fg-muted">Importe (EUR)<CampoDinero className={clase} {...importe.campo} /></label>
                <label className="text-sm text-fg"><input type="checkbox" checked={campos.pagado_con_caja ?? false} onChange={e => dispatch({ campo: "pagado_con_caja", valor: e.target.checked })} /> Pagado con dinero del cajón
                    <span className="block text-xs text-fg-muted">Resta de lo que debería haber en el cierre. Déjalo sin marcar si se pagó por banco o tarjeta.</span>
                </label>
            </fieldset>
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">{soloLectura ? <button onClick={cerrar}>Cerrar</button> : <><button disabled={guardando} onClick={cerrar}>Cancelar</button><button disabled={guardando} onClick={() => void guardar()} className="rounded-xl bg-accent px-4 py-2 font-semibold text-white">{guardando ? "Guardando…" : gasto ? "Guardar cambios" : "Guardar gasto"}</button></>}</div>
        </section>
    </ModalShell>;
}
