// src/domains/reservas_web/lecturas.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): lo que se lee de la base del negocio.
// Sólo lecturas: la reserva web nunca escribe en la base (ADR 0007). Ninguna devuelve datos
// personales de una reserva; lo que sí sale por las rutas públicas es lo del negocio.
//
// `'now','localtime'` lo fija `leerConLaHoraDelNegocio` (`lecturasDeLaWeb.ts`) con la hora del negocio
// (`horaDelNegocio.ts`).

import type { Base } from "../../lib/sql";

import type { AjustesWeb, FranjaWeb, MesaWeb, Ocupacion } from "./disponibilidad";

function filas(rs: any): any[] {
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

/** Un entero de un ajuste, dentro de su rango; fuera de él, el valor por defecto. */
function entero(v: unknown, def: number, min: number, max: number): number {
	const n = Number(v);
	return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

/**
 * Los ajustes de la reserva web. Los topes (un año de horizonte, un día de duración…) no son reglas
 * del negocio: impiden que un valor roto convierta una lectura en un bucle de miles de días.
 */
export async function ajustesWeb(db: Base): Promise<AjustesWeb> {
	const r =
		filas(
			await db.execute(`
				SELECT Reserva_Web_Activa AS activa, Reserva_Web_Dias_Min AS dias_min,
				       Reserva_Web_Dias_Max AS dias_max, Reserva_Web_Margen_Min AS margen_min,
				       Reserva_Web_Margen_Plazas AS margen_plazas, Reserva_Duracion_Min AS duracion,
				       Zona_Horaria AS zona
				FROM Business_Settings WHERE ID = 1;
			`),
		)[0] ?? {};
	const diasMin = entero(r.dias_min, 1, 0, 365);
	return {
		activa: Number(r.activa) === 1,
		diasMin,
		diasMax: Math.max(diasMin, entero(r.dias_max, 30, 0, 365)),
		margenMin: entero(r.margen_min, 20, 0, 240),
		margenPlazas: entero(r.margen_plazas, 2, 0, 50),
		duracion: entero(r.duracion, 120, 1, 24 * 60),
		zona: typeof r.zona === "string" && r.zona ? r.zona : "Europe/Madrid",
	};
}

/**
 * Lo que el widget enseña del negocio: el rótulo, cómo llegar y quién es el responsable. El logo no
 * (M-072): es una imagen del bucket, que se sirve con el id del negocio en el camino
 * (`/v1/images/:tenant/…`), y lo público de la reserva web es la clave.
 */
export type NegocioPublico = {
	nombre: string;
	direccion: string;
	telefono: string;
	razon_social: string;
	cif: string;
};

export async function negocioPublico(db: Base): Promise<NegocioPublico> {
	const r =
		filas(
			await db.execute(`
				SELECT Business_Name AS nombre, Direccion AS direccion, Telefono AS telefono,
				       Razon_Social AS razon_social, CIF AS cif
				FROM Business_Settings WHERE ID = 1;
			`),
		)[0] ?? {};
	const s = (v: unknown) => (typeof v === "string" ? v : "");
	return {
		nombre: s(r.nombre),
		direccion: s(r.direccion),
		telefono: s(r.telefono),
		razon_social: s(r.razon_social),
		cif: s(r.cif),
	};
}

// Una mesa es reservable si la casilla está marcada, la mesa y su zona no están archivadas
// (RI-54) y tiene alguna franja. Lo mismo en las dos lecturas.
const RESERVABLES = `
	FROM Mesas M
	JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
	JOIN Reserva_Web_Mesas W ON W.ID_Mesa = M.ID_Mesa
	WHERE W.Activa = 1 AND M.Archivada_En IS NULL AND Z.Archivada_En IS NULL
`;

/** Las mesas reservables desde la web y sus franjas. */
export async function mesasYFranjas(db: Base): Promise<{ mesas: MesaWeb[]; franjas: FranjaWeb[] }> {
	const [rsMesas, rsFranjas] = await db.batch(
		[
			`SELECT M.ID_Mesa AS id_mesa, M.Capacidad AS capacidad ${RESERVABLES} ORDER BY M.ID_Mesa;`,
			`SELECT F.ID_Mesa AS id_mesa, F.Dias_Semana AS dias_semana, F.Fecha_Desde AS fecha_desde,
			        F.Fecha_Hasta AS fecha_hasta, F.Hora_Desde AS hora_desde, F.Hora_Hasta AS hora_hasta
			 FROM Reserva_Web_Franjas F
			 WHERE F.ID_Mesa IN (SELECT M.ID_Mesa ${RESERVABLES})
			 ORDER BY F.ID_Mesa, F.Hora_Desde, F.ID_Franja;`,
		],
	);
	const franjas = filas(rsFranjas).map((f) => ({
		id_mesa: String(f.id_mesa),
		dias_semana: Number(f.dias_semana),
		fecha_desde: f.fecha_desde ?? null,
		fecha_hasta: f.fecha_hasta ?? null,
		hora_desde: String(f.hora_desde),
		hora_hasta: String(f.hora_hasta),
	}));
	const conFranja = new Set(franjas.map((f) => f.id_mesa));
	const mesas = filas(rsMesas)
		.map((m) => ({ id_mesa: String(m.id_mesa), capacidad: Number(m.capacidad) }))
		.filter((m) => conFranja.has(m.id_mesa));
	return { mesas, franjas };
}

/** Los días cerrados entre dos fechas, las dos incluidas. */
export async function cierresEntre(db: Base, desde: string, hasta: string): Promise<Set<string>> {
	const rs = await db.execute({
		sql: `SELECT Dia_YMD AS dia FROM Reserva_Web_Cierres WHERE Dia_YMD >= ?1 AND Dia_YMD <= ?2;`,
		args: [desde, hasta],
	});
	return new Set(filas(rs).map((r) => String(r.dia)));
}

/** Las reservas de la base alrededor de un día: las que ocupan su mesa y todos sus ids. */
export type OcupacionEnLaBase = {
	ocupaciones: Ocupacion[];
	/** Todas las reservas de la ventana, ocupen o no: la agenda da por vistas las suyas. */
	ids: Set<string>;
};

// RI-61: los intervalos salen con el mismo `datetime()` que `SQL_CHOQUE_RESERVA` y
// `SQL_CHOQUE_COMANDA` (`reservas.queries.ts`, y en la Main `reservas.rs`): lo único que cambia es
// que aquí se piden todos los de la ventana y el cruce se hace en `disponibilidad.ts::seCruzan`, con
// la misma comparación. `test/reservasWebDisponibilidad.test.ts` vigila que den lo mismo.
//
// La ventana es del día anterior al siguiente: la reserva pedida dura menos de un día
// (`ajustesWeb`), así que sólo la pisa una de esos tres días salvo que otra dure más de 24 h.
const SQL_RESERVAS_VENTANA = `
	SELECT R.ID_Reserva AS id_reserva, R.ID_Mesa AS id_mesa,
	       R.Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA') AS ocupa,
	       datetime(R.Dia_YMD || ' ' || R.Hora) AS inicio,
	       datetime(R.Dia_YMD || ' ' || R.Hora, '+' || COALESCE(R.Duracion_Min, ?2) || ' minutes') AS fin
	FROM Reservas R
	WHERE R.Dia_YMD >= date(?1, '-1 day') AND R.Dia_YMD <= date(?1, '+1 day');
`;

// RES-04: una comanda abierta ocupa su mesa todo el día de hoy (y lo anterior): en la Main, la
// reserva de un día que no es posterior a hoy choca. Como intervalo, desde siempre hasta el final
// de hoy, con el mismo `date('now','localtime')`.
const SQL_COMANDAS_ABIERTAS = `
	SELECT C.ID_Mesa AS id_mesa,
	       '0000-01-01 00:00:00' AS inicio,
	       datetime(date('now','localtime'), '+1 day') AS fin
	FROM Comandas C
	WHERE C.Estado = 'Abierta' AND C.ID_Mesa IS NOT NULL;
`;

export async function ocupacionAlrededorDe(db: Base, dia: string, duracion: number): Promise<OcupacionEnLaBase> {
	const [rsReservas, rsComandas] = await db.batch(
		[
			{ sql: SQL_RESERVAS_VENTANA, args: [dia, duracion] },
			{ sql: SQL_COMANDAS_ABIERTAS, args: [] },
		],
	);
	const ocupaciones: Ocupacion[] = [];
	const ids = new Set<string>();
	for (const r of filas(rsReservas)) {
		ids.add(String(r.id_reserva));
		// Un intervalo que SQLite no sabe calcular (una hora mal escrita) da NULL, y en el SQL de
		// la Main un NULL no choca con nada: aquí tampoco.
		if (Number(r.ocupa) === 1 && r.id_mesa && r.inicio && r.fin) {
			ocupaciones.push({ id_mesa: String(r.id_mesa), inicio: String(r.inicio), fin: String(r.fin) });
		}
	}
	for (const c of filas(rsComandas)) {
		if (c.inicio && c.fin) ocupaciones.push({ id_mesa: String(c.id_mesa), inicio: String(c.inicio), fin: String(c.fin) });
	}
	return { ocupaciones, ids };
}

/**
 * Las reservas vivas de un correo desde hoy, por su id: el tope de 10 por correo. Por el cliente de
 * la reserva, sin distinguir mayúsculas, como `ux_clientes_email`.
 */
export async function reservasVivasDelCorreo(db: Base, email: string, hoy: string): Promise<Set<string>> {
	const rs = await db.execute({
		sql: `SELECT R.ID_Reserva AS id_reserva
		      FROM Reservas R JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
		      WHERE C.Email IS NOT NULL AND C.Email <> '' AND lower(C.Email) = ?1
		        AND R.Dia_YMD >= ?2 AND R.Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA');`,
		args: [email, hoy],
	});
	return new Set(filas(rs).map((r) => String(r.id_reserva)));
}

/**
 * El techo del plano, en la respuesta entera (CLAUDE.md, «Worker»): es una ruta anónima. Ningún bar
 * se acerca; si alguno pasa, `completo` lo dice en vez de cortar el plano en silencio.
 */
const TECHO_SALONES = 50;
const TECHO_MESAS = 500;

/** El plano tal como lo dibuja el widget: salones y mesas, sin nada de las reservas. */
export type PlanoPublico = {
	completo: boolean;
	salones: { id: string; nombre: string; puntos: string }[];
	mesas: {
		id: string;
		id_salon: string;
		/** El nombre que tiene en la Main («5», «Terraza 3»). */
		nombre: string;
		forma: string;
		x: number;
		y: number;
		ancho: number;
		alto: number;
		radio: number | null;
		capacidad: number;
		reservable: boolean;
	}[];
};

export async function planoPublico(db: Base): Promise<PlanoPublico> {
	const [rsZonas, rsMesas] = await db.batch(
		[
			`SELECT ID_Zona AS id, Nombre_Zona AS nombre, Room_Points AS puntos
			 FROM Zonas WHERE Archivada_En IS NULL ORDER BY Nombre_Zona, ID_Zona LIMIT ${TECHO_SALONES + 1};`,
			`SELECT M.ID_Mesa AS id, M.ID_Zona AS id_salon, M.Numero_Mesa AS numero, M.Shape AS forma,
			        M.Ubicacion_X AS x, M.Ubicacion_Y AS y, M.Width AS ancho, M.Height AS alto,
			        M.Radius AS radio, M.Capacidad AS capacidad,
			        EXISTS (SELECT 1 FROM Reserva_Web_Mesas W WHERE W.ID_Mesa = M.ID_Mesa AND W.Activa = 1)
			          AND EXISTS (SELECT 1 FROM Reserva_Web_Franjas F WHERE F.ID_Mesa = M.ID_Mesa) AS reservable
			 FROM Mesas M JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
			 WHERE M.Archivada_En IS NULL AND Z.Archivada_En IS NULL
			 ORDER BY M.ID_Zona, M.ID_Mesa LIMIT ${TECHO_MESAS + 1};`,
		],
	);
	const zonas = filas(rsZonas);
	const mesas = filas(rsMesas);
	return {
		completo: zonas.length <= TECHO_SALONES && mesas.length <= TECHO_MESAS,
		salones: zonas.slice(0, TECHO_SALONES).map((z) => ({ id: String(z.id), nombre: String(z.nombre), puntos: String(z.puntos ?? "[]") })),
		mesas: mesas.slice(0, TECHO_MESAS).map((m) => ({
			id: String(m.id),
			id_salon: String(m.id_salon),
			nombre: String(m.numero),
			forma: String(m.forma),
			x: Number(m.x),
			y: Number(m.y),
			ancho: Number(m.ancho),
			alto: Number(m.alto),
			radio: m.radio === null || m.radio === undefined ? null : Number(m.radio),
			capacidad: Number(m.capacidad),
			reservable: Number(m.reservable) === 1,
		})),
	};
}

/** Los nombres de las mesas reservables desde la web, por su id: entre ellas elige la mesa automática. */
export async function nombresDeLasReservables(db: Base): Promise<Map<string, string>> {
	const rs = await db.execute(`SELECT M.ID_Mesa AS id, M.Numero_Mesa AS numero ${RESERVABLES};`);
	return new Map(filas(rs).map((m) => [String(m.id), String(m.numero)]));
}

/** Lo que se enseña de una mesa: su número. */
export async function numeroDeMesa(db: Base, idMesa: string): Promise<string | null> {
	const rs = await db.execute({ sql: `SELECT Numero_Mesa AS numero FROM Mesas WHERE ID_Mesa = ?1;`, args: [idMesa] });
	const r = filas(rs)[0];
	return r ? String(r.numero) : null;
}
