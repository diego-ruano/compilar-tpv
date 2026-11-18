// src/domains/pedidos_proveedor/pedidos_proveedor.queries.ts
//
// LECTURAS de los pedidos a proveedores. Espejo de `get_page` en la Main
// (`tpv-infra-sqlite/src/pedidos_proveedor.rs`): las mismas filas, en el mismo orden y con el mismo
// techo. Lo fija el arnés de lectura (`tests/contract/lecturas/casos/pedidos_proveedor/`).

import type { Client } from "@libsql/client/web";

import type { LineaPedidoDto, PedidoProveedorDto, PedidosPageDto } from "@tpv/contracts";

import { normalizada, textoABuscar } from "../../lib/busqueda";
import { deLaBase } from "../../lib/dinero";
import { recortar } from "../../lib/texto";

/**
 * Cuántas líneas lleva como mucho una página, sumadas las de todos sus pedidos
 * (`TECHO_LINEAS_PAGINA` en la Main). Se corta antes del pedido que lo pasaría, y siempre va al
 * menos uno: el siguiente sale en la página de después.
 */
export const TECHO_LINEAS_PAGINA = 2000;

/** El nombre del proveedor: el actual si sigue, y si se borró, la copia que guardó el pedido. */
const NOMBRE_DEL_PROVEEDOR = "COALESCE(pr.Nombre_Empresa, p.Nombre_Proveedor)";

function filas(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

/** Un texto opcional como lo lee la Main (`norm_opt_string`): recortado, y vacío es que no hay. */
function opcional(v: unknown): string | null {
	if (v == null) return null;
	const t = recortar(String(v));
	return t.length ? t : null;
}

/**
 * Una página de pedidos, lo más reciente primero (la clave desempata), con sus líneas. `search`
 * busca en el proveedor, el correo, las notas y el estado, sin acentos ni mayúsculas y tal cual se
 * escribe (`%` y `_` no son comodines). `total` es cuántos pedidos casan con la búsqueda.
 */
export async function pagina(
	db: Client,
	limit: number,
	offset: number,
	search: string | null,
): Promise<PedidosPageDto> {
	const texto = textoABuscar(search);
	const en = (col: string) => `instr(${normalizada(col)}, ?1) > 0`;
	const donde = texto
		? ` WHERE ${en(NOMBRE_DEL_PROVEEDOR)} OR ${en("p.Email_Destino")} OR ${en("p.Notas")} OR ${en("p.Estado")}`
		: "";
	const argsBusqueda = texto ? [texto] : [];
	const base = argsBusqueda.length;

	const [rsTotal, rsPedidos] = await db.batch(
		[
			{
				sql: `SELECT COUNT(*) AS total FROM Pedidos_Proveedor p
					LEFT JOIN Proveedores pr ON pr.ID_Proveedor = p.ID_Proveedor${donde};`,
				args: argsBusqueda,
			},
			{
				sql: `SELECT p.ID_Pedido AS id_pedido, p.ID_Proveedor AS id_proveedor,
						${NOMBRE_DEL_PROVEEDOR} AS nombre_proveedor, p.Email_Destino AS email_destino,
						p.Estado AS estado, p.Fecha_Creacion AS fecha_creacion, p.Fecha_Envio AS fecha_envio,
						p.Notas AS notas,
						(SELECT COUNT(*) FROM Lineas_Pedido_Proveedor l WHERE l.ID_Pedido = p.ID_Pedido) AS n_lineas
					FROM Pedidos_Proveedor p
					LEFT JOIN Proveedores pr ON pr.ID_Proveedor = p.ID_Proveedor${donde}
					ORDER BY p.Fecha_Creacion DESC, p.ID_Pedido DESC LIMIT ?${base + 1} OFFSET ?${base + 2};`,
				args: [...argsBusqueda, limit, offset],
			},
		],
		"read",
	);
	const total = Number(filas(rsTotal)[0]?.total ?? 0);

	const pedidos: PedidoProveedorDto[] = [];
	let lineasEnLaPagina = 0;
	for (const f of filas(rsPedidos)) {
		const lineas = Number(f.n_lineas ?? 0);
		if (pedidos.length > 0 && lineasEnLaPagina + lineas > TECHO_LINEAS_PAGINA) break;
		lineasEnLaPagina += lineas;
		pedidos.push({
			id_pedido: String(f.id_pedido ?? ""),
			id_proveedor: opcional(f.id_proveedor),
			nombre_proveedor: opcional(f.nombre_proveedor),
			email_destino: opcional(f.email_destino),
			estado: String(f.estado ?? ""),
			fecha_creacion: String(f.fecha_creacion ?? ""),
			fecha_envio: opcional(f.fecha_envio),
			notas: opcional(f.notas),
			lineas: [],
		});
	}
	if (pedidos.length === 0) return { pedidos, total };

	// Las líneas sólo de los pedidos de esta página, con sus ids en un único parámetro JSON (DO-01),
	// en el orden en que se escribieron.
	const rsLineas = await db.execute({
		sql: `SELECT ID_Pedido AS id_pedido, ID_Linea AS id_linea, Nombre_Producto AS nombre_producto,
				Cantidad AS cantidad, Precio_Unitario AS precio_unitario, Unidad AS unidad
			FROM Lineas_Pedido_Proveedor WHERE ID_Pedido IN (SELECT value FROM json_each(?1)) ORDER BY rowid ASC;`,
		args: [JSON.stringify(pedidos.map((p) => p.id_pedido))],
	});
	const porPedido = new Map<string, LineaPedidoDto[]>();
	for (const l of filas(rsLineas)) {
		const cantidad = Number(l.cantidad);
		const linea: LineaPedidoDto = {
			id_linea: String(l.id_linea ?? ""),
			nombre_producto: String(l.nombre_producto ?? ""),
			cantidad: Number.isFinite(cantidad) ? cantidad : 0,
			precio_unitario: l.precio_unitario == null ? null : deLaBase(l.precio_unitario),
			unidad: opcional(l.unidad),
		};
		const id = String(l.id_pedido ?? "");
		const delPedido = porPedido.get(id);
		if (delPedido) delPedido.push(linea);
		else porPedido.set(id, [linea]);
	}
	for (const p of pedidos) p.lineas = porPedido.get(p.id_pedido) ?? [];
	return { pedidos, total };
}

/** El estado de un pedido, o `null` si no existe: para saber cómo quedó un cambio de estado. */
export async function estadoDe(db: Client, idPedido: string): Promise<string | null> {
	const rs = await db.execute({
		sql: "SELECT Estado AS estado FROM Pedidos_Proveedor WHERE ID_Pedido = ?1;",
		args: [idPedido],
	});
	const f = filas(rs)[0];
	return f ? String(f.estado) : null;
}
