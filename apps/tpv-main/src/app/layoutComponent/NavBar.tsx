import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Zap,
  LayoutGrid,
  Package,
  CalendarDays,
  Users,
  Truck,
  Contact,
  ListChecks,
  Wallet,
  BarChart3,
  Bell,
  Settings,
  LogOut,
  PanelLeft,
  PanelLeftClose,
  type LucideIcon,
} from "lucide-react";
import NavBarItem from "./NavBarItem";
import Logo from "../../assets/img/logo-morado-cuadrado.png";
import { useAuth } from "../../shared/stores/useAuth";
import { useNoLeidasCount } from "../../features/notificaciones/notificacionesQueries";
import { cn } from "../../shared/lib/cn";

type Props = {
  open?: boolean;
  onToggle?: () => void;
  onClose?: () => void;
};

type MenuItem = { pagina: string; nombre?: string; icon: LucideIcon };

// Catálogo de entradas del menú (icono lucide coherente por dominio).
const ITEMS = {
  ventaRapida: { pagina: "VentaRapida", nombre: "Venta Rápida", icon: Zap },
  mesas: { pagina: "Mesas", icon: LayoutGrid },
  comandas: { pagina: "Comandas", nombre: "Comandas", icon: LayoutGrid },
  inventario: { pagina: "Inventario", icon: Package },
  reservas: { pagina: "Reservas", icon: CalendarDays },
  trabajadores: { pagina: "Trabajadores", icon: Users },
  proveedores: { pagina: "Proveedores", nombre: "Proveedores y Pedidos", icon: Truck },
  clientes: { pagina: "Clientes", icon: Contact },
  tareas: { pagina: "Tareas", icon: ListChecks },
  cuentas: { pagina: "Cuentas", icon: Wallet },
  estadisticas: { pagina: "Estadisticas", icon: BarChart3 },
  notificaciones: { pagina: "Notificaciones", icon: Bell },
  configuracion: { pagina: "Configuracion", nombre: "Configuración", icon: Settings },
} satisfies Record<string, MenuItem>;

// Menú por rol (mismos accesos que la versión anterior).
const MENU_BY_ROLE: Record<string, { top: MenuItem[]; bottom: MenuItem[] }> = {
  Administrador: {
    top: [
      ITEMS.ventaRapida,
      ITEMS.mesas,
      ITEMS.inventario,
      ITEMS.reservas,
      ITEMS.trabajadores,
      ITEMS.proveedores,
      ITEMS.clientes,
      ITEMS.tareas,
      ITEMS.cuentas,
      ITEMS.estadisticas,
    ],
    bottom: [ITEMS.notificaciones, ITEMS.configuracion],
  },
  Camarero: {
    top: [
      ITEMS.ventaRapida,
      ITEMS.mesas,
      ITEMS.inventario,
      ITEMS.reservas,
      ITEMS.trabajadores,
      ITEMS.tareas,
    ],
    bottom: [ITEMS.notificaciones],
  },
  Limpieza: {
    top: [ITEMS.inventario, ITEMS.trabajadores, ITEMS.tareas],
    bottom: [ITEMS.notificaciones],
  },
  Cocinero: {
    top: [ITEMS.comandas, ITEMS.inventario, ITEMS.trabajadores, ITEMS.tareas],
    bottom: [ITEMS.notificaciones],
  },
};

