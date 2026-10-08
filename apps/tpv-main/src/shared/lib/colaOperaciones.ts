/** Ordena las escrituras de una comanda. Un fallo no cancela las siguientes peticiones. */
export function crearColaOperaciones(alCambiar: (pendientes: number) => void = () => {}) {
    let cola: Promise<unknown> = Promise.resolve();
    let pendientes = 0;
    return {
        pendientes: () => pendientes,
        esperar: async () => { await cola; },
        ejecutar<T>(operacion: () => Promise<T>): Promise<T> {
            alCambiar(++pendientes);
            const resultado = cola.then(operacion).finally(() => { alCambiar(--pendientes); });
            cola = resultado.catch(() => {});
            return resultado;
        },
    };
}
