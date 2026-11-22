// src/domains/clientes/clientes.commands.ts

import { nuevoId } from "../../lib/ids";
import { recortar } from "../../lib/texto";
import type { ApplyCommand } from "../../lib/hub";
import type { CreateClienteInput, UpdateClienteInput } from "./clientes.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID = { $ref: "id" } as const;

function cleanOrNull(s: unknown): string | null {
	const t = recortar((s ?? "").toString());
	return t.length ? t : null;
}

/**
 * SYNC-30: 1 si el email (`?1`) no es de ningún cliente salvo, si lo hay, el que se guarda (`?2`).
 * Es el criterio del índice único `ux_clientes_email` (sobre `lower(Email)`, sin contar los vacíos),
 * y va en un paso `guard` del comando: mirado por la ruta antes de `apply`, se quedaba viejo
 * mientras el TenantHub atendía a otros (una Handy daba de alta el mismo correo entre la lectura y el
 * lote, y lo que contestaba era el error de SQLite del índice), y el reintento de un alta que ya
 * había entrado se encontraba a sí mismo si llegaba sin su id.
 */
export const SQL_EMAIL_LIBRE_SALVO = `SELECT NOT EXISTS (SELECT 1 FROM Clientes
	WHERE Email IS NOT NULL AND Email <> '' AND lower(Email) = lower(?1) AND ID_Cliente IS NOT ?2);`;

/** La guarda del correo de una ficha que se guarda (`id`: su id, o la referencia al paso que lo da). */
function guardaDelEmail(email: string | null, id: unknown): any[] {
	if (!email) return [];
	return [{ kind: "guard", sql: SQL_EMAIL_LIBRE_SALVO, args: [email, id], error: "email_duplicado", status: 409 }];
}

// Local-First/UUIDv7: el id lo genera el cliente y lo envía. Si faltara, generamos uno.
function idStep(provided?: string | null) {
	const id = recortar(provided ?? "") || nuevoId();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

// NOTA (CLI-06): `createCliente` es un UPSERT por ID_Cliente (INSERT ... ON CONFLICT DO
// UPDATE), no un alta estricta. Es intencional para que reaplicar el mismo comando (misma
// Op_Id/UUID en catch-up o reintentos de sync) sea idempotente en vez de romper por PK.
export function createCliente(input: CreateClienteInput): BuiltCommand {
	const cloudPayload = {
		id_cliente: input.id_cliente,
		nombre: recortar(input.nombre),
		email: cleanOrNull(input.email),
		telefono: cleanOrNull(input.telefono),
		notas: cleanOrNull(input.notas),
		// FISCAL-02: llegan normalizados por el schema, como en la Main.
		nif: cleanOrNull(input.nif),
		razon_social: cleanOrNull(input.razon_social),
		direccion_fiscal: cleanOrNull(input.direccion_fiscal),
	};

	const steps = [
		idStep(input.id_cliente),
		...guardaDelEmail(cloudPayload.email, REF_ID),
		{
			kind: "execute",
			sql: `
				INSERT INTO Clientes (
					ID_Cliente,
					Nombre,
					Telefono,
					Email,
					Notas,
					NIF,
					Razon_Social,
					Direccion_Fiscal,
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
					datetime('now','localtime')
				)
				ON CONFLICT(ID_Cliente) DO UPDATE SET
					Nombre = excluded.Nombre,
					Telefono = excluded.Telefono,
					Email = excluded.Email,
					Notas = excluded.Notas,
					NIF = excluded.NIF,
					Razon_Social = excluded.Razon_Social,
					Direccion_Fiscal = excluded.Direccion_Fiscal;
			`,
			args: [
				REF_ID,
				cloudPayload.nombre,
				cloudPayload.telefono,
				cloudPayload.email,
				cloudPayload.notas,
				cloudPayload.nif,
				cloudPayload.razon_social,
				cloudPayload.direccion_fiscal,
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
		nombre: recortar(input.nombre),
		email: cleanOrNull(input.email),
		telefono: cleanOrNull(input.telefono),
		notas: cleanOrNull(input.notas),
		nif: cleanOrNull(input.nif),
		razon_social: cleanOrNull(input.razon_social),
		direccion_fiscal: cleanOrNull(input.direccion_fiscal),
	};

	return {
		commandName: "clientes_update_cliente",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					...guardaDelEmail(cloudPayload.email, cloudPayload.id_cliente),
					{
						kind: "execute",
						sql: `
							UPDATE Clientes
							SET
								Nombre = ?1,
								Telefono = ?2,
								Email = ?3,
								Notas = ?4,
								NIF = ?5,
								Razon_Social = ?6,
								Direccion_Fiscal = ?7
							WHERE ID_Cliente = ?8;
						`,
						args: [
							cloudPayload.nombre,
							cloudPayload.telefono,
							cloudPayload.email,
							cloudPayload.notas,
							cloudPayload.nif,
							cloudPayload.razon_social,
							cloudPayload.direccion_fiscal,
							cloudPayload.id_cliente,
						],
					},
				],
			},
		},
		cloudPayload,
	};
}
