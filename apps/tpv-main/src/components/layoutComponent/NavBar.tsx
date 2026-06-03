import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import NavBarItem from "./NavBarItem";
import { ReactComponent as MesaSVG } from "../../assets/svg/MesaSVG.svg";
import { ReactComponent as MenuOpen } from "../../assets/svg/MenuOpen.svg";
import { ReactComponent as MenuClose } from "../../assets/svg/MenuClose.svg";
import { ReactComponent as ReservasSVG } from "../../assets/svg/ReservasSVG.svg";
import { ReactComponent as TrabajadoresSVG } from "../../assets/svg/TrabajadoresSVG.svg";
import { ReactComponent as ClienteSVG } from "../../assets/svg/ClienteSVG.svg";
import { ReactComponent as ConfiguracionSVG } from "../../assets/svg/ConfiguracionSVG.svg";
import { ReactComponent as LogoutSVG } from "../../assets/svg/LogoutSVG.svg";
import { ReactComponent as InventarioSVG } from "../../assets/svg/InventarioSVG.svg";
import { ReactComponent as EstadisticasSVG } from "../../assets/svg/EstadisticasSVG.svg";
import { ReactComponent as ProveedoresSVG } from "../../assets/svg/ProveedoresSVG.svg";
import { ReactComponent as CuentasSVG } from "../../assets/svg/CuentasSVG.svg";
import { ReactComponent as VentaRapidaSVG } from "../../assets/svg/VentaRapidaSVG.svg";
import { ReactComponent as TareasSVG } from "../../assets/svg/TareasSVG.svg";
import Logo from "../../assets/img/logo-morado-cuadrado.png";
import { useAuth } from "../../shared/stores/useAuth";

type Props = {
  open?: boolean;
  onToggle?: () => void;
  onClose?: () => void;
};

