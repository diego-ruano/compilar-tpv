// El equipo de la tanda: quién es el negocio y con qué PIN se entra.
//
// La tanda estrena UN equipo y lo va pasando de recorrido en recorrido (ver las recetas de
// `wdio.conf.ts`): la venta lo estrena, las copias le rompen la base y lo recuperan, y el de la
// licencia se la anula al final. Así que estos datos no son de ningún recorrido: son del equipo, y
// todo el que entre en él tiene que usar los mismos.
//
// Viven aquí y no en el recorrido que los usa primero porque importar un fichero de recorrido **lo
// ejecuta**: sus `describe` se registran en quien lo importa. Ya pasó: el segundo tramo de copias
// acabó corriendo los pasos del primero contra un equipo que ya estaba estrenado, y el síntoma —"no
// aparece la pantalla de primer inicio"— no se parecía en nada a la causa.

export const NEGOCIO = "Bar E2E";

/** Distinto del 1234 del seed: así el login prueba el PIN elegido, no el sembrado. */
export const PIN = "4321";

/**
 * El obligado tributario. Desde FISCAL-01 un equipo que no sabe quién factura **no puede cobrar**,
 * así que declararlo es parte del estreno, como lo es en un bar de verdad.
 */
export const RAZON_SOCIAL = "Hostelería E2E SL";

/**
 * Con dígito de control válido: `datos_obligado` revalida el NIF en Rust y se niega a emitir con
 * uno que no cuadre, precisamente para que no vuelva como error admisible de la AEAT horas después.
 */
export const NIF = "B12345674";
