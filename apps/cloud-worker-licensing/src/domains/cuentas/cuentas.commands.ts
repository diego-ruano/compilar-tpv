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

/// Normaliza el método de pago a "Tarjeta" o "Efectivo" (paridad con `tpv_domain::pago`, CUENTA-03).
function normalizeMetodo(input: string): string {
	return input.trim().toLowerCase() === "tarjeta" ? "Tarjeta" : "Efectivo";
}

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

// Actualiza sólo método y fecha; el Importe_Total se **recalcula** desde los Pago_Detalles
// cobrados (CUENTA-02), no se toma del input. Paridad con `SqliteCuentasRepository::actualizar_pago`.
export function updatePago(idPago: string, input: UpdatePagoInput): BuiltCommand {
	const cloudPayload = { id_pago: idPago, ...input };
	return {
		commandName: "cuentas_update_pago",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Pagos
					SET Fecha_Hora = ?2,
					    Metodo_Pago = ?3,
					    Importe_Total = (
					      SELECT IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0)
					      FROM Pago_Detalles pd
					      JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle
					      WHERE pd.ID_Pago = ?1
					    )
					WHERE ID_Pago = ?1;
				`,
				args: [idPago, input.fecha_hora, normalizeMetodo(input.metodo)],
			},
		},
		cloudPayload,
	};
}

// Borra un pago revirtiendo por completo el cobro (CUENTA-01): devuelve stock (Lote_Consumos),
// resta el gasto del cliente y reabre la comanda si quedan detalles pendientes. Paridad con
// `SqliteCuentasRepository::eliminar_pago`. Todo en una transacción del DO.
export function deletePago(idPago: string): BuiltCommand {
	const steps = [
		// 1) Devolver el stock consumido por los detalles del pago y borrar esos Lote_Consumos.
		{
			kind: "execute",
			sql: `
				UPDATE Lotes_Producto
				SET Stock_Disponible = COALESCE(Stock_Disponible,0) + (
				    SELECT IFNULL(SUM(lc.Cantidad),0)
				    FROM Lote_Consumos lc
				    JOIN Pago_Detalles pd ON pd.ID_Detalle = lc.ID_Detalle
				    WHERE pd.ID_Pago = ?1 AND lc.ID_Lote = Lotes_Producto.ID_Lote
				)
				WHERE ID_Lote IN (
				    SELECT lc.ID_Lote
				    FROM Lote_Consumos lc
				    JOIN Pago_Detalles pd ON pd.ID_Detalle = lc.ID_Detalle
				    WHERE pd.ID_Pago = ?1
				);
			`,
			args: [idPago],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Lote_Consumos WHERE ID_Detalle IN (SELECT ID_Detalle FROM Pago_Detalles WHERE ID_Pago = ?1);",
			args: [idPago],
		},
		// 2) Restar el gasto del cliente ligado a la comanda del pago (sin bajar de 0).
		{
			kind: "execute",
			sql: `
				UPDATE Clientes
				SET Total_Gastado = MAX(0, COALESCE(Total_Gastado,0) - (
				    SELECT IFNULL(p.Importe_Total,0) FROM Pagos p WHERE p.ID_Pago = ?1
				))
				WHERE ID_Cliente = (
				    SELECT r.ID_Cliente
				    FROM Pagos p
				    JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
				    JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
				    WHERE p.ID_Pago = ?1
				);
			`,
			args: [idPago],
		},
		// 4) Liberar los detalles del pago (deben quedar sin Pago_Detalle para contar como pendientes).
		{
			kind: "execute",
			sql: "DELETE FROM Pago_Detalles WHERE ID_Pago = ?1;",
			args: [idPago],
		},
		// 5) Reabrir la comanda si tras liberar sus detalles quedan líneas pendientes de pago.
		//    Se ejecuta con `Pagos` aún presente (para resolver la comanda) pero con los
		//    Pago_Detalles ya borrados (para que los detalles liberados cuenten como pendientes).
		{
			kind: "execute",
			sql: `
				UPDATE Comandas
				SET Estado = CASE
				      WHEN EXISTS (
				        SELECT 1 FROM Detalle_Comanda dc
				        LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				        WHERE dc.ID_Comanda = Comandas.ID_Comanda AND pd.ID_Detalle IS NULL
				      ) THEN 'Abierta' ELSE Estado END,
				    Fecha_Hora_Cierre = CASE
				      WHEN EXISTS (
				        SELECT 1 FROM Detalle_Comanda dc
				        LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
				        WHERE dc.ID_Comanda = Comandas.ID_Comanda AND pd.ID_Detalle IS NULL
				      ) THEN NULL ELSE Fecha_Hora_Cierre END,
				    Total_Comanda = (
				        SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
				        FROM Detalle_Comanda WHERE ID_Comanda = Comandas.ID_Comanda
				    )
				WHERE ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1);
			`,
			args: [idPago],
		},
		// 6) Borrar el pago.
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
