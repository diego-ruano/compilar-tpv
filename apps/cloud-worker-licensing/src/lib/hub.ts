// src/lib/hub.ts
//
// Puente con el Durable Object TenantHub para las ESCRITURAS de la API.
//
// Toda escritura va al MISMO motor del DO (`/internal/apply`): aplica en Turso
// dentro de una transacción, registra idempotencia por `Op_Id` y, tras confirmar,
// hace broadcast del cambio por WebSocket al resto de dispositivos. El DO también
// rechaza la escritura con `main_offline` si no hay una Main conectada.

import type { Env } from "../env";

export type ApplyCommand = {
	type: "tenantDb.exec" | "tenantDb.transaction";
	payload: any;
};

export type ApplyParams = {
	tenantId: string;
	deviceId: string;
	opId: string;
	commandName: string;
	command: ApplyCommand;
	cloudPayload?: any;
};

/** Error con código y status HTTP, para que el router lo traduzca a JSON. */
export class HubError extends Error {
	constructor(public code: string, public status: number) {
		super(code);
	}
}

export async function applyViaHub(env: Env, params: ApplyParams): Promise<any> {
	const { tenantId, deviceId, opId, commandName, command, cloudPayload } = params;

	const id = env.TenantHub.idFromName(tenantId);
	const stub = env.TenantHub.get(id);

	const res = await stub.fetch("https://do/internal/apply", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-tenant-id": tenantId,
			"x-device-id": deviceId,
		},
		body: JSON.stringify({
			type: command.type,
			payload: command.payload,
			opId,
			commandName,
			deviceId,
			cloud_payload: cloudPayload ?? null,
		}),
	});

	const json: any = await res.json().catch(() => ({}));

	if (!res.ok || !json?.ok) {
		const code = String(json?.error || "apply_failed");
		throw new HubError(code, res.status || 500);
	}

	return json.data;
}
