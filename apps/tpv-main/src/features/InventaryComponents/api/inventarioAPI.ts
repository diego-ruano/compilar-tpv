import { commands } from "@tpv/client";
// src/features/InventaryComponents/api/inventarioAPI.ts
//
// API de inventario: una función por comando Tauri, con los tipos que genera ts-rs desde Rust.
//
// Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53). Lo hacía por herencia de
// `dualCall`, cuando la misma fila podía llegar con tres nombres distintos; hoy cada comando
// devuelve una forma fija, y una capa que la "arregla" sólo puede esconder un error de contrato
// —y era la que dejaba entrar un `number` en un campo de dinero—.


import type {
    AjusteLoteInput,
    AjusteStockSueltoInput,
    AlergenoInvDto,
    CategoriaInvDto,
    CreateLoteInput,
    InventarioResumenResponse,
    LoteDto,
    ProductDetailResponse,
    ProductoDetalleDto,
    ProductoListDto,
    ProveedorMiniDto,
    UpdateLoteInput,
    UpsertCategoriaInput,
    UpsertProductoInput,
    UpsertProductoResult,
} from "@tpv/contracts";

export const inventarioAPI = {
    listCategorias(): Promise<CategoriaInvDto[]> {
        return commands.inventarioListCategorias();
    },

    async createCategoria(args: UpsertCategoriaInput): Promise<void> {
        await commands.inventarioCreateCategoria(args);
    },

    listProveedoresMini(): Promise<ProveedorMiniDto[]> {
        return commands.inventarioListProveedoresMini();
    },

    listProductosByCategoria(id_categoria: string): Promise<ProductoListDto[]> {
        return commands.inventarioListProductosByCategoria({ id_categoria });
    },

    async deleteProducto(id_producto: string): Promise<void> {
        await commands.inventarioDeleteProducto({ id_producto });
    },

    /** Alta o edición; devuelve el id del producto. */
    async upsertProducto(args: UpsertProductoInput): Promise<string> {
        const r = await commands.inventarioUpsertProducto(args);
        return r.id_producto;
    },

    getResumen(): Promise<InventarioResumenResponse> {
        return commands.inventarioGetResumen({});
    },

    listAlergenos(): Promise<AlergenoInvDto[]> {
        return commands.inventarioListAlergenos();
    },

    /** El producto con sus alérgenos. Falla si no existe: quien lo pide viene de una lista. */
    async getProductoDetalle(id_producto: string): Promise<ProductoDetalleDto> {
        const r = await commands.inventarioGetProductDetail({ id_producto });
        if (!r.producto) throw new Error("Producto no encontrado");
        return {
            ...r.producto,
            alergs: r.alergenos.map(({ ID_Alergeno, Nombre, Ruta_Imagen }) => ({
                ID_Alergeno,
                Nombre,
                Ruta_Imagen,
            })),
        };
    },

    listLotesByProducto(id_producto: string): Promise<LoteDto[]> {
        return commands.inventarioListLotesByProducto({ id_producto });
    },

    async createLote(args: CreateLoteInput): Promise<void> {
        await commands.inventarioCreateLote(args);
    },

    async updateLote(args: UpdateLoteInput): Promise<void> {
        await commands.inventarioUpdateLote(args);
    },

    async ajustarLote(args: AjusteLoteInput): Promise<void> {
        await commands.inventarioAjustarLote(args);
    },

    async ajustarStockSuelto(args: AjusteStockSueltoInput): Promise<void> {
        await commands.inventarioAjustarStockSuelto(args);
    },
};
