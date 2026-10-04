// src/domains/notificaciones/notificaciones.commands.ts
//
// Escrituras de notificaciones expresadas como comandos para el Durable Object. El SQL replica
// tpv-infra-sqlite/src/notificaciones.rs y el DO aporta transacción, idempotencia por Op_Id y
// broadcast. Nota (determinismo del broadcast): igual que el resto de módulos, se usan INSERT con
// VALUES explícitos (nunca INSERT ... SELECT), y el UUID se genera en un paso `value` previo, para
// que la nube y cada Main/Handy escriban EXACTAMENTE la misma fila al re-aplicar el broadcast.

import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import type { CrearNotificacionBody } from "./notificaciones.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID = { $ref: "id" } as const;

const SEVERIDADES = new Set(["info", "exito", "aviso", "error"]);

function normSeveridad(s: unknown): string {
	const t = (s ?? "").toString().trim().toLowerCase();
	return SEVERIDADES.has(t) ? t : "info";
}

function cleanOrNull(s: unknown): string | null {
	const t = (s ?? "").toString().trim();
	return t.length ? t : null;
}

/** La notificación tal y como se guarda: textos recortados, vacíos a NULL, severidad conocida. */
export function normalizar(input: CrearNotificacionBody) {
	return {
		tipo: input.tipo.trim(),
		severidad: normSeveridad(input.severidad),
		titulo: input.titulo.trim(),
		cuerpo: cleanOrNull(input.cuerpo),
		destino_tipo: input.destino_tipo,
		destino_valor:
			input.destino_tipo === "todos" ? null : cleanOrNull(input.destino_valor),
		accion: cleanOrNull(input.accion),
		payload: cleanOrNull(input.payload),
		clave_dedupe: cleanOrNull(input.clave_dedupe),
		expira_en: cleanOrNull(input.expira_en),
	};
}

export type NotificacionNormalizada = ReturnType<typeof normalizar>;

/** Lo que `actualizar` compara y reescribe, en el orden de sus `?n`. Los dos primeros se ven de un vistazo. */
const ACTUALIZABLES = [
	"severidad",
	"titulo",
	"cuerpo",
	"tipo",
	"destino_tipo",
	"destino_valor",
	"accion",
	"payload",
	"expira_en",
] as const;

export type ContenidoActivo = { [K in (typeof ACTUALIZABLES)[number]]: string | null };

/**
 * RI-12: volver a emitir con la clave de una notificación activa la ACTUALIZA. Espejo de
 * `emitir` en la Main (`tpv-infra-sqlite/src/notificaciones.rs`):
 *
 * - igual → `null`, no se escribe nada;
 * - cambia lo que se ve de un vistazo (severidad o título) → se reescribe, sube arriba
 *   (`Creada_En`) y se borran sus lecturas, para que vuelva a salir como no leída;
 * - cambia sólo el detalle (cuerpo, acción…) → se reescribe sin más. El de stock negativo lleva la
 *   cantidad en el cuerpo y cada venta la cambia: no puede volver a saltar por eso.
 *
 * El route lee la activa antes (el DO no decide por una lectura) y los valores viajan horneados.
 */
