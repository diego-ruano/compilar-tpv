// src/app/layoutComponent/Titlebar.tsx
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import LogoAltaria from "../../assets/img/logo-altaria-azul-transparente.png";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useImageUrl } from "../../shared/lib/useImageUrl";
import { IconButton, ThemeToggle } from "../../shared/ui";
import { conAviso } from "../../shared/lib/conAviso";

/**
 * Barra de título reutilizable: zona de arrastre (logo + nombre del negocio),
 * toggle de tema y controles de ventana de Tauri.
 */
function Titlebar() {
    const ventana = getCurrentWindow();
    const { businessName, logoDataUrl } = useBusinessSettings();
    // `logoDataUrl` es una ruta relativa (el nombre es herencia de cuando sí era un data URL):
    // hay que resolverla, no meterla tal cual en el `src`.
    const logoSrc = useImageUrl(logoDataUrl);

    return (
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface">
            <div
                className="flex w-full items-center gap-2 p-1.5 sm:gap-3"
                data-tauri-drag-region
            >
                <img
                    src={logoSrc || LogoAltaria}
                    className="size-6 rounded-md object-cover"
                    data-tauri-drag-region
                    alt="logo"
                />
                <p
                    data-tauri-drag-region
                    className="max-w-[45vw] truncate text-sm font-semibold text-fg sm:max-w-60"
                >
                    {businessName || "TPV"}
                </p>
            </div>

            <div className="flex w-fit items-center gap-1 p-1 px-1.5">
                <ThemeToggle size="sm" />
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
            </div>
        </div>
    );
}

export default Titlebar;
