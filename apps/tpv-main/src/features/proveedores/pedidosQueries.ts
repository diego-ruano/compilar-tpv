import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  pedidosCambiarEstado,
  pedidosActualizar,
  pedidosCrear,
  pedidosGetPage,
  PedidoCrearInput,
  PedidoActualizarInput,
  PedidoCambiarEstadoInput,
} from "./pedidosApis";

const PAGE_SIZE = 50;

const pedidosKeys = {
  // Prefijo común: las mutaciones invalidan por él, refrescando cualquier búsqueda cargada.
  all: ["pedidos_proveedor"] as const,
  list: (search: string) => ["pedidos_proveedor", "list", search] as const,
};

// PROV-03: listado paginado (infinite scroll) con búsqueda server-side. `search` forma parte
// de la clave: cambiarla arranca una consulta nueva desde el offset 0.
export function usePedidosPage(search: string) {
  return useInfiniteQuery({
    queryKey: pedidosKeys.list(search),
    queryFn: ({ pageParam }) =>
      pedidosGetPage({ limit: PAGE_SIZE, offset: pageParam, search }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const cargados = allPages.reduce((n, p) => n + p.pedidos.length, 0);
      return cargados < lastPage.total ? cargados : undefined;
    },
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
