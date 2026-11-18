// src/domains/pedidos_proveedor/pedidos_proveedor.schemas.ts
//
// Lo que acepta la nube de un pedido a un proveedor: lo mismo que la Main
// (`tpv_domain::pedidos_proveedor` y el caso de uso), con los mismos textos. Lo fija
// `crates/tpv-domain/src/validacion_casos.json` (`test/validacionCasos.test.ts`).

import * as z from "zod";

import { zDineroNoNegativoCon } from "../../lib/dinero";
import { recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	PedidosActualizarInput,
	PedidosCambiarEstadoInput,
	PedidosCrearInput,
	PedidosGetPageInput,
} from "@tpv/contracts";

/** Lo más que lleva un pedido (`MAX_LINEAS` en la Main): lo que admite el correo al proveedor. */
const MAX_LINEAS = 500;
/** Cuántos pedidos trae como mucho una página (`MAX_LIMIT` del caso de uso de la Main). */
const MAX_POR_PAGINA = 200;

// Los textos de `tpv_domain::pedidos_proveedor`.
const MSG_FALTA_EL_PEDIDO = "Falta el pedido.";
const MSG_DEMASIADAS_LINEAS = "Un pedido no puede llevar más de 500 líneas.";
const MSG_NOMBRE_DEL_PRODUCTO = "Escribe el nombre del producto.";
const MSG_CANTIDAD_NEGATIVA = "La cantidad no puede ser negativa.";
const MSG_PRECIO_NEGATIVO = "El precio no puede ser negativo.";
const MSG_ESTADO_DEL_PEDIDO = "Un pedido sólo se puede enviar o cancelar.";

/** Un texto opcional recortado; vacío es que no hay (`limpiar_opcional`). */
function limpia(v: unknown): string | null {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
}

const optStr = z.string().nullish().transform(limpia);

const lineaSchema = z.object({
	id_linea: z.string().overwrite(recortar),
	nombre_producto: z.string().overwrite(recortar).min(1, MSG_NOMBRE_DEL_PRODUCTO),
	cantidad: z.number().finite(MSG_CANTIDAD_NEGATIVA).min(0, MSG_CANTIDAD_NEGATIVA),
	precio_unitario: zDineroNoNegativoCon(MSG_PRECIO_NEGATIVO).nullish(),
	unidad: optStr,
});

/** La cabecera va antes que las líneas: es lo que mira primero la Main. */
export const pedidoCrearSchema = z.object({
	id_pedido: z.string().overwrite(recortar).min(1, MSG_FALTA_EL_PEDIDO),
	id_proveedor: optStr,
	email_destino: optStr,
	notas: optStr,
	lineas: z.array(lineaSchema).max(MAX_LINEAS, MSG_DEMASIADAS_LINEAS),
});

/** La edición: lo mismo, con el id del pedido en el camino (`PUT /:id`). */
export const pedidoActualizarSchema = pedidoCrearSchema.omit({ id_pedido: true });

/** El estado al que pasa un borrador, recortado (`estado_nuevo`). */
export const pedidoEstadoSchema = z.object({
	estado: z
		.string()
		.overwrite(recortar)
		.refine((v) => v === "enviado" || v === "cancelado", MSG_ESTADO_DEL_PEDIDO),
	fecha_envio: optStr,
});

/**
 * Una página: el tamaño se acota como en el caso de uso de la Main (de 1 a `MAX_POR_PAGINA`). Lo que
 * se busca va en el cuerpo (AUD-27); `textoABuscar` lo recorta y lo pliega en la consulta.
 */
export const pedidosPaginaSchema = z.object({
	limit: z
		.number()
		.int()
		.min(0)
		.transform((n) => Math.min(Math.max(n, 1), MAX_POR_PAGINA)),
	offset: z.number().int().min(0),
	search: z.string().nullish(),
});

export type PedidoCrearInput = z.infer<typeof pedidoCrearSchema>;
export type PedidoActualizarInput = z.infer<typeof pedidoActualizarSchema>;
export type PedidoEstadoInput = z.infer<typeof pedidoEstadoSchema>;

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
type _GCrear = Assert<SameKeys<PedidoCrearInput, PedidosCrearInput>>;
type _GActualizar = Assert<SameKeys<PedidoActualizarInput, Omit<PedidosActualizarInput, "id_pedido">>>;
type _GEstado = Assert<SameKeys<PedidoEstadoInput, Omit<PedidosCambiarEstadoInput, "id_pedido">>>;
type _GPagina = Assert<SameKeys<z.infer<typeof pedidosPaginaSchema>, PedidosGetPageInput>>;
type _GLinea = Assert<SameKeys<z.infer<typeof lineaSchema>, PedidosCrearInput["lineas"][number]>>;
