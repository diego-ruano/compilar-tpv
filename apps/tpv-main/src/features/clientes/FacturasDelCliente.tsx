// src/features/clientes/FacturasDelCliente.tsx
//
// La sección «Facturas» de la ficha del cliente: sus facturas completas (las de su NIF), de la más
// reciente a la más antigua, con su PDF y su reimpresión. Sólo en la Main: la Handy no tiene los
// registros de facturación ni los PDF.
//
// El PDF es el que se compuso al emitirla (docs/arquitectura/tickets.md § El PDF de una factura
// completa): el del equipo; si no está, el de la nube; y si la nube no lo tiene, se compone en ese
// momento. La app no tiene con qué abrir un fichero con el visor del sistema, así que se guarda
// donde diga el diálogo, como el PDF de Cuentas.

import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { commands, toAppError } from "@tpv/client";
import { FileDown, FileText, Printer } from "lucide-react";

import { useToast } from "../../shared/toast";
import { useMode } from "../../shared/stores/useMode";
import { conAviso } from "../../shared/lib/conAviso";
import { eur } from "../../shared/lib/dinero";
import { cn } from "../../shared/lib/cn";
import PrintTicketModal, { type CobroImprimible } from "../../shared/ticket/PrintTicketModal";
import { useFacturasDelCliente } from "./clientesQueries";
import {
    etiquetaClase,
    fechaDeLaFactura,
    nombreDelPdf,
    reimpresionDe,
    type FacturaDelCliente,
} from "./facturasDeLaFicha";

const BOTON =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-fg transition hover:bg-surface-2 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50";

export default function FacturasDelCliente({ idCliente }: { idCliente: string }) {
    const esMain = useMode((st) => st.mode) === "tpv";
    const toast = useToast();
    const facturas = useFacturasDelCliente(idCliente, esMain);
    const [reimpresion, setReimpresion] = useState<CobroImprimible | null>(null);
    const [guardandoPdf, setGuardandoPdf] = useState<string | null>(null);

    // Una carga que falla se avisa, con el motivo.
    useEffect(() => {
        if (facturas.isError) {
            toast.error("No se pudieron cargar las facturas del cliente", toAppError(facturas.error).message);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [facturas.isError]);

    if (!esMain) return null;
    // Hasta que llegan no se enseña nada en su lugar.
    const datos = facturas.data;
    if (!datos) return null;

    const guardarPdf = async (f: FacturaDelCliente) => {
        const ruta = await save({
            title: `Guardar la factura ${f.num_serie} en PDF`,
            defaultPath: nombreDelPdf(f),
            filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (!ruta) return;
        setGuardandoPdf(f.id_registro);
        try {
            const bytes = await commands.clientesFacturaPdf({ id_registro: f.id_registro });
            await writeFile(ruta, new Uint8Array(bytes));
            toast.success("Factura guardada", ruta);
        } catch (e) {
            toast.error("No se pudo guardar el PDF de la factura", toAppError(e).message);
        } finally {
            setGuardandoPdf(null);
        }
    };

    return (
        <div className="mt-3 rounded-xl border border-border bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-fg-muted">
                <FileText className="size-4" aria-hidden />
                <span className="text-xs font-medium">Facturas</span>
            </div>

            {!datos.nif ? (
                <p className="mt-1 text-sm text-fg-muted">
                    Añade su NIF con «Editar» y aquí saldrán las facturas que se le han hecho.
                </p>
            ) : datos.facturas.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">
                    No hay facturas a nombre de <b className="text-fg">{datos.nif}</b>.
                </p>
            ) : (
                <ul className="mt-2 flex flex-col divide-y divide-border">
                    {datos.facturas.map((f) => {
                        const cobro = reimpresionDe(f);
                        const guardando = guardandoPdf === f.id_registro;
                        return (
                            <li
                                key={f.id_registro}
                                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
                            >
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold text-fg">{f.num_serie}</p>
                                    <p className="text-xs text-fg-muted">
                                        {fechaDeLaFactura(f.fecha_expedicion)} · {etiquetaClase(f.clase)}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span
                                        className={cn(
                                            "text-sm font-bold tabular-nums",
                                            f.importe < 0 ? "text-danger" : "text-fg",
                                        )}
                                    >
                                        {eur(f.importe)}
                                    </span>
                                    <button
                                        type="button"
                                        className={BOTON}
                                        disabled={guardando}
                                        title="Guardar el PDF de esta factura"
                                        onClick={conAviso(() => guardarPdf(f), "No se pudo guardar el PDF de la factura")}
                                    >
                                        <FileDown className="size-3.5" aria-hidden />
                                        {guardando ? "Guardando…" : "PDF"}
                                    </button>
                                    <button
                                        type="button"
                                        className={BOTON}
                                        disabled={!cobro}
                                        title={
                                            cobro
                                                ? "Imprimir una copia en la impresora de tickets"
                                                : "Su cobro todavía no está en este equipo"
                                        }
                                        onClick={() => setReimpresion(cobro)}
                                    >
                                        <Printer className="size-3.5" aria-hidden />
                                        Reimprimir
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {datos.hay_mas ? (
                <p className="mt-2 text-xs text-fg-muted">
                    Se ven las {datos.facturas.length} más recientes.
                </p>
            ) : null}

            <PrintTicketModal
                open={reimpresion !== null}
                onClose={() => setReimpresion(null)}
                titulo="Reimprimir factura"
                items={[]}
                cobro={reimpresion}
            />
        </div>
    );
}
