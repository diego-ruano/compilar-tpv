// src/durableObjects/agendaWeb.motor.ts
//
// La agenda de reservas web de un negocio (docs/estudios/reservas-web.md §4.3): decide la mesa,
// guarda la reserva hasta que la Main la tiene y lleva los enlaces de cancelar.
//
// Reglas que no se rompen aquí:
//   · **Nunca escribe en Turso** (ADR 0007). Lee la base del negocio y escribe sólo en su SQLite.
//   · **Comprobar y apuntar van en el mismo bloque síncrono**, sin `await` en medio: lo que hace que
//     dos altas a la vez para la misma mesa no salgan las dos (`agendaWeb.almacen.ts`). Lo que es
//     asíncrono (Turso, los hashes) va antes.
//   · **Sin estado en campos de instancia que importe**: lo que hay que recordar va en el SQLite
//     (`estado`), como en el `TenantHub` (SYNC-16). `leer` es una costura para los tests, no estado.
//   · Las respuestas no llevan datos personales de ninguna reserva.

import type { Client } from "@libsql/client/web";

import type { Env } from "../env";
import { nuevoId } from "../lib/ids";
import { lecturaConHora } from "../lib/tenantClient";
import { sha256HexStr } from "../server/utils/crypto";
import {
	alternativas,
	horaEnTramos,
	intervalo,
	libres,
	mesasAdecuadas,
	motivoDelDia,
	tramosDelDia,
	type AjustesWeb,
	type FranjaWeb,
	type MesaWeb,
	type Ocupacion,
} from "../domains/reservas_web/disponibilidad";
import { horaDelNegocio } from "../domains/reservas_web/horaDelNegocio";
import {
	ajustesWeb,
	cierresEntre,
	mesasYFranjas,
	numeroDeMesa,
	ocupacionAlrededorDe,
	reservasVivasDelCorreo,
} from "../domains/reservas_web/lecturas";
import type { AltaReservaWeb } from "../domains/reservas_web/reservasWeb.schemas";
import {
	altasDesde,
	anularAlta,
	apuntarAlta,
	apuntarCancelacion,
	darPorVistas,
	negocioRecordado,
	ocupacionPendiente,
	peticion,
	prepararAlmacen,
	purgar,
	recordarNegocio,
	reservaDelEnlace,
	vivasDelCorreoEnLaAgenda,
} from "./agendaWeb.almacen";

/** Reservas vivas por correo, contando las de Turso y las que esperan aquí. */
export const MAX_RESERVAS_POR_CORREO = 10;
/** Altas por negocio en 24 h: el control exacto detrás del limitador por IP. */
export const MAX_ALTAS_DIA_NEGOCIO = 200;
/** Cada cuánto despierta la alarma mientras haya algo guardado. */
const CADA_ALARMA_MS = 60 * 60_000;
/**
 * Cuánto antes de empezar a leer Turso se mira si otra petición dio un alta por vista
 * (`agendaWeb.almacen.ts::Lectura`). Cubre que la lectura de Turso llegue con algo de retraso.
 */
const MARGEN_LECTURA_MS = 60_000;

type ErrorAgenda =
	| "reserva_web_cerrada"
	| "dia_no_reservable"
	| "hora_fuera_de_franja"
	| "mesa_no_disponible"
	| "limite_reservas_correo"
	| "tope_reservas_negocio"
	| "reserva_no_cancelable"
	| "enlace_no_valido";

/** Los rechazos de negocio cruzan el RPC como resultado, no como excepción (igual que `aplicar`). */
export type RechazoAgenda = { ok: false; error: ErrorAgenda; status: 400 | 404 | 409 | 429 };

const STATUS: Record<ErrorAgenda, RechazoAgenda["status"]> = {
	reserva_web_cerrada: 409,
	dia_no_reservable: 400,
	hora_fuera_de_franja: 400,
	mesa_no_disponible: 409,
	limite_reservas_correo: 409,
	tope_reservas_negocio: 429,
	reserva_no_cancelable: 409,
	enlace_no_valido: 404,
};

function rechazo(error: ErrorAgenda): RechazoAgenda {
	return { ok: false, error, status: STATUS[error] };
}

export type ResultadoDisponibles = { ok: true; mesas: string[]; alternativas: string[] } | RechazoAgenda;

export type ResultadoReservar =
	| {
			ok: true;
			id_reserva: string;
			codigo: string;
			dia: string;
			hora: string;
			personas: number;
			mesa: string;
			/** El token del enlace de cancelar: sólo para el correo, nunca para la respuesta. */
			token: string;
	  }
	| RechazoAgenda;

export type EstadoPublico = "confirmada" | "cancelada" | "pasada";

export type ResultadoConsulta =
	| { ok: true; dia: string; hora: string; personas: number; mesa: string; estado: EstadoPublico; cancelable: boolean }
	| RechazoAgenda;

