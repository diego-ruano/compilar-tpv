// src/features/mesas/editor/useMesasWeb.ts
//
// La configuración de reservas desde la web de las mesas del plano (docs/estudios/reservas-web.md),
// para el editor. Distingue «todavía no la tengo» y «no la he podido leer» de «esa mesa no tiene»:
// abrir el formulario de una mesa sin haber leído la suya enseñaría la mesa apagada, y guardarlo
// borraría la configuración que sí tenía. Por eso el editor sólo deja abrirlo con `estado === "listo"`.
import { useCallback, useEffect, useRef, useState } from "react";
import { commands, toAppError } from "@tpv/client";
import type { ReservaWebMesaDto } from "@tpv/contracts";

export type EstadoMesasWeb = "cargando" | "listo" | "error";

export function useMesasWeb(activo: boolean) {
    const [estado, setEstado] = useState<EstadoMesasWeb>("cargando");
    const [mesas, setMesas] = useState<Record<string, ReservaWebMesaDto>>({});
    const [error, setError] = useState("");
    // Una respuesta vieja no pisa a una más reciente: sólo cuenta la última lectura pedida.
    const ultima = useRef(0);

    // Captura su propio error y lo deja en `estado`: se puede lanzar con `void`.
    const recargar = useCallback(async () => {
        if (!activo) return;
        const esta = ++ultima.current;
        setEstado("cargando");
        try {
            const lista = await commands.reservaWebMesas();
            if (esta !== ultima.current) return;
            setMesas(Object.fromEntries(lista.map((m) => [m.id_mesa, m])));
            setEstado("listo");
        } catch (e) {
            if (esta !== ultima.current) return;
            setError(toAppError(e).message);
            setEstado("error");
        }
    }, [activo]);

    useEffect(() => {
        void recargar();
    }, [recargar]);

    /** Lo que acaba de guardar el formulario, sin volver a leer. */
    const guardada = useCallback((mesa: ReservaWebMesaDto) => {
        setMesas((prev) => ({ ...prev, [mesa.id_mesa]: mesa }));
    }, []);

    return { estado, mesas, error, recargar, guardada };
}
