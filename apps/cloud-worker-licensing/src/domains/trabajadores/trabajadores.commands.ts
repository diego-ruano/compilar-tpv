// src/domains/trabajadores/trabajadores.commands.ts

import { nuevoId } from "../../lib/ids";
import { recortar } from "../../lib/texto";
import type { ApplyCommand } from "../../lib/hub";
import type { FilaSemanaOrigen, GrupoAsignacion } from "./trabajadores.queries";
import type { PredeterminadoItem } from "./trabajadores.queries";
import type { AsignacionGuardarInput } from "@tpv/contracts";
import type {
	AsignacionCreateInput,
	AsignacionUpdateInput,
	CopySemanaInput,
	TrabajadorCreateInput,
	TrabajadorUpdateInput,
} from "./trabajadores.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_USUARIO = { $ref: "id_usuario" } as const;
const REF_ID_TRABAJADOR = { $ref: "id_trabajador" } as const;

/**
 * RI-63: el PIN llega en claro y la ruta lo hashea antes de construir el comando. El PIN no puede
 * quedarse en el `cloudPayload`, que el Durable Object guarda en su cola (`Cloud_Payload_Json`).
 */
function sinPin<T extends { pin?: string | null }>(input: T): Omit<T, "pin"> {
	const { pin: _pin, ...resto } = input;
	return resto;
}