export function actualizar(
	idNotificacion: string,
	actual: ContenidoActivo,
	nueva: NotificacionNormalizada,
): BuiltCommand | null {
	const distinto = (k: (typeof ACTUALIZABLES)[number]) => (actual[k] ?? null) !== (nueva[k] ?? null);
	if (!ACTUALIZABLES.some(distinto)) return null;
	const seVeDistinto = distinto("severidad") || distinto("titulo");

	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				UPDATE Notificaciones
				SET Severidad = ?1, Titulo = ?2, Cuerpo = ?3, Tipo = ?4, Destino_Tipo = ?5,
					Destino_Valor = ?6, Accion = ?7, Payload = ?8, Expira_En = ?9${
						seVeDistinto ? ", Creada_En = datetime('now','localtime')" : ""
					}
				WHERE ID_Notificacion = ?10;
			`,
			args: [...ACTUALIZABLES.map((k) => nueva[k] ?? null), idNotificacion],
		},
	];
	if (seVeDistinto) {
		steps.push({
			kind: "execute",
			sql: "DELETE FROM Notificacion_Lecturas WHERE ID_Notificacion = ?1;",
			args: [idNotificacion],
		});
	}

	return {
		commandName: "notificaciones_actualizar",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_notificacion: idNotificacion, ...nueva },
	};
}

export function crear(input: CrearNotificacionBody): BuiltCommand {
	const cloudPayload = normalizar(input);

	const steps: any[] = [
		{
			kind: "value",
			saveAs: "id",
			sql: "SELECT ?1;",
			args: [nuevoId()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Notificaciones (
					ID_Notificacion, Tipo, Severidad, Titulo, Cuerpo,
					Destino_Tipo, Destino_Valor, Accion, Payload, Clave_Dedupe,
					Creada_En, Expira_En
				) VALUES (
					?1, ?2, ?3, ?4, ?5,
					?6, ?7, ?8, ?9, ?10,
					datetime('now','localtime'), ?11
				);
			`,
			args: [
				REF_ID,
				cloudPayload.tipo,
				cloudPayload.severidad,
				cloudPayload.titulo,
				cloudPayload.cuerpo,
				cloudPayload.destino_tipo,
				cloudPayload.destino_valor,
				cloudPayload.accion,
				cloudPayload.payload,
				cloudPayload.clave_dedupe,
				cloudPayload.expira_en,
			],
		},
	];

	return {
		commandName: "notificaciones_crear",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload,
	};
}

export function marcarLeida(idNotificacion: string, idUsuario: string): BuiltCommand {
	return {
		commandName: "notificaciones_marcar_leida",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `INSERT OR IGNORE INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En) VALUES (?1, ?2, datetime('now','localtime'));`,
				args: [idNotificacion, idUsuario],
			},
		},
		cloudPayload: { id_notificacion: idNotificacion, id_usuario: idUsuario },
	};
}

/** Marca en bloque: INSERTs explícitos por id (el route resuelve los ids no leídos antes de aplicar). */
export function marcarLeidasBatch(ids: string[], idUsuario: string): BuiltCommand {
	const steps = ids.map((id) => ({
		kind: "execute",
		sql: `INSERT OR IGNORE INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En) VALUES (?1, ?2, datetime('now','localtime'));`,
		args: [id, idUsuario],
	}));

	return {
		commandName: "notificaciones_marcar_todas",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_usuario: idUsuario, ids },
	};
}

export function resolverPorClave(clave: string): BuiltCommand {
	return {
		commandName: "notificaciones_resolver",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `UPDATE Notificaciones SET Estado = 'resuelta' WHERE Clave_Dedupe = ?1 AND Estado = 'activa';`,
				args: [clave],
			},
		},
		cloudPayload: { clave_dedupe: clave },
	};
}

/**
 * Papelera: descartar y restaurar son el MISMO cambio de estado en direcciones opuestas, así que
 * comparten constructor. Como toda escritura replicable, va por el DO: la Main y las demás Handy
 * lo reciben por el broadcast y su papelera es la misma que la de aquí.
 */
function cambiarEstado(
	idNotificacion: string,
	estado: "activa" | "descartada",
	commandName: string,
): BuiltCommand {
	return {
		commandName,
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `UPDATE Notificaciones SET Estado = ?2 WHERE ID_Notificacion = ?1;`,
				args: [idNotificacion, estado],
			},
		},
		cloudPayload: { id_notificacion: idNotificacion, estado },
	};
}

export function descartar(idNotificacion: string): BuiltCommand {
	return cambiarEstado(idNotificacion, "descartada", "notificaciones_descartar");
}

export function restaurar(idNotificacion: string): BuiltCommand {
	return cambiarEstado(idNotificacion, "activa", "notificaciones_restaurar");
}

/** Borrado definitivo. Los recibos de lectura caen por ON DELETE CASCADE en cada motor. */
export function eliminar(idNotificacion: string): BuiltCommand {
	return {
		commandName: "notificaciones_eliminar",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `DELETE FROM Notificaciones WHERE ID_Notificacion = ?1;`,
				args: [idNotificacion],
			},
		},
		cloudPayload: { id_notificacion: idNotificacion },
	};
}
