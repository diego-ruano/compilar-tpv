// src/durableObjects/agendaWeb.fila.ts
//
// Las llamadas que la agenda de reservas web está atendiendo y la retirada del negocio, puestas en
// fila.
//
// Un alta lee la base del negocio y apunta después (`MotorAgendaWeb.reservar`). Si el borrado se
// colara en esa espera, el alta apuntaría detrás de él: la agenda de un negocio ya retirado volvería
// a guardar el nombre, el correo y el teléfono de quien reservó, con su alarma. Así que la retirada
// espera a lo que está a medias, y lo que llega mientras se borra espera a que acabe y encuentra la
// agenda vacía.
//
// Lo que guarda vive lo que vive la instancia del objeto, que es lo que vive una llamada a medias:
// al despertar no hay nada que recordar.

/**
 * Lo que la retirada espera, como mucho, a que acabe lo que la agenda tiene a medias. Una llamada
 * son un par de lecturas del `TenantHub` y, las menos, un correo: si no ha acabado en este tiempo,
 * la retirada falla (`agenda_ocupada`) y el negocio se queda para el siguiente intento.
 */
const ESPERA_POR_LO_QUE_ESTA_A_MEDIAS_MS = 10_000;

export class Fila {
	private readonly enCurso = new Set<Promise<unknown>>();
	private retirada: Promise<void> | null = null;

	constructor(private readonly esperaMs: number = ESPERA_POR_LO_QUE_ESTA_A_MEDIAS_MS) {}

	/** Atiende una llamada, y la apunta mientras dura. */
	async atender<T>(llamar: () => Promise<T>): Promise<T> {
		while (this.retirada) await this.retirada.catch(() => {});
		const llamada = llamar();
		this.enCurso.add(llamada);
		try {
			return await llamada;
		} finally {
			this.enCurso.delete(llamada);
		}
	}

	/** Borra cuando no queda nada a medias. Dos retiradas a la vez van una detrás de otra. */
	async retirar(borrar: () => Promise<void>): Promise<void> {
		while (this.retirada) await this.retirada.catch(() => {});
		const retirada = this.trasLoQueEstaAMedias(borrar);
		this.retirada = retirada;
		try {
			await retirada;
		} finally {
			if (this.retirada === retirada) this.retirada = null;
		}
	}

	private async trasLoQueEstaAMedias(borrar: () => Promise<void>): Promise<void> {
		// Hasta el primer `await` no corre nada más: lo que hay en curso es todo lo que hay, y lo
		// que llegue desde ahora espera en `atender`.
		const aMedias = [...this.enCurso];
		if (aMedias.length) {
			let reloj: ReturnType<typeof setTimeout> | undefined;
			const tope = new Promise<"tope">((resolver) => {
				reloj = setTimeout(() => resolver("tope"), this.esperaMs);
			});
			const fin = await Promise.race([Promise.allSettled(aMedias).then(() => "fin" as const), tope]);
			clearTimeout(reloj);
			if (fin === "tope") throw new Error("agenda_ocupada");
		}
		await borrar();
	}
}
