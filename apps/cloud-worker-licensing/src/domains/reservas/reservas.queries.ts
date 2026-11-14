// src/domains/reservas/reservas.queries.ts

import type { Client } from "@libsql/client/web";

import type { ClienteCoincidente, ReservaDto, ReservasMetaDto } from "@tpv/contracts";

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

export async function meta(db: Client): Promise<ReservasMetaDto> {
	const zonasRs = await db.execute(`
		SELECT
			ID_Zona AS id_zona,
			Nombre_Zona AS nombre_zona
		FROM Zonas
		WHERE Archivada_En IS NULL
		ORDER BY ID_Zona ASC;
	`);

	// Son reservables todas las mesas del plano: ya no existen "mesas de sistema" (la venta rápida
	// no usa mesa, ver `Comandas.Canal`). Lo archivado (RI-54) ya no está en el plano. Espejo del repo
	// local.
	const mesasRs = await db.execute(`
		SELECT
			ID_Mesa AS id_mesa,
			ID_Zona AS id_zona,
			Numero_Mesa AS numero_mesa,
			Capacidad AS capacidad
		FROM Mesas
		WHERE Archivada_En IS NULL
		ORDER BY ID_Zona ASC, ID_Mesa ASC;
	`);

	return {
		zonas: rows(zonasRs) as ReservasMetaDto["zonas"],
		mesas: rows(mesasRs) as ReservasMetaDto["mesas"],
	};
}

/**
 * Una reserva como la pinta el calendario. Los textos van con COALESCE, como el `s()` de la Main: el
 * DTO de Rust que lee esto en la Handy los tiene como `String`, y un null de una reserva sin mesa o
 * sin cliente (RI-61) no se dejaba deserializar y tumbaba el calendario entero.
 */
const SELECT_RESERVA = `
	SELECT
		R.ID_Reserva AS id_reserva,
		COALESCE(R.ID_Mesa, '') AS id_mesa,
		R.Dia_YMD AS dia_ymd,
		R.Hora AS hora,
		R.Turno AS turno,
		R.Comensales AS comensales,
		R.Duracion_Min AS duracion_min,
		R.Nota AS nota,
		R.Estado AS estado,
		R.Origen AS origen,
		C.ID_Cliente AS id_cliente,
		COALESCE(C.Nombre, '') AS nombre_cliente,
		C.Telefono AS telefono_cliente,
		C.Email AS email_cliente,
		COALESCE(M.ID_Zona, '') AS id_zona,
		COALESCE(M.Numero_Mesa, '') AS numero_mesa,
		COALESCE(M.Capacidad, 0) AS capacidad,
		COALESCE(Z.Nombre_Zona, '') AS nombre_zona
	FROM Reservas R
	LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
	LEFT JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
	LEFT JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
`;

export async function mes(
	db: Client,
	desde: string,
	hasta: string,
): Promise<ReservaDto[]> {
	const rs = await db.execute({
		sql: `
			${SELECT_RESERVA}
			WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
			ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
		`,
		args: [desde, hasta],
	});
	return rows(rs) as ReservaDto[];
}

/**
 * Una reserva, como la pinta el calendario, o `null`. Es lo que mira la Handy antes de cambiarla o
 * borrarla, para saber si al cliente de una reserva web hay que avisarle (espejo de
 * `SqliteReservasRepository::reserva`).
 */
export async function reserva(db: Client, idReserva: string): Promise<ReservaDto | null> {
	const rs = await db.execute({ sql: `${SELECT_RESERVA} WHERE R.ID_Reserva = ?1;`, args: [idReserva] });
	return (rows(rs)[0] as ReservaDto | undefined) ?? null;
}

/**
 * Cómo está una reserva para borrarla o cancelarla, o `null` si no existe: una web no se borra y
 * sólo se cancela la que aún no ha llegado (espejo de `eliminar`/`cancelar` en la Main,
 * docs/estudios/reservas-web.md §5.6).
 */
export async function estadoYOrigen(
	db: Client,
	idReserva: string,
): Promise<{ estado: string; origen: string } | null> {
	const rs = await db.execute({
		sql: "SELECT Estado AS estado, Origen AS origen FROM Reservas WHERE ID_Reserva = ?1;",
		args: [idReserva],
	});
	const r = rows(rs)[0];
	return r ? { estado: String(r.estado), origen: String(r.origen) } : null;
}

/** RI-61: la duración por defecto y el modo de solape del negocio. */
export type AjustesDeReserva = { duracion: number; modo: "avisar" | "prohibir" };

/** Los ajustes de reserva del negocio. Espejo de `ajustes_de_reserva`. */
export async function ajustesDeReserva(db: Client): Promise<AjustesDeReserva> {
	const rs = await db.execute(
		"SELECT Reserva_Duracion_Min AS duracion, Reserva_Solape AS modo FROM Business_Settings WHERE ID = 1;",
	);
	const r = rows(rs)[0] ?? {};
	return {
		duracion: Number(r.duracion) > 0 ? Number(r.duracion) : 120,
		modo: r.modo === "prohibir" ? "prohibir" : "avisar",
	};
}