export type ResultadoCancelar = { ok: true } | RechazoAgenda;

/** Una referencia corta para hablar con el restaurante: el final aleatorio del `ID_Reserva`. */
export function codigoDeReserva(idReserva: string): string {
	return idReserva.replace(/-/g, "").slice(-6).toUpperCase();
}

/** El token del enlace de cancelar: 128 bits en base64url. Sólo se guarda su hash. */
function nuevoToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** La forma de un token de enlace: lo demás no se busca. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Lo que se lee de Turso para decidir sobre un día. */
type DiaLeido = {
	/** Cuándo se empezó a leer: de ahí sale `Lectura.vistasDesdeMs`. */
	leidaMs: number;
	ahora: string;
	ajustes: AjustesWeb;
	cierres: Set<string>;
	mesas: MesaWeb[];
	franjas: FranjaWeb[];
	ocupaciones: Ocupacion[];
	idsEnTurso: Set<string>;
};

/** El estado de una reserva en Turso, para el enlace de cancelar. */
type ReservaEnTurso = { dia: string; hora: string; personas: number; id_mesa: string | null; estado: string };

export type Lector = <T>(tenantId: string, fn: (db: Client, ahora: string) => Promise<T>) => Promise<T>;

export class MotorAgendaWeb {
	/** Cómo se lee Turso. Los tests lo cambian por un cliente sobre SQLite. */
	leer: Lector;

	constructor(
		private readonly ctx: DurableObjectState,
		env: Env,
	) {
		prepararAlmacen(ctx.storage.sql);
		this.leer = (tenantId, fn) => lecturaConHora(env, tenantId, horaDelNegocio, fn);
	}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	private async leerDia(tenantId: string, dia: string): Promise<DiaLeido> {
		const leidaMs = Date.now();
		return this.leer(tenantId, async (db, ahora) => {
			const ajustes = await ajustesWeb(db);
			const [cierres, { mesas, franjas }, ocupacion] = await Promise.all([
				cierresEntre(db, dia, dia),
				mesasYFranjas(db),
				ocupacionAlrededorDe(db, dia, ajustes.duracion),
			]);
			return { leidaMs, ahora, ajustes, cierres, mesas, franjas, ocupaciones: ocupacion.ocupaciones, idsEnTurso: ocupacion.ids };
		});
	}

	/** Si el día o la hora no valen, el rechazo. */
	private motivo(d: DiaLeido, dia: string, hora: string): RechazoAgenda | null {
		const delDia = motivoDelDia(dia, d.ahora.slice(0, 10), d.ajustes, d.cierres);
		if (delDia === "reserva_web_cerrada") return rechazo("reserva_web_cerrada");
		if (delDia) return rechazo("dia_no_reservable");
		if (!horaEnTramos(tramosDelDia(d.mesas, d.franjas, dia, d.ajustes), hora)) return rechazo("hora_fuera_de_franja");
		return null;
	}

	/** Las mesas libres a esa hora, contando Turso y lo que espera aquí. Síncrono. */
	private mesasLibres(d: DiaLeido, dia: string, hora: string, personas: number): MesaWeb[] {
		const lectura = { ids: d.idsEnTurso, vistasDesdeMs: d.leidaMs - MARGEN_LECTURA_MS };
		const ocupado = [...d.ocupaciones, ...ocupacionPendiente(this.sql, dia, d.ajustes.duracion, lectura)];
		const adecuadas = mesasAdecuadas(d.mesas, d.franjas, dia, hora, personas, d.ajustes);
		return libres(adecuadas, ocupado, dia, hora, d.ajustes.duracion);
	}

	async disponibles(p: { tenantId: string; dia: string; hora: string; personas: number }): Promise<ResultadoDisponibles> {
		recordarNegocio(this.sql, p.tenantId);
		const d = await this.leerDia(p.tenantId, p.dia);

		const motivo = this.motivo(d, p.dia, p.hora);
		if (motivo) return motivo;

		darPorVistas(this.sql, d.idsEnTurso, Date.now());
		const mesas = this.mesasLibres(d, p.dia, p.hora, p.personas).map((m) => m.id_mesa);
		if (mesas.length) return { ok: true, mesas, alternativas: [] };

		const tramos = tramosDelDia(d.mesas, d.franjas, p.dia, d.ajustes);
		const otras = alternativas(
			p.hora,
			(h) => horaEnTramos(tramos, h) && this.mesasLibres(d, p.dia, h, p.personas).length > 0,
		);
		return { ok: true, mesas: [], alternativas: otras };
	}

