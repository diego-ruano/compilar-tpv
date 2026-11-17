// src/domains/reservas/reservas.queries.ts

import type { Client } from "@libsql/client/web";

import type { ClienteCoincidente, ReservaDto, ReservasMetaDto } from "@tpv/contracts";

import { recortar } from "../../lib/texto";

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
// condiciones van aparte porque las usan también las guardas del solape (`SQL_SIN_CHOQUE…`), que
// leen la duración del negocio dentro del lote en vez de recibirla: `duracion` es la de la reserva,
// `porDefecto` la del negocio y `propia` la reserva, que no choca consigo misma.
const chocaConUnaReserva = (duracion: string, porDefecto: string, propia: string) => `
	FROM Reservas R
	WHERE R.ID_Mesa = ?1
	  AND R.ID_Reserva <> ${propia}
	  AND R.Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA')
	  AND datetime(R.Dia_YMD || ' ' || R.Hora) < datetime(?2 || ' ' || ?3, '+' || ${duracion} || ' minutes')
	  AND datetime(R.Dia_YMD || ' ' || R.Hora, '+' || COALESCE(R.Duracion_Min, ${porDefecto}) || ' minutes')
	      > datetime(?2 || ' ' || ?3)
`;

// RES-04: una comanda abierta ocupa la mesa todo el día; no cuenta la de la propia reserva ni la de
// una que ya era de esa mesa ese día. `propia` es la reserva.
const chocaConUnaComanda = (propia: string) => `
	FROM Comandas C
	WHERE C.ID_Mesa = ?1
	  AND C.Estado = 'Abierta'
	  AND ?2 <= date('now','localtime')
	  AND C.ID_Reserva IS NOT ${propia}
	  AND NOT EXISTS (SELECT 1 FROM Reservas R0 WHERE R0.ID_Reserva = ${propia} AND R0.ID_Mesa = ?1 AND R0.Dia_YMD = ?2)
`;

const SQL_CHOQUE_RESERVA = `
	SELECT R.Hora AS desde,
	       strftime('%H:%M', datetime(R.Dia_YMD || ' ' || R.Hora,
	                                  '+' || COALESCE(R.Duracion_Min, ?5) || ' minutes')) AS hasta
	${chocaConUnaReserva("?4", "?5", "?6")}
	ORDER BY R.Dia_YMD, R.Hora, R.ID_Reserva
	LIMIT 1;
`;

const SQL_CHOQUE_COMANDA = `
	SELECT strftime('%H:%M', C.Fecha_Hora_Apertura) AS desde
	${chocaConUnaComanda("?3")}
	ORDER BY C.Fecha_Hora_Apertura, C.ID_Comanda
	LIMIT 1;
`;

/** La duración por defecto del negocio, leída en la propia sentencia: la de `ajustesDeReserva`. */
const DURACION_DEL_NEGOCIO =
	"COALESCE((SELECT Reserva_Duracion_Min FROM Business_Settings WHERE ID = 1 AND Reserva_Duracion_Min > 0), 120)";

/** ¿Choca la reserva con otra? Con los argumentos de `argumentosDeLaGuarda`. */
const CHOCA_EN_EL_LOTE = `(
	EXISTS (SELECT 1 ${chocaConUnaReserva(`COALESCE(?4, ${DURACION_DEL_NEGOCIO})`, DURACION_DEL_NEGOCIO, "?5")})
)`;

/**
 * SYNC-30: las guardas con las que `saveReserva` vuelve a mirar el solape dentro del lote que guarda
 * la reserva. La ruta lo mira antes (`choqueEnLaMesa`, para decir con qué choca), y entre su lectura
 * y el lote puede entrar otra reserva, abrirse una comanda en esa mesa o cambiar los ajustes: aquí la
 * duración y el modo del negocio se leen al aplicar, como hace la Main dentro de su transacción.
 *
 * - `SQL_SIN_CHOQUE_PROHIBIDO`: 1 salvo que los solapes estén prohibidos y la mesa choque.
 * - `SQL_SIN_CHOQUE`: 1 si la mesa no choca con nada (la reserva no llega confirmada).
 */
