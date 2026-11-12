import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { MotorTenantHub } from "./tenantHub.motor";
import type { ApplyParams, IdentidadDelWorker, RespuestaDeConsulta, ResultadoAplicacion } from "./tenantHub.rpc";
import type { Sentencia } from "./tenantHub.sqlite";
import { diagnosticar, type AccionDeDiagnostico, type RespuestaDeDiagnostico } from "./tenantHub.diagnostico";

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

	/** Una ruta de negocio entera, ejecutada aquí al lado de la base (`lib/enElHub.ts`). */
	ejecutarRuta(peticion: Request, identidad: IdentidadDelWorker): Promise<Response> {
		return this.motor.ejecutarRuta(peticion, identidad);
	}

	/** Las lecturas del Worker contra la base del negocio, que vive aquí. */
	consultar(tenantId: string, sentencias: Sentencia[], enLote: boolean): Promise<RespuestaDeConsulta> {
		return this.motor.consultar(tenantId, sentencias, enLote);
	}

	/** El alta del negocio crea aquí su esquema. */
	aprovisionar(tenantId: string): Promise<void> {
		return this.motor.aprovisionar(tenantId);
	}

	estaAprovisionado(): boolean {
		return this.motor.estaAprovisionado();
	}

	/** Retirar un negocio de pruebas: su base entera. */
	borrarTodo(): Promise<void> {
		return this.motor.borrarTodo();
	}

	/** La ruta de diagnóstico de latencias (`tenantHub.diagnostico.ts`). */
	diagnostico(a: AccionDeDiagnostico): Promise<RespuestaDeDiagnostico> {
		return diagnosticar(this.ctx, this.env, a);
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
