// src/features/mesas/editor/useMesasWeb.ts
//
// La configuración de reservas desde la web de las mesas del plano (docs/estudios/reservas-web.md),
// para el editor, y qué formulario de mesa está abierto. Distingue «todavía no la tengo» y «no la
// he podido leer» de «esa mesa no tiene»: abrir el formulario de una mesa sin haber leído la suya
// enseñaría la mesa apagada, y guardarlo borraría la configuración que sí tenía. Por eso `abrir`
// sólo abre con `estado === "listo"`, también si el modo del editor ya estaba armado cuando se
// volvió a leer (al guardar el plano).
import { useCallback, useEffect, useRef, useState } from "react";
import { commands, toAppError } from "@tpv/client";
import type { ReservaWebMesaDto } from "@tpv/contracts";
import type { Table } from "./geometria";
import { parseMesaId } from "../ParseMesaId";

export type EstadoMesasWeb = "cargando" | "listo" | "error";

export function useMesasWeb(activo: boolean) {
    const [estado, setEstado] = useState<EstadoMesasWeb>("cargando");
    const [mesas, setMesas] = useState<Record<string, ReservaWebMesaDto>>({});
    const [error, setError] = useState("");
    const [abierta, setAbierta] = useState<Table | null>(null);
    // Una respuesta vieja no pisa a una más reciente: sólo cuenta la última lectura pedida.
    const ultima = useRef(0);
    // `abrir` mira el estado de AHORA, no el del render en que se creó el manejador. `recargar` lo
    // pone a «cargando» en el acto, sin esperar al render.
    const estadoActual = useRef<EstadoMesasWeb>("cargando");
    useEffect(() => {
        estadoActual.current = estado;
    }, [estado]);

    // Captura su propio error y lo deja en `estado`: se puede lanzar con `void`.
    const recargar = useCallback(async () => {
        if (!activo) return;
        const esta = ++ultima.current;
        estadoActual.current = "cargando";
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

    /** Abre el formulario de una mesa, sólo con la configuración leída. Devuelve si lo ha abierto. */
    const abrir = useCallback((mesa: Table): boolean => {
        if (estadoActual.current !== "listo") return false;
        setAbierta(mesa);
        return true;
    }, []);

    const cerrar = useCallback(() => setAbierta(null), []);

    /**
     * Lo que acaba de guardar el formulario, sin volver a leer. Cierra el formulario sólo si sigue
     * abierto el de ESA mesa: si mientras se guardaba se abrió otra, no se le cierra.
     */
    const guardada = useCallback((mesa: ReservaWebMesaDto) => {
        setMesas((prev) => ({ ...prev, [mesa.id_mesa]: mesa }));
        setAbierta((actual) => (actual && parseMesaId(actual.id) === mesa.id_mesa ? null : actual));
    }, []);

    return { estado, mesas, error, recargar, abierta, abrir, cerrar, guardada };
}
