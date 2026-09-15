// src/shared/stores/useCorreoRecuperacionPendiente.ts
//
// LOGIN-08: el correo de recuperación que se eligió al activar y que falta confirmar con su código
// en la pantalla del PIN.
//
// Vive en memoria a propósito. Si la app se cierra antes de confirmarlo, se queda el correo de la
// compra, que es exactamente lo mismo que pulsar «Saltar»: no hay estado a medias que arrastrar.

import { create } from "zustand";

type Estado = {
    correo: string | null;
    fijar: (correo: string | null) => void;
};

export const useCorreoRecuperacionPendiente = create<Estado>((set) => ({
    correo: null,
    fijar: (correo) => set({ correo }),
}));
