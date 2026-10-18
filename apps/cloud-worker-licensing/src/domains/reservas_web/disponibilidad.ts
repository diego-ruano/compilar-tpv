// src/domains/reservas_web/disponibilidad.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.3): qué días, qué horas y qué mesas se
// pueden reservar. Todo puro, sin Turso ni el SQLite de la agenda: recibe lo leído y decide. Lo usan
// las rutas públicas (`/negocio`, `/dia`) y la agenda (`disponibles`, `reservar`), así que el
// criterio es uno solo.
//
// Las horas son de reloj de pared en la zona del negocio, como las guarda `Reservas` (`Dia_YMD`,
// `Hora`), y los instantes van en el formato de `datetime()` de SQLite (`YYYY-MM-DD HH:MM:SS`): así
// se comparan como texto, igual que en `SQL_CHOQUE_RESERVA`, y lo que llega de Turso ya viene así.

/** Los ajustes de `Business_Settings` que mira la reserva web. */
export type AjustesWeb = {
	activa: boolean;
	diasMin: number;
	diasMax: number;
	/** Tolerancia de la franja, en minutos, por cada extremo. */
	margenMin: number;
	/** Para N personas, mesas de N a N + margenPlazas. */
	margenPlazas: number;
	/** `Reserva_Duracion_Min`: lo que ocupa la mesa una reserva web. */
	duracion: number;
	zona: string;
};

/** Una fila de `Reserva_Web_Franjas`. */
export type FranjaWeb = {
	id_mesa: string;
	/** Máscara: 1 lunes, 2 martes, 4 miércoles … 64 domingo. */
	dias_semana: number;
	fecha_desde: string | null;
	fecha_hasta: string | null;
	hora_desde: string;
	hora_hasta: string;
};

/** Una mesa reservable desde la web: activa, con su zona activa y la casilla marcada. */
export type MesaWeb = { id_mesa: string; capacidad: number };

/** Lo que ocupa una mesa: `[inicio, fin)`, en el formato de `datetime()`. */
export type Ocupacion = { id_mesa: string; inicio: string; fin: string };

/** Un tramo de horas de llegada válidas, los dos extremos incluidos. */
export type Tramo = { desde: string; hasta: string };

export type MotivoDia = "reserva_web_cerrada" | "dia_no_reservable";

const MINUTOS_DIA = 24 * 60;

