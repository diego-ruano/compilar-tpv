// src/domains/clientes/clientes.commands.ts

import { nuevoId } from "../../lib/ids";
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

// Local-First/UUIDv7: el id lo genera el cliente y lo envía. Si faltara, generamos uno.
function idStep(provided?: string | null) {
	const id = (provided ?? "").trim() || nuevoId();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

// NOTA (CLI-06): `createCliente` es un UPSERT por ID_Cliente (INSERT ... ON CONFLICT DO
// UPDATE), no un alta estricta. Es intencional para que reaplicar el mismo comando (misma
// Op_Id/UUID en catch-up o reintentos de sync) sea idempotente en vez de romper por PK.
export function createCliente(input: CreateClienteInput): BuiltCommand {
	const cloudPayload = {
		id_cliente: input.id_cliente,
		nombre: input.nombre.trim(),
		email: cleanOrNull(input.email),
		telefono: cleanOrNull(input.telefono),
		notas: cleanOrNull(input.notas),
	};

	const steps = [
		idStep(input.id_cliente),
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

export function updateCliente(idCliente: string, input: UpdateClienteInput): BuiltCommand {
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
