// src/domains/reservas/reservas.commands.ts

import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import {
	argumentosDelChoque,
	SQL_SIN_CHOQUE_EN_LA_MESA,
	type AjustesDeReserva,
	type ClienteResuelto,
} from "./reservas.queries";
import type { ReservaSaveInput } from "./reservas.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_CLIENTE = { $ref: "id_cliente" } as const;
const REF_ID_RESERVA = { $ref: "id_reserva" } as const;

/**
 * Los pasos del cliente según lo que decidió `resolverCliente` (RI-61), y el valor que va en
 * `Reservas.ID_Cliente`: nada, el id del que ya existe o la referencia al que se crea aquí.
 */
function clienteSteps(
	input: ReservaSaveInput,
	cliente: ClienteResuelto,
): { steps: any[]; idCliente: string | typeof REF_ID_CLIENTE | null } {
	switch (cliente.modo) {
		case "ninguno":
			return { steps: [], idCliente: null };

		case "existente":
			return {
				steps: cliente.actualizar
					? [
							{
								kind: "execute",
								sql: `
									UPDATE Clientes
									SET
										Email = ?1,
										Telefono = ?2
									WHERE ID_Cliente = ?3;
								`,
								args: [
									cliente.actualizar.email,
									cliente.actualizar.telefono,
									cliente.id_cliente,
								],
							},
						]
					: [],
				idCliente: cliente.id_cliente,
			};

		case "nuevo":
			return {
				steps: [
					{
						kind: "value",
						saveAs: "id_cliente",
						sql: "SELECT ?1;",
						args: [nuevoId()],
					},
					{
						kind: "execute",
						sql: `
							INSERT INTO Clientes (
								ID_Cliente,
								Nombre,
								Telefono,
								Email,
								Created_At
							)
							VALUES (
								?1,
								?2,
								?3,
								?4,
								datetime('now','localtime')
							);
						`,
						args: [
							REF_ID_CLIENTE,
							input.nombre_cliente,
							input.telefono,
							input.email,
						],
					},
				],
				idCliente: REF_ID_CLIENTE,
			};
	}
}

function reservaArgs(input: ReservaSaveInput, idCliente: unknown, withId: boolean) {
	const args = [
		idCliente,
		input.id_mesa,
		input.dia_ymd,
		input.hora,
		input.turno,
		input.comensales,
		input.nota,
		input.duracion_min ?? null,
	];
	return withId ? [input.id_reserva, ...args] : args;
}

/**
 * SYNC-30: lo que la ruta decidió leyendo la base, otra vez dentro del lote que guarda la reserva.
 *
 * - El cliente existente sigue existiendo (`cliente_no_encontrado`).
 * - La mesa no choca con nada, si el solape está prohibido (`reserva_solapada_prohibida`) o si no
 *   llega confirmado (`reserva_solapada`). Un solape confirmado con «avisar» entra.
 *
 * Van delante de todo lo que escribe: la reserva no choca consigo misma, pero una nueva sin id lo
 * recibe aquí.
 */
function guardasDeLaReserva(
	input: ReservaSaveInput,
	cliente: ClienteResuelto,
	ajustes: AjustesDeReserva | null,
): any[] {
	const guardas: any[] = [];
	if (cliente.modo === "existente") {
		guardas.push({
			kind: "guard",
			sql: "SELECT EXISTS (SELECT 1 FROM Clientes WHERE ID_Cliente = ?1);",
			args: [cliente.id_cliente],
			error: "cliente_no_encontrado",
			status: 404,
		});
	}
	if (input.id_mesa && ajustes) {
		const error =
			ajustes.modo === "prohibir" ? "reserva_solapada_prohibida" : input.forzar_solape ? null : "reserva_solapada";
		if (error) {
			guardas.push({
				kind: "guard",
				sql: SQL_SIN_CHOQUE_EN_LA_MESA,
				args: argumentosDelChoque({ ...input, id_mesa: input.id_mesa }, ajustes.duracion),
				error,
				status: 409,
			});
		}
	}
	return guardas;
}

/**
 * `ajustes` son los del negocio cuando la reserva lleva mesa (la ruta los lee para mirar el solape),
 * y `null` sin mesa.
 */