function NavBar({ open: openProp, onToggle, onClose }: Props) {
  const { role, nombre, logout, idUsuario } = useAuth();
  const navigate = useNavigate();

  // Badge de la campana: nº de notificaciones no leídas del usuario logueado.
  const noLeidas = useNoLeidasCount(idUsuario).data ?? 0;

  // Soporta controlado por layout (responsive) o "uncontrolled".
  const [openLocal, setOpenLocal] = useState(false);
  const isControlled = typeof openProp === "boolean";
  const open = isControlled ? (openProp as boolean) : openLocal;

  const setOpen = (v: boolean) => {
    if (!isControlled) setOpenLocal(v);
  };

  const isLgUp = () =>
    typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches;

  // Al pasar de móvil -> desktop, dejamos el sidebar abierto.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = () => {
      if (mq.matches) {
        if (!open) {
          if (onToggle) onToggle();
          else setOpen(true);
        }
      }
    };

    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onToggle]);

  const actualizarApertura = () => {
    if (onToggle) onToggle();
    else setOpen(!open);
  };

  const closeIfMobile = () => {
    if (!isLgUp()) {
      if (onClose) onClose();
      else setOpen(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
    closeIfMobile();
  };

  const menu = MENU_BY_ROLE[role];
  if (!menu) return null;

  const initial = (nombre?.[0] ?? "?").toUpperCase();

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-full w-full flex-col border-r border-border bg-surface",
      )}
    >
      {/* Cabecera: logo + contraer/expandir */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-2">
        <img
          src={Logo}
          alt="logo"
          className={cn(
            "h-8 rounded-lg object-contain transition-[width,opacity,transform] duration-200 ease-out motion-reduce:transition-none",
            open ? "w-8 opacity-100 translate-x-0" : "w-0 opacity-0 -translate-x-2",
          )}
        />
        <button
          type="button"
          onClick={actualizarApertura}
          aria-label={open ? "Contraer menú" : "Expandir menú"}
          title={open ? "Contraer menú" : "Expandir menú"}
          className={cn(
            "grid size-9 place-items-center rounded-xl text-fg-muted transition hover:bg-surface-2 hover:text-fg cursor-pointer",
            open ? "" : "mx-auto",
          )}
        >
          {open ? (
            <PanelLeftClose className="size-5" aria-hidden />
          ) : (
            <PanelLeft className="size-5" aria-hidden />
          )}
        </button>
      </header>

      {/* Navegación principal */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {menu.top.map((item) => (
          <NavBarItem
            key={`${item.pagina}-${item.nombre ?? ""}`}
            pagina={item.pagina}
            nombre={item.nombre}
            svg={item.icon}
            abierto={open}
            onClick={closeIfMobile}
          />
        ))}
      </nav>

      {/* Pie: accesos secundarios + usuario + cerrar sesión */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border px-2 py-2">
        {menu.bottom.map((item) => (
          <NavBarItem
            key={`${item.pagina}-${item.nombre ?? ""}`}
            pagina={item.pagina}
            nombre={item.nombre}
            svg={item.icon}
            abierto={open}
            onClick={closeIfMobile}
            badge={item.pagina === "Notificaciones" ? noLeidas : undefined}
          />
        ))}

        {/* Usuario actual */}
        <div
          className={cn(
            "flex items-center rounded-xl px-2 py-2 transition-[gap] duration-300 ease-out motion-reduce:transition-none",
            open ? "gap-3" : "justify-center",
          )}
        >
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-bold text-accent">
            {initial}
          </div>
          <div
            className={cn(
              "min-w-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
              open
                ? "w-40 opacity-100 translate-x-0"
                : "w-0 opacity-0 -translate-x-2",
            )}
          >
            <p className="truncate text-sm font-semibold text-fg">
              {nombre || "Usuario"}
            </p>
            <p className="truncate text-xs text-fg-muted">{role}</p>
          </div>
        </div>

        {/* Cerrar sesión */}
        <button
          type="button"
          onClick={handleLogout}
          title={!open ? "Cerrar Sesión" : undefined}
          className={cn(
            "flex items-center rounded-xl text-fg-muted transition hover:bg-danger-soft hover:text-danger cursor-pointer",
            open ? "gap-3 px-3 py-2.5" : "justify-center p-2.5",
          )}
        >
          <LogOut className="size-5 shrink-0" aria-hidden />
          <span
            className={cn(
              "whitespace-nowrap text-sm transition-all duration-300",
              open ? "opacity-100" : "w-0 overflow-hidden opacity-0",
            )}
          >
            Cerrar Sesión
          </span>
        </button>
      </div>
    </aside>
  );
}

export default NavBar;