export const SQL_SIN_CHOQUE_PROHIBIDO = `
	SELECT NOT ((SELECT Reserva_Solape FROM Business_Settings WHERE ID = 1) IS 'prohibir' AND ${CHOCA_EN_EL_LOTE});
`;
export const SQL_SIN_CHOQUE = `SELECT NOT ${CHOCA_EN_EL_LOTE};`;
/** RES-04: 1 salvo que la mesa tenga hoy una comanda abierta, que no se salta ni confirmando. */
export const SQL_SIN_COMANDA_HOY = `SELECT NOT EXISTS (SELECT 1 ${chocaConUnaComanda("?5")});`;

/**
 * Los argumentos de las guardas del solape: `?1` la mesa, `?2` y `?3` el día y la hora, `?4` la
 * duración de la reserva (sin ella, la del negocio) y `?5` la propia reserva.
 */
export function argumentosDeLaGuarda(r: {
	id_mesa: string;
	dia_ymd: string;
	hora: string;
	duracion_min?: number | null;
	id_reserva?: string | null;
}): [string, string, string, number | null, string] {
	return [r.id_mesa, r.dia_ymd, r.hora, r.duracion_min ?? null, r.id_reserva ?? ""];
}

/**
 * RES-INC-03: 1 si la reserva sigue como la vio el formulario que la edita. Mismo SQL que
 * `SQL_SIGUE_COMO_LA_VIO` en la Main: compara lo que da su lectura (la mesa vacía si no tiene, la
 * nota recortada, el cliente que existe). Los argumentos, de `argumentosDeLoVisto`.
 */
export const SQL_SIGUE_COMO_LA_VIO = `
	SELECT EXISTS (SELECT 1 FROM Reservas R
		WHERE R.ID_Reserva = ?1
		  AND COALESCE(R.ID_Mesa, '') = ?2
		  AND R.Dia_YMD = ?3
		  AND R.Hora = ?4
		  AND R.Comensales = ?5
		  AND R.Duracion_Min IS ?6
		  AND trim(COALESCE(R.Nota, '')) = ?7
		  AND COALESCE((SELECT C.ID_Cliente FROM Clientes C WHERE C.ID_Cliente = R.ID_Cliente), '') = ?8);
`;

export function argumentosDeLoVisto(
	idReserva: string,
	v: { id_mesa: string; dia_ymd: string; hora: string; comensales: number; duracion_min: number | null; nota: string | null; id_cliente: string | null },
): (string | number | null)[] {
	return [idReserva, v.id_mesa, v.dia_ymd, v.hora, v.comensales, v.duracion_min, recortar(v.nota ?? ""), v.id_cliente ?? ""];
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
): Promise<{ con: "reserva" | "comanda"; texto: string } | null> {
	const base = [r.id_mesa, r.dia_ymd, r.hora, r.duracion_min ?? duracionDef, duracionDef];

	const reserva = rows(
		await db.execute({ sql: SQL_CHOQUE_RESERVA, args: [...base, r.id_reserva ?? ""] }),
	)[0];
	if (reserva) {
		return { con: "reserva", texto: `Esa mesa ya tiene una reserva de ${reserva.desde} a ${reserva.hasta}.` };
	}

	const comanda = rows(
		await db.execute({ sql: SQL_CHOQUE_COMANDA, args: [r.id_mesa, r.dia_ymd, r.id_reserva ?? ""] }),
	)[0];
	if (comanda) {
		return {
			con: "comanda",
			texto: `Esa mesa tiene una comanda abierta desde las ${comanda.desde}: hoy no se puede reservar. Elige otra mesa u otro día.`,
		};
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

/** SYNC-30: 1 si el email (`?1`) no es de ningún cliente. La guarda del cliente nuevo de una reserva. */
export const SQL_EMAIL_LIBRE = `SELECT NOT EXISTS (SELECT 1 FROM Clientes WHERE ${POR_EMAIL});`;
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
 * - **nuevo**: una ficha nueva aunque otra comparta el teléfono. Un email que ya es de otro cliente
 *   es `email_duplicado`, y lo decide la guarda de `saveReserva` dentro del lote (SYNC-30): mirado
 *   aquí, el reintento de una reserva que había entrado con su cliente nuevo se encontraba al
 *   cliente que ella misma había creado.
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
): Promise<ClienteResuelto | { error: "cliente_no_encontrado" }> {
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

	if (datos.nombre_cliente) return { modo: "nuevo" };

	return { modo: "ninguno" };
}
