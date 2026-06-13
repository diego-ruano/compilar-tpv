// src/domains/mesas/mesas.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type { CobroDetallesPlan } from "./mesas.queries";
import type {
	AbrirComandaInput,
	AddLineaInput,
	CobrarDetallesInput,
	SaveLayoutInput,
	SetTrabajadorInput,
} from "./mesas.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_COMANDA = { $ref: "id_comanda" } as const;
const REF_ID_PAGO = { $ref: "id_pago" } as const;

const UPDATE_TOTAL = `
	UPDATE Comandas
	SET Total_Comanda = (
		SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
		FROM Detalle_Comanda
		WHERE ID_Comanda = ?1
	)
	WHERE ID_Comanda = ?1;
`;

function parseDbId(raw: string, prefix: string): number | null {
	const m = String(raw || "").match(new RegExp(`^${prefix}(\\d+)$`));
	const n = m ? Number(m[1]) : 0;
	return Number.isInteger(n) && n > 0 ? n : null;
}

export function saveLayout(input: SaveLayoutInput): BuiltCommand {
	const steps: any[] = [];

	for (const z of input.salons) {
		const idZona = parseDbId(z.id, "db-zona-");
		const points = JSON.stringify(z.room.points ?? []);
		if (idZona) {
			steps.push({
				kind: "execute",
				sql: `
					INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At)
					VALUES (?1, ?2, ?3, datetime('now','localtime'))
					ON CONFLICT(ID_Zona) DO UPDATE SET
						Nombre_Zona = excluded.Nombre_Zona,
						Room_Points = excluded.Room_Points,
						Updated_At = excluded.Updated_At;
				`,
				args: [idZona, z.name, points],
			});
		} else {
			steps.push({
				kind: "execute",
				sql: `
					INSERT INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
					VALUES (?1, ?2, datetime('now','localtime'))
					ON CONFLICT(Nombre_Zona) DO UPDATE SET
						Room_Points = excluded.Room_Points,
						Updated_At = excluded.Updated_At;
				`,
				args: [z.name, points],
			});
		}

		const kept = z.tables
			.map((t) => parseDbId(t.id, "db-mesa-"))
			.filter((n): n is number => !!n);
		const keptClause = kept.length
			? `AND ID_Mesa NOT IN (${kept.map((_, i) => `?${i + 3}`).join(",")})`
			: "";
		steps.push({
			kind: "execute",
			sql: `
				DELETE FROM Mesas
				WHERE ID_Zona = COALESCE(?1, (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?2 LIMIT 1))
					AND Es_Sistema = 0
					${keptClause}
					AND NOT EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa)
					AND NOT EXISTS (SELECT 1 FROM Reservas R WHERE R.ID_Mesa = Mesas.ID_Mesa);
			`,
			args: [idZona, z.name, ...kept],
		});

		for (const t of z.tables) {
			const idMesa = parseDbId(t.id, "db-mesa-");
			const shape = t.shape?.trim() || "rounded";
			const width = t.width > 0 ? t.width : 120;
			const height = t.height > 0 ? t.height : 70;
			const seats = t.seats > 0 ? t.seats : 4;
			if (idMesa) {
				steps.push({
					kind: "execute",
					sql: `
						UPDATE Mesas
						SET
							ID_Zona = COALESCE(?1, (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?2 LIMIT 1)),
							Numero_Mesa = ?3,
							Capacidad = ?4,
							Ubicacion_X = ?5,
							Ubicacion_Y = ?6,
							Shape = ?7,
							Width = ?8,
							Height = ?9,
							Radius = ?10,
							Updated_At = datetime('now','localtime')
						WHERE ID_Mesa = ?11;
					`,
					args: [
						idZona,
						z.name,
						t.name,
						seats,
						t.x,
						t.y,
						shape,
						width,
						height,
						t.radius ?? null,
						idMesa,
					],
				});
			} else {
				steps.push({
					kind: "execute",
					sql: `
						INSERT INTO Mesas (
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
						SELECT
							COALESCE(?1, (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?2 LIMIT 1)),
							?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
							datetime('now','localtime'),
							0
						ON CONFLICT(ID_Zona, Numero_Mesa) DO UPDATE SET
							Capacidad = excluded.Capacidad,
							Ubicacion_X = excluded.Ubicacion_X,
							Ubicacion_Y = excluded.Ubicacion_Y,
							Shape = excluded.Shape,
							Width = excluded.Width,
							Height = excluded.Height,
							Radius = excluded.Radius,
							Updated_At = excluded.Updated_At;
					`,
					args: [
						idZona,
						z.name,
						t.name,
						seats,
						t.x,
						t.y,
						shape,
						width,
						height,
						t.radius ?? null,
					],
				});
			}
		}
	}

	return {
		commandName: "save_layout",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: input,
	};
}

