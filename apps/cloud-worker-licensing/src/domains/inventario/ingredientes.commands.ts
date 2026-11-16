// src/domains/inventario/ingredientes.commands.ts
//
// ESCRITURAS de ingredientes como comandos del motor del DO. Espejo de la Main
// (`tpv-infra-sqlite/src/ingredientes.rs`): las mismas sentencias, y lo que decide si una escritura
// entra (un nombre repetido, una categoría que ya no existe) va en un paso `guard` dentro del lote
// (SYNC-30), con los mismos textos (`MENSAJES` de `lib/errorCodes.ts`).
//
// Los borrados quitan a mano y en orden lo que cuelga de cada fila (DB-03): lo que se replica son
// estas sentencias, y la Main las aplica igual.

import { recortar } from "../../lib/texto";
import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import type { GuardarCategoriaIngredienteInput, GuardarIngredienteInput } from "./inventario.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

/** El id lo manda el cliente (UUIDv7); si falta, se genera aquí. Va en `id` para el resultado. */
function idDe(enviado: string | null | undefined): string {
	return recortar(enviado ?? "") || nuevoId();
}

function valorId(id: string) {
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

export function guardarCategoriaIngrediente(input: GuardarCategoriaIngredienteInput): BuiltCommand {
	const id = idDe(input.id_categoria_ingrediente);
	const nombre = recortar(input.nombre);
	const steps: any[] = [
		valorId(id),
		{
			kind: "guard",
			sql: `SELECT NOT EXISTS (SELECT 1 FROM Categorias_Ingrediente
				WHERE Nombre = ?2 AND ID_Categoria_Ingrediente <> ?1);`,
			args: [id, nombre],
			error: "categoria_ingrediente_repetida",
			status: 409,
		},
		{
			kind: "execute",
			sql: `INSERT INTO Categorias_Ingrediente (ID_Categoria_Ingrediente, Nombre) VALUES (?1, ?2)
				ON CONFLICT(ID_Categoria_Ingrediente) DO UPDATE SET Nombre = excluded.Nombre;`,
			args: [id, nombre],
		},
	];
	return {
		commandName: "inventario_guardar_categoria_ingrediente",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: { ...input, id_categoria_ingrediente: id },
	};
}

/** Espejo de `SQL_BORRAR_CATEGORIA`. */
export function borrarCategoriaIngrediente(idCategoria: string): BuiltCommand {
	const sentencias = [
		`DELETE FROM Producto_Ingredientes WHERE ID_Ingrediente IN
			(SELECT ID_Ingrediente FROM Ingredientes WHERE ID_Categoria_Ingrediente = ?1);`,
		"DELETE FROM Ingredientes WHERE ID_Categoria_Ingrediente = ?1;",
		"DELETE FROM Categorias_Ingrediente WHERE ID_Categoria_Ingrediente = ?1;",
	];
	return {
		commandName: "inventario_borrar_categoria_ingrediente",
		command: {
			type: "tenantDb.transaction",
			payload: { steps: sentencias.map((sql) => ({ kind: "execute", sql, args: [idCategoria] })) },
		},
		cloudPayload: { id_categoria_ingrediente: idCategoria },
	};
}

export function guardarIngrediente(input: GuardarIngredienteInput): BuiltCommand {
	const id = idDe(input.id_ingrediente);
	const idCategoria = recortar(input.id_categoria_ingrediente);
	const nombre = recortar(input.nombre);
	const steps: any[] = [
		valorId(id),
		{
			kind: "guard",
			sql: "SELECT EXISTS (SELECT 1 FROM Categorias_Ingrediente WHERE ID_Categoria_Ingrediente = ?1);",
			args: [idCategoria],
			error: "categoria_ingrediente_no_existe",
			status: 409,
		},
		{
			kind: "guard",
			sql: `SELECT NOT EXISTS (SELECT 1 FROM Ingredientes
				WHERE ID_Categoria_Ingrediente = ?2 AND Nombre = ?3 AND ID_Ingrediente <> ?1);`,
			args: [id, idCategoria, nombre],
			error: "ingrediente_repetido",
			status: 409,
		},
		{
			kind: "execute",
			sql: `INSERT INTO Ingredientes (ID_Ingrediente, ID_Categoria_Ingrediente, Nombre) VALUES (?1, ?2, ?3)
				ON CONFLICT(ID_Ingrediente) DO UPDATE SET
					ID_Categoria_Ingrediente = excluded.ID_Categoria_Ingrediente,
					Nombre = excluded.Nombre;`,
			args: [id, idCategoria, nombre],
		},
	];
	return {
		commandName: "inventario_guardar_ingrediente",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: { ...input, id_ingrediente: id },
	};
}

/** Espejo de `SQL_BORRAR_INGREDIENTE`. */
export function borrarIngrediente(idIngrediente: string): BuiltCommand {
	const sentencias = [
		"DELETE FROM Producto_Ingredientes WHERE ID_Ingrediente = ?1;",
		"DELETE FROM Ingredientes WHERE ID_Ingrediente = ?1;",
	];
	return {
		commandName: "inventario_borrar_ingrediente",
		command: {
			type: "tenantDb.transaction",
			payload: { steps: sentencias.map((sql) => ({ kind: "execute", sql, args: [idIngrediente] })) },
		},
		cloudPayload: { id_ingrediente: idIngrediente },
	};
}
