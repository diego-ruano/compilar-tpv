// src/domains/notificaciones/notificaciones.queries.ts
//
// Lecturas de notificaciones. SQL portado de tpv-infra-sqlite/src/notificaciones.rs.
// Visibilidad por usuario (todos / usuario / rol resuelto contra Usuarios) y estado "leído"
// por usuario (tabla Notificacion_Lecturas). `?1` = ID_Usuario.

import type { Client } from "@libsql/client/web";

import type { NotificacionRow } from "@tpv/contracts";

import type { ContenidoActivo } from "./notificaciones.commands";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

/** Predicado de visibilidad de una notificación activa y no caducada para el usuario `?1`. */
const VISIBLE = `
	n.Estado = 'activa'
	AND (n.Expira_En IS NULL OR n.Expira_En >= datetime('now','localtime'))
	AND (
		n.Destino_Tipo = 'todos'
		OR (n.Destino_Tipo = 'usuario' AND n.Destino_Valor = ?1)
		OR (n.Destino_Tipo = 'rol'
			AND n.Destino_Valor = (SELECT u.ID_Rol FROM Usuarios u WHERE u.ID_Usuario = ?1))
	)
`;

/**
 * Predicado de la PAPELERA: lo descartado que ese usuario puede ver.
 *
 * Sin filtro de caducidad, igual que en `tpv-infra-sqlite`: una notificación caducada que alguien
 * borró sigue en su papelera hasta que decida qué hacer con ella.
 */
const VISIBLE_PAPELERA = `
	n.Estado = 'descartada'
	AND (
		n.Destino_Tipo = 'todos'
		OR (n.Destino_Tipo = 'usuario' AND n.Destino_Valor = ?1)
		OR (n.Destino_Tipo = 'rol'
			AND n.Destino_Valor = (SELECT u.ID_Rol FROM Usuarios u WHERE u.ID_Usuario = ?1))
	)
`;

const LIST_LIMIT = 200;

export async function listar(
	db: Client,
	idUsuario: string,
	soloNoLeidas: boolean,
): Promise<NotificacionRow[]> {
	const filtro = soloNoLeidas ? "AND l.ID_Usuario IS NULL" : "";
	return filas(db, idUsuario, VISIBLE, filtro);
}

/** Contenido de la papelera del usuario. */
export async function listarPapelera(
	db: Client,
	idUsuario: string,
): Promise<NotificacionRow[]> {
	return filas(db, idUsuario, VISIBLE_PAPELERA, "");
}

/** Cuerpo común de los dos listados. El predicado sale SIEMPRE de una constante de este módulo. */
async function filas(
	db: Client,
	idUsuario: string,
	predicado: string,
	filtro: string,
): Promise<NotificacionRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				n.ID_Notificacion, n.Tipo, n.Severidad, n.Titulo, n.Cuerpo,
				n.Destino_Tipo, n.Destino_Valor, n.Accion, n.Payload, n.Estado,
				n.Creada_En, n.Expira_En,
				CASE WHEN l.ID_Usuario IS NOT NULL THEN 1 ELSE 0 END AS Leida
			FROM Notificaciones n
			LEFT JOIN Notificacion_Lecturas l
				ON l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
			WHERE ${predicado}
				${filtro}
			ORDER BY n.Creada_En DESC, n.ID_Notificacion DESC
			LIMIT ${LIST_LIMIT};
		`,
		args: [idUsuario],
	});

	return rows(rs).map((r) => ({
		id_notificacion: String(r.ID_Notificacion ?? ""),
		tipo: String(r.Tipo ?? ""),
		severidad: String(r.Severidad ?? ""),
		titulo: String(r.Titulo ?? ""),
		cuerpo: r.Cuerpo ?? null,
		destino_tipo: String(r.Destino_Tipo ?? ""),
		destino_valor: r.Destino_Valor ?? null,
		accion: r.Accion ?? null,
		payload: r.Payload ?? null,
		estado: String(r.Estado ?? ""),
		creada_en: String(r.Creada_En ?? ""),
		expira_en: r.Expira_En ?? null,
		leida: Number(r.Leida ?? 0) > 0,
	}));
}

export async function contarNoLeidas(db: Client, idUsuario: string): Promise<number> {
	const rs = await db.execute({
		sql: `
			SELECT COUNT(*) AS n
			FROM Notificaciones n
			WHERE ${VISIBLE}
				AND NOT EXISTS (
					SELECT 1 FROM Notificacion_Lecturas l
					WHERE l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
				);
		`,
		args: [idUsuario],
	});
	return Number(rows(rs)[0]?.n ?? 0);
}

/** IDs visibles y no leídos por el usuario (para marcar todas: el route los resuelve antes de aplicar). */
export async function idsNoLeidas(db: Client, idUsuario: string): Promise<string[]> {
	const rs = await db.execute({
		sql: `
			SELECT n.ID_Notificacion AS id
			FROM Notificaciones n
			WHERE ${VISIBLE}
				AND NOT EXISTS (
					SELECT 1 FROM Notificacion_Lecturas l
					WHERE l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
				)
			ORDER BY n.Creada_En DESC, n.ID_Notificacion DESC;
		`,
		args: [idUsuario],
	});
	return rows(rs)
		.map((r) => String(r.id ?? ""))
		.filter((s) => s.length > 0);
}

/**
 * La notificación ACTIVA con esa clave de dedupe, con lo que `actualizar` compara (o null). Para
 * la emisión con clave (RI-12) y para no resolver lo que no existe.
 */
export async function activaPorClave(
	db: Client,
	clave: string,
): Promise<{ id: string; contenido: ContenidoActivo } | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Notificacion AS id, Severidad AS severidad, Titulo AS titulo, Cuerpo AS cuerpo,
				Tipo AS tipo, Destino_Tipo AS destino_tipo, Destino_Valor AS destino_valor,
				Accion AS accion, Payload AS payload, Expira_En AS expira_en
			FROM Notificaciones
			WHERE Clave_Dedupe = ?1 AND Estado = 'activa'
			LIMIT 1;
		`,
		args: [clave],
	});
	const r = rows(rs)[0];
	if (!r?.id) return null;
	const texto = (v: unknown) => (v == null ? null : String(v));
	return {
		id: String(r.id),
		contenido: {
			severidad: texto(r.severidad),
			titulo: texto(r.titulo),
			cuerpo: texto(r.cuerpo),
			tipo: texto(r.tipo),
			destino_tipo: texto(r.destino_tipo),
			destino_valor: texto(r.destino_valor),
			accion: texto(r.accion),
			payload: texto(r.payload),
			expira_en: texto(r.expira_en),
		},
	};
}
