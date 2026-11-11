import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { MotorTenantHub } from "./tenantHub.motor";
import type { ApplyParams, RespuestaDeConsulta, ResultadoAplicacion } from "./tenantHub.rpc";
import type { Sentencia } from "./tenantHub.sqlite";

/** RI-45: solo este adaptador es RPC. Los helpers del motor no pertenecen a su prototipo. */
export class TenantHub extends DurableObject<Env> {
	// Los campos de instancia no son visibles por RPC. El motor se crea de nuevo al despertar;
	// las sesiones y la cola duraderas siguen en attachments y storage, respectivamente.
	private readonly motor: MotorTenantHub;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.motor = new MotorTenantHub(ctx, env);
	}

	aplicar(params: ApplyParams): Promise<ResultadoAplicacion> {
		return this.motor.aplicar(params);
	}

	/** prueba/sqlite-do: las lecturas del Worker contra la base del negocio, que vive aquí. */
	consultar(tenantId: string, sentencias: Sentencia[], enLote: boolean): Promise<RespuestaDeConsulta> {
		return this.motor.consultar(tenantId, sentencias, enLote);
	}

	/** prueba/sqlite-do: el alta del negocio crea aquí su esquema. */
	aprovisionar(tenantId: string): Promise<void> {
		return this.motor.aprovisionar(tenantId);
	}

	estaAprovisionado(): boolean {
		return this.motor.estaAprovisionado();
	}

	/** prueba/sqlite-do: retirar un negocio de pruebas. */
	borrarTodo(): Promise<void> {
		return this.motor.borrarTodo();
	}

	revocarDispositivo(deviceId: string): void {
		this.motor.revocarDispositivo(deviceId);
	}

	avisarEmparejamiento(): void {
		this.motor.avisarEmparejamiento();
	}

	/** La agenda de reservas web tiene algo para la Main (docs/estudios/reservas-web.md §4.4). */
	avisarReservasWeb(): void {
		this.motor.avisarReservasWeb();
	}

	fetch(request: Request): Promise<Response> {
		return this.motor.fetch(request);
	}

	alarm(): Promise<void> {
		return this.motor.alarm();
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		return this.motor.webSocketMessage(ws, message);
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		return this.motor.webSocketClose(ws, code, reason, wasClean);
	}

	webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		return this.motor.webSocketError(ws, error);
	}
}
