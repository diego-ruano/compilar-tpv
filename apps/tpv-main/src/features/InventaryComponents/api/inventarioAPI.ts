// src/features/InventaryComponents/api/inventarioAPI.ts
//
// API de inventario: una función por comando Tauri, con los tipos que genera ts-rs desde Rust.
//
// Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53). Lo hacía por herencia de
// `dualCall`, cuando la misma fila podía llegar con tres nombres distintos; hoy cada comando
// devuelve una forma fija, y una capa que la "arregla" sólo puede esconder un error de contrato
// —y era la que dejaba entrar un `number` en un campo de dinero—.

import { invokeClient } from "@tpv/client";
import type {
    AjusteLoteInput,
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
        return invokeClient<CategoriaInvDto[]>("inventario_list_categorias");
    },

    async createCategoria(args: UpsertCategoriaInput): Promise<void> {
        await invokeClient("inventario_create_categoria", { args });
    },

    listProveedoresMini(): Promise<ProveedorMiniDto[]> {
        return invokeClient<ProveedorMiniDto[]>("inventario_list_proveedores_mini");
    },

    listProductosByCategoria(id_categoria: string): Promise<ProductoListDto[]> {
        return invokeClient<ProductoListDto[]>("inventario_list_productos_by_categoria", {
            args: { id_categoria },
        });
    },

    async deleteProducto(id_producto: string): Promise<void> {
        await invokeClient("inventario_delete_producto", { args: { id_producto } });
    },

    /** Alta o edición; devuelve el id del producto. */
    async upsertProducto(args: UpsertProductoInput): Promise<string> {
        const r = await invokeClient<UpsertProductoResult>("inventario_upsert_producto", { args });
        return r.id_producto;
    },

    getResumen(): Promise<InventarioResumenResponse> {
        return invokeClient<InventarioResumenResponse>("inventario_get_resumen", { args: {} });
    },

    listAlergenos(): Promise<AlergenoInvDto[]> {
        return invokeClient<AlergenoInvDto[]>("inventario_list_alergenos");
    },

    /** El producto con sus alérgenos. Falla si no existe: quien lo pide viene de una lista. */
    async getProductoDetalle(id_producto: string): Promise<ProductoDetalleDto> {
        const r = await invokeClient<ProductDetailResponse>("inventario_get_product_detail", {
            args: { id_producto },
        });
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
        return invokeClient<LoteDto[]>("inventario_list_lotes_by_producto", {
            args: { id_producto },
        });
    },

    async createLote(args: CreateLoteInput): Promise<void> {
        await invokeClient("inventario_create_lote", { args });
    },

    async updateLote(args: UpdateLoteInput): Promise<void> {
        await invokeClient("inventario_update_lote", { args });
    },

    async ajustarLote(args: AjusteLoteInput): Promise<void> {
        await invokeClient("inventario_ajustar_lote", { args });
    },
};
