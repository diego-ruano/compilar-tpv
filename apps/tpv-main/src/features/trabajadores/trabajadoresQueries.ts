// Hooks de TanStack Query para **trabajadores / horarios**.
//
// Sigue el patrón de la feature de referencia `clientes`:
//  - Lecturas  -> useQuery con queryKey prefijada por la feature.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché (trabajadores, turnos, asignaciones de la semana) se
//    refresquen solas (Local-First: el dato sólo cambia aquí).
//  - El hook envuelve las funciones de `trabajadoresApis.ts` (invokeClient) sin tocar su firma.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
} from "./trabajadoresApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const trabajadoresKeys = {
  all: ["trabajadores"] as const,
  lista: () => ["trabajadores", "lista"] as const,
  turnos: () => ["trabajadores", "turnos"] as const,
  trabajadorIdByUsuario: (idUsuario: string | null | undefined) =>
    ["trabajadores", "trabajadorIdByUsuario", idUsuario] as const,
  asignacionesSemana: (fechaLunes: string) =>
    ["trabajadores", "asignacionesSemana", fechaLunes] as const,
};

/* =========================================================
   Reads (queries)
========================================================= */

/** Lista de todos los trabajadores (cacheada). */
export function useTrabajadores() {
  return useQuery({
    queryKey: trabajadoresKeys.lista(),
    queryFn: () => trabajadoresGetAll(),
  });
}

/** Catálogo de turnos disponibles (cacheado). */
export function useTurnos() {
  return useQuery({
    queryKey: trabajadoresKeys.turnos(),
    queryFn: () => turnosGetAll(),
  });
}

/**
 * ID de trabajador asociado al usuario logueado (sólo se necesita para no-admins).
 * Se habilita únicamente cuando `enabled` es true y hay un idUsuario válido.
 */
export function useTrabajadorIdByUsuario(
  idUsuario: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: trabajadoresKeys.trabajadorIdByUsuario(idUsuario),
    queryFn: () => trabajadoresGetTrabajadorIdByUsuario(String(idUsuario ?? "")),
    enabled: enabled && idUsuario != null,
  });
}

/** Asignaciones de horario de la semana cuyo lunes es `fechaLunes` (cacheadas por semana). */
export function useAsignacionesSemana(fechaLunes: string) {
  return useQuery({
    queryKey: trabajadoresKeys.asignacionesSemana(fechaLunes),
    queryFn: () => horariosGetAsignacionesSemana(fechaLunes),
  });
}

/* =========================================================
   Writes (mutations)
========================================================= */

/** Crea una asignación de horario; invalida la feature si el backend confirma. */
export function useCreateAsignacion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: horariosCreateAsignacion,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/** Edita una asignación de horario; invalida la feature si el backend confirma. */
export function useUpdateAsignacion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: horariosUpdateAsignacion,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/** Borra una asignación de horario; invalida la feature si el backend confirma. */
export function useDeleteAsignacion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: horariosDeleteAsignacion,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/** Copia las asignaciones de una semana a otra; invalida la feature si el backend confirma. */
export function useCopySemanaAsignaciones() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: horariosCopySemanaAsignaciones,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/** Guarda la semana visible como horario predeterminado; invalida la feature si confirma. */
export function useSetPredeterminadoDesdeSemana() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: horariosSetPredeterminadoDesdeSemana,
    onSuccess: (ok) => {
      if (ok) qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}
