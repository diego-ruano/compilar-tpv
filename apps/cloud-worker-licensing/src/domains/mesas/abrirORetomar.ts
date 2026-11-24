// src/domains/mesas/abrirORetomar.ts
//
// Abrir o retomar la mesa en un viaje (`POST /v1/mesas/comandas/abrir-o-retomar`): la comanda
// abierta de la mesa —creada si no hay ninguna, con el trabajador puesto si le faltaba y aún no
// tiene líneas— y sus líneas. Antes la Handy hacía cuatro peticiones seguidas al abrir una mesa: la
// comanda abierta, el permiso, abrirla o ponerle el trabajador, y las líneas. Espejo de
// `abrir_o_retomar_comanda` en la Main (`tpv-infra-sqlite/src/mesas.rs`), con caso de contrato.
//
// Va aparte de `mesas.commands.ts` porque lee antes de decidir qué escribir; lo que escribe son los
// constructores de siempre, `abrirComanda` y `setTrabajadorIfNull`.

import type { Base } from "../../lib/sql";

import * as cmd from "./mesas.commands";
import * as q from "./mesas.queries";
import type { AbrirComandaInput } from "./mesas.schemas";

/**
 * Lo que hay que escribir para abrir o retomar la mesa, o `null` si nada. Lo normal al volver a una
 * mesa es que ya tenga trabajador (o líneas): entonces no se escribe, porque una sentencia que no
 * cambia nada también se replica (su `Applied_Operations`, su `Sync_Changes`, el aviso a los demás
 * equipos y lo que releen).
 */
export async function planAbrirORetomar(db: Base, datos: AbrirComandaInput): Promise<cmd.BuiltCommand | null> {
	const abierta = await q.comandaAbiertaByMesa(db, datos.id_mesa);
	const idTrabajador = await q.resolveTrabajadorId(db, datos.id_trabajador_o_usuario);
	// MESA-10: sin autoenlace de reserva; si no viene una explícita, queda sin ella.
	if (!abierta) return cmd.abrirComanda(datos, idTrabajador, datos.id_reserva ?? null);
	if (!idTrabajador || !(await q.trabajadorPorPoner(db, abierta.id_comanda))) return null;
	return cmd.setTrabajadorIfNull(
		{ id_comanda: abierta.id_comanda, id_trabajador_o_usuario: datos.id_trabajador_o_usuario },
		idTrabajador,
	);
}
