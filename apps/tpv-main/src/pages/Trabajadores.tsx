import { Link, useLocation, useNavigate } from "react-router-dom";
import { ReactComponent as LapizSVG } from "../assets/svg/LapizSVG.svg";

import {
  trabajadoresGetAll,
  trabajadoresGetTrabajadorIdByUsuario,
  turnosGetAll,
  horariosGetAsignacionesSemana,
  horariosCreateAsignacion,
  horariosUpdateAsignacion,
  horariosDeleteAsignacion,
  horariosCopySemanaAsignaciones,
  horariosSetPredeterminadoDesdeSemana,
  type TrabajadorRow,
  type Turno,
  type Asignacion,
} from "../components/trabajadores/trabajadoresApis";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../zustand/useAuth";
import { useToast } from "../components/toast";

// PDF
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Tauri: guardar en ruta elegida por el usuario
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

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

// Para evitar errores de encoding raros en PDF: quitamos tildes/acentos/ñ
function asciiSafe(s: string) {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N")
    .replace(/[^\x00-\x7F]/g, "");
}

function labelDayAscii(i: number) {
  return ["LUN", "MAR", "MIE", "JUE", "VIE", "SAB", "DOM"][i] ?? "DIA";
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
  const subtitle = "Resumen listo para compartir (1 pagina por empleado)";

  const drawText = (
    page: any,
    text: string,
    x: number,
    y: number,
    size: number,
    bold = false,
    color = gray,
  ) => {
    page.drawText(asciiSafe(text), {
      x,
      y,
      size,
      font: bold ? fontBold : fontRegular,
      color,
    });
  };

  const wrapLines = (text: string, maxWidth: number, font: any, size: number) => {
    const words = asciiSafe(text).split(/\s+/).filter(Boolean);
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
    drawText(page, `TELEFONO: ${t.Telefono ?? "-"}`, M + 260, PAGE_H - 118, 10, false, rgb(0.35, 0.35, 0.35));

    const headY = tableTop;
    page.drawRectangle({
      x: tableLeft,
      y: headY,
      width: tableW,
      height: 28,
      color: rgb(0.1, 0.1, 0.1),
    });

    drawText(page, "DIA", tableLeft + 10, headY + 9, 10, true, rgb(1, 1, 1));
    drawText(page, "TURNO / AREA", tableLeft + col0W + 10, headY + 9, 10, true, rgb(1, 1, 1));
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

      drawText(page, labelDayAscii(i), tableLeft + 10, y + rowH - 22, 11, true);
      drawText(page, ymd, tableLeft + 10, y + rowH - 40, 9, false, rgb(0.45, 0.45, 0.45));

      const list = byCell.get(`${t.ID_Trabajador}|${ymd}`) ?? [];

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
          drawText(page, `(+${list.length - 3} mas)`, tableLeft + col0W + 10, y + 10, 9, false, rgb(0.45, 0.45, 0.45));
        }
      }

      y -= rowH;
    }

    drawText(
      page,
      "Nota: Si la hora FIN es menor que INICIO, el turno acaba al dia siguiente (+1).",
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
function HorarioSemanal({ trabajadores }: { trabajadores: TrabajadorRow[] }) {
  const auth = useAuth();
  const isAdmin = auth.role === "Administrador";

  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [asignaciones, setAsignaciones] = useState<Asignacion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));

  const [myTrabajadorId, setMyTrabajadorId] = useState<number | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [selectedTrabajadorId, setSelectedTrabajadorId] = useState<number | null>(null);
  const [selectedFecha, setSelectedFecha] = useState<string>("");

  const [editIdAsignacion, setEditIdAsignacion] = useState<number | null>(null);

  const [idTurno, setIdTurno] = useState<number | "">("");
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

  const trabajadoresVisibles = useMemo(() => {
    if (isAdmin) return trabajadoresSafe;
    if (!myTrabajadorId) return [];
    return trabajadoresSafe.filter((t) => t.ID_Trabajador === myTrabajadorId);
  }, [isAdmin, trabajadoresSafe, myTrabajadorId]);

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

  const cargar = async () => {
    setError(null);
    setLoading(true);

    try {
      const lunes = toYMD(weekStart);

      const rawTurnos = await turnosGetAll();
      setTurnos(asArray<Turno>(rawTurnos));

      if (!isAdmin && auth.idUsuario) {
        const idT = await trabajadoresGetTrabajadorIdByUsuario(auth.idUsuario);
        setMyTrabajadorId(idT);
      }

      const rawAsignaciones = await horariosGetAsignacionesSemana(lunes);
      setAsignaciones(asArray<Asignacion>(rawAsignaciones));
    } catch (e) {
      console.error(e);
      setError("No se pudo cargar el horario semanal.");
      setTurnos([]);
      setAsignaciones([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, auth.role, auth.idUsuario]);

  const copiarSemanaAnterior = async () => {
    if (!isAdmin) return;

    const toMonday = toYMD(weekStart);
    const fromMonday = toYMD(addDays(weekStart, -7));

    const ok = window.confirm(
      `Esto copiara la semana ${fromMonday} a ${toMonday} y sobrescribira la semana destino. Continuar?`,
    );
    if (!ok) return;

    setError(null);
    setLoading(true);
    try {
      await horariosCopySemanaAsignaciones({ fromMonday, toMonday, overwrite: true });
      await cargar();
    } catch (e) {
      console.error(e);
      setError("No se pudo copiar la semana anterior.");
    } finally {
      setLoading(false);
    }
  };

  const establecerPredeterminado = async () => {
    if (!isAdmin) return;

    const lunes = toYMD(weekStart);
    const ok = window.confirm(
      `Guardare como horario predeterminado la semana visible (${lunes}).\n` +
      `Se aplicara automaticamente a la semana actual real y futuras SOLO si no hay nada pintado.\n\nContinuar?`,
    );
    if (!ok) return;

    setError(null);
    setLoading(true);
    try {
      const done = await horariosSetPredeterminadoDesdeSemana(lunes);
      if (!done) {
        toast.error("No se pudo", "Esa semana no tiene asignaciones para guardar como predeterminado.");
        return;
      }
      toast.success("Listo", "Horario predeterminado guardado.");
      await cargar();
    } catch (e) {
      console.error(e);
      setError("No se pudo establecer el horario predeterminado.");
    } finally {
      setLoading(false);
    }
  };

  const guardarPDF = async () => {
    if (!isAdmin) return;
    setError(null);
    setLoading(true);

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
      console.error(e);
      setError("No se pudo generar el PDF del horario.");
    } finally {
      setLoading(false);
    }
  };

  const openCreate = (idTrab: number, fecha: string) => {
    if (!isAdmin) return;

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

    setModalOpen(true);
  };

  const openEdit = (a: Asignacion) => {
    if (!isAdmin) return;

    if ((a.ID_Asignacion ?? 0) <= 0) {
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

    setTurnoPartido(false);
    setHoraInicio1(hhmm(a.Hora_Inicio));
    setHoraFin1(hhmm(a.Hora_Fin));
    setHoraInicio2("");
    setHoraFin2("");

    setModalOpen(true);
  };

  const closeModal = () => setModalOpen(false);

  const validateRange = (ini: string, fin: string) => {
    if (!ini || !fin) return "Debes indicar hora inicio y hora fin.";
    if (ini.length !== 5 || fin.length !== 5) return "Hora invalida (usa HH:mm).";
    if (ini === fin) return "Inicio y fin no pueden ser iguales.";
    return null;
  };

  const guardarModal = async () => {
    setError(null);

    if (!isAdmin) return;
    if (!selectedTrabajadorId || !selectedFecha) return;
    if (!idTurno) return setError("Selecciona un turno");

    const err1 = validateRange(horaInicio1, horaFin1);
    if (err1) return setError(err1);

    if (turnoPartido) {
      const err2 = validateRange(horaInicio2, horaFin2);
      if (err2) return setError(`Tramo 2: ${err2}`);
    }

    try {
      setLoading(true);

      if (modalMode === "create") {
        await horariosCreateAsignacion({
          idTrabajador: selectedTrabajadorId,
          fecha: selectedFecha,
          idTurno: Number(idTurno),
          area,
          horaInicio: horaInicio1,
          horaFin: horaFin1,
          notas: notas ? notas : null,
        });

        if (turnoPartido) {
          await horariosCreateAsignacion({
            idTrabajador: selectedTrabajadorId,
            fecha: selectedFecha,
            idTurno: Number(idTurno),
            area,
            horaInicio: horaInicio2,
            horaFin: horaFin2,
            notas: notas ? notas : null,
          });
        }
      } else {
        if (!editIdAsignacion) return;
        await horariosUpdateAsignacion({
          idAsignacion: editIdAsignacion,
          idTurno: Number(idTurno),
          area,
          horaInicio: horaInicio1,
          horaFin: horaFin1,
          notas: notas ? notas : null,
        });
      }

      await cargar();
      closeModal();
    } catch (e) {
      console.error(e);
      setError("No se pudo guardar la asignacion.");
    } finally {
      setLoading(false);
    }
  };

  const borrarAsignacion = async (idAsignacion: number) => {
    if (!isAdmin) return;

    if (idAsignacion <= 0) {
      toast.info("Predeterminado", "Este turno es predeterminado. Crea uno real y luego podrás borrarlo.");
      return;
    }

    try {
      setLoading(true);
      await horariosDeleteAsignacion(idAsignacion);
      await cargar();
    } catch (e) {
      console.error(e);
      setError("No se pudo borrar la asignacion.");
    } finally {
      setLoading(false);
    }
  };

  const btnBase =
    "border-2 rounded-xl font-medium transition-all duration-300 whitespace-nowrap shrink-0 px-2 py-2 text-[11px] sm:px-3 sm:py-2 sm:text-sm";

  return (
    <div className="w-full bg-blanco rounded-xl p-3 sm:p-4 shadow-xs flex flex-col gap-3">
      <div className="w-full flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="flex flex-col">
          <h3 className="text-lg sm:text-xl font-bold">HORARIO SEMANAL</h3>
          <p className="text-sm text-negro/60">
            {isAdmin
              ? "Arriba tienes trabajadores. Aqui puedes asignar turnos por semana."
              : "Tu horario de esta semana (solo lectura)."}
          </p>
        </div>

        <div className="w-full lg:w-auto">
          <div
            className="
              grid grid-cols-2 gap-2
              sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:gap-2
              lg:flex-nowrap
            "
          >
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={guardarPDF}
                  className={`${btnBase} border-negro/30 text-negro hover:bg-negro hover:text-white disabled:opacity-60 disabled:cursor-not-allowed w-full sm:w-auto`}
                  disabled={loading}
                >
                  Guardar PDF
                </button>

                <button
                  type="button"
                  onClick={copiarSemanaAnterior}
                  className={`${btnBase} border-verde text-verde hover:bg-verde hover:text-white disabled:opacity-60 disabled:cursor-not-allowed w-full sm:w-auto`}
                  disabled={loading}
                >
                  Copiar semana anterior
                </button>

                <button
                  type="button"
                  onClick={establecerPredeterminado}
                  className={`${btnBase} border-negro/30 text-negro hover:bg-negro hover:text-white disabled:opacity-60 disabled:cursor-not-allowed w-full sm:w-auto`}
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
              className={`${btnBase} border-negro/30 text-negro hover:bg-negro hover:text-white w-full sm:w-auto`}
            >
              Semana -
            </button>

            <button
              type="button"
              onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
              className={`${btnBase} border-negro/30 text-negro hover:bg-negro hover:text-white w-full sm:w-auto`}
            >
              Hoy
            </button>

            <button
              type="button"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              className={`${btnBase} border-negro/30 text-negro hover:bg-negro hover:text-white w-full sm:w-auto col-span-2 sm:col-span-1`}
            >
              Semana +
            </button>
          </div>

          <p className="mt-2 text-[11px] text-negro/45 sm:hidden">
            En pantallas pequeñas los botones se ordenan en filas.
          </p>
        </div>
      </div>

      {error && (
        <div className="w-full rounded-xl border border-rojo/30 bg-rojo/10 p-3 text-sm text-rojo">
          {error}
        </div>
      )}

      <div className="md:hidden flex flex-col gap-3">
        {trabajadoresVisibles.map((t) => (
          <div
            key={t.ID_Trabajador}
            className="rounded-xl border border-negro/10 bg-white p-3 flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1">
              <div className="font-semibold text-base">
                {t.Nombre} {t.Apellido ?? ""}
              </div>
              <div className="text-xs text-negro/60">
                {t.Puesto ?? "—"} • {t.Telefono ?? "—"}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {weekDays.map((d) => {
                const key = `${t.ID_Trabajador}|${d.ymd}`;
                const list = asignacionesByCell.get(key) ?? [];

                return (
                  <div key={d.ymd} className="rounded-xl border border-negro/10 p-2 bg-blanco">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col min-w-0">
                        <div className="font-semibold text-sm">{d.label}</div>
                        <div className="text-[11px] text-negro/60 truncate">{d.ymd}</div>
                      </div>

                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => openCreate(t.ID_Trabajador, d.ymd)}
                          className="border border-negro/20 rounded-lg px-2 py-1 text-[11px] text-negro/70 hover:bg-negro hover:text-white transition-all whitespace-nowrap shrink-0"
                          title="Añadir asignación"
                        >
                          <span className="sm:hidden">+</span>
                          <span className="hidden sm:inline">+ Añadir</span>
                        </button>
                      )}
                    </div>

                    <div className="mt-2 flex flex-col gap-2">
                      {list.length === 0 ? (
                        <div className="text-[11px] text-negro/45">
                          {isAdmin ? "Sin asignación" : "—"}
                        </div>
                      ) : (
                        list.map((a) => {
                          const ini = hhmm(a.Hora_Inicio);
                          const fin = hhmm(a.Hora_Fin);
                          const showTime =
                            ini && fin
                              ? `${ini}-${fin}${crossesMidnight(ini, fin) ? " (+1)" : ""}`
                              : "";

                          const isVirtual = (a.ID_Asignacion ?? 0) <= 0;

                          return (
                            <div
                              key={`${a.ID_Asignacion}-${a.ID_Turno}-${a.Hora_Inicio ?? ""}-${a.Hora_Fin ?? ""}-${a.Area ?? ""}-${a.Notas ?? ""}`}
                              className="rounded-xl border border-negro/10 bg-white px-2 py-2 flex flex-col gap-1"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-semibold truncate">
                                    {a.Nombre_Turno}
                                  </div>
                                  <div className="text-[11px] text-negro/60">
                                    {a.Area}
                                    {showTime ? ` • ${showTime}` : ""}
                                  </div>

                                  {isVirtual && (
                                    <div className="mt-1 text-[11px] text-negro/45">
                                      Predeterminado
                                    </div>
                                  )}
                                </div>

                                {isAdmin && !isVirtual && (
                                  <div className="shrink-0">
                                    <div className="grid grid-cols-2 gap-1">
                                      <button
                                        type="button"
                                        onClick={() => openEdit(a)}
                                        className="text-[11px] border border-verde text-verde rounded-lg px-2 py-1 hover:bg-verde hover:text-white transition-all"
                                      >
                                        Editar
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => borrarAsignacion(a.ID_Asignacion)}
                                        className="text-[11px] border border-rojo text-rojo rounded-lg px-2 py-1 hover:bg-rojo hover:text-white transition-all"
                                        title="Borrar"
                                      >
                                        X
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {a.Notas ? <div className="text-[11px] text-negro/60">{a.Notas}</div> : null}
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

      <div className="hidden md:block">
        <div className="w-full overflow-x-auto border border-negro/10 rounded-xl">
          <div className="min-w-[900px]">
            <div className="grid grid-cols-[260px_repeat(7,1fr)] border-b border-negro/10 bg-negro/5">
              <div className="p-3 font-semibold">Trabajador</div>
              {weekDays.map((d) => (
                <div key={d.ymd} className="p-3 font-semibold text-center">
                  <div>{d.label}</div>
                  <div className="text-xs text-negro/60">{d.ymd}</div>
                </div>
              ))}
            </div>

            {trabajadoresVisibles.map((t) => (
              <div
                key={t.ID_Trabajador}
                className="grid grid-cols-[260px_repeat(7,1fr)] border-b border-negro/10"
              >
                <div className="p-3">
                  <div className="font-semibold">
                    {t.Nombre} {t.Apellido ?? ""}
                  </div>
                  <div className="text-xs text-negro/60">
                    {t.Puesto ?? "—"} • {t.Telefono ?? "—"}
                  </div>
                </div>

                {weekDays.map((d) => {
                  const key = `${t.ID_Trabajador}|${d.ymd}`;
                  const list = asignacionesByCell.get(key) ?? [];

                  return (
                    <div key={d.ymd} className="p-2 border-l border-negro/10">
                      <div className="flex flex-col gap-2">
                        {list.length === 0 ? (
                          <div className="text-xs text-negro/40">{isAdmin ? "Sin asignacion" : "—"}</div>
                        ) : (
                          list.map((a) => {
                            const effIni = hhmm(a.Hora_Inicio);
                            const effFin = hhmm(a.Hora_Fin);
                            const showTime =
                              effIni && effFin
                                ? `${effIni}-${effFin}${crossesMidnight(effIni, effFin) ? " (+1)" : ""}`
                                : "";

                            const isVirtual = (a.ID_Asignacion ?? 0) <= 0;

                            return (
                              <div
                                key={`${a.ID_Asignacion}-${a.ID_Turno}-${a.Hora_Inicio ?? ""}-${a.Hora_Fin ?? ""}-${a.Area ?? ""}-${a.Notas ?? ""}`}
                                className="rounded-xl border border-negro/10 bg-blanco px-2 py-2 flex flex-col gap-1"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex flex-col">
                                    <div className="text-sm font-semibold">{a.Nombre_Turno}</div>
                                    <div className="text-xs text-negro/60">
                                      {a.Area}
                                      {showTime ? ` • ${showTime}` : ""}
                                    </div>

                                    {isVirtual && (
                                      <div className="mt-1 text-[11px] text-negro/45">
                                        Predeterminado
                                      </div>
                                    )}
                                  </div>

                                  {isAdmin && !isVirtual && (
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => openEdit(a)}
                                        className="text-xs border border-verde text-verde rounded-lg px-2 py-1 hover:bg-verde hover:text-white transition-all"
                                      >
                                        Editar
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => borrarAsignacion(a.ID_Asignacion)}
                                        className="text-xs border border-rojo text-rojo rounded-lg px-2 py-1 hover:bg-rojo hover:text-white transition-all"
                                      >
                                        X
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {a.Notas ? <div className="text-xs text-negro/60">{a.Notas}</div> : null}
                              </div>
                            );
                          })
                        )}

                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => openCreate(t.ID_Trabajador, d.ymd)}
                            className="border border-negro/20 rounded-xl px-3 py-2 text-xs text-negro/70 hover:bg-negro hover:text-white transition-all"
                          >
                            + Anadir
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
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-negro/40 p-4">
          <div className="w-full max-w-xl bg-blanco rounded-2xl shadow-lg border border-negro/10 p-5 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col">
                <h4 className="text-lg font-bold">
                  {modalMode === "create" ? "Nueva asignacion" : "Editar asignacion"}
                </h4>
                <p className="text-sm text-negro/60">
                  Fecha: <span className="font-medium">{selectedFecha}</span>
                </p>
                <p className="text-xs text-negro/50">
                  Si FIN es menor que INICIO, se interpreta como turno nocturno (acaba al dia siguiente +1).
                </p>
              </div>

              <button
                type="button"
                onClick={closeModal}
                className="border-2 border-negro/30 text-negro rounded-xl px-3 py-2 font-medium hover:bg-negro hover:text-white transition-all"
              >
                Cerrar
              </button>
            </div>

            {error && (
              <div className="w-full rounded-xl border border-rojo/30 bg-rojo/10 p-3 text-sm text-rojo">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Turno</label>
                <select
                  value={idTurno}
                  onChange={(e) => setIdTurno(e.target.value ? Number(e.target.value) : "")}
                  className="border border-negro/15 rounded-xl px-3 py-2 bg-blanco outline-none focus:border-negro/30"
                >
                  <option value="">Selecciona un turno</option>
                  {turnos.map((t) => (
                    <option key={t.ID_Turno} value={t.ID_Turno}>
                      {t.Nombre_Turno}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Area</label>
                <select
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className="border border-negro/15 rounded-xl px-3 py-2 bg-blanco outline-none focus:border-negro/30"
                >
                  <option value="Sala">Sala</option>
                  <option value="Cocina">Cocina</option>
                </select>
              </div>

              <div className="md:col-span-2 flex items-center gap-2">
                <input
                  id="partido"
                  type="checkbox"
                  checked={turnoPartido}
                  onChange={(e) => setTurnoPartido(e.target.checked)}
                  className="w-4 h-4"
                  disabled={modalMode === "edit"}
                />
                <label htmlFor="partido" className="text-sm font-medium">
                  Turno partido (2 tramos)
                </label>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Hora inicio (tramo 1)</label>
                <input
                  type="time"
                  value={horaInicio1}
                  onChange={(e) => setHoraInicio1(e.target.value)}
                  className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Hora fin (tramo 1)</label>
                <input
                  type="time"
                  value={horaFin1}
                  onChange={(e) => setHoraFin1(e.target.value)}
                  className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                />
              </div>

              {turnoPartido && modalMode === "create" && (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium">Hora inicio (tramo 2)</label>
                    <input
                      type="time"
                      value={horaInicio2}
                      onChange={(e) => setHoraInicio2(e.target.value)}
                      className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium">Hora fin (tramo 2)</label>
                    <input
                      type="time"
                      value={horaFin2}
                      onChange={(e) => setHoraFin2(e.target.value)}
                      className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                    />
                  </div>
                </>
              )}

              <div className="flex flex-col gap-1 md:col-span-2">
                <label className="text-sm font-medium">Notas (opcional)</label>
                <input
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                  className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                  placeholder="Ej: cubrir a X, turno partido, etc."
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeModal}
                className="border-2 border-negro rounded-xl px-4 py-2 text-negro transition-all duration-300 hover:bg-negro hover:text-white"
              >
                Cancelar
              </button>

              <button
                type="button"
                disabled={loading}
                onClick={guardarModal}
                className="border-2 border-verde text-verde rounded-xl px-4 py-2 font-medium transition-all duration-300 hover:bg-verde hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
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
  const isAdmin = auth.role === "Administrador";
  const toast = useToast();

  const [trabajadores, setTrabajadores] = useState<TrabajadorRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const trabajadoresSafe = useMemo(() => asArray<TrabajadorRow>(trabajadores), [trabajadores]);

  const cargarTrabajadores = useCallback(async () => {
    try {
      setError(null);
      const raw = await trabajadoresGetAll();
      const rows = asArray<TrabajadorRow>(raw);
      setTrabajadores(rows);
    } catch (e) {
      console.error("Fallo al cargar trabajadores", e);
      setError("No se pudieron cargar los trabajadores.");
      setTrabajadores([]);
    }
  }, []);

  useEffect(() => {
    void cargarTrabajadores();
  }, [cargarTrabajadores, location.key]);

  return (
    <div className="w-full min-h-full bg-gris flex flex-col p-4 sm:p-6 lg:p-10 pt-5 gap-4 items-center">
      <div className="flex flex-col gap-4 bg-blanco w-full p-4 rounded-xl shadow-xs justify-center items-center">
        <div className="w-full flex flex-col items-center gap-3">
          <h2 className="text-2xl font-bold text-center">TRABAJADORES</h2>

          {isAdmin && (
            <Link to="/Trabajadores/nuevo-trabajador" className="w-fit">
              <div
                className="
                  group flex gap-2 w-fit items-center justify-center
                  cursor-pointer border-2 border-verde rounded-xl
                  text-verde transition-all duration-300 ease-out
                  hover:bg-verde hover:text-white hover:shadow-md
                  px-3 py-2 text-sm
                  sm:px-3 sm:py-1 sm:text-base
                "
              >
                <LapizSVG
                  width={18}
                  height={18}
                  className="transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-6"
                />
                <p className="font-medium">Añadir Nuevo Trabajador</p>
              </div>
            </Link>
          )}
        </div>

        {error && <p className="text-rojo text-sm">{error}</p>}
      </div>

      <div className="w-full bg-blanco rounded-xl p-4 shadow-xs flex flex-col gap-2">
        {trabajadoresSafe.length === 0 ? (
          <p className="text-negro/60">No hay trabajadores todavía.</p>
        ) : (
          trabajadoresSafe.map((t) => (
            <div
              key={t.ID_Trabajador}
              className="w-full flex flex-col md:flex-row md:items-center md:justify-between gap-3 border border-negro/10 rounded-xl px-3 py-3"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-lg">
                    {t.Nombre} {t.Apellido ?? ""}
                  </span>

                  <span className="text-xs px-2 py-1 rounded-lg border border-negro/10">
                    {t.Nombre_Rol}
                  </span>

                  <span
                    className={`text-xs px-2 py-1 rounded-lg border ${t.Estado === "Activo"
                      ? "border-verde/30 text-verde bg-verde/10"
                      : "border-rojo/30 text-rojo bg-rojo/10"
                      }`}
                  >
                    {t.Estado}
                  </span>
                </div>

                <div className="flex flex-wrap gap-4 text-sm text-negro/70">
                  <span>
                    <span className="text-negro/50">Teléfono:</span>{" "}
                    {t.Telefono ?? "—"}
                  </span>
                  <span>
                    <span className="text-negro/50">Puesto:</span>{" "}
                    {t.Puesto ?? "—"}
                  </span>
                </div>
              </div>

              {isAdmin && (
                <div className="w-full md:w-auto flex justify-center md:justify-end">
                  <div className="flex flex-wrap justify-center md:justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/Trabajadores/editar/${t.ID_Trabajador}`)}
                      className="
                        border-2 border-verde text-verde rounded-xl
                        font-medium transition-all duration-300 hover:bg-verde hover:text-white
                        px-3 py-1.5 text-xs
                        sm:px-4 sm:py-2 sm:text-sm
                      "
                    >
                      Editar
                    </button>

                    <button
                      type="button"
                      onClick={() => toast.info("Por implementar", "Estadísticas (pendiente)")}
                      className="
                        border-2 border-negro/30 text-negro rounded-xl
                        font-medium transition-all duration-300 hover:bg-negro hover:text-white
                        px-3 py-1.5 text-xs
                        sm:px-4 sm:py-2 sm:text-sm
                      "
                    >
                      Estadísticas
                    </button>

                    <button
                      type="button"
                      onClick={() => toast.info("Por implementar", "Dar de baja (pendiente)")}
                      className="
                        border-2 border-rojo text-rojo rounded-xl
                        font-medium transition-all duration-300 hover:bg-rojo hover:text-white
                        px-3 py-1.5 text-xs
                        sm:px-4 sm:py-2 sm:text-sm
                      "
                    >
                      Dar de baja
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <HorarioSemanal trabajadores={trabajadoresSafe} />
    </div>
  );
}

export default Trabajadores;