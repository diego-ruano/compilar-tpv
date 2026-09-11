// Los datos que comparten los dos tramos del recorrido de copias.
//
// Viven aquí y no en el primer tramo porque importar un fichero de recorrido **lo ejecuta**: sus
// `describe` se registran en quien lo importa, y el segundo tramo acababa corriendo los pasos del
// primero contra un equipo que ya estaba estrenado. El síntoma era desconcertante —"no aparece la
// pantalla de primer inicio"— y la causa no estaba a la vista en ninguno de los dos ficheros.

export const NEGOCIO = "Bar E2E copias";
export const PIN = "5678";
export const CATEGORIA = "Antes de la avería";

/**
 * El obligado tributario del equipo de este recorrido.
 *
 * Desde FIS-01 un equipo recién estrenado que no sabe quién factura **no puede cobrar**, y lo dice
 * con un aviso a pantalla completa al entrar. Este recorrido no vende, pero ese aviso tapa el menú
 * igual, así que declararlo es parte de dejar el equipo utilizable — como lo es en un bar de verdad.
 */
export const RAZON_SOCIAL = "Copias E2E SL";
/** Con dígito de control válido: Rust revalida el NIF y se niega a guardarlo si no cuadra. */
export const NIF = "B12345674";
