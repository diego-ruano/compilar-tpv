// src/durableObjects/agendaWeb.ts
//
// La agenda de reservas web, un Durable Object por negocio (`idFromName(tenantId)`). Sin WebSockets:
// atiende la petición y se duerme. Lo que hace está en `agendaWeb.motor.ts`; esto es sólo el
// adaptador RPC, como el del `TenantHub` (RI-45): los helpers del motor no son parte del prototipo.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import type { PendientesReservaWebDto } from "@tpv/contracts";

import type { AltaReservaWeb } from "../domains/reservas_web/reservasWeb.schemas";
import type { ResultadoDeLaMain } from "./agendaWeb.almacen";
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

	reservar(p: { tenantId: string; alta: AltaReservaWeb; intento?: string | null }): Promise<ResultadoReservar> {
		return this.motor.reservar(p);
	}

	consultarEnlace(p: { tenantId: string; token: string }): Promise<ResultadoConsulta> {
		return this.motor.consultarEnlace(p);
	}

	cancelar(p: { tenantId: string; token: string }): Promise<ResultadoCancelar> {
		return this.motor.cancelar(p);
	}

	// La entrega a la Main (§4.5): sólo desde sus rutas, detrás de `soloLaMain`.
	pendientes(p: { tenantId: string }): Promise<{ ok: true } & PendientesReservaWebDto> {
		return this.motor.pendientes(p);
	}

	recogidas(p: { tenantId: string; resultados: ResultadoDeLaMain[] }): Promise<{ ok: true; apuntadas: number }> {
		return this.motor.recogidas(p);
	}

	// Desde la ruta de los avisos al cliente (Main o Handy): el restaurante ha cambiado la reserva.
	enlaceParaUnCambio(p: {
		tenantId: string;
		id_reserva: string;
		dia: string;
		hora: string;
	}): Promise<{ ok: true; canceladaPorElCliente: boolean; token: string | null }> {
		return this.motor.enlaceParaUnCambio(p);
	}

	alarm(): Promise<void> {
		return this.motor.alarm();
	}
}

/** La agenda de un negocio. */
export function agendaDe(env: Env, tenantId: string): DurableObjectStub<AgendaWeb> {
	return env.AgendaWeb.get(env.AgendaWeb.idFromName(tenantId));
}
