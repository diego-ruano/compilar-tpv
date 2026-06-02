// src/pages/Tareas.tsx
import React, { useEffect, useMemo, useState } from "react";
import { tareasApi } from "../components/tareas/tareasApis";
import { useAuth } from "../zustand/useAuth";
import { ReactComponent as LapizSVG } from "../assets/svg/LapizSVG.svg";

type TareaUI = {
  ID_Tarea: number;
  Titulo: string;
  Descripcion: string | null;
  Fecha_Creacion?: string;
  Fecha_Limite: string | null;
  Asignada_At?: string;
  Estado?: "PENDIENTE" | "FINALIZADA";
  Finalizada_At?: string | null;
  Total_Asignados?: number;
  Total_Finalizadas?: number;
};

type TrabajadorUI = {
  ID_Trabajador: number;
  ID_Usuario: number;
  Nombre: string;
  Apellido: string | null;
  Puesto: string | null;
  Email: string;
};

function fmtFechaHora(s?: string | null) {
  if (!s) return "";
  return s.replace("T", " ");
}

function isTodayLocalFromSqlDateTime(dt?: string | null) {
  if (!dt) return false;
  const d = dt.slice(0, 10);
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return d === `${y}-${m}-${day}`;
}

function Column({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full min-w-0 rounded-2xl bg-blanco p-3 shadow-md sm:rounded-3xl sm:p-4 lg:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="truncate text-base font-semibold sm:text-lg lg:text-xl">
          {title}
        </h3>
      </div>
      <div className="flex flex-col gap-2.5 sm:gap-3">{children}</div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  done,
  onClick,
}: {
  title: string;
  subtitle?: string;
  done?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl border border-black/5 bg-white p-3 text-left shadow-sm transition hover:shadow-md active:scale-[0.99] sm:rounded-2xl sm:p-3.5 lg:p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            {done ? (
              <span className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />
            ) : (
              <span className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-yellow-500" />
            )}

            <p
              className={`min-w-0 truncate text-sm font-medium sm:text-[0.95rem] lg:text-base ${
                done ? "line-through text-black/50" : ""
              }`}
              title={title}
            >
              {title}
            </p>
          </div>

          {subtitle ? (
            <p className="mt-1 line-clamp-2 text-xs text-black/60 sm:text-sm">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function Modal({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[999] overflow-y-auto bg-black/40">
      <div className="flex min-h-full items-start justify-center p-2 sm:p-4 md:items-center">
        <div className="flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl sm:max-h-[88dvh] sm:rounded-3xl">
          <div className="flex flex-col gap-2 border-b border-black/10 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4 lg:p-5">
            <h2 className="break-words text-base font-semibold leading-tight sm:text-lg lg:text-xl">
              {title}
            </h2>

            <button
              className="self-end rounded-xl bg-black/5 px-3 py-2 text-sm hover:bg-black/10 sm:self-auto"
              onClick={onClose}
            >
              Cerrar
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4 lg:p-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Tareas() {
  const { role, idTrabajador } = useAuth();
  const isAdmin = role === "Administrador";

  const [loading, setLoading] = useState(true);
  const [trabajadores, setTrabajadores] = useState<TrabajadorUI[]>([]);
  const [tareasAdmin, setTareasAdmin] = useState<TareaUI[]>([]);
  const [misTareas, setMisTareas] = useState<TareaUI[]>([]);
  const [modalNueva, setModalNueva] = useState(false);
  const [modalDetalle, setModalDetalle] = useState(false);
  const [selected, setSelected] = useState<TareaUI | null>(null);

  const [confirmAccion, setConfirmAccion] = useState<
    | { tipo: "borrar_tarea"; tarea: TareaUI }
    | null
  >(null);
  const [confirmando, setConfirmando] = useState(false);

  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [fechaLimite, setFechaLimite] = useState<string>("");
  const [idsAsignados, setIdsAsignados] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  const [adminEditTitulo, setAdminEditTitulo] = useState("");
  const [adminEditDescripcion, setAdminEditDescripcion] = useState("");
  const [adminEditFechaLimite, setAdminEditFechaLimite] =
    useState<string>("");
  const [adminEditIdsAsignados, setAdminEditIdsAsignados] = useState<number[]>(
    [],
  );
  const [adminDetalleAsignados, setAdminDetalleAsignados] = useState<
    Array<{
      ID_Trabajador: number;
      Nombre: string;
      Apellido: string | null;
      Puesto: string | null;
      Asignada_At: string;
      Estado: string;
      Finalizada_At: string | null;
    }>
  >([]);
  const [adminSaving, setAdminSaving] = useState(false);
  const [adminDeleting, setAdminDeleting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      if (isAdmin) {
        const [trs, ts] = await Promise.all([
          tareasApi.getTrabajadores(),
          tareasApi.getTareasAdmin(),
        ]);

        setTrabajadores(trs as any);
        setTareasAdmin(ts as any);
      } else {
        if (!idTrabajador) {
          setMisTareas([]);
        } else {
          const t = await tareasApi.getMisTareas(idTrabajador);
          setMisTareas(t as any);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, idTrabajador]);

  const tareasPendientes = useMemo(() => {
    const src = isAdmin ? tareasAdmin : misTareas;
    if (isAdmin) {
      return src.filter(
        (t) => (t.Total_Asignados ?? 0) > (t.Total_Finalizadas ?? 0),
      );
    }
    return src.filter((t) => (t.Estado ?? "PENDIENTE") === "PENDIENTE");
  }, [isAdmin, tareasAdmin, misTareas]);

  const tareasFinalizadasHoy = useMemo(() => {
    const src = isAdmin ? tareasAdmin : misTareas;

    if (isAdmin) {
      return src.filter(
        (t) =>
          (t.Total_Asignados ?? 0) > 0 &&
          (t.Total_Finalizadas ?? 0) === (t.Total_Asignados ?? 0),
      );
    }

    return src.filter(
      (t) =>
        (t.Estado ?? "PENDIENTE") === "FINALIZADA" &&
        isTodayLocalFromSqlDateTime(t.Finalizada_At ?? null),
    );
  }, [isAdmin, tareasAdmin, misTareas]);

  const toggleAsignado = (id: number) => {
    setIdsAsignados((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const crearTarea = async () => {
    if (!titulo.trim()) return;
    if (!idsAsignados.length) return;

    setSaving(true);
    try {
      const ok = await tareasApi.createTarea({
        titulo: titulo.trim(),
        descripcion: descripcion.trim() || null,
        fechaLimite: fechaLimite?.trim() || null,
        idsTrabajadores: idsAsignados,
      });

      if (ok) {
        setTitulo("");
        setDescripcion("");
        setFechaLimite("");
        setIdsAsignados([]);
        setModalNueva(false);
        await refresh();
      }
    } finally {
      setSaving(false);
    }
  };

  const finalizar = async () => {
    if (!selected) return;
    if (!idTrabajador) return;

    await tareasApi.marcarTareaFinalizada({
      idTarea: selected.ID_Tarea,
      idTrabajador,
    });

    setModalDetalle(false);
    setSelected(null);
    await refresh();
  };

  const openDetalle = async (t: TareaUI) => {
    setConfirmAccion(null);
    setSelected(t);
    setModalDetalle(true);

    if (!isAdmin) return;

    try {
      const [tarea, trs, asigs] = await Promise.all([
        tareasApi.getTareaById(t.ID_Tarea),
        tareasApi.getTrabajadores(),
        tareasApi.getTareaAsignados(t.ID_Tarea),
      ]);

      setTrabajadores(trs as any);
      setAdminDetalleAsignados(asigs as any);

      const finalTitulo = (tarea as any)?.Titulo ?? t.Titulo ?? "";
      const finalDesc = (tarea as any)?.Descripcion ?? t.Descripcion ?? "";
      const finalLimite = (tarea as any)?.Fecha_Limite ?? t.Fecha_Limite ?? "";

      setAdminEditTitulo(finalTitulo);
      setAdminEditDescripcion(finalDesc || "");
      setAdminEditFechaLimite(finalLimite || "");

      const ids = (asigs ?? [])
        .map((a: any) => Number(a.ID_Trabajador))
        .filter((n: number) => Number.isFinite(n) && n > 0);

      setAdminEditIdsAsignados(ids);
    } catch {
      setAdminEditTitulo(t.Titulo ?? "");
      setAdminEditDescripcion(t.Descripcion ?? "");
      setAdminEditFechaLimite(t.Fecha_Limite ?? "");
      setAdminEditIdsAsignados([]);
      setAdminDetalleAsignados([]);
    }
  };

  const toggleAsignadoAdmin = (idTrab: number) => {
    setAdminEditIdsAsignados((prev) =>
      prev.includes(idTrab) ? prev.filter((x) => x !== idTrab) : [...prev, idTrab],
    );
  };

  const guardarCambiosAdmin = async () => {
    if (!selected) return;
    if (!adminEditTitulo.trim()) return;

    setAdminSaving(true);
    try {
      await tareasApi.updateTarea({
        idTarea: selected.ID_Tarea,
        titulo: adminEditTitulo.trim(),
        descripcion: adminEditDescripcion.trim() || null,
        fechaLimite: adminEditFechaLimite?.trim() || null,
      });

      await tareasApi.setAsignacionesTarea({
        idTarea: selected.ID_Tarea,
        idsTrabajadores: adminEditIdsAsignados,
      });

      setModalDetalle(false);
      setSelected(null);
      await refresh();
    } finally {
      setAdminSaving(false);
    }
  };

  const borrarTareaAdmin = () => {
    if (!selected) return;
    setConfirmAccion({ tipo: "borrar_tarea", tarea: selected });
  };

  const confirmarBorrarTareaAdmin = async () => {
    if (!confirmAccion || confirmAccion.tipo !== "borrar_tarea") return;

    setConfirmando(true);
    setAdminDeleting(true);
    try {
      await tareasApi.deleteTarea(confirmAccion.tarea.ID_Tarea);

      setConfirmAccion(null);
      setModalDetalle(false);
      setSelected(null);

      await refresh();
    } finally {
      setAdminDeleting(false);
      setConfirmando(false);
    }
  };

  const modalTitle = isAdmin
    ? adminEditTitulo?.trim() || selected?.Titulo || "Detalle de tarea"
    : (selected?.Titulo ?? "Detalle de tarea");

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col p-2 sm:p-3 lg:p-4">
      <div className="mb-3 flex w-full flex-col items-stretch justify-center gap-3 rounded-2xl bg-blanco p-3 shadow-xs sm:mb-4 sm:rounded-3xl sm:p-4 lg:flex-row lg:items-center lg:gap-6 lg:p-5">
        <h2 className="order-1 text-center text-xl font-bold tracking-tight sm:text-2xl lg:order-none lg:text-3xl">
          TAREAS
        </h2>

        {isAdmin ? (
          <div
            onClick={() => setModalNueva(true)}
            className="
              order-2 group mx-auto flex w-full max-w-[220px] items-center justify-center gap-2
              rounded-xl border-2 border-verde px-3 py-2 text-verde
              transition-all duration-300 ease-out
              hover:bg-verde hover:text-white hover:shadow-md
              sm:max-w-[240px] sm:rounded-2xl
              lg:mx-0 lg:w-fit lg:px-4
            "
          >
            <LapizSVG
              width={22}
              height={22}
              className="shrink-0 transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-6 sm:h-6 sm:w-6"
            />
            <p className="truncate text-sm font-medium sm:text-base">Crear tarea</p>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="px-1 text-sm text-black/60 sm:text-base">Cargando…</div>
      ) : (
        <div className="grid w-full grid-cols-1 gap-3 pb-2 sm:gap-4 lg:grid-cols-2 lg:gap-5">
          <div className="order-1 min-w-0 lg:order-2">
            <Column title={isAdmin ? "Completadas" : "Completadas hoy"}>
              {tareasFinalizadasHoy.length ? (
                tareasFinalizadasHoy.map((t) => {
                  const done = true;
                  const subtitle = isAdmin
                    ? `${t.Total_Finalizadas ?? 0}/${t.Total_Asignados ?? 0} finalizadas`
                    : (t.Descripcion ?? "");
                  return (
                    <Card
                      key={t.ID_Tarea}
                      title={t.Titulo}
                      subtitle={subtitle}
                      done={done}
                      onClick={() => openDetalle(t)}
                    />
                  );
                })
              ) : (
                <p className="text-sm text-black/50 sm:text-base">
                  {isAdmin ? "Aún no hay tareas completadas." : "Hoy no has completado tareas."}
                </p>
              )}
            </Column>
          </div>

          <div className="order-2 min-w-0 lg:order-1">
            <Column title="Pendientes">
              {tareasPendientes.length ? (
                tareasPendientes.map((t) => {
                  const subtitle = isAdmin
                    ? `${t.Total_Finalizadas ?? 0}/${t.Total_Asignados ?? 0} finalizadas`
                    : (t.Descripcion ?? "");

                  const done =
                    !isAdmin && (t.Estado ?? "PENDIENTE") === "FINALIZADA";

                  return (
                    <Card
                      key={t.ID_Tarea}
                      title={t.Titulo}
                      subtitle={subtitle}
                      done={done}
                      onClick={() => openDetalle(t)}
                    />
                  );
                })
              ) : (
                <p className="text-sm text-black/50 sm:text-base">No hay tareas pendientes.</p>
              )}
            </Column>
          </div>
        </div>
      )}

      <Modal open={modalNueva} onClose={() => setModalNueva(false)} title="Crear tarea">
        <div className="flex flex-col gap-3 sm:gap-4">
          <div>
            <p className="mb-1 text-sm text-black/60">Nombre</p>
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              className="w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm sm:rounded-2xl sm:text-base"
              placeholder="Ej: Limpiar terraza"
            />
          </div>

          <div>
            <p className="mb-1 text-sm text-black/60">Descripción</p>
            <textarea
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              className="min-h-[96px] w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm sm:min-h-[110px] sm:rounded-2xl sm:text-base"
              placeholder="Detalles de la tarea…"
            />
          </div>

          <div>
            <p className="mb-1 text-sm text-black/60">Fecha límite</p>
            <input
              type="date"
              value={fechaLimite}
              onChange={(e) => setFechaLimite(e.target.value)}
              className="w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm sm:w-auto sm:rounded-2xl sm:text-base"
            />
          </div>

          <div>
            <p className="mb-2 text-sm text-black/60">Asignar a</p>

            <div className="flex max-h-[240px] flex-col gap-2 overflow-auto rounded-xl border border-black/10 p-2 sm:rounded-2xl sm:p-3">
              {trabajadores.map((tr) => {
                const checked = idsAsignados.includes(tr.ID_Trabajador);
                return (
                  <label
                    key={tr.ID_Trabajador}
                    className="flex cursor-pointer flex-col gap-1 rounded-lg p-2 hover:bg-black/5 sm:flex-row sm:items-center sm:gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAsignado(tr.ID_Trabajador)}
                      />
                      <span className="font-medium">
                        {tr.Nombre} {tr.Apellido ?? ""}
                      </span>
                    </div>
                    <span className="pl-6 text-sm text-black/50 sm:pl-0">
                      {tr.Puesto ?? tr.Email}
                    </span>
                  </label>
                );
              })}

              {!trabajadores.length ? (
                <p className="text-sm text-black/50">No hay trabajadores en la BD.</p>
              ) : null}
            </div>
          </div>

          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              onClick={() => setModalNueva(false)}
              className="w-full rounded-xl bg-black/5 px-4 py-2.5 hover:bg-black/10 sm:w-auto sm:rounded-2xl"
              disabled={saving}
            >
              Cancelar
            </button>
            <button
              onClick={crearTarea}
              className="w-full rounded-xl bg-black px-4 py-2.5 text-white hover:opacity-90 disabled:opacity-60 sm:w-auto sm:rounded-2xl"
              disabled={saving || !titulo.trim() || !idsAsignados.length}
            >
              {saving ? "Guardando…" : "Crear"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={modalDetalle}
        onClose={() => {
          setModalDetalle(false);
          setSelected(null);
          setConfirmAccion(null);
        }}
        title={modalTitle}
      >
        {!selected ? null : (
          <div className="flex flex-col gap-3 sm:gap-4">
            {!isAdmin ? (
              <>
                {selected.Descripcion ? (
                  <div>
                    <p className="mb-1 text-sm text-black/60">Descripción</p>
                    <p className="text-sm sm:text-base">{selected.Descripcion}</p>
                  </div>
                ) : (
                  <p className="text-sm text-black/50">Sin descripción.</p>
                )}

                <div className="flex flex-col gap-1 text-sm">
                  <p className="text-black/60">
                    <b>Asignada:</b> {fmtFechaHora(selected.Asignada_At ?? "")}
                  </p>
                  <p className="text-black/60">
                    <b>Fecha límite:</b> {selected.Fecha_Limite ?? "—"}
                  </p>

                  {selected.Estado === "FINALIZADA" ? (
                    <p className="text-black/60">
                      <b>Finalizada:</b> {fmtFechaHora(selected.Finalizada_At ?? "")}
                    </p>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  {selected.Estado === "FINALIZADA" ? (
                    <button
                      className="w-full cursor-default rounded-xl bg-green-600 px-4 py-2.5 text-white opacity-90 sm:w-auto sm:rounded-2xl"
                      disabled
                    >
                      ✅ Finalizada
                    </button>
                  ) : (
                    <button
                      onClick={finalizar}
                      className="w-full rounded-xl bg-black px-4 py-2.5 text-white hover:opacity-90 sm:w-auto sm:rounded-2xl"
                      disabled={!idTrabajador}
                    >
                      Marcar como finalizada
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:gap-4">
                  <div>
                    <p className="mb-1 text-sm text-black/60">Nombre</p>
                    <input
                      value={adminEditTitulo}
                      onChange={(e) => setAdminEditTitulo(e.target.value)}
                      className="w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm sm:rounded-2xl sm:text-base"
                    />
                  </div>

                  <div>
                    <p className="mb-1 text-sm text-black/60">Descripción</p>
                    <textarea
                      value={adminEditDescripcion}
                      onChange={(e) => setAdminEditDescripcion(e.target.value)}
                      className="min-h-[96px] w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm sm:min-h-[110px] sm:rounded-2xl sm:text-base"
                    />
                  </div>

                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
                    <div className="flex-1">
                      <p className="mb-1 text-sm text-black/60">Fecha límite</p>
                      <input
                        type="date"
                        value={adminEditFechaLimite ?? ""}
                        onChange={(e) => setAdminEditFechaLimite(e.target.value)}
                        className="w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm sm:w-auto sm:rounded-2xl sm:text-base"
                      />
                    </div>

                    <div className="text-sm text-black/60 lg:text-right">
                      <p>
                        <b>Creada:</b>{" "}
                        {selected.Fecha_Creacion ? fmtFechaHora(selected.Fecha_Creacion) : "—"}
                      </p>
                      <p>
                        <b>Progreso:</b> {selected.Total_Finalizadas ?? 0}/{selected.Total_Asignados ?? 0}
                      </p>
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-sm text-black/60">
                      Asignación (asignados / no asignados)
                    </p>

                    <div className="flex max-h-[220px] flex-col gap-2 overflow-y-auto rounded-xl border border-black/10 p-2 sm:rounded-2xl sm:p-3">
                      {trabajadores.map((tr) => {
                        const checked = adminEditIdsAsignados.includes(tr.ID_Trabajador);
                        return (
                          <label
                            key={tr.ID_Trabajador}
                            className="flex cursor-pointer flex-col gap-2 rounded-lg p-2 hover:bg-black/5 sm:flex-row sm:items-center sm:gap-2"
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAsignadoAdmin(tr.ID_Trabajador)}
                              />
                              <span className="font-medium">
                                {tr.Nombre} {tr.Apellido ?? ""}
                              </span>
                            </div>

                            <span className="pl-6 text-sm text-black/50 sm:pl-0">
                              {tr.Puesto ?? tr.Email}
                            </span>

                            <span className="text-xs rounded-full bg-black/5 px-2 py-1 sm:ml-auto">
                              {checked ? "Asignado" : "No asignado"}
                            </span>
                          </label>
                        );
                      })}

                      {!trabajadores.length ? (
                        <p className="text-sm text-black/50">No hay trabajadores.</p>
                      ) : null}
                    </div>

                    <p className="mt-2 text-sm text-black/50">
                      Asignados: {adminEditIdsAsignados.length}
                    </p>

                    {adminDetalleAsignados.length ? (
                      <div className="mt-3 rounded-xl border border-black/10 p-3 sm:rounded-2xl sm:p-4">
                        <p className="mb-2 text-sm font-semibold sm:text-base">Estado por trabajador</p>

                        <div className="flex flex-col gap-2.5">
                          {adminDetalleAsignados.map((a) => (
                            <div
                              key={a.ID_Trabajador}
                              className="flex flex-col gap-2 rounded-xl bg-black/[0.02] p-2.5 sm:bg-transparent sm:p-0 lg:flex-row lg:items-center lg:justify-between lg:gap-3 text-sm"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-medium">
                                  {a.Nombre} {a.Apellido ?? ""}
                                </p>
                                <p className="text-black/50">
                                  Asignada: {fmtFechaHora(a.Asignada_At)}
                                </p>
                              </div>

                              <div className="lg:text-right">
                                <p
                                  className={`inline-flex rounded-full px-2 py-1 text-xs ${
                                    a.Estado === "FINALIZADA"
                                      ? "bg-green-600 text-white"
                                      : "bg-yellow-500 text-white"
                                  }`}
                                >
                                  {a.Estado}
                                </p>
                                {a.Finalizada_At ? (
                                  <p className="mt-1 text-black/50">
                                    Fin: {fmtFechaHora(a.Finalizada_At)}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <button
                      onClick={borrarTareaAdmin}
                      className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-white hover:opacity-90 disabled:opacity-60 sm:w-auto sm:rounded-2xl"
                      disabled={adminSaving || adminDeleting}
                    >
                      {adminDeleting ? "Borrando…" : "🗑️ Borrar"}
                    </button>

                    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                      <button
                        onClick={() => {
                          setModalDetalle(false);
                          setSelected(null);
                          setConfirmAccion(null);
                        }}
                        className="w-full rounded-xl bg-black/5 px-4 py-2.5 hover:bg-black/10 sm:w-auto sm:rounded-2xl"
                        disabled={adminSaving || adminDeleting}
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={guardarCambiosAdmin}
                        className="w-full rounded-xl bg-black px-4 py-2.5 text-white hover:opacity-90 disabled:opacity-60 sm:w-auto sm:rounded-2xl"
                        disabled={
                          adminSaving ||
                          adminDeleting ||
                          !adminEditTitulo.trim()
                        }
                      >
                        {adminSaving ? "Guardando…" : "Guardar cambios"}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!confirmAccion}
        onClose={() => {
          if (confirmando) return;
          setConfirmAccion(null);
        }}
        title="Borrar tarea"
      >
        <div className="text-sm text-black/80 sm:text-base">
          <p>
            ¿Seguro que quieres borrar la tarea{" "}
            <span className="font-semibold text-black">
              "{confirmAccion?.tarea?.Titulo ?? ""}"
            </span>
            ?
          </p>
          <p className="mt-2 text-sm text-black/60">
            Esto la elimina de la BD y desaparece para todos.
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            onClick={() => setConfirmAccion(null)}
            className="w-full rounded-xl bg-black/5 px-4 py-2.5 hover:bg-black/10 disabled:opacity-60 sm:w-auto sm:rounded-2xl"
            disabled={confirmando}
          >
            Cancelar
          </button>
          <button
            onClick={confirmarBorrarTareaAdmin}
            className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-white hover:opacity-90 disabled:opacity-60 sm:w-auto sm:rounded-2xl"
            disabled={confirmando}
          >
            {confirmando ? "Borrando…" : "Confirmar"}
          </button>
        </div>
      </Modal>
    </div>
  );
}