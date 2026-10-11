// src/app/layoutComponent/ControlesVentana.tsx
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconButton } from "../../shared/ui";
import { conAviso } from "../../shared/lib/conAviso";
import { esAndroid } from "../../shared/lib/plataforma";

/**
 * Minimizar, maximizar y cerrar: la ventana de escritorio no tiene marco (`decorations: false`), así
 * que los pone la app. En Android no hay ventana que mover y el teléfono ya tiene los suyos.
 */
function ControlesVentana() {
    if (esAndroid) return null;
    const ventana = getCurrentWindow();

    return (
        <>
            <IconButton size="sm" label="Minimizar" onClick={conAviso(() => ventana.minimize())}>
                <Minus className="size-4" aria-hidden />
            </IconButton>
            <IconButton size="sm" label="Maximizar" onClick={conAviso(() => ventana.toggleMaximize())}>
                <Square className="size-3.5" aria-hidden />
            </IconButton>
            <IconButton
                size="sm"
                label="Cerrar"
                onClick={conAviso(() => ventana.close())}
                className="hover:bg-danger-soft hover:text-danger"
            >
                <X className="size-4" aria-hidden />
            </IconButton>
        </>
    );
}

export default ControlesVentana;