export function saveReserva(
	input: ReservaSaveInput,
	cliente: ClienteResuelto,
	ajustes: AjustesDeReserva | null,
): BuiltCommand {
	const cloudPayload = {
		...input,
		id_cliente: cliente.modo === "existente" ? cliente.id_cliente : null,
	};

	const { steps: pasosCliente, idCliente } = clienteSteps(input, cliente);
	const steps: any[] = [...guardasDeLaReserva(input, cliente, ajustes), ...pasosCliente];

	if (input.id_reserva) {
		steps.push({
			kind: "execute",
			sql: `
				INSERT INTO Reservas (
					ID_Reserva,
					ID_Cliente,
					ID_Mesa,
					Dia_YMD,
					Hora,
					Turno,
					Comensales,
					Nota,
					Estado,
					Duracion_Min,
					Created_At
				)
				VALUES (
					?1,
					?2,
					?3,
					?4,
					?5,
					?6,
					?7,
					?8,
					'PROXIMA',
					?9,
					datetime('now','localtime')
				)
				ON CONFLICT(ID_Reserva) DO UPDATE SET
					ID_Cliente = excluded.ID_Cliente,
					ID_Mesa = excluded.ID_Mesa,
					Dia_YMD = excluded.Dia_YMD,
					Hora = excluded.Hora,
					Turno = excluded.Turno,
					Comensales = excluded.Comensales,
					Nota = excluded.Nota,
					Duracion_Min = excluded.Duracion_Min;
			`,
			args: reservaArgs(input, idCliente, true),
		});
		steps.push({
			kind: "value",
			saveAs: "id_reserva",
			sql: "SELECT ?1;",
			args: [input.id_reserva],
		});
	} else {
		steps.push({
			kind: "value",
			saveAs: "id_reserva",
			sql: "SELECT ?1;",
			args: [nuevoId()],
		});
		steps.push({
			kind: "execute",
			sql: `
				INSERT INTO Reservas (
					ID_Reserva,
					ID_Cliente,
					ID_Mesa,
					Dia_YMD,
					Hora,
					Turno,
					Comensales,
					Nota,
					Estado,
					Duracion_Min,
					Created_At
				)
				VALUES (
					?1,
					?2,
					?3,
					?4,
					?5,
					?6,
					?7,
					?8,
					'PROXIMA',
					?9,
					datetime('now','localtime')
				);
			`,
			args: [REF_ID_RESERVA, ...reservaArgs(input, idCliente, false)],
		});
	}

	return {
		commandName: "reservas_save",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "id_reserva" },
		},
		cloudPayload,
	};
}

/**
 * Borra una reserva y desvincula sus comandas. Igual que la Main. Una reserva web no se borra
 * (docs/estudios/reservas-web.md §5.6): lo rechaza la ruta antes de construir esto.
 */
export function deleteReserva(idReserva: string): BuiltCommand {
	const steps = [
		{
			kind: "execute" as const,
			sql: "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
			args: [idReserva],
		},
		{
			kind: "execute" as const,
			saveAs: "deleted",
			sql: "DELETE FROM Reservas WHERE ID_Reserva = ?1;",
			args: [idReserva],
		},
	];
	return {
		commandName: "reservas_delete",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "deleted" } },
		cloudPayload: { id_reserva: idReserva },
	};
}

/**
 * Cancela una reserva que aún no ha llegado: se queda, cancelada. Igual que la Main.
 *
 * Que aún no haya llegado lo decide la guarda, dentro del lote que la cancela (SYNC-30): la ruta la
 * lee antes, pero entre su lectura y el lote la Main puede haberla sentado. Si entretanto se ha
 * cancelado o se ha borrado, cancelarla no cambia nada y la guarda la deja pasar. La sentencia
 * replicada no lleva la condición: se vuelve a evaluar en la Main al replicarse, que puede tener la
 * reserva en otro estado, y lo que decide es la nube.
 */
export function cancelarReserva(idReserva: string): BuiltCommand {
	return {
		commandName: "reservas_cancelar",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "guard",
						sql: "SELECT NOT EXISTS (SELECT 1 FROM Reservas WHERE ID_Reserva = ?1 AND Estado NOT IN ('PROXIMA', 'CANCELADA'));",
						args: [idReserva],
						error: "reserva_no_pendiente",
						status: 409,
					},
					{
						kind: "execute",
						saveAs: "canceladas",
						sql: "UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;",
						args: [idReserva],
					},
				],
				resultKey: "canceladas",
			},
		},
		cloudPayload: { id_reserva: idReserva },
	};
}
