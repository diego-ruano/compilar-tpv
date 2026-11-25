import { commands } from "@tpv/client";
//shared/stores/useAuth.ts
//
// La sesión del frontend. SEC-01: **ya no es la única que existe**. El backend guarda la suya
// (`AppState::sesion`, puesta por `login_user`), que es la que comprueban los comandos gateados.
// Ésta sigue mandando en lo que la UI ENSEÑA; aquélla, en lo que la UI puede HACER.
//
// De ahí que `logout` avise a las dos: si sólo se limpiara ésta, la pantalla volvería al login
// con una sesión de administrador viva detrás.

import { create } from "zustand";
import { queryClient } from "../lib/queryClient";


export type AuthState = {
    // Estado de sesión
    role: string; // "" = no logueado
    idUsuario: string | null;
    nombre: string | null;
    idTrabajador: string | null;
    requiresSetup: boolean;
    email: string | null;
    /**
     * Por qué se cerró la sesión sin que nadie lo pidiera, para que el login lo diga (p. ej. el
     * usuario ya no está activo). `null` si no hay nada que decir. Lo borra el siguiente login.
     */
    motivoCierre: string | null;

    // Acciones
    setSession: (data: {
        role: string;
        idUsuario: string;
        nombre: string;
        idTrabajador: string | null;
        requiresSetup: boolean;
        email: string | null;
    }) => void;

    /** `motivo`: lo que el login tiene que decir al volver (ver `motivoCierre`). */
    logout: (motivo?: string) => void;
};

export const useAuth = create<AuthState>((set) => ({
    role: "",
    idUsuario: null,
    nombre: null,
    idTrabajador: null,
    requiresSetup: false,
    email: null,
    motivoCierre: null,

    setSession: ({
        role,
        idUsuario,
        nombre,
        idTrabajador,
        requiresSetup,
        email,
    }) =>
        set({
            role,
            idUsuario,
            nombre,
            idTrabajador,
            requiresSetup,
            email,
            motivoCierre: null,
        }),

    logout: (motivo) => {
        limpiarSesionLocal();
        useAuth.setState({ motivoCierre: motivo ?? null });

        // El store se limpia SIEMPRE y primero: es lo que devuelve la UI al login, y no puede
        // quedar colgado esperando al IPC. El aviso al backend va detrás y sin `await` —quien
        // llama a `logout()` (incluido el cierre por inactividad) no tiene nada que hacer con
        // el resultado— pero su fallo no se traga en silencio: una sesión que no se cierra en
        // el backend es exactamente lo que este comando existe para evitar. Lo registra `invocar`.
        void commands.logout().catch(() => {});
    },
}));

/** El cambio de vínculo ya cerró la sesión en Rust. Retira su presentación sin enviar otro logout. */
export function limpiarSesionLocal(): void {
    queryClient.clear();
    useAuth.setState({ role: "", idUsuario: null, nombre: null, idTrabajador: null, requiresSetup: false, email: null });
}
