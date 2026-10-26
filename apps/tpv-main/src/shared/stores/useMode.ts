// src/shared/stores/useMode.ts
//
// El modo lo dice el backend (`getDeviceMode`, en `useModoDispositivo`) en cada arranque. No se guarda
// en localStorage: un modo recordado de otra instalación hacía arrancar la Main antes de que el
// backend tuviera modo, y todo lo que se carga al entrar fallaba con «Modo de dispositivo no
// seleccionado».
import { create } from "zustand";

export type DeviceMode = "tpv" | "handy";
export type ModeStateValue = DeviceMode | null | "loading";

type ModeStore = {
    mode: ModeStateValue;
    setMode: (mode: ModeStateValue) => void;
};

export const useMode = create<ModeStore>()((set) => ({
    mode: "loading",
    setMode: (mode) => set({ mode }),
}));
