// src/domains/mesas/reservaEnElPlano.ts
//
// MESAS-02: qué reserva enseña cada mesa del plano de la Handy. Espejo de `estado_en_el_plano` y
// `reserva_de_cada_mesa` en la Main (`tpv-domain/src/reservas.rs`), con los casos que comparten en
// `crates/tpv-domain/src/plano_reservas_casos.json`. Va fuera de `mesas.queries.ts` porque no lee
// nada: decide con lo leído.

import { esFechaYmd } from "../../lib/fechas";
import { recortar } from "../../lib/texto";
import { horaLocalEn } from "../reservas_web/horaDelNegocio";

/** Cuántos minutos antes de su hora sale una reserva en el plano. `PLANO_ANTELACION_MIN`. */
const ANTELACION_MIN = 60;

/** Lo que dura una reserva sin duración propia ni del negocio. `DURACION_POR_DEFECTO_MIN`. */
export const DURACION_POR_DEFECTO_MIN = 120;

/** Una reserva viva con mesa, tal como la lee el plano. */
export type ReservaDeMesa = {
	id_mesa: string;
	id_reserva: string;
	cliente: string;
	dia_ymd: string;
	hora: string;
	estado: string;
	/** La suya o, si no tiene, la del negocio. Sin un valor positivo, la de por defecto. */
	duracion_min: number | null;
};

export type ReservaEnElPlano = {
	reserva: ReservaDeMesa;
	estado: "ACTIVA" | "PROXIMA";
	minutos_para: number;
};

/** Una hora local, en milisegundos como si fuera UTC, a un instante; `null` si no existe. */
export type Instante = (local: number) => number | null;

/**
 * Si una reserva sale en el plano y con qué estado. Una sentada sale hasta que se va; una que aún no
 * ha llegado, desde una hora antes hasta que acaba su hueco, y sigue siendo «por llegar».
 */
function estadoEnElPlano(estado: string, minutosPara: number, duracionMin: number): "ACTIVA" | "PROXIMA" | null {
	const e = recortar(estado).toUpperCase();
	if (e === "ACTIVA") return "ACTIVA";
	const enSuHueco = minutosPara <= ANTELACION_MIN && minutosPara > -duracionMin;
	return e === "PROXIMA" && enSuHueco ? "PROXIMA" : null;
}

const HORA = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const FECHA_Y_HORA = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/** Un día y una hora locales, en milisegundos como si fueran UTC; `null` si no valen. */
function horaLocal(dia: string, hora: string): number | null {
	const h = HORA.exec(hora);
	if (!esFechaYmd(dia) || !h) return null;
	const [a, m, d] = dia.split("-").map(Number);
	return Date.UTC(a, m - 1, d, Number(h[1]), Number(h[2]), Number(h[3] ?? 0));
}

/** `YYYY-MM-DD HH:MM:SS` (la hora local de la Handy) como `horaLocal`; `null` si no lo es. */
export function horaLocalDeTexto(texto: string): number | null {
	const f = FECHA_Y_HORA.exec(texto);
	return f ? horaLocal(f[1], f[2]) : null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Los instantes de una hora local de `zona`: uno, dos si se repite al retrasar el reloj, ninguno si
 * se salta al adelantarlo. El desfase de un instante sale de `Intl`; el de una hora local, de los
 * que hay un día antes y un día después, quedándose con los que cuadran.
 */
function instantesEnZona(zona: string): (local: number) => number[] {
	const desfase = (ms: number) => (horaLocalDeTexto(horaLocalEn(zona, ms)) ?? ms) - ms;
	return (local) =>
		[...new Set([desfase(local - DIA_MS), desfase(local + DIA_MS)])]
			.map((d) => local - d)
			.filter((t) => desfase(t) === local - t);
}

/** Las horas de las reservas: de una que se repite, la primera, como `earliest` de chrono en la Main. */
export function instanteEnZona(zona: string): Instante {
	const instantes = instantesEnZona(zona);
	return (local) => {
		const candidatos = instantes(local);
		return candidatos.length ? Math.min(...candidatos) : null;
	};
}

/**
 * «Ahora», de la hora local de la Handy (`X-Client-Now`). Esa cabecera no lleva desfase, así que en
 * la hora que se repite no dice en cuál de las dos está: de las dos, la más cercana al reloj del
 * worker, que distan una hora y el de la Handy va con minutos. Sin ninguna (un reloj en la hora que
 * se salta), el del worker.
 */
export function ahoraEnZona(zona: string, local: number, reloj = Date.now()): number {
	const candidatos = instantesEnZona(zona)(local);
	if (!candidatos.length) return reloj;
	return candidatos.reduce((a, b) => (Math.abs(b - reloj) < Math.abs(a - reloj) ? b : a));
}

/**
 * La reserva que enseña cada mesa: la sentada antes que ninguna y, si no, la más cercana a ahora; a
 * la misma distancia, la de identificador menor. `ahora` es un instante en milisegundos, e
 * `instante` pasa a uno la hora local de cada reserva. Los minutos se truncan hacia cero.
 */
export function reservaDeCadaMesa(
	reservas: ReservaDeMesa[],
	ahora: number,
	instante: Instante,
): Map<string, ReservaEnElPlano> {
	const porMesa = new Map<string, ReservaEnElPlano>();
	const antes = (x: ReservaEnElPlano, y: ReservaEnElPlano): boolean => {
		const sx = x.estado === "ACTIVA";
		const sy = y.estado === "ACTIVA";
		if (sx !== sy) return sx;
		const dx = Math.abs(x.minutos_para);
		const dy = Math.abs(y.minutos_para);
		if (dx !== dy) return dx < dy;
		return x.reserva.id_reserva < y.reserva.id_reserva;
	};

	for (const reserva of reservas) {
		if (!reserva.id_mesa || !reserva.id_reserva) continue;
		const local = horaLocal(recortar(reserva.dia_ymd), recortar(reserva.hora));
		const t = local === null ? null : instante(local);
		if (t === null) continue;
		// `|| 0`: un -0 es un 0.
		const minutos = Math.trunc((t - ahora) / 60_000) || 0;
		const duracion = reserva.duracion_min !== null && reserva.duracion_min > 0 ? reserva.duracion_min : DURACION_POR_DEFECTO_MIN;
		const estado = estadoEnElPlano(reserva.estado, minutos, duracion);
		if (!estado) continue;
		const candidata: ReservaEnElPlano = { reserva, estado, minutos_para: minutos };
		const actual = porMesa.get(reserva.id_mesa);
		if (!actual || antes(candidata, actual)) porMesa.set(reserva.id_mesa, candidata);
	}
	return porMesa;
}