	async reservar(p: { tenantId: string; alta: AltaReservaWeb }): Promise<ResultadoReservar> {
		const { alta } = p;
		recordarNegocio(this.sql, p.tenantId);

		// Lo asíncrono, antes del bloque que decide.
		const token = nuevoToken();
		const [tokenHash, emailHash] = await Promise.all([sha256HexStr(token), sha256HexStr(alta.email)]);
		const leidaMs = Date.now();
		const leido = await this.leer(p.tenantId, async (db, ahora) => {
			const ajustes = await ajustesWeb(db);
			const hoy = ahora.slice(0, 10);
			const [cierres, { mesas, franjas }, ocupacion, delCorreo, numero] = await Promise.all([
				cierresEntre(db, alta.dia_ymd, alta.dia_ymd),
				mesasYFranjas(db),
				ocupacionAlrededorDe(db, alta.dia_ymd, ajustes.duracion),
				reservasVivasDelCorreo(db, alta.email, hoy),
				numeroDeMesa(db, alta.id_mesa),
			]);
			const dia: DiaLeido = {
				leidaMs,
				ahora,
				ajustes,
				cierres,
				mesas,
				franjas,
				ocupaciones: ocupacion.ocupaciones,
				idsEnTurso: ocupacion.ids,
			};
			return { dia, delCorreo, numero };
		});
		const d = leido.dia;

		const motivo = this.motivo(d, alta.dia_ymd, alta.hora);
		if (motivo) return motivo;

		// ── Desde aquí, síncrono hasta apuntarla ──
		const ahoraMs = Date.now();
		darPorVistas(this.sql, [...d.idsEnTurso, ...leido.delCorreo], ahoraMs);

		const libre = this.mesasLibres(d, alta.dia_ymd, alta.hora, alta.personas).some((m) => m.id_mesa === alta.id_mesa);
		if (!libre || leido.numero === null) return rechazo("mesa_no_disponible");

		const hoy = d.ahora.slice(0, 10);
		const lecturaDelCorreo = { ids: leido.delCorreo, vistasDesdeMs: leidaMs - MARGEN_LECTURA_MS };
		if (leido.delCorreo.size + vivasDelCorreoEnLaAgenda(this.sql, emailHash, hoy, lecturaDelCorreo) >= MAX_RESERVAS_POR_CORREO) {
			return rechazo("limite_reservas_correo");
		}
		if (altasDesde(this.sql, ahoraMs - 86_400_000) >= MAX_ALTAS_DIA_NEGOCIO) return rechazo("tope_reservas_negocio");

		const idReserva = nuevoId();
		// El enlace vale hasta un día después de la reserva. La hora es de pared del negocio y aquí se
		// lee como UTC: un día y medio de margen cubre cualquier desfase.
		const caducaMs = Date.parse(`${alta.dia_ymd}T${alta.hora}:00Z`) + 36 * 3_600_000;
		this.ctx.storage.transactionSync(() =>
			apuntarAlta(
				this.sql,
				{
					id_peticion: nuevoId(),
					tipo: "alta",
					id_reserva: idReserva,
					id_mesa: alta.id_mesa,
					dia_ymd: alta.dia_ymd,
					hora: alta.hora,
					comensales: alta.personas,
					email_hash: emailHash,
					datos_json: JSON.stringify({
						nombre: alta.nombre,
						email: alta.email,
						telefono: alta.telefono,
						nota: alta.nota,
					}),
					// La hora la pone quien escribe (0004): el alta ocurre aquí, y éste es el
					// `Created_At` que escribirá la Main.
					creada_local: d.ahora,
					creada_ms: ahoraMs,
					estado: "pendiente",
				},
				{ tokenHash, caducaMs },
			),
		);
		// ── Fin del bloque ──

		await this.asegurarAlarma();
		return {
			ok: true,
			id_reserva: idReserva,
			codigo: codigoDeReserva(idReserva),
			dia: alta.dia_ymd,
			hora: alta.hora,
			personas: alta.personas,
			mesa: leido.numero,
			token,
		};
	}

	/** El resumen para la página de cancelar. */
	async consultarEnlace(p: { tenantId: string; token: string }): Promise<ResultadoConsulta> {
		recordarNegocio(this.sql, p.tenantId);
		const idReserva = await this.reservaDelToken(p.token);
		if (!idReserva) return rechazo("enlace_no_valido");

		const { ahora, enTurso, numero } = await this.leerReserva(p.tenantId, idReserva);
		const alta = peticion(this.sql, "alta", idReserva);
		const datos = enTurso ?? (alta ? { dia: alta.dia_ymd, hora: alta.hora, personas: alta.comensales, id_mesa: alta.id_mesa } : null);
		if (!datos) return rechazo("enlace_no_valido");

		const estado = this.estadoPublico(idReserva, enTurso, ahora, datos);
		return {
			ok: true,
			dia: datos.dia,
			hora: datos.hora,
			personas: datos.personas,
			mesa: numero ?? "",
			estado,
			cancelable: estado === "confirmada",
		};
	}

