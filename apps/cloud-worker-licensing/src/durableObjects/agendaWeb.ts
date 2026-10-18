// src/durableObjects/agendaWeb.ts
//
// La agenda de reservas web, un Durable Object por negocio (`idFromName(tenantId)`). Sin WebSockets:
// atiende la petición y se duerme. Lo que hace está en `agendaWeb.motor.ts`; esto es sólo el
// adaptador RPC, como el del `TenantHub` (RI-45): los helpers del motor no son parte del prototipo.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import type { AltaReservaWeb } from "../domains/reservas_web/reservasWeb.schemas";
import {
	MotorAgendaWeb,
	type ResultadoCancelar,
	type ResultadoConsulta,
	type ResultadoDisponibles,
	type ResultadoReservar,
} from "./agendaWeb.motor";

export class AgendaWeb extends DurableObject<Env> {
	// Los campos de instancia no son visibles por RPC. El motor se crea de nuevo al despertar; lo
	// que importa está en el SQLite del objeto.
	private readonly motor: MotorAgendaWeb;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.motor = new MotorAgendaWeb(ctx, env);
	}

	disponibles(p: { tenantId: string; dia: string; hora: string; personas: number }): Promise<ResultadoDisponibles> {
		return this.motor.disponibles(p);
	}

	reservar(p: { tenantId: string; alta: AltaReservaWeb }): Promise<ResultadoReservar> {
		return this.motor.reservar(p);
	}

	consultarEnlace(p: { tenantId: string; token: string }): Promise<ResultadoConsulta> {
		return this.motor.consultarEnlace(p);
	}

	cancelar(p: { tenantId: string; token: string }): Promise<ResultadoCancelar> {
		return this.motor.cancelar(p);
	}

	alarm(): Promise<void> {
		return this.motor.alarm();
	}
}

/** La agenda de un negocio. */
export function agendaDe(env: Env, tenantId: string): DurableObjectStub<AgendaWeb> {
	return env.AgendaWeb.get(env.AgendaWeb.idFromName(tenantId));
}
