import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  pedidosCambiarEstado,
  pedidosActualizar,
  pedidosCrear,
  pedidosGetAll,
  PedidoCrearInput,
  PedidoActualizarInput,
  PedidoCambiarEstadoInput,
} from "./pedidosApis";

const pedidosKeys = {
  all: ["pedidos_proveedor"] as const,
};

export function usePedidosAll() {
  return useQuery({
    queryKey: pedidosKeys.all,
    queryFn: pedidosGetAll,
    staleTime: 30_000,
  });
}

export function useCrearPedido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PedidoCrearInput) => pedidosCrear(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: pedidosKeys.all }),
  });
}

export function useActualizarPedido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PedidoActualizarInput) => pedidosActualizar(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: pedidosKeys.all }),
  });
}

export function useCancelarPedido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idPedido: string) =>
      pedidosCambiarEstado({ idPedido, estado: "cancelado" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: pedidosKeys.all }),
  });
}

export function useEnviarPedido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PedidoCambiarEstadoInput) => pedidosCambiarEstado(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: pedidosKeys.all }),
  });
}
