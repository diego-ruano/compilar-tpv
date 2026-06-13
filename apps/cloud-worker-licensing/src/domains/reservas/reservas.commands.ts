// src/domains/reservas/reservas.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type { ReservaSaveInput } from "./reservas.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_CLIENTE = { $ref: "id_cliente" } as const;
const REF_ID_RESERVA = { $ref: "id_reserva" } as const;

export type ClienteReservaExistente = {
	id_cliente: string;
	email: string | null;
} | null;

function cleanOrNull(s: unknown): string | null {
	const t = (s ?? "").toString().trim();
	return t.length ? t : null;
}

function clienteSteps(input: ReservaSaveInput, cliente: ClienteReservaExistente) {
	if (cliente?.id_cliente) {
		const shouldSetEmail = input.email && !cleanOrNull(cliente.email);
		return [
			{
				kind: "execute",
				sql: shouldSetEmail
					? `
						UPDATE Clientes
						SET
							Nombre = ?1,
							Email = ?2,
							Telefono = ?3,
							Notas = ?4
						WHERE ID_Cliente = ?5;
					`
					: `
						UPDATE Clientes
						SET
							Nombre = ?1,
							Telefono = ?2,
							Notas = ?3
						WHERE ID_Cliente = ?4;
					`,
				args: shouldSetEmail
					? [
							input.nombre_cliente,
							input.email,
							input.telefono,
							input.notas_cliente,
							cliente.id_cliente,
						]
					: [
							input.nombre_cliente,
							input.telefono,
							input.notas_cliente,
							cliente.id_cliente,
						],
			},
			{
				kind: "value",
				saveAs: "id_cliente",
				sql: "SELECT ?1;",
				args: [cliente.id_cliente],
			},
		];
	}

	return [
		{
			kind: "value",
			saveAs: "id_cliente",
			sql: "SELECT ?1;",
			args: [crypto.randomUUID()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Clientes (
					ID_Cliente,
					Nombre,
					Telefono,
					Email,
					Notas,
					Created_At
				)
				VALUES (
					?1,
					?2,
					?3,
					?4,
					?5,
					datetime('now','localtime')
				);
			`,
			args: [
				REF_ID_CLIENTE,
				input.nombre_cliente,
				input.telefono,
				input.email,
				input.notas_cliente,
			],
		},
	];
}

function reservaArgs(input: ReservaSaveInput, withId: boolean) {
	const args = [
		REF_ID_CLIENTE,
		input.id_mesa,
		input.dia_ymd,
		input.hora,
		input.turno,
		input.comensales,
		input.nota,
		input.estado,
	];
	return withId ? [input.id_reserva, ...args] : args;
}

export function saveReserva(
	input: ReservaSaveInput,
	cliente: ClienteReservaExistente,
): BuiltCommand {
	const cloudPayload = {
		...input,
		id_cliente: cliente?.id_cliente ?? null,
	};

	const steps: any[] = [...clienteSteps(input, cliente)];

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
					Estado
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
					?9
				)
				ON CONFLICT(ID_Reserva) DO UPDATE SET
					ID_Cliente = excluded.ID_Cliente,
					ID_Mesa = excluded.ID_Mesa,
					Dia_YMD = excluded.Dia_YMD,
					Hora = excluded.Hora,
					Turno = excluded.Turno,
					Comensales = excluded.Comensales,
					Nota = excluded.Nota,
					Estado = excluded.Estado;
			`,
			args: reservaArgs(input, true),
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
			args: [crypto.randomUUID()],
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
					Estado
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
					?9
				);
			`,
			args: [REF_ID_RESERVA, ...reservaArgs(input, false)],
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

export function deleteReserva(idReserva: string): BuiltCommand {
	const cloudPayload = { id_reserva: idReserva };
	return {
		commandName: "reservas_delete",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
						args: [idReserva],
					},
					{
						kind: "execute",
						saveAs: "deleted",
						sql: "DELETE FROM Reservas WHERE ID_Reserva = ?1;",
						args: [idReserva],
					},
				],
				resultKey: "deleted",
			},
		},
		cloudPayload,
	};
}
