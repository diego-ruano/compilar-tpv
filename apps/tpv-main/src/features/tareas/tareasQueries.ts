// Hooks de TanStack Query para **tareas** (sigue el patrón de la feature de referencia `clientes`).
//
// Patrón:
//  - Lecturas que alimentan listas -> useQuery con queryKey prefijado por "tareas".
//  - Escrituras (CRUD + completar) -> useMutation que, en onSuccess, invalida la clave de la
//    feature para que las listas en caché se refresquen solas (Local-First).
//  - Los hooks envuelven los métodos de `commands` (commands) sin tocar sus firmas.
//
// NOTA: `getTareaById` y `getTareaAsignados` se usan on-demand al abrir el detalle (dentro de
// un Promise.all que rellena estado local del formulario). No aportan caché y se dejan como
// llamada directa a `commands` en el consumidor (regla 7).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands } from "@tpv/client";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
const tareasKeys = {
  all: ["tareas"] as const,
  trabajadores: () => ["tareas", "trabajadores"] as const,
  admin: () => ["tareas", "admin"] as const,
  mias: (id_trabajador: string | null | undefined) =>
    ["tareas", "mias", id_trabajador ?? null] as const,
  papelera: () => ["tareas", "papelera"] as const,
};

/** Lista de trabajadores (para asignación de tareas). */
export function useTrabajadores(enabled = true) {
  return useQuery({
    queryKey: tareasKeys.trabajadores(),
    queryFn: () => commands.tareasGetTrabajadores(),
    enabled,
  });
}

/** Lista de tareas en vista administrador (con totales de asignación/finalización). */
export function useTareasAdmin(enabled = true) {
  return useQuery({
    queryKey: tareasKeys.admin(),
    queryFn: () => commands.tareasGetTareasAdmin(),
    enabled,
  });
}

/** Tareas asignadas al trabajador autenticado (vista no-admin). */
export function useMisTareas(id_trabajador: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: tareasKeys.mias(id_trabajador),
    queryFn: () => commands.tareasGetMisTareas({ id_trabajador: String(id_trabajador ?? "") }),
    enabled: enabled && !!id_trabajador,
  });
}

/** Crea una tarea; invalida la caché de tareas si el backend confirma. */
export function useCreateTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.tareasCreateTarea,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Edita los datos de una tarea; invalida la caché de tareas si el backend confirma. */
export function useUpdateTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.tareasUpdateTarea,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Actualiza las asignaciones de una tarea; invalida la caché de tareas si el backend confirma. */
export function useSetAsignacionesTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.tareasSetAsignacionesTarea,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Elimina una tarea; invalida la caché de tareas si el backend confirma. */
export function useDeleteTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id_tarea: string) => commands.tareasDeleteTarea({ id_tarea }),
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Tareas en la papelera (TAR-05). Se habilita al abrir la modal, no en cada carga de la página. */
export function usePapelera(enabled = true) {
  return useQuery({
    queryKey: tareasKeys.papelera(),
    queryFn: () => commands.tareasGetPapelera(),
    enabled,
  });
}

/** Saca una tarea de la papelera; invalida toda la feature (vuelve a la lista y sale de la papelera). */
export function useRestaurarTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id_tarea: string) => commands.tareasRestaurarTarea({ id_tarea }),
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Vacía la papelera (borrado definitivo); invalida la feature. */
export function useVaciarPapelera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.tareasVaciarPapelera,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Marca una tarea como finalizada para un trabajador; invalida la caché si el backend confirma. */
export function useMarcarTareaFinalizada() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.tareasMarcarTareaFinalizada,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}
