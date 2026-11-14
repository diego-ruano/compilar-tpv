// test/helpers/horaDelCliente.ts
//
// «Ahora» tal y como lo manda un dispositivo (`X-Client-Now`), sacado del reloj de verdad. Una fecha
// escrita a mano en un test caduca: el worker rechaza la hora que se aleja de la suya más que la
// deriva admisible (`MAX_CLIENT_NOW_DRIFT_MS`, `tenantHub.tiempo.ts`), cae a la del servidor y las
// ventanas que el test espera dejan de casar al día siguiente.

/** Un instante como `AAAA-MM-DD HH:MM:SS`, el formato de las fechas de la base. */
export function comoFecha(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** «Ahora», al segundo, con el formato de `X-Client-Now`. */
export function ahoraDelCliente(): string {
	return comoFecha(Math.floor(Date.now() / 1000) * 1000);
}

/** `fecha` (`AAAA-MM-DD HH:MM:SS`) menos `horas` horas; para días, `24 * n`. */
export function antesDe(fecha: string, horas: number): string {
	return comoFecha(Date.parse(`${fecha.replace(" ", "T")}Z`) - horas * 3_600_000);
}
