// src/domains/clientes/clientes.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type { CreateClienteInput, UpdateClienteInput } from "./clientes.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID = { $ref: "id" } as const;

function cleanOrNull(s: unknown): string | null {
	const t = (s ?? "").toString().trim();
	return t.length ? t : null;
}

function nextIdStep(provided?: number) {
	return provided && provided > 0
		? { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [provided] }
		: {
				kind: "value",
				saveAs: "id",
				sql: "SELECT COALESCE(MAX(ID_Cliente), 0) + 1 FROM Clientes;",
			};
}

export function createCliente(input: CreateClienteInput): BuiltCommand {
	const cloudPayload = {
		id_cliente: input.id_cliente,
		nombre: input.nombre.trim(),
		email: cleanOrNull(input.email),
		telefono: cleanOrNull(input.telefono),
		notas: cleanOrNull(input.notas),
	};

	const steps = [
		nextIdStep(input.id_cliente),
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
				)
				ON CONFLICT(ID_Cliente) DO UPDATE SET
					Nombre = excluded.Nombre,
					Telefono = excluded.Telefono,
					Email = excluded.Email,
					Notas = excluded.Notas;
			`,
			args: [
				REF_ID,
				cloudPayload.nombre,
				cloudPayload.telefono,
				cloudPayload.email,
				cloudPayload.notas,
			],
		},
	];

	return {
		commandName: "clientes_create_cliente",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload,
	};
}

export function updateCliente(idCliente: number, input: UpdateClienteInput): BuiltCommand {
	const cloudPayload = {
		id_cliente: idCliente,
		nombre: input.nombre.trim(),
		email: cleanOrNull(input.email),
		telefono: cleanOrNull(input.telefono),
		notas: cleanOrNull(input.notas),
	};

	return {
		commandName: "clientes_update_cliente",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Clientes
					SET
						Nombre = ?1,
						Telefono = ?2,
						Email = ?3,
						Notas = ?4
					WHERE ID_Cliente = ?5;
				`,
				args: [
					cloudPayload.nombre,
					cloudPayload.telefono,
					cloudPayload.email,
					cloudPayload.notas,
					cloudPayload.id_cliente,
				],
			},
		},
		cloudPayload,
	};
}
