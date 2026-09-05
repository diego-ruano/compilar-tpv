// src/domains/cuentas/cuentas.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type {
	AnularPagoInput,
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
		// Los dos ids se generan ANTES de sus INSERT, nunca dentro del SQL: una `TEXT PRIMARY KEY`
		// calculada en la sentencia se re-evaluaría al replicar (CLAUDE.md §9).
		{ kind: "value", saveAs: "mov", sql: "SELECT ?1;", args: [crypto.randomUUID()] },
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
		// Su fila en el historial de caja (CUENTA-07). Paridad con
		// `SqliteCuentasRepository::crear_gasto`: una salida de dinero es un movimiento como lo es
		// un cobro. `ID_Usuario` va nulo porque aquí no hay sesión de usuario —solo tenant y
		// dispositivo—; en la Main lo pone el backend.
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Caja (
				  ID_Movimiento, Fecha_Hora, Tipo, ID_Gasto, Importe, Motivo
				)
				VALUES (?1, datetime('now','localtime'), 'GASTO', ?2, ABS(?3), ?4);
			`,
			args: [{ $ref: "mov" }, REF_ID, cloudPayload.importe, cloudPayload.concepto],
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
	const steps = [
		{ kind: "value", saveAs: "mov", sql: "SELECT ?1;", args: [crypto.randomUUID()] },
		// El movimiento se anota ANTES del borrado: después la fila ya no está y el historial se
		// quedaría con un importe de 0, que no dice nada de lo que se deshizo.
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Caja (
				  ID_Movimiento, Fecha_Hora, Tipo, ID_Gasto, Importe, Motivo
				)
				SELECT ?2, datetime('now','localtime'), 'GASTO_ANULADO', g.ID_Gasto,
				       ABS(IFNULL(g.Importe,0)), NULLIF(COALESCE(g.Concepto,''),'')
				FROM Cuentas_Gastos g
				WHERE g.ID_Gasto = ?1;
			`,
			args: [idGasto, { $ref: "mov" }],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
			args: [idGasto],
		},
	];
	return {
		commandName: "cuentas_delete_gasto",
		command: { type: "tenantDb.transaction", payload: { steps } },
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

// Anula un pago SIN borrarlo (CUENTA-07): devuelve el stock (por lote y suelto), resta el gasto
// del cliente, marca la fila de `Pagos` y deja el movimiento en `Movimientos_Caja`. Las líneas y
// sus `Pago_Detalles` se **conservan** (Opción A): son lo que permite reimprimir el ticket anulado,
// y lo que devuelve las consumiciones a la mesa como pendientes — «cobrada» pasa a leerse por la
// vista `v_lineas_cobradas`, que sólo mira pagos activos. Paridad con
// `SqliteCuentasRepository::anular_pago`. Todo en una transacción del DO.
export function anularPago(idPago: string, input: AnularPagoInput): BuiltCommand {
	const motivo = (input.motivo ?? "").trim();
	const idUsuario = input.id_usuario;
	const steps = [
		// El id del movimiento de caja se genera ANTES del INSERT, nunca dentro de la sentencia:
		// una TEXT PRIMARY KEY calculada en SQL se re-evaluaría al replicar y la nube y la Main
		// acabarían con dos filas distintas para el mismo hecho.
		idStep(null),
		// 1) Devolver el stock consumido por los detalles del pago. La traza (`Lote_Consumos`) se
		//    CONSERVA: ya no es ella la que impide el doble abono, sino el `Estado` del pago.
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
				)
				  AND (SELECT COALESCE(Estado,'ACTIVO') FROM Pagos WHERE ID_Pago = ?1) = 'ACTIVO';
			`,
			args: [idPago],
		},
		// 1-bis) Y el stock SUELTO que consumió el pago (lo que los lotes no cubrieron, VR-04).
		{
			kind: "execute",
			sql: `
				UPDATE Productos
				SET Stock_Suelto = COALESCE(Stock_Suelto,0) + (
				    SELECT IFNULL(SUM(sc.Cantidad),0)
				    FROM Suelto_Consumos sc
				    JOIN Pago_Detalles pd ON pd.ID_Detalle = sc.ID_Detalle
				    WHERE pd.ID_Pago = ?1 AND sc.ID_Producto = Productos.ID_Producto
				)
				WHERE ID_Producto IN (
				    SELECT sc.ID_Producto
				    FROM Suelto_Consumos sc
				    JOIN Pago_Detalles pd ON pd.ID_Detalle = sc.ID_Detalle
				    WHERE pd.ID_Pago = ?1
				)
				  AND (SELECT COALESCE(Estado,'ACTIVO') FROM Pagos WHERE ID_Pago = ?1) = 'ACTIVO';
			`,
			args: [idPago],
		},
		// 2) Restar el gasto del cliente ligado a la comanda del pago (sin bajar de 0).
		{
			kind: "execute",
			sql: `
				UPDATE Clientes
				SET Total_Gastado = MAX(0, COALESCE(Total_Gastado,0) - (
				    SELECT ROUND(IFNULL(p.Importe_Total,0), 2) FROM Pagos p WHERE p.ID_Pago = ?1
				))
				WHERE ID_Cliente = (
				    SELECT r.ID_Cliente
				    FROM Pagos p
				    JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
				    JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
				    WHERE p.ID_Pago = ?1
				      AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
				);
			`,
			args: [idPago],
		},
		// 3) El movimiento en el historial de caja. Va ANTES de marcar el pago porque lee su
		//    importe y su método de la fila todavía activa.
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Caja (
				  ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, ID_Usuario, Importe, Metodo_Pago, Motivo
				)
				SELECT ?2, datetime('now','localtime'), 'ANULACION', p.ID_Pago, ?3,
				       ABS(ROUND(IFNULL(p.Importe_Total,0), 2)), NULLIF(COALESCE(p.Metodo_Pago,''),''), ?4
				FROM Pagos p
				WHERE p.ID_Pago = ?1 AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO';
			`,
			args: [idPago, REF_ID, idUsuario, motivo],
		},
		// 4) Marcar el pago. El `Estado <> 'ANULADO'` deja el UPDATE idempotente, y es el guardia
		//    que impide abonar el stock dos veces.
		{
			kind: "execute",
			sql: `
				UPDATE Pagos
				SET Estado = 'ANULADO',
				    Anulado_En = datetime('now','localtime'),
				    Anulado_Por = ?2,
				    Motivo_Anulacion = ?3
				WHERE ID_Pago = ?1 AND COALESCE(Estado,'ACTIVO') <> 'ANULADO';
			`,
			args: [idPago, idUsuario, motivo],
		},
		// 5) Recalcular la comanda. Sus líneas vuelven a estar pendientes —el pago que las cubría
		//    ya no está activo—, así que se reabre si no hay otra comanda abierta para la mesa.
		{
			kind: "execute",
			sql: `
				UPDATE Comandas
				SET Estado = CASE
				      WHEN ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1)
				       AND EXISTS (
				        SELECT 1 FROM Detalle_Comanda dc
				        LEFT JOIN v_lineas_cobradas pd ON pd.ID_Detalle = dc.ID_Detalle
				        WHERE dc.ID_Comanda = Comandas.ID_Comanda AND pd.ID_Detalle IS NULL
				      )
				       AND NOT EXISTS (
				        SELECT 1 FROM Comandas abierta
				        WHERE abierta.ID_Mesa = Comandas.ID_Mesa
				          AND abierta.Estado = 'Abierta'
				          AND abierta.ID_Comanda <> Comandas.ID_Comanda
				      )
				      THEN 'Abierta' ELSE Estado END,
				    Fecha_Hora_Cierre = CASE
				      WHEN ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1)
				       AND EXISTS (
				        SELECT 1 FROM Detalle_Comanda dc
				        LEFT JOIN v_lineas_cobradas pd ON pd.ID_Detalle = dc.ID_Detalle
				        WHERE dc.ID_Comanda = Comandas.ID_Comanda AND pd.ID_Detalle IS NULL
				      )
				       AND NOT EXISTS (
				        SELECT 1 FROM Comandas abierta
				        WHERE abierta.ID_Mesa = Comandas.ID_Mesa
				          AND abierta.Estado = 'Abierta'
				          AND abierta.ID_Comanda <> Comandas.ID_Comanda
				      )
				      THEN NULL ELSE Fecha_Hora_Cierre END,
				    Total_Comanda = (
				        SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
				        FROM Detalle_Comanda WHERE ID_Comanda = Comandas.ID_Comanda
				    )
				WHERE ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1);
			`,
			args: [idPago],
		},
	];
	return {
		commandName: "cuentas_anular_pago",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_pago: idPago, id_usuario: idUsuario, motivo },
	};
}
