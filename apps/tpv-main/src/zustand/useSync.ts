import { create } from "zustand";

export type SyncStatus = "idle" | "resyncing";

type SyncState = {
	status: SyncStatus;
	pendingCount: number;
	lastSyncAt: number | null;
	lastSyncError: string | null;
	uiLocked: boolean;
	startResync: () => void;
	finishResync: () => void;
	failResync: (error: string) => void;
	setPendingCount: (count: number) => void;
	clearSyncError: () => void;
	resetSync: () => void;
};

export const useSync = create<SyncState>((set) => ({
	status: "idle",
	pendingCount: 0,
	lastSyncAt: null,
	lastSyncError: null,
	uiLocked: false,

	startResync: () =>
		set((state) => ({
			...state,
			status: "resyncing",
			uiLocked: true,
			lastSyncError: null,
		})),

	finishResync: () =>
		set((state) => ({
			...state,
			status: "idle",
			uiLocked: false,
			lastSyncAt: Date.now(),
			lastSyncError: null,
			pendingCount: 0,
		})),

	failResync: (error: string) =>
		set((state) => ({
			...state,
			status: "idle",
			uiLocked: false,
			lastSyncError: String(error || "sync_failed"),
		})),

	setPendingCount: (count: number) =>
		set((state) => ({
			...state,
			pendingCount: Math.max(0, Math.trunc(Number(count) || 0)),
		})),

	clearSyncError: () =>
		set((state) => ({
			...state,
			lastSyncError: null,
		})),

	resetSync: () =>
		set({
			status: "idle",
			pendingCount: 0,
			lastSyncAt: null,
			lastSyncError: null,
			uiLocked: false,
		}),
}));