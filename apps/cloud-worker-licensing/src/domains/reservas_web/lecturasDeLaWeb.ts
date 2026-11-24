// src/domains/reservas_web/lecturasDeLaWeb.ts
//
// Lo que la agenda de reservas web (`AgendaWeb`) y la API pública de la reserva leen de la base del
// negocio, en un viaje al TenantHub por lectura.
//
// Ninguna de las dos corre dentro del TenantHub: la API pública no tiene dispositivo que lo pida
// (`tenantAuth`, `alHub`), y la agenda es otro Durable Object. Leían consulta a consulta, un viaje al
// TenantHub por cada una: el día de la agenda eran cinco, tres de ellos seguidos. Ahora cada lectura
// tiene un nombre y sus datos (`LecturaWeb`), viaja entera por RPC (`TenantHub.leerParaLaWeb`) y el
// TenantHub la ejecuta con su base al lado (`leerConLaHoraDelNegocio`): un viaje.
//
// «Ahora» es la hora del negocio (`horaDelNegocio.ts`): la pide un navegador cualquiera, cuya hora no
// vale para nada. Se fija en todas las sentencias de la lectura, que lo recibe también.
//
// Lo que no se puede perder de vista al añadir una:
//   · sólo lee: la reserva web nunca escribe en la base del negocio (ADR 0007);
//   · lo que necesita del estado de la agenda (lo que espera a la Main) se le pasa en sus datos: el
//     TenantHub no lo ve;
//   · lo que devuelve cruza el RPC (copia estructurada: valen `Map` y `Set`, no funciones).

import type { Base } from "../../lib/sql";

import type { Env } from "../../env";
import { HubError } from "../../lib/errorHttp";
import { hubDe } from "../../lib/hub";
import { hubLocal } from "../../lib/hubLocal";
import { conLaHoraDeQuienPregunta } from "../../lib/tenantClient";
import { medirTramo } from "../../observability/tiempos";
import { negocioDelCorreo } from "./correos";
import { horizonte } from "./disponibilidad";
import { horaDelNegocio } from "./horaDelNegocio";
import {
	ajustesWeb,
	cierresEntre,
	mesasYFranjas,
	negocioPublico,
	nombresDeLasReservables,
	numeroDeMesa,
	ocupacionAlrededorDe,
	planoPublico,
	reservasVivasDelCorreo,
} from "./lecturas";

// Lo que la agenda pregunta para saber qué ha llegado ya a la base. Un alta, si la reserva está;
// una cancelación, si está y ya no está por llegar (cancelada, sentada, terminada o no presentada):
// la Main sólo cancela una que aún no ha llegado (`cancelar_desde_la_web`).
const SQL_ESTAN = `SELECT ID_Reserva AS id FROM Reservas WHERE ID_Reserva IN (SELECT value FROM json_each(?1));`;
const SQL_CANCELADAS = `SELECT ID_Reserva AS id FROM Reservas
	WHERE ID_Reserva IN (SELECT value FROM json_each(?1)) AND Estado <> 'PROXIMA';`;

/** El estado de una reserva en la base, para el enlace de cancelar, con el correo de su cliente. */
export type ReservaEnLaBase = { dia: string; hora: string; personas: number; id_mesa: string | null; estado: string; email: string | null };

/**
 * Las lecturas, por su nombre. Cada una recibe la base con «ahora» ya fijado a la hora del negocio,
 * esa hora, y sus datos.
 */
