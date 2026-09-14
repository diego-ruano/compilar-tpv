// Lo que comparten los tres tramos del recorrido de copias.
//
// Vive aquí y no en el primer tramo porque importar un fichero de recorrido **lo ejecuta** (ver
// `equipo.ts`). Los datos del negocio y el PIN no están aquí: son del equipo de la tanda, que las
// copias reciben ya estrenado.

/** Lo que crea el primer tramo y buscan los otros dos después de cada avería. */
export const CATEGORIA = "Antes de la avería";
