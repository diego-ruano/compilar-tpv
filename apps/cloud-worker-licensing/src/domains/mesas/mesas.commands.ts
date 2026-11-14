import { zMetodoPago } from "../../lib/pago";
import { recortar } from "../../lib/texto";
// src/domains/mesas/mesas.commands.ts

import type { Dinero } from "@tpv/contracts";
import { nuevoId } from "../../lib/ids";
import { HubError } from "../../lib/errorHttp";
import type { ApplyCommand } from "../../lib/hub";
import { pasosConsumo } from "../inventario/consumo";
import { guardaComandaSinCobrar, guardaProductoEnLaCarta } from "./guardasDeLinea";
import type { CobroDetallesPlan } from "./mesas.queries";
import type {
	AbrirComandaInput,
	AddLineaInput,
	CobrarDetallesInput,
	SaveLayoutInput,
	SetReservaInput,
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
		SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
		FROM Detalle_Comanda
		WHERE ID_Comanda = ?1
	)
	WHERE ID_Comanda = ?1;
`;

function parseDbId(raw: string, prefix: string): string | null {
	const s = recortar(String(raw || ""));
	if (!s.startsWith(prefix)) return null;
	const id = recortar(s.slice(prefix.length));
	return id || null;
}

/**
 * Serializa los puntos del polígono de una zona **igual que la Main**.
 *
 * En Rust los puntos son `Vec<f64>` y `serde_json` escribe todo float con parte decimal:
 * `[10.0,20.0]`. `JSON.stringify` escribe `[10,20]`. Las dos cadenas valen lo mismo al parsearlas,
 * pero son bytes distintos en `Zonas.Room_Points`, así que la misma zona guardada desde la Main y
 * desde una Handy quedaba con un texto distinto. Lo detectó el test de contrato
 * `mesas__save_layout`; aquí se conforma el worker, que es la regla del harness (canónico = Rust,
 * el escritor único). Si algún día Rust deja de usar `serde_json` para esto, esto sobra.
 */
function puntosComoRust(points: Array<number | null> | undefined | null): string {
	const partes = (points ?? []).map((n) => {
		if (n == null || !Number.isFinite(n)) throw new HubError("validation_error", 400, { message: "El plano contiene una coordenada inválida" });
		return Number.isInteger(n) ? n.toFixed(1) : String(n);
	});
	return `[${partes.join(",")}]`;
}

/**
 * RI-54: los dos pasos que quitan del plano las mesas que cumplen `filtro`. Espejo de
 * `sql_quitar_mesas` en tpv-infra-sqlite: las que tienen historia (comandas o reservas) se ARCHIVAN
 * —desaparecen del plano y siguen en las estadísticas—, las demás se borran, y una con una comanda
 * abierta no se toca. Las condiciones van en el SQL para que la Main, al replicarlas, decida lo mismo.
 */
function pasosQuitarMesas(filtro: string, args: unknown[]): any[] {
	const historia = `(EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa)
		OR EXISTS (SELECT 1 FROM Reservas R WHERE R.ID_Mesa = Mesas.ID_Mesa))`;
	return [
		{
			kind: "execute",
			sql: `
				UPDATE Mesas SET Archivada_En = datetime('now','localtime')
				WHERE ${filtro} AND Archivada_En IS NULL AND ${historia}
					AND NOT EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa AND C.Estado = 'Abierta');
			`,
			args,
		},
		{ kind: "execute", sql: `DELETE FROM Mesas WHERE ${filtro} AND NOT ${historia};`, args },
	];
}

export function saveLayout(input: SaveLayoutInput): BuiltCommand {
	const steps: any[] = [];

	// Zonas que el editor conserva (tienen prefijo db-zona-)
	const keptZoneIds = input.salons
		.map((z) => parseDbId(z.id, "db-zona-"))
		.filter((id): id is string => !!id);

	// DO-01: las zonas conservadas van en un solo parámetro (un array JSON), no en uno por zona: estas
	// sentencias se replican y el SQLite del DO admite 100 parámetros por sentencia. Igual que la Main.
	const zoneNotInClause = keptZoneIds.length ? "AND ID_Zona NOT IN (SELECT value FROM json_each(?1))" : "";
	const keptZoneArgs = keptZoneIds.length ? [JSON.stringify(keptZoneIds)] : [];

	// RI-54: las mesas de las zonas eliminadas se archivan si tienen historia y se borran si no; una
	// con comanda abierta se queda. Luego la zona: archivada si le quedan mesas archivadas, borrada si
	// no le queda ninguna. Mismo criterio y mismas sentencias que la Main.
	steps.push(...pasosQuitarMesas(`1 = 1 ${zoneNotInClause}`, keptZoneArgs));
	steps.push({
		kind: "execute",
		sql: `
			UPDATE Zonas SET Archivada_En = datetime('now','localtime')
			WHERE 1 = 1
				${zoneNotInClause}
				AND Archivada_En IS NULL
				AND EXISTS (SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona)
				AND NOT EXISTS (
					SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona AND M.Archivada_En IS NULL
				);
		`,
		args: keptZoneArgs,
	});
	steps.push({
		kind: "execute",
		sql: `
			DELETE FROM Zonas
			WHERE 1 = 1
				${zoneNotInClause}
				AND NOT EXISTS (SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona);
		`,
		args: keptZoneArgs,
	});

	// Aparca los nombres de las zonas conservadas a un valor temporal único, para que los
	// UPDATE de nombre de abajo no choquen transitoriamente con UNIQUE(Nombre_Zona) al
	// renombrar/intercambiar zonas. Mismo criterio EXACTO que la app local (tpv-infra-sqlite).
	if (keptZoneIds.length) {
		steps.push({
			kind: "execute",
			sql: `
				UPDATE Zonas SET Nombre_Zona = '__tmp_zona_' || ID_Zona
				WHERE ID_Zona IN (SELECT value FROM json_each(?1));
			`,
			args: keptZoneArgs,
		});
	}

	for (const z of input.salons) {
		const idZona = parseDbId(z.id, "db-zona-");
		const points = puntosComoRust(z.room.points);
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
			const newZonaId = nuevoId();
			steps.push({
				kind: "execute",
				sql: `
					INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At)
					VALUES (?1, ?2, ?3, datetime('now','localtime'))
					ON CONFLICT(Nombre_Zona) WHERE Archivada_En IS NULL DO UPDATE SET
						Room_Points = excluded.Room_Points,
						Updated_At = excluded.Updated_At;
				`,
				args: [newZonaId, z.name, points],
			});
		}

		const kept = z.tables
			.map((t) => parseDbId(t.id, "db-mesa-"))
			.filter((n): n is string => !!n);
		// DO-01: las mesas conservadas, en un solo parámetro (una zona puede tener cientos).
		const keptClause = kept.length ? "AND ID_Mesa NOT IN (SELECT value FROM json_each(?3))" : "";
		steps.push(
			...pasosQuitarMesas(
				`ID_Zona = COALESCE(?1, (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?2 AND Archivada_En IS NULL LIMIT 1)) ${keptClause}`,
				kept.length ? [idZona, z.name, JSON.stringify(kept)] : [idZona, z.name],
			),
		);

		for (const t of z.tables) {
			const idMesa = parseDbId(t.id, "db-mesa-");
			const shape = recortar(t.shape ?? "") || "rounded";
			const width = t.width > 0 ? t.width : 120;
			const height = t.height > 0 ? t.height : 70;
			const seats = t.seats > 0 ? t.seats : 4;
			if (idMesa) {
				steps.push({
					kind: "execute",
					sql: `
						UPDATE Mesas
						SET
							ID_Zona = COALESCE(?1, (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?2 AND Archivada_En IS NULL LIMIT 1)),
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
				const newMesaId = nuevoId();
				steps.push({
					kind: "execute",
					sql: `
						INSERT INTO Mesas (
							ID_Mesa,
							ID_Zona,
							Numero_Mesa,
							Capacidad,
							Ubicacion_X,
							Ubicacion_Y,
							Shape,
							Width,
							Height,
							Radius,
							Updated_At
						)
						SELECT
							?11,
							COALESCE(?1, (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?2 AND Archivada_En IS NULL LIMIT 1)),
							?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
							datetime('now','localtime')
						ON CONFLICT(ID_Zona, Numero_Mesa) WHERE Archivada_En IS NULL DO UPDATE SET
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
						newMesaId,
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

/** Estados con los que la reserva deja de estar viva y hay que soltar la comanda que la apuntaba. */
const ESTADOS_QUE_CIERRAN_RESERVA = new Set(["FINALIZADA", "CANCELADA", "NO_SHOW"]);

/**
 * Marca desde la mesa que el cliente ha llegado o se ha ido. Lo decide la ruta con la reserva como
 * la lee (`cambioDesdeLaMesa`), y `desde` es el estado que leyó: la guarda exige que la reserva siga
 * así al aplicarlo, o ya como se pide (SYNC-30). Si entre la lectura y el lote la han cancelado,
 * marcado «No vino» o borrado, `reserva_cambiada`, lo mismo que si la ruta lo hubiera visto.
 */
export function setReservaEstado(idReserva: string, estado: string, desde: string): BuiltCommand {
	const steps: any[] = [
		{
			kind: "guard",
			sql: "SELECT EXISTS (SELECT 1 FROM Reservas WHERE ID_Reserva = ?1 AND Estado IN (?2, ?3));",
			args: [idReserva, desde, estado],
			error: "reserva_cambiada",
			status: 409,
		},
		{
			kind: "execute",
			sql: "UPDATE Reservas SET Estado = ?2 WHERE ID_Reserva = ?1;",
			args: [idReserva, estado],
		},
	];

	// Al cerrar la reserva se desliga la comanda que la referenciaba. Si no, la comanda sigue
	// contando como "de esa reserva" y el cliente sigue colgando de ella al cobrar. Paridad con
	// `SqliteMesasRepository::set_reserva_estado`; la condición se evalúa AQUÍ (no en el SQL) para
	// que la nube y la Main emitan exactamente las mismas sentencias.
	if (ESTADOS_QUE_CIERRAN_RESERVA.has(estado)) {
		steps.push({
			kind: "execute",
			sql: "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
			args: [idReserva],
		});
	}

	return {
		commandName: "set_reserva_estado",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_reserva: idReserva, estado },
	};
}

function stripPrefix(raw: string, prefix: string): string {
	const s = recortar(String(raw || ""));
	return s.startsWith(prefix) ? recortar(s.slice(prefix.length)) : s;
}

export function abrirComanda(
	input: AbrirComandaInput,
	idTrabajador: string | null,
	idReserva: string | null,
): BuiltCommand {
	const bareIdMesa = stripPrefix(input.id_mesa, "db-mesa-");
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
						args: [nuevoId()],
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
							SELECT ?1, ?2, ?3, ?4, datetime('now','localtime'), 0, 'Abierta'
							WHERE NOT EXISTS (
								SELECT 1 FROM Comandas WHERE ID_Mesa = ?2 AND Estado = 'Abierta'
							);
						`,
						args: [REF_ID_COMANDA, bareIdMesa, idTrabajador, idReserva],
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
							WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
							ORDER BY datetime(Fecha_Hora_Apertura) DESC
							LIMIT 1;
						`,
						args: [bareIdMesa],
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
						AND ID_Trabajador IS NULL
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

// INC-20261030-007: espejo de `comanda_set_reserva_if_null` en la Main. Sólo una comanda abierta y
// sin reserva: la de otra reserva no se pisa.
export function setReservaIfNull(input: SetReservaInput): BuiltCommand {
	return {
		commandName: "comanda_set_reserva_if_null",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Comandas
					SET ID_Reserva = ?2
					WHERE ID_Comanda = ?1
						AND Estado = 'Abierta'
						AND ID_Reserva IS NULL
						AND EXISTS (SELECT 1 FROM Reservas WHERE ID_Reserva = ?2);
				`,
				args: [input.id_comanda, input.id_reserva],
			},
		},
		cloudPayload: input,
	};
}

