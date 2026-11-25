// Hooks de TanStack Query para **trabajadores / horarios**.
//
// Sigue el patrón de la feature de referencia `clientes`:
//  - Lecturas  -> useQuery con queryKey prefijada por la feature.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché (trabajadores, turnos, asignaciones de la semana) se
//    refresquen solas (Local-First: el dato sólo cambia aquí).
//  - Las firmas del transporte se generan desde los comandos Rust.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands } from "@tpv/client";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
const trabajadoresKeys = {
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
    queryFn: () => commands.trabajadoresGetAll(),
  });
}

/** Catálogo de turnos disponibles (cacheado). */
export function useTurnos() {
  return useQuery({
    queryKey: trabajadoresKeys.turnos(),
    queryFn: () => commands.turnosGetAll(),
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
    queryFn: () => commands.trabajadoresGetTrabajadorIdByUsuario({ id_usuario: String(idUsuario ?? "") }),
    enabled: enabled && idUsuario != null,
  });
}

/** Asignaciones de horario de la semana cuyo lunes es `fechaLunes` (cacheadas por semana). */
export function useAsignacionesSemana(fechaLunes: string) {
  return useQuery({
    queryKey: trabajadoresKeys.asignacionesSemana(fechaLunes),
    queryFn: () => commands.horariosGetAsignacionesSemana({ fecha_lunes: fechaLunes }),
  });
}

/* =========================================================
   Writes (mutations)
========================================================= */

/** RI-85: crea o sustituye el conjunto completo en una transacción. */
export function useGuardarAsignacion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.horariosGuardarAsignacion,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: trabajadoresKeys.all }); },
  });
}

/** Borra una asignación de horario; invalida la feature si el backend confirma. */
export function useDeleteAsignacion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id_asignacion: string) => commands.horariosDeleteAsignacion({ id_asignacion }),
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/** Copia las asignaciones de una semana a otra; invalida la feature si el backend confirma. */
export function useCopySemanaAsignaciones() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.horariosCopySemanaAsignaciones,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/**
 * Marca libre el día de un trabajador: tapa su horario predeterminado. Se quita con
 * `useDeleteAsignacion`, y el día vuelve a la plantilla.
 */
export function useMarcarLibre() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.horariosMarcarLibre,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: trabajadoresKeys.all }); },
  });
}

/** Guarda la semana visible como horario predeterminado; invalida la feature si confirma. */
export function useSetPredeterminadoDesdeSemana() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fecha_lunes: string) => commands.horariosSetPredeterminadoDesdeSemana({ fecha_lunes }),
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}

/**
 * Elimina a un trabajador: el backend lo borra si no tiene historia y lo retira si la tiene
 * (`retirado`). Invalida la feature: sale de la lista y de los horarios.
 */
export function useEliminarTrabajador() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id_trabajador: string) => commands.trabajadoresEliminar({ id_trabajador }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trabajadoresKeys.all });
    },
  });
}