// RI-61: el mismo SQL que `SQL_CHOQUE_RESERVA` y `SQL_CHOQUE_COMANDA` en la Main
// (`tpv-infra-sqlite/src/reservas.rs`), donde está explicado. Tiene que seguir siéndolo. Las
// condiciones van aparte porque las usa también la guarda del solape (`SQL_SIN_CHOQUE_EN_LA_MESA`).
const CHOCA_CON_UNA_RESERVA = `
	FROM Reservas R
	WHERE R.ID_Mesa = ?1
	  AND R.ID_Reserva <> ?6
	  AND R.Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA')
	  AND datetime(R.Dia_YMD || ' ' || R.Hora) < datetime(?2 || ' ' || ?3, '+' || ?4 || ' minutes')
	  AND datetime(R.Dia_YMD || ' ' || R.Hora, '+' || COALESCE(R.Duracion_Min, ?5) || ' minutes')
	      > datetime(?2 || ' ' || ?3)
`;

const CHOCA_CON_UNA_COMANDA = `
	FROM Comandas C
	WHERE C.ID_Mesa = ?1
	  AND C.Estado = 'Abierta'
	  AND datetime(C.Fecha_Hora_Apertura) < datetime(?2 || ' ' || ?3, '+' || ?4 || ' minutes')
	  AND MAX(datetime(C.Fecha_Hora_Apertura, '+' || ?5 || ' minutes'), datetime('now','localtime'))
	      > datetime(?2 || ' ' || ?3)
`;

const SQL_CHOQUE_RESERVA = `
	SELECT R.Hora AS desde,
	       strftime('%H:%M', datetime(R.Dia_YMD || ' ' || R.Hora,
	                                  '+' || COALESCE(R.Duracion_Min, ?5) || ' minutes')) AS hasta
	${CHOCA_CON_UNA_RESERVA}
	ORDER BY R.Dia_YMD, R.Hora, R.ID_Reserva
	LIMIT 1;
`;

const SQL_CHOQUE_COMANDA = `
	SELECT strftime('%H:%M', C.Fecha_Hora_Apertura) AS desde
	${CHOCA_CON_UNA_COMANDA}
	ORDER BY C.Fecha_Hora_Apertura, C.ID_Comanda
	LIMIT 1;
`;

/**
 * SYNC-30: 1 si la mesa no choca con nada, con los argumentos de `argumentosDelChoque`. Es la guarda
 * con la que `saveReserva` vuelve a mirar el solape dentro del lote que guarda la reserva: la ruta
 * lo mira antes (`choqueEnLaMesa`, para decir con qué choca), y entre su lectura y el lote puede
 * entrar otra reserva o abrirse una comanda en esa mesa.
 */
export const SQL_SIN_CHOQUE_EN_LA_MESA = `
	SELECT NOT EXISTS (SELECT 1 ${CHOCA_CON_UNA_RESERVA})
	   AND NOT EXISTS (SELECT 1 ${CHOCA_CON_UNA_COMANDA});
`;

/**
 * Los argumentos de las consultas del choque: `?1` la mesa, `?2` y `?3` el día y la hora, `?4` la
 * duración de la reserva, `?5` la del negocio y `?6` la propia reserva, que no choca consigo misma.
 */
export function argumentosDelChoque(
	r: { id_mesa: string; dia_ymd: string; hora: string; duracion_min?: number | null; id_reserva?: string | null },
	duracionDef: number,
): [string, string, string, number, number, string] {
	return [r.id_mesa, r.dia_ymd, r.hora, r.duracion_min ?? duracionDef, duracionDef, r.id_reserva ?? ""];
}

/** Mismo texto que `MSG_SOLAPE_PROHIBIDO` en la Main. */
export const MSG_SOLAPE_PROHIBIDO =
	"En este negocio no se pueden solapar reservas (Configuración → Reservas).";

/**
 * RI-61: con qué choca la reserva en su mesa, como frase para quien reserva, o `null`: otra reserva
 * que se cruza con ella o una comanda abierta. Espejo de `choque_en_la_mesa` en la Main. Su
 * `'now','localtime'` lo fija `tenantQuery` con la hora de quien reserva (REV-03).
 */
