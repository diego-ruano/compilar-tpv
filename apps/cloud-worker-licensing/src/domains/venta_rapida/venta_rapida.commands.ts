// src/domains/venta_rapida/venta_rapida.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type { CobroPlan, RestarStockPlan } from "./venta_rapida.queries";
import type {
	AddLineaInput,
	CobrarFraccionadoInput,
	CreateComandaBarraInput,
	DeleteLineaInput,
	RemoveLastLineaInput,
	RestarStockInput,
	UpdateNotaInput,
} from "./venta_rapida.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_ZONA = { $ref: "id_zona" } as const;
const REF_ID_MESA_BARRA = { $ref: "id_mesa_barra" } as const;
const REF_ID_COMANDA = { $ref: "id_comanda" } as const;
const REF_ID_DETALLE = { $ref: "id_detalle" } as const;

const UPDATE_TOTAL = `
	UPDATE Comandas
	SET Total_Comanda = (
		SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
		FROM Detalle_Comanda
		WHERE ID_Comanda = ?1
	)
	WHERE ID_Comanda = ?1;
`;

function ensureBarraSteps() {
	return [
		{
			kind: "execute",
			sql: `
				INSERT OR IGNORE INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
				VALUES ('Salon', '[]', datetime('now','localtime'));
			`,
		},
		{
			kind: "value",
			saveAs: "id_zona",
			sql: "SELECT ID_Zona FROM Zonas ORDER BY ID_Zona ASC LIMIT 1;",
		},
		{
			kind: "execute",
			sql: `
				INSERT OR IGNORE INTO Mesas (
					ID_Zona,
					Numero_Mesa,
					Capacidad,
					Ubicacion_X,
					Ubicacion_Y,
					Shape,
					Width,
					Height,
					Radius,
					Updated_At,
					Es_Sistema
				)
				VALUES (?1, 'BARRA', 0, 0, 0, 'rect', 80, 50, NULL, datetime('now','localtime'), 1);
			`,
			args: [REF_ID_ZONA],
		},
		{
			kind: "value",
			saveAs: "id_mesa_barra",
			sql: "SELECT ID_Mesa FROM Mesas WHERE Numero_Mesa = 'BARRA' ORDER BY ID_Mesa ASC LIMIT 1;",
		},
	];
}

