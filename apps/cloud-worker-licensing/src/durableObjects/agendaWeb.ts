// src/durableObjects/agendaWeb.ts
//
// La agenda de reservas web, un Durable Object por negocio (`idFromName(tenantId)`). Sin WebSockets:
// atiende la petición y se duerme. Lo que hace está en `agendaWeb.motor.ts`; esto es el adaptador
// RPC, como el del `TenantHub` (RI-45): los helpers del motor no son parte del prototipo. Y es quien
// pone en fila la retirada del negocio con lo que la agenda esté atendiendo (`agendaWeb.fila.ts`).

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { objetoDelNegocio } from "../lib/objetosDelNegocio";
import type { PendientesReservaWebDto } from "@tpv/contracts";

import type { AltaReservaWeb } from "../domains/reservas_web/reservasWeb.schemas";
import type { ResultadoDeLaMain } from "./agendaWeb.almacen";
import { Fila } from "./agendaWeb.fila";
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
	// Lo que se está atendiendo ahora mismo: no hay nada que recordar al despertar.
	private readonly fila = new Fila();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.motor = new MotorAgendaWeb(ctx, env);
	}

	disponibles(p: { tenantId: string; dia: string; hora: string; personas: number }): Promise<ResultadoDisponibles> {
		return this.fila.atender(() => this.motor.disponibles(p));
	}

	reservar(p: { tenantId: string; alta: AltaReservaWeb; intento?: string | null }): Promise<ResultadoReservar> {
		return this.fila.atender(() => this.motor.reservar(p));
	}

	consultarEnlace(p: { tenantId: string; token: string }): Promise<ResultadoConsulta> {
		return this.fila.atender(() => this.motor.consultarEnlace(p));
	}

	cancelar(p: { tenantId: string; token: string }): Promise<ResultadoCancelar> {
		return this.fila.atender(() => this.motor.cancelar(p));
	}

	// La entrega a la Main (§4.5): sólo desde sus rutas, detrás de `soloLaMain`.
	pendientes(p: { tenantId: string }): Promise<{ ok: true } & PendientesReservaWebDto> {
		return this.fila.atender(() => this.motor.pendientes(p));
	}

	recogidas(p: { tenantId: string; resultados: ResultadoDeLaMain[] }): Promise<{ ok: true; apuntadas: number }> {
		return this.fila.atender(() => this.motor.recogidas(p));
	}

	// Desde la ruta de los avisos al cliente (Main o Handy): el restaurante ha cambiado la reserva.
	enlaceParaUnCambio(p: {
		tenantId: string;
		id_reserva: string;
		dia: string;
		hora: string;
	}): Promise<{ ok: true; canceladaPorElCliente: boolean; token: string | null }> {
		return this.fila.atender(() => this.motor.enlaceParaUnCambio(p));
	}

	/**
	 * Retirar un negocio de pruebas: todo lo que la agenda guarda de él, y su alarma. Cuando no
	 * queda ninguna llamada a medias (`Fila`).
	 */
	borrarTodo(): Promise<void> {
		return this.fila.retirar(() => this.motor.borrarTodo());
	}

	alarm(): Promise<void> {
		return this.fila.atender(() => this.motor.alarm());
	}
}

/**
 * La agenda de un negocio, colocada como su TenantHub (`lib/objetosDelNegocio.ts`): guarda datos
 * personales de quien reserva, y quien la llama primero puede ser el visitante de una web desde
 * cualquier sitio. La pista pide que nazca en Europa occidental aunque él esté en otro continente.
 */
export function agendaDe(
	env: Pick<Env, "AgendaWeb" | "JURISDICCION_DO" | "UBICACION_DO">,
	tenantId: string,
): DurableObjectStub<AgendaWeb> {
	return objetoDelNegocio(env, env.AgendaWeb, tenantId);
}
