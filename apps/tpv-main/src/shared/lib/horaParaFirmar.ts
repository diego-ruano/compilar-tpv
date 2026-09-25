// src/shared/lib/horaParaFirmar.ts
//
// PROD-04: la hora con la que el frontend firma lo que manda a la nube (el saludo del WebSocket y el
// emparejamiento de la Handy). No es `Date.now()`: la nube rechaza cualquier firma cuya hora se
// aparte más de 2 minutos de la suya, y un PC de bar que deja de sincronizar la hora llega a ese
// margen en unas semanas sin que nada lo avise. Rust la corrige con la hora que trae cada respuesta
// del worker (`tpv-infra-licensing/src/reloj.rs`) y aquí sólo se le pregunta.
//
// Sólo para FIRMAR. La hora de lo que se guarda (ventas, fichajes, caja) sigue siendo la del equipo.

/** El IPC con Rust. Se recibe en vez de importarse para que los tests lo sustituyan. */
type Invocar = (comando: string) => Promise<unknown>;

/**
 * La hora de la nube en ms. Si Rust no contesta con un número, la del equipo: firmar con ella es lo
 * que se hacía antes, y con el reloj en hora —el caso normal— es exactamente lo mismo.
 */
export async function horaParaFirmar(invocar: Invocar): Promise<number> {
	try {
		const ms = Number(await invocar("device_hora_para_firmar"));
		if (Number.isFinite(ms) && ms > 0) return ms;
	} catch {
		/* se firma con la del equipo */
	}
	return Date.now();
}