export function setReservaEstado(idReserva: string, estado: string): BuiltCommand {
	return {
		commandName: "set_reserva_estado",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: "UPDATE Reservas SET Estado = ?2 WHERE ID_Reserva = ?1;",
				args: [idReserva, estado],
			},
		},
		cloudPayload: { id_reserva: idReserva, estado },
	};
}

export function abrirComanda(
	input: AbrirComandaInput,
	idTrabajador: string | null,
	idReserva: string | null,
): BuiltCommand {
	return {
		commandName: "abrir_comanda",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "value",
						saveAs: "id_comanda",
						sql: "SELECT ?1;",
						args: [crypto.randomUUID()],
					},
					{
						kind: "execute",
						sql: `
							INSERT INTO Comandas (
								ID_Comanda,
								ID_Mesa,
								ID_Trabajador,
								ID_Reserva,
								Fecha_Hora_Apertura,
								Total_Comanda,
								Estado
							)
							VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'), 0, 'Abierta');
						`,
						args: [REF_ID_COMANDA, input.id_mesa, idTrabajador, idReserva],
					},
					{
						kind: "row",
						saveAs: "comanda",
						sql: `
							SELECT
								ID_Comanda AS id_comanda,
								ID_Mesa AS id_mesa,
								ID_Trabajador AS id_trabajador,
								ID_Reserva AS id_reserva,
								Fecha_Hora_Apertura AS fecha_hora_apertura,
								Fecha_Hora_Cierre AS fecha_hora_cierre,
								COALESCE(Total_Comanda,0) AS total_comanda,
								COALESCE(Estado,'Abierta') AS estado
							FROM Comandas
							WHERE ID_Comanda = ?1
							LIMIT 1;
						`,
						args: [REF_ID_COMANDA],
					},
				],
				resultKey: "comanda",
			},
		},
		cloudPayload: { ...input, id_trabajador: idTrabajador, id_reserva: idReserva },
	};
}

export function setTrabajadorIfNull(
	input: SetTrabajadorInput,
	idTrabajador: string | null,
): BuiltCommand {
	return {
		commandName: "comanda_set_trabajador_if_null",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Comandas
					SET ID_Trabajador = ?2
					WHERE ID_Comanda = ?1
						AND Estado = 'Abierta'
						AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0)
						AND NOT EXISTS (
							SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = ?1
						);
				`,
				args: [input.id_comanda, idTrabajador],
			},
		},
		cloudPayload: { ...input, id_trabajador: idTrabajador },
	};
}

export function cerrarComanda(idComanda: string, total: number): BuiltCommand {
	return {
		commandName: "cerrar_comanda",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Comandas
					SET Estado = 'Pagada',
						Total_Comanda = ?2,
						Fecha_Hora_Cierre = datetime('now','localtime')
					WHERE ID_Comanda = ?1;
				`,
				args: [idComanda, total],
			},
		},
		cloudPayload: { id_comanda: idComanda, total },
	};
}

export function addLinea(
	input: AddLineaInput,
	idTrabajador: string | null,
	pasaCocina: boolean,
): BuiltCommand {
	const steps: any[] = [];
	if (idTrabajador) {
		steps.push({
			kind: "execute",
			sql: `
				UPDATE Comandas
				SET ID_Trabajador = ?2
				WHERE ID_Comanda = ?1
					AND Estado = 'Abierta'
					AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
			`,
			args: [input.id_comanda, idTrabajador],
		});
	}
	steps.push({
		kind: "execute",
		sql: `
			INSERT INTO Detalle_Comanda (
				ID_Comanda,
				ID_Producto,
				Cantidad,
				Precio_Unitario,
				Estado_Cocina
			)
			VALUES (?1, ?2, ?3, ?4, ?5);
		`,
		args: [
			input.id_comanda,
			input.id_producto,
			input.cantidad,
			input.precio,
			pasaCocina ? "PENDIENTE" : null,
		],
	});
	steps.push({ kind: "execute", sql: UPDATE_TOTAL, args: [input.id_comanda] });

	return {
		commandName: "add_linea_comanda",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { ...input, id_trabajador: idTrabajador, pasa_cocina: pasaCocina },
	};
}

