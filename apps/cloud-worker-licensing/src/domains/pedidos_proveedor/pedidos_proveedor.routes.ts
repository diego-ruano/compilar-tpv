// src/domains/pedidos_proveedor/pedidos_proveedor.routes.ts
//
// Los pedidos a proveedores desde la Handy (PED-HANDY): la página con su búsqueda, crear, editar un
// borrador y enviarlo o cancelarlo. El correo al proveedor sale por `/v1/email/enviar-pedido`.

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";

import * as cmd from "./pedidos_proveedor.commands";
import * as q from "./pedidos_proveedor.queries";
import * as S from "./pedidos_proveedor.schemas";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, decidirPorEstado, lecturaPorPost, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const pedidosProveedorRoutes = new Hono<Ctx>();

// AUD-27: lo que se busca (un proveedor, unas notas) va en el cuerpo, no en la URL.
pedidosProveedorRoutes.use("/pagina", lecturaPorPost());
pedidosProveedorRoutes.use("*", tenantAuth, alHub);

pedidosProveedorRoutes.post("/pagina", cuerpo(S.pedidosPaginaSchema), async (c) => {
	// Desestructurado: `x.search` es, para el barrido de AUD-27, leer la query entera de una URL.
	const { limit, offset, search } = c.req.valid("json");
	return c.json(await tenantQuery(c, (db) => q.pagina(db, limit, offset, search ?? null)));
});

pedidosProveedorRoutes.post("/", cuerpo(S.pedidoCrearSchema), async (c) => {
	const datos = c.req.valid("json");
	const id = await apply(c, cmd.crear(datos));
	return c.json({ ok: true, id_pedido: id ?? datos.id_pedido });
});

// La guarda del comando decide si entra (`pedido_no_editable`): la ruta no mira el resultado.
pedidosProveedorRoutes.put("/:id", cuerpo(S.pedidoActualizarSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pedido_invalido");
	const datos = c.req.valid("json");
	await apply(c, cmd.actualizar(id, datos));
	return c.json({ ok: true });
});

// `cambiado`, como en la Main: si había un borrador que pasar a ese estado. Cuando no se sabe cuántas
// filas tocó (el reintento de una escritura cuyo recuento no se guardó), se mira cómo quedó.
pedidosProveedorRoutes.put("/:id/estado", cuerpo(S.pedidoEstadoSchema), async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_pedido_invalido");
	const datos = c.req.valid("json");
	const cambiado = await decidirPorEstado(await apply(c, cmd.cambiarEstado(id, datos)), async () =>
		(await tenantQuery(c, (db) => q.estadoDe(db, id))) === datos.estado,
	);
	return c.json({ ok: true, cambiado });
});
