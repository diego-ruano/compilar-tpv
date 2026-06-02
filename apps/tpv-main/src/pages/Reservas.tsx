import { useEffect, useMemo, useRef, useState } from "react";
import {
  reservasGetMeta,
  reservasGetMes,
  reservasSave,
  reservasDelete,
  type Turno as TurnoApi,
} from "../components/reservas/reservasApis";
import { mesasLoadLayout } from "../components/mesasComponents/mesasApi";

import { useAuth } from "../zustand/useAuth";
import { useToast } from "../components/toast";

// ✅ Modal + tipos del layout (MapCanvas)
import ReservaMesaMapModal from "../components/reservas/ReservaMesaMapModal";
import type { Salon, MesaMeta } from "../components/mesasComponents/types";

/* =========================
   Tipos
========================= */
type Turno = "DESAYUNO" | "COMIDA" | "CAFE" | "CENA";

type Zona = { idZona: number; nombre: string };
type Mesa = {
  idMesa: number;
  idZona: number;
  nombre: string;
  capacidad: number;
};

type ReservaUI = {
  id: number;
  diaYMD: string;
  hora: string;

  nombre: string;
  telefono: string;
  email: string;

  comensales: number;
  nota: string;

  turno: Turno;

  idZona: number;
  zonaNombre: string;

  idMesa: number;
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
  if (e === "noshow") return false;
  return true;
}

