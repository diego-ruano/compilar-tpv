// Ingredientes: lo que comparten la gestión (Inventario), la ficha del producto y la ventana de una
// línea de la comanda. Sin cantidades, stock ni precio: sólo qué lleva cada producto y lo que se
// pide distinto («sin cebolla», «extra de queso»).
//
// Lo que se pidió distinto en una línea llega de la base como el JSON de
// `Detalle_Comanda.Cambios_Ingredientes` (ver `0003_ingredientes.sql`): un array de
// `{ id, nombre, tipo }`, con el nombre que tenía el ingrediente al pedirlo.

import type {
    CambioIngredienteInput,
    CatalogoIngredientesDto,
    CategoriaIngredienteDto,
    IngredienteDto,
} from "@tpv/contracts";

export type TipoCambio = "SIN" | "EXTRA";
export type CambioIngrediente = { id: string; nombre: string; tipo: TipoCambio };

/** Los cambios guardados en una línea. Lo que no se entienda se ignora: nunca impide enseñarla. */
export function leerCambios(json: string | null | undefined): CambioIngrediente[] {
    if (!json) return [];
    try {
        const v: unknown = JSON.parse(json);
        if (!Array.isArray(v)) return [];
        return v.flatMap((c: unknown) => {
            if (!c || typeof c !== "object") return [];
            const { id, nombre, tipo } = c as Record<string, unknown>;
            if (typeof id !== "string" || typeof nombre !== "string") return [];
            if (tipo !== "SIN" && tipo !== "EXTRA") return [];
            return [{ id, nombre, tipo }];
        });
    } catch {
        return [];
    }
}

/** Una línea de texto para la comanda, la cocina y el ticket: «SIN Cebolla · EXTRA Queso». */
export function textoCambios(json: string | null | undefined): string {
    return leerCambios(json)
        .map((c) => `${c.tipo} ${c.nombre}`)
        .join(" · ");
}

/** Lo que se manda al guardar: primero los «sin», luego los «extra», como se leen en cocina. */
export function cambiosParaGuardar(cambios: CambioIngrediente[]): CambioIngredienteInput[] {
    const orden = (t: TipoCambio) => (t === "SIN" ? 0 : 1);
    return [...cambios]
        .sort((a, b) => orden(a.tipo) - orden(b.tipo))
        .map((c) => ({ id_ingrediente: c.id, nombre: c.nombre, tipo: c.tipo }));
}

const porNombre = (a: { Nombre: string }, b: { Nombre: string }) =>
    a.Nombre.localeCompare(b.Nombre, "es", { sensitivity: "base" });

export type GrupoIngredientes = { categoria: CategoriaIngredienteDto; ingredientes: IngredienteDto[] };

/** El catálogo agrupado por categoría, todo por nombre como lo lee una persona (con acentos). */
export function agruparPorCategoria(catalogo: CatalogoIngredientesDto | undefined): GrupoIngredientes[] {
    if (!catalogo) return [];
    const porCategoria = new Map<string, IngredienteDto[]>();
    for (const i of catalogo.ingredientes) {
        const lista = porCategoria.get(i.ID_Categoria_Ingrediente) ?? [];
        lista.push(i);
        porCategoria.set(i.ID_Categoria_Ingrediente, lista);
    }
    return [...catalogo.categorias].sort(porNombre).map((categoria) => ({
        categoria,
        ingredientes: (porCategoria.get(categoria.ID_Categoria_Ingrediente) ?? []).sort(porNombre),
    }));
}
