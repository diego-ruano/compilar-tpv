import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  Users,
  Phone,
  Mail,
  Armchair,
  Map as MapIcon,
  Pencil,
  Trash2,
  Clock,
} from "lucide-react";
import {
  type Turno as TurnoApi,
} from "../../features/reservas/reservasApis";
import {
  useReservasMeta,
  useReservasMes,
  useSaveReserva,
  useDeleteReserva,
} from "../../features/reservas/reservasQueries";
import { mesasLoadLayout } from "../../features/mesasComponents/mesasApi";

import { useAuth } from "../../shared/stores/useAuth";
import { useToast } from "../../shared/toast";

// ✅ Modal + tipos del layout (MapCanvas)
import ReservaMesaMapModal from "../../features/reservas/ReservaMesaMapModal";
import type { Salon, MesaMeta } from "../../features/mesasComponents/types";

/* =========================
   Tipos
========================= */
type Turno = "DESAYUNO" | "COMIDA" | "CAFE" | "CENA";

type Zona = { idZona: string; nombre: string };
type Mesa = {
  idMesa: string;
  idZona: string;
  nombre: string;
  capacidad: number;
};

type ReservaUI = {
  id: string;
  diaYMD: string;
  hora: string;

  nombre: string;
  telefono: string;
  email: string;

  comensales: number;
  nota: string;

  turno: Turno;

  idZona: string;
  zonaNombre: string;

  idMesa: string;
  mesaNombre: string;
  capacidadMesa: number;

  estado: string;
};

type SessionBadge = {
  rolNombre: string;
  usuarioNombre: string;
};

/* =========================
   Helpers
========================= */
function ymdLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function inicioMesLocal(fecha: Date) {
  return new Date(fecha.getFullYear(), fecha.getMonth(), 1);
}

function finMesLocal(fecha: Date) {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0);
}

function sumarMesesLocal(fecha: Date, n: number) {
  return new Date(fecha.getFullYear(), fecha.getMonth() + n, 1);
}

function nombreMesYAnioLocal(fecha: Date) {
  return fecha.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
}

function generarCeldasMesLocal(fechaBase: Date) {
  const start = new Date(fechaBase.getFullYear(), fechaBase.getMonth(), 1);
  const offsetLunes0 = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offsetLunes0);

  return Array.from({ length: 42 }).map((_, i) => {
    const f = new Date(start);
    f.setDate(start.getDate() + i);
    return { fecha: f, esMes: f.getMonth() === fechaBase.getMonth() };
  });
}

function normalizarHora(h: string): string {
  if (!h) return "00:00";
  return h.slice(0, 5);
}

/**
 * Turnos:
 * - 08:00–12:59 => DESAYUNO
 * - 13:00–15:59 => COMIDA
 * - 16:00–18:59 => CAFE
 * - 19:00+      => CENA
 */
function turnoPorHora(hhmm: string): Turno {
  const [hhStr, mmStr] = String(hhmm || "00:00").split(":");
  const h = Number(hhStr ?? 0);
  const m = Number(mmStr ?? 0);
  const mins = h * 60 + m;

  if (mins < 13 * 60) return "DESAYUNO";
  if (mins < 16 * 60) return "COMIDA";
  if (mins < 19 * 60) return "CAFE";
  return "CENA";
}

function turnoLabel(t: Turno) {
  return t === "CAFE" ? "CAFÉ" : t;
}

function emailValido(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizarRolLabel(role: string) {
  const r = String(role || "").trim().toLowerCase();
  if (!r) return "Usuario";
  if (r === "admin" || r === "administrador") return "Administrador";
  if (r === "camarero") return "Camarero";
  if (r === "encargado") return "Encargado";
  return role;
}

/** ✅ IMPORTANTE: Reservas cerradas NO bloquean mesa */
function estadoBloqueaMesa(estadoRaw: string | null | undefined) {
  const e = String(estadoRaw ?? "ACTIVA").trim().toLowerCase();
  if (e === "finalizada") return false;
  if (e === "cancelada") return false;
  if (e === "no_show" || e === "noshow") return false;
  return true;
}

function parseDbZonaId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  if (s.startsWith("db-zona-")) {
    const id = s.replace("db-zona-", "").trim();
    return id || null;
  }

  return s;
}

