// src/shared/stores/useMode.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DeviceMode = "tpv" | "handy";
export type ModeStateValue = DeviceMode | null | "loading";

type ModeStore = {
    mode: ModeStateValue;
    setMode: (mode: ModeStateValue) => void;
    clearMode: () => void;
};

export const useMode = create<ModeStore>()(
    persist(
        (set) => ({
            mode: "loading",
            setMode: (mode) => set({ mode }),
            clearMode: () => set({ mode: null }),
        }),
        {
            name: "device-mode", // key de localStorage
            // opcional: no persistimos "loading"
            partialize: (state) => ({
                mode: state.mode === "loading" ? null : state.mode,
            }),
        },
    ),
);
