// pages/Clientes.tsx
import React, { useEffect, useMemo, useState } from "react";
import { ReactComponent as LapizSVG } from "../assets/svg/LapizSVG.svg";

import Modal from "../components/proveedores/Modal";
import Campo from "../components/proveedores/Campo";
import ClienteCard from "../components/ClientsComponents/ClientesCard";
import { useToast } from "../shared/toast";

import {
  clientesCreateCliente,
  clientesGetClienteForm,
  clientesGetOverview,
  clientesUpdateCliente,
  type FiltroRanking,
  type ClienteRow,
} from "../components/ClientsComponents/clientesApis";

type Vista = "list" | "detail";

type ClienteUI = {
  ID_Cliente: number;
  Nombre: string;
  Email: string;
  Telefono: string;

  UltimaReservaTexto: string;
  Mesa: string;
  Comensales: string;

  TotalGastado: number;
  TotalReservas: number;
  ReservasPendientes: number;
};

function euro(n: number) {
  return (Number(n) || 0).toLocaleString("es-ES", {
    style: "currency",
    currency: "EUR",
  });
}

export default function Clientes() {
  const [vista, setVista] = useState<Vista>("list");
  const [ranking, setRanking] = useState<FiltroRanking>("todos");

  const [busqueda, setBusqueda] = useState("");
  const [loading, setLoading] = useState(false);

  const [clientes, setClientes] = useState<ClienteUI[]>([]);
  const [clienteActivo, setClienteActivo] = useState<ClienteUI | null>(null);
  const toast = useToast();

  // Modal (nuevo/editar)
  const [modalClienteOpen, setModalClienteOpen] = useState(false);
  const [modalClienteModo, setModalClienteModo] = useState<"nuevo" | "editar">(
    "nuevo",
  );

  // Form modal
  const [fNombre, setFNombre] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fTelefono, setFTelefono] = useState("");
  const [fNotas, setFNotas] = useState("");

  function mapRowToUI(r: ClienteRow): ClienteUI {
    const fecha = r.Ultima_Reserva_Fecha;
    const hora = r.Ultima_Reserva_Hora;
    const ultimaReserva = fecha ? `${fecha}${hora ? ` ${hora}` : ""}` : "-";

    const totalGastado =
      Number(r.Total_Gastado_Calculado || 0) +
      Number(r.Total_Gastado_Stored || 0);

    return {
      ID_Cliente: Number(r.ID_Cliente),
      Nombre: String(r.Nombre ?? ""),
      Email: String(r.Email ?? ""),
      Telefono: String(r.Telefono ?? ""),

      UltimaReservaTexto: ultimaReserva,
      Mesa: r.Ultima_Reserva_Mesa ? String(r.Ultima_Reserva_Mesa) : "-",
      Comensales:
        r.Ultima_Reserva_NumPersonas != null
          ? String(r.Ultima_Reserva_NumPersonas)
          : "-",

      TotalGastado: totalGastado,
      TotalReservas: Number(r.Total_Reservas || 0),
      ReservasPendientes: Number(r.Reservas_Pendientes || 0),
    };
  }

  async function recargarSegunFiltroManteniendoSeleccion() {
    setLoading(true);
    try {
      const rows = await clientesGetOverview({ ranking });
      const ui = (rows ?? []).map(mapRowToUI);

      setClientes(ui);

      // Mantener selección si estamos en detail
      if (clienteActivo) {
        const id = Number(clienteActivo.ID_Cliente);
        const updated = ui.find((x) => Number(x.ID_Cliente) === id);
        if (updated) setClienteActivo(updated);
      }
    } catch (e) {
      console.error("Error cargando clientes", e);
      setClientes([]);
      setClienteActivo(null);
      setVista("list");
      toast.error("Error", "No se pudieron cargar los clientes.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    recargarSegunFiltroManteniendoSeleccion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking]);

  const clientesFiltrados = useMemo(() => {
    const s = busqueda.trim().toLowerCase();
    if (!s) return clientes;
    return clientes.filter((c) => {
      const full = `${c.Nombre} ${c.Email} ${c.Telefono}`.toLowerCase();
      return full.includes(s);
    });
  }, [clientes, busqueda]);

  function volverALista() {
    setVista("list");
    setClienteActivo(null);
    setBusqueda("");
  }

  function abrirDetalleCliente(c: ClienteUI) {
    setClienteActivo(c);
    setVista("detail");
    setBusqueda("");
  }

  function abrirNuevoClienteModal() {
    setModalClienteModo("nuevo");
    setFNombre("");
    setFEmail("");
    setFTelefono("");
    setFNotas("");
    setModalClienteOpen(true);
  }

  async function abrirEditarClienteModal() {
    if (!clienteActivo) return;

    try {
      const r0 = await clientesGetClienteForm({
        idCliente: Number(clienteActivo.ID_Cliente),
      });

      setModalClienteModo("editar");
      setFNombre(String(r0?.Nombre ?? clienteActivo.Nombre ?? ""));
      setFEmail(String(r0?.Email ?? clienteActivo.Email ?? ""));
      setFTelefono(String(r0?.Telefono ?? clienteActivo.Telefono ?? ""));
      setFNotas(String(r0?.Notas ?? ""));
      setModalClienteOpen(true);
    } catch (e) {
      console.error(e);
      toast.error("Error", "No se pudo cargar el cliente para editar.");
    }
  }

  async function guardarCliente() {
    const nombre = fNombre.trim();
    if (!nombre) {
      toast.info("Falta el nombre.", "El nombre es obligatorio.");
      return;
    }

    const email = fEmail.trim();
    const telefono = fTelefono.trim();
    const notas = fNotas.trim();

    setLoading(true);
    try {
      if (modalClienteModo === "nuevo") {
        const ok = await clientesCreateCliente({
          nombre,
          email: email || null,
          telefono: telefono || null,
          notas: notas || null,
        });

        if (!ok) {
          toast.error("Error", "No se pudo crear el cliente.");
          return;
        }

        setModalClienteOpen(false);
        await recargarSegunFiltroManteniendoSeleccion();
        return;
      }

      if (!clienteActivo) return;

      const ok = await clientesUpdateCliente({
        idCliente: Number(clienteActivo.ID_Cliente),
        nombre,
        email: email || null,
        telefono: telefono || null,
        notas: notas || null,
      });

      if (!ok) {
        toast.error("Error", "No se pudo actualizar el cliente.");
        return;
      }

      setModalClienteOpen(false);
      await recargarSegunFiltroManteniendoSeleccion();
    } catch (e) {
      console.error("Error guardando cliente", e);
      toast.error("Error", "No se pudo guardar el cliente.");
    } finally {
      setLoading(false);
    }
  }

  const titulo = useMemo(() => {
    if (vista === "list") return "CLIENTES";
    return `CLIENTE · ${clienteActivo ? `${clienteActivo.Nombre}`.trim() : ""}`;
  }, [vista, clienteActivo]);

  return (
    <div className="w-full min-h-full bg-gris flex flex-col items-center gap-4 p-3 pt-3 sm:p-6 sm:pt-4 lg:p-10 lg:pt-5">
      {/* HEADER */}
      <div className="w-full bg-blanco p-3 sm:p-4 rounded-xl shadow-xs flex flex-col gap-3 sm:gap-4 justify-center items-center">
        {/* TÍTULO */}
        <div className="w-full flex items-center justify-between gap-2">
          {vista === "detail" ? (
            <button
              type="button"
              onClick={volverALista}
              className="flex cursor-pointer items-center gap-2 text-negro font-semibold hover:opacity-80 transition shrink-0"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              <span className="hidden xs:inline">Volver</span>
            </button>
          ) : (
            <div className="w-8 sm:w-auto" />
          )}

          <h2 className="text-xl sm:text-2xl font-bold text-center flex-1">
            {titulo}
          </h2>

          <div className="w-8 sm:w-auto" />
        </div>

        {/* FILTROS SOLO EN LIST */}
        {vista === "list" && (
          <div className="w-full sticky sm:static top-14 z-10">
            <div
              className="
                mx-auto w-fit max-w-full
                rounded-2xl
                bg-blanco/95 backdrop-blur
                border border-negro/10
                shadow-sm
                px-2 py-2
                sm:bg-transparent sm:border-0 sm:shadow-none sm:p-0
              "
            >
              {/* MÓVIL MUY ESTRECHO → COLUMNA */}
              <div className="flex flex-col items-center gap-2 xs:hidden">
                <button
                  type="button"
                  onClick={() => setRanking("todos")}
                  className={`border-2 rounded-xl px-3 py-1 text-[11px] font-semibold w-full whitespace-nowrap ${
                    ranking === "todos"
                      ? "border-verde bg-verde text-white"
                      : "border-negro hover:bg-negro hover:text-white"
                  }`}
                >
                  Todos
                </button>

                <button
                  type="button"
                  onClick={() => setRanking("reservas")}
                  className={`border-2 rounded-xl px-3 py-1 text-[11px] font-semibold w-full whitespace-nowrap ${
                    ranking === "reservas"
                      ? "border-verde bg-verde text-white"
                      : "border-negro hover:bg-negro hover:text-white"
                  }`}
                >
                  Mejor por reservas
                </button>

                <button
                  type="button"
                  onClick={() => setRanking("gasto")}
                  className={`border-2 rounded-xl px-3 py-1 text-[11px] font-semibold w-full whitespace-nowrap ${
                    ranking === "gasto"
                      ? "border-verde bg-verde text-white"
                      : "border-negro hover:bg-negro hover:text-white"
                  }`}
                >
                  Mejor por gasto
                </button>

                <button
                  type="button"
                  onClick={() => recargarSegunFiltroManteniendoSeleccion()}
                  className="border-2 rounded-xl px-3 py-1 text-[11px] font-semibold w-full whitespace-nowrap border-negro hover:bg-negro hover:text-white transition"
                >
                  Recargar
                </button>

                <button
                  type="button"
                  onClick={abrirNuevoClienteModal}
                  className="group flex items-center justify-center gap-2 border-2 border-verde rounded-xl px-3 py-1 text-[11px] font-medium text-verde hover:bg-verde hover:text-white transition w-full whitespace-nowrap"
                >
                  <LapizSVG width={16} height={16} />
                  Añadir Nuevo Cliente
                </button>
              </div>

              {/* MÓVIL NORMAL → 2 FILAS */}
              <div className="hidden xs:grid sm:hidden gap-2">
                <div className="flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRanking("todos")}
                    className={`border-2 rounded-xl px-3 py-1 text-[11px] font-semibold whitespace-nowrap ${
                      ranking === "todos"
                        ? "border-verde bg-verde text-white"
                        : "border-negro hover:bg-negro hover:text-white"
                    }`}
                  >
                    Todos
                  </button>

                  <button
                    type="button"
                    onClick={() => setRanking("reservas")}
                    className={`border-2 rounded-xl px-3 py-1 text-[11px] font-semibold whitespace-nowrap ${
                      ranking === "reservas"
                        ? "border-verde bg-verde text-white"
                        : "border-negro hover:bg-negro hover:text-white"
                    }`}
                  >
                    Mejor por reservas
                  </button>

                  <button
                    type="button"
                    onClick={() => setRanking("gasto")}
                    className={`border-2 rounded-xl px-3 py-1 text-[11px] font-semibold whitespace-nowrap ${
                      ranking === "gasto"
                        ? "border-verde bg-verde text-white"
                        : "border-negro hover:bg-negro hover:text-white"
                    }`}
                  >
                    Mejor por gasto
                  </button>
                </div>

                <div className="flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => recargarSegunFiltroManteniendoSeleccion()}
                    className="border-2 rounded-xl px-3 py-1 text-[11px] font-semibold whitespace-nowrap border-negro hover:bg-negro hover:text-white transition"
                  >
                    Recargar
                  </button>

                  <button
                    type="button"
                    onClick={abrirNuevoClienteModal}
                    className="group flex items-center gap-2 border-2 border-verde rounded-xl px-3 py-1 text-[11px] font-medium whitespace-nowrap text-verde hover:bg-verde hover:text-white transition"
                  >
                    <LapizSVG width={16} height={16} />
                    Añadir Nuevo Cliente
                  </button>
                </div>
              </div>

              {/* SM+ → UNA SOLA FILA */}
              <div className="hidden sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-2">
                <button
                  type="button"
                  onClick={() => setRanking("todos")}
                  className={`border-2 rounded-xl px-4 py-2 sm:py-1 transition font-semibold ${
                    ranking === "todos"
                      ? "border-verde bg-verde text-white"
                      : "border-negro hover:bg-negro hover:text-white"
                  }`}
                >
                  Todos
                </button>

                <button
                  type="button"
                  onClick={() => setRanking("reservas")}
                  className={`border-2 rounded-xl px-4 py-2 sm:py-1 transition font-semibold ${
                    ranking === "reservas"
                      ? "border-verde bg-verde text-white"
                      : "border-negro hover:bg-negro hover:text-white"
                  }`}
                >
                  Mejor por reservas
                </button>

                <button
                  type="button"
                  onClick={() => setRanking("gasto")}
                  className={`border-2 rounded-xl px-4 py-2 sm:py-1 transition font-semibold ${
                    ranking === "gasto"
                      ? "border-verde bg-verde text-white"
                      : "border-negro hover:bg-negro hover:text-white"
                  }`}
                >
                  Mejor por gasto
                </button>

                <button
                  type="button"
                  onClick={() => recargarSegunFiltroManteniendoSeleccion()}
                  className="border-2 rounded-xl px-4 py-2 sm:py-1 transition font-semibold border-negro hover:bg-negro hover:text-white"
                >
                  Recargar
                </button>

                <button
                  type="button"
                  onClick={abrirNuevoClienteModal}
                  className="group flex gap-2 items-center justify-center cursor-pointer border-2 border-verde rounded-xl px-4 py-2 sm:py-1 text-verde transition-all duration-300 ease-out hover:bg-verde hover:text-white hover:shadow-md whitespace-nowrap"
                >
                  <LapizSVG width={20} height={20} />
                  <p className="font-medium">Añadir Nuevo Cliente</p>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* SEARCH SOLO EN LIST */}
        {vista === "list" && (
          <div className="w-full max-w-[820px]">
            <div className="w-full flex items-center gap-3 border-2 border-negro/20 rounded-xl px-4 py-2 bg-white">
              <span className="text-negro/70 select-none">🔎</span>
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar cliente..."
                className="w-full outline-none bg-transparent text-negro"
              />
              {loading && (
                <span className="text-negro/60 text-sm">Cargando...</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* LISTA (CARDS) */}
      {vista === "list" && (
        <div className="w-full bg-blanco rounded-xl p-3 sm:p-4 shadow-xs">
          {loading ? (
            <p className="text-negro/70">Cargando clientes...</p>
          ) : clientesFiltrados.length === 0 ? (
            <p className="text-negro/70">No hay clientes con ese filtro.</p>
          ) : (
            <div
              className="
                grid w-full gap-3 sm:gap-4
                grid-cols-1
                sm:grid-cols-2
                lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]
              "
            >
              {clientesFiltrados.map((c) => (
                <div
                  key={c.ID_Cliente}
                  className="
                    relative
                    rounded-2xl
                    border border-negro/10
                    bg-white
                    p-3
                    shadow-sm
                    transition
                    hover:shadow-md hover:-translate-y-[1px]
                    active:translate-y-0
                  "
                >
                  {c.ReservasPendientes > 0 && (
                    <div className="absolute -top-2 -right-2 z-10 bg-verde text-white text-xs font-bold px-2 py-1 rounded-full shadow-sm">
                      {c.ReservasPendientes} pendiente
                      {c.ReservasPendientes === 1 ? "" : "s"}
                    </div>
                  )}

                  <div
                    className="cursor-pointer"
                    onClick={() => abrirDetalleCliente(c)}
                  >
                    <ClienteCard
                      nombre={c.Nombre}
                      apellido={""}
                      onClick={() => abrirDetalleCliente(c)}
                    />

                    <div className="mt-3 flex flex-wrap gap-2">
                      <div className="px-2 py-1 rounded-full border border-negro/10 text-xs text-negro/80 bg-gris/30">
                        Reservas: <b className="text-negro">{c.TotalReservas}</b>
                      </div>
                      <div className="px-2 py-1 rounded-full border border-negro/10 text-xs text-negro/80 bg-gris/30">
                        Gastado: <b className="text-negro">{euro(c.TotalGastado)}</b>
                      </div>
                    </div>

                    {(c.Email || c.Telefono) && (
                      <div className="mt-2 text-[12px] text-negro/60 flex flex-col gap-1">
                        {c.Email && <span className="truncate">✉️ {c.Email}</span>}
                        {c.Telefono && <span className="truncate">📞 {c.Telefono}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* DETALLE */}
      {vista === "detail" && clienteActivo && (
        <div className="w-full bg-blanco rounded-xl p-3 sm:p-6 shadow-xs flex flex-col gap-4 sm:gap-5">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="text-lg sm:text-2xl font-bold text-negro break-words">
                {clienteActivo.Nombre}
              </h3>

              <div className="mt-2 text-sm text-negro flex flex-col gap-2">
                <p className="break-words">
                  <span className="font-semibold">Email:</span>{" "}
                  {clienteActivo.Email || "—"}
                </p>
                <p className="break-words">
                  <span className="font-semibold">Teléfono:</span>{" "}
                  {clienteActivo.Telefono || "—"}
                </p>

                <div className="mt-3 pt-3 border-t border-negro/10 grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                  <div className="border-2 border-negro/10 rounded-xl p-3">
                    <p className="text-xs text-negro/60">Total reservas</p>
                    <p className="text-lg font-bold">{clienteActivo.TotalReservas}</p>
                  </div>

                  <div className="border-2 border-negro/10 rounded-xl p-3">
                    <p className="text-xs text-negro/60">Total gastado</p>
                    <p className="text-lg font-bold">{euro(clienteActivo.TotalGastado)}</p>
                  </div>

                  <div className="border-2 border-negro/10 rounded-xl p-3">
                    <p className="text-xs text-negro/60">Reservas pendientes</p>
                    <p className="text-lg font-bold">
                      {clienteActivo.ReservasPendientes > 0
                        ? `Sí (${clienteActivo.ReservasPendientes})`
                        : "No"}
                    </p>
                  </div>

                  <div className="border-2 border-negro/10 rounded-xl p-3">
                    <p className="text-xs text-negro/60">Última reserva</p>
                    <p className="font-semibold break-words">
                      {clienteActivo.UltimaReservaTexto}
                    </p>
                    <p className="text-sm text-negro/70 break-words">
                      Mesa: <b>{clienteActivo.Mesa}</b> · Comensales:{" "}
                      <b>{clienteActivo.Comensales}</b>
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="w-full lg:w-auto lg:min-w-[260px]">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3">
                <button
                  className="w-full border-2 border-verde text-verde rounded-xl py-2.5 sm:py-2 hover:bg-verde hover:text-white transition font-semibold"
                  onClick={abrirEditarClienteModal}
                >
                  Editar cliente
                </button>

                <button
                  className="w-full border-2 border-azul text-azul rounded-xl py-2.5 sm:py-2 hover:bg-azul hover:text-white transition font-semibold"
                  onClick={() =>
                    toast.info(
                      "Pendiente",
                      "Enviar publicidad (pendiente de implementar)",
                    )
                  }
                >
                  Enviar Publicidad
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL NUEVO/EDITAR */}
      <Modal
        open={modalClienteOpen}
        onClose={() => setModalClienteOpen(false)}
        title={modalClienteModo === "nuevo" ? "Crear cliente" : "Editar cliente"}
        zIndex={60}
        widthClass="max-w-[780px]"
      >
        <div className="max-h-[75vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Campo
              label="Nombre *"
              value={fNombre}
              onChange={setFNombre}
              placeholder="Ej: Juan"
            />

            <Campo
              label="Email"
              value={fEmail}
              onChange={setFEmail}
              placeholder="Ej: juan@correo.com"
              type="email"
            />

            <Campo
              label="Teléfono"
              value={fTelefono}
              onChange={setFTelefono}
              placeholder="Ej: 600123123"
            />

            <div className="sm:col-span-2">
              <label className="font-semibold text-negro">Notas</label>
              <textarea
                value={fNotas}
                onChange={(e) => setFNotas(e.target.value)}
                rows={4}
                className="mt-1 w-full border border-negro rounded-lg px-3 py-2 text-negro outline-none bg-white resize-none"
                placeholder="Ej: Cliente VIP, alergias, preferencias..."
              />
            </div>
          </div>

          <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3 justify-end">
            <button
              type="button"
              onClick={() => setModalClienteOpen(false)}
              className="border-2 border-negro rounded-xl px-4 py-2 hover:bg-negro hover:text-white transition font-semibold w-full sm:w-auto"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={guardarCliente}
              disabled={loading}
              className={`border-2 rounded-xl px-4 py-2 font-semibold transition w-full sm:w-auto ${
                loading
                  ? "border-gray-300 text-gray-400 cursor-not-allowed"
                  : "border-verde text-verde hover:bg-verde hover:text-white"
              }`}
            >
              {loading ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
