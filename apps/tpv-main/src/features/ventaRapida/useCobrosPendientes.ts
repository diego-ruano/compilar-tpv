import { useCallback, useEffect, useRef, useState } from "react";
import { commands, toAppError } from "@tpv/client";
import { useMode } from "../../shared/stores/useMode";
import { importarCobrosLegados } from "./cobrosLegados";
import type { CobroPendienteDto } from "@tpv/contracts";

export function useCobrosPendientes() {
    const main = useMode(s => s.mode) === "tpv";
    const [pendientes, setPendientes] = useState<CobroPendienteDto[]>([]);
    const [error, setError] = useState<string | null>(null);
    const montado = useRef(true);
    const recargar = useCallback(async () => {
        if (!main) return;
        try {
            const datos = await commands.vrListarCobrosPendientes();
            if (montado.current) setPendientes(datos);
        } catch (e) { if (montado.current) setError(toAppError(e).message); }
    }, [main]);
    useEffect(() => {
        montado.current = true;
        if (main) void (async () => {
            try { await importarCobrosLegados(); }
            catch (e) { if (montado.current) setError(toAppError(e).message); }
            await recargar();
        })();
        return () => { montado.current = false; };
    }, [main, recargar]);
    return { pendientes, recargar, error, main };
}
