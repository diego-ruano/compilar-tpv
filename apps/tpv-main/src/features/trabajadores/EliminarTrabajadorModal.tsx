// src/features/trabajadores/EliminarTrabajadorModal.tsx
//
// Confirmar que se elimina a un trabajador, diciendo antes qué va a pasar. El backend decide: sin
// historia lo borra; con historia (fichajes, cobros, comandas, tareas hechas…) lo retira, que es
// conservar todo eso a su nombre y quitarlo de todas partes. Ver `sql_quitar_trabajador` en
// `tpv-infra-sqlite/src/trabajadores.rs`.

import type { TrabajadorRow } from "@tpv/contracts";
import { toAppError } from "@tpv/client";
import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { useToast } from "../../shared/toast";
import { Button, ModalShell } from "../../shared/ui";
import { useEliminarTrabajador } from "./trabajadoresQueries";

type Props = {
    /** A quién se elimina; `null` con el modal cerrado. */
    trabajador: TrabajadorRow | null;
    onCerrar: () => void;
};

export default function EliminarTrabajadorModal({ trabajador, onCerrar }: Props) {
    const eliminar = useEliminarTrabajador();
    const toast = useToast();
    const [error, setError] = useState<string | null>(null);
    const ocupado = eliminar.isPending;

    const cerrar = () => {
        if (ocupado) return;
        setError(null);
        onCerrar();
    };

    const confirmar = async () => {
        if (!trabajador || ocupado) return;
        setError(null);
        try {
            const { retirado } = await eliminar.mutateAsync(trabajador.ID_Trabajador);
            if (retirado) {
                toast.success(
                    "Trabajador retirado",
                    `${trabajador.Nombre} tenía fichajes o cosas a su nombre: se conservan, pero ya no aparece ni puede entrar.`,
                );
            } else {
                toast.success("Trabajador eliminado", `${trabajador.Nombre} no tenía nada a su nombre y se ha borrado.`);
            }
            onCerrar();
        } catch (e) {
            // El modal sigue abierto con el motivo (el último administrador, uno mismo, ya no existe).
            setError(toAppError(e).message);
        }
    };

    const nombre = trabajador ? `${trabajador.Nombre}${trabajador.Apellido ? ` ${trabajador.Apellido}` : ""}` : "";

    return (
        <ModalShell open={trabajador !== null} onClose={cerrar}>
            <div className="absolute inset-0 bg-black/40" onClick={cerrar} />
            <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-danger-soft text-danger">
                            <TriangleAlert className="size-5" aria-hidden />
                        </div>
                        <h3 className="min-w-0 text-lg font-semibold text-fg">Eliminar a {nombre}</h3>
                    </div>
                    <button
                        type="button"
                        className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        onClick={cerrar}
                        title="Cancelar"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-fg-muted">
                    <li>
                        Deja de aparecer en la plantilla, en la pantalla de fichar y en los horarios y las
                        tareas, y no podrá entrar.
                    </li>
                    <li>Se quitan sus turnos de hoy en adelante, su horario predeterminado y sus tareas pendientes.</li>
                    <li>
                        Si ya ha fichado, cobrado, servido comandas o hecho tareas, todo eso se conserva a su
                        nombre: su registro de jornada y lo que firmó no se borran. Si no tiene nada, se borra
                        del todo.
                    </li>
                    <li className="font-medium text-fg">
                        No se puede deshacer. Si puede volver a trabajar aquí, mejor desactívalo desde «Editar».
                    </li>
                </ul>

                {error ? (
                    <div
                        className="mt-4 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger"
                        role="alert"
                    >
                        {error}
                    </div>
                ) : null}

                <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
                    <Button variant="secondary" onClick={cerrar} disabled={ocupado}>
                        Cancelar
                    </Button>
                    <Button variant="danger" loading={ocupado} onClick={() => void confirmar()}>
                        Eliminar
                    </Button>
                </div>
            </div>
        </ModalShell>
    );
}
