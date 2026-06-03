import React, { useMemo, useState } from "react";
import NavBar from "../../components/layoutComponent/NavBar";
import Account from "../../components/layoutComponent/Account";
import { getCurrentWindow } from "@tauri-apps/api/window";
import LogoAltaria from "../../assets/img/logo.png";
import CerrarVentana from "../../assets/svg/CerrarVentana.svg";
import MinimizarVentana from "../../assets/svg/MinimizarVentana.svg";
import PantallaCompleta from "../../assets/svg/PantallaCompleta.svg";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";

// ✅ Reutilizamos el icono que ya tienes
import { ReactComponent as MenuOpen } from "../../assets/svg/MenuOpen.svg";

function layout({ children }: { children: React.ReactNode }) {
  const ventana = getCurrentWindow();
  const { businessName, logoDataUrl } = useBusinessSettings();

  // ✅ Estado del sidebar controlado desde layout (para poder hacer overlay en móvil)
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ✅ Detectar si estamos en >= lg (Tailwind lg = 1024px)
  const isLgUp = useMemo(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  }, []);

  const toggleSidebar = () => setSidebarOpen((v) => !v);
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      {/* Barra superior */}
      <div className="w-full flex justify-between shrink-0">
        <div
          className="flex bg-white w-full p-1.5 items-center gap-3"
          data-tauri-drag-region
        >
          <img
            src={logoDataUrl ?? LogoAltaria}
            className="size-5 rounded-sm object-cover"
            data-tauri-drag-region
          />
          <p data-tauri-drag-region className="truncate max-w-60">
            {businessName || "TPV"}
          </p>
        </div>

        <div className="flex gap-4 w-fit p-1 px-2 bg-white">
          <button
            data-tauri-drag-region
            className="hover:scale-140 transition-all cursor-pointer"
            onClick={() => ventana.minimize()}
          >
            <img src={MinimizarVentana} className="size-8" />
          </button>
          <button
            data-tauri-drag-region
            className="hover:scale-140 transition-all cursor-pointer"
            onClick={() => ventana.toggleMaximize()}
          >
            <img src={PantallaCompleta} className="size-5" />
          </button>
          <button
            data-tauri-drag-region
            className="hover:scale-140 transition-all cursor-pointer"
            onClick={() => ventana.close()}
          >
            <img src={CerrarVentana} className="size-8" />
          </button>
        </div>
      </div>

      {/* Contenido */}
      <div className="relative flex flex-1 min-h-0">
        {/* ✅ Backdrop SOLO en móvil cuando el sidebar está abierto */}
        <div
          className={[
            "lg:hidden",
            sidebarOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
            "absolute inset-0 z-30 bg-black/40 transition-opacity",
          ].join(" ")}
          onClick={closeSidebar}
        />

        {/* Sidebar container */}
        <div
          className={[
            // Desktop: layout normal (push). Móvil: overlay absoluto
            "h-full shrink-0",
            "lg:relative lg:z-auto",
            "absolute left-0 top-0 bottom-0 z-40",
            // Móvil: slide in/out sin afectar al main
            "transition-transform duration-300",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            // En desktop NO usamos translate, y el ancho lo controla NavBar (w-12 / w-60)
            "lg:translate-x-0",
          ].join(" ")}
        >
          <NavBar
            open={sidebarOpen}
            onToggle={toggleSidebar}
            onClose={closeSidebar}
          />
          <Account rol="admin" />
        </div>

        {/* ✅ Botón flotante SOLO en móvil para abrir cuando está cerrado */}
        <button
          type="button"
          onClick={toggleSidebar}
          className={[
            "lg:hidden",
            sidebarOpen ? "hidden" : "flex",
            "absolute left-2 top-2 z-50",
            "h-10 w-10 items-center justify-center",
            "rounded-xl bg-white shadow",
          ].join(" ")}
          aria-label="Abrir menú"
        >
          <MenuOpen width={28} height={28} />
        </button>

        {/* Main scrolleable */}
        <main className="flex-1 bg-gris overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export default layout;
