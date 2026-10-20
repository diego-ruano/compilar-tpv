// src/domains/reservas/reservas.commands.ts

import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import type { ClienteResuelto } from "./reservas.queries";
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

export function saveReserva(input: ReservaSaveInput, cliente: ClienteResuelto): BuiltCommand {
	const cloudPayload = {
		...input,
		id_cliente: cliente.modo === "existente" ? cliente.id_cliente : null,
	};

	const { steps: pasosCliente, idCliente } = clienteSteps(input, cliente);
	const steps: any[] = [...pasosCliente];

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
 * Quién decide es la ruta, que la lee antes (`reservas.queries.ts::estadoYOrigen`): la sentencia no
 * lleva la condición porque se vuelve a evaluar en la Main al replicarse, que puede tener la reserva
 * en otro estado.
 */
export function cancelarReserva(idReserva: string): BuiltCommand {
	return {
		commandName: "reservas_cancelar",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
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