function parseDbZonaId(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  if (s.startsWith("db-zona-")) {
    const n = Number(s.replace("db-zona-", ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDbMesaId(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  if (s.startsWith("db-mesa-")) {
    const n = Number(s.replace("db-mesa-", ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
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

  const [zonas, setZonas] = useState<Zona[]>([]);
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [reservasMes, setReservasMes] = useState<ReservaUI[]>([]);

  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [reservaEditandoId, setReservaEditandoId] = useState<number | null>(null);

  const [form, setForm] = useState({
    nombreCliente: "",
    telefono: "",
    email: "",
    hora: "14:00",
    comensales: 2,
    nota: "",
    idZona: 0,
    idMesa: 0,
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

        if ((!form.idZona || form.idZona === 0) && layout?.length) {
          const idZona = parseDbZonaId(layout[0]?.id);
          if (idZona) {
            setForm((p) => ({ ...p, idZona, idMesa: 0 }));
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
     Cargar zonas + mesas (API)
  ========================================================= */
  useEffect(() => {
    let cancelado = false;

    async function cargarZonasYMesas() {
      const meta = await reservasGetMeta();
      if (cancelado) return;

      setZonas(meta.zonas ?? []);
      setMesas(meta.mesas ?? []);

      if ((meta.zonas?.length ?? 0) > 0 && (!form.idZona || form.idZona === 0)) {
        setForm((p) => ({ ...p, idZona: meta.zonas[0].idZona, idMesa: 0 }));
      }
    }

    cargarZonasYMesas().catch(console.error);
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =========================================================
     Cargar reservas del mes (API)
  ========================================================= */
  async function cargarReservasDelMes(fechaMes: Date) {
    const desde = ymdLocal(inicioMesLocal(fechaMes));
    const hasta = ymdLocal(finMesLocal(fechaMes));

    const rows = await reservasGetMes({ desde, hasta });

    const data: ReservaUI[] = (rows ?? []).map((r: any) => {
      const hora = normalizarHora(String(r?.Hora ?? "00:00"));
      const turno: Turno = turnoPorHora(hora);

      return {
        id: Number(r?.ID_Reserva ?? 0),
        diaYMD: String(r?.Dia_YMD ?? ""),
        hora,

        nombre: String(r?.Nombre_Cliente ?? ""),
        telefono: String(r?.Telefono_Cliente ?? ""),
        email: String(r?.Email_Cliente ?? ""),

        comensales: Number(r?.Comensales ?? 1),
        nota: String(r?.Nota ?? ""),
        turno,

        idZona: Number(r?.ID_Zona ?? 0),
        zonaNombre: String(r?.Nombre_Zona ?? ""),

        idMesa: Number(r?.ID_Mesa ?? 0),
        mesaNombre: String(r?.Numero_Mesa ?? ""),
        capacidadMesa: Number(r?.Capacidad ?? 0),

        estado: String(r?.Estado ?? "ACTIVA"),
      };
    });

    setReservasMes(data);
  }

  useEffect(() => {
    cargarReservasDelMes(mesActual).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesActual]);

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
      idMesa: 0,
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

    const ocupada = reservasMes.some((r) => {
      if (!estadoBloqueaMesa(r.estado)) return false;
      if (r.diaYMD !== seleccionadoClave) return false;
      if (r.turno !== turno) return false;
      if (r.idZona !== form.idZona) return false;
      if (r.idMesa !== form.idMesa) return false;
      if (reservaEditandoId != null && r.id === reservaEditandoId) return false;
      return true;
    });

    if (ocupada) return toast.error("Error", "Esa mesa ya tiene reserva en ese turno.");

    try {
      const nombreTrim = form.nombreCliente.trim();
      const telTrim = form.telefono.trim();
      const notaTrim = form.nota?.trim() || "";
      const horaSql = normalizarHora(form.hora);

      const ok = await reservasSave({
        idReserva: reservaEditandoId,
        diaYMD: seleccionadoClave,
        hora: horaSql,
        turno: turno as TurnoApi,
        comensales: Number(form.comensales),
        nota: notaTrim ? notaTrim : null,
        estado: "ACTIVA",

        idMesa: Number(form.idMesa),

        nombreCliente: nombreTrim,
        telefono: telTrim || null,
        email: emailOrNull,
        notasCliente: notaTrim || null,
      });

      if (!ok) return toast.error("Error", "No se pudo guardar la reserva.");

      await cargarReservasDelMes(mesActual);
      setReservaEditandoId(null);
      setMostrarFormulario(false);
      setMostrarMapaMesas(false);
      resetFormulario();
    } catch (err) {
      console.error(err);
      toast.error("Error", "Error al guardar en BBDD.");
    }
  }

  async function borrarReserva(idReserva: number) {
    try {
      const ok = await reservasDelete({ idReserva: Number(idReserva) });
      if (!ok) return toast.error("Error", "No se pudo borrar.");

      await cargarReservasDelMes(mesActual);
      toast.success?.("OK", "Reserva borrada.");
    } catch (err) {
      console.error(err);
      toast.error("Error", "Error al borrar en BBDD.");
    }
  }

  return (
    <div className="w-full h-full overflow-hidden bg-gris text-gray-800">
      <div className="flex h-full flex-col p-6 overflow-hidden">
        <div className="mb-4 flex items-center justify-between rounded-2xl bg-blanco px-6 py-4 shadow">
          <h1 className="text-xl font-extrabold tracking-widest">RESERVAS</h1>
          <div className="text-sm text-gray-500">
            Día: <span className="font-bold text-gray-800">{seleccionadoClave}</span>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between rounded-2xl bg-blanco px-4 py-3 shadow">
          <button
            onClick={irMesAnterior}
            className="rounded-lg border border-gray-200 px-3 py-1 hover:bg-gris-100"
            aria-label="Mes anterior"
          >
            ←
          </button>

          <div className="font-extrabold uppercase tracking-widest">
            {nombreMesYAnioLocal(mesActual)}
          </div>

          <button
            onClick={irMesSiguiente}
            className="rounded-lg border border-gray-200 px-3 py-1 hover:bg-gris-100"
            aria-label="Mes siguiente"
          >
            →
          </button>
        </div>

        <div className="flex flex-1 gap-6 overflow-hidden">
          <div className="w-[520px] shrink-0 overflow-hidden rounded-2xl bg-blanco p-4 shadow">
            <div className="grid grid-cols-7 gap-2 text-center text-xs font-bold text-gray-500">
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
                      esMes ? "bg-blanco" : "bg-gris-50 text-gray-400",
                      esSel ? "border-green-500 ring-2 ring-green-200" : "border-gray-200",
                      "hover:bg-gris-100",
                    ].join(" ")}
                    title={clave}
                  >
                    <div className="flex items-center justify-between text-sm font-bold">
                      <span>{fecha.getDate()}</span>
                      {esHoy && <span className="h-2 w-2 rounded-full bg-green-500" />}
                    </div>

                    {total > 0 && (
                      <div className="absolute bottom-1 left-1 inline-flex items-center rounded-md bg-green-100 px-1.5 py-0.5 text-[10px] font-extrabold text-green-700">
                        {total} res
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-1 flex-col overflow-hidden rounded-2xl bg-blanco p-4 shadow">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="font-extrabold tracking-widest">
                  RESERVAS {diaSeleccionado.toLocaleDateString("es-ES")}
                </div>
                <div className="text-xs text-gray-500">Total: {reservasDelDia.length}</div>
              </div>

              {!mostrarFormulario ? (
                <button
                  onClick={() => abrirFormulario()}
                  className="rounded-full bg-green-700 px-4 py-2 text-xs font-bold tracking-widest text-white hover:bg-gris-800"
                >
                  AÑADIR RESERVA
                </button>
              ) : (
                <button
                  onClick={cerrarFormulario}
                  className="rounded-full border border-gray-200 bg-red-700 px-4 py-2 text-xs font-bold tracking-widest text-blanco hover:bg-gris-50"
                >
                  CERRAR
                </button>
              )}
            </div>

            <div className="flex-1 overflow-hidden overflow-y-auto">
              {mostrarFormulario ? (
                <div className="relative h-full">
                  <form
                    onSubmit={guardarReserva}
                    className="h-full rounded-xl border border-gray-200 bg-gris-50 p-3"
                  >
                    <div className="mb-2 text-xs font-extrabold tracking-widest text-gray-600">
                      {reservaEditandoId != null
                        ? `MODIFICAR RESERVA (${seleccionadoClave})`
                        : `NUEVA RESERVA (${seleccionadoClave})`}
                    </div>

                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-gris-900 px-3 py-1 text-xs font-extrabold tracking-widest text-gray-700">
                        {turnoLabel(turnoPorHora(form.hora))}
                      </span>

                      <span className="rounded-full border border-gray-200 bg-blanco px-3 py-1 text-xs font-bold text-gray-700">
                        {sessionBadge.rolNombre}:{" "}
                        <span className="font-extrabold">{sessionBadge.usuarioNombre}</span>
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Nombre cliente *
                        </label>
                        <input
                          required
                          ref={nombreInputRef}
                          value={form.nombreCliente}
                          onChange={(e) => setForm((p) => ({ ...p, nombreCliente: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                          placeholder="Ej: Carlos Pérez"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Teléfono *
                        </label>
                        <input
                          required
                          value={form.telefono}
                          onChange={(e) => setForm((p) => ({ ...p, telefono: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                          placeholder="Ej: 600 123 456"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Email (opcional)
                        </label>
                        <input
                          type="email"
                          value={form.email}
                          onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                          placeholder="Ej: cliente@email.com"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Hora *
                        </label>
                        <input
                          type="time"
                          required
                          value={form.hora}
                          onChange={(e) => setForm((p) => ({ ...p, hora: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
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
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Nota (opcional)
                        </label>
                        <input
                          value={form.nota}
                          onChange={(e) => setForm((p) => ({ ...p, nota: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                          placeholder="Ej: Cumpleaños, trona..."
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Salón *
                        </label>
                        <select
                          required
                          value={form.idZona || ""}
                          onChange={(e) => {
                            const idZona = Number(e.target.value);
                            setForm((p) => ({ ...p, idZona, idMesa: 0 }));
                          }}
                          className="w-full rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-sm outline-none focus:border-green-400"
                        >
                          {zonas.map((z) => (
                            <option key={z.idZona} value={z.idZona}>
                              {z.nombre}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-gray-600">
                          Mesa *
                        </label>
                        <div className="flex gap-2">
                          <input
                            readOnly
                            value={mesaSeleccionada ? mesaSeleccionada.nombre : ""}
                            placeholder="Selecciona mesa"
                            onClick={() => setMostrarMapaMesas(true)}
                            className="w-full cursor-pointer rounded-lg border border-gray-200 bg-gris-100 px-3 py-2 text-sm text-gray-700 outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setMostrarMapaMesas(true)}
                            className="rounded-lg bg-black px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:bg-gris-800"
                          >
                            VISUALIZAR
                          </button>
                        </div>

                        <div className="mt-1 text-[11px] text-gray-500">
                          Salón: <b>{zonaSeleccionada?.nombre ?? "-"}</b> · Turno:{" "}
                          <b>{turnoLabel(turnoPorHora(form.hora))}</b>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={cerrarFormulario}
                        className="rounded-lg border border-gray-200 bg-red-700 px-3 py-2 text-xs font-bold text-blanco hover:bg-gris-50"
                      >
                        CANCELAR
                      </button>

                      <button
                        type="submit"
                        className="rounded-lg bg-green-600 px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:bg-green-700"
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
                      setForm((p) => ({ ...p, idZona: zonaId, idMesa: 0 }));
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
                <div className="text-sm text-gray-500">No hay reservas para este día.</div>
              ) : (
                <div className="h-full overflow-y-auto space-y-3 pr-2">
                  {reservasDelDia.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-stretch justify-between gap-4 rounded-2xl border border-gray-200 bg-blanco p-4 shadow-sm"
                    >
                      <div className="flex min-w-0 gap-4">
                        <div className="flex w-[92px] flex-col items-center justify-center rounded-xl bg-black px-3 py-2 text-white">
                          <div className="text-[11px] font-semibold tracking-wider text-white/70">
                            HORA
                          </div>
                          <div className="text-lg font-extrabold tracking-wide">{r.hora}</div>
                          <div className="mt-1 rounded-md bg-blanco/10 px-2 py-0.5 text-[10px] font-extrabold tracking-widest">
                            {turnoLabel(r.turno)}
                          </div>
                        </div>

                        <div className="min-w-0 py-0.5">
                          <div className="truncate text-lg font-extrabold text-gray-900">
                            {r.nombre}
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gris-50 px-3 py-1 text-sm font-semibold text-gray-800">
                              <span className="mr-2 text-gray-500">👥</span>
                              {r.comensales} comensales
                            </span>

                            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gris-50 px-3 py-1 text-sm font-semibold text-gray-800">
                              <span className="mr-2 text-gray-500">📞</span>
                              {r.telefono}
                            </span>

                            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gris-50 px-3 py-1 text-sm font-semibold text-gray-800">
                              <span className="mr-2 text-gray-500">✉️</span>
                              {r.email}
                            </span>

                            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gris-50 px-3 py-1 text-sm font-semibold text-gray-800">
                              <span className="mr-2 text-gray-500">🪑</span>
                              {r.zonaNombre} · {r.mesaNombre}
                            </span>
                          </div>

                          <div className="mt-2 text-xs font-semibold text-gray-500">
                            Estado: <span className="text-gray-700">{r.estado}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => abrirFormulario(r)}
                          className="rounded-xl bg-gris-100 px-4 py-2 text-xs font-extrabold tracking-widest text-gray-800 hover:bg-gris-200"
                        >
                          MODIFICAR
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmBorrar({ open: true, reserva: r })}
                          className="rounded-xl bg-red-100 px-4 py-2 text-xs font-extrabold tracking-widest text-red-700 hover:bg-red-200"
                        >
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
                className="w-full max-w-md rounded-2xl bg-blanco p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-lg font-extrabold tracking-widest text-gray-900">
                  ¿Borrar esta reserva?
                </div>

                <div className="mt-2 text-sm text-gray-600">
                  Esta acción no se puede deshacer.
                </div>

                {confirmBorrar.reserva && (
                  <div className="mt-4 space-y-2 rounded-xl border border-gray-200 bg-gris-50 p-3">
                    <div className="text-sm font-bold text-gray-900 truncate">
                      {confirmBorrar.reserva.nombre}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-semibold text-gray-700">
                      <span className="rounded-full border border-gray-200 bg-blanco px-3 py-1">
                        🕒 {confirmBorrar.reserva.hora} · {turnoLabel(confirmBorrar.reserva.turno)}
                      </span>
                      <span className="rounded-full border border-gray-200 bg-blanco px-3 py-1">
                        🪑 {confirmBorrar.reserva.zonaNombre} · {confirmBorrar.reserva.mesaNombre}
                      </span>
                      <span className="rounded-full border border-gray-200 bg-blanco px-3 py-1">
                        👥 {confirmBorrar.reserva.comensales} comensales
                      </span>
                    </div>
                  </div>
                )}

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={borrando}
                    onClick={() => setConfirmBorrar({ open: false, reserva: null })}
                    className="rounded-lg border border-gray-200 bg-blanco px-3 py-2 text-xs font-bold text-gray-800 hover:bg-gris-50 disabled:opacity-60"
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
                    className="rounded-lg bg-red-700 px-3 py-2 text-xs font-extrabold tracking-widest text-blanco hover:bg-red-800 disabled:opacity-60"
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