const LECTURAS = {
	/** API pública, `/negocio`: lo del negocio y lo que hace falta para su calendario. */
	async negocio(db: Base, ahora: string, _: Record<never, never>) {
		const ajustes = await ajustesWeb(db);
		const hoy = ahora.slice(0, 10);
		const { primero, ultimo } = horizonte(hoy, ajustes);
		const [negocio, { mesas, franjas }, cierres] = await Promise.all([
			negocioPublico(db),
			mesasYFranjas(db),
			cierresEntre(db, primero, ultimo),
		]);
		return { ajustes, hoy, primero, ultimo, negocio, mesas, franjas, cierres };
	},

	/** API pública, `/dia`: lo que hace falta para las horas de un día. */
	async dia(db: Base, ahora: string, p: { dia: string }) {
		const ajustes = await ajustesWeb(db);
		const [cierres, { mesas, franjas }] = await Promise.all([cierresEntre(db, p.dia, p.dia), mesasYFranjas(db)]);
		return { ajustes, hoy: ahora.slice(0, 10), cierres, mesas, franjas };
	},

	/** API pública, `/plano`: salones y mesas, para dibujar. */
	async plano(db: Base, _ahora: string, _: Record<never, never>) {
		return planoPublico(db);
	},

	/** Lo del negocio que sale en un correo al cliente. */
	async negocioDelCorreo(db: Base, _ahora: string, _: Record<never, never>) {
		return negocioDelCorreo(db);
	},

	/** La agenda, para decidir sobre un día: los ajustes, las mesas y lo que ya ocupa la base. */
	async diaDeLaAgenda(db: Base, ahora: string, p: { dia: string }) {
		const ajustes = await ajustesWeb(db);
		const [cierres, { mesas, franjas }, ocupacion] = await Promise.all([
			cierresEntre(db, p.dia, p.dia),
			mesasYFranjas(db),
			ocupacionAlrededorDe(db, p.dia, ajustes.duracion),
		]);
		return { ahora, ajustes, cierres, mesas, franjas, ocupaciones: ocupacion.ocupaciones, idsEnLaBase: ocupacion.ids };
	},

	/**
	 * La agenda, para un alta: lo del día, las reservas vivas del correo y el nombre de la mesa que
	 * lleva la respuesta (la pedida o, sin ella, las de todas las que puede tocar).
	 */
	async alta(db: Base, ahora: string, p: { dia: string; email: string; idMesa: string; automatica: boolean }) {
		const ajustes = await ajustesWeb(db);
		const hoy = ahora.slice(0, 10);
		const [cierres, { mesas, franjas }, ocupacion, delCorreo, nombres] = await Promise.all([
			cierresEntre(db, p.dia, p.dia),
			mesasYFranjas(db),
			ocupacionAlrededorDe(db, p.dia, ajustes.duracion),
			reservasVivasDelCorreo(db, p.email, hoy),
			p.automatica
				? nombresDeLasReservables(db)
				: numeroDeMesa(db, p.idMesa).then((n) => new Map<string, string>(n === null ? [] : [[p.idMesa, n]])),
		]);
		return {
			dia: { ahora, ajustes, cierres, mesas, franjas, ocupaciones: ocupacion.ocupaciones, idsEnLaBase: ocupacion.ids },
			delCorreo,
			nombres,
		};
	},

	/**
	 * La agenda, para el enlace de cancelar: la reserva en la base, con el correo de su cliente, y el
	 * nombre de su mesa. Si aún no está en la base, el de la mesa del alta que espera en la agenda
	 * (`idMesaDelAlta`).
	 */
	async reserva(db: Base, ahora: string, p: { idReserva: string; idMesaDelAlta: string | null }) {
		const rs = await db.execute({
			sql: `SELECT R.Dia_YMD AS dia, R.Hora AS hora, R.Comensales AS personas, R.ID_Mesa AS id_mesa,
			             R.Estado AS estado, NULLIF(TRIM(C.Email), '') AS email
			      FROM Reservas R LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
			      WHERE R.ID_Reserva = ?1;`,
			args: [p.idReserva],
		});
		const r: any = rs.rows?.[0];
		const enLaBase: ReservaEnLaBase | null = r
			? {
					dia: String(r.dia),
					hora: String(r.hora),
					personas: Number(r.personas),
					id_mesa: r.id_mesa ?? null,
					estado: String(r.estado),
					email: typeof r.email === "string" ? r.email : null,
				}
			: null;
		const idMesa = enLaBase?.id_mesa ?? p.idMesaDelAlta;
		const numero = idMesa ? await numeroDeMesa(db, idMesa) : null;
		return { ahora, enLaBase, numero };
	},

	/** La agenda, para avisar a quien no se le pudo registrar: el negocio y el nombre de cada mesa. */
	async fallidas(db: Base, ahora: string, p: { idsMesas: string[] }) {
		const [negocio, nombres] = await Promise.all([
			negocioDelCorreo(db),
			Promise.all(p.idsMesas.map(async (id) => [id, await numeroDeMesa(db, id)] as const)),
		]);
		return { ahora, negocio, mesas: new Map(nombres) };
	},

	/**
	 * La agenda, en su alarma: de estas reservas, cuáles ha recibido ya la Main (`alta`) o cuáles ya
	 * no están por llegar (`cancelacion`).
	 */
	async enLaBase(db: Base, _ahora: string, p: { tipo: "alta" | "cancelacion"; ids: string[] }) {
		const rs = await db.execute({ sql: p.tipo === "alta" ? SQL_ESTAN : SQL_CANCELADAS, args: [JSON.stringify(p.ids)] });
		return (rs.rows ?? []).map((r: any) => String(r.id));
	},
};

