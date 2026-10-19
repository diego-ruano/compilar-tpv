// La lógica del widget que no necesita React: las horas que se ofrecen, el calendario, las fechas
// en español. Lo que decide si se puede reservar está en el worker; esto sólo pinta lo que dice.

export type Tramo = { desde: string; hasta: string };

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * ¿Se puede llegar a esa hora? La hora la elige el cliente al minuto (§1 del plan), dentro de los
 * tramos del día, los dos extremos incluidos. `HH:MM` se compara como texto.
 */
export function horaEnTramos(tramos: Tramo[], hora: string): boolean {
	return HORA.test(hora) && tramos.some((t) => t.desde <= hora && hora <= t.hasta);
}

/** La hora con la que empieza el campo: la que ya había si vale ese día, o la primera del día. */
export function horaInicial(tramos: Tramo[], anterior: string): string {
	if (horaEnTramos(tramos, anterior)) return anterior;
	return [...tramos].sort((a, b) => (a.desde < b.desde ? -1 : 1))[0]?.desde ?? "";
}

/** «de 19:40 a 21:50 y de 13:00 a 15:20», en orden. */
export function textoDeTramos(tramos: Tramo[]): string {
	return [...tramos]
		.sort((a, b) => (a.desde < b.desde ? -1 : 1))
		.map((t) => `de ${t.desde} a ${t.hasta}`)
		.join(" y ");
}

/** `2026-10-24` → { año, mes (0-11), día }. */
function partes(ymd: string) {
	return { anio: Number(ymd.slice(0, 4)), mes: Number(ymd.slice(5, 7)) - 1, dia: Number(ymd.slice(8, 10)) };
}

function ymd(anio: number, mes: number, dia: number): string {
	return `${anio}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export type Mes = { anio: number; mes: number };

export function mesDe(dia: string): Mes {
	const p = partes(dia);
	return { anio: p.anio, mes: p.mes };
}

export function mesSiguiente(m: Mes, salto: number): Mes {
	const total = m.anio * 12 + m.mes + salto;
	return { anio: Math.floor(total / 12), mes: total % 12 };
}

/**
 * Las semanas de un mes para pintar el calendario, de lunes a domingo: cada hueco es un día
 * `YYYY-MM-DD` o `null` (los de antes del 1 y después del último).
 */
export function semanasDelMes(m: Mes): (string | null)[][] {
	const primero = new Date(Date.UTC(m.anio, m.mes, 1));
	const huecosAntes = (primero.getUTCDay() + 6) % 7;
	const diasDelMes = new Date(Date.UTC(m.anio, m.mes + 1, 0)).getUTCDate();
	const celdas: (string | null)[] = Array.from({ length: huecosAntes }, () => null);
	for (let d = 1; d <= diasDelMes; d++) celdas.push(ymd(m.anio, m.mes, d));
	while (celdas.length % 7) celdas.push(null);
	const semanas: (string | null)[][] = [];
	for (let i = 0; i < celdas.length; i += 7) semanas.push(celdas.slice(i, i + 7));
	return semanas;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function nombreDelMes(m: Mes): string {
	return `${MESES[m.mes]} ${m.anio}`;
}

/** «vie 24 oct». */
export function diaCorto(dia: string): string {
	const p = partes(dia);
	const semana = new Date(Date.UTC(p.anio, p.mes, p.dia)).getUTCDay();
	return `${DIAS[semana]} ${p.dia} ${MESES[p.mes].slice(0, 3)}`;
}

/** «viernes, 24 de octubre». */
export function diaLargo(dia: string): string {
	const p = partes(dia);
	const semana = new Date(Date.UTC(p.anio, p.mes, p.dia)).getUTCDay();
	return `${DIAS_LARGOS[semana]}, ${p.dia} de ${MESES[p.mes]}`;
}

export function personasTexto(n: number): string {
	return n === 1 ? "1 persona" : `${n} personas`;
}

/** Lo que dice la dirección del widget: la clave del negocio, qué pantalla y el token del enlace. */
export type Ruta = { clave: string; vista: "reservar" | "cancelar"; token: string | null };

export function leerRuta(pathname: string, hash: string): Ruta | null {
	const m = /\/reservas-web\/v1\/w\/([^/]+)(\/cancelar)?\/?$/.exec(pathname);
	if (!m) return null;
	const token = new URLSearchParams(hash.replace(/^#/, "")).get("t");
	return { clave: decodeURIComponent(m[1]), vista: m[2] ? "cancelar" : "reservar", token };
}
