// Los datos que comparten los dos tramos del recorrido de copias.
//
// Viven aquí y no en el primer tramo porque importar un fichero de recorrido **lo ejecuta**: sus
// `describe` se registran en quien lo importa, y el segundo tramo acababa corriendo los pasos del
// primero contra un equipo que ya estaba estrenado. El síntoma era desconcertante —"no aparece la
// pantalla de primer inicio"— y la causa no estaba a la vista en ninguno de los dos ficheros.

export const NEGOCIO = "Bar E2E copias";
export const PIN = "5678";
export const CATEGORIA = "Antes de la avería";
