// src/domains/inventario/ingredientes.queries.ts
//
// LECTURAS de ingredientes: el catálogo y los de cada producto. El mismo SQL y el mismo orden que la
// Main (`tpv-infra-sqlite/src/ingredientes.rs`), así que las filas ya salen con la forma de los DTOs.

import type { Base } from "../../lib/sql";

import type { CatalogoIngredientesDto, CategoriaIngredienteDto, IngredienteDto } from "@tpv/contracts";

function filas(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

export async function catalogoIngredientes(db: Base): Promise<CatalogoIngredientesDto> {
	const categorias = await db.execute(
		`SELECT ID_Categoria_Ingrediente, Nombre FROM Categorias_Ingrediente
		 ORDER BY Nombre ASC, ID_Categoria_Ingrediente ASC;`,
	);
	const ingredientes = await db.execute(
		`SELECT ID_Ingrediente, ID_Categoria_Ingrediente, Nombre FROM Ingredientes
		 ORDER BY Nombre ASC, ID_Ingrediente ASC;`,
	);
	return {
		categorias: filas(categorias) as CategoriaIngredienteDto[],
		ingredientes: filas(ingredientes) as IngredienteDto[],
	};
}

export async function ingredientesDeProducto(db: Base, idProducto: string): Promise<string[]> {
	const rs = await db.execute({
		sql: `SELECT ID_Ingrediente FROM Producto_Ingredientes WHERE ID_Producto = ?1
			  ORDER BY ID_Ingrediente ASC;`,
		args: [idProducto],
	});
	return filas(rs).map((f) => String(f.ID_Ingrediente));
}
