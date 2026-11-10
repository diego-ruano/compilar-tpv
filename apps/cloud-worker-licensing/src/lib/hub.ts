// src/lib/hub.ts
//
// Puente con el Durable Object TenantHub para las ESCRITURAS de la API.
//
// Toda escritura va al MISMO motor del DO (RPC `aplicar`): aplica en Turso
// dentro de una transacción, registra idempotencia por `Op_Id` y, tras confirmar,
// hace broadcast del cambio por WebSocket al resto de dispositivos. El DO también
// rechaza la escritura con `main_offline` si no hay una Main conectada.

import type { Env } from "../env";
import { HubError } from "./errorHttp";
import { capturarError } from "../observability/errors";
import type { ApplyParams, ResultadoAplicacion } from "../durableObjects/tenantHub.rpc";
export type { ApplyParams } from "../durableObjects/tenantHub.rpc";

export { HubError } from "./errorHttp";

export type ApplyCommand = {
	type: "tenantDb.exec" | "tenantDb.transaction";
	payload: any;
};

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
 *
 * La configuración de las reservas desde la web (qué mesas, cuándo y qué días se cierra,
 * docs/estudios/reservas-web.md) es de administración y sólo tiene pantalla en la Main. Borrar una
 * mesa desde la Handy sigue llevándose su configuración: eso es la cascada de la base, no una
 * sentencia de la Handy.
 */
const TABLAS_SOLO_MAIN = [
	"Registros_Facturacion",
	"Serie_Facturacion",
	"Roles_Permisos",
	"Reserva_Web_Mesas",
	"Reserva_Web_Franjas",
	"Reserva_Web_Cierres",
];

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
	const { tenantId, command } = params;

	// FISCAL-01. Este es el camino de la API REST, o sea el de la Handy: el outbox de la Main
	// entra por el WebSocket del DO y no pasa por aquí. Una regla que sólo viviera en la interfaz
	// —o en la revisión de código de quien añade la próxima ruta— es una sugerencia.
	const vetada = escrituraVetada(command);
	if (vetada) {
		throw new HubError(`escritura_solo_en_main:${vetada}`, 403);
	}

	const id = env.TenantHub.idFromName(tenantId);
	const stub = env.TenantHub.get(id);

	const respuesta: ResultadoAplicacion = await stub.aplicar(params);
	if (!respuesta.ok) throw new HubError(respuesta.error, respuesta.status, respuesta.details);
	return respuesta.data;
}

/**
 * Le dice al `TenantHub` que cierre los WebSockets vivos de un dispositivo que se ha dado de baja.
 *
 * Es la diferencia entre "se entera cuando le toque" y "se entera ahora". Cerrándoselo, el cliente
 * reconecta a los 3 s, `/v1/ws/ticket` le contesta 403 y ESO es lo que dispara el bloqueo de verdad:
 * `useMainSocket` traduce un rechazo de la nube en un `license_check_now`, que emite
 * `license:changed` y tapa la aplicación. Por eso no hace falta ningún mensaje nuevo del DO: basta
 * con cerrar.
 *
 * **Best-effort a propósito.** Quien llama ya ha escrito el cambio en el control-plane, que es lo
 * que manda; esto sólo lo adelanta. Si el DO no contesta, el equipo se bloquea igual en su próximo
 * reconnect o en la siguiente vuelta del job. Un fallo aquí nunca puede tumbar la operación.
 *
 * AUD-02: cierra sin condición, porque la baja de un dispositivo no se deshace con otro aviso. Un
 * cambio de licencia (traslado, anulación, reembolso) va por `avisarCambioDeLicencia`.
 */
export async function cerrarSocketsDelDispositivo(
	hubNs: Env["TenantHub"],
	tenantId: string,
	deviceId: string,
): Promise<void> {
	if (!tenantId || !deviceId) return;

	try {
		const stub = hubNs.get(hubNs.idFromName(tenantId));

		await stub.revocarDispositivo(deviceId);
	} catch (error) {
		capturarError(error, "device.close_sockets");
		// Ver arriba: si falla, el dispositivo se bloquea en el próximo reconnect.
	}
}

/**
 * AUD-02 · Le dice al `TenantHub` del negocio que su licencia ha cambiado y quién es la Main puede
 * no ser ya quien era: un traslado a otro equipo (`/v1/license/activate`), una anulación desde la
 * administración, o el reembolso o la disputa de un alta (webhook de Stripe).
 *
 * El hub no echa a nadie porque se lo digan: vuelve a leer de la base central quién es la Main y
 * echa a la sesión `tpv` que no lo sea (`releerMain`). Así un aviso que llega tarde —el del traslado
 * B→A, entregado después de que la licencia haya vuelto a B— no echa a la Main que ha vuelto a
 * serlo. Al equipo que ha dejado de ser la Main se le cierra el socket, reconecta, el ticket se le
 * niega y se bloquea, como con `cerrarSocketsDelDispositivo`.
 *
 * Best-effort, igual que aquél: quien llama ya ha escrito el cambio en el control-plane. Si el aviso
 * no llega, el hub lo corrige por su cuenta en cuanto hay actividad, como mucho un minuto después
 * de su última lectura (`comprobarMain`).
 */
export async function avisarCambioDeLicencia(hubNs: Env["TenantHub"], tenantId: string): Promise<void> {
	if (!tenantId) return;

	try {
		const stub = hubNs.get(hubNs.idFromName(tenantId));

		await stub.releerMain(tenantId);
	} catch (error) {
		capturarError(error, "license.notify_hub");
	}
}
