//shared/stores/useAuth.ts
//
// La sesión del frontend. SEC-01: **ya no es la única que existe**. El backend guarda la suya
// (`AppState::sesion`, puesta por `login_user`), que es la que comprueban los comandos gateados.
// Ésta sigue mandando en lo que la UI ENSEÑA; aquélla, en lo que la UI puede HACER.
//
// De ahí que `logout` avise a las dos: si sólo se limpiara ésta, la pantalla volvería al login
// con una sesión de administrador viva detrás.

import { create } from "zustand";
import { invokeClient } from "@tpv/client";

export type AuthState = {
    // Estado de sesión
    role: string; // "" = no logueado
    idUsuario: string | null;
    nombre: string | null;
    idTrabajador: string | null;
    requiresSetup: boolean;
    email: string | null;

    // Acciones
    setSession: (data: {
        role: string;
        idUsuario: string;
        nombre: string;
        idTrabajador: string | null;
        requiresSetup: boolean;
        email: string | null;
    }) => void;

    logout: () => void;
};

export const useAuth = create<AuthState>((set) => ({
    role: "",
    idUsuario: null,
    nombre: null,
    idTrabajador: null,
    requiresSetup: false,
    email: null,

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
        }),

    logout: () => {
        set({
            role: "",
            idUsuario: null,
            nombre: null,
            idTrabajador: null,
            requiresSetup: false,
            email: null,
        });

        // El store se limpia SIEMPRE y primero: es lo que devuelve la UI al login, y no puede
        // quedar colgado esperando al IPC. El aviso al backend va detrás y sin `await` —quien
        // llama a `logout()` (incluido el cierre por inactividad) no tiene nada que hacer con
        // el resultado— pero su fallo no se traga en silencio: una sesión que no se cierra en
        // el backend es exactamente lo que este comando existe para evitar.
        void invokeClient("logout").catch((e: unknown) => {
            console.error("[useAuth] no se pudo cerrar la sesión del backend:", e);
        });
    },
}));
