// src/net/healthCheck.ts
import { useNet } from "../zustand/useNet";

const HEALTH_URL = "https://tpv-server.altarialights.workers.dev/health";
const TIMEOUT_MS = 2_500;

const ONLINE_EVERY_MS = 15_000;
const OFFLINE_EVERY_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);

		p.then((v) => {
			clearTimeout(t);
			resolve(v);
		}).catch((e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

export function startHealthcheck(): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function setOffline() {
		const netState = useNet.getState() as any;

		if (typeof netState.forceOffline === "function") {
			netState.forceOffline();
			return;
		}

		if (typeof netState.setOffline === "function") {
			netState.setOffline();
		}
	}

	async function tick() {
		if (stopped) return;

		try {
			const res = await withTimeout(
				fetch(HEALTH_URL, { cache: "no-store" }),
				TIMEOUT_MS,
			);

			if (!res.ok) {
				throw new Error(`health ${res.status}`);
			}

			useNet.getState().setOnline();
		} catch {
			setOffline();
		}

		if (stopped) return;

		const isOnline = useNet.getState().status === "online";
		const nextDelay = isOnline ? ONLINE_EVERY_MS : OFFLINE_EVERY_MS;

		timer = setTimeout(tick, nextDelay);
	}

	void tick();

	return () => {
		stopped = true;
		clearTimer();
	};
}