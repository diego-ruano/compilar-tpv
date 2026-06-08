import React, { useState } from "react";
import { Menu } from "lucide-react";
import NavBar from "../layoutComponent/NavBar";
import Titlebar from "../layoutComponent/Titlebar";

function layout({ children }: { children: React.ReactNode }) {
  // Estado del sidebar controlado desde layout (para overlay en móvil).
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const toggleSidebar = () => setSidebarOpen((v) => !v);
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      {/* Barra superior reutilizable */}
      <Titlebar />

      {/* Contenido */}
      <div className="relative flex min-h-0 flex-1">
        {/* Backdrop SOLO en móvil cuando el sidebar está abierto */}
        <div
          className={[
            "lg:hidden",
            sidebarOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
            "absolute inset-0 z-30 bg-black/50 transition-opacity",
          ].join(" ")}
          onClick={closeSidebar}
        />

        {/* Contenedor del sidebar */}
        <div
          className={[
            "h-full shrink-0",
            "lg:relative lg:z-auto",
            "absolute left-0 top-0 bottom-0 z-40",
            "transition-transform duration-300",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "lg:translate-x-0",
          ].join(" ")}
        >
          <NavBar
            open={sidebarOpen}
            onToggle={toggleSidebar}
            onClose={closeSidebar}
          />
        </div>

        {/* Botón flotante SOLO en móvil para abrir cuando está cerrado */}
        <button
          type="button"
          onClick={toggleSidebar}
          className={[
            "lg:hidden",
            sidebarOpen ? "hidden" : "flex",
            "absolute left-3 top-3 z-50",
            "h-10 w-10 items-center justify-center",
            "rounded-xl border border-border bg-surface text-fg shadow-md",
            "transition active:scale-95",
          ].join(" ")}
          aria-label="Abrir menú"
        >
          <Menu className="size-5" aria-hidden />
        </button>

        {/* Main scrolleable */}
        <main className="flex-1 overflow-y-auto bg-bg">{children}</main>
      </div>
    </div>
  );
}

export default layout;
