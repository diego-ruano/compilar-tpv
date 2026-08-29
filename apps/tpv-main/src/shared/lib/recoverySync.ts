import type { SyncHealth } from "@tpv/contracts";

export type RecoveryPhase = "downloading" | "uploading" | "verifying";

type RecoverySyncDeps = {
	catchUp: () => Promise<number>;
	drainOutbox: () => Promise<void>;
	health: () => Promise<SyncHealth>;
	complete: (cloudHighWater: number) => Promise<void>;
	wait: () => Promise<void>;
	onPhase?: (phase: RecoveryPhase) => void;
	maxVerificationRounds?: number;
};

/**
 * Orden mínimo que hace segura una restauración antigua:
 *
 * 1. nube → Main, para traer lo ocurrido después de la copia;
 * 2. Main → nube, para conservar el outbox que contenía esa copia;
 * 3. nube → Main otra vez, para confirmar el orden final y los ecos de esas operaciones.
 *
 * El bucle final cubre la cola durable del servidor: una operación puede estar aceptada pero aún
 * no aplicada. Nunca se desbloquea por tiempo; sólo por las dos invariantes observables.
 */
export async function reconcileRestoredDatabase(deps: RecoverySyncDeps): Promise<number> {
	deps.onPhase?.("downloading");
	await deps.catchUp();

	deps.onPhase?.("uploading");
	await deps.drainOutbox();

	const rounds = deps.maxVerificationRounds ?? 180;
	for (let round = 0; round < rounds; round++) {
		deps.onPhase?.("verifying");
		const highWater = await deps.catchUp();
		const health = await deps.health();

		if (
			health.outbox_pending === 0 &&
			health.last_seq >= highWater &&
			health.failing === 0 &&
			health.quarantined === 0
		) {
			await deps.complete(highWater);
			return highWater;
		}

		await deps.wait();
		deps.onPhase?.("uploading");
		await deps.drainOutbox();
	}

	throw new Error("La nube no confirmó la convergencia dentro del tiempo esperado");
}
