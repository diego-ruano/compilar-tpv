import { toAppError } from "@tpv/client";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Users, Plus } from "lucide-react";

import {
  type TrabajadorRow,
  type TurnoRow as Turno,
  type AsignacionRow as Asignacion,
} from "@tpv/contracts";
import {
  useTrabajadores,
  useTurnos,
  useTrabajadorIdByUsuario,
  useAsignacionesSemana,
  useGuardarAsignacion,
  useDeleteAsignacion,
  useCopySemanaAsignaciones,
  useSetPredeterminadoDesdeSemana,
  useMarcarLibre,
} from "../../features/trabajadores/trabajadoresQueries";
import EliminarTrabajadorModal from "../../features/trabajadores/EliminarTrabajadorModal";

import { useEffect, useMemo, useRef, useState } from "react";
import { captureException } from "../../shared/observability/sentry";
import { useAuth } from "../../shared/stores/useAuth";
import { usePermisos } from "../../shared/lib/usePermisos";
import { esAdmin } from "../../shared/lib/permisos";
import { useToast } from "../../shared/toast";

// PDF
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { textoPdf } from "../../shared/lib/textoPdf";

// Tauri: guardar en ruta elegida por el usuario
import { save, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { conAviso } from "../../shared/lib/conAviso";
import { CampoHora, esHora } from "../../shared/ui/CampoHora";

/**
 * INC-20261030-012: las columnas de la semana, las mismas para la cabecera y para cada fila. Cada fila
 * es su propia rejilla, y con `1fr` (que no baja del ancho de su contenido) una fila con tarjetas
 * anchas ensanchaba sus columnas: dejaba de cuadrar con la cabecera y se pulsaba el día de al lado.
 * `minmax(0,1fr)` las deja todas iguales, y el contenido se parte dentro.
 */
const COLUMNAS_SEMANA = "grid grid-cols-[260px_repeat(7,minmax(0,1fr))]";

/* =========================
   Helpers runtime
========================= */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.rows)) return obj.rows as T[];
    if (Array.isArray(obj.result)) return obj.result as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];

    if (Array.isArray(obj.trabajadores)) return obj.trabajadores as T[];
    if (Array.isArray(obj.turnos)) return obj.turnos as T[];
    if (Array.isArray(obj.asignaciones)) return obj.asignaciones as T[];
  }

  return [];
}

