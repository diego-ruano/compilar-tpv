// src/pages/Inventario.tsx
import React, { useState } from "react";
import { toAppError } from "@tpv/client";
import { useToast } from "../../shared/toast";

import { useInventario } from "../../features/InventaryComponents/hooks/useInventario";

import InventoryHeader from "../../features/InventaryComponents/ui/InventoryHeader";
import CategoriesSection from "../../features/InventaryComponents/ui/CategoriesSection";
import SummarySection from "../../features/InventaryComponents/ui/SummarySection";
import ProductsSection from "../../features/InventaryComponents/ui/ProductsSection";

import AddCategoryModal from "../../features/InventaryComponents/ui/AddCategoryModal";
import { AddProductModal } from "../../features/InventaryComponents/ui/AddProductModal";
import ProductDetailModal from "../../features/InventaryComponents/ProductDetailModal";

import { useDeleteProducto } from "../../features/InventaryComponents/inventarioQueries";

export default function Inventario() {
    const toast = useToast();

    const {
        categorias,
        categoriaSeleccionada,
        productos,
        loadingProductos,
        proximosCaducar,
        menosCantidad,
        titulo,
        setCategoriaSeleccionada,
        setProductos,
        cargarCategorias,
        cargarProductos,
        cargarResumenInventario,
    } = useInventario();

    const deleteProducto = useDeleteProducto();

    const [openAddCategory, setOpenAddCategory] = useState(false);
    const [openAddProduct, setOpenAddProduct] = useState(false);

    const [openProductDetail, setOpenProductDetail] = useState(false);
    const [productDetailId, setProductDetailId] = useState<string | null>(null);

    const [productIdToEdit, setProductIdToEdit] = useState<string | null>(null);

    const deleteProduct = async (id: string) => {
        try {
            // La invalidación de onSuccess recachea productos y resumen automáticamente.
            await deleteProducto.mutateAsync(id);
        } catch (e) {
            // El motivo viene del caso de uso y dice qué hacer ("está en una comanda abierta:
            // cóbrala o quita la línea"). Tragárselo por un genérico deja al usuario delante de un
            // botón que no funciona y sin saber por qué.
            console.error("Error eliminando producto:", e);
            toast.error("No se puede", toAppError(e).message || "No se pudo eliminar el producto.");
        }
    };

    const startEditProduct = (id: string) => {
        setProductIdToEdit(id);
        setOpenAddProduct(true);
    };

    return (
        <div className="flex min-h-full w-full touch-pan-y flex-col items-center gap-3 bg-bg p-2 pt-3 sm:gap-4 sm:p-4 lg:p-6 lg:pt-5">
            <div className="flex w-full min-w-0 flex-col gap-3 sm:gap-4">
                <InventoryHeader
                    titulo={titulo}
                    categoriaSeleccionada={categoriaSeleccionada}
                    onBack={() => {
                        setCategoriaSeleccionada(null);
                        setProductos([]);
                    }}
                    onNewCategory={() => setOpenAddCategory(true)}
                    onNewProduct={() => {
                        setProductIdToEdit(null);
                        setOpenAddProduct(true);
                    }}
                />

                {!categoriaSeleccionada ? (
                    <>
                        <CategoriesSection categorias={categorias} onSelect={(c) => setCategoriaSeleccionada(c)} />

                        <SummarySection proximosCaducar={proximosCaducar} menosCantidad={menosCantidad} />
                    </>
                ) : (
                    <ProductsSection
                        loading={loadingProductos}
                        productos={productos}
                        onOpenDetail={(id) => {
                            setProductDetailId(id);
                            setOpenProductDetail(true);
                        }}
                    />
                )}

                <AddCategoryModal
                    open={openAddCategory}
                    onClose={() => setOpenAddCategory(false)}
                    onSaved={async () => {
                        await cargarCategorias();
                    }}
                />

                <AddProductModal
                    open={openAddProduct}
                    onClose={() => {
                        setOpenAddProduct(false);
                        setProductIdToEdit(null);
                    }}
                    categoriaPreseleccionadaId={categoriaSeleccionada ? categoriaSeleccionada.ID_Categoria : null}
                    productIdToEdit={productIdToEdit}
                    onSaved={async () => {
                        if (categoriaSeleccionada) {
                            await cargarProductos(categoriaSeleccionada.ID_Categoria);
                        } else {
                            await cargarResumenInventario();
                        }
                    }}
                />

                <ProductDetailModal
                    open={openProductDetail}
                    onClose={() => setOpenProductDetail(false)}
                    productId={productDetailId}
                    onEdit={(id) => {
                        setOpenProductDetail(false);
                        startEditProduct(id);
                    }}
                    onDeleted={async (id) => {
                        await deleteProduct(id);
                    }}
                />
            </div>
        </div>
    );
}
