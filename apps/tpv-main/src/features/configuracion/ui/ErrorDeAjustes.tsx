// src/features/configuracion/ui/ErrorDeAjustes.tsx
//
// CFG-INC-02: unos ajustes que no se han podido leer. Se dice qué y por qué, con «Reintentar», en vez
// de enseñar los valores por defecto como si fueran los guardados.
import { conAviso } from "../../../shared/lib/conAviso";
import { GhostButton } from "./Buttons";

export function ErrorDeAjustes({
    titulo,
    motivo,
    detalle,
    onReintentar,
}: {
    /** Qué no se ha podido leer: «No se han podido leer los datos del negocio». */
    titulo: string;
    motivo: string;
    /** Qué pasa mientras tanto, si hace falta decirlo. */
    detalle?: string;
    onReintentar: () => Promise<void>;
}) {
    return (
        <div
            role="alert"
            className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger sm:flex-row sm:items-center sm:justify-between"
        >
            <div className="min-w-0">
                <p className="font-semibold">{titulo}</p>
                <p className="mt-0.5 break-words">{motivo}</p>
                {detalle ? <p className="mt-0.5 text-xs">{detalle}</p> : null}
            </div>
            <GhostButton onClick={conAviso(onReintentar)}>Reintentar</GhostButton>
        </div>
    );
}