export function createTrabajador(input: TrabajadorCreateInput, passwordHash: string): BuiltCommand {
	const steps = [
		{
			kind: "value",
			saveAs: "id_usuario",
			sql: "SELECT ?1;",
			args: [nuevoId()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Usuarios (
					ID_Usuario,
					ID_Rol,
					Email,
					Password_Hash,
					Nombre,
					Apellido,
					Estado,
					Sin_PIN
				)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);
			`,
			args: [
				REF_ID_USUARIO,
				input.id_rol,
				input.email,
				passwordHash,
				input.nombre,
				input.apellido,
				input.estado,
				input.sin_pin ? 1 : 0,
			],
		},
		{
			kind: "value",
			saveAs: "id_trabajador",
			sql: "SELECT ?1;",
			args: [nuevoId()],
		},
		{
			kind: "execute",
			// TRAB-03: DNI, IBAN y Numero_Seguridad_Social NO se escriben desde aquí. Van
			// cifrados con una clave que sólo tiene la Main, así que si la Handy los
			// insertara quedarían en claro en la base — exactamente lo que el cifrado evita.
			// Se dan de alta vacíos y se completan luego desde la Main.
			sql: `
				INSERT INTO Trabajadores (
					ID_Trabajador,
					ID_Usuario,
					Telefono,
					Puesto,
					Fecha_Inicio_Contrato,
					Fecha_Fin_Contrato
				)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6);
			`,
			args: [
				REF_ID_TRABAJADOR,
				REF_ID_USUARIO,
				input.telefono,
				input.puesto,
				input.fecha_inicio_contrato,
				input.fecha_fin_contrato,
			],
		},
	];

	return {
		commandName: "trabajadores_create",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "id_trabajador" },
		},
		cloudPayload: sinPin(input),
	};
}

/**
 * Sin `resultKey`: el resultado son las filas que tocó cada UPDATE (`usuarios`, `trabajadores`),
 * para que la ruta diga que el trabajador no existe en vez de responder `ok` sin haber tocado nada
 * (RI-63). En un reintento idempotente llegan a `null`: ese resultado se guarda sin leer la base.
 */
export function updateTrabajador(
	idTrabajador: string,
	input: TrabajadorUpdateInput,
	passwordHash: string | null,
): BuiltCommand {
	// `Sin_PIN` sólo cambia si llega; sin valor se queda el que tenga. Mismo SQL en la Main.
	const valorSinPin = input.sin_pin == null ? null : input.sin_pin ? 1 : 0;
	const updateUsuario = passwordHash
		? {
				kind: "execute",
				saveAs: "usuarios",
				sql: `
					UPDATE Usuarios
					SET
						ID_Rol = ?1,
						Email = ?2,
						Nombre = ?3,
						Apellido = ?4,
						Estado = ?5,
						Sin_PIN = COALESCE(?6, Sin_PIN),
						Password_Hash = ?7
					WHERE ID_Usuario = ?8;
				`,
				args: [
					input.id_rol,
					input.email,
					input.nombre,
					input.apellido,
					input.estado,
					valorSinPin,
					passwordHash,
					input.id_usuario,
				],
			}
		: {
				kind: "execute",
				saveAs: "usuarios",
				sql: `
					UPDATE Usuarios
					SET
						ID_Rol = ?1,
						Email = ?2,
						Nombre = ?3,
						Apellido = ?4,
						Estado = ?5,
						Sin_PIN = COALESCE(?6, Sin_PIN)
					WHERE ID_Usuario = ?7;
				`,
				args: [
					input.id_rol,
					input.email,
					input.nombre,
					input.apellido,
					input.estado,
					valorSinPin,
					input.id_usuario,
				],
			};

	return {
		commandName: "trabajadores_update",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					updateUsuario,
					{
						kind: "execute",
						saveAs: "trabajadores",
						// TRAB-03: las tres columnas cifradas se omiten del SET. Omitirlas (en vez
						// de ponerlas a NULL) es lo que hace que editar un trabajador desde la
						// Handy CONSERVE lo que la Main guardó, en lugar de borrárselo.
						sql: `
							UPDATE Trabajadores
							SET
								Telefono = ?1,
								Puesto = ?2,
								Fecha_Inicio_Contrato = ?3,
								Fecha_Fin_Contrato = ?4
							WHERE ID_Trabajador = ?5;
						`,
						args: [
							input.telefono,
							input.puesto,
							input.fecha_inicio_contrato,
							input.fecha_fin_contrato,
							idTrabajador,
						],
					},
				],
			},
		},
		cloudPayload: { ...sinPin(input), id_trabajador: idTrabajador },
	};
}

export function createAsignacion(input: AsignacionCreateInput): BuiltCommand {
	const idAsignacion = nuevoId();
	return {
		commandName: "horarios_create_asignacion",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: `
							INSERT INTO Asignacion_Turnos (
								ID_Asignacion,
								ID_Trabajador,
								Fecha,
								ID_Turno,
								Area,
								Hora_Inicio,
								Hora_Fin,
								Notas
							)
							VALUES (?1, ?2, date(?3), ?4, ?5, ?6, ?7, ?8);
						`,
						args: [
							idAsignacion,
							input.id_trabajador,
							input.fecha,
							input.id_turno,
							input.area,
							input.hora_inicio,
							input.hora_fin,
							input.notas,
						],
					},
					{
						kind: "value",
						saveAs: "id_asignacion",
						sql: "SELECT ?1;",
						args: [idAsignacion],
					},
				],
				resultKey: "id_asignacion",
			},
		},
		cloudPayload: input,
	};
}

/** RI-85: resuelve el grupo y lo sustituye dentro de la misma transacción. */
export function guardarAsignacion(input: AsignacionGuardarInput, existente: GrupoAsignacion | null = null): BuiltCommand {
	const grupo = existente?.id_grupo ?? nuevoId();
	const idPrincipal = input.id_asignacion ?? nuevoId();
	const condicion = "EXISTS (SELECT 1 FROM Asignacion_Turnos WHERE ID_Asignacion = ?10 AND COALESCE(ID_Grupo, ID_Asignacion) = ?2 AND ID_Trabajador = ?3 AND Fecha = ?4)";
	const steps: any[] = [];
	if (input.id_asignacion) {
		// Conservamos el miembro principal: sirve de guarda en cada sentencia del batch.
		// Si desapareció desde la lectura previa, no se borra ni se crea ninguna fila.
		steps.push({ kind: "execute", sql: `DELETE FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = ?1 AND ID_Asignacion <> ?2 AND EXISTS (SELECT 1 FROM Asignacion_Turnos WHERE ID_Asignacion = ?2 AND COALESCE(ID_Grupo, ID_Asignacion) = ?1 AND ID_Trabajador = ?3 AND Fecha = ?4);`, args: [grupo, idPrincipal, input.id_trabajador, input.fecha] });
	}
	input.tramos.forEach((tramo, i) => {
		const id = i === 0 ? idPrincipal : existente?.ids.find(id => id !== idPrincipal) ?? nuevoId();
		steps.push({ kind: "execute", ...(i === 0 ? { saveAs: "guardado" } : {}),
			sql: `INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Grupo, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${input.id_asignacion ? condicion : "1"} ON CONFLICT(ID_Asignacion) DO UPDATE SET ID_Grupo = excluded.ID_Grupo, ID_Turno = excluded.ID_Turno, Area = excluded.Area, Hora_Inicio = excluded.Hora_Inicio, Hora_Fin = excluded.Hora_Fin, Notas = excluded.Notas;`,
			args: [id, grupo, input.id_trabajador, input.fecha, input.id_turno, input.area, tramo.hora_inicio, tramo.hora_fin, input.notas ?? null, ...(input.id_asignacion ? [idPrincipal] : [])],
		});
	});
	return { commandName: "horarios_guardar_asignacion", command: { type: "tenantDb.transaction", payload: { steps, resultKey: "guardado" } }, cloudPayload: input };
}

export function updateAsignacion(
	idAsignacion: string,
	input: AsignacionUpdateInput,
): BuiltCommand {
	return {
		commandName: "horarios_update_asignacion",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Asignacion_Turnos
					SET
						ID_Turno = ?2,
						Area = ?3,
						Hora_Inicio = ?4,
						Hora_Fin = ?5,
						Notas = ?6
					WHERE ID_Asignacion = ?1 AND (SELECT COUNT(*) FROM Asignacion_Turnos a WHERE COALESCE(a.ID_Grupo, a.ID_Asignacion) = COALESCE(Asignacion_Turnos.ID_Grupo, Asignacion_Turnos.ID_Asignacion)) = 1;
				`,
				args: [
					idAsignacion,
					input.id_turno,
					input.area,
					input.hora_inicio,
					input.hora_fin,
					input.notas,
				],
			},
		},
		cloudPayload: { ...input, id_asignacion: idAsignacion },
	};
}

