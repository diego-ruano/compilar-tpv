// Cliente único de TanStack Query (caché de lecturas del frontend).
//
// El TPV es **Local-First de un solo dispositivo**: los datos sólo cambian por mutaciones
// de esta misma app, que invalidan las queries afectadas. Por eso:
//  - `refetchOnWindowFocus: false` (la BD local no cambia "por detrás").
//  - `staleTime` amplio: al navegar entre vistas la caché sirve los datos al instante y
//    sólo se vuelve a consultar SQLite cuando una mutación invalida la clave.
//  - `retry` bajo: un fallo contra el SQLite local es un error real, no un problema de red.
//
// Convención de claves: cada feature usa un array con su nombre como prefijo, p. ej.
// `["proveedores"]`, `["proveedores", "productos", idProveedor]`. Así se puede invalidar
// toda una feature con `queryClient.invalidateQueries({ queryKey: ["proveedores"] })`.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
