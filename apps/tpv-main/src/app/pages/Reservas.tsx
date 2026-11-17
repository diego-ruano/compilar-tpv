import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
  Globe,
  Ban,
} from "lucide-react";

import { commands, esError, toAppError } from "@tpv/client";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { etiquetaDuracion, horaFin, opcionesDuracion } from "../../features/reservas/duracion";
import type { ReservaDto as ReservaUI, ZonaDto as Zona, MesaDto as Mesa, ClienteCoincidente } from "@tpv/contracts";
import {
  useReservasMeta,
  useReservasMes,
  useSaveReserva,
  useDeleteReserva,
  useCancelarReserva,
} from "../../features/reservas/reservasQueries";
import { mesasLoadLayout } from "../../features/mesas/mesasApi";

import { useAuth } from "../../shared/stores/useAuth";
import { useToast } from "../../shared/toast";
import { captureException } from "../../shared/observability/sentry";

// ✅ Modal + tipos del layout (MapCanvas)
import ReservaMesaMapModal from "../../features/reservas/ReservaMesaMapModal";
import {
  cambiaParaElCliente,
  cancelarLeEscribe,
  correoTrasGuardar,
  esWebPorVenir,
} from "../../features/reservas/reservaWeb";
import { etiquetaEstado, ocupaMesa, ordenarDelDia, resumenDelDia } from "../../features/reservas/estadoReserva";
import { diaAlCambiarDeMes, mismoMes } from "../../features/reservas/calendario";
import type { MesaMetaOut } from "@tpv/contracts";
import type { Salon } from "../../features/mesas/types";
import { conAviso } from "../../shared/lib/conAviso";
import { hoyEnElNegocio } from "../../shared/lib/diaDelNegocio";
import { useMesasMesaMeta } from "../../features/mesas/mesasQueries";
import { comandaImpideReservar, mesasConComandaHoy } from "../../features/reservas/comandaAbierta";
import {
  clienteSinTocar,
  formDeReserva,
  motivoParaNoGuardar,
  rebasar,
  vistoDe,
  type FormReserva,
} from "../../features/reservas/edicion";

/* =========================
   Tipos
========================= */
type Turno = "DESAYUNO" | "COMIDA" | "CAFE" | "CENA";

/** RI-61: la respuesta a «este teléfono es de Ana, ¿la reserva es para ella?». */
type DecisionCliente = "asignar" | "nuevo" | "ninguno" | "cancelar";

/**
 * Los campos del cliente que viajan con la reserva (ver `ReservaSaveInput`), y el correo que ya
 * tiene el cliente asignado: con él se sabe a dónde irá el aviso de un cambio (`correoTrasGuardar`).
 */
type ClienteDeLaReserva = {
  idCliente: string | null;
  nombreCliente: string | null;
  telefono: string | null;
  email: string | null;
  correoDelExistente: string | null;
};

const SIN_CLIENTE: ClienteDeLaReserva = {
  idCliente: null,
  nombreCliente: null,
  telefono: null,
  email: null,
  correoDelExistente: null,
};

/**
 * Lo que se enseña cuando falla guardar o borrar (RI-84): el `message` del backend, que ya viene
 * escrito para la persona (una mesa ocupada, un email que ya es de otro cliente, la Main sin
 * conexión…). Un fallo del motor llega con su texto técnico: se enseña también, detrás de una frase
 * que se entienda.
 */
function textoDelError(err: unknown) {
  const { code, message } = toAppError(err);
  return code === "repository" ? `Fallo de la base de datos: ${message}` : message;
}

/** «ana gómez» y «Ana Gomez» son la misma persona a efectos de no preguntar. */
function mismoNombre(a: string, b: string) {
  return a.trim().localeCompare(b.trim(), "es", { sensitivity: "base" }) === 0;
}

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

const HORAS_RESERVA = Array.from({ length: 288 }, (_, i) => {
  const minutos = i * 5;
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
});

function HoraSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (hora: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [posicion, setPosicion] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const campoRef = useRef<HTMLDivElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);
  const seleccionRef = useRef<HTMLButtonElement>(null);
  const opciones = HORAS_RESERVA.includes(value) || !value ? HORAS_RESERVA : [value, ...HORAS_RESERVA];

  useEffect(() => {
    if (!abierto) return;
    const cerrarFuera = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!campoRef.current?.contains(target) && !listaRef.current?.contains(target)) {
        setAbierto(false);
      }
    };
    document.addEventListener("pointerdown", cerrarFuera);
    return () => document.removeEventListener("pointerdown", cerrarFuera);
  }, [abierto]);

  useEffect(() => {
    if (!abierto || !seleccionRef.current || !listaRef.current) return;
    const lista = listaRef.current;
    const seleccion = seleccionRef.current;
    lista.scrollTop = Math.max(
      0,
      seleccion.offsetTop - lista.clientHeight / 2 + seleccion.clientHeight / 2,
    );
  }, [abierto, posicion]);

  useEffect(() => {
    if (!abierto) return;

    const recolocar = () => {
      const rect = campoRef.current?.getBoundingClientRect();
      if (!rect) return;

      const margen = 16;
      const separacion = 4;
      const alturaDeseada = Math.min(192, opciones.length * 40 + 8);
      const espacioAbajo = window.innerHeight - rect.bottom - margen - separacion;
      const maxHeight = Math.max(1, Math.min(alturaDeseada, espacioAbajo));
      const width = Math.min(rect.width, window.innerWidth - margen * 2);
      const left = Math.min(Math.max(margen, rect.left), window.innerWidth - margen - width);

      setPosicion({
        top: rect.bottom + separacion,
        left,
        width,
        maxHeight,
      });
    };

    const frame = requestAnimationFrame(recolocar);
    window.addEventListener("resize", recolocar);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", recolocar);
    };
  }, [abierto, opciones.length]);

  return (
    <div ref={campoRef} className="relative w-full max-w-[14rem]">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={abierto}
        onClick={() => setAbierto((actual) => !actual)}
        className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm text-fg outline-none focus:border-accent"
      >
        <span>{value || "Selecciona una hora"}</span>
        <ChevronDown className="size-4 shrink-0 text-fg-muted" aria-hidden />
      </button>

      {abierto ? (
        <div
          ref={listaRef}
          role="listbox"
          aria-label="Horas disponibles"
          style={
            posicion
              ? {
                  position: "fixed",
                  top: posicion.top,
                  left: posicion.left,
                  width: posicion.width,
                  height: posicion.maxHeight,
                  maxHeight: posicion.maxHeight,
                  overflowY: "scroll",
                  overscrollBehavior: "contain",
                  scrollbarGutter: "stable",
                }
              : { position: "fixed", top: 0, left: 0, visibility: "hidden" }
          }
          className="z-50 rounded-lg border border-border bg-surface p-1 shadow-xl"
        >
          {opciones.map((hora) => (
            <button
              key={hora}
              ref={hora === value ? seleccionRef : undefined}
              type="button"
              role="option"
              aria-selected={hora === value}
              onClick={() => {
                onChange(hora);
                setAbierto(false);
              }}
              className={`w-full rounded-md px-3 py-1.5 text-left text-sm transition ${
                hora === value ? "bg-accent text-white" : "text-fg hover:bg-surface-2"
              }`}
            >
              {hora}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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

function turnoLabel(t: string | null) {
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

/** La pastilla del estado: las vivas en color, las cerradas en gris salvo la cancelada. */
function claseEstado(estado: string) {
  if (estado === "PROXIMA") return "border-accent/30 bg-accent-soft text-accent";
  if (estado === "ACTIVA") return "border-success/30 bg-success-soft text-success";
  if (estado === "CANCELADA") return "border-danger/30 bg-danger-soft text-danger";
  return "border-border bg-surface-2 text-fg-muted";
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
  const cancelarReservaMut = useCancelarReserva();

  // Zonas + mesas derivadas de la meta cacheada.
  const zonas = useMemo<Zona[]>(() => metaQuery.data?.zonas ?? [], [metaQuery.data]);
  const mesas = useMemo<Mesa[]>(() => metaQuery.data?.mesas ?? [], [metaQuery.data]);

  const reservasMes = useMemo(() => reservasMesQuery.data ?? [], [reservasMesQuery.data]);

  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [reservaEditandoId, setReservaEditandoId] = useState<string | null>(null);

  const [form, setForm] = useState<FormReserva>({
    nombreCliente: "",
    telefono: "",
    email: "",
    hora: "14:00",
    comensales: 2,
    duracionMin: null,
    nota: "",
    idZona: "",
    idMesa: "",
  });

  const nombreInputRef = useRef<HTMLInputElement>(null);

  // RI-61: el cliente que ya tenía la reserva que se edita, para no volver a preguntar si no se
  // tocan sus datos. Y la pregunta «este teléfono es de Ana, ¿es ella?», que espera respuesta.
  const [clienteAsignado, setClienteAsignado] = useState<{
    id: string;
    nombre: string;
    telefono: string;
    email: string;
  } | null>(null);
  const [preguntaCliente, setPreguntaCliente] = useState<{
    coincidente: ClienteCoincidente;
    responder: (d: DecisionCliente) => void;
  } | null>(null);
  // RI-61: «esa mesa ya tiene una reserva de 21:00 a 23:00. ¿Guardar igualmente?».
  const [avisoSolape, setAvisoSolape] = useState<{
    mensaje: string;
    responder: (guardar: boolean) => void;
  } | null>(null);
  // Reservas desde la web (docs/estudios/reservas-web.md §5.6): cambiar una que está por venir le
  // manda un correo al cliente. Se pregunta antes.
  const [avisoWeb, setAvisoWeb] = useState<{ responder: (seguir: boolean) => void } | null>(null);
  const duracionDefecto = useBusinessSettings((s) => s.reserva_duracion_min);

  // Cancelar la deja en la lista, cancelada; borrar la quita. Una reserva web no se borra nunca, y
  // cancelar una que está por venir le escribe al cliente (docs/estudios/reservas-web.md §5.6).
  const [confirmar, setConfirmar] = useState<{ accion: "cancelar" | "borrar"; reserva: ReservaUI } | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const webPorVenir = confirmar?.accion === "cancelar" && esWebPorVenir(confirmar.reserva);
  const avisaAlCliente = confirmar?.accion === "cancelar" && cancelarLeEscribe(confirmar.reserva);

  const hoyClave = ymdLocal(hoy);
  const seleccionadoClave = ymdLocal(diaSeleccionado);
  const celdas = useMemo(() => generarCeldasMesLocal(mesActual), [mesActual]);

  /* =========================================================
     Layout real + Modal mapa
  ========================================================= */
  const [mostrarMapaMesas, setMostrarMapaMesas] = useState(false);
  const [salonsLayout, setSalonsLayout] = useState<Salon[]>([]);

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
        if (!cancelado) {
          toast.error("No se pudo cargar el plano", toAppError(e).message);
          setSalonsLayout([]);
        }
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
      setForm((p) => ({ ...p, idZona: zonas[0].id_zona, idMesa: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zonas]);

  /* =========================================================
     Errores de carga -> toast
  ========================================================= */
  useEffect(() => {
    if (metaQuery.isError) {
      toast.error("No se pudieron cargar las zonas y mesas", toAppError(metaQuery.error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaQuery.isError]);

  useEffect(() => {
    if (reservasMesQuery.isError) {
      toast.error("No se pudieron cargar las reservas", toAppError(reservasMesQuery.error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservasMesQuery.isError]);

  /* =========================================================
     Reservas del día + badges
  ========================================================= */
  // Las canceladas, terminadas y de clientes que no vinieron siguen en la lista, atenuadas y al
  // final; el calendario y el total cuentan sólo las vivas.
  const reservasDelDia = useMemo(
    () => ordenarDelDia(reservasMes.filter((r) => r.dia_ymd === seleccionadoClave)),
    [reservasMes, seleccionadoClave],
  );

  const reservasPorDia = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reservasMes) {
      if (!ocupaMesa(r.estado)) continue;
      map.set(r.dia_ymd, (map.get(r.dia_ymd) ?? 0) + 1);
    }
    return map;
  }, [reservasMes]);

  const zonaSeleccionada = useMemo(
    () => zonas.find((z) => z.id_zona === form.idZona) ?? null,
    [zonas, form.idZona],
  );

  const mesaSeleccionada = useMemo(
    () => mesas.find((m) => m.id_mesa === form.idMesa) ?? null,
    [mesas, form.idMesa],
  );

  // RES-04: una mesa con una comanda abierta no se puede reservar para hoy, a ninguna hora (no se
  // sabe cuándo se irán); para mañana sí. Con el día de hoy, el plano para elegir mesa las enseña
  // ocupadas, como en Mesas, y al elegir una se avisa antes de guardar.
  const zonaDelNegocio = useBusinessSettings((s) => s.zona_horaria);
  const esHoy = seleccionadoClave === hoyEnElNegocio(zonaDelNegocio);
  const metaDeMesas = useMesasMesaMeta({ enabled: mostrarFormulario && esHoy });
  const conComandaHoy = useMemo(() => mesasConComandaHoy(metaDeMesas.data, esHoy), [esHoy, metaDeMesas.data]);
  const reservaEditada = reservaEditandoId ? reservasMes.find((r) => r.id_reserva === reservaEditandoId) : undefined;

  // RES-INC-03 / SYN-INC-04: lo que el formulario tiene por visto de la reserva que edita, y lo que
  // llega de otro equipo mientras tanto: entra en los campos que no se han tocado. Si se cierra, se
  // borra o se mueve de día, se avisa y no se deja guardar (`features/reservas/edicion.ts`).
  const [baseEditada, setBaseEditada] = useState<ReservaUI | null>(null);
  useEffect(() => {
    if (!baseEditada || !reservaEditada || reservaEditada === baseEditada) return;
    if (reservaEditada.dia_ymd !== baseEditada.dia_ymd) return;
    if (clienteSinTocar(form, baseEditada) && reservaEditada.id_cliente !== baseEditada.id_cliente) {
      setClienteAsignado(
        reservaEditada.id_cliente
          ? {
              id: reservaEditada.id_cliente,
              nombre: reservaEditada.nombre_cliente,
              telefono: reservaEditada.telefono_cliente ?? "",
              email: reservaEditada.email_cliente ?? "",
            }
          : null,
      );
    }
    setForm((f) => rebasar(f, baseEditada, reservaEditada));
    setBaseEditada(reservaEditada);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sólo cuando llega otra versión de la reserva
  }, [reservaEditada]);
  const motivoNoGuardar =
    reservaEditandoId && reservasMesQuery.data !== undefined
      ? motivoParaNoGuardar(reservaEditada, seleccionadoClave)
      : null;
  const comandaEnLaMesaElegida = comandaImpideReservar(conComandaHoy, form.idMesa, seleccionadoClave, reservaEditada);

  /* =========================
     Acciones
  ========================= */
  // El día elegido va siempre con el mes que se ve: la lista sale de las reservas del mes cargado.
  function seleccionarDia(fecha: Date) {
    setDiaSeleccionado(fecha);
    // Un día gris es del mes de al lado: se salta a él.
    if (!mismoMes(fecha, mesActual)) setMesActual(inicioMesLocal(fecha));
    setMostrarFormulario(false);
    setReservaEditandoId(null);
    setMostrarMapaMesas(false);
  }

  function irAMes(delta: number) {
    const mes = sumarMesesLocal(mesActual, delta);
    setMesActual(mes);
    setDiaSeleccionado(diaAlCambiarDeMes(mes, new Date()));
    setMostrarFormulario(false);
    setReservaEditandoId(null);
    setMostrarMapaMesas(false);
  }

  const irMesAnterior = () => irAMes(-1);
  const irMesSiguiente = () => irAMes(1);

  function resetFormulario() {
    setClienteAsignado(null);
    setForm((p) => ({
      ...p,
      nombreCliente: "",
      telefono: "",
      email: "",
      hora: "14:00",
      comensales: 2,
      duracionMin: null,
      nota: "",
      idMesa: "",
    }));
  }

  function abrirFormulario(reserva?: ReservaUI) {
    setBaseEditada(reserva ?? null);
    if (reserva) {
      setReservaEditandoId(reserva.id_reserva);
      setClienteAsignado(
        reserva.id_cliente
          ? {
              id: reserva.id_cliente,
              nombre: reserva.nombre_cliente,
              telefono: reserva.telefono_cliente ?? "",
              email: reserva.email_cliente ?? "",
            }
          : null,
      );
      setForm(formDeReserva(reserva));
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
    setBaseEditada(null);
    setMostrarMapaMesas(false);
    resetFormulario();
  }

  function confirmarSolape(mensaje: string): Promise<boolean> {
    return new Promise((resolve) => {
      setAvisoSolape({
        mensaje,
        responder: (guardar) => {
          setAvisoSolape(null);
          resolve(guardar);
        },
      });
    });
  }

  function confirmarCambioWeb(): Promise<boolean> {
    return new Promise((resolve) => {
      setAvisoWeb({
        responder: (seguir) => {
          setAvisoWeb(null);
          resolve(seguir);
        },
      });
    });
  }

  function preguntarCliente(coincidente: ClienteCoincidente): Promise<DecisionCliente> {
    return new Promise((resolve) => {
      setPreguntaCliente({
        coincidente,
        responder: (d) => {
          setPreguntaCliente(null);
          resolve(d);
        },
      });
    });
  }

  /**
   * RI-61: qué cliente lleva la reserva, o `null` si se cancela el guardado. Una reserva puede no
   * tener cliente, y un teléfono o un email que ya son de otra persona no se le asignan sin
   * preguntar: antes, Luis reservaba con el teléfono de Ana y el calendario decía «Ana».
   */
  async function decidirCliente(): Promise<ClienteDeLaReserva | null> {
    const nombre = form.nombreCliente.trim();
    const telefono = form.telefono.trim();
    const email = form.email.trim();
    const escrito = { telefono: telefono || null, email: email || null };

    // Editando sin tocar los datos del cliente, se queda el que tenía.
    if (
      clienteAsignado &&
      nombre === clienteAsignado.nombre.trim() &&
      telefono === clienteAsignado.telefono.trim() &&
      email === clienteAsignado.email.trim()
    ) {
      return {
        ...escrito,
        idCliente: clienteAsignado.id,
        nombreCliente: null,
        correoDelExistente: clienteAsignado.email || null,
      };
    }
    if (!nombre && !telefono && !email) return SIN_CLIENTE;

    if (telefono || email) {
      const c = await commands.reservasBuscarCliente(escrito);
      if (c) {
        // El mismo cliente (o el que ya tenía la reserva): no hay nada que preguntar.
        const suyo = { ...escrito, idCliente: c.id_cliente, nombreCliente: null, correoDelExistente: c.email ?? null };
        if (c.id_cliente === clienteAsignado?.id || (nombre && mismoNombre(c.nombre, nombre))) return suyo;
        const d = await preguntarCliente(c);
        if (d === "cancelar") return null;
        if (d === "ninguno") return SIN_CLIENTE;
        if (d === "asignar") return suyo;
        // «Es otra persona»: sólo se ofrece por teléfono y con un nombre escrito.
        return { ...escrito, idCliente: null, nombreCliente: nombre, correoDelExistente: null };
      }
    }

    if (!nombre) {
      toast.info(
        "Falta el nombre",
        "Para dar de alta al cliente hace falta su nombre. Si no quieres ficha de cliente, deja vacíos el teléfono y el email.",
      );
      return null;
    }
    return { ...escrito, idCliente: null, nombreCliente: nombre, correoDelExistente: null };
  }

  async function guardarReserva(e: React.FormEvent) {
    e.preventDefault();
    if (motivoNoGuardar) return;

    const emailTrim = form.email.trim();
    if (emailTrim && !emailValido(emailTrim)) {
      return toast.info("Validación", "El email no parece válido.");
    }
    if (!form.hora) return toast.info("Validación", "La hora es obligatoria.");
    if (!form.comensales || form.comensales < 1) {
      return toast.info("Validación", "Los comensales son obligatorios.");
    }
    const turno: Turno = turnoPorHora(form.hora);
    const horaSql = normalizarHora(form.hora);

    const original = reservaEditandoId ? reservasMes.find((r) => r.id_reserva === reservaEditandoId) : undefined;
    const cambio = { dia_ymd: seleccionadoClave, hora: horaSql, comensales: Number(form.comensales), id_mesa: form.idMesa || null };

    // RI-61: si la mesa ya está ocupada a esa hora lo decide el backend, con la duración de cada
    // reserva y el modo del negocio (avisar o prohibir). Aquí sólo se comprobaba la misma hora
    // exacta, y sin preguntar.
    try {
      const cliente = await decidirCliente();
      if (!cliente) return;

      // Una reserva web por venir: si cambia lo que le importa al cliente, le llega un correo. Dice
      // cómo queda, sale si la hora nueva no ha pasado (con ésa se mira «por venir») y va al correo
      // del cliente que lleve la reserva: sin correo no se promete.
      if (
        original &&
        esWebPorVenir({ ...original, dia_ymd: cambio.dia_ymd, hora: cambio.hora }) &&
        cambiaParaElCliente(original, cambio) &&
        correoTrasGuardar(cliente, cliente.correoDelExistente) &&
        !(await confirmarCambioWeb())
      ) {
        return;
      }
      const notaTrim = form.nota?.trim() || "";

      // El estado no viaja: una nueva nace PROXIMA y una que se edita conserva el suyo en la base.
      // Mandar el de la caché devolvía a «por venir» una reserva cancelada o sentada mientras tanto.
      const datos = {
        id_reserva: reservaEditandoId,
        dia_ymd: seleccionadoClave,
        hora: horaSql,
        turno: turno as Turno,
        comensales: Number(form.comensales),
        duracion_min: form.duracionMin,
        nota: notaTrim ? notaTrim : null,

        id_mesa: form.idMesa || null,

        id_cliente: cliente.idCliente,
        nombre_cliente: cliente.nombreCliente,
        telefono: cliente.telefono,
        email: cliente.email,
        // RES-INC-03: el backend no la guarda si ya no está como la tiene el formulario.
        visto: reservaEditandoId && baseEditada ? vistoDe(baseEditada) : null,
      };

      let ok: boolean;
      try {
        ok = await saveReserva.mutateAsync(datos);
      } catch (err) {
        // RI-61: con «permitir con aviso», el backend dice con qué choca y se guarda si se confirma.
        // Con los solapes prohibidos llega como un conflicto normal y cae al aviso de abajo.
        if (!esError(err, "reserva_solapada")) throw err;
        if (!(await confirmarSolape(toAppError(err).message))) return;
        ok = await saveReserva.mutateAsync({ ...datos, forzar_solape: true });
      }

      if (!ok) return toast.error("Error", "No se pudo guardar la reserva.");

      setReservaEditandoId(null);
      setBaseEditada(null);
      setMostrarFormulario(false);
      setMostrarMapaMesas(false);
      resetFormulario();
    } catch (err) {
      toast.error("No se pudo guardar la reserva", textoDelError(err));
    }
  }

  async function borrarReserva(reserva: ReservaUI) {
    try {
      const ok = await deleteReserva.mutateAsync({ id_reserva: reserva.id_reserva });
      // `false` es que no había nada que borrar: otro equipo la borró antes.
      if (!ok) return toast.error("No se pudo borrar la reserva", "Esa reserva ya no existe.");
      toast.success?.("OK", "Reserva borrada.");
    } catch (err) {
      toast.error("No se pudo borrar la reserva", textoDelError(err));
    }
  }

  async function cancelarReserva(reserva: ReservaUI) {
    try {
      const ok = await cancelarReservaMut.mutateAsync({ id_reserva: reserva.id_reserva });
      if (!ok) return toast.error("No se pudo cancelar la reserva", "Esa reserva ya no existe.");
      toast.success?.(
        "OK",
        cancelarLeEscribe(reserva) ? "Reserva cancelada. Se le avisará al cliente por correo." : "Reserva cancelada.",
      );
    } catch (err) {
      toast.error("No se pudo cancelar la reserva", textoDelError(err));
    }
  }

  return (
    <div className="h-full w-full touch-pan-y overflow-y-auto overscroll-contain bg-bg text-fg xl:overflow-hidden">
      <div className="flex min-h-full flex-col gap-3 p-2 pt-3 sm:p-4 lg:px-6 lg:py-5 xl:h-full xl:overflow-hidden">
        <div className="flex flex-col items-stretch gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm xs:flex-row xs:items-center xs:justify-between sm:p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <CalendarDays className="size-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-fg sm:text-2xl">Reservas</h1>
              <p className="text-sm text-fg-muted">Gestiona las reservas por día.</p>
            </div>
          </div>
          <div className="shrink-0 self-end rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-fg-muted xs:self-auto sm:text-sm">
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

          <div className="min-w-0 truncate text-center text-sm font-extrabold uppercase tracking-widest text-fg sm:text-base">
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

        <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row xl:gap-6 xl:overflow-hidden">
          <div className="w-full shrink-0 overflow-hidden rounded-2xl border border-border bg-surface p-2.5 shadow-sm sm:p-4 xl:w-[min(42vw,520px)]">
            <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-fg-muted sm:gap-2">
              {["L", "M", "X", "J", "V", "S", "D"].map((d) => (
                <div key={d} className="py-1">
                  {d}
                </div>
              ))}
            </div>

            <div className="mt-2 grid grid-cols-7 gap-1 sm:gap-2">
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
                      "relative h-[clamp(2.75rem,9vw,5rem)] rounded-lg border p-1.5 text-left transition sm:rounded-xl sm:p-2",
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

          <div className="flex min-h-[34rem] flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4 xl:min-h-0">
            <div className="mb-3 flex flex-col items-stretch gap-3 xs:flex-row xs:items-start xs:justify-between">
              <div>
                <div className="font-extrabold tracking-widest">
                  RESERVAS {diaSeleccionado.toLocaleDateString("es-ES")}
                </div>
                <div className="text-xs text-fg-muted">{resumenDelDia(reservasDelDia)}</div>
              </div>

              {!mostrarFormulario ? (
                <button
                  onClick={() => abrirFormulario()}
                  className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2 text-xs font-bold tracking-widest text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] xs:w-auto"
                >
                  <Plus className="size-4" aria-hidden />
                  AÑADIR RESERVA
                </button>
              ) : (
                <button
                  onClick={cerrarFormulario}
                  className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-danger/30 bg-danger-soft px-4 py-2 text-xs font-bold tracking-widest text-danger transition hover:opacity-90 active:scale-[0.98] xs:w-auto"
                >
                  <X className="size-4" aria-hidden />
                  CERRAR
                </button>
              )}
            </div>

            <div className="flex-1 overflow-hidden overflow-y-auto">
              {mostrarFormulario ? (
                <div className="relative min-h-full">
                  <form
                    onSubmit={conAviso(guardarReserva)}
                    className="min-h-full rounded-xl border border-border bg-surface-2 p-3"
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
                          Nombre del cliente (opcional: sin datos, la reserva va sin cliente)
                        </label>
                        <input
                          ref={nombreInputRef}
                          value={form.nombreCliente}
                          onChange={(e) => setForm((p) => ({ ...p, nombreCliente: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                          placeholder="Ej: Carlos Pérez"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Teléfono (opcional)
                        </label>
                        <input
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
                        <HoraSelect
                          value={form.hora}
                          onChange={(hora) => setForm((p) => ({ ...p, hora }))}
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
                          Duración
                        </label>
                        <select
                          value={form.duracionMin ?? ""}
                          onChange={(e) =>
                            setForm((p) => ({
                              ...p,
                              duracionMin: e.target.value === "" ? null : Number(e.target.value),
                            }))
                          }
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                        >
                          <option value="">
                            La del negocio ({etiquetaDuracion(duracionDefecto)})
                          </option>
                          {opcionesDuracion(form.duracionMin).map((m) => (
                            <option key={m} value={m}>
                              {etiquetaDuracion(m)}
                            </option>
                          ))}
                        </select>
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
                          Salón
                        </label>
                        <select
                          value={form.idZona || ""}
                          onChange={(e) => {
                            const idZona = e.target.value;
                            setForm((p) => ({ ...p, idZona, idMesa: "" }));
                          }}
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent sm:max-w-[14rem]"
                        >
                          {zonas.map((z) => (
                            <option key={z.id_zona} value={z.id_zona}>
                              {z.nombre_zona}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-fg-muted">
                          Mesa (opcional)
                        </label>
                        <div className="flex flex-col gap-2 xs:flex-row">
                          <input
                            readOnly
                            value={mesaSeleccionada ? mesaSeleccionada.numero_mesa : ""}
                            placeholder="Sin mesa asignada"
                            onClick={() => setMostrarMapaMesas(true)}
                            className="w-full cursor-pointer rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg-muted outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setMostrarMapaMesas(true)}
                            className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white shadow-sm transition hover:bg-accent-hover xs:w-auto"
                          >
                            <MapIcon className="size-4" aria-hidden />
                            VISUALIZAR
                          </button>

                          {form.idMesa ? (
                            <button
                              type="button"
                              onClick={() => setForm((p) => ({ ...p, idMesa: "" }))}
                              className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface px-3 py-2 text-xs font-extrabold tracking-widest text-fg-muted transition hover:bg-surface-2 xs:w-auto"
                            >
                              QUITAR
                            </button>
                          ) : null}
                        </div>

                        {comandaEnLaMesaElegida ? (
                          <div role="alert" className="mt-1 text-[11px] font-semibold text-danger">
                            Esa mesa tiene una comanda abierta: hoy no se puede reservar. Elige otra mesa u otro día.
                          </div>
                        ) : null}

                        <div className="mt-1 text-[11px] text-fg-muted">
                          Salón: <b>{form.idMesa ? (zonaSeleccionada?.nombre_zona ?? "-") : "sin mesa"}</b>{" "}
                          · Turno: <b>{turnoLabel(turnoPorHora(form.hora))}</b>
                        </div>
                      </div>
                    </div>

                    {motivoNoGuardar ? (
                      <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
                        {motivoNoGuardar}
                      </div>
                    ) : null}

                    <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
                      <button
                        type="button"
                        onClick={cerrarFormulario}
                        className="cursor-pointer rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-bold text-danger transition hover:opacity-90"
                      >
                        CANCELAR
                      </button>

                      <button
                        type="submit"
                        disabled={!!motivoNoGuardar}
                        className="cursor-pointer rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
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
                        captureException(new Error("ID de salón inválido desde el mapa"), { salonIdRaw });
                        return;
                      }
                      setForm((p) => ({ ...p, idZona: zonaId, idMesa: "" }));
                    }}
                    mesaMetaById={conComandaHoy as unknown as Record<number, MesaMetaOut>}
                    onSelectMesa={(mesaIdRaw) => {
                      const idMesa = parseDbMesaId(mesaIdRaw);
                      if (!idMesa) {
                        captureException(new Error("ID de mesa inválido desde el mapa"), { mesaIdRaw });
                        return;
                      }
                      setForm((p) => ({ ...p, idMesa }));
                    }}
                  />
                </div>
              ) : reservasMesQuery.data === undefined ? (
                // Sin datos del mes todavía: cargando o sin poder leerlos. No es «no hay reservas».
                reservasMesQuery.isError ? (
                  <div className="flex flex-wrap items-center gap-3 text-sm text-danger">
                    No se han podido cargar las reservas.
                    <button
                      type="button"
                      onClick={() => void reservasMesQuery.refetch()}
                      className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-bold text-fg hover:bg-surface-2"
                    >
                      REINTENTAR
                    </button>
                  </div>
                ) : (
                  <div className="text-sm text-fg-muted">Cargando reservas…</div>
                )
              ) : reservasDelDia.length === 0 ? (
                <div className="text-sm text-fg-muted">No hay reservas para este día.</div>
              ) : (
                <div className="h-full overflow-y-auto space-y-3 pr-2">
                  {reservasDelDia.map((r) => {
                    // Cancelada, terminada o sin presentarse: se queda a la vista, atenuada.
                    const viva = ocupaMesa(r.estado);
                    return (
                    <div
                      key={r.id_reserva}
                      className="flex flex-col items-stretch gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm md:flex-row md:justify-between md:gap-4 md:p-4"
                    >
                      <div className={`flex min-w-0 flex-col gap-3 xs:flex-row xs:gap-4 ${viva ? "" : "opacity-60"}`}>
                        <div className={`flex w-full shrink-0 flex-row items-center justify-between rounded-xl bg-accent px-3 py-2 text-white xs:w-[92px] xs:flex-col xs:justify-center ${viva ? "" : "grayscale"}`}>
                          <div className="text-[11px] font-semibold tracking-wider text-white/70">
                            HORA
                          </div>
                          <div className="text-lg font-extrabold tracking-wide">{r.hora}</div>
                          <div className="text-[11px] font-semibold text-white/80">
                            hasta {horaFin(r.hora, r.duracion_min ?? duracionDefecto)}
                          </div>
                          <div className="mt-1 rounded-md border border-white/30 bg-white/15 px-2 py-0.5 text-[10px] font-extrabold tracking-widest text-white">
                            {turnoLabel(r.turno)}
                          </div>
                        </div>

                        <div className="min-w-0 py-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="truncate text-lg font-extrabold text-fg">
                              {r.nombre_cliente}
                            </div>
                            {/* Reservas desde la web (docs/estudios/reservas-web.md): la hizo el cliente. */}
                            {r.origen === "WEB" ? (
                              <span className="inline-flex shrink-0 items-center rounded-full border border-accent/30 bg-accent-soft px-2.5 py-0.5 text-xs font-bold text-accent">
                                <Globe className="mr-1 size-3.5" aria-hidden />
                                Web
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                              <Users className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                              {r.comensales} comensales
                            </span>

                            {r.telefono_cliente ? (
                              <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                                <Phone className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                                {r.telefono_cliente}
                              </span>
                            ) : null}

                            {r.email_cliente ? (
                              <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                                <Mail className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                                {r.email_cliente}
                              </span>
                            ) : null}

                            <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-fg">
                              <Armchair className="mr-1.5 size-4 text-fg-muted" aria-hidden />
                              {r.id_mesa ? `${r.nombre_zona} · ${r.numero_mesa}` : "Sin mesa"}
                            </span>
                          </div>

                          <div className="mt-2">
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${claseEstado(r.estado)}`}>
                              {etiquetaEstado(r.estado)}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="grid shrink-0 grid-cols-2 gap-2 md:flex md:items-center">
                        {/* Una reserva cerrada ya no se cambia. */}
                        {viva ? (
                          <button
                            onClick={() => abrirFormulario(r)}
                            className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-extrabold tracking-widest text-fg transition hover:bg-surface-2 md:px-4"
                          >
                            <Pencil className="size-3.5" aria-hidden />
                            MODIFICAR
                          </button>
                        ) : null}

                        {/* Sólo se cancela la que aún no ha llegado. */}
                        {r.estado === "PROXIMA" ? (
                          <button
                            type="button"
                            onClick={() => setConfirmar({ accion: "cancelar", reserva: r })}
                            className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-extrabold tracking-widest text-fg transition hover:bg-surface-2 md:px-4"
                          >
                            <Ban className="size-3.5" aria-hidden />
                            CANCELAR
                          </button>
                        ) : null}

                        {/* Una reserva web no se borra nunca: se cancela, y se queda (§5.6). */}
                        {r.origen !== "WEB" ? (
                          <button
                            type="button"
                            onClick={() => setConfirmar({ accion: "borrar", reserva: r })}
                            className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-extrabold tracking-widest text-danger transition hover:opacity-90 md:px-4"
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                            BORRAR
                          </button>
                        ) : null}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {avisoSolape && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4"
              onClick={() => avisoSolape.responder(false)}
            >
              <div
                className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-lg font-extrabold text-fg">La mesa está ocupada</div>
                <div className="mt-2 text-sm text-fg-muted">{avisoSolape.mensaje}</div>
                <div className="mt-2 text-sm text-fg-muted">¿Guardar la reserva igualmente?</div>
                <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
                  <button
                    type="button"
                    onClick={() => avisoSolape.responder(false)}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-surface-2"
                  >
                    CANCELAR
                  </button>
                  <button
                    type="button"
                    onClick={() => avisoSolape.responder(true)}
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:opacity-90"
                  >
                    GUARDAR IGUALMENTE
                  </button>
                </div>
              </div>
            </div>
          )}

          {avisoWeb && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4"
              onClick={() => avisoWeb.responder(false)}
            >
              <div
                role="alertdialog"
                aria-labelledby="aviso-web-titulo"
                className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div id="aviso-web-titulo" className="text-lg font-extrabold text-fg">
                  Esta reserva se hizo desde la web
                </div>
                <div className="mt-2 text-sm text-fg-muted">
                  Se enviará un correo al cliente con el cambio. ¿Seguro?
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
                  <button
                    type="button"
                    onClick={() => avisoWeb.responder(false)}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-surface-2"
                  >
                    VOLVER
                  </button>
                  <button
                    type="button"
                    onClick={() => avisoWeb.responder(true)}
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:opacity-90"
                  >
                    GUARDAR Y AVISAR
                  </button>
                </div>
              </div>
            </div>
          )}

          {preguntaCliente && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4"
              onClick={() => preguntaCliente.responder("cancelar")}
            >
              <div
                className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-lg font-extrabold text-fg">
                  ¿La reserva es para {preguntaCliente.coincidente.nombre}?
                </div>

                <div className="mt-2 text-sm text-fg-muted">
                  {preguntaCliente.coincidente.coincide_por === "email"
                    ? `El email ${preguntaCliente.coincidente.email ?? ""}`
                    : `El teléfono ${preguntaCliente.coincidente.telefono ?? ""}`}{" "}
                  ya es de <span className="font-bold text-fg">{preguntaCliente.coincidente.nombre}</span>.
                </div>

                {preguntaCliente.coincidente.coincide_por === "email" ? (
                  <div className="mt-2 text-xs text-fg-muted">
                    Dos clientes no pueden compartir el email. Si es otra persona, cancela y cambia el
                    email o déjalo vacío.
                  </div>
                ) : !form.nombreCliente.trim() ? (
                  <div className="mt-2 text-xs text-fg-muted">
                    Si es otra persona, cancela y escribe su nombre para darla de alta.
                  </div>
                ) : null}

                <div className="mt-5 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => preguntaCliente.responder("asignar")}
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:opacity-90"
                  >
                    SÍ, ES {preguntaCliente.coincidente.nombre.toUpperCase()}
                  </button>
                  {preguntaCliente.coincidente.coincide_por === "telefono" &&
                  form.nombreCliente.trim() ? (
                    <button
                      type="button"
                      onClick={() => preguntaCliente.responder("nuevo")}
                      className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-surface-2"
                    >
                      NO, ES OTRA PERSONA (DAR DE ALTA A {form.nombreCliente.trim().toUpperCase()})
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => preguntaCliente.responder("ninguno")}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-surface-2"
                  >
                    GUARDAR SIN CLIENTE
                  </button>
                  <button
                    type="button"
                    onClick={() => preguntaCliente.responder("cancelar")}
                    className="rounded-lg px-3 py-2 text-xs font-bold text-fg-muted hover:bg-surface-2"
                  >
                    CANCELAR
                  </button>
                </div>
              </div>
            </div>
          )}

          {confirmar && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4"
              onClick={() => (confirmando ? null : setConfirmar(null))}
            >
              <div
                role="alertdialog"
                aria-labelledby="confirmar-titulo"
                className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div id="confirmar-titulo" className="text-lg font-extrabold tracking-widest text-fg">
                  {confirmar.accion === "cancelar" ? "¿Cancelar esta reserva?" : "¿Borrar esta reserva?"}
                </div>

                <div className="mt-2 text-sm text-fg-muted">
                  {confirmar.accion === "borrar"
                    ? "Desaparece del todo. Esta acción no se puede deshacer."
                    : avisaAlCliente
                      ? "Se queda en la lista como cancelada y deja libre la mesa. Se hizo desde la web: al cliente le llegará un correo diciéndole que se ha cancelado."
                      : webPorVenir
                        ? "Se queda en la lista como cancelada y deja libre la mesa. Se hizo desde la web, pero su cliente no tiene correo: no se le avisará."
                        : "Se queda en la lista como cancelada y deja libre la mesa."}
                </div>

                <div className="mt-4 space-y-2 rounded-xl border border-border bg-surface-2 p-3">
                  <div className="text-sm font-bold text-fg truncate">{confirmar.reserva.nombre_cliente}</div>
                  <div className="flex flex-wrap gap-2 text-xs font-semibold text-fg-muted">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
                      <Clock className="size-3.5" aria-hidden />
                      {confirmar.reserva.hora} · {turnoLabel(confirmar.reserva.turno)}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
                      <Armchair className="size-3.5" aria-hidden />
                      {confirmar.reserva.id_mesa
                        ? `${confirmar.reserva.nombre_zona} · ${confirmar.reserva.numero_mesa}`
                        : "Sin mesa"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
                      <Users className="size-3.5" aria-hidden />
                      {confirmar.reserva.comensales} comensales
                    </span>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
                  <button
                    type="button"
                    disabled={confirmando}
                    onClick={() => setConfirmar(null)}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-fg hover:bg-surface-2 disabled:opacity-60"
                  >
                    VOLVER
                  </button>

                  <button
                    type="button"
                    disabled={confirmando}
                    onClick={conAviso(async () => {
                      const { accion, reserva } = confirmar;
                      setConfirmando(true);
                      try {
                        await (accion === "cancelar" ? cancelarReserva(reserva) : borrarReserva(reserva));
                        setConfirmar(null);
                      } finally {
                        setConfirmando(false);
                      }
                    })}
                    className="rounded-lg bg-danger px-3 py-2 text-xs font-extrabold tracking-widest text-white hover:bg-danger disabled:opacity-60"
                  >
                    {confirmar.accion === "cancelar"
                      ? confirmando
                        ? "CANCELANDO..."
                        : "CANCELAR RESERVA"
                      : confirmando
                        ? "BORRANDO..."
                        : "BORRAR"}
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
