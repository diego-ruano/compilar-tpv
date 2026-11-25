import { commands } from "@tpv/client";
// RI-70: el backend devuelve las concesiones efectivas; sin ninguna respuesta se deniega.
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../stores/useAuth";

/** Cada cuánto se reintenta leer los permisos mientras la lectura falla. */
const REINTENTO_MS = 15_000;

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
        // Si la relectura falla (sin red, la Handy recuperándola), se vuelve a intentar sola hasta
        // que conteste. Mientras contesta bien no hay reloj: se relee por lo de arriba.
        refetchInterval: (q) => (q.state.status === "error" ? REINTENTO_MS : false),
    });
    // Una relectura que falla no borra lo que ya se sabía: se sigue pintando con los últimos
    // permisos leídos, que es para lo único que valen aquí (quien decide es el backend, en cada
    // comando). Antes se tomaban por ninguno y la aplicación se desmontaba entera.
    const actual = query.data;
    return {
        ...query,
        rol: actual?.rol ?? "",
        puede: (codigo: string) => actual?.permisos.includes(codigo) ?? false,
    };
}
