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

export async function mes(
	db: Client,
	desde: string,
	hasta: string,
): Promise<ReservaDto[]> {
	// Los textos van con COALESCE, como el `s()` de la Main: el DTO de Rust que lee esto en la Handy
	// los tiene como `String`, y un null de una reserva sin mesa o sin cliente (RI-61) no se dejaba
	// deserializar y tumbaba el calendario entero.
	const rs = await db.execute({
		sql: `
			SELECT
				R.ID_Reserva AS id_reserva,
				COALESCE(R.ID_Mesa, '') AS id_mesa,
				R.Dia_YMD AS dia_ymd,
				R.Hora AS hora,
				R.Turno AS turno,
				R.Comensales AS comensales,
				R.Nota AS nota,
				R.Estado AS estado,
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
			WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
			ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
		`,
		args: [desde, hasta],
	});
	return rows(rs) as ReservaDto[];
}

// RES-02: ¿hay ya una reserva que ocupe el mismo hueco exacto (mesa+día+hora)? Excluye la
// propia reserva (edición) y los estados que no ocupan (cancelada/no-show/finalizada). Espejo
// de la comprobación autoritativa del repo local.
export async function haySolapeReserva(
	db: Client,
	idMesa: string,
	diaYmd: string,
	hora: string,
	idReservaExcluir: string | null,
): Promise<boolean> {
	const rs = await db.execute({
		sql: `
			SELECT 1
			FROM Reservas
			WHERE ID_Mesa = ?1 AND Dia_YMD = ?2 AND Hora = ?3
				AND Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA')
				AND ID_Reserva <> ?4
			LIMIT 1;
		`,
		args: [idMesa, diaYmd, hora, idReservaExcluir ?? ""],
	});
	return rows(rs).length > 0;
}

export type ClienteExistente = {
	id_cliente: string;
	nombre: string | null;
	email: string | null;
	telefono: string | null;
	notas: string | null;
};

const COLS_CLIENTE = `
	ID_Cliente AS id_cliente,
	Nombre AS nombre,
	Email AS email,
	Telefono AS telefono,
	Notas AS notas
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
			actualizar: { email: string | null; telefono: string | null; notas: string | null } | null;
	  }
	| { modo: "nuevo" };

export async function resolverCliente(
	db: Client,
	datos: {
		id_cliente?: string | null;
		nombre_cliente?: string | null;
		telefono?: string | null;
		email?: string | null;
		notas_cliente?: string | null;
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
		const notas = ex.notas ?? datos.notas_cliente ?? null;
		// Sin nada que rellenar no se escribe: cada escritura viaja a la Main.
		const cambia = email !== ex.email || telefono !== ex.telefono || notas !== ex.notas;
		return {
			modo: "existente",
			id_cliente: ex.id_cliente,
			actualizar: cambia ? { email, telefono, notas } : null,
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
