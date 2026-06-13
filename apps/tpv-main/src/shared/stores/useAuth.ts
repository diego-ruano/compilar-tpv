//shared/stores/useAuth.ts

import { create } from "zustand";

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

    logout: () =>
        set({
            role: "",
            idUsuario: null,
            nombre: null,
            idTrabajador: null,
            requiresSetup: false,
            email: null,
        }),
}));
