// src/domains/proveedores/proveedores.queries.ts

import type { Client } from "@libsql/client/web";

import type {
	CategoriaProveedorDto,
	ProductoProveedorDto,
	ProveedorDto,
} from "@tpv/contracts";

function rows(rs: any): any[] {
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

const PRODUCTO_COLS = `
	p.ID_Producto AS id_producto,
	p.ID_Categoria AS id_categoria,
	p.ID_Proveedor AS id_proveedor,
	p.Nombre AS nombre,
	-- Los tres numericos opcionales tratan el 0 como "sin valor" (NULLIF), igual que hace la Main con
	-- su fpos_or_none. Importa porque Stock_Minimo tiene DEFAULT 0: sin esto, un producto al que
	-- nadie le ha puesto minimo llegaba a la Handy como 0 y a la Main como null, y una ficha que
	-- distingue "no tiene minimo" de "su minimo es cero" pinta cosas distintas en cada pantalla.
	NULLIF(p.Precio_Venta, 0) AS precio_venta,
	((SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) + COALESCE(p.Stock_Suelto, 0)) AS stock_actual,
	NULLIF(p.Stock_Minimo, 0) AS stock_minimo,
	p.Unidad_Medida AS unidad_medida,
	p.Nombre_Imagen AS nombre_imagen,
	p.Ruta_Imagen AS ruta_imagen,
	NULLIF(p.Cantidad_Pedido_Esperada, 0) AS cantidad_pedido_esperada,
	(SELECT MAX(datetime(l.Fecha_Entrada)) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS ultima_entrada,
	(SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS caducidad_proxima
`;

export async function getAll(db: Client): Promise<ProveedorDto[]> {
	const rs = await db.execute(`
		SELECT
			ID_Proveedor AS id_proveedor,
			Nombre_Empresa AS nombre_empresa,
			Contacto AS contacto,
			Telefono AS telefono,
			Email AS email,
			CIF AS cif,
			Informacion_adicional AS informacion_adicional,
			Nombre_Imagen AS nombre_imagen,
			Ruta_Imagen AS ruta_imagen
		FROM Proveedores
		ORDER BY Nombre_Empresa ASC;
	`);
	return rows(rs) as ProveedorDto[];
}

export async function getProductos(
	db: Client,
	idProveedor: string,
): Promise<ProductoProveedorDto[]> {
	const rs = await db.execute({
		sql: `SELECT ${PRODUCTO_COLS} FROM Productos p WHERE p.ID_Proveedor = ?1 AND p.Archivado_En IS NULL ORDER BY p.Nombre ASC;`,
		args: [idProveedor],
	});
	return rows(rs) as ProductoProveedorDto[];
}

export async function getCategorias(db: Client): Promise<CategoriaProveedorDto[]> {
	const rs = await db.execute(`
		SELECT
			ID_Categoria AS id_categoria,
			Nombre AS nombre,
			Nombre_Imagen AS nombre_imagen,
			Ruta_Imagen AS ruta_imagen
		FROM Categorias_Producto
		ORDER BY Nombre ASC;
	`);
	return rows(rs) as CategoriaProveedorDto[];
}

export async function getProductosAll(db: Client): Promise<ProductoProveedorDto[]> {
	const rs = await db.execute(
		`SELECT ${PRODUCTO_COLS} FROM Productos p WHERE p.Archivado_En IS NULL ORDER BY p.Nombre ASC;`,
	);
	return rows(rs) as ProductoProveedorDto[];
}
