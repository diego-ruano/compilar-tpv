// src/app/layoutComponent/ControlesZoom.tsx
import { Minus, Plus, Search } from "lucide-react";
import { IconButton } from "../../shared/ui";
import { conAviso } from "../../shared/lib/conAviso";
import { esMovil } from "../../shared/lib/plataforma";
import { useZoomVentana } from "../../shared/stores/useZoomVentana";

/**
 * Tamaño de la interfaz: `−` y `+` lo fijan en este equipo, y la lupa lo devuelve al automático
 * (el que sale del monitor). Los límites los sabe `zoom.rs`. En el móvil no hay ventana que escalar.
 */
function ControlesZoom() {
    const zoom = useZoomVentana((s) => s.zoom);
    const cambiar = useZoomVentana((s) => s.cambiar);
    if (esMovil) return null;

    const porcentaje = zoom ? `${zoom.porcentaje} %` : "…";
    const lupa = zoom?.automatico
        ? `Tamaño de la pantalla: ${porcentaje} (automático)`
        : `Tamaño de la pantalla: ${porcentaje}. Pulsa para volver al automático`;

    return (
        <div className="flex items-center">
            <IconButton
                size="sm"
                label="Reducir"
                disabled={!zoom?.puede_alejar}
                onClick={conAviso(() => cambiar("alejar"), "No se pudo cambiar el tamaño")}
            >
                <Minus className="size-4" aria-hidden />
            </IconButton>
            {/* Nunca deshabilitada: un botón deshabilitado no enseña su texto al pasar por encima,
                y es lo que dice el porcentaje. En automático, pulsarla no cambia nada. */}
            <IconButton
                size="sm"
                label={lupa}
                onClick={conAviso(() => cambiar("automatico"), "No se pudo cambiar el tamaño")}
            >
                <Search className="size-4" aria-hidden />
            </IconButton>
            <IconButton
                size="sm"
                label="Ampliar"
                disabled={!zoom?.puede_acercar}
                onClick={conAviso(() => cambiar("acercar"), "No se pudo cambiar el tamaño")}
            >
                <Plus className="size-4" aria-hidden />
            </IconButton>
        </div>
    );
}

export default ControlesZoom;