function NavBar({ open: openProp, onToggle, onClose }: Props) {
  const { role, logout } = useAuth();
  const navigate = useNavigate();

  // ✅ Soporta: controlado por layout (responsive) o “uncontrolled” (por si lo usas en otro sitio)
  const [openLocal, setOpenLocal] = useState(false);
  const isControlled = typeof openProp === "boolean";
  const open = isControlled ? (openProp as boolean) : openLocal;

  const setOpen = (v: boolean) => {
    if (!isControlled) setOpenLocal(v);
  };

  const isLgUp = useMemo(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  }, []);

  // ✅ Si pasamos de móvil->desktop, dejamos el sidebar abierto (más cómodo en desktop)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = () => {
      if (mq.matches) {
        // en desktop, por defecto abierto si venimos de overlay cerrado
        // (pero sin forzar si ya está abierto)
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
    // ✅ En móvil cerramos el overlay al navegar
    if (!isLgUp) {
      if (onClose) onClose();
      else setOpen(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
    closeIfMobile();
  };

  const baseSectionClass = `flex flex-col h-full gap-3 transition-all duration-500 bg-blanco sticky top-0 ${
    open ? "w-60" : "w-12"
  }`;

  const header = (
    <header className="flex items-center p-2 justify-between w-full">
      <img className={` w-8 ${open ? "" : "hidden"}`} src={Logo} alt="" />
      <MenuOpen
        width={32}
        height={32}
        className={`cursor-pointer ${open ? "hidden" : ""}`}
        onClick={actualizarApertura}
      />
      <MenuClose
        width={32}
        height={32}
        className={`cursor-pointer ${open ? "" : "hidden"}`}
        onClick={actualizarApertura}
      />
    </header>
  );

  const navShell = (topItems: React.ReactNode, bottomItems: React.ReactNode) => (
    <nav className="flex flex-col justify-between h-full w-fit p-2">
      <div className="flex flex-col gap-3 w-fit">{topItems}</div>
      <div className="flex flex-col gap-3 w-fit">{bottomItems}</div>
    </nav>
  );

  if (role == "Administrador") {
    return (
      <section className={baseSectionClass}>
        {header}

        {navShell(
          <>
            <NavBarItem
              nombre="Venta Rápida"
              pagina="VentaRapida"
              svg={VentaRapidaSVG}
              abierto={open}
              onClick={closeIfMobile}
            />
            <NavBarItem pagina="Mesas" svg={MesaSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Inventario" svg={InventarioSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Reservas" svg={ReservasSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Trabajadores" svg={TrabajadoresSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem
              pagina="Proveedores"
              nombre="Proveedores y Pedidos"
              svg={ProveedoresSVG}
              abierto={open}
              onClick={closeIfMobile}
            />
            <NavBarItem pagina="Clientes" svg={ClienteSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Tareas" svg={TareasSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Cuentas" svg={CuentasSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Estadisticas" svg={EstadisticasSVG} abierto={open} onClick={closeIfMobile} />
          </>,
          <>
            <NavBarItem
              pagina="Configuracion"
              nombre="Configuración"
              svg={ConfiguracionSVG}
              abierto={open}
              onClick={closeIfMobile}
            />
            <NavBarItem
              pagina="Logout"
              nombre="Cerrar Sesión"
              svg={LogoutSVG}
              abierto={open}
              onClick={handleLogout}
            />
          </>,
        )}
      </section>
    );
  }

  if (role == "Camarero") {
    return (
      <section className={baseSectionClass}>
        <header className="flex items-center p-2 justify-between w-full">
          <VentaRapidaSVG
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "" : "hidden"}`}
            onClick={() => {
              navigate("/ventaRapida");
              closeIfMobile();
            }}
          />
          <MenuOpen
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "hidden" : ""}`}
            onClick={actualizarApertura}
          />
          <MenuClose
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "" : "hidden"}`}
            onClick={actualizarApertura}
          />
        </header>

        {navShell(
          <>
            <NavBarItem pagina="Mesas" svg={MesaSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Inventario" svg={InventarioSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Reservas" svg={ReservasSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Trabajadores" svg={TrabajadoresSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Tareas" svg={TareasSVG} abierto={open} onClick={closeIfMobile} />
          </>,
          <>
            <NavBarItem
              pagina="Logout"
              nombre="Cerrar Sesión"
              svg={LogoutSVG}
              abierto={open}
              onClick={handleLogout}
            />
          </>,
        )}
      </section>
    );
  }

  if (role == "Limpieza") {
    return (
      <section className={baseSectionClass}>
        <header className="flex items-center p-2 justify-between w-full">
          <MenuOpen
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "hidden" : ""}`}
            onClick={actualizarApertura}
          />
          <MenuClose
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "" : "hidden"}`}
            onClick={actualizarApertura}
          />
        </header>

        {navShell(
          <>
            <NavBarItem pagina="Inventario" svg={InventarioSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Trabajadores" svg={TrabajadoresSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Tareas" svg={TareasSVG} abierto={open} onClick={closeIfMobile} />
          </>,
          <>
            <NavBarItem
              pagina="Logout"
              nombre="Cerrar Sesión"
              svg={LogoutSVG}
              abierto={open}
              onClick={handleLogout}
            />
          </>,
        )}
      </section>
    );
  }

  if (role == "Cocinero") {
    return (
      <section className={baseSectionClass}>
        <header className="flex items-center p-2 justify-between w-full">
          <MenuOpen
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "hidden" : ""}`}
            onClick={actualizarApertura}
          />
          <MenuClose
            width={32}
            height={32}
            className={`cursor-pointer ${open ? "" : "hidden"}`}
            onClick={actualizarApertura}
          />
        </header>

        {navShell(
          <>
            <NavBarItem
              pagina="Mesas"
              nombre="Comandas"
              svg={MesaSVG}
              abierto={open}
              onClick={closeIfMobile}
            />
            <NavBarItem pagina="Inventario" svg={InventarioSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Trabajadores" svg={TrabajadoresSVG} abierto={open} onClick={closeIfMobile} />
            <NavBarItem pagina="Tareas" svg={TareasSVG} abierto={open} onClick={closeIfMobile} />
          </>,
          <>
            <NavBarItem
              pagina="Logout"
              nombre="Cerrar Sesión"
              svg={LogoutSVG}
              abierto={open}
              onClick={handleLogout}
            />
          </>,
        )}
      </section>
    );
  }

  return null;
}

export default NavBar;