export function createComandaBarra(
	input: CreateComandaBarraInput,
	idTrabajadorReal: number | null,
): BuiltCommand {
	const steps: any[] = [
		...ensureBarraSteps(),
		{
			kind: "value",
			saveAs: "id_comanda",
			sql: "SELECT COALESCE(MAX(ID_Comanda), 0) + 1 FROM Comandas;",
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Comandas (
					ID_Comanda,
					Fecha_Hora_Apertura,
					Estado,
					Total_Comanda,
					ID_Trabajador,
					ID_Mesa
				)
				VALUES (?1, datetime('now','localtime'), 'Abierta', 0, ?2, ?3)
				ON CONFLICT(ID_Comanda) DO UPDATE SET
					Estado = excluded.Estado,
					Total_Comanda = COALESCE(Comandas.Total_Comanda, excluded.Total_Comanda),
					ID_Trabajador = excluded.ID_Trabajador,
					ID_Mesa = excluded.ID_Mesa;
			`,
			args: [REF_ID_COMANDA, idTrabajadorReal, REF_ID_MESA_BARRA],
		},
		{
			kind: "execute",
			sql: `
				DELETE FROM Comandas
				WHERE ID_Mesa = ?1
					AND ID_Comanda <> ?2
					AND COALESCE(Total_Comanda,0) <= 0
					AND NOT EXISTS (
						SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = Comandas.ID_Comanda
					)
					AND NOT EXISTS (
						SELECT 1 FROM Pagos p WHERE p.ID_Comanda = Comandas.ID_Comanda
					);
			`,
			args: [REF_ID_MESA_BARRA, REF_ID_COMANDA],
		},
	];

	return {
		commandName: "vr_create_comanda_barra",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "id_comanda" },
		},
		cloudPayload: { ...input, id_trabajador_real: idTrabajadorReal },
	};
}

export function addLinea(input: AddLineaInput): BuiltCommand {
	return {
		commandName: "vr_add_linea_comanda",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "value",
						saveAs: "id_detalle",
						sql: "SELECT COALESCE(MAX(ID_Detalle), 0) + 1 FROM Detalle_Comanda;",
					},
					{
						kind: "execute",
						sql: `
							INSERT INTO Detalle_Comanda (
								ID_Detalle,
								ID_Comanda,
								ID_Producto,
								Cantidad,
								Precio_Unitario,
								Notas,
								Estado_Cocina
							)
							VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'PENDIENTE')
							ON CONFLICT(ID_Detalle) DO UPDATE SET
								ID_Comanda = excluded.ID_Comanda,
								ID_Producto = excluded.ID_Producto,
								Cantidad = excluded.Cantidad,
								Precio_Unitario = excluded.Precio_Unitario,
								Estado_Cocina = COALESCE(Detalle_Comanda.Estado_Cocina, excluded.Estado_Cocina);
						`,
						args: [
							REF_ID_DETALLE,
							input.id_comanda,
							input.id_producto,
							input.cantidad,
							input.precio_unitario,
						],
					},
					{
						kind: "execute",
						sql: UPDATE_TOTAL,
						args: [input.id_comanda],
					},
				],
				resultKey: "id_detalle",
			},
		},
		cloudPayload: input,
	};
}

export function removeLastUnpaidLinea(input: RemoveLastLineaInput): BuiltCommand {
	return {
		commandName: "vr_remove_last_unpaid_linea",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: `
							DELETE FROM Detalle_Comanda
							WHERE ID_Detalle = (
								SELECT dc.ID_Detalle
								FROM Detalle_Comanda dc
								LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
								WHERE dc.ID_Comanda = ?1
									AND dc.ID_Producto = ?2
									AND pd.ID_Detalle IS NULL
								ORDER BY dc.ID_Detalle DESC
								LIMIT 1
							);
						`,
						args: [input.id_comanda, input.id_producto],
					},
					{ kind: "execute", sql: UPDATE_TOTAL, args: [input.id_comanda] },
				],
			},
		},
		cloudPayload: input,
	};
}

export function deleteLineaIfUnpaid(input: DeleteLineaInput): BuiltCommand {
	return {
		commandName: "vr_delete_linea_if_unpaid",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: `
							DELETE FROM Detalle_Comanda
							WHERE ID_Detalle = ?1
								AND ID_Comanda = ?2
								AND NOT EXISTS (
									SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = ?1
								);
						`,
						args: [input.id_detalle, input.id_comanda],
					},
					{ kind: "execute", sql: UPDATE_TOTAL, args: [input.id_comanda] },
				],
			},
		},
		cloudPayload: input,
	};
}

export function updateNotaDetalle(input: UpdateNotaInput): BuiltCommand {
	return {
		commandName: "vr_update_nota_detalle",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: "UPDATE Detalle_Comanda SET Notas = ?2 WHERE ID_Detalle = ?1;",
				args: [input.id_detalle, input.nota],
			},
		},
		cloudPayload: input,
	};
}

export function cobrarFraccionado(
	input: CobrarFraccionadoInput,
	plan: Extract<CobroPlan, { ok: true }>,
): BuiltCommand {
	const steps: any[] = [];
	if (plan.id_trabajador_cobrador) {
		steps.push({
			kind: "execute",
			sql: `
				UPDATE Comandas
				SET ID_Trabajador = ?2
				WHERE ID_Comanda = ?1
					AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
			`,
			args: [input.id_comanda, plan.id_trabajador_cobrador],
		});
	}

	steps.push({
		kind: "execute",
		sql: `
			INSERT INTO Pagos (
				ID_Pago,
				ID_Comanda,
				Fecha_Hora,
				Metodo_Pago,
				Importe_Total,
				Tipo,
				ID_Usuario_Cobrador,
				ID_Trabajador_Cobrador
			)
			VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, 'FRACCIONADO', ?5, ?6)
			ON CONFLICT(ID_Pago) DO UPDATE SET
				ID_Comanda = excluded.ID_Comanda,
				Metodo_Pago = excluded.Metodo_Pago,
				Importe_Total = excluded.Importe_Total,
				Tipo = excluded.Tipo,
				ID_Usuario_Cobrador = excluded.ID_Usuario_Cobrador,
				ID_Trabajador_Cobrador = excluded.ID_Trabajador_Cobrador;
		`,
		args: [
			plan.id_pago,
			input.id_comanda,
			input.metodo,
			plan.importe_total,
			plan.id_usuario_cobrador,
			plan.id_trabajador_cobrador,
		],
	});

	for (const det of input.detalles) {
		steps.push({
			kind: "execute",
			sql: `
				INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
				SELECT ?1, dc.ID_Detalle
				FROM Detalle_Comanda dc
				WHERE dc.ID_Comanda = ?2
					AND dc.ID_Detalle = ?3
					AND NOT EXISTS (
						SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
					);
			`,
			args: [plan.id_pago, input.id_comanda, det],
		});
	}

	for (const a of plan.allocations) {
		steps.push({
			kind: "execute",
			sql: `
				UPDATE Lotes_Producto
				SET Stock_Disponible = COALESCE(Stock_Disponible,0) - ?2
				WHERE ID_Lote = ?1;
			`,
			args: [a.id_lote, a.take],
		});
		if (a.id_detalle) {
			steps.push({
				kind: "execute",
				sql: `
					INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, Cantidad)
					VALUES (?1, ?2, ?3)
					ON CONFLICT(ID_Detalle, ID_Lote) DO NOTHING;
				`,
				args: [a.id_detalle, a.id_lote, a.take],
			});
		}
	}

	steps.push({ kind: "execute", sql: UPDATE_TOTAL, args: [input.id_comanda] });
	steps.push({
		kind: "execute",
		sql: `
			UPDATE Comandas
			SET
				Estado = 'Pagada',
				Total_Comanda = (
					SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
					FROM Detalle_Comanda
					WHERE ID_Comanda = ?1
				),
				Fecha_Hora_Cierre = datetime('now','localtime')
			WHERE ID_Comanda = ?1
				AND NOT EXISTS (
					SELECT 1
					FROM Detalle_Comanda dc
					LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
					WHERE dc.ID_Comanda = ?1
						AND pd.ID_Detalle IS NULL
				);
		`,
		args: [input.id_comanda],
	});

	return {
		commandName: "vr_cobrar_fraccionado",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { ...input, plan },
	};
}

export function restarStock(
	input: RestarStockInput,
	plan: Extract<RestarStockPlan, { ok: true }>,
): BuiltCommand {
	const steps = plan.allocations.length
		? plan.allocations.map((a) => ({
				kind: "execute",
				sql: `
					UPDATE Lotes_Producto
					SET Stock_Disponible = CASE
						WHEN COALESCE(Stock_Disponible,0) - ?2 < 0 THEN 0
						ELSE COALESCE(Stock_Disponible,0) - ?2
					END
					WHERE ID_Lote = ?1;
				`,
				args: [a.id_lote, a.take],
			}))
		: [{ kind: "value", saveAs: "ok", sql: "SELECT 1;" }];
	return {
		commandName: "vr_restar_stock",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps,
			},
		},
		cloudPayload: { ...input, plan },
	};
}

export function deleteComandaIfSafe(idComanda: number): BuiltCommand {
	return {
		commandName: "vr_delete_comanda_if_safe",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: "DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
						args: [idComanda],
					},
					{
						kind: "execute",
						saveAs: "deleted",
						sql: "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
						args: [idComanda],
					},
				],
				resultKey: "deleted",
			},
		},
		cloudPayload: { id_comanda: idComanda },
	};
}