type Lecturas = typeof LECTURAS;
export type NombreDeLectura = keyof Lecturas;
/** Una lectura: su nombre (`que`) y sus datos. */
export type LecturaWeb<N extends NombreDeLectura = NombreDeLectura> = N extends NombreDeLectura
	? { que: N } & Parameters<Lecturas[N]>[2]
	: never;
/** Lo que devuelve una lectura. */
export type ResultadoDe<N extends NombreDeLectura> = Awaited<ReturnType<Lecturas[N]>>;

/** Lo que contesta `TenantHub.leerParaLaWeb`. Un fallo con status decidido viaja como dato: el RPC no conserva un `HubError`. */
export type RespuestaDeLecturaWeb =
	| { ok: true; valor: unknown }
	| { ok: false; code: string; status: number; details?: unknown };

/**
 * Ejecuta una lectura sobre `db`, que ya tiene «ahora» fijado a `ahora`. Es lo que hace
 * `leerConLaHoraDelNegocio` después de calcular la hora; los tests de la agenda lo llaman con la suya.
 */
export function ejecutarLecturaWeb<N extends NombreDeLectura>(db: Base, ahora: string, lectura: LecturaWeb<N>): Promise<ResultadoDe<N>> {
	const leer = LECTURAS[lectura.que] as (db: Base, ahora: string, p: unknown) => Promise<ResultadoDe<N>>;
	return leer(db, ahora, lectura);
}

/** Ejecuta una lectura sobre la base del negocio, con «ahora» fijado a la hora del negocio. */
export async function leerConLaHoraDelNegocio<N extends NombreDeLectura>(db: Base, lectura: LecturaWeb<N>): Promise<ResultadoDe<N>> {
	const ahora = await horaDelNegocio(db);
	return ejecutarLecturaWeb(conLaHoraDeQuienPregunta(db, ahora), ahora, lectura);
}

/**
 * Una lectura de la base del negocio `tenantId`, en un viaje a su TenantHub (o al lado, si se está
 * ya dentro de él).
 */
export async function leerParaLaWeb<N extends NombreDeLectura>(
	env: Env,
	tenantId: string,
	lectura: LecturaWeb<N>,
): Promise<ResultadoDe<N>> {
	const local = hubLocal(tenantId);
	if (local) return leerConLaHoraDelNegocio(await local.base(), lectura);
	const r = (await medirTramo("hub-lee", () =>
		hubDe(env, tenantId).leerParaLaWeb(tenantId, lectura as any),
	)) as unknown as RespuestaDeLecturaWeb;
	if (!r.ok) throw new HubError(r.code, r.status, r.details);
	return r.valor as ResultadoDe<N>;
}