export function deleteAsignacion(idAsignacion: string): BuiltCommand {
	return {
		commandName: "horarios_delete_asignacion",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: "DELETE FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = (SELECT COALESCE(ID_Grupo, ID_Asignacion) FROM Asignacion_Turnos WHERE ID_Asignacion = ?1);",
				args: [idAsignacion],
			},
		},
		cloudPayload: { id_asignacion: idAsignacion },
	};
}

// TRAB-08: la semana se copia fila a fila, con el UUID generado aquí y pasado como argumento.
// Antes era un `INSERT ... SELECT lower(hex(randomblob(16)))`, y eso es exactamente lo que no se
// puede hacer: lo que viaja a la Main es el TEXTO de la sentencia (el DO solo resuelve a literal
// las marcas de hora canónicas y los `$ref`), así que la Main volvía a ejecutar el randomblob y se
// quedaba con otros ID_Asignacion. Mismas filas, claves distintas, y a partir de ahí editar o borrar
// un turno solo afectaba a una de las dos copias. El repo de Rust ya lo hacía fila a fila por esto
// mismo (ver el comentario en tpv-infra-sqlite/src/trabajadores.rs::copy_semana).
export function copySemana(
	input: CopySemanaInput,
	filas: FilaSemanaOrigen[],
): BuiltCommand {
	const steps: any[] = [];
	if (input.overwrite) {
		steps.push({
			kind: "execute",
			sql: `
				DELETE FROM Asignacion_Turnos
				WHERE Fecha >= date(?1)
					AND Fecha < date(?1, '+7 day');
			`,
			args: [input.to_monday],
		});
	}

	const shift = diasEntre(input.from_monday, input.to_monday);
	let insertadas = 0;
	const grupos = new Map<string, string>();

	for (const f of filas) {
		const destino = sumaDias(f.fecha, shift);
		// Espejo del `continue` de Rust: una fecha que no se puede leer se salta, no revienta.
		if (destino === null) continue;
		let grupo: string | null = null;
		if (f.id_grupo) {
			grupo = grupos.get(f.id_grupo) ?? nuevoId();
			grupos.set(f.id_grupo, grupo);
		}

		steps.push({
			kind: "execute",
			sql: `
				INSERT INTO Asignacion_Turnos (
					ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas, ID_Grupo
				)
				VALUES (?1, ?2, date(?3), ?4, ?5, ?6, ?7, ?8, ?9);
			`,
			args: [
				nuevoId(),
				f.id_trabajador,
				destino,
				f.id_turno,
				f.area ?? "Sala",
				f.hora_inicio,
				f.hora_fin,
				f.notas,
				grupo,
			],
		});
		insertadas++;
	}

	steps.push({
		kind: "value",
		saveAs: "inserted",
		sql: "SELECT ?1;",
		args: [insertadas],
	});

	return {
		commandName: "horarios_copy_semana_asignaciones",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "inserted" },
		},
		cloudPayload: input,
	};
}

