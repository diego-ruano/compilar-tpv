import { commands } from "@tpv/client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toAppError } from "@tpv/client";
import type { ConfiguracionPermisos, GuardarPermisosInput } from "@tpv/contracts";
import { queryClient } from "../../../shared/lib/queryClient";
import { conAviso } from "../../../shared/lib/conAviso";

type Borrador = {
    idRol: string;
    permisos: string[];
    vistos: string[];
};

export function Permisos() {
    const query = useQuery({
        queryKey: ["permisos", "configuracion"],
        queryFn: () => commands.permisosConfiguracion(),
    });
    const [seleccion, setSeleccion] = useState("");
    const [borrador, setBorrador] = useState<Borrador | null>(null);
    const guardar = useMutation({
        mutationFn: (args: GuardarPermisosInput) => commands.permisosGuardar(args),
        onSuccess: async () => {
            setBorrador(null);
            await queryClient.invalidateQueries({ queryKey: ["permisos"] });
        },
    });
    const roles = query.data?.roles.filter((r) => r.nombre !== "Administrador") ?? [];
    const idSeleccionado = borrador?.idRol ?? seleccion;
    const rol = idSeleccionado ? roles.find((r) => r.id_rol === idSeleccionado) : roles[0];
    const concedidos = borrador?.permisos ?? rol?.permisos ?? [];

    function cambiarPermiso(codigo: string, conceder: boolean) {
        if (!rol) return;
        guardar.reset();
        setBorrador({
            idRol: rol.id_rol,
            permisos: conceder ? [...concedidos, codigo] : concedidos.filter((c) => c !== codigo),
            // Un refresco no cambia la base con la que empezó esta edición.
            vistos: borrador?.vistos ?? rol.permisos,
        });
    }

    // Sin texto de espera: la matriz llega enseguida y el aviso sólo parpadeaba.
    if (query.isPending) return null;
    if (query.isError) {
        return <div>
            <p>{toAppError(query.error).message}</p>
            <button type="button" onClick={() => void query.refetch()}>Reintentar</button>
        </div>;
    }
    const grupos = Array.from(new Set(query.data.catalogo.map((p) => p.grupo)));

    return <section className="space-y-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold">Permisos por rol</h2>
        <p className="text-sm text-fg-muted">
            Configura las acciones de cada rol. Los administradores conservan acceso completo;
            la gestión de permisos, personal, licencia, dispositivos y configuración fiscal les corresponde siempre.
        </p>
        <label className="block">Rol
            <select
                className="ml-3 rounded border border-border bg-surface p-2"
                value={rol?.id_rol ?? ""}
                disabled={guardar.isPending}
                onChange={(e) => { setSeleccion(e.target.value); setBorrador(null); guardar.reset(); }}
            >
                {roles.map((r) => <option key={r.id_rol} value={r.id_rol}>{r.nombre}</option>)}
            </select>
        </label>
        {grupos.map((grupo) => <fieldset key={grupo} className="rounded border border-border p-3">
            <legend className="px-2 font-semibold">{grupo}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
                {query.data.catalogo.filter((p) => p.grupo === grupo).map((p) => <label key={p.codigo} className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={concedidos.includes(p.codigo)}
                        disabled={!rol || guardar.isPending}
                        onChange={(e) => cambiarPermiso(p.codigo, e.target.checked)}
                    />
                    {p.nombre}
                </label>)}
            </div>
        </fieldset>)}
        {guardar.isError && <p role="alert" className="text-danger">
            {toAppError(guardar.error).message} Recarga si otra persona ha cambiado los permisos.
        </p>}
        <div className="flex gap-3">
            <button
                type="button"
                className="rounded bg-accent px-4 py-2 text-accent-fg disabled:opacity-50"
                disabled={!rol || !borrador || guardar.isPending}
                onClick={conAviso(async () => {
                    if (rol && borrador) {
                        await guardar.mutateAsync({ id_rol: borrador.idRol, permisos_vistos: borrador.vistos, permisos: borrador.permisos });
                    }
                })}
            >
                {guardar.isPending ? "Guardando…" : "Guardar permisos"}
            </button>
            <button type="button" disabled={guardar.isPending} onClick={() => { setBorrador(null); guardar.reset(); void query.refetch(); }}>
                Recargar
            </button>
        </div>
        {guardar.isSuccess && <p role="status">Permisos guardados.</p>}
    </section>;
}
