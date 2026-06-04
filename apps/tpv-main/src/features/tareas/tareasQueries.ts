// Hooks de TanStack Query para **tareas** (sigue el patrón de la feature de referencia `clientes`).
//
// Patrón:
//  - Lecturas que alimentan listas -> useQuery con queryKey prefijado por "tareas".
//  - Escrituras (CRUD + completar) -> useMutation que, en onSuccess, invalida la clave de la
//    feature para que las listas en caché se refresquen solas (Local-First).
//  - Los hooks envuelven los métodos de `tareasApi` (invokeClient) sin tocar sus firmas.
//
// NOTA: `getTareaById` y `getTareaAsignados` se usan on-demand al abrir el detalle (dentro de
// un Promise.all que rellena estado local del formulario). No aportan caché y se dejan como
// llamada directa a `tareasApi` en el consumidor (regla 7).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { tareasApi } from "./tareasApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const tareasKeys = {
  all: ["tareas"] as const,
  trabajadores: () => ["tareas", "trabajadores"] as const,
  admin: () => ["tareas", "admin"] as const,
  mias: (idTrabajador: number | null | undefined) =>
    ["tareas", "mias", idTrabajador ?? null] as const,
};

/** Lista de trabajadores (para asignación de tareas). */
export function useTrabajadores(enabled = true) {
  return useQuery({
    queryKey: tareasKeys.trabajadores(),
    queryFn: () => tareasApi.getTrabajadores(),
    enabled,
  });
}

/** Lista de tareas en vista administrador (con totales de asignación/finalización). */
export function useTareasAdmin(enabled = true) {
  return useQuery({
    queryKey: tareasKeys.admin(),
    queryFn: () => tareasApi.getTareasAdmin(),
    enabled,
  });
}

/** Tareas asignadas al trabajador autenticado (vista no-admin). */
export function useMisTareas(idTrabajador: number | null | undefined, enabled = true) {
  return useQuery({
    queryKey: tareasKeys.mias(idTrabajador),
    queryFn: () => tareasApi.getMisTareas(Number(idTrabajador)),
    enabled: enabled && !!idTrabajador,
  });
}

/** Crea una tarea; invalida la caché de tareas si el backend confirma. */
export function useCreateTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tareasApi.createTarea,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Edita los datos de una tarea; invalida la caché de tareas si el backend confirma. */
export function useUpdateTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tareasApi.updateTarea,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Actualiza las asignaciones de una tarea; invalida la caché de tareas si el backend confirma. */
export function useSetAsignacionesTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tareasApi.setAsignacionesTarea,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Elimina una tarea; invalida la caché de tareas si el backend confirma. */
export function useDeleteTarea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tareasApi.deleteTarea,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}

/** Marca una tarea como finalizada para un trabajador; invalida la caché si el backend confirma. */
export function useMarcarTareaFinalizada() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tareasApi.marcarTareaFinalizada,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: tareasKeys.all });
    },
  });
}
