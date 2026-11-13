import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { MotorTenantHub } from "./tenantHub.motor";
import type { ApplyParams, IdentidadDelWorker, ResultadoAplicacion } from "./tenantHub.rpc";
import type { LecturaWeb, RespuestaDeLecturaWeb } from "../domains/reservas_web/lecturasDeLaWeb";
import { comoPeticionDeSentry } from "../observability/sentry";

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

	/**
	 * Una ruta de negocio entera, ejecutada aquí al lado de la base (`lib/enElHub.ts`). Para Sentry
	 * es una petición: su propio ámbito y su propio cliente (`comoPeticionDeSentry`).
	 */
	ejecutarRuta(peticion: Request, identidad: IdentidadDelWorker): Promise<Response> {
		return comoPeticionDeSentry(this.env, this.ctx, peticion, () =>
			this.motor.ejecutarRuta(peticion, identidad),
		);
	}

	/**
	 * Una lectura de la agenda de reservas web o de la API pública de la reserva, entera, con la base
	 * al lado (`domains/reservas_web/lecturasDeLaWeb.ts`). Sólo lee.
	 */
	leerParaLaWeb(tenantId: string, lectura: LecturaWeb): Promise<RespuestaDeLecturaWeb> {
		return this.motor.leerParaLaWeb(tenantId, lectura);
	}

	/** El alta del negocio crea aquí su esquema y su administrador inicial. */
	aprovisionar(tenantId: string): Promise<{ reused: boolean }> {
		return this.motor.aprovisionar(tenantId);
	}

	estaAprovisionado(): boolean {
		return this.motor.estaAprovisionado();
	}

	/** Retirar un negocio de pruebas: cierra sus sesiones, quita la alarma y borra todo lo guardado. */
	borrarTodo(): Promise<void> {
		return this.motor.borrarTodo();
	}

	revocarDispositivo(deviceId: string): Promise<void> {
		return this.motor.revocarDispositivo(deviceId);
	}

	/** AUD-02: la licencia del negocio ha cambiado; que vuelva a leer quién es la Main. */
	releerMain(tenantId: string): Promise<void> {
		return this.motor.releerMain(tenantId);
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