export function addLinea(
	input: AddLineaInput,
	estadoCocina: string | null,
	ivaPercent: number | null,
	nombreProducto: string | null,
	precio: Dinero,
): BuiltCommand {
	// SYNC-30: el producto en la carta y la comanda sin cobrar, mirados dentro del lote.
	const steps: any[] = [guardaProductoEnLaCarta(input.id_producto), guardaComandaSinCobrar(input.id_comanda)];
	// UUID generado en JS e insertado como literal: no necesita un paso `value` (SELECT ?1)
	// con su round trip — el statement capturado para la Main ya lleva el id resuelto.
	const idDetalle = nuevoId();

	// Resolución de trabajador embebida en la propia UPDATE para evitar un round-trip
	// previo a la base. El EXISTS garantiza que solo se actualiza si hay match real.
	if (input.id_trabajador_o_usuario) {
		steps.push({
			kind: "execute",
			sql: `
				UPDATE Comandas
				SET ID_Trabajador = COALESCE(
					(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Trabajador = ?2 LIMIT 1),
					(SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario = ?2 LIMIT 1)
				)
				WHERE ID_Comanda = ?1
					AND Estado = 'Abierta'
					AND ID_Trabajador IS NULL
					AND EXISTS (
						SELECT 1 FROM Trabajadores
						WHERE ID_Trabajador = ?2 OR ID_Usuario = ?2
					);
			`,
			args: [input.id_comanda, input.id_trabajador_o_usuario],
		});
	}

	// MESA-07: Estado_Cocina se resuelve como literal (?6) en el route handler; ya no
	// va una subquery embebida en el INSERT (no determinista al replicarse a la Main).
	// El tipo de IVA (?7) y el nombre (?8) viajan igual y por el mismo motivo, y se guardan EN LA
	// LÍNEA: una reimpresión tiene que enseñar lo del día de la venta, y el producto puede haberse
	// borrado del catálogo desde entonces (INV-05). El precio (?5) también sale del catálogo (RI-27).
	//
	// INC-20261030-016: sólo entra en una comanda abierta. En la nube lo decide la guarda de arriba
	// (SYNC-30); la condición es para la Main, que aplica esta sentencia con sus datos y puede tener
	// la comanda cobrada sin subir: allí no entra nada, en vez de una línea que nadie va a cobrar.
	steps.push({
		kind: "execute",
		sql: `
			INSERT INTO Detalle_Comanda (
				ID_Detalle,
				ID_Comanda,
				ID_Producto,
				Cantidad,
				Precio_Unitario,
				Estado_Cocina,
				IVA_Percent,
				Nombre_Producto
			)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
			WHERE EXISTS (SELECT 1 FROM Comandas WHERE ID_Comanda = ?2 AND Estado = 'Abierta');
		`,
		args: [
			idDetalle,
			input.id_comanda,
			input.id_producto,
			input.cantidad,
			precio,
			estadoCocina,
			ivaPercent,
			nombreProducto,
		],
	});

	steps.push({ kind: "execute", sql: UPDATE_TOTAL, args: [input.id_comanda] });

	return {
		commandName: "add_linea_comanda",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { ...input },
	};
}