/** Días de diferencia entre dos fechas YYYY-MM-DD (UTC, para no arrastrar husos). */
function diasEntre(desde: string, hasta: string): number {
	const a = fechaUtc(desde);
	const b = fechaUtc(hasta);
	if (a === null || b === null) return 0;
	return Math.round((b - a) / 86400000);
}

/** Suma días a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD, o null si la fecha no es legible. */
function sumaDias(fecha: string, dias: number): string | null {
	const base = fechaUtc(fecha);
	if (base === null) return null;
	return new Date(base + dias * 86400000).toISOString().slice(0, 10);
}

function fechaUtc(s: unknown): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(recortar(String(s ?? "")));
	if (!m) return null;
	const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isFinite(t) ? t : null;
}

export function setPredeterminadoDesdeSemana(
	fechaLunes: string,
	items: PredeterminadoItem[],
): BuiltCommand {
	if (!items.length) {
		return {
			commandName: "horarios_set_predeterminado_desde_semana",
			command: {
				type: "tenantDb.transaction",
				payload: {
					steps: [{ kind: "value", saveAs: "ok", sql: "SELECT 0;" }],
					resultKey: "ok",
				},
			},
			cloudPayload: { fecha_lunes: fechaLunes, items: [] },
		};
	}

	const trabajadores = Array.from(
		new Set(items.map((it) => it.id_trabajador)),
	).sort();

	const steps: any[] = trabajadores.map((idTrabajador) => ({
		kind: "execute",
		sql: "DELETE FROM Horario_Predeterminado WHERE ID_Trabajador = ?1;",
		args: [idTrabajador],
	}));

	for (const it of items) {
		steps.push({
			kind: "execute",
			sql: `
				INSERT INTO Horario_Predeterminado (
					ID_Default,
					ID_Trabajador,
					Weekday,
					Orden,
					ID_Turno,
					Area,
					Hora_Inicio,
					Hora_Fin,
					Notas
				)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
			`,
			args: [
				nuevoId(),
				it.id_trabajador,
				it.weekday,
				it.orden,
				it.id_turno,
				it.area,
				it.hora_inicio,
				it.hora_fin,
				it.notas,
			],
		});
	}

	steps.push({ kind: "value", saveAs: "ok", sql: "SELECT 1;" });

	return {
		commandName: "horarios_set_predeterminado_desde_semana",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "ok" },
		},
		cloudPayload: { fecha_lunes: fechaLunes, items },
	};
}
