// src/app/layoutComponent/Titlebar.tsx
import LogoAltaria from "../../assets/img/logo-altaria-azul-transparente.png";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useImageUrl } from "../../shared/lib/useImageUrl";
import { cn } from "../../shared/lib/cn";
import { ThemeToggle } from "../../shared/ui";
import ControlesVentana from "./ControlesVentana";
import ControlesZoom from "./ControlesZoom";

/**
 * Barra de título reutilizable: zona de arrastre (logo + nombre del negocio), tamaño de la
 * interfaz, toggle de tema y controles de ventana de Tauri (que en el móvil no salen).
 *
 * Es la única: también la del login, que la pone encima de su fondo con `className`. Una copia
 * aparte se queda sin lo que se añada aquí, como le pasó con el tamaño de la interfaz.
 */
function Titlebar({ className }: { className?: string }) {
    const { business_name, logo_data_url } = useBusinessSettings();
    // `logo_data_url` es una ruta relativa (el nombre es herencia de cuando sí era un data URL):
    // hay que resolverla, no meterla tal cual en el `src`.
    const logoSrc = useImageUrl(logo_data_url);

    return (
        <div className={cn("flex shrink-0 items-center justify-between border-b border-border bg-surface", className)}>
            {/* `min-w-0`: con la ventana estrecha encoge el nombre, no empuja los botones fuera. */}
            <div
                className="flex min-w-0 flex-1 items-center gap-2 p-1.5 sm:gap-3"
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
                    className="min-w-0 max-w-[35vw] truncate text-sm font-semibold text-fg sm:max-w-60"
                >
                    {business_name || "TPV"}
                </p>
            </div>

            <div className="flex w-fit items-center gap-1 p-1 px-1.5">
                <ControlesZoom />
                <ThemeToggle size="sm" />
                <ControlesVentana />
            </div>
        </div>
    );
}

export default Titlebar;