// RI-59: «la última» es la de clave mayor (UUIDv7, `nuevoId`), pero antes una que cocina no haya
// preparado. Espejo de `remove_one_pending_detalle` en la Main.
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
										SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
									)
								ORDER BY (COALESCE(dc.Estado_Cocina,'PENDIENTE') = 'PREPARADO') ASC, dc.ID_Detalle DESC LIMIT 1
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
						SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
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
							SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
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
						args: [nuevoId()],
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
							zMetodoPago.parse(input.metodo),
							plan.total,
							input.tipo,
							input.id_usuario,
							plan.id_trabajador,
						],
					},
					// El cobro en el historial de caja (CUENTA-07). Paridad con
					// `SqliteMesasRepository::cobrar_detalles`. El id del movimiento se genera
					// ANTES del INSERT, como el del pago.
					{
						kind: "value",
						saveAs: "id_mov",
						sql: "SELECT ?1;",
						args: [nuevoId()],
					},
					{
						kind: "execute",
						sql: `
						INSERT INTO Movimientos_Caja (
								ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, ID_Usuario, ID_Trabajador,
								Importe, Metodo_Pago
							)
							SELECT ?1, datetime('now','localtime'), 'COBRO', ?2, ?3, ?4, ABS(?5), ?6
							WHERE NOT EXISTS (
								SELECT 1 FROM Movimientos_Caja mc
								WHERE mc.Tipo = 'COBRO' AND mc.ID_Pago = ?2
							);
						`,
						args: [
							{ $ref: "id_mov" },
							REF_ID_PAGO,
							input.id_usuario,
							plan.id_trabajador,
							plan.total,
							zMetodoPago.parse(input.metodo),
						],
					},
					// RI-61: el cliente se queda en la comanda al cobrar (el de su reserva, si aún no
					// tiene), y el gasto se le acredita a él. Espejo de `sumar_gasto_cliente_por_comanda`.
					{
						kind: "execute",
						sql: `
							UPDATE Comandas
							SET ID_Cliente = (
								SELECT r.ID_Cliente FROM Reservas r WHERE r.ID_Reserva = Comandas.ID_Reserva
							)
							WHERE ID_Comanda = ?1 AND ID_Cliente IS NULL AND ID_Reserva IS NOT NULL;
						`,
						args: [input.id_comanda],
					},
					{
						kind: "execute",
						sql: `
							UPDATE Clientes
							SET Total_Gastado = COALESCE(Total_Gastado,0) + ?2
							WHERE ID_Cliente = (
								SELECT c.ID_Cliente FROM Comandas c WHERE c.ID_Comanda = ?1
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
								AND dc.ID_Detalle IN (SELECT value FROM json_each(?3))
								AND NOT EXISTS (
									SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
								);
						`,
						// DO-01: las líneas, en un solo parámetro (un array JSON).
						args: [REF_ID_PAGO, input.id_comanda, JSON.stringify(input.detalle_ids)],
					},
					// MESA-01: descuento de stock/lotes (FEFO) de las lineas cobradas.
					// RI-10: el mismo consumo que el cobro de barra (lotes FEFO, suelto y trazas). Va
					// DESPUÉS del INSERT del pago por la FK de las trazas (STOCK-01).
					...pasosConsumo(plan.consumo, REF_ID_PAGO),
					{
						kind: "execute",
						sql: `
							UPDATE Comandas
							SET
								Estado = 'Pagada',
								Total_Comanda = (
									SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
									FROM Detalle_Comanda WHERE ID_Comanda = ?1
								),
								Fecha_Hora_Cierre = datetime('now','localtime')
							WHERE ID_Comanda = ?1
								AND NOT EXISTS (
									SELECT 1
									FROM Detalle_Comanda dc
									WHERE dc.ID_Comanda = ?1 AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
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
