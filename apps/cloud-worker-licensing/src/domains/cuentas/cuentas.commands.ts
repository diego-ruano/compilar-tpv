// src/domains/cuentas/cuentas.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type {
	CreateGastoInput,
	UpdateGastoInput,
	UpdatePagoInput,
} from "./cuentas.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID = { $ref: "id" } as const;

// UUIDv7: el id lo genera el cliente y lo envía; si faltara, generamos uno.
function idStep(provided?: string | null) {
	const id = (provided ?? "").trim() || crypto.randomUUID();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

export function createGasto(input: CreateGastoInput): BuiltCommand {
	const cloudPayload = {
		id_gasto: input.id_gasto ?? null,
		fecha: input.fecha,
		tipo_gasto: input.tipo_gasto,
		concepto: input.concepto,
		importe: input.importe,
		proveedor_id: input.proveedor_id ?? null,
	};
	const steps = [
		idStep(cloudPayload.id_gasto),
		{
			kind: "execute",
			sql: `
				INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto, ID_Proveedor)
				VALUES (?1, date(?2), ?3, ?4, ?5, ?6)
				ON CONFLICT(ID_Gasto) DO UPDATE SET
					Fecha = excluded.Fecha,
					Concepto = excluded.Concepto,
					Importe = excluded.Importe,
					Tipo_Gasto = excluded.Tipo_Gasto,
					ID_Proveedor = excluded.ID_Proveedor;
			`,
			args: [
				REF_ID,
				cloudPayload.fecha,
				cloudPayload.concepto,
				cloudPayload.importe,
				cloudPayload.tipo_gasto,
				cloudPayload.proveedor_id,
			],
		},
	];
	return {
		commandName: "cuentas_create_gasto",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload,
	};
}

export function updateGasto(idGasto: string, input: UpdateGastoInput): BuiltCommand {
	const cloudPayload = { id_gasto: idGasto, ...input };
	return {
		commandName: "cuentas_update_gasto",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Cuentas_Gastos
					SET Fecha = date(?2), Tipo_Gasto = ?3, Concepto = ?4, Importe = ?5, ID_Proveedor = ?6
					WHERE ID_Gasto = ?1;
				`,
				args: [
					idGasto,
					input.fecha,
					input.tipo_gasto,
					input.concepto,
					input.importe,
					input.proveedor_id ?? null,
				],
			},
		},
		cloudPayload,
	};
}

export function deleteGasto(idGasto: string): BuiltCommand {
	return {
		commandName: "cuentas_delete_gasto",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: "DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
				args: [idGasto],
			},
		},
		cloudPayload: { id_gasto: idGasto },
	};
}

export function updatePago(idPago: string, input: UpdatePagoInput): BuiltCommand {
	const cloudPayload = { id_pago: idPago, ...input };
	return {
		commandName: "cuentas_update_pago",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Pagos
					SET Fecha_Hora = ?2, Metodo_Pago = ?3, Importe_Total = ?4
					WHERE ID_Pago = ?1;
				`,
				args: [idPago, input.fecha_hora, input.metodo, input.importe],
			},
		},
		cloudPayload,
	};
}

export function deletePago(idPago: string): BuiltCommand {
	const steps = [
		{
			kind: "execute",
			sql: "DELETE FROM Pago_Detalles WHERE ID_Pago = ?1;",
			args: [idPago],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Pagos WHERE ID_Pago = ?1;",
			args: [idPago],
		},
	];
	return {
		commandName: "cuentas_delete_pago",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_pago: idPago },
	};
}
