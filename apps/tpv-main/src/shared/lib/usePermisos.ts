import { commands } from "@tpv/client";
// RI-70: el backend devuelve las concesiones efectivas; sin respuesta se deniega.
import { useQuery } from "@tanstack/react-query";

import type { AutorizacionUsuario } from "@tpv/contracts";
import { useAuth } from "../stores/useAuth";

/**
 * Los permisos de la sesión, para lo que la pantalla enseña o esconde. Quien decide es el backend,
 * en cada comando; esto sólo evita ofrecer lo que se va a denegar.
 *
 * PERM-CACHE: no se releen por reloj. Se releen cuando pueden haber cambiado: al llegar un cambio de
 * `usuarios`, `roles` o `roles_permisos` (`syncStatements.ts` invalida `["permisos"]`), al guardar
 * la pantalla de permisos, en una conexión nueva de la Handy (que lo invalida todo), al montar una
 * pantalla que los usa y al volver a la aplicación. En la Handy esa relectura no siempre es un viaje
 * a la nube: Rust guarda la autorización mientras su socket de avisos sigue abierto, y la tira antes
 * de avisar aquí del cambio (docs/arquitectura/permisos.md).
 */
export function usePermisos() {
    const usuario = useAuth((s) => s.idUsuario);
    const query = useQuery({
        queryKey: ["permisos", "sesion", usuario],
        queryFn: () => commands.permisosSesion(),
        enabled: !!usuario,
        staleTime: 0,
        refetchOnWindowFocus: true,
    });
    const actual = query.isError ? undefined : query.data;
    return {
        ...query,
        rol: actual?.rol ?? "",
        puede: (codigo: string) => actual?.permisos.includes(codigo) ?? false,
    };
}
