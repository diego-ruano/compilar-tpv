import { usePermisos } from "../../shared/lib/usePermisos";
// pages/Clientes.tsx
import { useEffect, useMemo, useState } from "react";
import { toAppError } from "@tpv/client";
import {
  ArrowLeft,
  Plus,
  RefreshCw,
  Mail,
  Phone,
  Pencil,
  Users,
  CalendarDays,
  Wallet,
  Clock,
  ChevronLeft,
  ChevronRight,
  ReceiptText,
} from "lucide-react";

import Modal from "../../features/proveedores/Modal";
import Campo from "../../features/proveedores/Campo";
import { useToast } from "../../shared/toast";
import { SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";

import {
  clientesGetClienteForm,
  type ClienteOverview,
  type FiltroRanking,
} from "../../features/clientes/clientesApis";
import {
  useClienteForm,
  useClientesOverview,
  useRecalcularGasto,
  useCreateCliente,
  useUpdateCliente,
} from "../../features/clientes/clientesQueries";
import FacturasDelCliente from "../../features/clientes/FacturasDelCliente";
import { nifValido } from "../../shared/ticket/nif";
import { conAviso } from "../../shared/lib/conAviso";
import { contiene, textoABuscar } from "../../shared/lib/busqueda";
import type { Dinero } from "@tpv/contracts";
import { eur } from "../../shared/lib/dinero";

type Vista = "list" | "detail";

type ClienteUI = {
  ID_Cliente: string;
  Nombre: string;
  Email: string;
  Telefono: string;

  UltimaReservaTexto: string;
  Mesa: string;
  Comensales: string;

  TotalGastado: Dinero;
  TotalReservas: number;
  ReservasPendientes: number;
};

const RANKINGS: { key: FiltroRanking; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "reservas", label: "Mejor por reservas" },
  { key: "gasto", label: "Mejor por gasto" },
];

// Colores suaves deterministas para los avatares (claro/oscuro).
const AVATAR_PALETTE = [
  "bg-[#2B81D4]/15 text-[#2B81D4]",
  "bg-sky-500/15 text-sky-500",
  "bg-emerald-500/15 text-emerald-500",
  "bg-amber-500/15 text-amber-500",
  "bg-rose-500/15 text-rose-500",
  "bg-cyan-500/15 text-cyan-500",
  "bg-[#0F2C56]/15 text-[#0F2C56]",
  "bg-[#016FFC]/15 text-[#016FFC]",
];

function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of String(seed || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const idx = h % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx];
}

function inicial(nombre: string): string {
  return (nombre?.trim()?.[0] ?? "?").toUpperCase();
}