function parseDbMesaId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  if (s.startsWith("db-mesa-")) {
    const id = s.replace("db-mesa-", "").trim();
    return id || null;
  }

  return s;
}

export default function Reservas() {
  const hoy = new Date();

  const { nombre: nombreSession, role: roleSession } = useAuth();
  const toast = useToast();

  const sessionBadge = useMemo<SessionBadge>(
    () => ({
      rolNombre: normalizarRolLabel(roleSession),
      usuarioNombre: nombreSession ?? "—",
    }),
    [roleSession, nombreSession],
  );

  const [mesActual, setMesActual] = useState<Date>(() => inicioMesLocal(hoy));
  const [diaSeleccionado, setDiaSeleccionado] = useState<Date>(() => hoy);

  // Rango del mes para la query de reservas (cacheada por desde/hasta).
  const rangoMes = useMemo(
    () => ({
      desde: ymdLocal(inicioMesLocal(mesActual)),
      hasta: ymdLocal(finMesLocal(mesActual)),
    }),
    [mesActual],
  );

  // Lecturas vía TanStack Query (cacheadas).
  const metaQuery = useReservasMeta();
  const reservasMesQuery = useReservasMes(rangoMes.desde, rangoMes.hasta);

  // Escrituras vía mutaciones (la invalidación en onSuccess recachea las listas).
  const saveReserva = useSaveReserva();
  const deleteReserva = useDeleteReserva();

  // Zonas + mesas derivadas de la meta cacheada.
  const zonas = useMemo<Zona[]>(() => metaQuery.data?.zonas ?? [], [metaQuery.data]);
  const mesas = useMemo<Mesa[]>(() => metaQuery.data?.mesas ?? [], [metaQuery.data]);

  // Reservas del mes derivadas de la query (mismo mapeo que antes).
  const reservasMes = useMemo<ReservaUI[]>(() => {
    const rows = reservasMesQuery.data ?? [];
    return rows.map((r: any) => {
      const hora = normalizarHora(String(r?.Hora ?? "00:00"));
      const turno: Turno = turnoPorHora(hora);

      return {
        id: String(r?.ID_Reserva ?? ""),
        diaYMD: String(r?.Dia_YMD ?? ""),
        hora,

        nombre: String(r?.Nombre_Cliente ?? ""),
        telefono: String(r?.Telefono_Cliente ?? ""),
        email: String(r?.Email_Cliente ?? ""),

        comensales: Number(r?.Comensales ?? 1),
        nota: String(r?.Nota ?? ""),
        turno,

        idZona: String(r?.ID_Zona ?? ""),
        zonaNombre: String(r?.Nombre_Zona ?? ""),

        idMesa: String(r?.ID_Mesa ?? ""),
        mesaNombre: String(r?.Numero_Mesa ?? ""),
        capacidadMesa: Number(r?.Capacidad ?? 0),

        estado: String(r?.Estado ?? "ACTIVA"),
      };
    });
  }, [reservasMesQuery.data]);

  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [reservaEditandoId, setReservaEditandoId] = useState<string | null>(null);

  const [form, setForm] = useState<{
    nombreCliente: string;
    telefono: string;
    email: string;
    hora: string;
    comensales: number;
    nota: string;
    idZona: string;
    idMesa: string;
  }>({
    nombreCliente: "",
    telefono: "",
    email: "",
    hora: "14:00",
    comensales: 2,
    nota: "",
    idZona: "",
    idMesa: "",
  });

  const nombreInputRef = useRef<HTMLInputElement>(null);

  const [confirmBorrar, setConfirmBorrar] = useState<{
    open: boolean;
    reserva: ReservaUI | null;
  }>({ open: false, reserva: null });

  const [borrando, setBorrando] = useState(false);

  const hoyClave = ymdLocal(hoy);
  const seleccionadoClave = ymdLocal(diaSeleccionado);
  const celdas = useMemo(() => generarCeldasMesLocal(mesActual), [mesActual]);

  /* =========================================================
     Layout real + Modal mapa
  ========================================================= */
  const [mostrarMapaMesas, setMostrarMapaMesas] = useState(false);
  const [salonsLayout, setSalonsLayout] = useState<Salon[]>([]);
  const emptyMesaMetaById = useMemo(() => ({} as Record<number, MesaMeta>), []);

  useEffect(() => {
    let cancelado = false;

    async function cargarLayout() {
      try {
        const layout = await mesasLoadLayout();
        if (cancelado) return;

        setSalonsLayout(layout ?? []);

        if (!form.idZona && layout?.length) {
          const idZona = parseDbZonaId(layout[0]?.id);
          if (idZona) {
            setForm((p) => ({ ...p, idZona, idMesa: "" }));
          }
        }
      } catch (e) {
        console.error("Error cargando layout:", e);
        if (!cancelado) setSalonsLayout([]);
      }
    }

    void cargarLayout();

    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =========================================================
     Seed del salón por defecto cuando llega la meta (zonas)
  ========================================================= */
  useEffect(() => {
    if (zonas.length > 0 && !form.idZona) {
      setForm((p) => ({ ...p, idZona: zonas[0].idZona, idMesa: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zonas]);

  /* =========================================================
     Errores de carga -> toast
  ========================================================= */
  useEffect(() => {
    if (metaQuery.isError) {
      console.error(metaQuery.error);
      toast.error("Error", "Error al cargar zonas y mesas.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaQuery.isError]);

  useEffect(() => {
    if (reservasMesQuery.isError) {
      console.error(reservasMesQuery.error);
      toast.error("Error", "Error al cargar las reservas.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservasMesQuery.isError]);

  /* =========================================================
     Reservas del día + badges
  ========================================================= */
  const reservasDelDia = useMemo(() => {
    return reservasMes
      .filter((r) => r.diaYMD === seleccionadoClave)
      .sort((a, b) => a.hora.localeCompare(b.hora));
  }, [reservasMes, seleccionadoClave]);

  const reservasPorDia = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reservasMes) {
      if (!estadoBloqueaMesa(r.estado)) continue;
      map.set(r.diaYMD, (map.get(r.diaYMD) ?? 0) + 1);
    }
    return map;
  }, [reservasMes]);

  const zonaSeleccionada = useMemo(
    () => zonas.find((z) => z.idZona === form.idZona) ?? null,
    [zonas, form.idZona],
  );

  const mesaSeleccionada = useMemo(
    () => mesas.find((m) => m.idMesa === form.idMesa) ?? null,
    [mesas, form.idMesa],
  );

  /* =========================
     Acciones
  ========================= */
  function seleccionarDia(fecha: Date) {
    setDiaSeleccionado(fecha);
    setMostrarFormulario(false);
    setReservaEditandoId(null);
    setMostrarMapaMesas(false);
  }

  function irMesAnterior() {
    setMesActual((prev) => sumarMesesLocal(prev, -1));
    setMostrarFormulario(false);
    setReservaEditandoId(null);
    setMostrarMapaMesas(false);
  }

  function irMesSiguiente() {
    setMesActual((prev) => sumarMesesLocal(prev, 1));
    setMostrarFormulario(false);
    setReservaEditandoId(null);
    setMostrarMapaMesas(false);
  }

  function resetFormulario() {
    setForm((p) => ({
      ...p,
      nombreCliente: "",
      telefono: "",
      email: "",
      hora: "14:00",
      comensales: 2,
      nota: "",
      idMesa: "",
    }));
  }

  function abrirFormulario(reserva?: ReservaUI) {
    if (reserva) {
      setReservaEditandoId(reserva.id);
      setForm({
        nombreCliente: reserva.nombre,
        telefono: reserva.telefono,
        email: reserva.email ?? "",
        hora: reserva.hora,
        comensales: reserva.comensales,
        nota: reserva.nota ?? "",
        idZona: reserva.idZona,
        idMesa: reserva.idMesa,
      });
    } else {
      setReservaEditandoId(null);
      resetFormulario();
    }

    setMostrarFormulario(true);
    setMostrarMapaMesas(false);
    setTimeout(() => nombreInputRef.current?.focus(), 0);
  }

  function cerrarFormulario() {
    setMostrarFormulario(false);
    setReservaEditandoId(null);
    setMostrarMapaMesas(false);
    resetFormulario();
  }

  async function guardarReserva(e: React.FormEvent) {
    e.preventDefault();

    if (!form.nombreCliente.trim()) return toast.info("Validación", "El nombre es obligatorio.");
    if (!form.telefono.trim()) return toast.info("Validación", "El teléfono es obligatorio.");

    const emailTrim = form.email.trim();
    if (emailTrim && !emailValido(emailTrim)) {
      return toast.info("Validación", "El email no parece válido.");
    }
    const emailOrNull: string | null = emailTrim ? emailTrim : null;

    if (!form.hora) return toast.info("Validación", "La hora es obligatoria.");
    if (!form.comensales || form.comensales < 1) {
      return toast.info("Validación", "Los comensales son obligatorios.");
    }
    if (!form.idZona) return toast.info("Validación", "Debes elegir un salón.");
    if (!form.idMesa) return toast.info("Validación", "Debes seleccionar una mesa.");

    const turno: Turno = turnoPorHora(form.hora);
    const horaSql = normalizarHora(form.hora);

    // RES-02: se bloquea el doble booking del hueco EXACTO (misma mesa + día + hora), no todo el
    // turno: así una mesa puede reservarse varias veces en el mismo servicio a horas distintas.
    const ocupada = reservasMes.some((r) => {
      if (!estadoBloqueaMesa(r.estado)) return false;
      if (r.diaYMD !== seleccionadoClave) return false;
      if (r.hora !== horaSql) return false;
      if (r.idMesa !== form.idMesa) return false;
      if (reservaEditandoId != null && r.id === reservaEditandoId) return false;
      return true;
    });

    if (ocupada) return toast.error("Error", "Esa mesa ya tiene una reserva a esa hora.");

    try {
      const nombreTrim = form.nombreCliente.trim();
      const telTrim = form.telefono.trim();
      const notaTrim = form.nota?.trim() || "";

      const ok = await saveReserva.mutateAsync({
        idReserva: reservaEditandoId,
        diaYMD: seleccionadoClave,
        hora: horaSql,
        turno: turno as TurnoApi,
        comensales: Number(form.comensales),
        nota: notaTrim ? notaTrim : null,
        estado: "ACTIVA",

        idMesa: form.idMesa,

        nombreCliente: nombreTrim,
        telefono: telTrim || null,
        email: emailOrNull,
        notasCliente: notaTrim || null,
      });

      if (!ok) return toast.error("Error", "No se pudo guardar la reserva.");

      setReservaEditandoId(null);
      setMostrarFormulario(false);
      setMostrarMapaMesas(false);
      resetFormulario();
    } catch (err) {
      console.error(err);
      toast.error("Error", "Error al guardar en BBDD.");
    }
  }

  async function borrarReserva(idReserva: string) {
    try {
      const ok = await deleteReserva.mutateAsync({ idReserva });
      if (!ok) return toast.error("Error", "No se pudo borrar.");

      toast.success?.("OK", "Reserva borrada.");
    } catch (err) {
      console.error(err);
      toast.error("Error", "Error al borrar en BBDD.");
    }
  }

  return (
    <div className="h-full w-full overflow-hidden bg-bg text-fg">
      <div className="flex h-full flex-col gap-3 overflow-hidden p-3 sm:p-4 lg:px-10 lg:py-5">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <CalendarDays className="size-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-fg sm:text-2xl">Reservas</h1>
              <p className="text-sm text-fg-muted">Gestiona las reservas por día.</p>
            </div>
          </div>
          <div className="shrink-0 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg-muted">
            Día: <span className="font-bold text-fg">{seleccionadoClave}</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-sm">
          <button
            onClick={irMesAnterior}
            className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border text-fg-muted transition hover:bg-surface-2 hover:text-fg"
            aria-label="Mes anterior"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>

          <div className="font-extrabold uppercase tracking-widest text-fg">
            {nombreMesYAnioLocal(mesActual)}
          </div>

          <button
            onClick={irMesSiguiente}
            className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border text-fg-muted transition hover:bg-surface-2 hover:text-fg"
            aria-label="Mes siguiente"
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>

        <div className="flex flex-1 gap-6 overflow-hidden">
          <div className="w-[520px] shrink-0 overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="grid grid-cols-7 gap-2 text-center text-xs font-bold text-fg-muted">
              {["L", "M", "X", "J", "V", "S", "D"].map((d) => (
                <div key={d} className="py-1">
                  {d}
                </div>
              ))}
            </div>

            <div className="mt-2 grid grid-cols-7 gap-2">
              {celdas.map(({ fecha, esMes }) => {
                const clave = ymdLocal(fecha);
                const total = reservasPorDia.get(clave) ?? 0;

                const esHoy = clave === hoyClave;
                const esSel = clave === seleccionadoClave;

                return (
                  <button
                    key={clave}
                    onClick={() => seleccionarDia(fecha)}
                    className={[
                      "relative h-20 rounded-xl border p-2 text-left transition",
                      esMes ? "bg-surface" : "bg-surface-2 text-fg-subtle",
                      esSel ? "border-accent ring-2 ring-ring" : "border-border",
                      "hover:bg-surface-2",
                    ].join(" ")}
                    title={clave}
                  >
                    <div className="flex items-center justify-between text-sm font-bold">
                      <span>{fecha.getDate()}</span>
                      {esHoy && <span className="h-2 w-2 rounded-full bg-accent" />}
                    </div>

                    {total > 0 && (
                      <div className="absolute bottom-1 left-1 inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-extrabold text-accent">
                        {total} res
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="font-extrabold tracking-widest">
                  RESERVAS {diaSeleccionado.toLocaleDateString("es-ES")}
                </div>
                <div className="text-xs text-fg-muted">Total: {reservasDelDia.length}</div>
              </div>

              {!mostrarFormulario ? (
                <button
                  onClick={() => abrirFormulario()}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-xs font-bold tracking-widest text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98]"
                >
                  <Plus className="size-4" aria-hidden />
                  AÑADIR RESERVA
                </button>
              ) : (
                <button
                  onClick={cerrarFormulario}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-danger/30 bg-danger-soft px-4 py-2 text-xs font-bold tracking-widest text-danger transition hover:opacity-90 active:scale-[0.98]"
                >
                  <X className="size-4" aria-hidden />
                  CERRAR
                </button>
              )}
            </div>

            <div className="flex-1 overflow-hidden overflow-y-auto">
              {mostrarFormulario ? (
                <div className="relative h-full">
                  <form
                    onSubmit={guardarReserva}
                    className="h-full rounded-xl border border-border bg-surface-2 p-3"
                  >
                    <div className="mb-2 text-xs font-extrabold tracking-widest text-fg-muted">
                      {reservaEditandoId != null
                        ? `MODIFICAR RESERVA (${seleccionadoClave})`
                        : `NUEVA RESERVA (${seleccionadoClave})`}
                    </div>

                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-extrabold tracking-widest text-fg-muted">
                        {turnoLabel(turnoPorHora(form.hora))}
                      </span>

                      <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-bold text-fg-muted">
                        {sessionBadge.rolNombre}:{" "}
                        <span className="font-extrabold">{sessionBadge.usuarioNombre}</span>
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Nombre cliente *
                        </label>
                        <input
                          required
                          ref={nombreInputRef}
                          value={form.nombreCliente}
                          onChange={(e) => setForm((p) => ({ ...p, nombreCliente: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                          placeholder="Ej: Carlos Pérez"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Teléfono *
                        </label>
                        <input
                          required
                          value={form.telefono}
                          onChange={(e) => setForm((p) => ({ ...p, telefono: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                          placeholder="Ej: 600 123 456"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Email (opcional)
                        </label>
                        <input
                          type="email"
                          value={form.email}
                          onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                          placeholder="Ej: cliente@email.com"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Hora *
                        </label>
                        <input
                          type="time"
                          required
                          value={form.hora}
                          onChange={(e) => setForm((p) => ({ ...p, hora: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Comensales *
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          value={form.comensales}
                          onChange={(e) =>
                            setForm((p) => ({ ...p, comensales: Number(e.target.value) }))
                          }
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Nota (opcional)
                        </label>
                        <input
                          value={form.nota}
                          onChange={(e) => setForm((p) => ({ ...p, nota: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                          placeholder="Ej: Cumpleaños, trona..."
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Salón *
                        </label>
                        <select
                          required
                          value={form.idZona || ""}
                          onChange={(e) => {
                            const idZona = e.target.value;
                            setForm((p) => ({ ...p, idZona, idMesa: "" }));
                          }}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                        >
                          {zonas.map((z) => (
                            <option key={z.idZona} value={z.idZona}>
                              {z.nombre}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Mesa *
                        </label>
                        <div className="flex gap-2">
                          <input
                            readOnly
                            value={mesaSeleccionada ? mesaSeleccionada.nombre : ""}
                            placeholder="Selecciona mesa"
                            onClick={() => setMostrarMapaMesas(true)}
                            className="w-full cursor-pointer rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg-muted outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setMostrarMapaMesas(true)}
                            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white shadow-sm transition hover:bg-accent-hover"
                          >
                            <MapIcon className="size-4" aria-hidden />
                            VISUALIZAR
                          </button>
                        </div>

                        <div className="mt-1 text-[11px] text-fg-muted">
                          Salón: <b>{zonaSeleccionada?.nombre ?? "-"}</b> · Turno:{" "}
                          <b>{turnoLabel(turnoPorHora(form.hora))}</b>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={cerrarFormulario}
                        className="cursor-pointer rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-bold text-danger transition hover:opacity-90"
                      >
                        CANCELAR
                      </button>

                      <button
                        type="submit"
                        className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white shadow-sm transition hover:bg-accent-hover"
                      >
                        {reservaEditandoId != null ? "GUARDAR CAMBIOS" : "GUARDAR"}
                      </button>
                    </div>
                  </form>

                  <ReservaMesaMapModal
                    open={mostrarMapaMesas}
                    onClose={() => setMostrarMapaMesas(false)}
                    salons={salonsLayout}
                    activeSalonId={
                      form.idZona ? `db-zona-${form.idZona}` : salonsLayout[0]?.id ?? ""
                    }
                    onChangeSalon={(salonIdRaw) => {
                      const zonaId = parseDbZonaId(salonIdRaw);
                      if (!zonaId) {
                        console.error("ID de salón inválido desde mapa:", salonIdRaw);
                        return;
                      }
                      setForm((p) => ({ ...p, idZona: zonaId, idMesa: "" }));
                    }}
                    mesaMetaById={emptyMesaMetaById}
                    onSelectMesa={(mesaIdRaw) => {
                      const idMesa = parseDbMesaId(mesaIdRaw);
                      if (!idMesa) {
                        console.error("ID de mesa inválido desde mapa:", mesaIdRaw);
                        return;
                      }
                      setForm((p) => ({ ...p, idMesa }));
                    }}
                  />
                </div>
              ) : reservasDelDia.length === 0 ? (
                <div className="text-sm text-fg-muted">No hay reservas para este día.</div>
              ) : (
                <div className="h-full overflow-y-auto space-y-3 pr-2">
                  {reservasDelDia.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-stretch justify-between gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm"
                    >
                      <div className="flex min-w-0 gap-4">
                        <div className="flex w-[92px] flex-col items-center justify-center rounded-xl bg-accent px-3 py-2 text-white">
                          <div className="text-[11px] font-semibold tracking-wider text-white/70">
                            HORA
                          </div>
                          <div className="text-lg font-extrabold tracking-wide">{r.hora}</div>
                          <div className="mt-1 rounded-md border border-white/30 bg-white/15 px-2 py-0.5 text-[10px] font-extrabold tracking-widest text-white">
                            {turnoLabel(r.turno)}
                          </div>
                        </div>

                        <div className="min-w-0 py-0.5">
                          <div className="truncate text-lg font-extrabold text-fg">
                            {r.nombre}
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                              <Users className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                              {r.comensales} comensales
                            </span>

                            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                              <Phone className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                              {r.telefono}
                            </span>

                            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                              <Mail className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                              {r.email}
                            </span>

                            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                              <Armchair className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                              {r.zonaNombre} · {r.mesaNombre}
                            </span>
                          </div>

                          <div className="mt-2 text-xs font-semibold text-fg-muted">
                            Estado: <span className="text-fg-muted">{r.estado}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => abrirFormulario(r)}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-border bg-surface px-4 py-2 text-xs font-extrabold tracking-widest text-fg transition hover:bg-surface-2"
                        >
                          <Pencil className="size-3.5" aria-hidden />
                          MODIFICAR
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmBorrar({ open: true, reserva: r })}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-4 py-2 text-xs font-extrabold tracking-widest text-danger transition hover:opacity-90"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                          BORRAR
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {confirmBorrar.open && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => (borrando ? null : setConfirmBorrar({ open: false, reserva: null }))}
            >
              <div
                className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-lg font-extrabold tracking-widest text-fg">
                  ¿Borrar esta reserva?
                </div>

                <div className="mt-2 text-sm text-fg-muted">
                  Esta acción no se puede deshacer.
                </div>

                {confirmBorrar.reserva && (
                  <div className="mt-4 space-y-2 rounded-xl border border-border bg-surface-2 p-3">
                    <div className="text-sm font-bold text-fg truncate">
                      {confirmBorrar.reserva.nombre}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-semibold text-fg-muted">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
                        <Clock className="size-3.5" aria-hidden />
                        {confirmBorrar.reserva.hora} · {turnoLabel(confirmBorrar.reserva.turno)}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
                        <Armchair className="size-3.5" aria-hidden />
                        {confirmBorrar.reserva.zonaNombre} · {confirmBorrar.reserva.mesaNombre}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
                        <Users className="size-3.5" aria-hidden />
                        {confirmBorrar.reserva.comensales} comensales
                      </span>
                    </div>
                  </div>
                )}

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={borrando}
                    onClick={() => setConfirmBorrar({ open: false, reserva: null })}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-surface-2 disabled:opacity-60"
                  >
                    CANCELAR
                  </button>

                  <button
                    type="button"
                    disabled={borrando || !confirmBorrar.reserva}
                    onClick={async () => {
                      const res = confirmBorrar.reserva;
                      if (!res) return;

                      setBorrando(true);
                      try {
                        await borrarReserva(res.id);
                        setConfirmBorrar({ open: false, reserva: null });
                      } finally {
                        setBorrando(false);
                      }
                    }}
                    className="rounded-lg bg-danger px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:bg-danger disabled:opacity-60"
                  >
                    {borrando ? "BORRANDO..." : "BORRAR"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
