// src/lib/hub.ts
//
// Puente con el Durable Object TenantHub para las ESCRITURAS de la API.
//
// Toda escritura va al MISMO motor del DO (`/internal/apply`): aplica en Turso
// dentro de una transacción, registra idempotencia por `Op_Id` y, tras confirmar,
// hace broadcast del cambio por WebSocket al resto de dispositivos. El DO también
// rechaza la escritura con `main_offline` si no hay una Main conectada.

import type { Env } from "../env";
import { signInternalWorkerRequest } from "./internalAuth";

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
	/** Hora local del dispositivo emisor (`YYYY-MM-DD HH:MM:SS`) para resolver `datetime('now')`. */
	clientNow?: string;
};

/** Error con código y status HTTP, para que el router lo traduzca a JSON. */
export class HubError extends Error {
	constructor(public code: string, public status: number) {
		super(code);
	}
}

/**
 * Tablas cuya escritura es EXCLUSIVA de la Main (FISCAL-01). No es una regla de producto como
 * `soloLaMainCobra`: es que la nube no puede fabricar un registro de facturación.
 *
 * Un registro de facturación es el hecho fiscal, se crea dentro de la transacción del cobro y va
 * encadenado por una huella al anterior. La cadena vive en el SIF del obligado —el equipo del
 * bar—, y `Registros_Facturacion` se replica aquí para que una Main que pierda su `data.db` pueda
 * recuperarla: **la nube es copia, no fuente**. Una fila insertada desde aquí sería un eslabón que
 * ninguna huella ata a nada, y el `Orden` que gastara dejaría a la Main emitiendo por detrás de su
 * propia cadena.
 *
 * `Serie_Facturacion` va con ella por lo mismo: es el contador que reserva el número, y un número
 * repartido desde dos sitios acaba en una factura duplicada (error 3000 de la AEAT).
 */
const TABLAS_SOLO_MAIN = ["Registros_Facturacion", "Serie_Facturacion"];

/**
 * ¿Alguna sentencia de este comando escribe en una tabla vetada?
 *
 * Se mira el SQL y no el nombre del comando a propósito: el nombre lo elige quien añade la ruta y
 * es justo lo que se olvida de revisar. Sólo se miran las ESCRITURAS — leer un ticket desde la
 * Handy es legítimo y es lo que hace la pantalla de Cuentas.
 */
function escrituraVetada(command: ApplyCommand): string | null {
	const stmts: any[] =
		command.type === "tenantDb.transaction"
			? (command.payload?.steps ?? command.payload?.statements ?? [])
			: [command.payload];

	for (const st of stmts) {
		const sql = String(st?.sql ?? "");
		if (!sql) continue;
		const sqlMayus = sql.toUpperCase();
		const head = sqlMayus.trimStart().slice(0, 6);
		const esEscritura =
			head.startsWith("INSERT") ||
			head.startsWith("UPDATE") ||
			head.startsWith("DELETE") ||
			head.startsWith("REPLAC");
		if (!esEscritura) continue;
		for (const tabla of TABLAS_SOLO_MAIN) {
			if (sqlMayus.includes(tabla.toUpperCase())) return tabla;
		}
	}
	return null;
}

export async function applyViaHub(env: Env, params: ApplyParams): Promise<any> {
	const { tenantId, deviceId, opId, commandName, command, cloudPayload, clientNow } =
		params;

	// FISCAL-01. Este es el camino de la API REST, o sea el de la Handy: el outbox de la Main
	// entra por el WebSocket del DO y no pasa por aquí. Una regla que sólo viviera en la interfaz
	// —o en la revisión de código de quien añade la próxima ruta— es una sugerencia.
	const vetada = escrituraVetada(command);
	if (vetada) {
		throw new HubError(`escritura_solo_en_main:${vetada}`, 403);
	}

	const id = env.TenantHub.idFromName(tenantId);
	const stub = env.TenantHub.get(id);

	const rawBody = JSON.stringify({
		type: command.type,
		payload: command.payload,
		opId,
		commandName,
		deviceId,
		cloud_payload: cloudPayload ?? null,
		client_now: clientNow ?? null,
	});

	// Firma HMAC del worker → el DO verifica que la escritura proviene de `tpv-api`
	// legítimo. `pathname`/`body` deben coincidir con los que verá el verificador.
	const sigHeaders = await signInternalWorkerRequest(
		String(env.LICENSE_JWT_SECRET || ""),
		"POST",
		"/internal/apply",
		rawBody,
	);

	const res = await stub.fetch("https://do/internal/apply", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-tenant-id": tenantId,
			"x-device-id": deviceId,
			...(clientNow ? { "x-client-now": clientNow } : {}),
			...sigHeaders,
		},
		body: rawBody,
	});

	const json: any = await res.json().catch(() => ({}));

	if (!res.ok || !json?.ok) {
		const code = String(json?.error || "apply_failed");
		throw new HubError(code, res.status || 500);
	}

	return json.data;
}

/**
 * Le dice al `TenantHub` que cierre los WebSockets vivos de un dispositivo.
 *
 * Es la diferencia entre "se entera cuando le toque" y "se entera ahora". El TPV sólo pregunta por
 * su licencia cada 6 horas (job `licencia`), así que sin esto un equipo con el socket abierto sigue
 * vendiendo hasta medio día después de anularla. Cerrándoselo, el cliente reconecta a los 3 s,
 * `/v1/ws/ticket` le contesta 403 y ESO es lo que dispara el bloqueo de verdad: `useMainSocket`
 * traduce un rechazo de la nube en un `license_check_now`, que emite `license:changed` y tapa la
 * aplicación. Por eso no hace falta ningún mensaje nuevo del DO: basta con cerrar.
 *
 * **Best-effort a propósito.** Quien llama ya ha escrito el cambio en el control-plane, que es lo
 * que manda; esto sólo lo adelanta. Si el DO no contesta, el equipo se bloquea igual en su próximo
 * reconnect o en la siguiente vuelta del job. Un fallo aquí nunca puede tumbar la operación.
 */
export async function cerrarSocketsDelDispositivo(
	hubNs: DurableObjectNamespace,
	jwtSecret: string,
	tenantId: string,
	deviceId: string,
): Promise<void> {
	if (!tenantId || !deviceId) return;

	try {
		const stub = hubNs.get(hubNs.idFromName(tenantId));

		const rawBody = JSON.stringify({ deviceId });

		// FABLE-F: misma firma HMAC que `/internal/apply`. `pathname` y `rawBody` tienen que
		// coincidir EXACTAMENTE con los que verá el verificador del DO.
		const sigHeaders = await signInternalWorkerRequest(
			jwtSecret,
			"POST",
			"/internal/revoke",
			rawBody,
		);

		await stub.fetch("https://do/internal/revoke", {
			method: "POST",
			headers: { "content-type": "application/json", ...sigHeaders },
			body: rawBody,
		});
	} catch {
		// Ver arriba: si falla, el dispositivo se bloquea en el próximo reconnect.
	}
}