function dosCifras(n: number): string {
	return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` + `n` días. El día tiene que estar validado. */
export function sumarDias(dia: string, n: number): string {
	const t = Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000;
	return new Date(t).toISOString().slice(0, 10);
}

/** El bit del día de la semana en la máscara de las franjas: 1 el lunes … 64 el domingo. */
export function bitDelDia(dia: string): number {
	const domingoCero = new Date(`${dia}T00:00:00Z`).getUTCDay();
	return 1 << ((domingoCero + 6) % 7);
}

/** `HH:MM` → minutos desde las 00:00. */
function minutos(hora: string): number {
	return Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));
}

/** Minutos desde las 00:00 → `HH:MM`. Tiene que estar en el día. */
function hora(min: number): string {
	return `${dosCifras(Math.floor(min / 60))}:${dosCifras(min % 60)}`;
}

/** `[dia hora, + duracion)` en el formato de `datetime()`. Cruza la medianoche si toca. */
export function intervalo(dia: string, horaHHMM: string, duracion: number): { inicio: string; fin: string } {
	const inicioMs = Date.parse(`${dia}T${horaHHMM}:00Z`);
	const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
	return { inicio: fmt(inicioMs), fin: fmt(inicioMs + duracion * 60_000) };
}

/** ¿Se pisan dos intervalos? El fin no cuenta: una que acaba a las 21:00 deja libre las 21:00. */
export function seCruzan(a: { inicio: string; fin: string }, b: { inicio: string; fin: string }): boolean {
	return a.inicio < b.fin && a.fin > b.inicio;
}

/** El primer y el último día que se pueden reservar, con «hoy» en la zona del negocio. */
export function horizonte(hoy: string, ajustes: AjustesWeb): { primero: string; ultimo: string } {
	return { primero: sumarDias(hoy, ajustes.diasMin), ultimo: sumarDias(hoy, ajustes.diasMax) };
}

/** Por qué no se puede reservar ese día, o `null` si se puede (sin mirar todavía las franjas). */
export function motivoDelDia(
	dia: string,
	hoy: string,
	ajustes: AjustesWeb,
	cierres: ReadonlySet<string>,
): MotivoDia | null {
	if (!ajustes.activa) return "reserva_web_cerrada";
	const { primero, ultimo } = horizonte(hoy, ajustes);
	if (dia < primero || dia > ultimo || cierres.has(dia)) return "dia_no_reservable";
	return null;
}

/** ¿Vale la franja para ese día? El día de la semana está en la máscara y cae entre sus fechas. */
export function franjaValeElDia(f: FranjaWeb, dia: string): boolean {
	if ((f.dias_semana & bitDelDia(dia)) === 0) return false;
	if (f.fecha_desde && dia < f.fecha_desde) return false;
	if (f.fecha_hasta && dia > f.fecha_hasta) return false;
	return true;
}

/**
 * Las horas de llegada que caben en la franja: la reserva entera dentro, con la tolerancia por cada
 * lado (`Hora_Desde − margen ≤ H` y `H + duración ≤ Hora_Hasta + margen`). En minutos del día, y
 * recortado al día: la llegada es de ese día aunque la reserva acabe pasada la medianoche.
 */
export function llegadasDeLaFranja(f: FranjaWeb, ajustes: AjustesWeb): [number, number] | null {
	const desde = Math.max(0, minutos(f.hora_desde) - ajustes.margenMin);
	const hasta = Math.min(MINUTOS_DIA - 1, minutos(f.hora_hasta) + ajustes.margenMin - ajustes.duracion);
	return desde <= hasta ? [desde, hasta] : null;
}

/** ¿Cabe una llegada a esa hora en alguna de estas franjas? */
function cabe(franjas: FranjaWeb[], dia: string, h: number, ajustes: AjustesWeb): boolean {
	return franjas.some((f) => {
		if (!franjaValeElDia(f, dia)) return false;
		const tramo = llegadasDeLaFranja(f, ajustes);
		return tramo !== null && tramo[0] <= h && h <= tramo[1];
	});
}

/**
 * Los tramos de llegada de un día: la unión de los de cada franja de las mesas reservables, con los
 * que se tocan o se solapan juntos.
 */
export function tramosDelDia(mesas: MesaWeb[], franjas: FranjaWeb[], dia: string, ajustes: AjustesWeb): Tramo[] {
	const reservables = new Set(mesas.map((m) => m.id_mesa));
	const sueltos = franjas
		.filter((f) => reservables.has(f.id_mesa) && franjaValeElDia(f, dia))
		.map((f) => llegadasDeLaFranja(f, ajustes))
		.filter((t): t is [number, number] => t !== null)
		.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

	const unidos: [number, number][] = [];
	for (const t of sueltos) {
		const ultimo = unidos[unidos.length - 1];
		if (ultimo && t[0] <= ultimo[1] + 1) ultimo[1] = Math.max(ultimo[1], t[1]);
		else unidos.push([t[0], t[1]]);
	}
	return unidos.map(([d, h]) => ({ desde: hora(d), hasta: hora(h) }));
}

/** ¿Está la hora dentro de algún tramo? */
export function horaEnTramos(tramos: Tramo[], horaHHMM: string): boolean {
	return tramos.some((t) => t.desde <= horaHHMM && horaHHMM <= t.hasta);
}

/**
 * Las mesas que valen para N personas a esa hora, sin mirar si están libres: capacidad de N a
 * N + margen, y alguna de sus franjas vale ese día y contiene la reserva entera.
 */
export function mesasAdecuadas(
	mesas: MesaWeb[],
	franjas: FranjaWeb[],
	dia: string,
	horaHHMM: string,
	personas: number,
	ajustes: AjustesWeb,
): MesaWeb[] {
	const h = minutos(horaHHMM);
	return mesas.filter(
		(m) =>
			m.capacidad >= personas &&
			m.capacidad <= personas + ajustes.margenPlazas &&
			cabe(
				franjas.filter((f) => f.id_mesa === m.id_mesa),
				dia,
				h,
				ajustes,
			),
	);
}

/** De esas mesas, las que no pisan nada de lo que ya las ocupa. */
export function libres(
	candidatas: MesaWeb[],
	ocupaciones: Ocupacion[],
	dia: string,
	horaHHMM: string,
	duracion: number,
): MesaWeb[] {
	const pedida = intervalo(dia, horaHHMM, duracion);
	return candidatas.filter(
		(m) => !ocupaciones.some((o) => o.id_mesa === m.id_mesa && seCruzan(o, pedida)),
	);
}

/** Los saltos que se prueban para ofrecer otra hora, del más cercano al más lejano. */
const SALTOS = [15, -15, 30, -30, 45, -45, 60, -60];
const MAX_ALTERNATIVAS = 4;

/**
 * Si no queda mesa a esa hora, hasta cuatro horas cercanas (±15, 30, 45 y 60 minutos) del mismo día
 * que sí tienen, ordenadas. `tieneMesa` decide por cada hora.
 */
export function alternativas(horaHHMM: string, tieneMesa: (h: string) => boolean): string[] {
	const h = minutos(horaHHMM);
	const elegidas: string[] = [];
	for (const salto of SALTOS) {
		const otra = h + salto;
		if (otra < 0 || otra >= MINUTOS_DIA) continue;
		if (tieneMesa(hora(otra))) elegidas.push(hora(otra));
		if (elegidas.length === MAX_ALTERNATIVAS) break;
	}
	return elegidas.sort();
}

/**
 * Los días del horizonte en los que alguien podría reservar: sin cierre y con algún tramo de
 * llegada. Sirve para el calendario del widget.
 */
export function diasAbiertos(
	hoy: string,
	ajustes: AjustesWeb,
	cierres: ReadonlySet<string>,
	mesas: MesaWeb[],
	franjas: FranjaWeb[],
): string[] {
	if (!ajustes.activa) return [];
	const { primero, ultimo } = horizonte(hoy, ajustes);
	const dias: string[] = [];
	for (let d = primero; d <= ultimo; d = sumarDias(d, 1)) {
		if (!cierres.has(d) && tramosDelDia(mesas, franjas, d, ajustes).length > 0) dias.push(d);
	}
	return dias;
}

/** La mayor mesa que se puede reservar: el tope de personas del widget. */
export function maxPersonas(mesas: MesaWeb[], franjas: FranjaWeb[]): number {
	const conFranja = new Set(franjas.map((f) => f.id_mesa));
	return mesas.filter((m) => conFranja.has(m.id_mesa)).reduce((max, m) => Math.max(max, m.capacidad), 0);
}