	/**
	 * Cancelar desde el enlace, hasta la hora de la reserva. Si la Main todavía no la tiene, se anula
	 * aquí; si ya la tiene (o la está registrando), queda una cancelación para entregarle.
	 * Idempotente: cancelar dos veces es un `ok`.
	 */
	async cancelar(p: { tenantId: string; token: string }): Promise<ResultadoCancelar> {
		recordarNegocio(this.sql, p.tenantId);
		const idReserva = await this.reservaDelToken(p.token);
		if (!idReserva) return rechazo("enlace_no_valido");

		const { ahora, enTurso } = await this.leerReserva(p.tenantId, idReserva);
		// ── Síncrono hasta el final ──
		const ahoraMs = Date.now();
		if (enTurso) darPorVistas(this.sql, [idReserva], ahoraMs);
		const alta = peticion(this.sql, "alta", idReserva);
		const datos = enTurso ?? (alta ? { dia: alta.dia_ymd, hora: alta.hora, personas: alta.comensales, id_mesa: alta.id_mesa } : null);
		if (!datos) return rechazo("enlace_no_valido");

		const estado = this.estadoPublico(idReserva, enTurso, ahora, datos);
		if (estado === "cancelada") return { ok: true };
		if (estado === "pasada") return rechazo("reserva_no_cancelable");

		if (!enTurso && anularAlta(this.sql, idReserva, ahoraMs)) return { ok: true };
		apuntarCancelacion(this.sql, {
			id_peticion: nuevoId(),
			id_reserva: idReserva,
			id_mesa: datos.id_mesa,
			dia_ymd: datos.dia,
			hora: datos.hora,
			comensales: datos.personas,
			creada_local: ahora,
			creada_ms: ahoraMs,
		});
		await this.asegurarAlarma();
		return { ok: true };
	}

	/** Lo que ve quien abre el enlace. Síncrono. */
	private estadoPublico(
		idReserva: string,
		enTurso: ReservaEnTurso | null,
		ahora: string,
		datos: { dia: string; hora: string },
	): EstadoPublico {
		const alta = peticion(this.sql, "alta", idReserva);
		const cancelada =
			enTurso?.estado === "CANCELADA" ||
			alta?.estado === "anulada" ||
			// La Main no pudo registrarla: al cliente se le avisa por correo y deja de valer.
			alta?.estado === "fallida" ||
			// Estuvo en Turso y ya no está: el restaurante la borró, que es cancelarla.
			(!enTurso && alta?.estado === "vista") ||
			peticion(this.sql, "cancelacion", idReserva) !== null;
		if (cancelada) return "cancelada";
		// Sentados (ACTIVA), terminada o no se presentaron: ya no es una reserva por venir.
		if (enTurso && enTurso.estado !== "PROXIMA") return "pasada";
		// Hasta la hora de la reserva, en la hora del negocio.
		if (intervalo(datos.dia, datos.hora, 0).inicio <= ahora) return "pasada";
		return "confirmada";
	}

	private async reservaDelToken(token: string): Promise<string | null> {
		if (!TOKEN_RE.test(token)) return null;
		const hash = await sha256HexStr(token);
		return reservaDelEnlace(this.sql, hash, Date.now());
	}

	private async leerReserva(
		tenantId: string,
		idReserva: string,
	): Promise<{ ahora: string; enTurso: ReservaEnTurso | null; numero: string | null }> {
		return this.leer(tenantId, async (db, ahora) => {
			const rs = await db.execute({
				sql: `SELECT R.Dia_YMD AS dia, R.Hora AS hora, R.Comensales AS personas, R.ID_Mesa AS id_mesa,
				             R.Estado AS estado
				      FROM Reservas R WHERE R.ID_Reserva = ?1;`,
				args: [idReserva],
			});
			const r: any = rs.rows?.[0];
			const enTurso: ReservaEnTurso | null = r
				? { dia: String(r.dia), hora: String(r.hora), personas: Number(r.personas), id_mesa: r.id_mesa ?? null, estado: String(r.estado) }
				: null;
			const idMesa = enTurso?.id_mesa ?? peticion(this.sql, "alta", idReserva)?.id_mesa ?? null;
			const numero = idMesa ? await numeroDeMesa(db, idMesa) : null;
			return { ahora, enTurso, numero };
		});
	}

	/** Una sola alarma, reprogramada mientras haya algo guardado. */
	private async asegurarAlarma(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + CADA_ALARMA_MS);
		}
	}

	async alarm(): Promise<void> {
		const quedaAlgo = purgar(this.sql, Date.now());
		if (quedaAlgo) await this.ctx.storage.setAlarm(Date.now() + CADA_ALARMA_MS);
	}

	/** Sólo para diagnóstico y tests: de qué negocio es esta agenda. */
	negocio(): string | null {
		return negocioRecordado(this.sql);
	}
}