export async function choqueEnLaMesa(
	db: Client,
	r: {
		id_mesa: string;
		dia_ymd: string;
		hora: string;
		duracion_min: number | null;
		id_reserva: string | null;
	},
	duracionDef: number,
): Promise<string | null> {
	const args = argumentosDelChoque(r, duracionDef);

	const reserva = rows(await db.execute({ sql: SQL_CHOQUE_RESERVA, args }))[0];
	if (reserva) {
		return `Esa mesa ya tiene una reserva de ${reserva.desde} a ${reserva.hasta}.`;
	}

	// Sin la propia reserva, que esta consulta no usa.
	const comanda = rows(await db.execute({ sql: SQL_CHOQUE_COMANDA, args: args.slice(0, 5) }))[0];
	if (comanda) {
		return `Esa mesa está ocupada: tiene una comanda abierta desde las ${comanda.desde}.`;
	}
	return null;
}

export type ClienteExistente = {
	id_cliente: string;
	nombre: string | null;
	email: string | null;
	telefono: string | null;
};

const COLS_CLIENTE = `
	ID_Cliente AS id_cliente,
	Nombre AS nombre,
	Email AS email,
	Telefono AS telefono
`;

// Por email sin distinguir mayúsculas: es el criterio del índice único `ux_clientes_email` (sobre
// `lower(Email)`), el mismo por el que luego rechazaría el INSERT. Espejo de `POR_EMAIL` en la Main.
const POR_EMAIL = "Email IS NOT NULL AND Email <> '' AND lower(Email) = ?1";
const POR_TELEFONO = "Telefono = ?1";
const POR_ID = "ID_Cliente = ?1";

async function clientePor(
	db: Client,
	filtro: string,
	valor: string,
): Promise<ClienteExistente | null> {
	const rs = await db.execute({
		sql: `SELECT ${COLS_CLIENTE} FROM Clientes WHERE ${filtro}
		      ORDER BY Created_At DESC, ID_Cliente DESC LIMIT 1;`,
		args: [valor],
	});
	return (rows(rs)[0] as ClienteExistente | undefined) ?? null;
}

/**
 * RI-61: el cliente que ya tiene ese email o, si no, ese teléfono, para que la pantalla pregunte
 * antes de asignarle la reserva. Espejo de `buscar_cliente` en la Main.
 */
export async function buscarCliente(
	db: Client,
	telefono: string | null,
	email: string | null,
): Promise<ClienteCoincidente | null> {
	const busquedas: [string | null, string, string][] = [
		[email, POR_EMAIL, "email"],
		[telefono, POR_TELEFONO, "telefono"],
	];
	for (const [valor, filtro, por] of busquedas) {
		if (!valor) continue;
		const c = await clientePor(db, filtro, valor);
		if (c) {
			return {
				id_cliente: c.id_cliente,
				nombre: c.nombre ?? "",
				telefono: c.telefono,
				email: c.email,
				coincide_por: por,
			};
		}
	}
	return null;
}

/**
 * El cliente que llevará la reserva, ya decidido (RI-61). Espejo de `resolver_cliente` en la Main:
 *
 * - **ninguno**: sin cliente.
 * - **existente**: se le asigna; lo escrito sólo rellena sus huecos (RES-01), y un email que ya es de
 *   otro cliente no se le pone. Si ya no existe, `cliente_no_encontrado`.
 * - **nuevo**: una ficha nueva aunque otra comparta el teléfono; un email que ya es de otro cliente
 *   es `email_duplicado`.
 *
 * Los valores del merge se calculan aquí y viajan horneados en la sentencia, para que la escritura
 * replicada sea determinista.
 */
export type ClienteResuelto =
	| { modo: "ninguno" }
	| {
			modo: "existente";
			id_cliente: string;
			actualizar: { email: string | null; telefono: string | null } | null;
	  }
	| { modo: "nuevo" };

export async function resolverCliente(
	db: Client,
	datos: {
		id_cliente?: string | null;
		nombre_cliente?: string | null;
		telefono?: string | null;
		email?: string | null;
	},
): Promise<ClienteResuelto | { error: "cliente_no_encontrado" | "email_duplicado" }> {
	if (datos.id_cliente) {
		const ex = await clientePor(db, POR_ID, datos.id_cliente);
		if (!ex) return { error: "cliente_no_encontrado" };

		let emailLibre: string | null = null;
		if (datos.email) {
			const otro = await clientePor(db, POR_EMAIL, datos.email);
			emailLibre = otro && otro.id_cliente !== ex.id_cliente ? null : datos.email;
		}
		const email = ex.email ?? emailLibre;
		const telefono = ex.telefono ?? datos.telefono ?? null;
		// Sin nada que rellenar no se escribe: cada escritura viaja a la Main. Las notas del cliente
		// no se tocan desde una reserva (RI-84).
		const cambia = email !== ex.email || telefono !== ex.telefono;
		return {
			modo: "existente",
			id_cliente: ex.id_cliente,
			actualizar: cambia ? { email, telefono } : null,
		};
	}

	if (datos.nombre_cliente) {
		if (datos.email && (await clientePor(db, POR_EMAIL, datos.email))) {
			return { error: "email_duplicado" };
		}
		return { modo: "nuevo" };
	}

	return { modo: "ninguno" };
}
