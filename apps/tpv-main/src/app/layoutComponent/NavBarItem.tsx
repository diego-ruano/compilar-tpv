import { Link, To, useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../shared/lib/cn";

function NavBarItem({
  pagina,
  nombre,
  svg: SvgIcon,
  abierto,
  onClick,
}: {
  pagina: string;
  nombre?: string;
  svg: LucideIcon;
  abierto: boolean;
  onClick?: () => void;
}) {
  const ruta: To = "../" + pagina;
  const label = nombre || pagina;

  const location = useLocation();
  const path = location.pathname.toLowerCase();
  const target = ("/" + pagina).toLowerCase();
  // VentaRapida es también la ruta índice ("/").
  const active = path === target || (pagina === "VentaRapida" && path === "/");

  return (
    <Link
      to={ruta}
      title={!abierto ? label : undefined}
      onClick={() => {
        onClick?.();
      }}
      className={cn(
        "group relative flex items-center rounded-xl transition",
        abierto ? "gap-3 px-3 py-2.5" : "justify-center p-2.5",
        active
          ? "bg-accent-soft text-accent font-semibold"
          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {/* Indicador de activo (barra lateral) */}
      <span
        className={cn(
          "absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-accent transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
      />

      <SvgIcon className="size-5 shrink-0" strokeWidth={active ? 2.4 : 2} />

      <span
        className={cn(
          "whitespace-nowrap text-sm transition-all duration-300 ease-in-out",
          abierto
            ? "opacity-100 translate-x-0 delay-150"
            : "w-0 overflow-hidden opacity-0 -translate-x-2",
        )}
      >
        {label}
      </span>
    </Link>
  );
}

export default NavBarItem;
