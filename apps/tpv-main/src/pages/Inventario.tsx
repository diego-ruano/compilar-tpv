// src/pages/Inventario.tsx
import React, { useState } from "react";
import { useToast } from "../shared/toast";

import { useInventario } from "../features/InventaryComponents/hooks/useInventario";

import InventoryHeader from "../features/InventaryComponents/ui/InventoryHeader";
import CategoriesSection from "../features/InventaryComponents/ui/CategoriesSection";
import SummarySection from "../features/InventaryComponents/ui/SummarySection";
import ProductsSection from "../features/InventaryComponents/ui/ProductsSection";

import AddCategoryModal from "../features/InventaryComponents/ui/AddCategoryModal";
import { AddProductModal } from "../features/InventaryComponents/ui/AddProductModal";
import ProductDetailModal from "../features/InventaryComponents/ProductDetailModal";

import { inventarioAPI } from "../features/InventaryComponents/api/inventarioAPI";

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

    const [openAddCategory, setOpenAddCategory] = useState(false);
    const [openAddProduct, setOpenAddProduct] = useState(false);

    const [openProductDetail, setOpenProductDetail] = useState(false);
    const [productDetailId, setProductDetailId] = useState<number | null>(null);

    const [productIdToEdit, setProductIdToEdit] = useState<number | null>(null);

    const deleteProduct = async (id: number) => {
        try {
            await inventarioAPI.deleteProducto(id);

            if (categoriaSeleccionada) {
                await cargarProductos(Number(categoriaSeleccionada.ID_Categoria));
            } else {
                await cargarResumenInventario();
            }
        } catch (e) {
            console.error("Error eliminando producto:", e);
            toast.error("Error", "No se pudo eliminar el producto.");
        }
    };

    const startEditProduct = (id: number) => {
        setProductIdToEdit(id);
        setOpenAddProduct(true);
    };

    return (
        <div className="w-full min-h-full bg-gris flex flex-col items-center">
            <div className="w-full max-w-[1400px] px-3 sm:px-6 lg:px-10 py-4 sm:py-6 flex flex-col gap-4">
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
                    categoriaPreseleccionadaId={categoriaSeleccionada ? Number(categoriaSeleccionada.ID_Categoria) : null}
                    productIdToEdit={productIdToEdit}
                    onSaved={async () => {
                        if (categoriaSeleccionada) {
                            await cargarProductos(Number(categoriaSeleccionada.ID_Categoria));
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
