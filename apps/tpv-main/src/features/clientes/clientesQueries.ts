import { commands } from "@tpv/client";
// Hooks de TanStack Query para **clientes** (FEATURE DE REFERENCIA del patrón).
//
// Patrón a seguir en el resto de features:
//  - Lecturas  -> useQuery con queryKey con el nombre de la feature como prefijo.
//  - Escrituras -> useMutation que, en onSuccess, invalida la clave de la feature para
//    que las listas en caché se refresquen solas (Local-First: el dato sólo cambia aquí).
//  - El hook envuelve las funciones de `*Apis.ts` (commands) sin tocar su firma.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toAppError } from "@tpv/client";
import type { GuardarDatosFiscalesInput } from "@tpv/contracts";
import { useCallback } from "react";

import { useToast } from "../../shared/toast";
import {
  clientesGetClienteForm,
  clientesGetOverview,
  clientesRecalcularGasto,
  type FiltroRanking,
} from "./clientesApis";

/** Prefijo de claves de la feature; invalidar esto refresca todas sus listas. */
export const clientesKeys = {
  all: ["clientes"] as const,
  overview: (ranking: FiltroRanking) => ["clientes", "overview", ranking] as const,
  form: (idCliente: string) => ["clientes", "form", idCliente] as const,
  paraFactura: (idComanda: string | null) => ["clientes", "paraFactura", idComanda] as const,
};

/**
 * Lista/overview de clientes según el ranking seleccionado (cacheada por ranking). Al cambiar de
 * ranking se sigue enseñando la lista anterior hasta que llega la nueva, para que la pantalla no
 * parpadee.
 */
export function useClientesOverview(ranking: FiltroRanking) {
  return useQuery({
    queryKey: clientesKeys.overview(ranking),
    queryFn: () => clientesGetOverview({ ranking }),
    placeholderData: keepPreviousData,
  });
}

/**
 * La ficha de un cliente (lo que se edita, con sus datos fiscales). Sin datos previos: al pasar de un
 * cliente a otro no se enseña la ficha del anterior.
 */
export function useClienteForm(idCliente: string | null) {
  return useQuery({
    queryKey: clientesKeys.form(idCliente ?? ""),
    queryFn: () => clientesGetClienteForm(idCliente ?? ""),
    enabled: idCliente != null,
  });
}

/**
 * FISCAL-02 · Las fichas para el formulario de la factura completa, y la del cliente de la comanda
 * (`idComanda`) si se sabe. Sólo en la Main (`habilitada`): es la que cobra.
 */
export function useClientesParaFactura(idComanda: string | null, habilitada: boolean) {
  return useQuery({
    queryKey: clientesKeys.paraFactura(idComanda),
    queryFn: () => commands.clientesParaFactura({ id_comanda: idComanda }),
    enabled: habilitada,
    staleTime: 30_000,
  });
}

/**
 * FISCAL-02 · Guarda en la ficha los datos con los que se acaba de facturar. Devuelve una función
 * «dispara y olvida»: se llama DESPUÉS del cobro o de la emisión, y si falla sólo se avisa (con el
 * motivo); el cobro ya está hecho y no se deshace.
 *
 * No es una `useMutation`: el formulario que la llama se cierra en cuanto el cobro entra, y lo que
 * tiene que pasar después (refrescar los clientes, avisar del fallo) no puede depender de que siga
 * montado. El cliente de consultas y los avisos son de toda la aplicación.
 */
export function useGuardarDatosFiscales() {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    (plan: GuardarDatosFiscalesInput) => {
      commands
        .clientesGuardarDatosFiscales(plan)
        .then(() => qc.invalidateQueries({ queryKey: clientesKeys.all }))
        .catch((e: unknown) =>
          toast.error(
            "La factura está hecha, pero sus datos no se guardaron en la ficha del cliente",
            toAppError(e).message,
          ),
        );
    },
    [qc, toast],
  );
}

/** Alta de cliente; invalida la caché de clientes si el backend confirma el cambio. */
export function useCreateCliente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.clientesCreateCliente,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: clientesKeys.all });
    },
  });
}

/** Edición de cliente; invalida la caché de clientes si el backend confirma el cambio. */
export function useUpdateCliente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commands.clientesUpdateCliente,
    onSuccess: (ok) => {
      if (ok) void qc.invalidateQueries({ queryKey: clientesKeys.all });
    },
  });
}

/**
 * Rehace el gasto acumulado desde los pagos (DB-14). Invalida siempre: el valor mostrado cambia
 * aunque el recálculo confirme el que ya había.
 */
export function useRecalcularGasto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: clientesRecalcularGasto,
    onSuccess: () => qc.invalidateQueries({ queryKey: clientesKeys.all }),
  });
}
