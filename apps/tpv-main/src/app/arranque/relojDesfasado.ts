// src/app/arranque/relojDesfasado.ts
//
// RELOJ-01 — cuándo y qué dice la franja del reloj desfasado (`AvisoReloj.tsx`).
//
// Las firmas que van a la nube ya usan la hora de la nube (`tpv-infra-licensing/src/reloj.rs`), pero
// la hora del negocio —tickets, caja, fichajes— es la del equipo, a propósito: corregirla de golpe
// podría fechar una factura antes que la anterior. Lo que se hace es avisar, para que quien está
// delante la ajuste. Nada aquí corrige ninguna hora ni toca el cobro.

/** A partir de cuánto desfase se avisa. Por debajo, unos segundos o un par de minutos no se notan en
 * un ticket y la firma ya los corrige sola. */
export const UMBRAL_AVISO_RELOJ_MS = 5 * 60_000;

export type AvisoDelReloj = {
	/** Hacia dónde se ha ido la hora del equipo respecto a la de la nube. */
	sentido: "adelantada" | "atrasada";
	/** Cuánto, en palabras («7 minutos», «2 horas y 10 minutos», «3 días»). */
	cuanto: string;
};

/**
 * El aviso que toca, o `null` si no hay que enseñar nada: sin medida todavía, o con un desfase por
 * debajo del umbral.
 *
 * `desfaseMs` es lo que hay que sumarle a la hora del equipo para tener la de la nube (lo que da el
 * comando `reloj_desfase`): positivo, la del equipo va atrasada; negativo, adelantada.
 */
export function avisoDelReloj(desfaseMs: number | null | undefined): AvisoDelReloj | null {
	if (desfaseMs == null || !Number.isFinite(desfaseMs)) return null;
	if (Math.abs(desfaseMs) < UMBRAL_AVISO_RELOJ_MS) return null;
	return {
		sentido: desfaseMs > 0 ? "atrasada" : "adelantada",
		cuanto: duracionEnPalabras(Math.abs(desfaseMs)),
	};
}

function cuenta(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Una duración en español natural, con la unidad que se entiende de un vistazo: minutos por debajo de
 * una hora, horas (y minutos) por debajo de un día, y días (y horas) a partir de ahí.
 */
export function duracionEnPalabras(ms: number): string {
	const minutos = Math.round(Math.abs(ms) / 60_000);
	if (minutos < 60) return cuenta(minutos, "minuto", "minutos");

	if (minutos < 24 * 60) {
		const horas = Math.floor(minutos / 60);
		const resto = minutos % 60;
		const h = cuenta(horas, "hora", "horas");
		return resto === 0 ? h : `${h} y ${cuenta(resto, "minuto", "minutos")}`;
	}

	let dias = Math.floor(minutos / (24 * 60));
	let horas = Math.round((minutos % (24 * 60)) / 60);
	if (horas === 24) {
		dias += 1;
		horas = 0;
	}
	const d = cuenta(dias, "día", "días");
	return horas === 0 ? d : `${d} y ${cuenta(horas, "hora", "horas")}`;
}

/**
 * Cómo se pone en hora cada equipo: el PC de la Main (Windows) o el teléfono de la Handy. El PC puede
 * ser Windows 10 u 11 o Windows 7 (la rama `compilacion-windows-7` recibe este texto por merge), y
 * el camino no es el mismo: van los dos.
 */
function comoAjustarla(movil: boolean): string {
	return movil
		? "Ajústala en los ajustes del dispositivo: Fecha y hora, con la fecha y la hora automáticas."
		: "Ajústala sincronizándola con la hora de Internet. En Windows 10 y 11: Configuración → Hora e idioma → Fecha y hora → «Sincronizar ahora». En Windows 7: Panel de control → Fecha y hora → Hora de Internet → Cambiar la configuración → «Actualizar ahora».";
}

/** El texto entero de la franja. */
export function textoAvisoReloj(aviso: AvisoDelReloj, movil: boolean): string {
	return (
		`La hora de este equipo va ${aviso.cuanto} ${aviso.sentido}. ` +
		"Los tickets y la caja salen con la hora del equipo. " +
		comoAjustarla(movil)
	);
}