/* =========================
   Helpers fecha
========================= */
function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toYMD(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Lunes como inicio de semana (ES)
function startOfWeekMonday(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Dom..6=Sáb
  const diff = (day === 0 ? -6 : 1) - day; // mover a lunes
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Devuelve HH:mm (tolerante a HH:mm:ss)
function hhmm(t: string | null | undefined) {
  if (!t) return "";
  return String(t).slice(0, 5);
}

// Si fin < inicio => cruza medianoche
function crossesMidnight(inicio: string, fin: string) {
  return fin < inicio;
}

/**
 * Lo que quita «Libre» de un día: sus turnos de verdad (los predeterminados no son filas, y el libre
 * ya es libre). Con alguno, se pide confirmación antes de quitarlo.
 */
function turnosQueQuitaElLibre(delDia: Asignacion[]): Asignacion[] {
  return delDia.filter((a) => a.ID_Asignacion && !a.Libre);
}

function etiquetaDia(i: number) {
  return ["LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB", "DOM"][i] ?? "DÍA";
}

/* =========================
   PDF bonito 1 pagina por empleado
========================= */
async function generarHorarioPDFPorEmpleado(args: {
  weekStartYMD: string;
  weekEndYMD: string;
  weekDays: { ymd: string; label: string }[];
  trabajadores: TrabajadorRow[];
  asignaciones: Asignacion[];
}) {
  const { weekStartYMD, weekEndYMD, trabajadores, asignaciones } = args;

  const byCell = new Map<string, Asignacion[]>();
  for (const a of asignaciones) {
    const key = `${a.ID_Trabajador}|${a.Fecha}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key)!.push(a);
  }
  for (const [k, list] of byCell.entries()) {
    list.sort((x, y) => hhmm(x.Hora_Inicio).localeCompare(hhmm(y.Hora_Inicio)));
    byCell.set(k, list);
  }

  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;

  const M = 40;
  const headerH = 90;
  const tableTop = PAGE_H - M - headerH;
  const tableLeft = M;
  const tableW = PAGE_W - 2 * M;
  const rowH = 78;
  const col0W = 90;
  const colW = (tableW - col0W) / 2;

  const gray = rgb(0.15, 0.15, 0.15);
  const light = rgb(0.95, 0.95, 0.95);
  const border = rgb(0.85, 0.85, 0.85);

  const title = `HORARIO SEMANAL ${weekStartYMD} - ${weekEndYMD}`;
  const subtitle = "Resumen listo para compartir (1 página por empleado)";

  const drawText = (
    page: any,
    text: string,
    x: number,
    y: number,
    size: number,
    bold = false,
    color = gray,
  ) => {
    // Como el PDF de cuentas (RI-82): Helvetica admite ñ, tildes y €, y sólo se sustituye lo que
    // no puede escribir. Quitar tildes y eñes a todo dejaba «Peña» en «Pena».
    const font = bold ? fontBold : fontRegular;
    page.drawText(textoPdf(text, font), {
      x,
      y,
      size,
      font,
      color,
    });
  };

  const wrapLines = (text: string, maxWidth: number, font: PDFFont, size: number) => {
    const words = textoPdf(text, font).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";

    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      const width = font.widthOfTextAtSize(test, size);
      if (width <= maxWidth) line = test;
      else {
        if (line) lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  for (const t of trabajadores) {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

    page.drawRectangle({
      x: 0,
      y: PAGE_H - 120,
      width: PAGE_W,
      height: 120,
      color: light,
    });

    drawText(page, title, M, PAGE_H - 55, 16, true);
    drawText(page, subtitle, M, PAGE_H - 75, 10, false, rgb(0.35, 0.35, 0.35));

    const fullName = `${t.Nombre} ${t.Apellido ?? ""}`.trim();
    drawText(page, `EMPLEADO: ${fullName}`, M, PAGE_H - 100, 12, true);
    drawText(page, `PUESTO: ${t.Puesto ?? "-"}`, M, PAGE_H - 118, 10, false, rgb(0.35, 0.35, 0.35));
    drawText(page, `TELÉFONO: ${t.Telefono ?? "-"}`, M + 260, PAGE_H - 118, 10, false, rgb(0.35, 0.35, 0.35));

    const headY = tableTop;
    page.drawRectangle({
      x: tableLeft,
      y: headY,
      width: tableW,
      height: 28,
      color: rgb(0.1, 0.1, 0.1),
    });

    drawText(page, "DÍA", tableLeft + 10, headY + 9, 10, true, rgb(1, 1, 1));
    drawText(page, "TURNO / ÁREA", tableLeft + col0W + 10, headY + 9, 10, true, rgb(1, 1, 1));
    drawText(page, "HORAS / NOTAS", tableLeft + col0W + colW + 10, headY + 9, 10, true, rgb(1, 1, 1));

    const baseParts = weekStartYMD.split("-").map(Number);
    const baseDate = new Date(baseParts[0], baseParts[1] - 1, baseParts[2]);

    let y = headY - rowH;

    for (let i = 0; i < 7; i++) {
      const d = addDays(baseDate, i);
      const ymd = toYMD(d);

      page.drawRectangle({
        x: tableLeft,
        y,
        width: tableW,
        height: rowH,
        color: i % 2 === 0 ? rgb(1, 1, 1) : rgb(0.985, 0.985, 0.985),
      });

      page.drawRectangle({
        x: tableLeft,
        y,
        width: tableW,
        height: rowH,
        borderColor: border,
        borderWidth: 1,
        color: undefined as any,
      });

      page.drawLine({
        start: { x: tableLeft + col0W, y },
        end: { x: tableLeft + col0W, y: y + rowH },
        thickness: 1,
        color: border,
      });
      page.drawLine({
        start: { x: tableLeft + col0W + colW, y },
        end: { x: tableLeft + col0W + colW, y: y + rowH },
        thickness: 1,
        color: border,
      });

      drawText(page, etiquetaDia(i), tableLeft + 10, y + rowH - 22, 11, true);
      drawText(page, ymd, tableLeft + 10, y + rowH - 40, 9, false, rgb(0.45, 0.45, 0.45));

      // El día libre se imprime como un día sin turno: «LIBRE».
      const list = (byCell.get(`${t.ID_Trabajador}|${ymd}`) ?? []).filter((a) => !a.Libre);

      if (list.length === 0) {
        drawText(page, "LIBRE", tableLeft + col0W + 10, y + rowH - 24, 11, true, rgb(0.4, 0.4, 0.4));
        drawText(page, "-", tableLeft + col0W + colW + 10, y + rowH - 24, 11, false, rgb(0.4, 0.4, 0.4));
      } else {
        const startY = y + rowH - 22;
        let off = 0;

        for (const a of list.slice(0, 3)) {
          const turno = `${a.Nombre_Turno ?? ""}`.trim() || "TURNO";
          const area = a.Area || "";
          const ini = hhmm(a.Hora_Inicio);
          const fin = hhmm(a.Hora_Fin);

          const time = ini && fin ? `${ini}-${fin}${crossesMidnight(ini, fin) ? " (+1)" : ""}` : "-";

          drawText(page, `${turno}${area ? ` (${area})` : ""}`, tableLeft + col0W + 10, startY - off, 10, true);

          const note = a.Notas ? ` / ${a.Notas}` : "";
          const rightText = `${time}${note}`;

          const lines = wrapLines(rightText, colW - 18, fontRegular, 9);
          drawText(page, lines[0] ?? time, tableLeft + col0W + colW + 10, startY - off, 9, false);
          if (lines.length > 1) {
            drawText(
              page,
              lines[1],
              tableLeft + col0W + colW + 10,
              startY - off - 12,
              9,
              false,
              rgb(0.35, 0.35, 0.35),
            );
          }

          off += 18;
        }

        if (list.length > 3) {
          drawText(page, `(+${list.length - 3} más)`, tableLeft + col0W + 10, y + 10, 9, false, rgb(0.45, 0.45, 0.45));
        }
      }

      y -= rowH;
    }

    drawText(
      page,
      "Nota: Si la hora FIN es menor que INICIO, el turno acaba al día siguiente (+1).",
      M,
      M - 5,
      9,
      false,
      rgb(0.45, 0.45, 0.45),
    );
  }

  const bytes = await pdfDoc.save();
  return new Uint8Array(bytes);
}

/* =========================
   HorarioSemanal component (RESPONSIVE)
========================= */
const SIN_PERMISO_HORARIOS = "Ya no puedes gestionar horarios";

/**
 * El turno LIBRE que siembra `0001_inicial.sql` (`ID_TURNO_LIBRE` en `tpv-domain`): un día libre es
 * una asignación suya sin horas. No se ofrece en el editor de turnos.
 */
const ID_TURNO_LIBRE = "00000000-0000-7000-8000-000000000101";

function HorarioSemanal({ trabajadores }: { trabajadores: TrabajadorRow[] }) {
  const auth = useAuth();
  // El permiso de gestionar horarios, no el rol de administrador: se llamaba `isAdmin`.
  const puedeGestionarHorarios = usePermisos().puede("horarios.gestionar");

  const [error, setError] = useState<string | null>(null);

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));

  // Datos vía TanStack Query (caché): turnos, id de trabajador del usuario (no-admin) y
  // las asignaciones de la semana visible. Las mutaciones de escritura invalidan la
  // feature y recachean estas listas solas.
  const lunesYMD = useMemo(() => toYMD(weekStart), [weekStart]);

  const turnosQuery = useTurnos();
  const trabajadorIdQuery = useTrabajadorIdByUsuario(
    auth.idUsuario,
    !puedeGestionarHorarios && !!auth.idUsuario,
  );
  const asignacionesQuery = useAsignacionesSemana(lunesYMD);

  const guardarAsignacion = useGuardarAsignacion();
  const guardandoRef = useRef(false);
  const deleteAsignacion = useDeleteAsignacion();
  const copySemana = useCopySemanaAsignaciones();
  const setPredeterminado = useSetPredeterminadoDesdeSemana();
  const marcarLibreMut = useMarcarLibre();

  // El turno LIBRE no se elige en el editor: un día libre no tiene horas, y se marca con «Libre».
  const turnos = useMemo<Turno[]>(
    () => asArray<Turno>(turnosQuery.data ?? []).filter((t) => t.ID_Turno !== ID_TURNO_LIBRE),
    [turnosQuery.data],
  );
  const asignaciones = useMemo<Asignacion[]>(
    () => asArray<Asignacion>(asignacionesQuery.data ?? []),
    [asignacionesQuery.data],
  );
  const myTrabajadorId = trabajadorIdQuery.data ?? null;

  const loading =
    turnosQuery.isFetching ||
    asignacionesQuery.isFetching ||
    trabajadorIdQuery.isFetching ||
    guardarAsignacion.isPending ||
    deleteAsignacion.isPending ||
    copySemana.isPending ||
    setPredeterminado.isPending ||
    marcarLibreMut.isPending;

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [selectedTrabajadorId, setSelectedTrabajadorId] = useState<string | null>(null);
  const [selectedFecha, setSelectedFecha] = useState<string>("");

  const [editIdAsignacion, setEditIdAsignacion] = useState<string | null>(null);

  const [id_turno, setIdTurno] = useState<string>("");
  const [area, setArea] = useState<string>("Sala");
  const [notas, setNotas] = useState<string>("");

  const [turnoPartido, setTurnoPartido] = useState(false);
  const [horaInicio1, setHoraInicio1] = useState("");
  const [horaFin1, setHoraFin1] = useState("");
  const [horaInicio2, setHoraInicio2] = useState("");
  const [horaFin2, setHoraFin2] = useState("");

  const toast = useToast();

  const trabajadoresSafe = useMemo(() => asArray<TrabajadorRow>(trabajadores), [trabajadores]);

  const weekDays = useMemo(() => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      days.push({
        date: d,
        ymd: toYMD(d),
        label: ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"][i],
      });
    }
    return days;
  }, [weekStart]);
  const hoyYmd = toYMD(new Date());

  const trabajadoresVisibles = useMemo(() => {
    if (puedeGestionarHorarios) return trabajadoresSafe;
    if (!myTrabajadorId) return [];
    return trabajadoresSafe.filter((t) => t.ID_Trabajador === myTrabajadorId);
  }, [puedeGestionarHorarios, trabajadoresSafe, myTrabajadorId]);

  const asignacionesByCell = useMemo(() => {
    const map = new Map<string, Asignacion[]>();
    for (const a of asignaciones) {
      const key = `${a.ID_Trabajador}|${a.Fecha}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }

    for (const [k, list] of map.entries()) {
      list.sort((x, y) => hhmm(x.Hora_Inicio).localeCompare(hhmm(y.Hora_Inicio)));
      map.set(k, list);
    }

    return map;
  }, [asignaciones]);

  // Aviso si falla la carga de turnos/asignaciones (equivale al catch del fetch anterior).
  useEffect(() => {
    if (turnosQuery.isError || asignacionesQuery.isError) {
      setError(`No se pudo cargar el horario semanal: ${toAppError(turnosQuery.error ?? asignacionesQuery.error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnosQuery.isError, asignacionesQuery.isError]);

  const copiarSemanaAnterior = async () => {
    if (!sigueConPermiso()) return;

    const to_monday = toYMD(weekStart);
    const from_monday = toYMD(addDays(weekStart, -7));

    const ok = await confirmDialog(
      `Esto copiara la semana ${from_monday} a ${to_monday} y sobrescribira la semana destino. Continuar?`,
      { title: "Copiar semana anterior", kind: "warning" },
    );
    if (!ok) return;

    setError(null);
    try {
      await copySemana.mutateAsync({ from_monday, to_monday, overwrite: true });
    } catch (e) {
      setError(`No se pudo copiar la semana anterior: ${toAppError(e).message}`);
    }
  };

  const establecerPredeterminado = async () => {
    if (!sigueConPermiso()) return;

    const lunes = toYMD(weekStart);
    const ok = await confirmDialog(
      `Guardare como horario predeterminado la semana visible (${lunes}).\n` +
      `Se aplicara automaticamente a la semana actual real y futuras SOLO si no hay nada pintado.\n\nContinuar?`,
      { title: "Horario predeterminado", kind: "warning" },
    );
    if (!ok) return;

    setError(null);
    try {
      const done = await setPredeterminado.mutateAsync(lunes);
      if (!done) {
        toast.error("No se pudo", "Esa semana no tiene asignaciones para guardar como predeterminado.");
        return;
      }
      toast.success("Listo", "Horario predeterminado guardado.");
    } catch (e) {
      setError(`No se pudo establecer el horario predeterminado: ${toAppError(e).message}`);
    }
  };

  const guardarPDF = async () => {
    if (!sigueConPermiso()) return;
    setError(null);

    try {
      const weekStartYMD = toYMD(weekStart);
      const weekEndYMD = toYMD(addDays(weekStart, 6));

      const pdfData = await generarHorarioPDFPorEmpleado({
        weekStartYMD,
        weekEndYMD,
        weekDays: weekDays.map((d) => ({ ymd: d.ymd, label: d.label })),
        trabajadores: trabajadoresVisibles,
        asignaciones,
      });

      const defaultName = `horario_SEMANA_${weekStartYMD}.pdf`;
      const filePath = await save({
        title: "Guardar horario en PDF",
        defaultPath: defaultName,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (!filePath) return;

      await writeFile(filePath, pdfData);
      toast.success("Completado", `PDF guardado:\n${filePath}`);
    } catch (e) {
      // El PDF se compone en la pantalla: si falla, no lo ha registrado `invocar`.
      captureException(e, { fase: "pdf_horario" });
      setError(`No se pudo generar el PDF del horario: ${toAppError(e).message}`);
    }
  };

  const openCreate = (idTrab: string, fecha: string) => {
    if (!sigueConPermiso()) return;

    setModalMode("create");
    setSelectedTrabajadorId(idTrab);
    setSelectedFecha(fecha);
    setEditIdAsignacion(null);

    setIdTurno(turnos[0]?.ID_Turno ?? "");
    setArea("Sala");
    setNotas("");

    setTurnoPartido(false);
    setHoraInicio1("");
    setHoraFin1("");
    setHoraInicio2("");
    setHoraFin2("");

    setError(null);
    setModalOpen(true);
  };

  const openEdit = (a: Asignacion) => {
    if (!sigueConPermiso()) return;

    if (!a.ID_Asignacion) {
      toast.info("Predeterminado", "Este turno viene del horario predeterminado. Crea uno real para editarlo.");
      return;
    }

    setModalMode("edit");
    setSelectedTrabajadorId(a.ID_Trabajador);
    setSelectedFecha(a.Fecha);
    setEditIdAsignacion(a.ID_Asignacion);

    setIdTurno(a.ID_Turno);
    setArea(a.Area || "Sala");
    setNotas(a.Notas ?? "");

    const grupo = a.ID_Grupo ? asignaciones.filter(it => it.ID_Grupo === a.ID_Grupo).sort((x, y) => (x.Hora_Inicio ?? "").localeCompare(y.Hora_Inicio ?? "")) : [a];
    setEditIdAsignacion(grupo[0].ID_Asignacion);
    setTurnoPartido(grupo.length === 2);
    setHoraInicio1(hhmm(grupo[0].Hora_Inicio));
    setHoraFin1(hhmm(grupo[0].Hora_Fin));
    setHoraInicio2(hhmm(grupo[1]?.Hora_Inicio));
    setHoraFin2(hhmm(grupo[1]?.Hora_Fin));

    setError(null);
    setModalOpen(true);
  };

  const closeModal = () => { if (!guardandoRef.current) setModalOpen(false); };

  // Quitarle a alguien el permiso con el editor abierto: al guardar no pasaba nada, en silencio.
  // El editor se cierra y se dice por qué; el backend rechazaría el guardado igualmente.
  useEffect(() => {
    if (puedeGestionarHorarios || !modalOpen) return;
    setModalOpen(false);
    toast.warning(SIN_PERMISO_HORARIOS, "Te han quitado el permiso mientras editabas. Lo que no habías guardado no se ha guardado.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puedeGestionarHorarios, modalOpen]);

  /** Antes de cada acción de gestión: sin el permiso, se dice en vez de no hacer nada. */
  const sigueConPermiso = () => {
    if (puedeGestionarHorarios) return true;
    toast.warning(SIN_PERMISO_HORARIOS, "Pide a un administrador que te dé el permiso de horarios.");
    return false;
  };

  const validateRange = (ini: string, fin: string) => {
    if (!ini || !fin) return "Debes indicar hora inicio y hora fin.";
    if (!esHora(ini) || !esHora(fin)) return "Hora invalida (usa HH:mm).";
    if (ini === fin) return "Inicio y fin no pueden ser iguales.";
    return null;
  };

  const guardarModal = async () => {
    if (guardandoRef.current) return;
    setError(null);

    if (!sigueConPermiso()) return;
    if (!selectedTrabajadorId || !selectedFecha) return;
    if (!id_turno) return setError("Selecciona un turno");

    const err1 = validateRange(horaInicio1, horaFin1);
    if (err1) return setError(err1);

    if (turnoPartido) {
      const err2 = validateRange(horaInicio2, horaFin2);
      if (err2) return setError(`Tramo 2: ${err2}`);
    }

    guardandoRef.current = true;
    try {
      await guardarAsignacion.mutateAsync({
        id_asignacion: modalMode === "edit" ? editIdAsignacion : null,
        id_trabajador: selectedTrabajadorId,
        fecha: selectedFecha,
        id_turno,
        area,
        notas: notas || null,
        tramos: [
          { hora_inicio: horaInicio1, hora_fin: horaFin1 },
          ...(turnoPartido ? [{ hora_inicio: horaInicio2, hora_fin: horaFin2 }] : []),
        ],
      });
      setModalOpen(false);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      guardandoRef.current = false;
    }
  };

  /**
   * Marca libre el día: sustituye lo que tuviera y tapa la plantilla. Si ese día tiene turnos de
   * verdad, los quita, así que antes se confirma diciendo cuáles.
   */
  const marcarLibre = async (t: TrabajadorRow, fecha: string, delDia: Asignacion[]) => {
    if (!sigueConPermiso()) return;
    const id_trabajador = t.ID_Trabajador;
    const quita = turnosQueQuitaElLibre(delDia);
    if (quita.length > 0) {
      const cuales = quita
        .map((a) => {
          const ini = hhmm(a.Hora_Inicio);
          const fin = hhmm(a.Hora_Fin);
          return ini && fin ? `${a.Nombre_Turno} ${ini}-${fin}` : a.Nombre_Turno;
        })
        .join(", ");
      const ok = await confirmDialog(
        `${t.Nombre} tiene ${quita.length === 1 ? "un turno" : `${quita.length} turnos`} el ${fecha} (${cuales}). ` +
          `Al marcar el día libre se ${quita.length === 1 ? "quita" : "quitan"}.\n\n¿Continuar?`,
        { title: "Marcar el día libre", kind: "warning" },
      );
      if (!ok) return;
    }
    setError(null);
    try {
      await marcarLibreMut.mutateAsync({ id_trabajador, fecha });
    } catch (e) {
      setError(`No se pudo marcar el día libre: ${toAppError(e).message}`);
    }
  };

  const borrarAsignacion = async (id_asignacion: string) => {
    if (!sigueConPermiso()) return;

    if (!id_asignacion) {
      toast.info("Predeterminado", "Este turno es predeterminado. Crea uno real y luego podrás borrarlo.");
      return;
    }

    try {
      await deleteAsignacion.mutateAsync(id_asignacion);
    } catch (e) {
      setError(`No se pudo borrar la asignación: ${toAppError(e).message}`);
    }
  };

  const btnBase =
    "min-w-0 border-2 rounded-xl font-medium transition-all duration-300 whitespace-normal break-words text-center leading-tight px-2 py-2 text-[11px] sm:px-3 sm:py-2 sm:text-sm";

  return (
    <div className="flex w-full shrink-0 flex-col gap-3 rounded-xl bg-surface p-3 shadow-xs sm:p-4">
      <div className="flex w-full flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col">
          <h3 className="text-lg sm:text-xl font-bold">HORARIO SEMANAL</h3>
          <p className="text-sm text-fg-muted">
            {puedeGestionarHorarios
              ? "Arriba tienes trabajadores. Aqui puedes asignar turnos por semana."
              : "Tu horario de esta semana (solo lectura)."}
          </p>
        </div>

        <div className="w-full xl:w-auto">
          <div
            className="
              grid grid-cols-2 gap-2
              sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:gap-2
              xl:flex-nowrap
            "
          >
            {puedeGestionarHorarios && (
              <>
                <button
                  type="button"
                  onClick={conAviso(guardarPDF)}
                  className={`${btnBase} border-border-strong text-fg hover:bg-accent hover:text-white disabled:opacity-60 disabled:cursor-not-allowed w-full sm:w-auto`}
                  disabled={loading}
                >
                  Guardar PDF
                </button>

                <button
                  type="button"
                  onClick={conAviso(copiarSemanaAnterior)}
                  className={`${btnBase} border-accent text-accent hover:bg-accent hover:text-white disabled:opacity-60 disabled:cursor-not-allowed w-full sm:w-auto`}
                  disabled={loading}
                >
                  Copiar semana anterior
                </button>

                <button
                  type="button"
                  onClick={conAviso(establecerPredeterminado)}
                  className={`${btnBase} border-border-strong text-fg hover:bg-accent hover:text-white disabled:opacity-60 disabled:cursor-not-allowed w-full sm:w-auto`}
                  disabled={loading}
                  title="Guarda como predeterminado la semana visible"
                >
                  Establecer predeterminado
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setWeekStart(addDays(weekStart, -7))}
              className={`${btnBase} border-border-strong text-fg hover:bg-accent hover:text-white w-full sm:w-auto`}
            >
              Semana -
            </button>

            <button
              type="button"
              onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
              className={`${btnBase} border-border-strong text-fg hover:bg-accent hover:text-white w-full sm:w-auto`}
            >
              Hoy
            </button>

            <button
              type="button"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              className={`${btnBase} border-border-strong text-fg hover:bg-accent hover:text-white w-full sm:w-auto col-span-2 sm:col-span-1`}
            >
              Semana +
            </button>
          </div>

          <p className="mt-2 text-[11px] text-fg-subtle sm:hidden">
            En pantallas pequeñas los botones se ordenan en filas.
          </p>
        </div>
      </div>

      {error && (
        <div className="w-full rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="hidden">
        {trabajadoresVisibles.map((t) => (
          <div
            key={t.ID_Trabajador}
            className="rounded-xl border border-border bg-surface p-3 flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1">
              <div className="font-semibold text-base">
                {t.Nombre} {t.Apellido ?? ""}
              </div>
              <div className="text-xs text-fg-muted">
                {t.Puesto ?? "—"} • {t.Telefono ?? "—"}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {weekDays.map((d) => {
                const key = `${t.ID_Trabajador}|${d.ymd}`;
                const list = asignacionesByCell.get(key) ?? [];

                return (
                  <div key={d.ymd} className="rounded-xl border border-border p-2 bg-surface">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col min-w-0">
                        <div className="font-semibold text-sm">{d.label}</div>
                        <div className="text-[11px] text-fg-muted truncate">{d.ymd}</div>
                      </div>

                      {puedeGestionarHorarios && (
                        <button
                          type="button"
                          onClick={() => openCreate(t.ID_Trabajador, d.ymd)}
                          className="border border-border rounded-lg px-2 py-1 text-[11px] text-fg-muted hover:bg-accent hover:text-white transition-all whitespace-nowrap shrink-0"
                          title="Añadir asignación"
                        >
                          <span className="sm:hidden">+</span>
                          <span className="hidden sm:inline">+ Añadir</span>
                        </button>
                      )}
                    </div>

                    <div className="mt-2 flex flex-col gap-2">
                      {list.length === 0 ? (
                        <div className="text-[11px] text-fg-subtle">
                          {puedeGestionarHorarios ? "Sin asignación" : "—"}
                        </div>
                      ) : (
                        list.map((a) => {
                          const ini = hhmm(a.Hora_Inicio);
                          const fin = hhmm(a.Hora_Fin);
                          const showTime =
                            ini && fin
                              ? `${ini}-${fin}${crossesMidnight(ini, fin) ? " (+1)" : ""}`
                              : "";

                          const isVirtual = !a.ID_Asignacion;

                          return (
                            <div
                              key={`${a.ID_Asignacion}-${a.ID_Turno}-${a.Hora_Inicio ?? ""}-${a.Hora_Fin ?? ""}-${a.Area ?? ""}-${a.Notas ?? ""}`}
                              className="rounded-xl border border-border bg-surface px-2 py-2 flex flex-col gap-1"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-semibold truncate">
                                    {a.Nombre_Turno}
                                  </div>
                                  <div className="text-[11px] text-fg-muted">
                                    {a.Area}
                                    {showTime ? ` • ${showTime}` : ""}
                                  </div>

                                  {isVirtual && (
                                    <div className="mt-1 text-[11px] text-fg-subtle">
                                      Predeterminado
                                    </div>
                                  )}
                                </div>

                                {puedeGestionarHorarios && !isVirtual && (
                                  <div className="shrink-0">
                                    <div className="grid grid-cols-2 gap-1">
                                      <button
                                        type="button"
                                        onClick={() => openEdit(a)}
                                        className="text-[11px] border border-accent text-accent rounded-lg px-2 py-1 hover:bg-accent hover:text-white transition-all"
                                      >
                                        Editar
                                      </button>
                                      <button
                                        type="button"
                                        onClick={conAviso(() => borrarAsignacion(a.ID_Asignacion))}
                                        className="text-[11px] border border-danger text-danger rounded-lg px-2 py-1 hover:bg-danger hover:text-white transition-all"
                                        title="Borrar"
                                      >
                                        X
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {a.Notas ? <div className="text-[11px] text-fg-muted">{a.Notas}</div> : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="block min-w-0">
        <div className="w-full touch-pan-x overflow-x-auto overscroll-x-contain rounded-xl border border-border pb-2 [scrollbar-gutter:stable]">
          <div className="min-w-[900px]">
            <div className={`${COLUMNAS_SEMANA} border-b border-border bg-surface-2`}>
              <div className="p-3 font-semibold">Trabajador</div>
              {weekDays.map((d) => (
                <div key={d.ymd} className="p-3 font-semibold text-center">
                  <div>{d.label}</div>
                  <div className="text-xs text-fg-muted">{d.ymd}</div>
                </div>
              ))}
            </div>

            {trabajadoresVisibles.map((t) => (
              <div
                key={t.ID_Trabajador}
                className={`${COLUMNAS_SEMANA} border-b border-border`}
              >
                <div className="p-3">
                  <div className="font-semibold">
                    {t.Nombre} {t.Apellido ?? ""}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {t.Puesto ?? "—"} • {t.Telefono ?? "—"}
                  </div>
                </div>

                {weekDays.map((d) => {
                  const key = `${t.ID_Trabajador}|${d.ymd}`;
                  const list = asignacionesByCell.get(key) ?? [];

                  return (
                    <div key={d.ymd} className="min-w-0 p-2 border-l border-border">
                      <div className="flex flex-col gap-2">
                        {list.length === 0 ? (
                          <div className="text-xs text-fg-subtle">{puedeGestionarHorarios ? "Sin asignacion" : "—"}</div>
                        ) : (
                          list.map((a) => {
                            const effIni = hhmm(a.Hora_Inicio);
                            const effFin = hhmm(a.Hora_Fin);
                            const showTime =
                              effIni && effFin
                                ? `${effIni}-${effFin}${crossesMidnight(effIni, effFin) ? " (+1)" : ""}`
                                : "";

                            const isVirtual = !a.ID_Asignacion;

                            return (
                              <div
                                key={`${a.ID_Asignacion}-${a.ID_Turno}-${a.Hora_Inicio ?? ""}-${a.Hora_Fin ?? ""}-${a.Area ?? ""}-${a.Notas ?? ""}`}
                                className="rounded-xl border border-border bg-surface px-2 py-2 flex flex-col gap-1"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="flex min-w-0 flex-col break-words">
                                    <div className="text-sm font-semibold">{a.Libre ? "Libre" : a.Nombre_Turno}</div>
                                    {a.Libre ? (
                                      <div className="text-xs text-fg-muted">Día libre</div>
                                    ) : (
                                      <div className="text-xs text-fg-muted">
                                        {a.Area}
                                        {showTime ? ` • ${showTime}` : ""}
                                      </div>
                                    )}

                                    {isVirtual && (
                                      <div className="mt-1 text-[11px] text-fg-subtle">
                                        Predeterminado
                                      </div>
                                    )}
                                  </div>

                                  {puedeGestionarHorarios && !isVirtual && (
                                    <div className="flex items-center gap-1">
                                      {!a.Libre && (
                                      <button
                                        type="button"
                                        onClick={() => openEdit(a)}
                                        className="text-xs border border-accent text-accent rounded-lg px-2 py-1 hover:bg-accent hover:text-white transition-all"
                                      >
                                        Editar
                                      </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={conAviso(() => borrarAsignacion(a.ID_Asignacion))}
                                        className="text-xs border border-danger text-danger rounded-lg px-2 py-1 hover:bg-danger hover:text-white transition-all"
                                        title={a.Libre ? "Quitar el día libre (vuelve el horario predeterminado)" : "Borrar"}
                                      >
                                        X
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {a.Notas ? <div className="text-xs text-fg-muted">{a.Notas}</div> : null}
                              </div>
                            );
                          })
                        )}

                        {puedeGestionarHorarios && (
                          <button
                            type="button"
                            onClick={() => openCreate(t.ID_Trabajador, d.ymd)}
                            className="border border-border rounded-xl px-3 py-2 text-xs text-fg-muted hover:bg-accent hover:text-white transition-all"
                          >
                            + Anadir
                          </button>
                        )}
                        {/* Un día que ya ha pasado no se marca libre si tuvo turnos: los borraría. Sin
                            ninguno sí (un trabajador recién dado de alta, a mitad de semana): si no,
                            los días de antes de hoy no se podían dejar libres para guardar la semana
                            como su horario predeterminado. */}
                        {puedeGestionarHorarios &&
                          (d.ymd >= hoyYmd || turnosQueQuitaElLibre(list).length === 0) &&
                          !list.some((a) => a.Libre) && (
                          <button
                            type="button"
                            onClick={conAviso(() => marcarLibre(t, d.ymd, list))}
                            className="border border-border rounded-xl px-3 py-2 text-xs text-fg-muted hover:bg-surface-2 transition-all"
                            title="Marcar el día libre: tapa el horario predeterminado"
                          >
                            Libre
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 p-2 sm:p-4">
          <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface p-3 shadow-lg sm:gap-4 sm:p-5">
            <div className="flex flex-col items-stretch gap-3 xs:flex-row xs:items-start xs:justify-between sm:gap-4">
              <div className="flex flex-col">
                <h4 className="text-lg font-bold">
                  {modalMode === "create" ? "Nueva asignacion" : "Editar asignacion"}
                </h4>
                <p className="text-sm text-fg-muted">
                  Fecha: <span className="font-medium">{selectedFecha}</span>
                </p>
                <p className="text-xs text-fg-subtle">
                  Si FIN es menor que INICIO, se interpreta como turno nocturno (acaba al dia siguiente +1).
                </p>
              </div>

              <button
                type="button"
                onClick={closeModal}
                className="w-full rounded-xl border-2 border-border-strong px-3 py-2 font-medium text-fg transition-all hover:bg-accent hover:text-white xs:w-auto"
              >
                Cerrar
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex min-w-0 flex-col gap-1">
                <label className="text-sm font-medium">Turno</label>
                <select
                  value={id_turno}
                  onChange={(e) => setIdTurno(e.target.value || "")}
                  className="border border-border rounded-xl px-3 py-2 bg-surface outline-none focus:border-accent"
                >
                  <option value="">Selecciona un turno</option>
                  {turnos.map((t) => (
                    <option key={t.ID_Turno} value={t.ID_Turno}>
                      {t.Nombre_Turno}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1">
                <label className="text-sm font-medium">Area</label>
                <select
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className="border border-border rounded-xl px-3 py-2 bg-surface outline-none focus:border-accent"
                >
                  <option value="Sala">Sala</option>
                  <option value="Cocina">Cocina</option>
                </select>
              </div>

              <div className="flex items-center gap-2 sm:col-span-2 lg:h-10 lg:self-end">
                <input
                  id="partido"
                  type="checkbox"
                  checked={turnoPartido}
                  onChange={(e) => setTurnoPartido(e.target.checked)}
                  className="w-4 h-4"
                  disabled={loading}
                />
                <label htmlFor="partido" className="text-sm font-medium">
                  Turno partido (2 tramos)
                </label>
              </div>

              <div className="flex min-w-0 flex-col justify-end gap-1">
                <label className="text-sm font-medium">Hora inicio (tramo 1)</label>
                <CampoHora aria-label="Hora inicio (tramo 1)" valor={horaInicio1} onCambio={setHoraInicio1} />
              </div>

              <div className="flex min-w-0 flex-col justify-end gap-1">
                <label className="text-sm font-medium">Hora fin (tramo 1)</label>
                <CampoHora aria-label="Hora fin (tramo 1)" valor={horaFin1} onCambio={setHoraFin1} />
              </div>

              {turnoPartido && (
                <>
                  <div className="flex min-w-0 flex-col justify-end gap-1">
                    <label className="text-sm font-medium">Hora inicio (tramo 2)</label>
                    <CampoHora aria-label="Hora inicio (tramo 2)" valor={horaInicio2} onCambio={setHoraInicio2} />
                  </div>

                  <div className="flex min-w-0 flex-col justify-end gap-1">
                    <label className="text-sm font-medium">Hora fin (tramo 2)</label>
                    <CampoHora aria-label="Hora fin (tramo 2)" valor={horaFin2} onCambio={setHoraFin2} />
                  </div>
                </>
              )}

              <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                <label className="text-sm font-medium">Notas (opcional)</label>
                <input
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                  className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                  placeholder="Ej: cubrir a X, turno partido, etc."
                />
              </div>
            </div>

            {/* Una sola vez y junto a Guardar, que es lo que lo provoca. Salía también arriba, bajo
                el título: el mismo error dos veces en el mismo modal. */}
            {error && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>}
            <div className="grid grid-cols-2 gap-2 pt-2 sm:flex sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={closeModal}
                className="border-2 border-border rounded-xl px-4 py-2 text-fg transition-all duration-300 hover:bg-accent hover:text-white"
              >
                Cancelar
              </button>

              <button
                type="button"
                disabled={loading}
                onClick={conAviso(guardarModal)}
                className="border-2 border-accent text-accent rounded-xl px-4 py-2 font-medium transition-all duration-300 hover:bg-accent hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================
   Trabajadores page
========================= */
function Trabajadores() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const isAdmin = esAdmin(usePermisos().rol);
  // A quién se va a eliminar (el modal de confirmación abierto).
  const [aEliminar, setAEliminar] = useState<TrabajadorRow | null>(null);

  // Lista de trabajadores vía TanStack Query (caché). Las mutaciones de horarios y el
  // alta/edición invalidan la feature; aquí además refrescamos al navegar a la página.
  const trabajadoresQuery = useTrabajadores();

  const trabajadoresSafe = useMemo(
    () => asArray<TrabajadorRow>(trabajadoresQuery.data ?? []),
    [trabajadoresQuery.data],
  );

  const error = trabajadoresQuery.isError
    ? `No se pudieron cargar los trabajadores: ${toAppError(trabajadoresQuery.error).message}`
    : null;

  // Refrescar la lista cada vez que se navega a la página (equivale al efecto previo
  // keyed por location.key, que recargaba al volver desde alta/edición de trabajador).
  useEffect(() => {
    void trabajadoresQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  return (
    <div className="flex h-full min-h-0 w-full touch-pan-y flex-col items-center gap-3 overflow-y-auto overscroll-contain bg-bg p-2 pt-3 [scrollbar-gutter:stable] sm:gap-4 sm:p-4 lg:p-6 lg:pt-5">
      <div className="flex w-full shrink-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4">
        <div className="flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <Users className="size-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-fg sm:text-2xl">Trabajadores</h2>
              <p className="text-sm text-fg-muted">
                {trabajadoresSafe.length}{" "}
                {trabajadoresSafe.length === 1 ? "trabajador" : "trabajadores"}
              </p>
            </div>
          </div>

          {isAdmin && (
            <Link
              to="/Trabajadores/nuevo-trabajador"
              className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] xs:w-auto"
            >
              <Plus className="size-4" aria-hidden />
              <span className="hidden xs:inline">Nuevo trabajador</span>
            </Link>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      <div className="flex w-full shrink-0 flex-col gap-2 rounded-xl bg-surface p-3 shadow-xs sm:p-4">
        {trabajadoresSafe.length === 0 ? (
          <p className="text-fg-muted">No hay trabajadores todavía.</p>
        ) : (
          trabajadoresSafe.map((t) => (
            <div
              key={t.ID_Trabajador}
              className="flex w-full flex-col gap-3 rounded-xl border border-border px-3 py-3 lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-lg">
                    {t.Nombre} {t.Apellido ?? ""}
                  </span>

                  <span className="text-xs px-2 py-1 rounded-lg border border-border">
                    {t.Nombre_Rol}
                  </span>

                  <span
                    className={`text-xs px-2 py-1 rounded-lg border ${t.Estado === "Activo"
                      ? "border-accent/30 text-accent bg-accent-soft"
                      : "border-danger/30 text-danger bg-danger-soft"
                      }`}
                  >
                    {t.Estado}
                  </span>
                </div>

                <div className="flex flex-wrap gap-4 text-sm text-fg-muted">
                  <span>
                    <span className="text-fg-subtle">Teléfono:</span>{" "}
                    {t.Telefono ?? "—"}
                  </span>
                  <span>
                    <span className="text-fg-subtle">Puesto:</span>{" "}
                    {t.Puesto ?? "—"}
                  </span>
                </div>
              </div>

              {isAdmin && (
                <div className="flex w-full justify-center lg:w-auto lg:justify-end">
                  <div className="grid w-full grid-cols-2 gap-2 xs:w-auto xs:flex xs:flex-wrap xs:justify-center lg:justify-end">
                    <button
                      type="button"
                      onClick={() => void navigate(`/Trabajadores/editar/${t.ID_Trabajador}`)}
                      className="
                        min-w-0 w-full justify-center whitespace-normal break-words text-center leading-tight
                        border-2 border-accent text-accent rounded-xl
                        font-medium transition-all duration-300 hover:bg-accent hover:text-white
                        px-3 py-1.5 text-xs
                        xs:w-auto sm:px-4 sm:py-2 sm:text-sm
                      "
                    >
                      Editar
                    </button>

                    <button
                      type="button"
                      onClick={() => setAEliminar(t)}
                      className="
                        min-w-0 w-full justify-center whitespace-normal break-words text-center leading-tight
                        border-2 border-danger text-danger rounded-xl
                        font-medium transition-all duration-300 hover:bg-danger hover:text-white
                        px-3 py-1.5 text-xs
                        xs:w-auto sm:px-4 sm:py-2 sm:text-sm
                      "
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <EliminarTrabajadorModal trabajador={aEliminar} onCerrar={() => setAEliminar(null)} />

      <HorarioSemanal trabajadores={trabajadoresSafe} />
    </div>
  );
}

export default Trabajadores;