export function removeOnePendingDetalle(idComanda: string, idProducto: string): BuiltCommand {
	return {
		commandName: "remove_one_pending_detalle",
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
								WHERE dc.ID_Comanda = ?1
									AND dc.ID_Producto = ?2
									AND NOT EXISTS (
										SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
									)
								ORDER BY dc.ID_Detalle DESC LIMIT 1
							);
						`,
						args: [idComanda, idProducto],
					},
					{ kind: "execute", sql: UPDATE_TOTAL, args: [idComanda] },
				],
			},
		},
		cloudPayload: { id_comanda: idComanda, id_producto: idProducto },
	};
}

export function deleteDetalle(idDetalle: string, idComanda: string | null): BuiltCommand {
	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				DELETE FROM Detalle_Comanda
				WHERE ID_Detalle = ?1
					AND NOT EXISTS (
						SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
					);
			`,
			args: [idDetalle],
		},
	];
	if (idComanda) steps.push({ kind: "execute", sql: UPDATE_TOTAL, args: [idComanda] });
	return {
		commandName: "delete_detalle",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_detalle: idDetalle, id_comanda: idComanda },
	};
}

export function updateDetalleNota(idDetalle: string, nota: string | null): BuiltCommand {
	return {
		commandName: "update_detalle_nota",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Detalle_Comanda
					SET Notas = ?2
					WHERE ID_Detalle = ?1
						AND NOT EXISTS (
							SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
						);
				`,
				args: [idDetalle, nota],
			},
		},
		cloudPayload: { id_detalle: idDetalle, nota },
	};
}

export function cobrarDetalles(
	input: CobrarDetallesInput,
	plan: Extract<CobroDetallesPlan, { ok: true }>,
): BuiltCommand {
	const placeholders = input.detalle_ids.map((_, i) => `?${i + 3}`).join(",");
	return {
		commandName: "cobrar_detalles",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "value",
						saveAs: "id_pago",
						sql: "SELECT ?1;",
						args: [crypto.randomUUID()],
					},
					{
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
							VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, ?5, ?6, ?7);
						`,
						args: [
							REF_ID_PAGO,
							input.id_comanda,
							input.metodo,
							plan.total,
							input.tipo,
							input.id_usuario,
							plan.id_trabajador,
						],
					},
					{
						kind: "execute",
						sql: `
							UPDATE Clientes
							SET Total_Gastado = COALESCE(Total_Gastado,0) + ?2
							WHERE ID_Cliente = (
								SELECT r.ID_Cliente
								FROM Comandas c
								JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
								WHERE c.ID_Comanda = ?1
								LIMIT 1
							);
						`,
						args: [input.id_comanda, plan.total],
					},
					{
						kind: "execute",
						sql: `
							INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
							SELECT ?1, dc.ID_Detalle
							FROM Detalle_Comanda dc
							WHERE dc.ID_Comanda = ?2
								AND dc.ID_Detalle IN (${placeholders})
								AND NOT EXISTS (
									SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
								);
						`,
						args: [REF_ID_PAGO, input.id_comanda, ...input.detalle_ids],
					},
					{
						kind: "execute",
						sql: `
							UPDATE Comandas
							SET
								Estado = 'Pagada',
								Total_Comanda = (
									SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
									FROM Detalle_Comanda WHERE ID_Comanda = ?1
								),
								Fecha_Hora_Cierre = datetime('now','localtime')
							WHERE ID_Comanda = ?1
								AND NOT EXISTS (
									SELECT 1
									FROM Detalle_Comanda dc
									LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
									WHERE dc.ID_Comanda = ?1 AND pd.ID_Detalle IS NULL
								);
						`,
						args: [input.id_comanda],
					},
					{ kind: "execute", sql: UPDATE_TOTAL, args: [input.id_comanda] },
				],
			},
		},
		cloudPayload: { ...input, plan },
	};
}

export function kitchenSetLineState(
	idDetalle: string,
	idUsuarioCocinero: string,
	estado: string,
): BuiltCommand {
	return {
		commandName: "kitchen_set_line_state",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql:
					estado === "PREPARADO"
						? `
							UPDATE Detalle_Comanda
							SET
								Estado_Cocina = 'PREPARADO',
								ID_Usuario_Cocinero = COALESCE(ID_Usuario_Cocinero, ?2),
								Fecha_Hora_Cocina = COALESCE(Fecha_Hora_Cocina, datetime('now','localtime'))
							WHERE ID_Detalle = ?1;
						`
						: `
							UPDATE Detalle_Comanda
							SET
								Estado_Cocina = 'PENDIENTE',
								ID_Usuario_Cocinero = NULL,
								Fecha_Hora_Cocina = NULL
							WHERE ID_Detalle = ?1;
						`,
				args:
					estado === "PREPARADO"
						? [idDetalle, idUsuarioCocinero]
						: [idDetalle],
			},
		},
		cloudPayload: { id_detalle: idDetalle, id_usuario_cocinero: idUsuarioCocinero, estado },
	};
}