export default function Clientes() {
  const [vista, setVista] = useState<Vista>("list");
  const [ranking, setRanking] = useState<FiltroRanking>("todos");

  const [busqueda, setBusqueda] = useState("");

  const [clienteActivo, setClienteActivo] = useState<ClienteUI | null>(null);
  const toast = useToast();

  // Datos vía TanStack Query (caché): la lista se recachea por `ranking` y las
  // mutaciones (crear/editar) invalidan la clave para refrescarla automáticamente.
  const overview = useClientesOverview(ranking);
  const { puede } = usePermisos();
  const recalcularGasto = useRecalcularGasto();
  const createCliente = useCreateCliente();
  const updateCliente = useUpdateCliente();

  const guardando = createCliente.isPending || updateCliente.isPending;

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
  // FISCAL-02: los datos para facturarle. Opcionales.
  const [fNif, setFNif] = useState("");
  const [fRazonSocial, setFRazonSocial] = useState("");
  const [fDireccionFiscal, setFDireccionFiscal] = useState("");
  const nifMal = fNif.trim() !== "" && !nifValido(fNif);

  // La ficha del cliente abierto, con sus datos fiscales: el overview no los trae.
  const fichaActiva = useClienteForm(vista === "detail" ? (clienteActivo?.ID_Cliente ?? null) : null);
  const fiscalActivo = fichaActiva.data;
  const tieneDatosFiscales = !!(fiscalActivo?.nif || fiscalActivo?.razon_social || fiscalActivo?.direccion_fiscal);

  // Si no se pueden leer, se avisa: sin el bloque, la ficha parecería no tener datos de facturación.
  useEffect(() => {
    if (fichaActiva.isError) {
      toast.error("No se pudieron cargar los datos de facturación del cliente", toAppError(fichaActiva.error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fichaActiva.isError]);

  function mapRowToUI(r: ClienteOverview): ClienteUI {
    const fecha = r.ultima_reserva_fecha;
    const hora = r.ultima_reserva_hora;
    const ultimaReserva = fecha ? `${fecha}${hora ? ` ${hora}` : ""}` : "-";

    return {
      ID_Cliente: r.id_cliente,
      Nombre: r.nombre,
      Email: r.email ?? "",
      Telefono: r.telefono ?? "",

      UltimaReservaTexto: ultimaReserva,
      Mesa: r.ultima_reserva_mesa ?? "-",
      Comensales:
        r.ultima_reserva_num_personas != null ? String(r.ultima_reserva_num_personas) : "-",

      TotalGastado: r.total_gastado_stored,
      TotalReservas: r.total_reservas,
      ReservasPendientes: r.reservas_pendientes,
    };
  }

  const clientes = useMemo<ClienteUI[]>(
    () => (overview.data ?? []).map(mapRowToUI),
    [overview.data],
  );

  // Mantener la selección de detalle sincronizada con la lista recacheada.
  useEffect(() => {
    if (!clienteActivo) return;
    const id = clienteActivo.ID_Cliente;
    const updated = clientes.find((x) => x.ID_Cliente === id);
    if (updated && updated !== clienteActivo) setClienteActivo(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientes]);

  // Aviso + reset si falla la carga (equivale al catch del fetch anterior).
  useEffect(() => {
    if (overview.isError) {
      setClienteActivo(null);
      setVista("list");
      toast.error("No se pudieron cargar los clientes", toAppError(overview.error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.isError]);

  const clientesFiltrados = useMemo(() => {
    const s = textoABuscar(busqueda);
    if (!s) return clientes;
    return clientes.filter((c) => contiene(s, `${c.Nombre} ${c.Email} ${c.Telefono}`));
  }, [clientes, busqueda]);

  // Navegación anterior/siguiente en la vista de detalle.
  const idxActivo = useMemo(() => {
    if (!clienteActivo) return -1;
    return clientesFiltrados.findIndex(
      (c) => c.ID_Cliente === clienteActivo.ID_Cliente,
    );
  }, [clientesFiltrados, clienteActivo]);

  const prevCliente = idxActivo > 0 ? clientesFiltrados[idxActivo - 1] : null;
  const nextCliente =
    idxActivo >= 0 && idxActivo < clientesFiltrados.length - 1
      ? clientesFiltrados[idxActivo + 1]
      : null;

  function irAnterior() {
    if (prevCliente) setClienteActivo(prevCliente);
  }
  function irSiguiente() {
    if (nextCliente) setClienteActivo(nextCliente);
  }

  // Atajos de teclado ←/→ para moverse entre clientes en el detalle.
  useEffect(() => {
    if (vista !== "detail") return;

    const onKey = (e: KeyboardEvent) => {
      if (modalClienteOpen) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        irAnterior();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        irSiguiente();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista, modalClienteOpen, prevCliente, nextCliente]);

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
    setFNif("");
    setFRazonSocial("");
    setFDireccionFiscal("");
    setModalClienteOpen(true);
  }

  async function abrirEditarClienteModal() {
    if (!clienteActivo) return;

    try {
      const r0 = await clientesGetClienteForm(clienteActivo.ID_Cliente);

      setModalClienteModo("editar");
      setFNombre(r0?.nombre ?? clienteActivo.Nombre);
      setFEmail(r0?.email ?? clienteActivo.Email);
      setFTelefono(r0?.telefono ?? clienteActivo.Telefono);
      setFNotas(r0?.notas ?? "");
      setFNif(r0?.nif ?? "");
      setFRazonSocial(r0?.razon_social ?? "");
      setFDireccionFiscal(r0?.direccion_fiscal ?? "");
      setModalClienteOpen(true);
    } catch (e) {
      toast.error("No se pudo cargar el cliente para editar", toAppError(e).message);
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
    if (nifMal) {
      toast.info("El NIF no es válido.", "Revisa las cifras y la letra, o déjalo vacío.");
      return;
    }
    const fiscal = {
      nif: fNif.trim() || undefined,
      razon_social: fRazonSocial.trim() || undefined,
      direccion_fiscal: fDireccionFiscal.trim() || undefined,
    };

    try {
      if (modalClienteModo === "nuevo") {
        const ok = await createCliente.mutateAsync({
          nombre,
          email: email || undefined,
          telefono: telefono || undefined,
          notas: notas || undefined,
          ...fiscal,
        });

        if (!ok) {
          toast.error("Error", "No se pudo crear el cliente.");
          return;
        }

        setModalClienteOpen(false);
        return;
      }

      if (!clienteActivo) return;

      const ok = await updateCliente.mutateAsync({
        id_cliente: clienteActivo.ID_Cliente,
        nombre,
        email: email || undefined,
        telefono: telefono || undefined,
        notas: notas || undefined,
        ...fiscal,
      });

      if (!ok) {
        toast.error("Error", "No se pudo actualizar el cliente.");
        return;
      }

      setModalClienteOpen(false);
    } catch (e) {
      toast.error("No se pudo guardar el cliente", toAppError(e).message);
    }
  }
  // La invalidación en las mutaciones recachea la lista automáticamente.

  return (
    <div className="flex min-h-full w-full flex-col items-center gap-3 bg-bg p-3 pt-3 sm:gap-4 sm:p-6 sm:pt-4 lg:p-10 lg:pt-5">
      {/* ================= LISTA ================= */}
      {vista === "list" && (
        <>
          {/* HEADER: título, filtros y, a la derecha, buscar y crear. Si no cabe en una línea, baja
              por bloques; en el móvil, buscar y crear ocupan su propia línea, y todo va más junto. */}
          <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-surface p-2.5 shadow-sm sm:gap-y-3 sm:p-4">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent sm:size-11 sm:rounded-2xl">
                <Users className="size-5 sm:size-6" aria-hidden />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-fg max-sm:leading-tight sm:text-2xl">Clientes</h2>
                <p className="text-xs text-fg-muted sm:text-sm">
                  {clientes.length} {clientes.length === 1 ? "cliente" : "clientes"} en total
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              {RANKINGS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRanking(r.key)}
                  className={cn(
                    "cursor-pointer rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition sm:px-3 sm:py-2 sm:text-sm",
                    ranking === r.key
                      ? "border-accent bg-accent text-accent-fg shadow-sm"
                      : "border-border bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
              <SearchInput
                value={busqueda}
                onValueChange={setBusqueda}
                placeholder="Buscar cliente..."
                className="min-w-0 flex-1 sm:w-72 sm:flex-none"
              />

              <button
                type="button"
                onClick={abrirNuevoClienteModal}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98]"
              >
                <Plus className="size-4" aria-hidden />
                <span className="hidden xs:inline">Nuevo cliente</span>
              </button>
            </div>
          </div>

          {/* CARDS */}
          <div className="w-full">
            {overview.isPending ? null : clientesFiltrados.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-10 text-center shadow-sm">
                <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
                  <Users className="size-6" aria-hidden />
                </div>
                <p className="text-sm font-medium text-fg">Sin clientes</p>
                <p className="text-xs text-fg-muted">No hay clientes con ese filtro.</p>
              </div>
            ) : (
              // En el teléfono, dos por fila.
              <div className="grid w-full grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                {clientesFiltrados.map((c) => {
                  return (
                    <button
                      key={c.ID_Cliente}
                      type="button"
                      onClick={() => abrirDetalleCliente(c)}
                      className="group relative flex min-w-0 cursor-pointer flex-col rounded-2xl border border-border bg-surface p-2.5 text-left shadow-sm sm:p-4 transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md active:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {c.ReservasPendientes > 0 && (
                        <span className="absolute -right-1.5 -top-2 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-accent-fg shadow-sm sm:-right-2 sm:px-2 sm:py-1 sm:text-xs">
                          {c.ReservasPendientes} pendiente
                          {c.ReservasPendientes === 1 ? "" : "s"}
                        </span>
                      )}

                      <div className="flex items-center gap-2 sm:gap-3">
                        <div
                          className={cn(
                            "grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold sm:size-12 sm:text-base",
                            avatarColor(c.ID_Cliente),
                          )}
                        >
                          {inicial(c.Nombre)}
                        </div>

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-fg sm:text-base">{c.Nombre || "—"}</p>
                          <p className="flex items-center gap-1.5 truncate text-xs text-fg-muted">
                            {c.Email ? (
                              <>
                                <Mail className="size-3 shrink-0" aria-hidden />
                                {c.Email}
                              </>
                            ) : c.Telefono ? (
                              <>
                                <Phone className="size-3 shrink-0" aria-hidden />
                                {c.Telefono}
                              </>
                            ) : (
                              "Sin contacto"
                            )}
                          </p>
                        </div>

                        <ChevronRight
                          className="size-4 shrink-0 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:text-accent"
                          aria-hidden
                        />
                      </div>

                      {/* En el teléfono cada dato va en su línea, etiqueta y cifra: en dos columnas
                          el importe se cortaba. */}
                      <div className="mt-2 grid grid-cols-1 gap-1 sm:mt-4 sm:grid-cols-2 sm:gap-2">
                        <div className="flex items-center justify-between gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1 sm:block sm:rounded-xl sm:p-2.5">
                          <div className="flex items-center gap-1.5 text-fg-subtle">
                            <CalendarDays className="size-3.5" aria-hidden />
                            <span className="text-[11px] font-medium">Reservas</span>
                          </div>
                          <p className="text-sm font-bold text-fg sm:mt-0.5 sm:text-base">{c.TotalReservas}</p>
                        </div>

                        <div className="flex items-center justify-between gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1 sm:block sm:rounded-xl sm:p-2.5">
                          <div className="flex items-center gap-1.5 text-fg-subtle">
                            <Wallet className="size-3.5" aria-hidden />
                            <span className="text-[11px] font-medium">Gastado</span>
                          </div>
                          <p className="min-w-0 truncate text-sm font-bold text-fg sm:mt-0.5 sm:text-base">
                            {eur(c.TotalGastado)}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ================= DETALLE ================= */}
      {vista === "detail" && clienteActivo && (
        <>
          {/* Barra superior: volver + navegación anterior/siguiente */}
          <div className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm">
            <button
              type="button"
              onClick={volverALista}
              className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2"
            >
              <ArrowLeft className="size-4" aria-hidden />
              <span className="hidden xs:inline">Volver</span>
            </button>

            <div className="flex items-center gap-2">
              <span className="hidden text-sm font-medium text-fg-muted sm:inline">
                {idxActivo + 1} / {clientesFiltrados.length}
              </span>
              <button
                type="button"
                onClick={irAnterior}
                disabled={!prevCliente}
                aria-label="Cliente anterior"
                title="Cliente anterior (←)"
                className={cn(
                  "grid size-9 place-items-center rounded-xl border border-border bg-surface text-fg transition",
                  prevCliente
                    ? "cursor-pointer hover:bg-surface-2 hover:text-accent"
                    : "cursor-not-allowed opacity-40",
                )}
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={irSiguiente}
                disabled={!nextCliente}
                aria-label="Cliente siguiente"
                title="Cliente siguiente (→)"
                className={cn(
                  "grid size-9 place-items-center rounded-xl border border-border bg-surface text-fg transition",
                  nextCliente
                    ? "cursor-pointer hover:bg-surface-2 hover:text-accent"
                    : "cursor-not-allowed opacity-40",
                )}
              >
                <ChevronRight className="size-5" aria-hidden />
              </button>
            </div>
          </div>

          {/* Tarjeta de detalle */}
          <div className="w-full rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6">
            {/* Hero */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <div
                  className={cn(
                    "grid size-16 shrink-0 place-items-center rounded-2xl text-2xl font-bold",
                    avatarColor(clienteActivo.ID_Cliente),
                  )}
                >
                  {inicial(clienteActivo.Nombre)}
                </div>

                <div className="min-w-0">
                  <h3 className="truncate text-xl font-bold text-fg sm:text-2xl">
                    {clienteActivo.Nombre}
                  </h3>
                  <div className="mt-1 flex flex-col gap-1 text-sm text-fg-muted">
                    <span className="flex items-center gap-1.5 break-all">
                      <Mail className="size-3.5 shrink-0" aria-hidden />
                      {clienteActivo.Email || "—"}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Phone className="size-3.5 shrink-0" aria-hidden />
                      {clienteActivo.Telefono || "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer sm:py-2"
                  onClick={conAviso(abrirEditarClienteModal)}
                >
                  <Pencil className="size-4" aria-hidden />
                  Editar
                </button>
              </div>
            </div>

            {/* Stats */}
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-surface-2 p-4">
                <div className="flex items-center gap-2 text-fg-muted">
                  <CalendarDays className="size-4 text-accent" aria-hidden />
                  <span className="text-xs font-medium">Total reservas</span>
                </div>
                <p className="mt-1 text-2xl font-bold text-fg">{clienteActivo.TotalReservas}</p>
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-4">
                <div className="flex items-center gap-2 text-fg-muted">
                  <Wallet className="size-4 text-accent" aria-hidden />
                  <span className="text-xs font-medium">Total gastado</span>
                </div>
                <p className="mt-1 text-2xl font-bold text-fg">{eur(clienteActivo.TotalGastado)}</p>

                {/*
                  DB-14: el gasto es una suma que se guarda aparte, así que puede quedarse vieja
                  (un cobro que entra y falla al acreditarlo). El job de reconciliación avisa del
                  descuadre pero NO lo corrige: la decisión es de quien lleva el negocio. Este es
                  el botón que la ejecuta, y rehace el total desde los pagos del cliente.
                */}
                <button
                  type="button"
                  onClick={() => recalcularGasto.mutate({ id_cliente: clienteActivo.ID_Cliente })}
                  disabled={recalcularGasto.isPending || !puede("clientes.recalcular")}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg disabled:opacity-50"
                  title="Rehace el total desde los cobros de este cliente"
                >
                  <RefreshCw
                    className={`size-3 ${recalcularGasto.isPending ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  {recalcularGasto.isPending ? "Recalculando…" : "Recalcular desde los cobros"}
                </button>
              </div>

              <div className="rounded-xl border border-border bg-surface-2 p-4">
                <div className="flex items-center gap-2 text-fg-muted">
                  <Clock className="size-4 text-accent" aria-hidden />
                  <span className="text-xs font-medium">Reservas pendientes</span>
                </div>
                <p className="mt-1 text-2xl font-bold text-fg">
                  {clienteActivo.ReservasPendientes > 0
                    ? clienteActivo.ReservasPendientes
                    : "0"}
                </p>
              </div>
            </div>

            {/* Última reserva */}
            <div className="mt-3 rounded-xl border border-border bg-surface-2 p-4">
              <div className="flex items-center gap-2 text-fg-muted">
                <CalendarDays className="size-4" aria-hidden />
                <span className="text-xs font-medium">Última reserva</span>
              </div>
              <p className="mt-1 break-words font-semibold text-fg">
                {clienteActivo.UltimaReservaTexto}
              </p>
              <p className="mt-0.5 break-words text-sm text-fg-muted">
                Mesa: <b className="text-fg">{clienteActivo.Mesa}</b> · Comensales:{" "}
                <b className="text-fg">{clienteActivo.Comensales}</b>
              </p>
            </div>

            {/* FISCAL-02: los datos para facturarle, si los tiene. Hasta que llega la ficha no se
                enseña nada en su lugar. */}
            {tieneDatosFiscales && fiscalActivo ? (
              <div className="mt-3 rounded-xl border border-border bg-surface-2 p-4">
                <div className="flex items-center gap-2 text-fg-muted">
                  <ReceiptText className="size-4" aria-hidden />
                  <span className="text-xs font-medium">Datos de facturación</span>
                </div>
                <p className="mt-1 break-words font-semibold text-fg">
                  {fiscalActivo.razon_social ?? clienteActivo.Nombre}
                </p>
                <p className="mt-0.5 break-words text-sm text-fg-muted">
                  NIF: <b className="text-fg">{fiscalActivo.nif ?? "—"}</b>
                </p>
                {fiscalActivo.direccion_fiscal ? (
                  <p className="mt-0.5 break-words text-sm text-fg-muted">{fiscalActivo.direccion_fiscal}</p>
                ) : null}
              </div>
            ) : null}

            {/* Sus facturas completas, con su PDF: sólo en la Main. */}
            <FacturasDelCliente idCliente={clienteActivo.ID_Cliente} />
          </div>
        </>
      )}

      {/* MODAL NUEVO/EDITAR */}
      <Modal
        open={modalClienteOpen}
        onClose={() => setModalClienteOpen(false)}
        title={modalClienteModo === "nuevo" ? "Crear cliente" : "Editar cliente"}
        zIndex={60}
        widthClass="max-w-[780px]"
      >
        {/* INC-20261030-020: sin desplazamiento propio; ya lo tiene el cuerpo del modal. Con una
            segunda caja de 75vh dentro, en Android horizontal la interior era más alta que la
            exterior: el dedo movía la de dentro y Guardar/Cancelar quedaban fuera de la vista. */}
        <div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

            <div className="sm:col-span-2 lg:col-span-3">
              <label className="text-sm font-semibold text-fg">Notas</label>
              <textarea
                value={fNotas}
                onChange={(e) => setFNotas(e.target.value)}
                rows={4}
                className="mt-1 w-full resize-none rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Ej: Cliente VIP, alergias, preferencias..."
              />
            </div>

            {/* FISCAL-02: para no dictar el NIF cada vez que pide factura. */}
            <div className="sm:col-span-2 lg:col-span-3">
              <p className="text-sm font-semibold text-fg">Datos para facturarle</p>
              <p className="text-xs text-fg-muted">
                Opcionales. Con ellos, la factura completa se rellena al elegir este cliente.
              </p>
            </div>

            <div>
              <Campo
                label="NIF / CIF"
                value={fNif}
                onChange={(v) => setFNif(v.toUpperCase())}
                placeholder="Ej: B12345674"
              />
              {nifMal ? (
                <span className="mt-1 block text-xs text-danger">
                  Ese NIF no es válido: revisa las cifras y la letra.
                </span>
              ) : null}
            </div>

            <div className="lg:col-span-2">
              <Campo
                label="Razón social"
                value={fRazonSocial}
                onChange={setFRazonSocial}
                placeholder="Ej: Comidas Juan SL"
                maxLength={120}
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <Campo
                label="Dirección fiscal"
                value={fDireccionFiscal}
                onChange={setFDireccionFiscal}
                placeholder="Ej: Calle Mayor 1, 28013 Madrid"
                maxLength={250}
              />
            </div>
          </div>

          <div className="mt-6 flex flex-col-reverse justify-end gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => setModalClienteOpen(false)}
              className="w-full rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2 sm:w-auto cursor-pointer"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={conAviso(guardarCliente)}
              disabled={guardando}
              className={cn(
                "w-full rounded-xl px-4 py-2 font-semibold transition sm:w-auto",
                guardando
                  ? "cursor-not-allowed bg-surface-2 text-fg-subtle"
                  : "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:scale-[0.98] cursor-pointer",
              )}
            >
              {guardando ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
