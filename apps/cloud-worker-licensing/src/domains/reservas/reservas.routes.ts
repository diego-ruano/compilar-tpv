// src/domains/reservas/reservas.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";

import * as cmd from "./reservas.commands";
import * as q from "./reservas.queries";
import * as S from "./reservas.schemas";
import { badRequest } from "../../server/utils/response";
import { consulta, cuerpo } from "../../lib/validacion";
import { apply, lecturaPorPost, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const reservasRoutes = new Hono<Ctx>();

// AUD-27: lectura por POST (el teléfono y el correo de un cliente van en el cuerpo, no en la URL).
reservasRoutes.use("/buscar-cliente", lecturaPorPost());
reservasRoutes.use("*", tenantAuth, alHub);

reservasRoutes.get("/meta", async (c) =>
	c.json(await tenantQuery(c, (db) => q.meta(db))),
);

reservasRoutes.get("/mes", consulta(S.mesQuerySchema), async (c) => {
	const { desde, hasta } = c.req.valid("query");
	return c.json(await tenantQuery(c, (db) => q.mes(db, desde, hasta)));
});

// RI-61: ¿ese teléfono o ese email ya son de un cliente? La pantalla pregunta antes de asignarle la
// reserva. Sin ninguno de los dos no hay nada que buscar. Es una lectura, por POST (AUD-27).
reservasRoutes.post("/buscar-cliente", cuerpo(S.buscarClienteSchema), async (c) => {
	const { telefono, email } = c.req.valid("json");
	if (!telefono && !email) return c.json(null);
	return c.json(await tenantQuery(c, (db) => q.buscarCliente(db, telefono, email)));
});

// Una reserva, o `null`: la Handy la mira antes de cambiarla o borrarla, para saber si hay que
// avisar a su cliente (docs/estudios/reservas-web.md §5.7). Después de `/meta` y `/mes`, que si no
// se los comería.
reservasRoutes.get("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva_invalido");
	return c.json(await tenantQuery(c, (db) => q.reserva(db, id)));
});

reservasRoutes.post("/", cuerpo(S.reservaSaveSchema), async (c) => {
	const datos = c.req.valid("json");

	// RI-61: ¿se pisa con lo que ya ocupa la mesa (otra reserva o una comanda abierta)? Sin mesa no
	// ocupa nada. Con los solapes prohibidos no se guarda; con «avisar», sólo si llega confirmado.
	// La Main hace lo mismo dentro de su transacción. Aquí se mira para decir con qué choca, y el
	// comando lo vuelve a mirar dentro del lote que guarda la reserva (SYNC-30).
	const idMesa = datos.id_mesa;
	const solape = idMesa
		? await tenantQuery(c, async (db) => {
				const ajustes = await q.ajustesDeReserva(db);
				const texto = await q.choqueEnLaMesa(db, { ...datos, id_mesa: idMesa }, ajustes.duracion);
				return { ajustes, texto };
			})
		: null;
	if (solape?.texto && solape.ajustes.modo === "prohibir") {
		return c.json(
			{ error: "reserva_solapada_prohibida", message: `${solape.texto} ${q.MSG_SOLAPE_PROHIBIDO}` },
			409,
		);
	}
	if (solape?.texto && !datos.forzar_solape) {
		return c.json({ error: "reserva_solapada", message: solape.texto }, 409);
	}

	// RI-61: el cliente llega decidido (ninguno, uno existente o uno nuevo); aquí no se casa nada.
	const cliente = await tenantQuery(c, (db) => q.resolverCliente(db, datos));
	// Un email de un cliente nuevo que ya es de otro lo rechaza la guarda del comando (`email_duplicado`).
	if ("error" in cliente) return c.json({ error: cliente.error }, 404);
	const id = await apply(c, cmd.saveReserva(datos, cliente));
	return c.json({ ok: true, id_reserva: id });
});

// Borrar y cancelar (docs/estudios/reservas-web.md §5.6), como la Main: se decide aquí, al leerla, y
// se replica sólo la sentencia elegida, sin condición.
reservasRoutes.delete("/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva_invalido");
	// Una reserva web no se borra nunca: se cancela, y se queda.
	const r = await tenantQuery(c, (db) => q.estadoYOrigen(db, id));
	if (r?.origen === "WEB") return c.json({ error: "reserva_web_no_se_borra" }, 409);
	await apply(c, cmd.deleteReserva(id));
	return c.json({ ok: true });
});

// Cancela una reserva que aún no ha llegado. `cancelada: false` si ya no existe; una ya cancelada
// no se vuelve a escribir. Que aún no haya llegado lo decide la guarda del comando al aplicarlo
// (SYNC-30): si no, `reserva_no_pendiente`. El correo al cliente de una reserva web lo manda la
// Handy después (`POST /v1/reservas-web/avisos`), como con cualquier cambio suyo.
reservasRoutes.post("/:id/cancelar", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_reserva_invalido");
	const r = await tenantQuery(c, (db) => q.estadoYOrigen(db, id));
	if (!r) return c.json({ ok: true, cancelada: false });
	if (r.estado === "CANCELADA") return c.json({ ok: true, cancelada: true });
	await apply(c, cmd.cancelarReserva(id));
	return c.json({ ok: true, cancelada: true });
});
