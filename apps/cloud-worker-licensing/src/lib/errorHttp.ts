// src/lib/errorHttp.ts
//
// Error tipado que cruza las capas internas hasta la frontera HTTP (ARQ-07). Aunque conserva el
// nombre histórico `HubError`, también lo usan ahora los fallos propios de infraestructura: lo
// importante es que `code`, `status` y `details` viajen estructurados, no enterrados en `message`.

function mensajeDiagnostico(code: string, details: unknown): string {
	if (details && typeof details === "object") {
		const message = (details as any).message;
		if (typeof message === "string" && message) return message;
	}
	return code;
}

export class HubError extends Error {
	constructor(
		public code: string,
		public status: number,
		public details?: unknown,
	) {
		super(mensajeDiagnostico(code, details));
		this.name = "HubError";
	}
}

/** El sobre común para cualquier error que ya trae un status HTTP decidido. */
export function cuerpoDeErrorConStatus(err: any): Record<string, unknown> {
	const error = err?.code || err?.message || "error";
	return {
		ok: false,
		error,
		...(err?.details === undefined ? {} : { details: err.details }),
	};
}
