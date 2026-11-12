// src/lib/hub.ts
//
// Puente con el Durable Object TenantHub para las ESCRITURAS de la API.
//
// Toda escritura va al MISMO motor del DO (RPC `aplicar`): aplica en la base
// dentro de una transacción, registra idempotencia por `Op_Id` y, tras confirmar,
// hace broadcast del cambio por WebSocket al resto de dispositivos. El DO también
// rechaza la escritura con `main_offline` si no hay una Main conectada.

import type { Env } from "../env";
import { HubError } from "./errorHttp";
import { capturarError } from "../observability/errors";
import { medirTramo } from "../observability/tiempos";
import { hubLocal } from "./hubLocal";
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

/**
 * El espacio de los TenantHub, con la jurisdicción del despliegue.
 *
 * Con la base del negocio dentro del DO, donde nace el objeto es donde viven sus datos, y nace
 * cerca de quien lo toca primero: una reserva web hecha desde fuera de Europa, por ejemplo. Con
 * `JURISDICCION_DO = "eu"` sólo puede nacer y guardarse en la UE. En local va vacía: workerd no
 * implementa jurisdicciones («Jurisdiction restrictions are not implemented in workerd»).
 *
 * El mismo nombre da otro objeto en otra jurisdicción: cambiarla es empezar de cero.
 */
export function espacioDelHub(env: Pick<Env, "TenantHub" | "JURISDICCION_DO">): Env["TenantHub"] {
	const j = env.JURISDICCION_DO;
	return j ? env.TenantHub.jurisdiction(j as DurableObjectJurisdiction) : env.TenantHub;
}

/** El TenantHub de un negocio. */
export function hubDe(env: Pick<Env, "TenantHub" | "JURISDICCION_DO" | "UBICACION_DO">, tenantId: string) {
	const ns = espacioDelHub(env);
	const pista = env.UBICACION_DO as DurableObjectLocationHint | undefined;
	return pista ? ns.get(ns.idFromName(tenantId), { locationHint: pista }) : ns.get(ns.idFromName(tenantId));
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

	// Dentro del TenantHub del negocio (`lib/enElHub.ts`), el motor está al lado: sin RPC.
	const local = hubLocal(tenantId);
	const respuesta = local
		? await local.aplicar(params)
		: ((await medirTramo("hub-escribe", async () => hubDe(env, tenantId).aplicar(params))) as ResultadoAplicacion);
	if (!respuesta.ok) throw new HubError(respuesta.error, respuesta.status, respuesta.details);
	return respuesta.data;
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
