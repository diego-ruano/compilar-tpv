import { describe, expect, it, vi } from "vitest";

import { reconcileRestoredDatabase } from "../src/shared/lib/recoverySync";

const healthy = (overrides: Record<string, number> = {}) => ({
	outbox_pending: 0,
	last_seq: 42,
	quarantined: 0,
	failing: 0,
	...overrides,
});

describe("reconcileRestoredDatabase", () => {
	it("ejecuta catch-up → outbox → catch-up y sólo entonces desbloquea", async () => {
		const order: string[] = [];
		const result = await reconcileRestoredDatabase({
			catchUp: vi.fn(async () => {
				order.push("catch-up");
				return 42;
			}),
			drainOutbox: vi.fn(async () => {
				order.push("outbox");
			}),
			health: vi.fn(async () => {
				order.push("health");
				return healthy();
			}),
			complete: vi.fn(async () => {
				order.push("complete");
			}),
			wait: vi.fn(async () => {}),
		});

		expect(result).toBe(42);
		expect(order).toEqual(["catch-up", "outbox", "catch-up", "health", "complete"]);
	});

	it("espera una operación aceptada por la cola hasta verla aplicada", async () => {
		let checks = 0;
		const drain = vi.fn(async () => {});
		const wait = vi.fn(async () => {});

		await reconcileRestoredDatabase({
			catchUp: async () => 50,
			drainOutbox: drain,
			health: async () => {
				checks++;
				return checks === 1
					? healthy({ outbox_pending: 1, last_seq: 49 })
					: healthy({ last_seq: 50 });
			},
			complete: async () => {},
			wait,
		});

		expect(wait).toHaveBeenCalledOnce();
		expect(drain).toHaveBeenCalledTimes(2);
	});

	it("no desbloquea si hay una operación en cuarentena", async () => {
		const complete = vi.fn(async () => {});

		await expect(
			reconcileRestoredDatabase({
				catchUp: async () => 10,
				drainOutbox: async () => {},
				health: async () => healthy({ last_seq: 10, quarantined: 1 }),
				complete,
				wait: async () => {},
				maxVerificationRounds: 2,
			}),
		).rejects.toThrow("no confirmó la convergencia");
		expect(complete).not.toHaveBeenCalled();
	});

	it("propaga un fallo de red sin marcar la recuperación como completa", async () => {
		const complete = vi.fn(async () => {});
		await expect(
			reconcileRestoredDatabase({
				catchUp: async () => {
					throw new Error("offline");
				},
				drainOutbox: async () => {},
				health: async () => healthy(),
				complete,
				wait: async () => {},
			}),
		).rejects.toThrow("offline");
		expect(complete).not.toHaveBeenCalled();
	});
});
