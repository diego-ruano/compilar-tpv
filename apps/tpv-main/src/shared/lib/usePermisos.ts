// RI-70: el backend devuelve las concesiones efectivas; sin respuesta se deniega.
import { useQuery } from "@tanstack/react-query";
import { invokeClient } from "@tpv/client";
import type { AutorizacionUsuario } from "@tpv/contracts";
import { useAuth } from "../stores/useAuth";

export function usePermisos() {
    const usuario = useAuth((s) => s.idUsuario);
    const query = useQuery({
        queryKey: ["permisos", "sesion", usuario],
        queryFn: () => invokeClient<AutorizacionUsuario>("permisos_sesion"),
        enabled: !!usuario,
        staleTime: 0,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
    });
    const actual = query.isError ? undefined : query.data;
    return {
        ...query,
        rol: actual?.rol ?? "",
        puede: (codigo: string) => actual?.permisos.includes(codigo) ?? false,
    };
}
